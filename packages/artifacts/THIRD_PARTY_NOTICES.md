# Third-party notices

## `marked`

The Markdown view of the server renders Markdown in the browser with an unchanged copy of `lib/marked.umd.js` of `marked`, at `server/web/vendor/marked.umd.js`.

- Project: https://github.com/markedjs/marked
- Version: `18.0.7`
- License: MIT
- Copyright: 2018+ MarkedJS, 2011-2018 Christopher Jeffrey

The full upstream license text is in [`server/web/vendor/marked-LICENSE.md`](server/web/vendor/marked-LICENSE.md), a copy of the `LICENSE` file of the npm package.

## `highlight.js`

The Markdown view gives a fenced code block with a language its syntax colors with an unchanged copy of `highlight.min.js` of the npm package `@highlightjs/cdn-assets` (the common-languages browser build of highlight.js), at `server/web/vendor/highlight.min.js`. The colors are rules of `server/web/markdown.css`, not a theme file of the package.

- Project: https://github.com/highlightjs/highlight.js
- Package: `@highlightjs/cdn-assets`, version `11.12.0`
- File in the package: `highlight.min.js` (129254 bytes)
- SHA-256: `8ab71eb09c51f501e5e25157d9cff100e46cc29bcbfc744d0b746d451fca7f53`
- License: BSD-3-Clause
- Copyright: 2006 Ivan Sagalaev

The full upstream license text is in [`server/web/vendor/highlight-LICENSE`](server/web/vendor/highlight-LICENSE), a copy of the `LICENSE` file of the npm package.

## Updates

The package does not depend on the npm packages and runs no npm step. To update a copy, replace its files with the files of the new release and change the facts above.
