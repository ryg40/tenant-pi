/** Register the server's tool catalogue once per pi session. */
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import type { McpBridge } from "./lib/mcp-bridge.mjs";

export const TOOL_NAME_PREFIX = "openviking_";

/**
 * The Pi-only allowlist `OPENVIKING_PI_TOOLS`: comma-separated server tool
 * names without the prefix. Unset or empty means every tool (null).
 */
export function toolAllowlist(env: Record<string, string | undefined> = process.env): Set<string> | null {
  const names = String(env.OPENVIKING_PI_TOOLS || "").split(",").map((name) => name.trim()).filter(Boolean);
  return names.length ? new Set(names) : null;
}

export interface RegisterOptions {
  env?: Record<string, string | undefined>;
  /** Called once for each allowlist name that the catalogue does not have. */
  onUnknown?: (name: string) => void;
}

export function registerMcpTools(pi: any, bridge: McpBridge, options: RegisterOptions = {}): string[] {
  const validator = new AjvJsonSchemaValidator();
  const allow = toolAllowlist(options.env);
  const catalogue = bridge.state.tools;
  if (allow) {
    const known = new Set(catalogue.map((tool) => tool.name));
    for (const name of allow) if (!known.has(name)) options.onUnknown?.(name);
  }
  const selected = allow ? catalogue.filter((tool) => allow.has(tool.name)) : catalogue;
  return selected.map((tool) => {
    const name = TOOL_NAME_PREFIX + tool.name;
    const validate = validator.getValidator(tool.inputSchema);
    pi.registerTool({
      name,
      label: "OpenViking " + tool.name,
      description: tool.description?.trim() || tool.title || "OpenViking " + tool.name,
      parameters: tool.inputSchema,
      // Validate before pi coerces values or drops optional null properties.
      prepareArguments(args: unknown) {
        const result = validate(args);
        if (!result.valid) throw new Error("Invalid arguments for " + name + ": " + result.errorMessage);
        return args;
      },
      async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
        return bridge.callTool(tool.name, params, { signal });
      },
    });
    return name;
  });
}
