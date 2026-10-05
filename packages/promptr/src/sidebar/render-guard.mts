// Render-request guard for the Promptr sidebar. Every sidebar request for a Pi frame passes through here:
// background sources (telemetry, panel registry, store timer, session events) are coalesced to a bounded
// rate, and a sustained storm is reported once by its top requester and then throttled.

export const RENDER_IDLE_INTERVAL_MS = 100;
/** Telemetry changes per streamed token; 4 frames/s keep the Activity panel current during a turn. */
export const RENDER_WORKING_INTERVAL_MS = 250;
export const RENDER_THROTTLED_INTERVAL_MS = 1000;
export const RENDER_STORM_RATE = 30;
export const RENDER_STORM_SECONDS = 5;

export interface RenderGuardOptions {
  /** Ask Pi for one frame (the split pane's requestRender). */
  flush(): void;
  /** An agent turn is running; background requests are spaced RENDER_WORKING_INTERVAL_MS apart. */
  isWorking(): boolean;
  /** A resize drag is active; every request is flushed at once. */
  isResizing(): boolean;
  /** Called once per guard when a storm is detected (the controller's warning notice). */
  warn(text: string): void;
  /** Test seams. */
  now?(): number;
  setTimer?(run: () => void, ms: number): { unref?(): unknown };
  clearTimer?(timer: unknown): void;
}

export interface RenderGuardStats {
  requests: number;
  flushed: number;
  throttled: boolean;
  warned: boolean;
  bySource: Record<string, number>;
}

export interface RenderGuard {
  /**
   * Request a frame on behalf of `source`. `urgent` requests answer the user (keys, focus, commands) and
   * are flushed at once unless the guard is throttling; others are coalesced.
   */
  request(source: string, urgent?: boolean): void;
  /** Count a request that another component already sent to Pi (split-pane show, hide, resize). */
  count(source: string): void;
  stats(): RenderGuardStats;
  dispose(): void;
}

export function createRenderGuard(options: RenderGuardOptions): RenderGuard {
  const now = options.now ?? Date.now;
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>));
  const bySource: Record<string, number> = {};
  let requests = 0;
  let flushed = 0;
  let disposed = false;
  let lastFlush = Number.NEGATIVE_INFINITY;
  let timer: unknown;
  // Per-second windows: a storm is RENDER_STORM_SECONDS consecutive windows above RENDER_STORM_RATE.
  let windowStart = now();
  let windowCount = 0;
  let windowSources = new Map<string, number>();
  let stormSources = new Map<string, number>();
  let stormWindows = 0;
  let calmWindows = 0;
  let throttled = false;
  let warned = false;

  const closeWindow = (count: number) => {
    if (count > RENDER_STORM_RATE) {
      stormWindows++;
      calmWindows = 0;
      for (const [source, n] of windowSources) stormSources.set(source, (stormSources.get(source) ?? 0) + n);
    } else {
      stormWindows = 0;
      stormSources = new Map();
      if (throttled && ++calmWindows >= RENDER_STORM_SECONDS) { throttled = false; calmWindows = 0; }
    }
    windowSources = new Map();
    if (stormWindows < RENDER_STORM_SECONDS || throttled) return;
    throttled = true;
    if (warned) return;
    warned = true;
    const [top = "unknown", topCount = 0] = [...stormSources].sort((a, b) => b[1] - a[1])[0] ?? [];
    const rate = Math.round([...stormSources.values()].reduce((sum, n) => sum + n, 0) / stormWindows);
    try {
      options.warn(`Promptr sidebar: ${rate} render requests/s for ${stormWindows}s (top requester: ${top}, ${topCount});`
        + ` sidebar redraws are throttled to 1/s until the rate drops.`);
    } catch { /* a failed notice must not stop the guard */ }
  };
  const count = (source: string) => {
    if (disposed) return;
    const at = now();
    const elapsed = Math.floor((at - windowStart) / 1000);
    if (elapsed >= 1) {
      closeWindow(windowCount);
      // Seconds with no request at all are calm windows.
      for (let i = 1; i < Math.min(elapsed, RENDER_STORM_SECONDS + 1); i++) closeWindow(0);
      windowStart += elapsed * 1000;
      windowCount = 0;
    }
    requests++;
    windowCount++;
    bySource[source] = (bySource[source] ?? 0) + 1;
    windowSources.set(source, (windowSources.get(source) ?? 0) + 1);
  };
  const flush = () => {
    if (timer !== undefined) { clearTimer(timer); timer = undefined; }
    lastFlush = now();
    flushed++;
    try { options.flush(); } catch { /* the split pane reports its own errors */ }
  };
  const interval = () => throttled ? RENDER_THROTTLED_INTERVAL_MS
    : options.isWorking() ? RENDER_WORKING_INTERVAL_MS : RENDER_IDLE_INTERVAL_MS;

  return {
    request(source, urgent = false) {
      if (disposed) return;
      count(source);
      if (options.isResizing() || (urgent && !throttled)) { flush(); return; }
      if (timer !== undefined) return;
      const wait = lastFlush + interval() - now();
      if (wait <= 0) { flush(); return; }
      const next = setTimer(() => { timer = undefined; if (!disposed) flush(); }, wait);
      next.unref?.();
      timer = next;
    },
    count,
    stats: () => ({ requests, flushed, throttled, warned, bySource: { ...bySource } }),
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimer(timer);
      timer = undefined;
    },
  };
}
