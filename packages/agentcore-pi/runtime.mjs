// The Pi side of the shared AgentCore Memory. The core (`../agentcore-memory-core`) owns the config,
// the namespaces, the AWS client, the deadlines and the record metadata. This file maps Pi events and
// one Pi tool onto the core. It builds no namespace and sends no AWS request of its own.

export const RECALL_TYPE = "agentcore-memory-recall";
export const TOOL_NAME = "agentcore_propose";

// The static diagnostics of the contract (`MemoryErrorCode` in `../agentcore-memory-core/src/types.ts`).
const CODES = new Set(["config", "disabled", "project_none", "not_member", "not_maintainer", "text_empty",
  "text_too_long", "not_confirmed", "proposal_missing", "proposal_outside_project", "ledger", "aws_denied",
  "aws_failed", "timeout"]);

// Every log line is one of these constants. None holds request data, a config value or an error text.
export const LINES = Object.freeze({
  inactive: "AgentCore Memory: no configuration or kill switch set; extension inactive",
  invalid: "AgentCore Memory: invalid configuration; extension inactive",
  project: "AgentCore Memory: AGENTCORE_PROJECT is not a project of this person; recall without a project",
  recall: "AgentCore Memory: recall failed; turn continues",
  close: "AgentCore Memory: close failed",
});

// Shutdown waits this long for `core.close()`; a pending credential load must not hold the exit.
const CLOSE_WAIT_MS = 1000;

const PARAMETERS = {
  type: "object",
  properties: {
    text: { type: "string", description: "The fact to propose, as it should read in the shared project memory." },
    projectId: { type: "string", description: "Optional. A project of this person. Without it, the project of the working directory." },
  },
  required: ["text"],
  additionalProperties: false,
};

function code(error) {
  return CODES.has(error?.code) ? error.code : "aws_failed";
}

function refusal(value) {
  return { content: [{ type: "text", text: "AgentCore Memory propose refused: " + value }], details: { code: value }, isError: true };
}

/**
 * Register the recall hook, the propose tool and the shutdown hook on the core.
 * Returns false and registers nothing when there is no config, the kill switch is set, or the config is invalid.
 */
export function registerAgentCore(pi, { loadConfig, createCore, env = process.env, cwd = () => process.cwd(),
  log = (line) => console.error(line) }) {
  let core;
  try {
    // `loadConfig` returns null for `AGENTCORE_MEMORY_DISABLE=1` and when no source has a config.
    const config = loadConfig(env);
    if (!config) {
      log(LINES.inactive);
      return false;
    }
    core = createCore(config, { log });
  } catch {
    // The core throws the code `config`; its message is not printed.
    log(LINES.invalid);
    return false;
  }
  let closed = false;
  let projectLogged = false;
  const shutdown = new AbortController();
  const resolveProject = async () => {
    const resolution = await core.resolveProject({ cwd: cwd(), env });
    if (resolution.reason && !projectLogged) {
      projectLogged = true;
      log(LINES.project);
    }
    return resolution;
  };

  pi.on("before_agent_start", async (event, ctx) => {
    if (closed || event.messageType !== "user" || typeof event.prompt !== "string" || !event.prompt.trim()) return;
    try {
      const { projectId } = await resolveProject();
      const signal = ctx?.signal ? AbortSignal.any([ctx.signal, shutdown.signal]) : shutdown.signal;
      // The core reports a failed namespace in `failed` and logs it; it does not throw for it.
      const result = await core.recall({ query: event.prompt, projectId, signal });
      const content = closed ? null : core.formatContext(result);
      if (!content) return;
      return { message: { customType: RECALL_TYPE, content, display: false } };
    } catch {
      log(LINES.recall);
    }
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "AgentCore propose",
    description: "Propose one fact for the shared AgentCore memory of a project. The person sees the target namespace and the text and confirms before the write. A maintainer of the project reviews the proposal before it becomes shared. Use it only when the person asks to propose or save a fact to the project memory.",
    promptSnippet: "Propose one fact to the shared project memory; the person confirms each proposal",
    parameters: PARAMETERS,
    // One confirmation dialog at a time.
    executionMode: "sequential",
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (closed) return refusal("disabled");
      try {
        let projectId = params?.projectId ?? null;
        if (projectId === null) {
          ({ projectId } = await resolveProject());
          if (!projectId) return refusal("project_none");
        }
        const origin = { agent: "pi", harness: "pi", session: ctx.sessionManager.getSessionId() };
        // The core calls this gate with the preview and writes only when it returns true.
        const confirm = async (preview) => preview?.action === "propose"
          && (await ctx.ui.confirm(preview.namespace, preview.text)) === true;
        const result = await core.propose({ text: params?.text, projectId, origin }, confirm);
        return {
          content: [{ type: "text", text: JSON.stringify({ memoryRecordId: result.memoryRecordId, namespace: result.namespace }) }],
          details: { memoryRecordId: result.memoryRecordId, namespace: result.namespace },
        };
      } catch (error) {
        return refusal(code(error));
      }
    },
  });

  pi.on("session_shutdown", async () => {
    if (closed) return;
    closed = true;
    shutdown.abort();
    let timer;
    try {
      await Promise.race([core.close(), new Promise((resolve) => { timer = setTimeout(resolve, CLOSE_WAIT_MS); })]);
    } catch {
      log(LINES.close);
    } finally {
      clearTimeout(timer);
    }
  });
  return true;
}
