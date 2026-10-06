// Vendored from pi-atelier v0.12.0 src/display-path.ts (tag 3ff521f618cf, commit 371b847e525f).
// MIT License, Copyright (c) 2026 Michael. See packages/promptr/docs/PI-ATELIER-LICENSE.txt and
// packages/promptr/docs/atelier-adaptation.md for provenance and Promptr adaptations.
/** Formats a filesystem path for stable, cross-platform UI display. */
export function toDisplayPath(value: string, separator: "/" | "\\"): string {
	return separator === "/" ? value : value.replaceAll(separator, "/");
}
