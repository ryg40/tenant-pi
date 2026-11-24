import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerMemoryChain } from "./runtime.mjs";

// Shadow only: the handler measures the chain and injects nothing.
export default function (pi: ExtensionAPI) {
  registerMemoryChain(pi);
}
