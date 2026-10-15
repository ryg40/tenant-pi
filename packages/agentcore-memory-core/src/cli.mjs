// The review CLI of the shared AgentCore Memory. `main` takes injectable parts, so the tests run it with fakes.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  MemoryError, createCore, createFileLedger, defaultLedgerPath, loadConfig, personScope, renderPersonConfig,
  validateRegistry,
} from "./index.mjs";

const USAGE = `Usage: agentcore-memory [--config <file>] <command>

  resolve-project [--cwd <dir>]
  recall --query <text> [--project <id>]
  propose (--text <text> | --file <path>) [--project <id>]
  proposals list --project <id> [--actor <id>]
  proposals show --project <id> --id <recordId>
  proposals approve --project <id> --id <recordId> [--reason <text>]
  proposals reject --project <id> --id <recordId> --reason <text>
  scope --registry <file> --person <actorId>

Each write shows a preview and asks y/N on the terminal. No flag skips the question.
`;

const COMMANDS = {
  "resolve-project": ["cwd"],
  recall: ["query", "project"],
  propose: ["text", "file", "project"],
  "proposals list": ["project", "actor"],
  "proposals show": ["project", "id"],
  "proposals approve": ["project", "id", "reason"],
  "proposals reject": ["project", "id", "reason"],
  scope: ["registry", "person"],
};
const OPTIONS = Object.fromEntries(["config", "cwd", "query", "project", "text", "file", "actor", "id", "reason",
  "registry", "person"].map((name) => [name, { type: "string" }]));
OPTIONS.help = { type: "boolean", short: "h" };

class UsageError extends Error {}

/** One line from the terminal. A run without a terminal answers no: an agent cannot pipe a yes. */
async function terminalAsk(question, { stdin = process.stdin, stderr = process.stderr } = {}) {
  if (!stdin.isTTY) {
    stderr.write("agentcore-memory: a confirmation needs a terminal\n");
    return "";
  }
  const reader = createInterface({ input: stdin, output: stderr });
  try {
    return await reader.question(question);
  } finally {
    reader.close();
  }
}

function parse(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
  } catch {
    throw new UsageError();
  }
  const { values, positionals } = parsed;
  if (values.help) return { help: true };
  const name = positionals[0] === "proposals" ? `proposals ${positionals[1] ?? ""}` : positionals[0];
  const width = positionals[0] === "proposals" ? 2 : 1;
  const allowed = COMMANDS[name];
  if (!allowed || positionals.length !== width) throw new UsageError();
  for (const key of Object.keys(values)) {
    if (key !== "config" && !allowed.includes(key)) throw new UsageError();
    if (values[key] === "") throw new UsageError();
  }
  return { name, values };
}

function need(values, ...names) {
  for (const name of names) if (values[name] === undefined) throw new UsageError();
}

export async function main(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const ask = deps.ask ?? ((question) => terminalAsk(question, { stderr }));
  const readFile = deps.readFile ?? ((path) => readFileSync(path, "utf8"));
  const sessionId = deps.sessionId ?? randomUUID;
  const print = (value) => stdout.write(`${typeof value === "string" ? value : JSON.stringify(value)}\n`);

  let core;
  try {
    const { help, name, values } = parse(argv);
    if (help) { stdout.write(USAGE); return 0; }

    if (name === "scope") {
      need(values, "registry", "person");
      let registry;
      try {
        registry = validateRegistry(JSON.parse(readFile(values.registry)));
      } catch {
        throw new MemoryError("config");
      }
      // No AWS call: the scope comes from the registry alone.
      print(JSON.stringify({ scope: personScope(registry, values.person), config: renderPersonConfig(registry, values.person) },
        null, 2));
      return 0;
    }

    const configEnv = values.config === undefined ? env
      : { ...env, AGENTCORE_MEMORY_CONFIG: undefined, AGENTCORE_MEMORY_CONFIG_FILE: values.config };
    const config = loadConfig(configEnv);
    if (!config) throw new MemoryError(configEnv.AGENTCORE_MEMORY_DISABLE === "1" ? "disabled" : "config");
    core = createCore(config, {
      createClient: deps.createClient, gitRemote: deps.gitRemote, now: deps.now, hostname: deps.hostname,
      ledger: deps.ledger ?? createFileLedger(config.ledgerPath ?? defaultLedgerPath(env), { cwd }),
      log: (line) => stderr.write(`${line}\n`),
    });
    const origin = { agent: "agentcore-memory", harness: "cli", session: sessionId() };
    const confirm = async (preview) => {
      stderr.write(`${JSON.stringify(preview, null, 2)}\n`);
      const answer = await ask(`Confirm ${preview.action}? [y/N] `);
      return /^(y|yes)$/i.test(String(answer ?? "").trim());
    };
    const project = async () => {
      if (values.project !== undefined) return values.project;
      return (await core.resolveProject({ cwd, env })).projectId;
    };

    switch (name) {
      case "resolve-project":
        print(await core.resolveProject({ cwd: values.cwd ?? cwd, env }));
        break;
      case "recall": {
        need(values, "query");
        const block = core.formatContext(await core.recall({ query: values.query, projectId: await project() }));
        if (block) print(block);
        break;
      }
      case "propose": {
        if ((values.text === undefined) === (values.file === undefined)) throw new UsageError();
        let body = values.text;
        if (body === undefined) {
          try {
            body = readFile(values.file);
          } catch {
            throw new UsageError("file");
          }
        }
        print(await core.propose({ text: body, projectId: await project(), origin }, confirm));
        break;
      }
      case "proposals list":
        need(values, "project");
        for (const proposal of await core.listProposals({ projectId: values.project, actorId: values.actor })) print(proposal);
        break;
      case "proposals show": {
        need(values, "project", "id");
        const proposal = await core.showProposal({ projectId: values.project, memoryRecordId: values.id });
        if (!proposal) throw new MemoryError("proposal_missing");
        print(proposal);
        break;
      }
      case "proposals approve":
        need(values, "project", "id");
        print(await core.approve({ projectId: values.project, memoryRecordId: values.id, reason: values.reason, reviewer: origin },
          confirm));
        break;
      case "proposals reject":
        need(values, "project", "id", "reason");
        print(await core.reject({ projectId: values.project, memoryRecordId: values.id, reason: values.reason, reviewer: origin },
          confirm));
        break;
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(error.message === "file" ? "agentcore-memory: the file is unreadable\n" : USAGE);
      return 2;
    }
    // A static code only: never the text of an SDK, file system or parser error.
    stderr.write(`agentcore-memory: ${error instanceof MemoryError ? error.code : "failed"}\n`);
    return 1;
  } finally {
    await core?.close();
  }
}
