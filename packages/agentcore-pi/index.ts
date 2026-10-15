import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerAgentCore, readConfig } from "./runtime.mjs";

export default function (pi: ExtensionAPI) {
  try {
    const config = readConfig(process.env);
    if (config) registerAgentCore(pi, config);
  } catch {
    console.error("AgentCore Memory: invalid configuration; disabled");
  }
}
