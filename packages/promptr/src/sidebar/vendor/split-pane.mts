// Compatibility path for the earlier import location of this module.
// The single split implementation is ./atelier/split-pane.mts: pi-atelier v0.12.0 (MIT,
// Copyright 2026 Michael) plus the Promptr full-width dock. Do not add a second copy here;
// two copies would install duplicate renderer hooks.
export * from "./atelier/split-pane.mts";
