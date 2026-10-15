import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// Pi loads this file from the kit directory, so the core resolves beside this package.
import { createCore, loadConfig } from "../agentcore-memory-core/src/index.mjs";
import { registerAgentCore } from "./runtime.mjs";

export default function (pi: ExtensionAPI) {
  registerAgentCore(pi, { loadConfig, createCore });
}
