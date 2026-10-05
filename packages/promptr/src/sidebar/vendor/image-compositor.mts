// Compatibility path for the earlier import location of this module.
// The single image compositor is ./atelier/image-compositor.mts: pi-atelier v0.12.0 (MIT,
// Copyright 2026 Michael). One module keeps one compositor symbol per renderer.
export * from "./atelier/image-compositor.mts";
