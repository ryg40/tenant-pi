import { execFile } from "node:child_process";
import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Check } from "./checks.ts";

const PACKAGE = "@agent-sh/computer-use-linux";
const SPEC = /^npm:@agent-sh\/computer-use-linux(?:@(.+))?$/;

interface ComputerUseOptions {
	dir: string;
	env: NodeJS.ProcessEnv;
	/** The kit manifest. Defaults to `config/manifest.json` of the clone that holds this package. */
	manifest?: string;
	platform?: string;
	arch?: string;
	/** Runs `<binary> doctor` with the given environment and gives its standard output. Injected so tests start no binary. */
	runDoctor?: (binary: string, env: NodeJS.ProcessEnv) => Promise<string>;
}

const readJson = (path: string): unknown => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } };
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const executable = (path: string): boolean => { try { accessSync(path, constants.X_OK); return statSync(path).isFile(); } catch { return false; } };
const kitManifest = () => fileURLToPath(new URL("../../../../config/manifest.json", import.meta.url));

/** The variables that the binary gets: the display and session variables of the runtime environment of the package extension. */
const DOCTOR_ENV = ["PATH", "HOME", "DISPLAY", "WAYLAND_DISPLAY", "XAUTHORITY", "DBUS_SESSION_BUS_ADDRESS", "XDG_RUNTIME_DIR",
	"XDG_CURRENT_DESKTOP", "XDG_SESSION_TYPE", "XDG_SESSION_DESKTOP", "XDG_DATA_DIRS", "DESKTOP_SESSION", "GDMSESSION",
	"HYPRLAND_INSTANCE_SIGNATURE", "I3SOCK", "SWAYSOCK", "YDOTOOL_SOCKET", "COMPUTER_USE_LINUX_BIN"];
const doctorEnvironment = (env: NodeJS.ProcessEnv): NodeJS.ProcessEnv =>
	Object.fromEntries(DOCTOR_ENV.flatMap(key => typeof env[key] === "string" ? [[key, env[key]]] : []));

const packageDoctor = (binary: string, env: NodeJS.ProcessEnv): Promise<string> => new Promise((resolve, reject) => {
	// A report with blockers can exit non-zero; its standard output still holds the report.
	execFile(binary, ["doctor"], { env, timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) =>
		stdout.trim() || !error ? resolve(stdout) : reject(error));
});

/** The binary that the extension of the package starts, in its own order of lookup. */
function findBinary(root: string, env: NodeJS.ProcessEnv, platform: string, arch: string): { path: string; source: string } | undefined {
	const override = env.COMPUTER_USE_LINUX_BIN?.trim();
	if (override && isAbsolute(override) && executable(override)) return { path: override, source: "COMPUTER_USE_LINUX_BIN" };
	const bundled = join(root, "npm", "bin", `computer-use-linux-${platform}-${arch}`);
	if (executable(bundled)) return { path: bundled, source: "package" };
	for (const dir of (env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
		const candidate = join(dir, "computer-use-linux");
		if (executable(candidate)) return { path: candidate, source: "PATH" };
	}
	return undefined;
}

const describe = (item: unknown): string => typeof item === "string" ? item : String(record(item).message ?? record(item).code ?? JSON.stringify(item));
const list = (items: unknown[]): string => items.slice(0, 5).map(describe).join("; ") + (items.length > 5 ? `; and ${items.length - 5} more` : "");

/**
 * Read-only checks of the computer-use module of a profile: version against the kit pin, binary, readiness.
 * The readiness comes from the `doctor` command of the package, which reads the desktop state and changes nothing.
 * These checks never run the setup tools of the package, so the desktop settings of the user stay as they are.
 */
export async function computerUseChecks(options: ComputerUseOptions): Promise<Check[]> {
	const { dir, env } = options;
	const settings = record(readJson(join(dir, "settings.json")));
	const sources = (Array.isArray(settings.packages) ? settings.packages : [])
		.map(entry => typeof entry === "string" ? entry : record(entry).source)
		.filter((source): source is string => typeof source === "string");
	const listed = sources.map(source => SPEC.exec(source.trim())).find(Boolean);
	if (!listed) return [];

	const checks: Check[] = [];
	const add = (id: string, status: Check["status"], message: string) => checks.push({ id, status, message });
	const platform = options.platform ?? process.platform;
	if (platform !== "linux") {
		add("computer-use", "warn", `The profile lists ${PACKAGE}, which supports Linux only. No computer-use module for this platform is chosen yet.`);
		return checks;
	}
	const manifestSpec = record(record(record(record(readJson(options.manifest ?? kitManifest())).components)["computer-use"]).source).spec;
	const pin = typeof manifestSpec === "string" ? manifestSpec.split("@").at(-1) : listed[1];
	const pinSource = typeof manifestSpec === "string" ? "the kit pin" : "the version of the profile line";
	const root = join(dir, "npm", "node_modules", ...PACKAGE.split("/"));
	const installed = record(readJson(join(root, "package.json"))).version;
	if (typeof installed !== "string") {
		add("computer-use-version", "fail", `The profile lists ${PACKAGE}, but ${root} has no installed package. Run the computer-use line of INSTALL.md again.`);
	} else if (!pin) {
		add("computer-use-version", "info", `${PACKAGE} ${installed} is installed; no pin to compare with was found.`);
	} else if (installed === pin) {
		add("computer-use-version", "ok", `${PACKAGE} ${installed} equals ${pinSource}.`);
	} else {
		add("computer-use-version", "warn", `${PACKAGE} ${installed} is installed, but ${pinSource} is ${pin}. See UPDATE.md for a pin move.`);
	}

	const binary = findBinary(root, env, platform, options.arch ?? process.arch);
	if (!binary) {
		add("computer-use-binary", "warn", "No computer-use-linux binary found: not in COMPUTER_USE_LINUX_BIN, not in the package, not on PATH. The desktop tools fail until one exists; see docs/guides/modules.md#computer-use.");
		return checks;
	}
	add("computer-use-binary", "ok", `computer-use-linux binary from ${binary.source}: ${binary.path}.`);

	const fallback = "Ask the agent to call computer_use_linux_doctor.";
	let output: string;
	try {
		output = await (options.runDoctor ?? packageDoctor)(binary.path, doctorEnvironment(env));
	} catch (error) {
		add("computer-use-readiness", "warn", `The doctor command of the package failed with no output: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]}. ${fallback}`);
		return checks;
	}
	let readiness: Record<string, unknown>;
	try {
		readiness = record(record(JSON.parse(output)).readiness);
	} catch {
		readiness = {};
	}
	if (!Object.keys(readiness).length) {
		add("computer-use-readiness", "warn", `The output of the doctor command of the package is not a readable readiness report. ${fallback}`);
		return checks;
	}
	const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
	const warnings = Array.isArray(readiness.warnings) ? readiness.warnings : [];
	const setup = "The kit changes no desktop setting; the package names its setup steps.";
	if (blockers.length) add("computer-use-readiness", "warn", `Desktop control is not ready: ${blockers.length} blocker(s): ${list(blockers)}.${warnings.length ? ` Warnings: ${list(warnings)}.` : ""} ${setup}`);
	else if (warnings.length) add("computer-use-readiness", "info", `Desktop control is ready, with ${warnings.length} warning(s): ${list(warnings)}.`);
	else add("computer-use-readiness", "ok", "Desktop control is ready: the doctor of the package reports no blocker.");
	return checks;
}
