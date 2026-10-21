import { dashboardSections as v3, stackedSections as v4, type SectionLayout } from "../render.ts";

/**
 * Footer layouts by name. `v4` is the default: the rows of v3, all below the editor, model row first.
 * `v3` puts the directory row and the bar above the editor. Another name, also a removed layout, gives no layout: the session keeps its layout.
 */
export type LayoutName = "v4" | "v3";
export const layoutNames: readonly LayoutName[] = ["v4", "v3"];
export const defaultLayout: LayoutName = "v4";
export const layouts: Record<LayoutName, SectionLayout> = { v4, v3 };
/** Layouts that put rows above the editor. Only these get the `ops-footer-top` widget. */
export const hasRowsAbove = (name: LayoutName): boolean => name === "v3";
export const isLayoutName = (value: string): value is LayoutName => (layoutNames as readonly string[]).includes(value);
