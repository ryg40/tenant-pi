// The theme of the pages of the server origin: Torch Light, or Torch Dark when the reader chose a dark theme.
//
// The choice is the value of the localStorage key "human-review:theme", the key of Walkr (packages/walkr/src/theme.js).
// The Walkr page runs on this origin, so one choice serves both: a dark theme of Walkr gives Torch Dark here, each
// other value and no value give Torch Light. The system setting of the reader does not count. The Theme list of a
// page writes the same key, so Walkr follows a choice that the reader makes here.
//
// A page loads this file as a plain script in its head, before its styles: the script runs before the first paint,
// so a page never shows the other theme first. The policy of the pages (script-src 'self') allows no inline script.
"use strict";

(() => {
  const KEY = "human-review:theme";
  const DARK = ["torch-dark", "dark", "plum", "night", "statue-dark"];
  const themeOf = (value) => (DARK.includes(value) ? "torch-dark" : "torch-light");
  const stored = () => {
    try {
      return localStorage.getItem(KEY);
    } catch {
      return null; // a browser that gives a page no storage
    }
  };
  const root = document.documentElement;
  const pickers = () => document.querySelectorAll("select[data-theme-picker]");
  const apply = (value) => {
    const theme = themeOf(value);
    const changed = root.dataset.theme !== theme;
    root.dataset.theme = theme;
    for (const picker of pickers()) picker.value = theme;
    // The page scripts (the previews, the Markdown frame of the viewer) follow this event.
    if (changed) document.dispatchEvent(new CustomEvent("artifacts-theme", { detail: theme }));
  };
  apply(stored());

  // A change in another tab of this origin, for example in the Walkr page.
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) apply(stored());
  });
  // The Theme list of the band. The list is not in the document yet when this script runs.
  document.addEventListener("DOMContentLoaded", () => {
    for (const picker of pickers()) {
      picker.value = root.dataset.theme;
      picker.closest("label")?.removeAttribute("hidden");
      picker.addEventListener("change", () => {
        try {
          localStorage.setItem(KEY, themeOf(picker.value));
        } catch {
          // The choice holds for this page only.
        }
        apply(picker.value);
      });
    }
  });
})();
