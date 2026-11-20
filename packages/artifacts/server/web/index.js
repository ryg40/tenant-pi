// The index page of the local artifacts server: local times, the table or gallery view, the sort, the filter, the
// view state in the URL fragment and the live refresh. Without this script the page shows the table, newest first,
// with the UTC times.
import { localTimes, watch } from "/static/live.js";

const table = document.getElementById("artifacts");
const main = table.closest("main");
const tools = document.getElementById("tools");
const filter = document.getElementById("filter");
const views = document.getElementById("views");
const sort = document.getElementById("sort");
const empty = document.getElementById("empty");
const nomatch = document.getElementById("nomatch");
const body = table.tBodies[0];
const heads = Array.from(table.tHead.rows[0].cells);
const columns = heads.map((head) => head.dataset.column ?? "");
const CREATED = columns.indexOf("created");
const REPO = columns.indexOf("repo");

// The view state lives in the fragment: #view=gallery&sort=<column>&dir=asc|desc&filter=<text>. No fragment: the
// table, newest first and no filter.
const fromFragment = () => {
  const params = new URLSearchParams(location.hash.slice(1));
  const column = columns.indexOf(params.get("sort") ?? "");
  return {
    gallery: params.get("view") === "gallery",
    column: column > 0 ? column : CREATED,
    direction: params.get("dir") === "asc" ? "ascending" : "descending",
    words: params.get("filter") ?? "",
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
  if (view.words) params.set("filter", view.words);
  const hash = params.toString();
  history.replaceState(null, "", hash ? `#${hash}` : location.pathname + location.search);
};

// The sort: each cell holds its machine key in data-sort; data-sort-type="number" compares as numbers.
const key = (row, column) => {
  const cell = row.cells[column];
  const value = cell.dataset.sort ?? "";
  return cell.dataset.sortType === "number" ? Number(value) : value;
};

// Put `rows` into the body in the view order. A row moves only when it is out of place: a moved frame loads
// its page again.
const apply = (rows = Array.from(body.rows)) => {
  const sign = view.direction === "ascending" ? 1 : -1;
  const sorted = rows.slice().sort((a, b) => {
    const x = key(a, view.column);
    const y = key(b, view.column);
    return x < y ? -sign : x > y ? sign : 0;
  });
  sorted.forEach((row, place) => {
    if (body.rows[place] !== row) body.insertBefore(row, body.rows[place] ?? null);
  });
  heads.forEach((head, column) => {
    if (!head.hasAttribute("aria-sort")) return;
    head.setAttribute("aria-sort", column === view.column ? view.direction : "none");
  });
  // The gallery has no column heads: the sort list shows the sort there.
  main.dataset.view = view.gallery ? "gallery" : "table";
  for (const button of views.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String((button.dataset.view === "gallery") === view.gallery));
  }
  sort.value = `${columns[view.column]}:${view.direction === "ascending" ? "asc" : "desc"}`;
  // The filter: each word must match. A word `repo:<name>` (or `repo:"<name>"` for a name with spaces) matches
  // only the repo of that name; each other word matches a part of the title, the file name, the repo or the type.
  // The case does not count.
  const words = view.words.toLowerCase().match(/repo:"[^"]*"|\S+/g) ?? [];
  const matches = (row, word) => {
    if (!word.startsWith("repo:")) return (row.dataset.filter ?? "").includes(word);
    const quoted = /^repo:"(.*)"$/.exec(word);
    return (row.cells[REPO]?.dataset.sort ?? "") === (quoted ? quoted[1] : word.slice("repo:".length));
  };
  let shown = 0;
  for (const row of sorted) {
    const match = words.every((word) => matches(row, word));
    row.hidden = !match;
    if (match) shown += 1;
  }
  tools.hidden = sorted.length === 0;
  table.hidden = sorted.length === 0;
  empty.hidden = sorted.length > 0;
  nomatch.hidden = shown > 0 || sorted.length === 0;
};

const setFilter = (text) => {
  view.words = text;
  filter.value = text;
  save();
  apply();
};

heads.forEach((head, column) => {
  const button = head.querySelector("button");
  if (!button) return;
  button.addEventListener("click", () => {
    const again = column === view.column && view.direction === "ascending";
    view.column = column;
    view.direction = again ? "descending" : "ascending";
    save();
    apply();
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
  apply();
});
views.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-view]");
  if (!button) return;
  view.gallery = button.dataset.view === "gallery";
  save();
  apply();
});
filter.addEventListener("input", () => setFilter(filter.value));
// A click on a repo name filters by that repo only: the filter text `repo:<name>`.
body.addEventListener("click", (event) => {
  const button = event.target.closest("button.repo");
  if (!button) return;
  const name = button.textContent;
  setFilter(/\s/.test(name) ? `repo:"${name}"` : `repo:${name}`);
});
// A new fragment by hand, or the back and forward buttons.
window.addEventListener("hashchange", () => {
  view = fromFragment();
  filter.value = view.words;
  apply();
});

// The live refresh: when the state value changes, get the index again and take its rows and its facts line. A
// row whose artifact did not change stays, with its thumbnail.
let known = document.body.dataset.state;
const refresh = async () => {
  const reply = await fetch("/", { cache: "no-store" });
  if (!reply.ok) throw new Error(`index: ${reply.status}`);
  const page = new DOMParser().parseFromString(await reply.text(), "text/html");
  const fresh = page.getElementById("artifacts");
  const facts = page.querySelector(".facts");
  if (!fresh || !facts) throw new Error("index: no table");
  const old = new Map(Array.from(body.rows, (row) => [row.dataset.key, row]));
  // A static copy first: adoptNode takes a row out of the live collection of the parsed page.
  const rows = Array.from(fresh.tBodies[0].rows).map((row) => old.get(row.dataset.key) ?? document.adoptNode(row));
  for (const row of Array.from(body.rows)) {
    if (!rows.includes(row)) row.remove();
  }
  document.querySelector(".facts").replaceWith(document.adoptNode(facts));
  apply(rows);
  localTimes(table);
  known = page.body.dataset.state;
};
watch("/api/state", async (state) => {
  if (state.state !== known) await refresh();
});

localTimes(table);
filter.value = view.words;
apply();
