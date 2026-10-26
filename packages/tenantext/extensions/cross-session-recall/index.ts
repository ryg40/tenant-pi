import { existsSync } from "node:fs";
import { join } from "node:path";
import { CustomEditor, getAgentDir, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent } from "@earendil-works/pi-tui";
import { RecallStore, isRecallableText, normalizeText, storeDir, type HistoryItem } from "./store.ts";

/**
 * Cross-session input recall: every interactive input goes to one SQLite store shared by the Pi
 * profiles of the user. The newest distinct inputs seed the Up/Down history of the editor;
 * `/recall [query]` searches the whole store and `/recall-clear` empties it after a yes.
 * No model call and no network request.
 */

const NATIVE_HISTORY_LIMIT = 100;
const SELECT_LIMIT = 200;
const AUTOCOMPLETE_LIMIT = 20;
// Global, so that a factory of an earlier load of this module is also known.
const MARK = Symbol.for("pi.cross-session-recall.editor-factory");
type EditorFactory = NonNullable<ReturnType<ExtensionUIContext["getEditorComponent"]>>;
type Marked = EditorFactory & { [MARK]?: { base: EditorFactory | undefined } };

const oneLine = (text: string): string => text.replace(/\s+/g, " ");
const formatItem = (item: HistoryItem, position: number): string => {
  const date = new Date(item.timestamp).toISOString().slice(0, 10);
  const line = oneLine(item.text);
  return `${position + 1}. ${date}  ${line.slice(0, 160)}${line.length > 160 ? "…" : ""}`;
};
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export default function crossSessionRecall(pi: ExtensionAPI): void {
  // A user copy in <agent dir>/extensions is the same extension: it keeps the store and the commands, this copy stands down.
  const user = join(getAgentDir(), "extensions");
  if (existsSync(join(user, "cross-session-recall.ts")) || existsSync(join(user, "cross-session-recall", "index.ts"))) return;

  let store: RecallStore | undefined;
  // After a failed open the extension is inert for the process: Pi's editor works, one warning was shown.
  let failed = false;

  /** The open store, or undefined after one failed open. Only `session_start` opens; an input after a shutdown is dropped. */
  const open = (ctx: ExtensionContext): RecallStore | undefined => {
    if (store || failed) return store;
    try {
      store = new RecallStore(storeDir());
    } catch (error) {
      failed = true;
      ctx.ui.notify(`Cross-session recall is off, the store did not open: ${reason(error)}`, "warning");
      return undefined;
    }
    try {
      const imported = store.migrateLegacy();
      if (imported > 0) ctx.ui.notify(`Migrated ${imported} recall entries to SQLite`, "info");
    } catch (error) {
      ctx.ui.notify(`Cross-session recall: history.json not imported: ${reason(error)}`, "warning");
    }
    return store;
  };

  /**
   * Put the own factory on the current one. The factory reads the seed from the store each time it runs,
   * so an editor that another extension rebuilds later also has the inputs of this session.
   */
  const install = (ui: ExtensionUIContext): void => {
    const current = ui.getEditorComponent() as Marked | undefined;
    // A factory of this extension is not wrapped again: its base is used.
    const base = current?.[MARK] ? current[MARK].base : current;
    const factory: Marked = (tui, theme, keybindings): EditorComponent => {
      const editor = base ? base(tui, theme, keybindings) : new CustomEditor(tui, theme, keybindings);
      if (editor.addToHistory) {
        // Native history prepends and caps itself, so seed oldest to newest.
        for (const item of (store?.query("", NATIVE_HISTORY_LIMIT) ?? []).reverse()) editor.addToHistory(item.text);
      }
      return editor;
    };
    factory[MARK] = { base };
    ui.setEditorComponent(factory);
  };

  pi.on("session_start", (_event, ctx) => {
    // Print, JSON and RPC runs get no store: nothing of theirs is interactive.
    if (ctx.mode !== "tui" || !open(ctx)) return;
    install(ctx.ui);
    ctx.ui.setStatus("recall", `${store?.query("", NATIVE_HISTORY_LIMIT).length ?? 0} recalled`);
  });

  pi.on("input", (event, ctx) => {
    // Print, JSON and RPC runs send source "interactive" too; none of their inputs is stored.
    if (ctx.mode !== "tui" || event.source !== "interactive") return { action: "continue" };
    const text = normalizeText(event.text);
    if (!isRecallableText(text)) return { action: "continue" };
    try {
      store?.add({ text, timestamp: Date.now(), cwd: ctx.cwd, sessionFile: ctx.sessionManager.getSessionFile() });
    } catch (error) {
      ctx.ui.notify(`Could not save recall history: ${reason(error)}`, "warning");
    }
    return { action: "continue" };
  });

  pi.on("session_shutdown", () => {
    store?.close();
    store = undefined;
  });

  pi.registerCommand("recall", {
    description: "Search cross-session user input history and paste one into the editor",
    getArgumentCompletions: (prefix) => {
      const items = (store?.query(prefix, AUTOCOMPLETE_LIMIT) ?? []).map((item) => ({ value: item.text, label: oneLine(item.text).slice(0, 80) }));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      if (!store) return ctx.ui.notify("Cross-session recall is off", "warning");
      const query = normalizeText(args);
      const matches = store.query(query, SELECT_LIMIT);
      if (!matches.length) return ctx.ui.notify(query ? `No recalled messages match: ${query}` : "No recalled messages yet", "warning");
      if (!ctx.hasUI) return;
      const labels = matches.map(formatItem);
      const selected = await ctx.ui.select("Recall message", labels);
      const item = selected ? matches[labels.indexOf(selected)] : undefined;
      if (item) ctx.ui.setEditorText(item.text);
    },
  });

  pi.registerCommand("recall-clear", {
    description: "Permanently clear all cross-session input recall history",
    handler: async (_args, ctx) => {
      if (!store) return ctx.ui.notify("Cross-session recall is off", "warning");
      if (!ctx.hasUI || !(await ctx.ui.confirm("Clear recall history?", "Permanently delete every stored input?"))) return;
      store.clear();
      // The same chain of factories builds a new editor, so the live Up/Down history is empty too.
      if (ctx.mode === "tui") ctx.ui.setEditorComponent(ctx.ui.getEditorComponent());
      ctx.ui.setStatus("recall", "0 recalled");
      ctx.ui.notify("Recall history cleared", "info");
    },
  });
}
