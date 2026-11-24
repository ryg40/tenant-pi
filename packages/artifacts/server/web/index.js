// The index page of the local artifacts server: local times, the table or gallery view, the sort, the filter, the
// view state in the URL fragment, the live previews and the live refresh. Without this script the page shows the
// table, newest first, with the UTC times and no live preview.
import { bindAction } from "/static/archive.js";
import { localTimes, watch } from "/static/live.js";

const table = document.getElementById("artifacts");
const main = table.closest("main");
const tools = document.getElementById("tools");
const filter = document.getElementById("filter");
const repo = document.getElementById("repo");
const views = document.getElementById("views");
const sort = document.getElementById("sort");
const empty = document.getElementById("empty");
const nomatch = document.getElementById("nomatch");
const body = table.tBodies[0];
const heads = Array.from(table.tHead.rows[0].cells);
const columns = heads.map((head) => head.dataset.column ?? "");
const CREATED = columns.indexOf("created");
const REPO = columns.indexOf("repo");
const SIZE = columns.indexOf("size");

// The view state lives in the fragment: #view=gallery&sort=<column>&dir=asc|desc&filter=<text>&repo=<name>. No fragment: the
// table, newest first and no filter.
const fromFragment = () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const column = columns.indexOf(params.get("sort") ?? "");
  return {
    gallery: params.get("view") === "gallery",
    column: column > 0 ? column : CREATED,
    direction: params.get("dir") === "asc" ? "ascending" : "descending",
    words: params.get("filter") ?? "",
    repo: params.get("repo"), // No key: all repos. An empty name: no repo.
  };
};
let view = fromFragment();

const save = () => {
  const params = new URLSearchParams();
  if (view.gallery) params.set("view", "gallery");
  if (view.column !== CREATED || view.direction !== "descending") {
    params.set("sort", columns[view.column]);
    params.set("dir", view.direction === "ascending" ? "asc" : "desc");
  }
  if (view.repo !== null) params.set("repo", view.repo);
  if (view.words) params.set("filter", view.words);
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
};

// ---------------------------------------------------------------------------
// The live previews
// ---------------------------------------------------------------------------
// A preview is a frame of /a/<slug>?thumb. A frame is a whole page with its scripts and its pictures, so the index
// makes a frame only on demand, and never more than LIVE_FRAMES at one time:
// - Gallery: the cards in view, from the top. The card under the pointer or with the focus comes first. A frame
//   that leaves the view is removed, and the static tile of the card shows again. A large page (above
//   LARGE_BYTES) gets no frame by itself: its card says so, and the frame comes when the pointer or the focus
//   rests on the card. It stays while the card is in view.
// - Table: no frame at load. The row under the pointer or with the focus shows one frame in a card (the peek).
// The page looks at the view only after the scroll, the window size and the rows are quiet for SETTLE_MS, and at
// most LOADS previews start at one time. A preview that needs more than LOAD_MS frees its place for the next one.
// An artifact is untrusted HTML. The frame has the sandbox attribute with no allow-same-origin, and the answer of
// /a/<slug> has the same policy as a header: an artifact never runs in the origin of this page.
const LIVE_FRAMES = 12;
const LARGE_BYTES = 1024 * 1024;
const LOADS = 2;
const LOAD_MS = 4000;
const SETTLE_MS = 150;
const PEEK_MS = 300;
const PEEK_MIN_WIDTH = 700;

// A frame for `slug`. `done` runs once: at the load event, or after LOAD_MS for a page that loads slowly.
const makeFrame = (slug, done) => {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  // The preview shows the top of the page and takes no input, so it needs no scroll bar.
  frame.setAttribute("scrolling", "no");
  frame.tabIndex = -1;
  frame.title = "";
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    frame.classList.add("ready");
    done();
  };
  frame.addEventListener("load", end);
  setTimeout(end, LOAD_MS);
  // The Markdown view of an artifact takes the theme of this page from the query (theme.js sets data-theme). An
  // HTML artifact keeps its own colors.
  const dark = document.documentElement.dataset.theme === "torch-dark";
  frame.src = `/a/${encodeURIComponent(slug)}?thumb${dark ? "&theme=torch-dark" : ""}`;
  return frame;
};

const live = new Map(); // row -> its frame
const asked = new Set(); // the large rows in view that the reader asked a frame for
let wanted = [];
let loading = 0;
let pointed = null; // the row under the pointer or with the focus

const release = (row) => {
  const frame = live.get(row);
  if (!frame) return;
  frame.remove();
  live.delete(row);
};

const pump = () => {
  for (const row of wanted) {
    if (loading >= LOADS) return;
    if (live.has(row) || !row.isConnected) continue;
    loading += 1;
    const frame = makeFrame(row.dataset.slug ?? "", () => {
      loading -= 1;
      pump();
    });
    live.set(row, frame);
    row.querySelector("td.thumb a")?.append(frame);
  }
};

const lookAtView = () => {
  // A hidden page starts no frame. It keeps its frames, so the page is complete when it shows again.
  if (document.hidden) return;
  wanted = [];
  if (view.gallery) {
    const inView = (row) => {
      const box = row.getBoundingClientRect();
      return box.height > 0 && box.bottom > 0 && box.top < innerHeight;
    };
    // The pointed card comes first only while it is in view: a scroll moves the cards under a pointer at rest.
    if (pointed && !(pointed.isConnected && inView(pointed))) pointed = null;
    if (pointed) {
      wanted.push(pointed);
      if (pointed.classList.contains("large")) asked.add(pointed);
    }
    for (const row of Array.from(asked)) {
      if (!(row.isConnected && inView(row))) asked.delete(row);
    }
    for (const row of body.rows) {
      if (wanted.length >= LIVE_FRAMES) break;
      if (row.hidden || row === pointed) continue;
      const box = row.getBoundingClientRect();
      // The cards are in reading order: no later card is in view.
      if (box.top >= innerHeight) break;
      if (box.bottom > 0 && (!row.classList.contains("large") || asked.has(row))) wanted.push(row);
    }
  } else {
    asked.clear();
  }
  for (const row of Array.from(live.keys())) {
    if (!wanted.includes(row)) release(row);
  }
  pump();
};

let settle = 0;
const lookSoon = () => {
  wanted = []; // A frame that finishes before the check must not start a row from the old view.
  clearTimeout(settle);
  settle = setTimeout(lookAtView, SETTLE_MS);
};

// The peek of the table view: one frame in a card below (or above) the row.
const peek = document.createElement("div");
peek.className = "peek";
peek.hidden = true;
document.body.append(peek);
let peekRow = null;
let peekTimer = 0;

const hidePeek = () => {
  clearTimeout(peekTimer);
  peekRow = null;
  if (peek.hidden) return;
  peek.hidden = true;
  peek.replaceChildren();
};

const showPeek = (row) => {
  if (row === peekRow) return;
  hidePeek();
  if (!row || view.gallery || innerWidth < PEEK_MIN_WIDTH) return;
  peekRow = row;
  peekTimer = setTimeout(() => {
    const anchor = row.querySelector("td.name");
    if (peekRow !== row || !row.isConnected || row.hidden || !anchor) return;
    peek.replaceChildren(makeFrame(row.dataset.slug ?? "", () => {}));
    peek.hidden = false;
    // The place: below the row, or above it when the window has no room below. The script sets the place through
    // the style object, which the policy of the page allows; the page has no style attribute in its markup.
    const box = anchor.getBoundingClientRect();
    const size = peek.getBoundingClientRect();
    const below = box.bottom + 6;
    const top = below + size.height <= innerHeight ? below : Math.max(6, box.top - size.height - 6);
    const left = Math.max(6, Math.min(box.left, innerWidth - size.width - 6));
    peek.style.top = `${Math.round(top)}px`;
    peek.style.left = `${Math.round(left)}px`;
  }, PEEK_MS);
};

// The row that the pointer or the focus asks a preview for: its tile or its title, and no other part of the row.
const askedRow = (target) => {
  if (!(target instanceof Element)) return null;
  const part = target.closest("td.thumb a, a.title");
  return part ? part.closest("tr") : null;
};

const point = (row) => {
  if (view.gallery) {
    if (row && row !== pointed) {
      pointed = row;
      lookSoon();
    }
  } else {
    showPeek(row);
  }
};

body.addEventListener("mouseover", (event) => point(view.gallery ? event.target.closest("tr") : askedRow(event.target)));
body.addEventListener("mouseleave", () => {
  pointed = null;
  hidePeek();
});
// The focus events do not bubble: the capture phase sees them.
body.addEventListener("focus", (event) => point(view.gallery ? event.target.closest("tr") : askedRow(event.target)), true);
body.addEventListener("blur", () => hidePeek(), true);
window.addEventListener("scroll", () => {
  hidePeek();
  lookSoon();
}, { passive: true });
window.addEventListener("resize", () => {
  hidePeek();
  lookSoon();
});
document.addEventListener("visibilitychange", lookSoon);
// A new theme: each preview loads again, so a Markdown view shows the new theme.
document.addEventListener("artifacts-theme", () => {
  for (const row of Array.from(live.keys())) release(row);
  hidePeek();
  lookSoon();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hidePeek();
});

// ---------------------------------------------------------------------------
// The sort, the filter and the view
// ---------------------------------------------------------------------------
// The sort: each cell holds its machine key in data-sort; data-sort-type="number" compares as numbers.
const key = (row, column) => {
  const cell = row.cells[column];
  const value = cell.dataset.sort ?? "";
  return cell.dataset.sortType === "number" ? Number(value) : value;
};

// Put `rows` into the body in the sort order. A row moves only when it is out of place, and a row that moves
// loses its frame: a moved frame loads its page again.
const order = (rows = Array.from(body.rows)) => {
  const sign = view.direction === "ascending" ? 1 : -1;
  const keys = new Map(rows.map((row) => [row, key(row, view.column)]));
  const sorted = rows.slice().sort((a, b) => {
    const x = keys.get(a);
    const y = keys.get(b);
    return x < y ? -sign : x > y ? sign : 0;
  });
  let next = body.firstElementChild;
  for (const row of sorted) {
    if (row === next) {
      next = next.nextElementSibling;
    } else {
      release(row);
      body.insertBefore(row, next);
    }
  }
  heads.forEach((head, column) => {
    if (!head.hasAttribute("aria-sort")) return;
    head.setAttribute("aria-sort", column === view.column ? view.direction : "none");
  });
  sort.value = `${columns[view.column]}:${view.direction === "ascending" ? "asc" : "desc"}`;
};

const repoName = (row) => row.cells[REPO].querySelector("button")?.textContent ?? "";

const syncRepos = () => {
  const counts = new Map();
  for (const row of body.rows) {
    const name = repoName(row);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  repo.replaceChildren(new Option("All repos", ""));
  const names = Array.from(counts.keys()).filter(Boolean).sort((a, b) => a.localeCompare(b));
  if (counts.has("")) names.push("");
  for (const name of names) repo.add(new Option(`${name || "No repo"} (${counts.get(name)})`, name));
  if (view.repo !== null && !counts.has(view.repo)) {
    view.repo = null;
    save();
  }
  repo.selectedIndex = names.indexOf(view.repo) + 1;
};

// Show the rows that match the filter, and the view. Each word of the filter must match. A word `repo:<name>`
// (or `repo:"<name>"` for a name with spaces) matches only the repo of that name; each other word matches a part
// of the title, the file name, the repo or the type. The case does not count.
const show = () => {
  // The gallery has no column heads: the sort list shows the sort there.
  main.dataset.view = view.gallery ? "gallery" : "table";
  for (const button of views.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String((button.dataset.view === "gallery") === view.gallery));
  }
  const words = view.words.toLowerCase().match(/repo:"[^"]*"|\S+/g) ?? [];
  const matches = (row, word) => {
    if (!word.startsWith("repo:")) return (row.dataset.filter ?? "").includes(word);
    const quoted = /^repo:"(.*)"$/.exec(word);
    return (row.cells[REPO]?.dataset.sort ?? "") === (quoted ? quoted[1] : word.slice("repo:".length));
  };
  let all = 0;
  let shown = 0;
  for (const row of body.rows) {
    const match = (view.repo === null || repoName(row) === view.repo) && words.every((word) => matches(row, word));
    row.hidden = !match;
    // The mark of a large page: see the live previews.
    row.classList.toggle("large", Number(row.cells[SIZE]?.dataset.sort ?? 0) > LARGE_BYTES);
    all += 1;
    if (match) shown += 1;
  }
  document.getElementById("shown").textContent = `${shown} artifact${shown === 1 ? "" : "s"}`;
  tools.hidden = all === 0;
  table.hidden = all === 0;
  empty.hidden = all > 0;
  nomatch.hidden = shown > 0 || all === 0;
  hidePeek();
  lookSoon();
};

const setFilter = (text) => {
  view.words = text;
  filter.value = text;
  save();
  show();
};

heads.forEach((head, column) => {
  const button = head.querySelector("button");
  if (!button) return;
  button.addEventListener("click", () => {
    const again = column === view.column && view.direction === "ascending";
    view.column = column;
    view.direction = again ? "descending" : "ascending";
    save();
    order();
    show();
  });
  // The sort list: two entries for each sortable column head.
  for (const [dir, word] of [["asc", "ascending"], ["desc", "descending"]]) {
    sort.add(new Option(`${button.textContent} ${word}`, `${columns[column]}:${dir}`));
  }
});
sort.addEventListener("change", () => {
  const [name, dir] = sort.value.split(":");
  view.column = columns.indexOf(name);
  view.direction = dir === "asc" ? "ascending" : "descending";
  save();
  order();
  show();
});
views.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  view.gallery = button.dataset.view === "gallery";
  save();
  show();
});
filter.addEventListener("input", () => setFilter(filter.value));
repo.addEventListener("change", () => {
  view.repo = repo.selectedIndex === 0 ? null : repo.value;
  save();
  show();
});
// The repo button sets the same pick and keeps the text filter.
body.addEventListener("click", (event) => {
  const button = event.target.closest("button.repo");
  if (!button) return;
  view.repo = button.textContent;
  repo.value = view.repo;
  save();
  show();
});
// A new fragment by hand, or the back and forward buttons.
window.addEventListener("hashchange", () => {
  view = fromFragment();
  syncRepos();
  filter.value = view.words;
  order();
  show();
});

// The live refresh: when the state value changes, get the index again and take its rows and its facts line. A
// row whose artifact did not change stays, with its frame.
let known = document.body.dataset.state;
bindAction(table, "archive", (slug) => {
  known = Symbol(); // Discard an older refresh, even if a restore brings back the last known state.
  const row = Array.from(body.rows).find((row) => row.dataset.slug === slug);
  if (!row) return;
  release(row);
  row.remove();
  const link = document.getElementById("archived");
  const count = Number(link.dataset.count) + 1;
  link.dataset.count = count;
  link.textContent = `${count} archived`;
  link.hidden = false;
  syncRepos();
  show();
});
const refresh = async () => {
  const before = known;
  const reply = await fetch("/artifacts", { cache: "no-store" });
  if (!reply.ok) throw new Error(`index: ${reply.status}`);
  const page = new DOMParser().parseFromString(await reply.text(), "text/html");
  if (before !== known) return;
  const fresh = page.getElementById("artifacts");
  const facts = page.querySelector(".facts");
  if (!fresh || !facts) throw new Error("index: no table");
  const old = new Map(Array.from(body.rows, (row) => [row.dataset.key, row]));
  // A static copy first: adoptNode takes a row out of the live collection of the parsed page.
  const rows = Array.from(fresh.tBodies[0].rows).map((row) => old.get(row.dataset.key) ?? document.adoptNode(row));
  const kept = new Set(rows);
  for (const row of Array.from(body.rows)) {
    if (kept.has(row)) continue;
    release(row);
    row.remove();
  }
  document.querySelector(".facts").replaceWith(document.adoptNode(facts));
  order(rows);
  syncRepos();
  show();
  localTimes(table);
  known = page.body.dataset.state;
};
watch("/api/state", async (state) => {
  if (state.state !== known) await refresh();
});

localTimes(table);
syncRepos();
filter.value = view.words;
order();
show();
