// Both lists use the same write request. Only the main list loads the preview code.
import { localTimes } from "/static/live.js";

export const bindAction = (table, action, done) => {
  const note = document.getElementById("note");
  table.addEventListener("click", async (event) => {
    const button = event.target.closest("button.row-action");
    if (!button || button.disabled) return;
    const row = button.closest("tr");
    button.disabled = true;
    note.hidden = true;
    try {
      // Send the page origin for this write, even with the no-referrer policy of the page.
      const reply = await fetch(`/api/${action}/${encodeURIComponent(row.dataset.slug)}`, {
        method: "POST", mode: "same-origin", referrerPolicy: "same-origin", redirect: "error",
        headers: { "Content-Type": "application/json" }, body: "{}",
      });
      if (!reply.ok) {
        const data = await reply.json().catch(() => null);
        throw new Error(data?.error?.message || `The server answered ${reply.status}.`);
      }
      done(row.dataset.slug, row);
    } catch (error) {
      note.textContent = error.message;
      note.hidden = false;
      button.disabled = false;
    }
  });
  table.classList.add("actions-ready");
};

const archive = document.getElementById("archive");
if (archive) {
  localTimes(archive);
  bindAction(archive, "restore", (_, row) => {
    row.remove();
    const count = archive.tBodies[0].rows.length;
    document.getElementById("archive-count").textContent = `${count} archived`;
    archive.hidden = count === 0;
    document.getElementById("empty").hidden = count !== 0;
  });
}
