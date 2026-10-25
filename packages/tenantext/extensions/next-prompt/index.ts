import { CustomEditor, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, matchesKey, renderFakeCursor, visibleWidth, type EditorComponent, type TUI } from "@earendil-works/pi-tui";
import { dummiesOn, herdrRole, statePath } from "./dummies.ts";
import { suggestFromBranch } from "./report.ts";
import { defaults, loadSettings, SETTINGS_EVENT, type Settings } from "../../src/next-prompt-settings.ts";

/**
 * One next-action suggestion in the empty editor, read from the final dummies report of the branch.
 * No model call, no network request, no message and no session entry: the suggestion lives only in memory.
 */

// Global, so that a factory of an earlier load of this module is also known.
const MARK = Symbol.for("tenantext.next-prompt.factory");
type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type Marked = EditorFactory & { [MARK]?: { base: EditorFactory | undefined } };
// The smallest room for the faint text; with less room the editor draws its own line.
const MIN_ROOM = 8;

export interface Dependencies {
  loadSettings(): { settings: Settings; warning?: string };
  dummiesOn(): boolean;
  /** A role name, "unknown", or undefined outside Herdr. */
  herdrRole(): Promise<string | undefined>;
}
const real: Dependencies = {
  loadSettings: () => loadSettings(),
  dummiesOn: () => dummiesOn(statePath()),
  herdrRole: () => herdrRole(),
};

/**
 * The empty content line with the faint text after the cursor, or undefined when the line does not have the
 * expected form: spaces, the cursor marker, the fake cursor, then spaces. The caller then draws the line unchanged.
 * A text that does not fit is not cut: it gives undefined too.
 */
export function ghostLine(line: string, text: string, faint: (text: string) => string): string | undefined {
  const cursor = renderFakeCursor(" ");
  const at = line.indexOf(cursor);
  if (at < 0) return undefined;
  const before = line.slice(0, at).replace(CURSOR_MARKER, "");
  const after = line.slice(at + cursor.length);
  if (!/^ *$/.test(before) || !/^ +$/.test(after)) return undefined;
  const room = after.length - 1;
  if (room < MIN_ROOM || visibleWidth(text) > room) return undefined;
  const result = line.slice(0, at + cursor.length) + faint(text) + " ".repeat(after.length - visibleWidth(text));
  return visibleWidth(result) === visibleWidth(line) ? result : undefined;
}

export function createNextPrompt(pi: ExtensionAPI, deps: Dependencies = real): void {
  let settings: Settings = { ...defaults };
  let ctx: ExtensionContext | undefined;
  let role: Promise<string | undefined> = Promise.resolve(undefined);
  let suggestion: string | undefined;
  let shown = false;
  let tui: TUI | undefined;
  let own: Marked | undefined;
  let generation = 0;

  const clear = () => {
    const had = suggestion !== undefined;
    suggestion = undefined;
    shown = false;
    if (had) tui?.requestRender();
  };
  // Busy or queued work hides the suggestion. A context of an old session counts as busy.
  const quiet = () => {
    try { return !!ctx && ctx.isIdle() && !ctx.hasPendingMessages(); } catch { return false; }
  };

  // Only the layer of the current own factory acts. An older layer below the factory of another extension passes through.
  const decorate = (editor: EditorComponent, faint: (text: string) => string, layer: Marked) => {
    const render = editor.render.bind(editor);
    const handleInput = editor.handleInput.bind(editor);
    editor.render = (width: number) => {
      const lines = render(width);
      if (own !== layer) return lines;
      shown = false;
      if (suggestion === undefined || editor.getText() !== "" || !quiet() || lines.length < 3) return lines;
      const line = ghostLine(lines[1], suggestion, faint);
      if (line === undefined) return lines;
      shown = true;
      return [lines[0], line, ...lines.slice(2)];
    };
    editor.handleInput = (data: string) => {
      if (own === layer && suggestion !== undefined) {
        // Tab takes the text into the editor only when the editor is empty and the text is on the screen.
        if (shown && editor.getText() === "" && matchesKey(data, "tab")) {
          const text = suggestion;
          clear();
          editor.setText(text);
          tui?.requestRender();
          return;
        }
        clear();
      }
      handleInput(data);
    };
    return editor;
  };

  /** Put the own factory on top of the current one, when the own factory is not on top. */
  const install = (ui: ExtensionUIContext) => {
    const current = ui.getEditorComponent() as Marked | undefined;
    if (own && current === own) return;
    // A factory of this extension is not wrapped again: its base is used.
    const base = current?.[MARK] ? current[MARK].base : current;
    const faint = (text: string) => ui.theme.fg("dim", text);
    const factory: Marked = (screen, theme, keybindings) => {
      tui = screen;
      const editor = base ? base(screen, theme, keybindings) : new CustomEditor(screen, theme, keybindings);
      return decorate(editor, faint, factory);
    };
    factory[MARK] = { base };
    own = factory;
    ui.setEditorComponent(factory);
  };

  /** Give the editor back to the factory below, when the own factory is still on top. */
  const uninstall = () => {
    const mine = own;
    own = undefined;
    tui = undefined;
    if (!mine || !ctx || ctx.mode !== "tui") return;
    try {
      if (ctx.ui.getEditorComponent() === mine) ctx.ui.setEditorComponent(mine[MARK]?.base);
    } catch { /* an old context: the session runtime resets the editor */ }
  };

  const reset = () => { generation++; clear(); own = undefined; tui = undefined; };

  pi.on("session_start", (_event, next) => {
    reset();
    ctx = next;
    const loaded = deps.loadSettings();
    settings = loaded.settings;
    if (next.mode !== "tui") return;
    role = deps.herdrRole().catch(() => undefined);
    if (loaded.warning) next.ui.notify(loaded.warning, "warning");
  });
  pi.on("agent_start", () => clear());
  pi.on("session_tree", () => clear());
  const unsubscribe = pi.events.on(SETTINGS_EVENT, (value: unknown) => {
    if (!value || typeof value !== "object" || typeof (value as { enabled?: unknown }).enabled !== "boolean") return;
    settings = { ...settings, enabled: (value as { enabled: boolean }).enabled };
    if (!settings.enabled) { clear(); uninstall(); }
  });
  pi.on("session_shutdown", () => { reset(); ctx = undefined; unsubscribe(); });

  pi.on("agent_settled", async (event, settled) => {
    clear();
    if (event.aborted || settled.mode !== "tui" || !settings.enabled || !deps.dummiesOn()) return;
    const turn = generation;
    const found = await role;
    // A task session gets no suggestion. Outside Herdr, or with no role in the name, the start prompt decides.
    if (turn !== generation || (found !== undefined && found !== "unknown" && found !== "coordinator")) return;
    ctx = settled;
    if (!quiet() || settled.ui.getEditorText() !== "") return;
    const result = suggestFromBranch(settled.sessionManager.getBranch());
    if (result.kind !== "suggestion") return;
    suggestion = result.text;
    install(settled.ui);
    tui?.requestRender();
  });
}

export default function nextPrompt(pi: ExtensionAPI): void {
  createNextPrompt(pi);
}
