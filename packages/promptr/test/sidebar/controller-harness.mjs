// Shared fixtures for the Promptr sidebar controller tests. Temporary state only; fake send sink.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TuiAltScreen, TuiMainScreen } from '@earendil-works/pi-tui';
import { SidebarStore } from '../../dist/src/sidebar/store.mjs';
import { registerSidebar } from '../../dist/src/sidebar/controller.mjs';
import { attachSidebarTelemetry } from '../../dist/src/sidebar/telemetry.mjs';
import { mountPiLayout } from './pi-layout-fixture.mjs';
import { createInteractiveTuiReference, proxyByDefault } from './pi-proxy-fixture.mjs';

export const theme = { fg: (_color, value) => value, bold: value => value, italic: value => value };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptr-sidebar-'));
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, 'agent');
  t.after(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; fs.rmSync(root, { recursive: true, force: true }); });
  return { root, store: new SidebarStore(root) };
}

export function terminal() {
  return { columns: 140, rows: 45, write() {}, hideCursor() {}, showCursor() {}, start() {}, stop() {} };
}
export function controllerHarness(t, mode = 'tui', options = {}) {
  const { root, store } = fixture(t);
  const events = new Map(), commands = new Map(), shortcuts = new Map(), listeners = new Set();
  const notices = [], records = [], sends = [], overlays = [];
  let reviews = 0, launches = 0, closed = 0, active = 0, workspaces = 0, confirms = 0;
  let editor = async () => 'Draft from editor';
  const tui = new (options.fullscreen ? TuiAltScreen : TuiMainScreen)(terminal()); tui.requestRender = () => {};
  const parts = options.layout !== false ? mountPiLayout(tui) : undefined; // an unrecognized layout keeps the sidebar hidden
  // `tui` is the first renderer; factories receive `ui`, which is Pi's real stable reference when `proxy` is on.
  let current = tui;
  const ui = (options.proxy ?? proxyByDefault) ? createInteractiveTuiReference(() => current) : tui;
  // Pi 0.87.1: pi.on() keeps every handler and returns its unsubscribe function (telemetry relies on it).
  const pi = {
    on(name, fn) { const list = events.get(name) ?? []; list.push(fn); events.set(name, list); return () => { const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; },
    registerCommand: (name, c) => commands.set(name, c), registerShortcut: (name, c) => shortcuts.set(name, c), exec: () => launches++,
    sendUserMessage: (text, opts) => sends.push({ text, opts }),
    getActiveTools: () => ['read'], getAllTools: () => [{ name: 'read' }],
  };
  const state = { sessionId: options.sessionId ?? 'test', leaf: 'leaf', idle: true, pending: false, trusted: options.trusted ?? false };
  const sessionManager = { getSessionId: () => state.sessionId, getLeafId: () => state.leaf, getBranch: () => [], getEntries: () => [],
    getSessionName: () => undefined, getSessionFile: () => path.join(root, 'session.jsonl') };
  const ctx = { mode, cwd: root, hasUI: mode === 'tui' || mode === 'rpc', isIdle: () => state.idle, hasPendingMessages: () => state.pending,
    isProjectTrusted: () => state.trusted,
    getContextUsage: () => ({ percent: 25 }), model: { id: 'fixture-model', provider: 'fixture' }, modelRegistry: { isUsingOAuth: () => false },
    sessionManager, ui: {
      notify: text => notices.push(text),
      onTerminalInput(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      editor: (...args) => editor(...args),
      select: async (_title, labels, opts) => options.select ? options.select(labels, opts) : labels[0],
      input: async () => undefined,
      confirm: async (_title, _message, opts) => { confirms++; return options.confirm ? options.confirm(opts) : true; },
      // Mirrors Pi 0.87.1 showExtensionCustom: the factory runs synchronously, the overlay is shown in a
      // microtask, onHandle receives its handle, and every overlay done() calls tui.hideOverlay(), which pops
      // the TOP overlay whether or not it belongs to the caller (and even if it was never shown).
      custom(factory, opts) {
        active++;
        return new Promise(resolve => {
          let finished = false;
          const entry = {};
          const component = factory(ui, theme, {}, value => {
            if (finished) return; finished = true; closed++; active--;
            const i = overlays.indexOf(entry); if (i >= 0) overlays.splice(i, 1);
            if (opts?.overlay) ui.hideOverlay();
            resolve(value);
          });
          entry.component = component;
          if (finished) return;
          overlays.push(entry);
          Promise.resolve(component).then(() => {
            if (finished || !opts?.overlay) return;
            const overlayOptions = typeof opts.overlayOptions === 'function' ? opts.overlayOptions() : opts.overlayOptions;
            entry.handle = ui.showOverlay(component, overlayOptions);
            opts.onHandle?.(entry.handle);
          });
        });
      },
    } };
  const control = options.register ? options.register(pi) : registerSidebar(pi, { attempts: options.attempts ?? new Set(), workspace: async (...args) => { workspaces++; await options.workspace?.(...args); },
    review: options.review ?? (async () => reviews++),
    refresh: async () => ['Refreshed'], record: (...args) => records.push(args),
    // Real telemetry, with the Git seam replaced so no process runs.
    attachTelemetry: o => {
      const telemetry = attachSidebarTelemetry({ ...o, autoCompact: true, inspectWorkspace: async () => ({ kind: 'unavailable' }) });
      return options.wrapTelemetry ? options.wrapTelemetry(telemetry) : telemetry;
    } });
  t.after(async () => { await emit('session_shutdown'); control?.dispose?.(); });
  const emit = async name => { for (const fn of [...(events.get(name) ?? [])]) await fn({ type: name }, ctx); };
  return { root, store, ctx, pi, parts, events, commands, shortcuts, listeners, notices, tui, ui, records, sends, overlays,
    /** Pi's switchTuiMode: refused while overlay entries exist; otherwise later reads go to `next`. */
    renderer: () => current,
    replaceRenderer: next => { if (current.hasOverlayEntries) return false; current = next; return true; },
    press: raw => { for (const fn of [...listeners]) if (fn(raw)?.consume) break; },
    edit: fn => { editor = fn; },
    counts: () => ({ reviews, launches, active, closed, workspaces, confirms }),
    state,
    emit,
    command: (name, args = '') => commands.get(name).handler(args, ctx),
    shortcut: name => shortcuts.get(name).handler(ctx),
    sidebar: () => overlays.find(entry => entry.handle && typeof entry.component.handleInput !== 'function')?.component,
    dialog: () => [...overlays].reverse().find(entry => typeof entry.component.handleInput === 'function')?.component,
  };
}
