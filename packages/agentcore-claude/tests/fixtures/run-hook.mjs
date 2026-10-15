// Runs the recall hook as a process with a fake core, so a test sees its real
// standard output, standard error and file writes. Argument: `ok` or `throw`.
// In `throw` mode every error of the fake core carries the prompt text.
import { main, parseInput } from "../../src/hook.mjs";
import { fakeCoreModule } from "../fake-core.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = parseInput(Buffer.concat(chunks).toString("utf8"));
const mode = process.argv[2];
const error = new Error(`fake failure with ${input.prompt}`);
const module = mode === "throw" ? fakeCoreModule({ throwAt: "recall", error }) : fakeCoreModule();
const output = await main(input, { loadCore: async () => module });
process.stdout.write(`${JSON.stringify(output)}\n`);
