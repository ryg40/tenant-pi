// Vendored from pi-atelier v0.12.0 src/split-pane.ts (tag 3ff521f618cf, commit 371b847e525f).
// MIT License, Copyright (c) 2026 Michael. See packages/promptr/docs/PI-ATELIER-LICENSE.txt and
// packages/promptr/docs/atelier-adaptation.md for provenance and Promptr adaptations.
// Promptr: the only split implementation. It splits the transcript only, keeps Pi's
// pending/status/widgets/editor/footer dock full width below it, and shows no sidebar
// when that dock is not recognized. ../split-pane.mts re-exports this module.
import type { Component, OverlayHandle, OverlayOptions, TUI } from "@earendil-works/pi-tui";
import { compositeTuiLine, HStack, isViewportTUI, matchesKey, sliceByColumn, VStack } from "@earendil-works/pi-tui";
import { fullscreenDock, regularDock } from "../../dock-layout.mts";
import { createImageCompositorBinding } from "./image-compositor.mts";

/** Shown once when Pi's layout is not recognized; the sidebar stays off instead of shrinking the dock. */
export const UNSUPPORTED_LAYOUT_MESSAGE =
	"Promptr sidebar is off: this Pi layout is not recognized. Use /promptr workspace instead.";

const ENABLE_MOUSE = "\u001b[?1002h\u001b[?1006h";
const DISABLE_MOUSE = "\u001b[?1006l\u001b[?1002l";
const SGR_MOUSE = /^\u001b\[<(\d+);(\d+);(\d+)([Mm])$/;
/**
 * Pi's fullscreen mouse dispatch already reaches the transcript and sidebar through their layout
 * boxes, deepest first. It skips a stack only when its handler is Pi's own bundled
 * `Container.prototype.handleMouse`; Promptr's pi-tui copy has a different prototype, and that
 * inherited handler renders every child to measure it. Every mouse move then re-rendered the
 * transcript and sidebar several times and held the main thread at 100% CPU.
 */
function layoutOnly<T extends HStack | VStack>(stack: T): T {
	stack.handleMouse = () => undefined;
	return stack;
}

const PI_084_REGULAR_RENDER_ADAPTER = Symbol("promptr.atelier.regular-render-adapter");
const PI_084_FULLSCREEN_LAYOUT_ADAPTER = Symbol("promptr.atelier.fullscreen-layout-adapter");
const PI_084_FULLSCREEN_OVERLAY_ADAPTER = Symbol("promptr.atelier.fullscreen-overlay-adapter");
const PI_084_FULLSCREEN_SELECTION_ADAPTER = Symbol("promptr.atelier.fullscreen-selection-adapter");

type SelectionColumns = (
	line: string,
	row: number,
	selection: { start: { scrollView?: unknown } },
	minColumn?: number,
	maxColumn?: number,
) => { start: number; end: number };
type ApplySelection = (screen: string[], layout?: unknown) => string[];

interface FullscreenSelectionAdapterState {
	owner: object;
	baseSelectionColumns: SelectionColumns;
	baseApplySelection?: ApplySelection;
}

interface RegularRenderAdapterState {
	owner: object;
	baseRender: TUI["render"];
}

interface FullscreenLayoutAdapterState {
	owner: object;
	originalRoot: Component;
	splitRoot: Component;
	sidebarWidth: number;
	sidebarComponent: Component | undefined;
}

interface FullscreenOverlayAdapterState {
	owner: object;
	baseShowOverlay: TUI["showOverlay"];
	baseHideOverlay: TUI["hideOverlay"];
}

type AdaptedTui = TUI & {
	[PI_084_REGULAR_RENDER_ADAPTER]: RegularRenderAdapterState | undefined;
	[PI_084_FULLSCREEN_LAYOUT_ADAPTER]: FullscreenLayoutAdapterState | undefined;
	[PI_084_FULLSCREEN_OVERLAY_ADAPTER]: FullscreenOverlayAdapterState | undefined;
	[PI_084_FULLSCREEN_SELECTION_ADAPTER]: FullscreenSelectionAdapterState | undefined;
	getSelectionColumns?: SelectionColumns;
	applySelection?: ApplySelection;
	layoutRoot?: Component;
	setLayoutRoot(component: Component | undefined): void;
};

export interface SgrMouseEvent {
	button: number;
	x: number;
	y: number;
	release: boolean;
	motion: boolean;
}

export function parseSgrMouseEvent(data: string): SgrMouseEvent | undefined {
	const match = data.match(SGR_MOUSE);
	if (!match) return undefined;
	const button = Number(match[1]);
	const x = Number(match[2]);
	const y = Number(match[3]);
	if (![button, x, y].every(Number.isFinite) || x < 1 || y < 1) return undefined;
	return { button, x, y, release: match[4] === "m", motion: (button & 32) !== 0 };
}

export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 72;
export const MIN_MAIN_WIDTH = 64;

export interface SplitPaneControllerOptions {
	defaultSidebarWidth?: number;
	minSidebarWidth?: number;
	maxSidebarWidth?: number;
	minMainWidth?: number;
	onError?(error: unknown): void;
	subscribeInput?(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	onResizeChange?(resizing: boolean): void;
	onWarning?(message: string): void;
	/** Promptr: each render request the split pane issues itself (attach, show, hide, width, resize). Diagnostics only. */
	onRenderRequest?(reason: string): void;
}

export interface SplitPaneController {
	attach(tui: TUI): void;
	show(): void;
	hide(): void;
	setSidebarWidth(width: number): void;
	getSidebarWidth(): number;
	/** Rows above Pi's real pending/status/widgets/editor/footer dock. */
	getSidebarHeight(): number;
	/** False when Pi's dock is not recognized; the sidebar then stays hidden. */
	isLayoutSupported(): boolean;
	isEnabled(): boolean;
	isVisibleAtWidth(terminalWidth: number): boolean;
	beginResize(): boolean;
	finishResize(): void;
	cancelResize(): void;
	isResizing(): boolean;
	overlayOptions(): OverlayOptions;
	/** Ask Pi for a frame. Renderer adapters are re-synced only when the layout changed since the last sync. */
	requestRender(): void;
	dispose(): void;
}

const finiteInteger = (value: number, fallback: number): number =>
	Number.isFinite(value) ? Math.trunc(value) : fallback;

const clamp = (value: number, minimum: number, maximum: number): number =>
	Math.min(maximum, Math.max(minimum, value));

const EMPTY_SIDEBAR_COMPONENT: Component = {
	render: () => [],
	invalidate() {},
};

export function createSplitPaneController(options: SplitPaneControllerOptions = {}): SplitPaneController {
	const minimumSidebar = Math.max(
		1,
		finiteInteger(options.minSidebarWidth ?? MIN_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH),
	);
	const maximumSidebar = Math.max(
		minimumSidebar,
		finiteInteger(options.maxSidebarWidth ?? MAX_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH),
	);
	const minimumMain = Math.max(1, finiteInteger(options.minMainWidth ?? MIN_MAIN_WIDTH, MIN_MAIN_WIDTH));
	let sidebarWidth = clamp(
		finiteInteger(options.defaultSidebarWidth ?? DEFAULT_SIDEBAR_WIDTH, DEFAULT_SIDEBAR_WIDTH),
		minimumSidebar,
		maximumSidebar,
	);
	let tui: TUI | undefined;
	let enabled = false;
	let disposed = false;
	let resizing = false;
	let resizeStartWidth = sidebarWidth;
	let dragging = false;
	let unsubscribeInput: (() => void) | undefined;
	let resizeMouseTerminal: TUI["terminal"] | undefined;
	let fullscreenSidebarComponent: Component | undefined;
	let fullscreenSidebarHidden = false;
	let imageCompositor: ReturnType<typeof createImageCompositorBinding> | undefined;
	let controller: SplitPaneController;
	const adapterOwner = {};
	let unsupportedReported = false;
	let syncedLayout: readonly unknown[] | undefined;

	/** Pi's own dock for the current renderer, or undefined for an unrecognized layout. */
	const currentDock = (): readonly Component[] | undefined => {
		if (!tui) return undefined;
		const adaptedTui = tui as AdaptedTui;
		if (isPiFullscreenRenderer()) {
			const state = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
			if (state && state.owner !== adapterOwner) return undefined;
			const root = state ? state.originalRoot : adaptedTui.layoutRoot;
			const dock = root ? fullscreenDock(root)?.dock : undefined;
			return dock ? [dock] : undefined;
		}
		if (tui.mode !== "regular") return undefined;
		const state = adaptedTui[PI_084_REGULAR_RENDER_ADAPTER];
		if (state ? state.owner !== adapterOwner : !findPrototypeRender(tui)) return undefined;
		return regularDock(tui)?.dock;
	};
	const layoutSupported = (): boolean => currentDock() !== undefined;
	// Measure the real dynamic dock (multiline drafts, widgets, statuses, any footer height).
	const getSidebarHeight = (): number => {
		if (!tui) return 0;
		const dock = currentDock();
		if (!dock) return 0;
		const width = tui.terminal.columns;
		const rows = dock.reduce((sum, component) => sum + component.render(width).length, 0);
		return Math.max(0, tui.terminal.rows - rows);
	};
	const restoreStoppedCursor = () => {
		// Pi can close overlays after stop() restored the terminal (upstream #72).
		// Never change the cursor of a live renderer.
		if (tui && (tui as unknown as { stopped?: boolean }).stopped === true) tui.terminal.showCursor();
	};

	const findPrototypeRender = (nextTui: TUI): TUI["render"] | undefined => {
		let prototype = Object.getPrototypeOf(nextTui) as object | null;
		if ((prototype as { constructor?: { name?: string } } | null)?.constructor?.name !== "TuiMainScreen") {
			return undefined;
		}
		while (prototype) {
			const descriptor = Object.getOwnPropertyDescriptor(prototype, "render");
			if (typeof descriptor?.value === "function") return descriptor.value as TUI["render"];
			prototype = Object.getPrototypeOf(prototype) as object | null;
		}
		return undefined;
	};

	const findPrototypeOverlayMethods = (
		nextTui: TUI,
	): { showOverlay: TUI["showOverlay"]; hideOverlay: TUI["hideOverlay"] } | undefined => {
		let prototype = Object.getPrototypeOf(nextTui) as object | null;
		let showOverlay: TUI["showOverlay"] | undefined;
		let hideOverlay: TUI["hideOverlay"] | undefined;
		while (prototype && (!showOverlay || !hideOverlay)) {
			const showDescriptor = Object.getOwnPropertyDescriptor(prototype, "showOverlay");
			if (typeof showDescriptor?.value === "function")
				showOverlay = showDescriptor.value as TUI["showOverlay"];
			const hideDescriptor = Object.getOwnPropertyDescriptor(prototype, "hideOverlay");
			if (typeof hideDescriptor?.value === "function")
				hideOverlay = hideDescriptor.value as TUI["hideOverlay"];
			prototype = Object.getPrototypeOf(prototype) as object | null;
		}
		return showOverlay && hideOverlay ? { showOverlay, hideOverlay } : undefined;
	};

	const isPiFullscreenRenderer = (): boolean => tui?.mode === "fullscreen" && isViewportTUI(tui);

	const syncRegularRenderAdapter = () => {
		if (!tui || tui.mode !== "regular") return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_REGULAR_RENDER_ADAPTER];
		if (currentState?.owner === adapterOwner) return;
		// Another Atelier instance owns this renderer; do not stack private adapters.
		if (currentState) return;
		const baseRender = findPrototypeRender(tui);
		if (!baseRender) return;
		adaptedTui[PI_084_REGULAR_RENDER_ADAPTER] = { owner: adapterOwner, baseRender };
		adaptedTui.render = (width: number) => {
			const sidebar = effectiveSidebarWidth(width);
			const parts = sidebar > 0 ? regularDock(adaptedTui) : undefined;
			// Unrecognized children never reach here with a sidebar: visibleAt() is false.
			if (!parts) return Reflect.apply(baseRender, tui, [width]);
			// Only the transcript narrows. The dock keeps full width and sits on the last rows.
			const chat = parts.transcript.render(width - sidebar);
			const dock = parts.dock.flatMap((component) => component.render(width));
			const gap = Math.max(0, (tui?.terminal.rows ?? 0) - chat.length - dock.length);
			return [...chat, ...Array<string>(gap).fill(""), ...dock];
		};
	};

	const restoreRegularRenderAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_REGULAR_RENDER_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		adaptedTui.render = currentState.baseRender;
		adaptedTui[PI_084_REGULAR_RENDER_ADAPTER] = undefined;
	};

	/** Split only Pi's transcript; undefined when the root is not Pi's transcript + dock VStack. */
	const createFullscreenSplitRoot = (originalRoot: Component): Component | undefined => {
		const parts = fullscreenDock(originalRoot);
		if (!parts) return undefined;
		const splitBody = layoutOnly(new HStack([
			{ component: parts.transcript, basis: 0, grow: 1, shrink: 1, minSize: minimumMain },
			{
				component: fullscreenSidebarComponent ?? EMPTY_SIDEBAR_COMPONENT,
				basis: sidebarWidth,
				grow: 0,
				shrink: 1,
				minSize: minimumSidebar,
				maxSize: maximumSidebar,
				visible: ({ width }) => {
					reconcileResizeWidth(width);
					syncOverlayWidth(width);
					return !fullscreenSidebarHidden && visibleAt(width);
				},
			},
		]));
		return layoutOnly(new VStack([
			{ component: splitBody, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: parts.dock, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]));
	};

	const syncFullscreenLayoutAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (currentState && currentState.owner !== adapterOwner) return;
		const currentRoot = adaptedTui.layoutRoot;
		if (currentState?.owner === adapterOwner && currentRoot === currentState.splitRoot) {
			if (
				currentState.sidebarWidth === sidebarWidth &&
				currentState.sidebarComponent === fullscreenSidebarComponent
			) {
				return;
			}
			const splitRoot = createFullscreenSplitRoot(currentState.originalRoot);
			if (!splitRoot) return;
			adaptedTui.setLayoutRoot(splitRoot);
			currentState.splitRoot = splitRoot;
			currentState.sidebarWidth = sidebarWidth;
			currentState.sidebarComponent = fullscreenSidebarComponent;
			return;
		}
		if (!currentRoot) return;
		// Never wrap the whole screen: an unrecognized root keeps Pi's layout and no sidebar.
		const splitRoot = createFullscreenSplitRoot(currentRoot);
		if (!splitRoot) return;
		adaptedTui.setLayoutRoot(splitRoot);
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = {
			owner: adapterOwner,
			originalRoot: currentRoot,
			splitRoot,
			sidebarWidth,
			sidebarComponent: fullscreenSidebarComponent,
		};
	};

	const restoreFullscreenLayoutAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		if (adaptedTui.layoutRoot === currentState.splitRoot) {
			adaptedTui.setLayoutRoot(currentState.originalRoot);
		}
		adaptedTui[PI_084_FULLSCREEN_LAYOUT_ADAPTER] = undefined;
	};

	const syncFullscreenSelectionAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		if (adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER]) return;
		// Read the concrete method, not a forwarding function from Pi's stable proxy.
		let prototype = Object.getPrototypeOf(tui);
		while (prototype) {
			const base = Object.getOwnPropertyDescriptor(prototype, "getSelectionColumns")?.value;
			if (typeof base === "function") {
				const baseSelectionColumns = base as SelectionColumns;
				adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER] = { owner: adapterOwner, baseSelectionColumns };
				adaptedTui.getSelectionColumns = function (line, row, selection, minColumn, maxColumn) {
					const columns = baseSelectionColumns.call(this, line, row, selection, minColumn, maxColumn);
					// Pi falls back to screen selection when a drag starts outside a ScrollView
					// (e.g. the editor). This method serves both highlighting and OSC 52 copying.
					if (
						!selection.start.scrollView &&
						fullscreenSidebarComponent &&
						!fullscreenSidebarHidden &&
						!this.hasOverlay()
					) {
						const width = this.terminal.columns;
						const sidebar = effectiveSidebarWidth(width);
						// Dock rows below the sidebar are full width; never clip their right side.
						if (sidebar > 0 && row < getSidebarHeight()) {
							const mainWidth = width - sidebar;
							return { start: Math.min(columns.start, mainWidth), end: Math.min(columns.end, mainWidth) };
						}
					}
					return columns;
				};
				const baseApplySelection = Object.getOwnPropertyDescriptor(prototype, "applySelection")?.value;
				if (typeof baseApplySelection === "function") {
					adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER]!.baseApplySelection = baseApplySelection;
					adaptedTui.applySelection = function (screen, layout) {
						const selected = (baseApplySelection as ApplySelection).call(this, screen, layout);
						const width = this.terminal.columns;
						const sidebar = effectiveSidebarWidth(width);
						if (!fullscreenSidebarComponent || fullscreenSidebarHidden || sidebar <= 0 || this.hasOverlay()) {
							return selected;
						}
						const mainWidth = width - sidebar;
						const sidebarRows = getSidebarHeight();
						return selected.map((line, row) => {
							const original = screen[row];
							// Keep dock-row highlights across the full terminal width.
							if (original === undefined || line === original || row >= sidebarRows) return line;
							// Pi's selection slicing can replay the transcript background AFTER the
							// pane reset. Keep its highlighted main pane, but restore the original
							// sidebar through the compositor's state-aware suffix extraction.
							return compositeTuiLine(original, sliceByColumn(line, 0, mainWidth, true), 0, mainWidth, width);
						});
					};
				}
				return;
			}
			prototype = Object.getPrototypeOf(prototype);
		}
	};

	const restoreFullscreenSelectionAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const state = adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER];
		if (state?.owner !== adapterOwner) return;
		adaptedTui.getSelectionColumns = state.baseSelectionColumns;
		if (state.baseApplySelection) adaptedTui.applySelection = state.baseApplySelection;
		adaptedTui[PI_084_FULLSCREEN_SELECTION_ADAPTER] = undefined;
	};

	const syncFullscreenOverlayAdapter = () => {
		if (!isPiFullscreenRenderer() || !tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
		if (currentState?.owner === adapterOwner) return;
		if (currentState) return;
		const baseMethods = findPrototypeOverlayMethods(tui);
		if (!baseMethods) return;
		const { showOverlay: baseShowOverlay, hideOverlay: baseHideOverlay } = baseMethods;
		adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER] = {
			owner: adapterOwner,
			baseShowOverlay,
			baseHideOverlay,
		};
		adaptedTui.showOverlay = (component, overlayOptions) => {
			const state = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
			const base = state?.owner === adapterOwner ? state.baseShowOverlay : baseShowOverlay;
			if (enabled && overlayOptions === overlayLayout && isPiFullscreenRenderer()) {
				fullscreenSidebarComponent = component;
				fullscreenSidebarHidden = false;
				syncFullscreenLayoutAdapter();
				// ctx.ui.custom() only exposes persistent UI as an overlay. Keep a
				// non-visible overlay entry for its lifecycle promise, while the
				// actual Sidebar is rendered by the fullscreen HStack. Pi therefore
				// sees no visible overlay and can scope selection to the transcript
				// ScrollView instead of the composed terminal screen.
				const handle = Reflect.apply(base, tui, [
					component,
					{ ...overlayOptions, visible: () => false },
				]) as OverlayHandle;
				return {
					hide() {
						try {
							handle.hide();
						} finally {
							if (fullscreenSidebarComponent === component) {
								enabled = false;
								fullscreenSidebarComponent = undefined;
								syncFullscreenLayoutAdapter();
								tui?.requestRender();
							}
						}
					},
					setHidden(hidden) {
						handle.setHidden(hidden);
						if (fullscreenSidebarComponent === component) {
							fullscreenSidebarHidden = hidden;
							tui?.requestRender();
						}
					},
					isHidden: () => handle.isHidden(),
					focus: () => handle.focus(),
					unfocus: (options) => handle.unfocus(options),
					isFocused: () => handle.isFocused(),
					getBounds: () => handle.getBounds(),
				};
			}
			return Reflect.apply(base, tui, [component, overlayOptions]);
		};
		adaptedTui.hideOverlay = () => {
			const state = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
			const base = state?.owner === adapterOwner ? state.baseHideOverlay : baseHideOverlay;
			const hadVisibleOverlay = tui?.hasOverlay() ?? false;
			Reflect.apply(base, tui, []);
			if (!hadVisibleOverlay && fullscreenSidebarComponent) {
				enabled = false;
				fullscreenSidebarComponent = undefined;
				fullscreenSidebarHidden = false;
				syncFullscreenLayoutAdapter();
				tui?.requestRender();
			}
		};
	};

	const restoreFullscreenOverlayAdapter = () => {
		if (!tui) return;
		const adaptedTui = tui as AdaptedTui;
		const currentState = adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER];
		if (currentState?.owner !== adapterOwner) return;
		adaptedTui.showOverlay = currentState.baseShowOverlay;
		adaptedTui.hideOverlay = currentState.baseHideOverlay;
		adaptedTui[PI_084_FULLSCREEN_OVERLAY_ADAPTER] = undefined;
	};

	const prioritizeFullscreenResizeInput = (
		handler: (data: string) => { consume?: boolean; data?: string } | undefined,
	) => {
		if (!isPiFullscreenRenderer()) return;
		const listeners = (tui as unknown as { inputListeners?: Set<typeof handler> }).inputListeners;
		if (!(listeners instanceof Set) || !listeners.delete(handler)) return;
		// Pi 0.84's viewport listener consumes every mouse event for text selection.
		// Put Resize first temporarily; unsubscribe removes it without disturbing
		// the relative order of Pi's listener or other extension listeners.
		const existingListeners = [...listeners];
		listeners.clear();
		listeners.add(handler);
		for (const listener of existingListeners) listeners.add(listener);
	};

	const safely = (action: () => unknown) => {
		try {
			const result = action();
			if (result && typeof (result as PromiseLike<unknown>).then === "function") {
				void Promise.resolve(result).catch(() => undefined);
			}
		} catch {
			// Cleanup and error reporting are best effort; continue with remaining actions.
		}
	};

	// A hidden sidebar (narrow or unrecognized layout) must never own focus, input or rows.
	const visibleAt = (terminalWidth: number): boolean =>
		enabled &&
		Number.isFinite(terminalWidth) &&
		terminalWidth >= minimumMain + minimumSidebar &&
		layoutSupported();

	const effectiveSidebarWidth = (terminalWidth: number): number => {
		if (!visibleAt(terminalWidth)) return 0;
		return clamp(sidebarWidth, minimumSidebar, Math.min(maximumSidebar, terminalWidth - minimumMain));
	};

	const overlayLayout: OverlayOptions = {
		anchor: "top-right",
		width: sidebarWidth,
		maxHeight: "100%",
		margin: 0,
		nonCapturing: true,
		visible: (terminalWidth) => {
			reconcileResizeWidth(terminalWidth);
			syncOverlayWidth(terminalWidth);
			return visibleAt(terminalWidth);
		},
	};

	const syncOverlayWidth = (terminalWidth = tui?.terminal.columns) => {
		const effectiveWidth = terminalWidth === undefined ? 0 : effectiveSidebarWidth(terminalWidth);
		// The regular-mode overlay must end above the dock, whatever its current height.
		overlayLayout.maxHeight = Math.max(1, getSidebarHeight());
		overlayLayout.width = effectiveWidth > 0 ? effectiveWidth : sidebarWidth;
	};

	const reportLayoutSupport = () => {
		if (!tui || !enabled || disposed) return;
		if (layoutSupported()) {
			unsupportedReported = false;
			return;
		}
		if (unsupportedReported) return;
		unsupportedReported = true;
		safely(() => options.onWarning?.(UNSUPPORTED_LAYOUT_MESSAGE));
	};

	/**
	 * Promptr: everything the renderer adapters depend on. A replaced renderer has a new children array; Pi's
	 * own layout changes show as a new layout root or child count. Read through Pi's stable reference.
	 */
	const layoutKey = (): readonly unknown[] => {
		const adaptedTui = tui as AdaptedTui | undefined;
		return [adaptedTui, adaptedTui?.mode, adaptedTui?.children, adaptedTui?.children?.length, adaptedTui?.layoutRoot,
			enabled, sidebarWidth, fullscreenSidebarComponent, fullscreenSidebarHidden];
	};
	const syncAdapters = () => {
		imageCompositor?.sync();
		syncRegularRenderAdapter();
		syncFullscreenLayoutAdapter();
		syncFullscreenOverlayAdapter();
		syncFullscreenSelectionAdapter();
		reportLayoutSupport();
		syncedLayout = layoutKey();
	};
	// Promptr: requests with a reason come from mount, resize and hide and always re-sync; data-only requests
	// from the controller re-sync only after a layout change.
	const requestRender = (reason?: string) => {
		if (reason !== undefined) safely(() => options.onRenderRequest?.(reason));
		const synced = syncedLayout;
		if (reason !== undefined || !synced || layoutKey().some((value, index) => !Object.is(value, synced[index]))) syncAdapters();
		tui?.requestRender();
	};

	const stopResize = (restore: boolean) => {
		if (!resizing && !resizeMouseTerminal && !unsubscribeInput) return;
		if (restore) sidebarWidth = resizeStartWidth;
		syncOverlayWidth();
		syncFullscreenLayoutAdapter();
		const mouseTerminal = resizeMouseTerminal;
		const unsubscribe = unsubscribeInput;
		dragging = false;
		resizing = false;
		resizeMouseTerminal = undefined;
		unsubscribeInput = undefined;
		if (mouseTerminal) safely(() => mouseTerminal.write(DISABLE_MOUSE));
		if (unsubscribe) safely(unsubscribe);
		safely(() => options.onResizeChange?.(false));
		safely(() => requestRender("resize"));
	};

	const reconcileResizeWidth = (terminalWidth: number) => {
		if (!resizing) return;
		if (!visibleAt(terminalWidth)) {
			stopResize(true);
			return;
		}
		const effectiveMax = Math.min(maximumSidebar, terminalWidth - minimumMain);
		sidebarWidth = clamp(sidebarWidth, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
	};

	const attach = (nextTui: TUI) => {
		if (disposed) throw new Error("Cannot attach a disposed split pane");
		if (tui === nextTui) return;
		if (tui) throw new Error("Split pane is already attached to another TUI");
		tui = nextTui;
		imageCompositor = createImageCompositorBinding(nextTui, (width) => {
			if (!isPiFullscreenRenderer() || fullscreenSidebarHidden || !fullscreenSidebarComponent) {
				return undefined;
			}
			const sidebar = effectiveSidebarWidth(width);
			if (sidebar === 0) return undefined;
			// Image repair must stop at the dock; its rows belong to Pi's full-width editor/footer.
			const rows = getSidebarHeight();
			return {
				column: width - sidebar,
				width: sidebar,
				rows,
				lines: fullscreenSidebarComponent.render(sidebar).slice(0, rows),
			};
		});
		reconcileResizeWidth(nextTui.terminal.columns);
		syncOverlayWidth(nextTui.terminal.columns);
		requestRender("attach");
	};

	const handleResizeInput = (data: string): { consume?: boolean; data?: string } | undefined => {
		const mouse = parseSgrMouseEvent(data);
		if (mouse) {
			if (mouse.release) {
				if (dragging) stopResize(false);
				return { consume: true };
			}
			if (!mouse.motion && (mouse.button & 3) === 0 && (mouse.button & 64) === 0) {
				const dividerX = (tui?.terminal.columns ?? 0) - sidebarWidth + 1;
				if (Math.abs(mouse.x - dividerX) <= 1) dragging = true;
				return { consume: true };
			}
			if (mouse.motion && dragging && tui) {
				const proposed = tui.terminal.columns - mouse.x + 1;
				const effectiveMax = Math.min(maximumSidebar, tui.terminal.columns - minimumMain);
				sidebarWidth = clamp(proposed, minimumSidebar, Math.max(minimumSidebar, effectiveMax));
				syncOverlayWidth();
				requestRender("resize");
			}
			return { consume: true };
		}
		if (matchesKey(data, "shift+left")) {
			controller.setSidebarWidth(sidebarWidth + 4);
			return { consume: true };
		}
		if (matchesKey(data, "shift+right")) {
			controller.setSidebarWidth(sidebarWidth - 4);
			return { consume: true };
		}
		if (matchesKey(data, "left")) {
			controller.setSidebarWidth(sidebarWidth + 1);
			return { consume: true };
		}
		if (matchesKey(data, "right")) {
			controller.setSidebarWidth(sidebarWidth - 1);
			return { consume: true };
		}
		if (matchesKey(data, "enter")) {
			stopResize(false);
			return { consume: true };
		}
		if (matchesKey(data, "escape")) {
			stopResize(true);
			return { consume: true };
		}
		return undefined;
	};

	controller = {
		attach,
		show() {
			if (disposed || enabled) return;
			enabled = true;
			syncOverlayWidth();
			requestRender("show");
		},
		hide() {
			stopResize(true);
			if (!enabled) return;
			enabled = false;
			fullscreenSidebarComponent = undefined;
			fullscreenSidebarHidden = false;
			// Remove the sidebar even if subsequent compositor reconciliation fails.
			syncFullscreenLayoutAdapter();
			requestRender("hide");
			restoreStoppedCursor();
		},
		setSidebarWidth(width) {
			const next = clamp(finiteInteger(width, sidebarWidth), minimumSidebar, maximumSidebar);
			if (next === sidebarWidth) return;
			sidebarWidth = next;
			syncOverlayWidth();
			requestRender("width");
		},
		getSidebarWidth: () => sidebarWidth,
		getSidebarHeight,
		isLayoutSupported: layoutSupported,
		beginResize() {
			if (resizing) return true;
			if (!tui || !enabled) {
				options.onWarning?.("Promptr sidebar is not ready to resize");
				return false;
			}
			if (!visibleAt(tui.terminal.columns)) {
				options.onWarning?.("Terminal is too narrow to resize the Promptr sidebar");
				return false;
			}
			if (!options.subscribeInput) {
				options.onWarning?.("Terminal input is unavailable for sidebar resizing");
				return false;
			}
			sidebarWidth = effectiveSidebarWidth(tui.terminal.columns);
			syncOverlayWidth();
			syncFullscreenLayoutAdapter();
			resizeStartWidth = sidebarWidth;
			dragging = false;
			resizing = true;
			try {
				unsubscribeInput = options.subscribeInput(handleResizeInput);
				prioritizeFullscreenResizeInput(handleResizeInput);
				resizeMouseTerminal = isPiFullscreenRenderer() ? undefined : tui.terminal;
				resizeMouseTerminal?.write(ENABLE_MOUSE);
				options.onResizeChange?.(true);
				requestRender("resize");
				return true;
			} catch (error) {
				stopResize(true);
				safely(() => options.onError?.(error));
				return false;
			}
		},
		finishResize: () => stopResize(false),
		cancelResize: () => stopResize(true),
		isResizing: () => resizing,
		isEnabled: () => enabled,
		isVisibleAtWidth: visibleAt,
		overlayOptions: () => overlayLayout,
		requestRender: () => requestRender(),
		dispose() {
			if (disposed) return;
			stopResize(true);
			disposed = true;
			enabled = false;
			fullscreenSidebarComponent = undefined;
			fullscreenSidebarHidden = false;
			// Each restore touches only hooks this instance installed; one failure must not skip the rest.
			safely(restoreRegularRenderAdapter);
			safely(restoreFullscreenOverlayAdapter);
			safely(restoreFullscreenSelectionAdapter);
			safely(restoreFullscreenLayoutAdapter);
			safely(() => imageCompositor?.dispose());
			imageCompositor = undefined;
			safely(() => tui?.requestRender());
			safely(restoreStoppedCursor);
			tui = undefined;
		},
	};
	return controller;
}
