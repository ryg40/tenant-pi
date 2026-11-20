// The viewer page of the local artifacts server: local times, and a note when the artifact has a new version or
// is gone. The frame never loads again by itself: the reader would lose the place.
import { localTimes, watch } from "/static/live.js";

const { slug, version } = document.body.dataset;
const note = document.getElementById("note");
const noteText = document.getElementById("note-text");
const reload = document.getElementById("reload");

localTimes(document);
// The page loads again as a whole, so the bar shows the new facts too.
reload.addEventListener("click", () => location.reload());

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
