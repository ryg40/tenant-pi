// Shared by the index page and the viewer page: local times and the poll of /api/state.
const POLL_MS = 3000;
const two = (n) => String(n).padStart(2, "0");

// Each <time datetime> under root in the local time zone of the browser. The UTC value stays in the datetime
// attribute and goes into the title, so a second call gives the same text.
export const localTimes = (root) => {
  for (const time of root.querySelectorAll("time[datetime]")) {
    const date = new Date(time.dateTime);
    if (Number.isNaN(date.getTime())) continue;
    time.textContent = `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} `
      + `${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}`;
    time.title = `${time.dateTime} (UTC)`;
  }
};

// Ask `path` (a path of this origin) every few seconds while the page is visible, and at once when it is shown
// again; give each JSON answer to onState. A failed request or a failed onState changes nothing: the next round
// tries again.
export const watch = (path, onState) => {
  let busy = false;
  const round = async () => {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const reply = await fetch(path, { cache: "no-store" });
      if (reply.ok) await onState(await reply.json());
    } catch {
      // The next round tries again.
    } finally {
      busy = false;
    }
  };
  setInterval(round, POLL_MS);
  document.addEventListener("visibilitychange", round);
};
