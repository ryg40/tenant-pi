import type { Component } from "@earendil-works/pi-tui";

// Pi 0.87's layout-node symbol is shared across host/package module instances.
const LAYOUT_NODE = Symbol.for("@earendil-works/pi-tui/layout-node");
type Entry = { component: Component };
type Node = { type: string; entries?: Entry[] };
function nodeOf(component: Component): Node | undefined {
  const factory = (component as unknown as Record<symbol, unknown>)[LAYOUT_NODE];
  return typeof factory === "function" ? factory.call(component) as Node : undefined;
}

/** Recognize Pi's transcript + input dock without replacing either component. */
export function fullscreenDock(root: Component): { transcript: Component; dock: Component } | undefined {
  const node = nodeOf(root);
  if (node?.type !== "vstack" || node.entries?.length !== 2) return undefined;
  const [first, second] = node.entries;
  if (!first || !second || nodeOf(first.component)?.type !== "scroll" || nodeOf(second.component)?.type !== "vstack") return undefined;
  return { transcript: first.component, dock: second.component };
}

/** Regular Pi mounts document, pending, status, widgets, editor, widgets, footer. */
export function regularDock(tui: { children?: Component[] }): { transcript: Component; dock: Component[] } | undefined {
  if (tui.children?.length !== 7) return undefined;
  const [transcript, ...dock] = tui.children;
  return transcript ? { transcript, dock } : undefined;
}
