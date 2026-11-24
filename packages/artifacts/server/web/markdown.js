// The Markdown view: render the inert source text with the vendored marked (GFM tables and code blocks). Without
// this script the reader sees the source text.
//
// A fenced code block with a language gets the colors of the vendored highlight.js, loaded only when the page has
// such a block. A language that highlight.js does not know stays plain text; there is no automatic detection. A
// thumbnail frame of the index (`?thumb`) loads no library past marked.
"use strict";

// The theme. This view is sandboxed and has no storage: the page that frames it gives the theme in the query
// `theme`, and the server writes it into data-theme of the root element. When the reader changes the theme, the
// viewer page sends the new name as a message.
window.addEventListener("message", (event) => {
  if (event.source !== window.parent || !event.data) return;
  const theme = event.data.artifactsTheme;
  if (theme === "torch-light" || theme === "torch-dark") document.documentElement.dataset.theme = theme;
});

(() => {
  const source = document.getElementById("source");
  if (!source || typeof marked === "undefined" || typeof marked.parse !== "function") return;
  const view = document.createElement("article");
  view.className = "markdown";
  view.innerHTML = marked.parse(source.textContent, { gfm: true });
  source.replaceWith(view);
  if (new URLSearchParams(location.search).has("thumb")) return;

  // marked writes a fenced block with a language as <pre><code class="language-<name>">.
  const blocks = [];
  for (const code of view.querySelectorAll("pre > code")) {
    const name = /(?:^|\s)language-(\S+)/.exec(code.className);
    if (name) blocks.push([code, name[1]]);
  }
  if (blocks.length === 0) return;
  const script = document.createElement("script");
  script.src = "/static/vendor/highlight.min.js";
  script.addEventListener("load", () => {
    if (typeof hljs === "undefined") return;
    for (const [code, name] of blocks) {
      if (!hljs.getLanguage(name)) continue;
      try {
        // highlight.js escapes the text; its answer holds only its own spans.
        code.innerHTML = hljs.highlight(code.textContent, { language: name, ignoreIllegals: true }).value;
        code.classList.add("hljs");
      } catch {
        // The block stays plain text.
      }
    }
  });
  document.head.append(script);
})();
