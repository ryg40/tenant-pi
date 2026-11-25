import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryChain } from "./runtime.mjs";

// The handler measures the chain in shadow and injects nothing. The tool `memory_find` is on demand.
export default function (pi: ExtensionAPI) {
  registerMemoryChain(pi);
}
