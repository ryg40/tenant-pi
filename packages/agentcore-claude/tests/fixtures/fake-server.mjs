// Runs the MCP server on this process's stdio with a fake core. The tests talk
// JSON-RPC to it over standard input and standard output.
import { startServer } from "../../src/server.mjs";
import { fakeCoreModule } from "../fake-core.mjs";

const module = fakeCoreModule(process.argv[2] === "throw"
	? { throwAt: "propose", error: new Error("fake failure CANARY-server-text") }
	: {});
await startServer({ loadCore: async () => module, cwd: "/tmp" });
process.stdin.on("end", () => process.exit(0));
