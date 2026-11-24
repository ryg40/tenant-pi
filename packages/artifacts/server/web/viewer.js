// The viewer page of the local artifacts server: local times, the theme of a Markdown view, and a note when the
// artifact has a new version or is gone. The frame never loads again by itself: the reader would lose the place.
import { localTimes, watch } from "/static/live.js";

const { slug, version } = document.body.dataset;
const note = document.getElementById("note");
const noteText = document.getElementById("note-text");
const reload = document.getElementById("reload");
const frame = document.querySelector("iframe.frame");

localTimes(document);
// The page loads again as a whole, so the bar shows the new facts too.
reload.addEventListener("click", () => location.reload());

// A Markdown view takes the theme of this page (theme.js sets data-theme) from the query of its address: the server
// gave the frame the address in data-src and no src. An HTML artifact keeps its own colors, and its frame has its
// address already. When the reader changes the theme, the view gets the new name as a message, so it does not load
// again. The message goes to a sandboxed page with no origin of its own; it holds the name of the theme and no
// other value.
const address = frame?.dataset.src;
if (address) {
  const alone = document.querySelector(".nav a.alone");
  const themed = () => (document.documentElement.dataset.theme === "torch-dark" ? `${address}?theme=torch-dark` : address);
  frame.src = themed();
  frame.hidden = false;
  if (alone) alone.href = themed();
  document.addEventListener("artifacts-theme", (event) => {
    frame.contentWindow?.postMessage({ artifactsTheme: event.detail }, "*");
    if (alone) alone.href = themed();
  });
}

watch(`/api/state/${encodeURIComponent(slug)}`, (state) => {
  if (state.artifact === null) {
    noteText.textContent = "This artifact is no longer in the store.";
    reload.hidden = true;
    note.hidden = false;
  } else if (state.artifact && state.artifact.version !== version) {
    noteText.textContent = "A new version is stored.";
    reload.hidden = false;
    note.hidden = false;
  }
});
