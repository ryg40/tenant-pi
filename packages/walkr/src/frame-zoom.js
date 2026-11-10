// Zoom for one candidate display. The candidate bytes and the frame document never change:
// the stage scales the frame with a CSS transform. At 100% the frame has the size of the stage.
// A smaller level makes the frame taller by the same factor, so more of the page shows.
export const ZOOM_LEVELS = Object.freeze([0.25, 0.33, 0.5, 0.67, 0.75, 1]);
export const ZOOM_KEY = "walkr:zoom:";
const percent = (level) => `${Math.round(level * 100)}%`;
export const normalizeZoom = (value) => ZOOM_LEVELS.includes(Number(value)) ? Number(value) : 1;

/**
 * Add the zoom control of one display.
 * @param {{ document: Document, stage: Element, host: Element, name: string, label: string, storage?: Storage }} options
 *   `stage` holds the frame, `host` receives the control, `name` is the storage name of the display.
 */
export function mountFrameZoom({ document: doc, stage, host, name, label, storage = null }) {
  const button = (className, text, title) => {
    const node = doc.createElement("button");
    node.type = "button"; node.className = className; node.textContent = text; node.title = title;
    node.setAttribute("aria-label", title);
    return node;
  };
  const group = doc.createElement("span");
  group.className = "zoom-control"; group.setAttribute("role", "group"); group.setAttribute("aria-label", `Zoom of the ${label}`);
  const out = button("zoom-out", "−", `Zoom out the ${label}`);
  const reset = button("zoom-reset", "100%", `Show the ${label} at 100%`);
  const into = button("zoom-in", "+", `Zoom in the ${label}`);
  const full = button("zoom-full", "Full page", `Show the ${label} at the smallest zoom`);
  group.append(out, reset, into, full);
  let level = 1;
  try { level = normalizeZoom(storage?.getItem(ZOOM_KEY + name)); } catch {}
  function apply(next, save = true) {
    level = normalizeZoom(next);
    stage.classList.add("zoom-stage");
    stage.style.setProperty("--zoom", String(level));
    stage.dataset.zoom = percent(level);
    reset.textContent = percent(level);
    reset.setAttribute("aria-pressed", level === 1 ? "true" : "false");
    out.disabled = level === ZOOM_LEVELS[0];
    into.disabled = level === 1;
    full.disabled = level === ZOOM_LEVELS[0];
    if (save) { try { storage?.setItem(ZOOM_KEY + name, String(level)); } catch {} }
  }
  const step = (by) => apply(ZOOM_LEVELS[Math.min(ZOOM_LEVELS.length - 1, Math.max(0, ZOOM_LEVELS.indexOf(level) + by))]);
  const handlers = [[out, () => step(-1)], [into, () => step(1)], [reset, () => apply(1)], [full, () => apply(ZOOM_LEVELS[0])]];
  for (const [node, fn] of handlers) node.addEventListener("click", fn);
  host.append(group);
  apply(level, false);
  return {
    element: group,
    get level() { return level; },
    set: apply,
    close() { for (const [node, fn] of handlers) node.removeEventListener("click", fn); group.remove(); },
  };
}
