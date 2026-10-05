// Pi 0.87.1 interactive layout fixtures for sidebar tests.
// Regular mode mounts seven children; fullscreen uses createChatViewport()'s
// VStack([ScrollView(document), VStack(dock)]). Keep in step with Pi's interactive-mode.js.
import { ScrollView, TuiAltScreen, TuiMainScreen, VStack } from '@earendil-works/pi-tui';

export function terminal(columns = 140, rows = 45) {
  const term = { columns, rows, writes: [], cursorShown: 0, write(data) { term.writes.push(data); }, hideCursor() {},
    showCursor() { term.cursorShown++; }, start() {}, stop() {} };
  return term;
}

/** A component with a mutable row count that records the widths it was rendered at. */
export function block(name, rows = 1) {
  const part = { name, rows, widths: [], line: i => `${name}-${i}`,
    render(width) { part.widths.push(width); return Array.from({ length: part.rows }, (_, i) => part.line(i)); },
    invalidate() {} };
  return part;
}

/** Mount Pi's transcript + dock. Returns the named parts so tests can change dock heights. */
export function mountPiLayout(tui, { chatRows = 4, editorRows = 3, footerRows = 4, widgetRows = 0 } = {}) {
  const parts = { chat: block('chat', chatRows), pending: block('pending', 0), status: block('status', 0),
    above: block('above', widgetRows), editor: block('editor', editorRows), below: block('below', 0),
    footer: block('footer', footerRows) };
  const dock = [parts.pending, parts.status, parts.above, parts.editor, parts.below, parts.footer];
  if (tui.mode === 'fullscreen') {
    parts.root = new VStack([{ component: new ScrollView(parts.chat), basis: 0, grow: 1, shrink: 1, minSize: 1 },
      { component: new VStack(dock.map(component => ({ component, shrink: 1, minSize: 0 }))), basis: 'auto', grow: 0, shrink: 1, minSize: 1 }]);
    tui.setLayoutRoot(parts.root);
  } else {
    for (const child of [parts.chat, ...dock]) tui.addChild(child);
  }
  parts.dockRows = () => dock.reduce((sum, part) => sum + part.rows, 0);
  return parts;
}

export function createTui(mode, term = terminal(), Screen) {
  const tui = new (Screen ?? (mode === 'regular' ? TuiMainScreen : TuiAltScreen))(term);
  tui.requestRender = () => {};
  return tui;
}
