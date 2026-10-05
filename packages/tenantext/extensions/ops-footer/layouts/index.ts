import { belowOnly, dashboardSections as v3, stackedSections as v4, type SectionLayout } from "../render.ts";
import { dashboardRows as a } from "./a.ts";
import { dashboardRows as b } from "./b.ts";
import { dashboardRows as c } from "./c.ts";
import { dashboardRows as v2 } from "./v2.ts";

/**
 * Footer layouts by name. `v4` is the default: the rows of v3, all below the editor, model row first.
 * `v3` is the only one with rows above the editor; `v2` is the bar-first composition; `a`, `b`, and `c` are prototype layouts, all below the editor.
 */
export type LayoutName = "v4" | "v3" | "v2" | "a" | "b" | "c";
export const layoutNames: readonly LayoutName[] = ["v4", "v3", "v2", "a", "b", "c"];
export const defaultLayout: LayoutName = "v4";
export const layouts: Record<LayoutName, SectionLayout> = { v4, v3, v2: belowOnly(v2), a: belowOnly(a), b: belowOnly(b), c: belowOnly(c) };
/** Layouts that put rows above the editor. Only these get the `ops-footer-top` widget. */
export const hasRowsAbove = (name: LayoutName): boolean => name === "v3";
export const isLayoutName = (value: string): value is LayoutName => (layoutNames as readonly string[]).includes(value);
