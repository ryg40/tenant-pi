/**
 * The Walkr logo: a bare right footprint, a sole and five toes. It is inline SVG markup, not a file, because the
 * shell pages send `default-src 'none'` with no `img-src`: an `<img>`, a CSS mask or a `data:` image would not load.
 * The logo is decoration, so it is hidden from assistive technology and the brand text stays the accessible name.
 * Each page template holds the marker `<!--walkr-foot-->` where the logo goes.
 */
export const WALKR_FOOT = '<svg class="walkr-foot" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" focusable="false" fill="currentColor">' +
  '<path d="M6.4 10.4C6.4 8.7 8.5 7.9 11.2 8C14.4 8.1 16.6 9.4 16.2 12C15.9 14.2 14.6 15.6 14.8 17.8C15 20.8 13.6 22.8 11.2 22.8C8.8 22.8 7.6 21 8 18.6C8.3 16.6 9.1 15.4 8.4 13.8C7.7 12.6 6.4 12 6.4 10.4Z"/>' +
  '<circle cx="7.6" cy="5.2" r="2.1"/><circle cx="11.2" cy="3.4" r="1.6"/><circle cx="14.1" cy="4" r="1.4"/>' +
  '<circle cx="16.4" cy="5.5" r="1.2"/><circle cx="18.1" cy="7.6" r="1.05"/></svg>';

const MARKER = "<!--walkr-foot-->";

/** The page template with the logo in place of each marker. */
export function withFoot(html) {
  return html.replaceAll(MARKER, WALKR_FOOT);
}
