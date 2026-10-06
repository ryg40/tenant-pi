// Vendored from pi-atelier v0.12.0 src/activity.ts (tag 3ff521f618cf, commit 371b847e525f).
// MIT License, Copyright (c) 2026 Michael. See packages/promptr/docs/PI-ATELIER-LICENSE.txt and
// packages/promptr/docs/atelier-adaptation.md for provenance and Promptr adaptations.
export const WORKING_PHRASES = [
	"KNEADING",
	"PERCOLATING",
	"MARINATING",
	"CARAMELIZING",
	"JULIENNING",
	"FLAMBÉING",
	"CHOREOGRAPHING",
	"MOONWALKING",
	"JITTERBUGGING",
	"SOCK-HOPPING",
	"BOOGIEING",
	"SHIMMYING",
	"EBBING",
	"UNDULATING",
	"PROPAGATING",
	"PHOTOSYNTHESIZING",
	"GERMINATING",
	"POLLINATING",
	"PONDERING",
	"RUMINATING",
	"COGITATING",
	"CEREBRATING",
	"DELIBERATING",
	"MUSING",
	"FROLICKING",
	"LOLLYGAGGING",
	"DILLY-DALLYING",
	"BOONDOGGLING",
	"SHENANIGANING",
	"RAZZLE-DAZZLING",
	"CLAUDING",
	"GITIFYING",
	"RETICULATING",
	"HYPERSPACING",
	"QUANTUMIZING",
	"COMBOBULATING",
] as const;

export function selectWorkingPhrase(randomValue: number): string {
	const bounded = Number.isFinite(randomValue) ? Math.min(1, Math.max(0, randomValue)) : 0;
	const index = Math.min(WORKING_PHRASES.length - 1, Math.floor(bounded * WORKING_PHRASES.length));
	return WORKING_PHRASES[index]!;
}
