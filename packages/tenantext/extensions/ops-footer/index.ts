import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContextMeter } from "../context-meter/service.ts";
import { installOpsFooter } from "./runtime.ts";

export default function opsFooter(pi: ExtensionAPI): void {
  installOpsFooter(pi, { context: createContextMeter });
}
