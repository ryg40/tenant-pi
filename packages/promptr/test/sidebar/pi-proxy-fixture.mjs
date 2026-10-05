// Pi 0.87.1's stable TUI reference. InteractiveMode passes `createInteractiveTuiReference(() => this.renderer)`
// to extension factories, not the renderer: each read returns a fresh forwarding function, writes reach the current
// renderer, and it has no own-property or delete traps. It is not a package export, so load the pinned devDependency file.
import { TuiAltScreen, TuiMainScreen } from '@earendil-works/pi-tui';

const rendererModule = new URL('../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/tui-renderer.js', import.meta.url);
export const { createInteractiveTuiReference } = await import(rendererModule.href);

/** The sidebar suite runs through the real proxy when PROMPTR_TEST_PI_PROXY=1, or per harness with `proxy: true`. */
export const proxyByDefault = process.env.PROMPTR_TEST_PI_PROXY === '1';

/** Pi's fullscreen quit (`stopInteractiveTui`) runs `while (renderer.hasOverlayEntries) renderer.hideOverlay()`; bounded here. */
export function fullscreenExitLoop(renderer, limit = 100) {
  let spins = 0;
  while (renderer.hasOverlayEntries && spins < limit) { renderer.hideOverlay(); spins++; }
  return { spins, terminated: !renderer.hasOverlayEntries };
}

/** A Pi-faithful `showExtensionCustom` over a stable reference: factory now, show in a microtask, close pops the top. */
export function piCustomUi(ref, theme = {}) {
  return {
    custom(factory, options) {
      return new Promise(resolve => {
        let closed = false;
        const close = value => { if (closed) return; closed = true; if (options?.overlay) ref.hideOverlay(); resolve(value); };
        Promise.resolve(factory(ref, theme, {}, close)).then(component => {
          if (closed || !options?.overlay) return;
          const overlayOptions = typeof options.overlayOptions === 'function' ? options.overlayOptions() : options.overlayOptions;
          const handle = ref.showOverlay(component, overlayOptions);
          options.onHandle?.(handle);
        });
      });
    },
  };
}

export function renderer(fullscreen, term) {
  const tui = new (fullscreen ? TuiAltScreen : TuiMainScreen)(term);
  tui.requestRender = () => {};
  return tui;
}
