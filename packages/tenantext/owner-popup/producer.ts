import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	unlinkSync,
} from "node:fs";
import type http from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { A2UI_VERSION } from "../../walkr/src/a2ui.js";
import { WS_LIMITS } from "../../walkr/src/compare-socket.js";
import { dummiesOn, roleOfName, statePath as dummiesStatePath } from "../extensions/next-prompt/dummies.ts";
import {
	addressFromSurfaceId,
	BUTTON_ACTIONS,
	effectiveAnswer,
	formatSendLine,
	DRAFT_KEY_PREFIX,
	DRAFT_KEY_RE,
	draftKey,
	isRowAnswered,
	isRowConfirmed,
	isRowPendingConfirm,
	needsConfirm,
	renderedButtonSpecs,
	sendableRows,
	singleLineText,
	surfaceIdFor,
	toCreateSurfaceMessages,
	toDeleteSurfaceMessages,
	toReplaceSurfaceMessages,
	toUpdateSurfaceMessages,
	type CoordinatorGroup,
	type RowViewState,
	type SurfaceState,
} from "./a2ui.ts";
import {
	applyDeciderScore,
	checkDeciderHealth,
	resolveThresholds,
	scoreRowWithDecider,
	type DeciderConfig,
} from "./decider.ts";
import {
	appendReceiptSuffix,
	defaultStateDir,
	endReceipt,
	isValidReceiptAddress,
	RECEIPT_MAX_AGE_MS,
	receiptIsGone,
	removeReceipt,
	removeReceiptsForAddress,
	sha256Hex,
	sweepExpiredReceipts,
	writeReceipt,
	type CreatedReceipt,
} from "./receipt.ts";
import { extractOwnerRows, FIXED_DECISION_OPTIONS, isRiskyByWords, makeOptions, type OwnerRow } from "./rows.ts";
import { runWriter, type WriterConfig } from "./suggest.ts";
import { createLocalWsServer, type LocalWsClient, type LocalWsServer } from "./ws.ts";

/**
 * Local A2UI producer for the owner-task rail.
 * Listens on 127.0.0.1 (default port 18766, path /a2ui), owns surface state and the drafts of the fields,
 * fills split/decider/writer updates in series, validates every client action completely
 * against rendered buttons and report revisions before mutating state, and delivers one
 * `[Owner popup]` line per coordinator via `hc get` + `hc send` with a single-use receipt.
 * A coordinator can send only between its Stop event and its next turn-start event: then it sits at its prompt,
 * so a press sends at once, whatever status `hc get` reports. A delivered send or a turn-start locks the surface:
 * the rows that were not sent stay, Send is refused, and the next Stop report replaces the rows.
 */

export const DEFAULT_PRODUCER_PORT = 18766;
export const DEFAULT_PRODUCER_PATH = "/a2ui";
export const DEFAULT_IDLE_SHUTDOWN_MS = 10 * 60 * 1000;
const STOP_EVENT_MAX_AGE_MS = 10 * 60 * 1000;
/** Metadata-only event log in the state folder; started new at producer start when larger than this. */
const EVENT_LOG_NAME = "producer-events.jsonl";
const EVENT_LOG_MAX_BYTES = 1024 * 1024;
const CUSTOM_TEXT_MAX = 1000;
/**
 * The limit of one `hc send`. herdr-core holds a send while a person's draft sits unsent in the terminal, up to
 * 60 seconds after the last key (`draft_wait`), and for a quiet pause of a few seconds after a key. The limit is
 * above that hold, so a normal hold does not end as an unknown result. A press of Send skips the hold on a core whose
 * `terminal.send` has the `no_draft_wait` parameter (`hc send --no-draft-wait`): text left in the prompt is then
 * submitted together with the answer. An older core keeps the hold.
 */
export const HC_SEND_TIMEOUT_MS = 75_000;
/** The limit of one `hc get` or `hc schema`. */
const HC_QUERY_TIMEOUT_MS = 10_000;
/** A read of a kept `hc schema` answer older than this starts a background refresh: a core restart can change it. */
const HC_SCHEMA_MAX_AGE_MS = 60_000;
/** After a good send with no turn-start of the address (a session without the hook), the pending form ends then. */
export const RECEIPT_PENDING_FALLBACK_MS = 20_000;
// Event file name forms (shared between owner-popup-hook.mjs and producer.ts):
// - Stop event: `stop-<16-digit ms>-<8 lowercase hex>.json`
// - Turn-start event: `turn-start-<address>.json` (address uses only `[A-Za-z0-9._-]`, never starts with `-`, not `.` or `..`)
// - Taken event (reader-owned, never written by the hook): `reading-<pid>-<12 lowercase hex>.json`
const FINISHED_EVENT_RE = /^(?:stop-[0-9]{16}-[0-9a-f]{8}|turn-start-(?!\.{1,2}\.json$)[A-Za-z0-9._][A-Za-z0-9._-]*)\.json$/;
const TAKEN_EVENT_RE = /^reading-[0-9]+-[0-9a-f]{12}\.json$/;
const ALLOWED_ACTION_KEYS = new Set(["name", "surfaceId", "sourceComponentId", "timestamp", "context", "userMessage"]);
/** The fixed context keys; a Button context also binds one `other_<label>` key for each "Other answer" field drawn. */
const ALLOWED_CONTEXT_KEYS = new Set([
	"targetCoordinator",
	"targetLabel",
	"targetRevision",
	"optionId",
	"answerVersion",
]);
const TARGET_LITERAL_KEYS = ["targetCoordinator", "targetLabel", "targetRevision", "optionId", "answerVersion"] as const;
/** How many replaced revisions of one address a press can still name to get the current view again. */
const PAST_REVISIONS_KEPT = 8;
const STALE_VIEW_TEXT = "The view changed. Check the rows and press again.";

const HC_ENV_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"TZ",
	"TMPDIR",
	"TEMP",
	"TMP",
	"XDG_CONFIG_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
	"XDG_DATA_HOME",
	"XDG_RUNTIME_DIR",
	"HC_SOCKET",
	"HC_SCOPE",
	"HC_RUNTIME_DIR",
	"HC_DRAFT_MS",
] as const;

export interface TerminalRecord {
	address: string;
	name?: string;
	state?: string;
	agentStatus?: string;
	role?: string;
}

export interface HcSendResult {
	ok: boolean;
	code: number;
	detail: string;
	unknown?: boolean;
	/** The producer aborted the send (a new report of the address came): the line counts as not sent. */
	aborted?: boolean;
	/** The `hc` client refused `--no-draft-wait` (exit 2, usage error), and this result is of the plain send after it. */
	plainAfterUsage?: boolean;
	/** The `hc` client refused `--no-draft-wait`, and the check before the plain send failed: nothing was sent. */
	withheld?: boolean;
}

/** The check before the plain send after a usage refusal: `drain` can wait, `canGo` decides with no wait. */
export interface PlainSendCheck {
	drain(): Promise<void>;
	canGo(): boolean;
}

export interface HcClient {
	get(address: string): Promise<TerminalRecord | null>;
	/**
	 * An abort of `signal` ends the client process; a client that ends during the draft hold types nothing.
	 * With `noDraftWait`, the send adds `--no-draft-wait`; a usage refusal of the flag sends one time again without it.
	 * Both attempts share one limit of `HC_SEND_TIMEOUT_MS`. Before that plain send, `beforePlain.drain` runs and then
	 * `beforePlain.canGo`, with no wait between `canGo` and the start of the child: when `canGo` gives false (or one of
	 * them throws), the plain send does not start, and the result has `withheld`.
	 */
	send(
		address: string,
		text: string,
		signal?: AbortSignal,
		noDraftWait?: boolean,
		beforePlain?: PlainSendCheck,
	): Promise<HcSendResult>;
	/**
	 * The kept answer: true when the running core has `hc send --no-draft-wait`. It never waits: with no answer yet it
	 * is false. When no answer exists or the kept answer is older than about 60 seconds, it starts a background refresh
	 * and still gives the kept answer at once. A failed check is false.
	 */
	noDraftWait?(): boolean;
	/** Start a background `hc schema` check (or join the one in flight). It never rejects. */
	refreshNoDraftWait?(): Promise<boolean>;
	/**
	 * True only when herdr-core says that the terminal does not exist (`hc get` gives an error of the kind
	 * `not_found`). A failed or slow `hc get`, or any other answer, is false. It never rejects.
	 */
	gone?(address: string): Promise<boolean>;
}

export interface ProducerOptions {
	port?: number;
	path?: string;
	printOnly?: boolean;
	demoMode?: boolean;
	onPrint?: (line: string) => void;
	eventsDir?: string;
	stateDir?: string;
	pickLogPath?: string;
	dummiesFile?: string;
	hcBin?: string;
	hc?: HcClient;
	decider?: DeciderConfig | false;
	writer?: WriterConfig | false;
	idleShutdownMs?: number;
	eventPollMs?: number;
	maxPendingActionsPerClient?: number;
	clientIdleTimeoutMs?: number;
	pingIntervalMs?: number;
	peerAddress?: (req: http.IncomingMessage) => string;
	onIdleShutdown?: () => void;
}

interface DeliveryOutcome {
	handled: boolean;
	reason?: string;
}

/**
 * A send whose `hc send` gave no result: a later press whose checked rows give the same line sends this line again
 * with its receipt.
 */
interface UnknownSend {
	/** Generation of the address at the first try; a new report or a Close bumps it, and a turn-start ends the retry. */
	gen: number;
	/** The line of the first try without its receipt suffix, and with it. */
	baseLine: string;
	wireLine: string;
	/** The labels of the rows in that line. */
	labels: readonly string[];
	/** The receipt file of the first try and its creation time. */
	receiptPath: string;
	receiptCreatedAtMs: number;
}

/**
 * A retry can reuse the line of an unknown send only while its receipt can still verify when the line arrives:
 * the age of the receipt plus the limit of one `hc send` stays below the receipt lifetime.
 */
function canReuseUnknownSend(unknown: UnknownSend, nowMs = Date.now()): boolean {
	return nowMs - unknown.receiptCreatedAtMs + HC_SEND_TIMEOUT_MS < RECEIPT_MAX_AGE_MS;
}

export interface StopEventInput {
	address: string;
	name?: string;
	reportText: string;
	skipRoleCheck?: boolean;
	eventTimeMs?: number;
}

export interface ProducerHandle {
	readonly port: number;
	readonly ws: LocalWsServer;
	getState(): SurfaceState;
	addReport(input: StopEventInput): Promise<{ accepted: boolean; reason?: string }>;
	handleTurnStart(address: string, eventTimeMs?: number): void;
	handleRawAction(rawText: string): Promise<{ handled: boolean; reason?: string }>;
	pollEventsNow(): Promise<void>;
	waitForPendingWork(): Promise<void>;
	close(): Promise<void>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Build a minimal child environment for `hc`: keeps runtime/XDG paths and herdr-core routing vars,
 * never passes `HC_TERMINAL_ID`, `HC_TERMINAL_SOCKET`, model keys, or unrelated session variables.
 */
export function buildHcEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const key of HC_ENV_KEYS) {
		if (source[key] !== undefined) out[key] = source[key];
	}
	return out;
}

/**
 * The role of a terminal from its `hc get` labels and name: the label `skill.role`, else the role of a
 * `-<role>-<n>` name, else `coordinator` when the label `where` ends in " / coordinator" or " / 1"
 * (the first tab of a Herdr app space holds the coordinator), else undefined.
 */
export function roleOfTerminal(labels: Record<string, unknown>, name: string | undefined): string | undefined {
	if (typeof labels["skill.role"] === "string") return labels["skill.role"];
	const fromName = roleOfName(name);
	if (fromName) return fromName;
	const where = labels.where;
	if (typeof where !== "string") return undefined;
	const cut = where.lastIndexOf(" / ");
	if (cut < 0) return undefined;
	const tab = where.slice(cut + 3);
	return tab === "coordinator" || tab === "1" ? "coordinator" : undefined;
}

/**
 * True when the JSON of `hc schema` has the method `terminal.send` with the parameter `no_draft_wait`.
 * Text that is not that JSON gives false.
 */
export function schemaHasNoDraftWait(schemaJson: string): boolean {
	try {
		const data = JSON.parse(schemaJson) as unknown;
		if (!isPlainObject(data) || !Array.isArray(data.methods)) return false;
		const method = data.methods.find((m) => isPlainObject(m) && m.name === "terminal.send");
		if (!isPlainObject(method) || !Array.isArray(method.params)) return false;
		return method.params.some((param) => isPlainObject(param) && param.name === "no_draft_wait");
	} catch {
		return false;
	}
}

/** True when a failed `hc` run printed a JSON error of the kind `usage` (an old client refused a flag). */
function isUsageError(stderr: string): boolean {
	try {
		const data = JSON.parse(stderr.trim()) as unknown;
		return isPlainObject(data) && isPlainObject(data.error) && data.error.kind === "usage";
	} catch {
		return false;
	}
}

/**
 * Run `hc get <address> --json`, `hc schema` and `hc send` (never `--force` or `--if`, minimal child environment).
 */
export function createHcClient(hcBin = "hc", env: NodeJS.ProcessEnv = process.env): HcClient {
	let schemaAnswer: { value: boolean; atMs: number } | undefined;
	let schemaCheck: Promise<boolean> | undefined;
	/** Counts the usage refusals of the flag: a schema check that started before a refusal must not undo it. */
	let usageRefusals = 0;
	const refreshNoDraftWait = (): Promise<boolean> => {
		if (schemaCheck) return schemaCheck;
		const refusalsAtStart = usageRefusals;
		const check = new Promise<boolean>((resolveDone) => {
			const settle = (found: boolean): void => {
				// The client refused the flag while this check ran: the refusal stands until a later check.
				const value = found && usageRefusals === refusalsAtStart;
				// A monotonic clock: a step of the wall clock must not change the age of the answer.
				schemaAnswer = { value, atMs: performance.now() };
				resolveDone(value);
			};
			try {
				const childEnv = buildHcEnv(env);
				execFile(hcBin, ["schema"], { timeout: HC_QUERY_TIMEOUT_MS, env: childEnv, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
					settle(!error && schemaHasNoDraftWait(stdout));
				});
			} catch {
				// A synchronous launch failure counts as a failed check.
				settle(false);
			}
		});
		schemaCheck = check;
		// Clear the in-flight slot when the check ends, so a later refresh runs again.
		void check.finally(() => {
			if (schemaCheck === check) schemaCheck = undefined;
		});
		return check;
	};
	const runSend = (
		args: string[],
		signal: AbortSignal | undefined,
		timeoutMs: number,
	): Promise<HcSendResult & { stderr: string }> => {
		// Start no child for a send that is already aborted.
		if (signal?.aborted) return Promise.resolve({ ok: false, code: 1, aborted: true, detail: "aborted", stderr: "" });
		const childEnv = buildHcEnv(env);
		return new Promise((resolveDone) => {
			execFile(hcBin, args, { timeout: timeoutMs, env: childEnv, signal }, (error, stdout, stderr) => {
				if (!error) {
					resolveDone({ ok: true, code: 0, detail: stdout.trim(), stderr });
					return;
				}
				if (signal?.aborted) {
					resolveDone({ ok: false, code: 1, aborted: true, detail: "aborted", stderr });
					return;
				}
				const execErr = error as NodeJS.ErrnoException & {
					code?: number | string | null;
					killed?: boolean;
					signal?: string | null;
				};
				const hasExitCode = typeof execErr.code === "number" && execErr.code !== 0;
				const unknown = Boolean(execErr.killed || execErr.signal || !hasExitCode);
				const code = hasExitCode ? Number(execErr.code) : 1;
				resolveDone({
					ok: false,
					code,
					unknown,
					detail: (stderr || stdout || error.message).trim().slice(0, 200),
					stderr,
				});
			});
		});
	};
	return {
		noDraftWait(): boolean {
			if (!schemaAnswer || performance.now() - schemaAnswer.atMs >= HC_SCHEMA_MAX_AGE_MS) void refreshNoDraftWait();
			return schemaAnswer?.value ?? false;
		},
		refreshNoDraftWait,
		gone(address: string): Promise<boolean> {
			if (!isValidReceiptAddress(address)) return Promise.resolve(false);
			const childEnv = buildHcEnv(env);
			return new Promise((resolveDone) => {
				try {
					execFile(hcBin, ["get", address, "--json"], { timeout: HC_QUERY_TIMEOUT_MS, env: childEnv }, (error, stdout, stderr) => {
						const execErr = error as (NodeJS.ErrnoException & { killed?: boolean; signal?: string | null }) | null;
						// Success, a timeout or a kill says nothing about a closed terminal.
						if (!execErr || execErr.killed || execErr.signal) {
							resolveDone(false);
							return;
						}
						const kindOf = (text: string): unknown => {
							try {
								const data = JSON.parse(text.trim()) as unknown;
								return isPlainObject(data) && isPlainObject(data.error) ? data.error.kind : undefined;
							} catch {
								return undefined;
							}
						};
						resolveDone(kindOf(stderr) === "not_found" || kindOf(stdout) === "not_found");
					});
				} catch {
					resolveDone(false);
				}
			});
		},
		get(address: string): Promise<TerminalRecord | null> {
			if (!isValidReceiptAddress(address)) return Promise.resolve(null);
			const childEnv = buildHcEnv(env);
			return new Promise((resolveDone) => {
				execFile(hcBin, ["get", address, "--json"], { timeout: HC_QUERY_TIMEOUT_MS, env: childEnv }, (error, stdout) => {
					if (error) {
						resolveDone(null);
						return;
					}
					try {
						const data = JSON.parse(stdout) as Record<string, unknown>;
						if (!isPlainObject(data) || data.error) {
							resolveDone(null);
							return;
						}
						const labels = isPlainObject(data.labels) ? data.labels : {};
						const statusObj = isPlainObject(data.status) ? data.status : undefined;
						const agentStatus =
							typeof statusObj?.state === "string"
								? statusObj.state
								: typeof data.status === "string"
									? data.status
									: undefined;
						const name = typeof data.name === "string" ? data.name : undefined;
						const role = roleOfTerminal(labels, name);
						resolveDone({
							address: typeof data.address === "string" ? data.address : address,
							name,
							state: typeof data.state === "string" ? data.state : undefined,
							agentStatus,
							role,
						});
					} catch {
						resolveDone(null);
					}
				});
			});
		},
		async send(
			address: string,
			text: string,
			signal?: AbortSignal,
			noDraftWait = false,
			beforePlain?: PlainSendCheck,
		): Promise<HcSendResult> {
			if (!isValidReceiptAddress(address)) return { ok: false, code: 2, detail: "invalid address" };
			if (signal?.aborted) return { ok: false, code: 1, aborted: true, detail: "aborted" };
			// No `--if`: a coordinator at its prompt reports `idle`, `done`, or `working` while it holds background
			// waits, and `--if idle` refuses `done` and `working`. The hook events decide that it sits at its prompt.
			// `--no-draft-wait` is not `--force`: herdr-core still refuses a blocked terminal.
			const plainArgs = ["send", address, text];
			// One limit for the press: the plain attempt after a usage refusal gets only the time that is left.
			// A monotonic clock: a backward step of the wall clock must not give the plain attempt more time.
			const deadlineMs = performance.now() + HC_SEND_TIMEOUT_MS;
			if (noDraftWait) {
				const { stderr, ...first } = await runSend([...plainArgs, "--no-draft-wait"], signal, HC_SEND_TIMEOUT_MS);
				// An old client refuses the flag before it sends anything: send one time again without it.
				if (first.ok || first.unknown || first.aborted || first.code !== 2 || !isUsageError(stderr)) return first;
				// This client does not know the flag: the answer is "no option" until the next schema refresh.
				usageRefusals += 1;
				if (schemaAnswer) schemaAnswer = { value: false, atMs: schemaAnswer.atMs };
				// The flagged child ran for a while: the producer checks again that the plain line can still go out.
				const withheld: HcSendResult = { ok: false, code: first.code, withheld: true, detail: "plain send withheld" };
				try {
					await beforePlain?.drain();
				} catch {
					return withheld;
				}
				const leftMs = Math.min(HC_SEND_TIMEOUT_MS, Math.floor(deadlineMs - performance.now()));
				// No time left: the refusal stands, and nothing was sent.
				if (leftMs <= 0) return first;
				// No wait between this check and the start of the child: a decider answer cannot come between them.
				try {
					if (beforePlain && !beforePlain.canGo()) return withheld;
				} catch {
					return withheld;
				}
				const { stderr: _plainStderr, ...plain } = await runSend(plainArgs, signal, leftMs);
				return { ...plain, plainAfterUsage: true };
			}
			const { stderr: _stderr, ...result } = await runSend(plainArgs, signal, HC_SEND_TIMEOUT_MS);
			return result;
		},
	};
}

/**
 * Write one privacy-safe JSON line to the pick log (mode 0600, no report or answer text): for a send the sent rows,
 * for a Close all rows.
 */
function recordPickLog(pickLogPath: string | undefined, rows: readonly RowViewState[]): void {
	if (!pickLogPath) return;
	const entry = {
		at: new Date().toISOString(),
		count: rows.length,
		rows: rows.map((item) => {
			const confirmed = item.checked && isRowConfirmed(item);
			const ans = confirmed ? effectiveAnswer(item) : null;
			return {
				kind: item.row.kind,
				decider: item.row.deciderApplied ? "decider" : "no decider",
				picked: ans ? ans.picked : "none",
			};
		}),
	};
	try {
		mkdirSync(dirname(pickLogPath), { recursive: true, mode: 0o700 });
		appendFileSync(pickLogPath, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
		chmodSync(pickLogPath, 0o600);
	} catch {
		// Never break answering if log write fails.
	}
}

export async function createProducer(options: ProducerOptions = {}): Promise<ProducerHandle> {
	const hc = options.hc ?? createHcClient(options.hcBin ?? "hc");
	const printOnly = options.printOnly ?? false;
	const demoMode = options.demoMode ?? false;
	// Learn in the background whether the running core can skip the draft hold on a send (`hc schema`): at start and
	// when a report arrives. A press reads the kept answer and never waits for this check.
	const refreshNoDraftWait = (): void => {
		if (printOnly) return;
		try {
			void Promise.resolve(hc.refreshNoDraftWait?.()).catch(() => false);
		} catch {
			// An injected client that throws counts as no option.
		}
	};
	/** The kept answer, with no wait. A throw from an injected client gives false. */
	const readNoDraftWait = (): boolean => {
		try {
			return hc.noDraftWait?.() === true;
		} catch {
			return false;
		}
	};
	refreshNoDraftWait();
	const onPrint = options.onPrint ?? ((line: string) => process.stdout.write(`${line}\n`));
	const pickLogPath = options.pickLogPath;
	const dummiesFile = options.dummiesFile ?? dummiesStatePath();
	const idleShutdownMs = options.idleShutdownMs ?? DEFAULT_IDLE_SHUTDOWN_MS;
	const eventPollMs = options.eventPollMs ?? 150;
	const maxPendingActionsPerClient = options.maxPendingActionsPerClient ?? WS_LIMITS.maxPendingActions;
	const receiptStateDir = options.stateDir ?? (options.eventsDir ? dirname(options.eventsDir) : defaultStateDir());
	// Event log: time, event, address, 12 hex characters of a report digest, result. Never a text or a receipt id.
	const eventLogPath = options.stateDir || options.eventsDir ? join(receiptStateDir, EVENT_LOG_NAME) : undefined;
	if (eventLogPath) {
		try {
			if (lstatSync(eventLogPath).size > EVENT_LOG_MAX_BYTES) renameSync(eventLogPath, `${eventLogPath}.1`);
		} catch {
			// No log yet, or no rotation: the log never stops the producer.
		}
	}
	const logEvent = (event: string, address: string, digest?: string, result?: string): void => {
		if (!eventLogPath) return;
		try {
			const entry = { at: new Date().toISOString(), event, address, ...(digest ? { digest: digest.slice(0, 12) } : {}), ...(result ? { result } : {}) };
			appendFileSync(eventLogPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
		} catch {
			// A failure to write the log never stops the producer.
		}
	};

	const state: SurfaceState = {
		coordinators: [],
	};

	const generations = new Map<string, number>();
	const lastEventTimes = new Map<string, number>();
	/** Addresses whose final send step runs: from the last check before the receipt to the end of `hc send`. */
	const inFlightSend = new Set<string>();
	/** For each address, the labels of the rows in the line of the `hc send` in flight. */
	const sendingLabels = new Map<string, readonly string[]>();
	/** For each address, the send whose `hc send` gave no result; memory only, one per address. */
	const unknownSends = new Map<string, UnknownSend>();
	/**
	 * For each address, the labels of the rows in the line of each unknown send: the line can have reached the
	 * coordinator. Apart from the retry record, a turn-start does not end it; the next report reads it and ends it, and
	 * a Close, a delivered send of the address (see `endMaybeSent`) or the end of its group ends it too.
	 */
	const maybeSentLabels = new Map<string, Set<string>>();
	/**
	 * For each address, the labels of the rows of an unknown first line whose old receipt was already gone at a later
	 * press (`firstLineUnknown`): the rows stay unchecked, and their answer can have arrived. Their possibly-sent mark
	 * stays also after a delivered send of other rows; a delivered send of the row itself, the next report, a Close or
	 * the end of the group ends it.
	 */
	const unresolvedLabels = new Map<string, Set<string>>();
	/**
	 * End the possibly-sent marks of an address after a line arrived, except the marks of unresolved rows that were
	 * not in that line.
	 */
	const endMaybeSent = (address: string, arrivedLabels: readonly string[]): void => {
		maybeSentLabels.delete(address);
		const held = unresolvedLabels.get(address);
		if (!held) return;
		for (const label of arrivedLabels) held.delete(label);
		if (held.size === 0) unresolvedLabels.delete(address);
		else maybeSentLabels.set(address, new Set(held));
	};
	/** For each address, the abort handle of the `hc send` in flight; a new Stop report of the address aborts it. */
	const sendAborts = new Map<string, AbortController>();
	/** For each known coordinator address, the count of client actions that named it, raised at arrival. */
	const actionArrivals = new Map<string, number>();
	/**
	 * Pending forms that stay on the clients after a good send of the last rows left the state, with their fallback
	 * timer: until the turn-start of the address, or the fallback time.
	 */
	const heldForms = new Map<string, NodeJS.Timeout | null>();
	/** For each locked surface with rows left after a delivered send, the fallback timer of its "Receipt pending" line. */
	const sentNoteTimers = new Map<string, NodeJS.Timeout>();
	const pendingJobs = new Set<Promise<unknown>>();
	const pendingActionsByClient = new Map<number, number>();
	let nextRevision = 0;
	/** The source of each new `answerVersion`: one number for all rows, so a version never comes back. */
	let nextAnswerVersion = 0;
	/**
	 * The replaced revisions of each address, the newest last: a press of one gets the current view again. The list
	 * lives only across successful replacements of an active surface: each removal of the cards ends it.
	 */
	const pastRevisions = new Map<string, string[]>();
	let lastActivityAt = Date.now();
	let actionQueue: Promise<unknown> = Promise.resolve();
	let pollChain: Promise<void> = Promise.resolve();
	let closed = false;
	let pollTimer: NodeJS.Timeout | null = null;
	let idleTimer: NodeJS.Timeout | null = null;

	const trackJob = <T>(job: Promise<T>): Promise<T> => {
		pendingJobs.add(job);
		job.finally(() => pendingJobs.delete(job));
		return job;
	};

	const bumpGeneration = (address: string): number => {
		const next = (generations.get(address) ?? 0) + 1;
		generations.set(address, next);
		return next;
	};

	const isCurrentGen = (address: string, gen: number): boolean => !closed && generations.get(address) === gen;

	const findGroup = (address: string): CoordinatorGroup | null =>
		state.coordinators.find((c) => c.address === address) ?? null;

	const withdrawnText = (address: string): string =>
		`Answers for ${address} not sent: an action on its surface came after the send request. The rows stay; check them and press Send again.`;
	const reuseMinutes = Math.floor((RECEIPT_MAX_AGE_MS - HC_SEND_TIMEOUT_MS) / 60_000);
	const unknownText = (address: string): string =>
		`Send status unknown for ${address}: hc send gave no result in ${HC_SEND_TIMEOUT_MS / 1000} seconds. The answer can still arrive; check the terminal. The rows stay. For ${reuseMinutes} minutes, a press of Send with the same checked answers sends the same line with the same receipt, so ${address} accepts it only one time. When the checked answers differ, or after that time, the press ends the old receipt and sends the checked answers with a new receipt.`;
	/** A refusal text; after an unknown send of the same cards, the unknown text stays in front of it. */
	const withUnknownNote = (address: string, gen: number, text: string): string =>
		unknownSends.get(address)?.gen === gen ? `${unknownText(address)} ${text}` : text;

	const touch = () => {
		lastActivityAt = Date.now();
	};

	const broadcastSurfaceCreate = (group: CoordinatorGroup) => {
		const sid = surfaceIdFor(group.address);
		const createMsgs = toCreateSurfaceMessages(group);
		const replaceMsgs = toReplaceSurfaceMessages(group);
		for (const client of ws.clients()) {
			if (client.live.has(sid)) {
				client.sendMessages(replaceMsgs);
			} else {
				client.sendMessages(createMsgs);
			}
		}
	};

	const broadcastSurfaceUpdate = (group: CoordinatorGroup) => {
		const sid = surfaceIdFor(group.address);
		const updateMsgs = toUpdateSurfaceMessages(group);
		const createMsgs = toCreateSurfaceMessages(group);
		const replaceMsgs = toReplaceSurfaceMessages(group);
		for (const client of ws.clients()) {
			if (client.live.has(sid)) {
				if (!client.sendMessages(updateMsgs)) {
					client.sendMessages(replaceMsgs);
				}
			} else {
				client.sendMessages(createMsgs);
			}
		}
	};

	const broadcastSurfaceDelete = (address: string) => {
		const sid = surfaceIdFor(address);
		const deleteMsgs = toDeleteSurfaceMessages(sid);
		for (const client of ws.clients()) {
			if (client.live.has(sid)) {
				client.sendMessages(deleteMsgs);
			}
		}
	};

	/** End the held pending form of an address: stop its fallback timer and, with `broadcast`, delete its surface. */
	const dropHeldForm = (address: string, broadcast: boolean): boolean => {
		if (!heldForms.has(address)) return false;
		const timer = heldForms.get(address);
		if (timer) clearTimeout(timer);
		heldForms.delete(address);
		if (broadcast) broadcastSurfaceDelete(address);
		return true;
	};

	/** Bring the cards back in place of the pending form, with one status line; the picks stay as they are. */
	const showCards = (group: CoordinatorGroup, text: string) => {
		group.receiptPending = false;
		group.statusMessage = text;
		broadcastSurfaceCreate(group);
	};

	/** End the "Receipt pending" line of a locked surface; with `broadcast`, draw the surface again. */
	const dropSentNote = (address: string, broadcast: boolean): void => {
		const timer = sentNoteTimers.get(address);
		if (timer) clearTimeout(timer);
		sentNoteTimers.delete(address);
		const group = findGroup(address);
		if (!group?.sentPending) return;
		group.sentPending = undefined;
		if (broadcast) broadcastSurfaceUpdate(group);
	};

	const clearAddressCards = (address: string): number => {
		const gen = bumpGeneration(address);
		unknownSends.delete(address);
		pastRevisions.delete(address);
		dropSentNote(address, false);
		const before = state.coordinators.length;
		state.coordinators = state.coordinators.filter((c) => c.address !== address);
		const held = dropHeldForm(address, false);
		if (state.coordinators.length !== before || held) {
			broadcastSurfaceDelete(address);
		}
		return gen;
	};

	/**
	 * True for a press of a Button of a replaced view: it names an action of a Button, the coordinator of an active
	 * surface, and a revision that this surface had before (not the current one).
	 */
	const isStaleViewPress = (address: string, actionName: unknown, context: Record<string, unknown>): boolean => {
		const group = findGroup(address);
		const pressed = context.targetRevision;
		return (
			Boolean(group && group.rows.length > 0) &&
			typeof actionName === "string" &&
			BUTTON_ACTIONS.has(actionName) &&
			context.targetCoordinator === address &&
			typeof pressed === "string" &&
			pressed !== group?.revision &&
			(pastRevisions.get(address) ?? []).includes(pressed)
		);
	};

	const sendFullToClient = (client: LocalWsClient) => {
		for (const group of state.coordinators) {
			if (group.rows.length === 0) continue;
			client.sendMessages(toCreateSurfaceMessages(group));
		}
	};

	/**
	 * Count one client action at its arrival, before it waits in the action queue: raise the arrival count of
	 * each known coordinator that it names (`targetCoordinator` or its `surfaceId`),
	 * valid or refused. A Close names its coordinator, so it withdraws only the press of that coordinator.
	 * When the `surfaceId` names a known coordinator, only that address counts, so a frame with a mismatched
	 * context cannot withdraw the press of another coordinator.
	 * An action that names no coordinator raises the count of every known coordinator: each address in
	 * `state.coordinators` and in the arrival counts. Returns the counts after the raise,
	 * so that a press can store the count of its own arrival.
	 */
	const countArrival = (rawText: string): ReadonlyMap<string, number> => {
		const named = new Set<string>();
		let action: unknown;
		try {
			const parsed: unknown = JSON.parse(rawText);
			action = isPlainObject(parsed) ? parsed.action : undefined;
		} catch {
			action = undefined;
		}
		if (isPlainObject(action)) {
			const context: Record<string, unknown> = isPlainObject(action.context) ? action.context : {};
			const keys = ["targetCoordinator"];
			const surfaceAddr = typeof action.surfaceId === "string" ? addressFromSurfaceId(action.surfaceId) : null;
			const isKnown = (address: string): boolean => state.coordinators.some((c) => c.address === address);
			const hasNamedCoord = surfaceAddr !== null || keys.some((key) => typeof context[key] === "string");
			if (!hasNamedCoord) {
				for (const c of state.coordinators) named.add(c.address);
				for (const address of actionArrivals.keys()) named.add(address);
			}
			const candidates: string[] = [];
			if (surfaceAddr !== null && isKnown(surfaceAddr)) {
				candidates.push(surfaceAddr);
			} else {
				for (const key of keys) {
					const address = context[key];
					if (typeof address === "string") candidates.push(address);
				}
			}
			for (const address of candidates) {
				// A press of a replaced view changes nothing, so it withdraws no press of its coordinator.
				if (isKnown(address) && !isStaleViewPress(address, action.name, context)) named.add(address);
			}
		}
		const counts = new Map<string, number>();
		for (const address of named) {
			const next = (actionArrivals.get(address) ?? 0) + 1;
			actionArrivals.set(address, next);
			counts.set(address, next);
		}
		return counts;
	};

	/**
	 * The one send path for a press: `hc get`, events poll, then the final step. A coordinator with cards sits at
	 * its prompt (its Stop event came, its next turn-start did not), so the status of `hc get` does not hold the
	 * answer. The final step checks synchronously, with no `await` before the receipt: the generation, the arrival
	 * count of the address against the count of the press, and the terminal `live` in this lookup. Then one frozen
	 * list of the rows to send, one receipt, `hc send` (never `--force`), pick log, card removal. `inFlightSend` covers
	 * only the final step.
	 */
	async function deliverAnswers(
		destination: string,
		gen: number,
		group: CoordinatorGroup,
		pressArrivals: number,
	): Promise<DeliveryOutcome> {
		const term = await hc.get(destination);
		await pollEventsNow();
		if (!isCurrentGen(destination, gen)) {
			return { handled: false, reason: "stale-after-get" };
		}
		const liveGroup = findGroup(destination) ?? group;
		if (liveGroup.locked) {
			// A turn-start came before the final step: the coordinator works, so nothing is sent.
			showCards(liveGroup, "");
			return { handled: false, reason: "locked" };
		}
		if ((actionArrivals.get(destination) ?? 0) !== pressArrivals) {
			showCards(liveGroup, withUnknownNote(destination, gen, withdrawnText(destination)));
			return { handled: false, reason: "press-withdrawn" };
		}
		if (term === null) {
			showCards(
				liveGroup,
				withUnknownNote(
					destination,
					gen,
					`Send refused: hc get found no terminal ${destination}. The rows stay; press Send again.`,
				),
			);
			return { handled: false, reason: "hc-get-failed" };
		}
		if (term.state !== undefined && term.state !== "live") {
			showCards(liveGroup, withUnknownNote(destination, gen, `Send refused: the terminal ${destination} is gone (${term.state}).`));
			return { handled: false, reason: "terminal-gone" };
		}
		if (inFlightSend.has(destination)) {
			return { handled: false, reason: "send-in-flight" };
		}
		inFlightSend.add(destination);
		try {
			return await finishDelivery(destination, gen, liveGroup);
		} finally {
			inFlightSend.delete(destination);
		}
	}

	async function finishDelivery(destination: string, gen: number, liveGroup: CoordinatorGroup): Promise<DeliveryOutcome> {
		// The last synchronous step before the launch: ONE frozen list of the rows to send, from the live rows now
		// (checked, a valid answer, and a Confirm for a risky row). The line, the receipt, the pick log and the removal
		// after the delivery all use this list. A row that the decider marked risky during the lookup is not in it.
		const rows = sendableRows(liveGroup).map((item) => structuredClone(item));
		const labels = rows.map((item) => item.row.label);
		const baseLine = formatSendLine({ ...liveGroup, rows });
		const digest = liveGroup.reportDigest ?? sha256Hex("");
		// After an unknown result, a press whose list gives the same line sends the line of the first try with its
		// receipt: when both arrive, the receipt verifies one time, so the coordinator applies the answer once. A
		// receipt that can expire before the line arrives, or a different line, ends the first try: this press removes
		// its receipt, so a late first copy cannot verify, and the press is a new send with a new receipt. A receipt that
		// is gone before this press sends nothing: a young one was consumed by a first copy that verified
		// (`firstLineArrived`); an old one can also have expired, so its rows wait for the owner (`firstLineUnknown`).
		const retry = unknownSends.get(destination);
		let reuse: UnknownSend | undefined;
		let tooOld = false;
		/**
		 * The receipt of the first try was gone before this press, while it was still too young for a sweep (the reuse
		 * and line-changed branches: `canReuseUnknownSend` holds): only a verify removes it then, so the coordinator
		 * verified the first line. Nothing is sent in this press, so no second copy of these answers goes out; the rows
		 * of the first line leave the surface as after a delivered send. The verify proves that the line reached the
		 * prompt and started a turn, as a turn-start does, so the surface locks with no "Receipt pending" line until the
		 * next report. The rows of the first line are not kept with the unknown record, so no pick log entry is written
		 * for them.
		 */
		const firstLineArrived = (kept: UnknownSend, why: string): DeliveryOutcome => {
			unknownSends.delete(destination);
			endMaybeSent(destination, kept.labels);
			logEvent("receipt", destination, digest, `first-line-consumed-${why}`);
			if (isCurrentGen(destination, gen)) {
				const firstRows = kept.labels.map((label) => `[${label}]`).join(", ");
				removeSentRows(
					liveGroup,
					kept.labels,
					"turn-started",
					`The first answer for ${firstRows} reached ${destination}, so these rows are removed. Nothing was sent now.`,
				);
			}
			return { handled: false, reason: "first-line-consumed" };
		};
		/**
		 * The receipt of a first try that is too old to reuse was already gone before this press: a verify consumed it
		 * (the line arrived), or it expired and a sweep of another send removed it (the line never arrived, or too late
		 * to verify). The file does not tell the two apart, so the owner decides. Nothing is sent in this press, and the
		 * first try ends, so the next press is a new send with a new receipt. The rows of the first line stay with their
		 * answers and typed text, but unchecked: the next Send holds them only when the owner chooses an answer of the
		 * row again, which gives a new answer version, so a risky row needs its Confirm again. The surface does not lock.
		 * The rows keep their possibly-sent mark until the next report (`unresolvedLabels`), because their answer can
		 * have arrived.
		 */
		const firstLineUnknown = (kept: UnknownSend): DeliveryOutcome => {
			unknownSends.delete(destination);
			logEvent("receipt", destination, digest, "old-receipt-gone-unresolved");
			if (!isCurrentGen(destination, gen)) return { handled: false, reason: "first-line-unknown" };
			const first = new Set(kept.labels);
			const maybe = maybeSentLabels.get(destination) ?? new Set<string>();
			const held = unresolvedLabels.get(destination) ?? new Set<string>();
			for (const label of kept.labels) {
				maybe.add(label);
				held.add(label);
			}
			maybeSentLabels.set(destination, maybe);
			unresolvedLabels.set(destination, held);
			for (const item of liveGroup.rows) {
				if (!first.has(item.row.label)) continue;
				item.checked = false;
				item.confirmed = false;
			}
			const firstRows = kept.labels.map((label) => `[${label}]`).join(", ");
			showCards(
				liveGroup,
				`The first try for ${firstRows} to ${destination} is old, and its result is not known: it may have arrived; check the terminal. Nothing was sent now, and these rows are no longer checked. To send the answer of such a row again, choose it again (or press Use text), then press Send.`,
			);
			return { handled: false, reason: "first-line-unknown" };
		};
		// A new line goes out only when this press removed the old receipt: else the old line and the new line can both
		// verify. On a failed removal nothing is sent, and the retry record stays for the next press.
		const oldReceiptEnd = (kept: UnknownSend, why: string): "removed" | "already-gone" | "failed" => {
			const ended = endReceipt(kept.receiptPath);
			if (ended !== "failed") return ended;
			logEvent("receipt", destination, digest, `remove-failed-${why}`);
			showCards(liveGroup, `The old receipt for ${destination} could not be ended, so nothing was sent. Press Send again.`);
			return ended;
		};
		if (retry && retry.gen === gen && !canReuseUnknownSend(retry)) {
			const ended = oldReceiptEnd(retry, "too-old");
			if (ended === "failed") return { handled: false, reason: "receipt-remove-failed" };
			if (ended === "already-gone") return firstLineUnknown(retry);
			unknownSends.delete(destination);
			logEvent("receipt", destination, digest, "removed-too-old-to-reuse");
			tooOld = true;
		}
		if (!baseLine) {
			showCards(
				liveGroup,
				tooOld
					? `The first try for ${destination} is too old to send again. Check the answers and press Send.`
					: withUnknownNote(destination, gen, "No checked answer to send. Check a row with an answer, and confirm a risky answer."),
			);
			return { handled: false, reason: "no-confirmed-answers" };
		}
		const kept = unknownSends.get(destination);
		if (kept && kept.gen === gen) {
			if (kept.baseLine === baseLine) {
				// The same line again only while its receipt can verify: a gone receipt was consumed by the first copy.
				if (receiptIsGone(kept.receiptPath)) return firstLineArrived(kept, "reuse");
				reuse = kept;
			} else {
				const ended = oldReceiptEnd(kept, "line-changed");
				if (ended === "failed") return { handled: false, reason: "receipt-remove-failed" };
				if (ended === "already-gone") return firstLineArrived(kept, "line-changed");
				unknownSends.delete(destination);
				logEvent("receipt", destination, digest, "removed-line-changed");
			}
		}
		let wireLine: string;
		let receiptPath: string;
		let receiptCreatedAtMs: number;
		if (reuse) {
			wireLine = reuse.wireLine;
			receiptPath = reuse.receiptPath;
			receiptCreatedAtMs = reuse.receiptCreatedAtMs;
			logEvent("receipt", destination, digest, "reused");
		} else {
			try {
				const receipt: CreatedReceipt = writeReceipt({
					stateDir: receiptStateDir,
					address: destination,
					baseLine,
					reportDigest: digest,
				});
				receiptPath = receipt.path;
				receiptCreatedAtMs = Date.parse(receipt.record.createdAt);
				wireLine = appendReceiptSuffix(baseLine, receipt.id);
			} catch {
				logEvent("receipt", destination, digest, "write-failed");
				if (isCurrentGen(destination, gen)) {
					showCards(liveGroup, `Send failed for ${destination} (receipt write error). Try Send again.`);
				}
				return { handled: false, reason: "receipt-write-failed" };
			}
			logEvent("receipt", destination, digest, "written");
		}

		/**
		 * Before the plain send after a usage refusal of the flag: drain the events, then the same report and no lock,
		 * and each frozen row is still sendable in the live group with the same answer (the decider can mark a row risky
		 * while the flagged child runs).
		 */
		let withheldBy = "locked" as "locked" | "rows-changed";
		const plainCanGo = (): boolean => {
			const live = findGroup(destination);
			if (!isCurrentGen(destination, gen) || live?.locked) return false;
			const liveSendable = live ? sendableRows(live) : [];
			const same = rows.every((frozen) => {
				const now = liveSendable.find((item) => item.row.label === frozen.row.label);
				const a = now ? effectiveAnswer(now) : null;
				const b = effectiveAnswer(frozen);
				return Boolean(a && b && a.text === b.text && a.picked === b.picked);
			});
			if (!same) withheldBy = "rows-changed";
			return same;
		};
		let result: HcSendResult;
		const abort = new AbortController();
		sendAborts.set(destination, abort);
		sendingLabels.set(destination, labels);
		try {
			// No wait between the last checks and the launch of `hc send`: the press uses the answer known now.
			const noDraftWait = readNoDraftWait();
			logEvent("send", destination, digest, `${reuse ? "retry" : "first"}${noDraftWait ? "-no-draft-wait" : ""}`);
			result = await hc.send(destination, wireLine, abort.signal, noDraftWait, { drain: pollEventsNow, canGo: plainCanGo });
			if (result.plainAfterUsage) logEvent("send", destination, digest, "plain-after-usage");
		} catch {
			result = abort.signal.aborted
				? { ok: false, code: 1, aborted: true, detail: "aborted" }
				: { ok: false, code: 1, unknown: true, detail: "hc send threw" };
		} finally {
			if (sendAborts.get(destination) === abort) sendAborts.delete(destination);
			if (sendingLabels.get(destination) === labels) sendingLabels.delete(destination);
		}

		if (!result.ok && (result.aborted || abort.signal.aborted)) {
			// A new report came during the send: the old line counts as not sent. The new report removed the receipts
			// of the address; the new cards get no status text from this send.
			removeReceipt(receiptPath);
			logEvent("delivery", destination, digest, "aborted-new-report");
			return { handled: false, reason: "hc-send-aborted" };
		}
		if (!result.ok && result.withheld) {
			// The check before the plain send failed: nothing was sent. The reused receipt of a first try that can still
			// arrive stays.
			if (!reuse) removeReceipt(receiptPath);
			if (withheldBy === "rows-changed") {
				// A checked answer changed or needs Confirm now: the surface comes back with Send, not locked.
				logEvent("delivery", destination, digest, "withheld-rows-changed");
				if (isCurrentGen(destination, gen)) {
					showCards(
						liveGroup,
						withUnknownNote(
							destination,
							gen,
							`Answers for ${destination} not sent: a checked answer changed or needs Confirm. Check the rows and press Send again.`,
						),
					);
				}
				return { handled: false, reason: "rows-changed" };
			}
			// A turn-start came during the refused flagged send, as for a press on a locked surface.
			logEvent("delivery", destination, digest, "withheld-locked");
			if (isCurrentGen(destination, gen)) showCards(liveGroup, "");
			return { handled: false, reason: "locked" };
		}
		logEvent("delivery", destination, digest, result.ok ? "ok" : result.unknown ? "hc-send-unknown" : `hc-send-failed-${result.code}`);
		// A turn-start during `hc send` locked the surface: the pending form ends at this result.
		const turnStarted = Boolean(findGroup(destination)?.locked);
		if (!result.ok) {
			if (result.unknown) {
				// Keep the receipt: a line that did arrive can still verify. A press with the same line sends it again.
				// On a locked surface no press can send, so no retry is kept.
				if (isCurrentGen(destination, gen)) {
					// Also on a locked surface: the next report gives nothing from these rows.
					const maybe = maybeSentLabels.get(destination) ?? new Set<string>();
					for (const label of labels) maybe.add(label);
					maybeSentLabels.set(destination, maybe);
					if (turnStarted) {
						showCards(liveGroup, `Send status unknown for ${destination}: hc send gave no result in ${HC_SEND_TIMEOUT_MS / 1000} seconds. The answer can still arrive; check the terminal.`);
					} else {
						unknownSends.set(destination, { gen, baseLine, wireLine, labels, receiptPath, receiptCreatedAtMs });
						showCards(liveGroup, unknownText(destination));
					}
				}
				return { handled: false, reason: "hc-send-unknown" };
			}
			// A definite refusal: remove the receipt, except the reused receipt of a first try that can still arrive.
			if (!reuse) removeReceipt(receiptPath);
			if (isCurrentGen(destination, gen)) {
				showCards(
					liveGroup,
					reuse
						? `Send failed for ${destination} (exit ${result.code}). The first try can still arrive; check the terminal. A new press of Send with the same checked answers sends the same line with the same receipt.`
						: `Send failed for ${destination} (exit ${result.code}). Try Send again.`,
				);
			}
			return { handled: false, reason: "hc-send-failed" };
		}

		unknownSends.delete(destination);
		endMaybeSent(destination, labels);
		recordPickLog(pickLogPath, rows);
		if (isCurrentGen(destination, gen)) removeSentRows(liveGroup, labels, turnStarted ? "turn-started" : "await-turn");
		return { handled: true };
	}

	/**
	 * After a delivered send: remove only the sent rows. With no row left, the cards end, and the pending form stays
	 * until the turn-start of the address or the fallback time. With rows left, the surface stays locked and shows the
	 * "Receipt pending" line for the sent rows until the same moment. With `turn-started` the turn-start came during the
	 * send. In `print` mode no turn follows: the rows left stay usable, with Send, and no line shows. With rows left,
	 * `statusText` is the status line of the cards.
	 */
	function removeSentRows(
		group: CoordinatorGroup,
		sentLabels: readonly string[],
		mode: "await-turn" | "turn-started" | "print",
		statusText = "",
	): void {
		const awaitTurn = mode === "await-turn";
		const address = group.address;
		const sent = new Set(sentLabels);
		group.rows = group.rows.filter((item) => !sent.has(item.row.label));
		group.receiptPending = false;
		if (group.rows.length === 0) {
			bumpGeneration(address);
			pastRevisions.delete(address);
			state.coordinators = state.coordinators.filter((c) => c !== group);
			if (!awaitTurn) {
				dropHeldForm(address, false);
				broadcastSurfaceDelete(address);
				return;
			}
			const timer = setTimeout(() => {
				if (heldForms.get(address) === timer) dropHeldForm(address, true);
			}, RECEIPT_PENDING_FALLBACK_MS);
			timer.unref();
			heldForms.set(address, timer);
			return;
		}
		group.statusMessage = statusText;
		dropSentNote(address, false);
		if (mode === "print") {
			broadcastSurfaceCreate(group);
			return;
		}
		group.locked = true;
		if (awaitTurn) {
			group.sentPending = [...sentLabels];
			const timer = setTimeout(() => {
				if (sentNoteTimers.get(address) === timer) dropSentNote(address, true);
			}, RECEIPT_PENDING_FALLBACK_MS);
			timer.unref();
			sentNoteTimers.set(address, timer);
		}
		broadcastSurfaceCreate(group);
	}

	/**
	 * Validate a client action completely against rendered buttons, surface ID, report revisions, target rows, drafts, and options
	 * BEFORE mutating any state.
	 */
	async function processAction(
		rawText: string,
		arrived: ReadonlyMap<string, number>,
		client?: LocalWsClient,
	): Promise<{ handled: boolean; reason?: string }> {
		touch();
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawText);
		} catch {
			return { handled: false, reason: "invalid-json" };
		}
		if (!isPlainObject(parsed)) return { handled: false, reason: "not-object" };
		const topKeys = Object.keys(parsed);
		if (parsed.version !== A2UI_VERSION || topKeys.some((k) => k !== "version" && k !== "action")) {
			return { handled: false, reason: "bad-envelope" };
		}
		const action = parsed.action;
		if (!isPlainObject(action)) return { handled: false, reason: "missing-action" };
		if (Object.keys(action).some((k) => !ALLOWED_ACTION_KEYS.has(k))) {
			return { handled: false, reason: "invalid-action-keys" };
		}
		if (
			typeof action.name !== "string" ||
			typeof action.surfaceId !== "string" ||
			typeof action.sourceComponentId !== "string" ||
			typeof action.timestamp !== "string" ||
			!isPlainObject(action.context)
		) {
			return { handled: false, reason: "invalid-action-shape" };
		}

		const surfaceAddress = addressFromSurfaceId(action.surfaceId);
		if (!surfaceAddress) {
			return { handled: false, reason: "unknown-surface" };
		}

		// Read pending event files directly before every send decision so a turn-start written before the click wins.
		if (action.name === "send") {
			await pollEventsNow();
		}

		const group = findGroup(surfaceAddress);
		if (!group || group.rows.length === 0) {
			return { handled: false, reason: "no-active-surface" };
		}

		const context = action.context;
		if (Object.keys(context).some((k) => !ALLOWED_CONTEXT_KEYS.has(k) && !DRAFT_KEY_RE.test(k))) {
			return { handled: false, reason: "invalid-context-keys" };
		}
		if (context.targetCoordinator !== undefined && context.targetCoordinator !== surfaceAddress) {
			return { handled: false, reason: "surface-coordinator-mismatch" };
		}

		// A press of a Button of a replaced view: the client that pressed gets the current surface again with a status
		// line. No answer, no draft and no delivery changes. A forged or unknown revision stays silent.
		if (isStaleViewPress(group.address, action.name, context)) {
			if (client && !client.closed) {
				const sid = surfaceIdFor(group.address);
				const view: CoordinatorGroup = { ...group, statusMessage: withUnknownNote(group.address, generations.get(group.address) ?? 0, STALE_VIEW_TEXT) };
				if (!client.live.has(sid)) client.sendMessages(toCreateSurfaceMessages(view));
				else if (!client.sendMessages(toUpdateSurfaceMessages(view))) client.sendMessages(toReplaceSurfaceMessages(view));
			}
			return { handled: false, reason: "stale-view" };
		}

		// Match sourceComponentId, action name, and every bound literal (coordinator, row, revision, option) to a rendered Button.
		const buttons = renderedButtonSpecs(group);
		const button = buttons.get(action.sourceComponentId);
		if (!button) {
			return { handled: false, reason: "unknown-source-component" };
		}
		if (button.name !== action.name) {
			return { handled: false, reason: "action-mismatch" };
		}
		// A Confirm whose answer version is not the current one approves an answer that its surface no longer shows.
		let answerChanged = false;
		for (const [key, expected] of Object.entries(button.literals)) {
			if (context[key] !== expected) {
				if (key === "answerVersion" && button.name === "confirm" && typeof context[key] === "string") {
					answerChanged = true;
					continue;
				}
				return { handled: false, reason: `mismatch-${key}` };
			}
		}
		for (const targetKey of TARGET_LITERAL_KEYS) {
			if (!Object.hasOwn(button.literals, targetKey) && context[targetKey] !== undefined) {
				return { handled: false, reason: "unexpected-target" };
			}
		}
		// Every rendered Button names the coordinator and the revision of the surface.
		if (button.literals.targetCoordinator !== group.address || button.literals.targetRevision !== group.revision) {
			return { handled: false, reason: "stale-revision" };
		}

		// A drawn Confirm with another string `answerVersion` gets the visible refusal before the draft checks: a draft key
		// of a field that is no longer drawn (another row was answered after this Button was drawn) does not hide it.
		// No draft is applied and nothing changes: the surface shows the current answer and its current Confirm. After an
		// unknown send, the unknown note stays in front of the status.
		if (answerChanged) {
			const label = button.literals.targetLabel;
			group.statusMessage = withUnknownNote(group.address, generations.get(group.address) ?? 0, `[${label}] The answer changed. Check it and press Confirm again.`);
			broadcastSurfaceUpdate(group);
			return { handled: false, reason: "answer-changed" };
		}

		// The drafts of the "Other answer" fields arrive with each press, one `other_<label>` key for each field drawn.
		// A draft is no answer: it is kept only so that a redraw does not erase it. A key that the Button does not bind
		// refuses the press; a missing key keeps the draft that the producer has.
		// The membership comes first: a key of a field that is not drawn refuses the press also with a null value.
		const arrivedDrafts = new Map<string, string>();
		for (const [key, value] of Object.entries(context)) {
			if (!DRAFT_KEY_RE.test(key)) continue;
			const label = key.slice(DRAFT_KEY_PREFIX.length);
			if (!button.drafts.has(label)) return { handled: false, reason: "unrendered-other" };
			if (value === null || value === undefined) continue;
			if (typeof value !== "string") return { handled: false, reason: "invalid-other" };
			arrivedDrafts.set(label, value.slice(0, CUSTOM_TEXT_MAX));
		}
		const applyDrafts = () => {
			for (const item of group.rows) {
				const draft = arrivedDrafts.get(item.row.label);
				if (draft !== undefined) item.draft = draft;
			}
		};
		/**
		 * Write the planned answer state into the live row. A new, replaced or cleared answer gets a new answer version
		 * and no Confirm: a Confirm of the old surface no longer matches.
		 */
		const commit = (item: RowViewState, planned: Pick<RowViewState, "selectedOptionId" | "customText" | "draft" | "confirmed" | "checked">, newAnswer: boolean) => {
			item.selectedOptionId = planned.selectedOptionId;
			item.customText = planned.customText;
			item.draft = planned.draft;
			item.confirmed = newAnswer ? false : planned.confirmed;
			item.checked = planned.checked;
			if (newAnswer) item.answerVersion = ++nextAnswerVersion;
		};
		const targetLbl = button.literals.targetLabel;
		const targetItem = targetLbl ? group.rows.find((r) => r.row.label === targetLbl) : undefined;
		/** The target row is drawn in `left`: open, not writing (so its answers and its field show). */
		const targetOpen = Boolean(targetItem && !targetItem.row.writing && !isRowAnswered(targetItem));

		// The status text of an unknown send stays until the cards end: it says what a new press sends.
		const keepStatus = unknownSends.has(group.address);
		const redraw = (status = "") => {
			if (status || !keepStatus) group.statusMessage = status;
			broadcastSurfaceUpdate(group);
		};

		// Action-specific preconditions before any mutation.
		switch (button.name) {
			case "choose": {
				const optionId = button.literals.optionId;
				if (!targetItem || !targetOpen || typeof optionId !== "string" || !targetItem.row.options.slice(0, 3).some((opt) => opt.id === optionId)) {
					return { handled: false, reason: "unknown-option" };
				}
				// The pressed answer wins over a used text: the custom text of the row ends. A risky row waits for Confirm.
				applyDrafts();
				commit(targetItem, { ...targetItem, selectedOptionId: optionId, customText: "", checked: true }, true);
				redraw();
				return { handled: true };
			}
			case "other": {
				if (!targetItem || !targetOpen) return { handled: false, reason: "unknown-row" };
				const text = arrivedDrafts.get(targetItem.row.label) ?? targetItem.draft;
				applyDrafts();
				if (singleLineText(text).length === 0) {
					// An empty field: no answer changes, and one status line says why.
					redraw(`[${targetItem.row.label}] has no text to use. Type an answer in its field, then press Use text.`);
					return { handled: false, reason: "no-text-to-use" };
				}
				// The typed text is the answer of the row and checks it, as an answer button does. A risky row waits for Confirm.
				commit(targetItem, { ...targetItem, selectedOptionId: null, customText: text, draft: text, checked: true }, true);
				redraw();
				return { handled: true };
			}
			case "toggle": {
				// A check box is drawn only in `right`, for an answered row: a press clears the answer and the typed text.
				if (!targetItem || !isRowAnswered(targetItem)) return { handled: false, reason: "unknown-row" };
				applyDrafts();
				commit(targetItem, { selectedOptionId: null, customText: "", draft: "", confirmed: false, checked: false }, true);
				redraw();
				return { handled: true };
			}
			case "confirm": {
				if (!targetItem || !targetOpen || !needsConfirm(targetItem)) {
					return { handled: false, reason: "not-open-risky-row" };
				}
				if (!targetItem.checked || !isRowPendingConfirm(targetItem)) {
					return { handled: false, reason: "no-answer-to-confirm" };
				}
				applyDrafts();
				commit(targetItem, { ...targetItem, confirmed: true, checked: true }, false);
				redraw();
				return { handled: true };
			}
			case "send": {
				if (group.rows.length === 0) {
					return { handled: false, reason: "unknown-coordinator" };
				}
				if (group.locked) return { handled: false, reason: "locked" };
				if (inFlightSend.has(group.address)) {
					return { handled: false, reason: "send-in-flight" };
				}

				const destination = group.address;
				const gen = generations.get(destination) ?? 0;
				applyDrafts();
				// The final list is built again just before the launch; this early check refuses an empty press at once.
				if (sendableRows(group).length === 0) {
					redraw("No checked answer to send. Choose an answer, and confirm a risky answer.");
					return { handled: false, reason: "no-confirmed-answers" };
				}

				if (printOnly) {
					// One list for the line, the pick log and the removal, as in a real send.
					const sentRows = sendableRows(group).map((item) => structuredClone(item));
					onPrint(formatSendLine({ ...group, rows: sentRows }) as string);
					recordPickLog(pickLogPath, sentRows);
					// Print mode has no receipt and no turn of a coordinator: the rows left stay usable.
					removeSentRows(group, sentRows.map((item) => item.row.label), "print");
					return { handled: true };
				}

				// Show the accepted press at once as the small pending form: `hc send` can wait for an unsent draft in
				// the terminal. The form has no button, so no second press can send while it shows.
				group.receiptPending = true;
				broadcastSurfaceCreate(group);
				const pressArrivals = arrived.get(destination) ?? actionArrivals.get(destination) ?? 0;
				return deliverAnswers(destination, gen, group, pressArrivals);
			}
			case "close": {
				recordPickLog(pickLogPath, group.rows);
				bumpGeneration(group.address);
				unknownSends.delete(group.address);
				maybeSentLabels.delete(group.address);
				unresolvedLabels.delete(group.address);
				pastRevisions.delete(group.address);
				dropSentNote(group.address, false);
				state.coordinators = state.coordinators.filter((c) => c.address !== group.address);
				broadcastSurfaceDelete(group.address);
				return { handled: true };
			}
		}
		return { handled: false, reason: "action-mismatch" };
	}

	async function fillCoordinatorAsync(address: string, gen: number): Promise<void> {
		const group = findGroup(address);
		if (!group || !isCurrentGen(address, gen)) return;

		const deciderCfg = options.decider === false ? null : (options.decider ?? {});
		const writerCfg = options.writer === false ? null : (options.writer ?? {});
		const thresholds = deciderCfg ? resolveThresholds(deciderCfg.thresholds) : null;

		let deciderAvailable = false;
		const phaseLimit = deciderCfg ? (deciderCfg.phaseTimeoutMs ?? 2000) : 0;
		const phaseDeadline = Date.now() + phaseLimit;

		if (deciderCfg) {
			deciderAvailable = await checkDeciderHealth(deciderCfg, phaseDeadline);
			if (!isCurrentGen(address, gen)) return;
			group.deciderStatus = deciderAvailable ? "decider" : "no decider";
			broadcastSurfaceUpdate(group);
		} else {
			group.deciderStatus = "no decider";
		}

		// 1. Score split rows in row order within the shared 2 s phase budget.
		if (deciderCfg && deciderAvailable && thresholds) {
			const rowLimit = deciderCfg.rowTimeoutMs ?? 400;
			let anyAnswered = false;
			let anyAttempted = false;

			for (const item of group.rows) {
				if (!isCurrentGen(address, gen)) return;
				if (!item.row.needsDecider || item.row.writing || item.row.candidates.length === 0) continue;
				const remaining = phaseDeadline - Date.now();
				if (remaining <= 0) break;
				anyAttempted = true;
				const score = await scoreRowWithDecider(deciderCfg, group.excerpt, item.row, Math.min(rowLimit, remaining));
				if (!isCurrentGen(address, gen)) return;
				if (!score) continue;
				anyAnswered = true;
				// The risk result of this report replaces the risk that a taken-over answer held from the old report.
				item.row = applyDeciderScore(item.row, score, thresholds);
				item.riskHold = false;
				broadcastSurfaceUpdate(group);
			}

			if (anyAttempted && !anyAnswered) {
				deciderAvailable = false;
				group.deciderStatus = "no decider";
				broadcastSurfaceUpdate(group);
			}
		}

		// 2. Run writer only for rows that the splitter refused.
		const openItems = group.rows.filter((item) => item.row.needsWriter && item.row.writing);
		if (openItems.length === 0) return;

		const scoreWrittenItem = async (item: RowViewState) => {
			if (!deciderCfg || !deciderAvailable || !thresholds || !isCurrentGen(address, gen)) return;
			const score = await scoreRowWithDecider(deciderCfg, group.excerpt, item.row);
			if (!isCurrentGen(address, gen) || !score) return;
			item.row = applyDeciderScore(item.row, score, thresholds);
			item.riskHold = false;
			broadcastSurfaceUpdate(group);
		};

		const pendingWrittenScores: Promise<void>[] = [];
		if (writerCfg) {
			await runWriter(
				group.excerpt,
				openItems.map((item) => item.row),
				writerCfg,
				(label, candidates) => {
					if (!isCurrentGen(address, gen)) return;
					const item = group.rows.find((r) => r.row.label === label);
					if (!item) return;
					const riskByWords = item.row.riskByWords || candidates.some((opt) => isRiskyByWords(opt.text));
					item.row = {
						...item.row,
						riskByWords,
						risky: item.row.risky || riskByWords,
						writing: false,
						candidates,
						options: candidates.slice(0, 3),
					};
					broadcastSurfaceUpdate(group);
					pendingWrittenScores.push(scoreWrittenItem(item));
				},
			);
			await Promise.all(pendingWrittenScores);
		}

		if (!isCurrentGen(address, gen)) return;
		// Any open row that still got no writer options falls back to the fixed answers so it remains usable.
		let changed = false;
		for (const item of openItems) {
			if (item.row.writing) {
				const fallback = makeOptions(FIXED_DECISION_OPTIONS);
				item.row = {
					...item.row,
					writing: false,
					candidates: fallback,
					options: fallback,
				};
				changed = true;
			}
		}
		if (changed) broadcastSurfaceUpdate(group);
	}

	async function addReport(input: StopEventInput): Promise<{ accepted: boolean; reason?: string }> {
		touch();
		if (!isValidReceiptAddress(input.address)) {
			return { accepted: false, reason: "invalid-address" };
		}
		const lastTime = lastEventTimes.get(input.address);
		if (input.eventTimeMs !== undefined && lastTime !== undefined && input.eventTimeMs < lastTime) {
			return { accepted: false, reason: "older-event" };
		}
		lastEventTimes.set(input.address, input.eventTimeMs ?? performance.timeOrigin + performance.now());
		refreshNoDraftWait();
		// The rows in the line of a send in flight, or in the line of an unknown send since the last report (also one
		// before a turn-start), may have reached the coordinator: they give nothing to a new row.
		const maybeSent = new Set([...(sendingLabels.get(input.address) ?? []), ...(maybeSentLabels.get(input.address) ?? [])]);
		maybeSentLabels.delete(input.address);
		unresolvedLabels.delete(input.address);
		removeReceiptsForAddress(receiptStateDir, input.address);
		logEvent("receipts-removed", input.address, sha256Hex(input.reportText), "new-report");
		// A new report means a new prompt: a held send of the old line must not reach it. A turn-start does not abort,
		// because the delivered line itself starts a turn.
		sendAborts.get(input.address)?.abort();
		// The rows of the old report, for the take-over of picks by rows with the same text.
		const oldGroup = findGroup(input.address);
		const keptRows = oldGroup?.rows ?? [];
		// The history of the address goes on only when this report replaces an active surface; `clearAddressCards` ends
		// it, and only a successful replacement below sets it again.
		const past = oldGroup ? [...(pastRevisions.get(input.address) ?? []), oldGroup.revision].slice(-PAST_REVISIONS_KEPT) : [];
		const gen = clearAddressCards(input.address);
		let coordName = input.name;
		if (!input.skipRoleCheck) {
			if (!dummiesOn(dummiesFile, "claude")) {
				return { accepted: false, reason: "dummies-off" };
			}
			const term = await hc.get(input.address);
			if (!isCurrentGen(input.address, gen)) {
				return { accepted: false, reason: "superseded" };
			}
			if (!term || term.role !== "coordinator") {
				return { accepted: false, reason: term ? `role-${term.role ?? "unknown"}` : "hc-get-failed" };
			}
			coordName = coordName ?? term.name;
		}

		const extracted = extractOwnerRows(input.reportText);
		if (!extracted.eligible) {
			return { accepted: false, reason: extracted.reason ?? "ineligible" };
		}

		// A row with a condition gets no card: the coordinator repeats it with no condition when it is ready for it.
		const rowsWithCard = extracted.rows.filter((row) => !row.condition);
		if (rowsWithCard.length === 0) {
			return { accepted: false, reason: "conditional-rows-only" };
		}

		const revision = String(++nextRevision);
		const reportDigest = sha256Hex(input.reportText);
		const rows: RowViewState[] = takeOverRows(rowsWithCard, keptRows, maybeSent);
		const nextGroup: CoordinatorGroup = {
			address: input.address,
			revision,
			reportDigest,
			...(coordName ? { name: coordName } : {}),
			excerpt: extracted.excerpt,
			rows,
			deciderStatus: options.decider === false ? "no decider" : "decider ...",
			statusMessage: "",
		};

		if (past.length > 0) pastRevisions.set(input.address, past);
		state.coordinators.push(nextGroup);
		broadcastSurfaceCreate(nextGroup);

		void trackJob(fillCoordinatorAsync(input.address, gen));
		return { accepted: true };
	}

	/**
	 * Build the rows of a new report. A new row whose text (the whole text after the actor) equals the text of a kept
	 * row takes over its pick, custom text and checked state, but only when that text occurs one time among the kept
	 * rows and one time among the new rows; else the new row starts fresh. A kept row in `maybeSent` gives nothing.
	 * A pick whose option the new row does not have with the same text becomes the custom text, so the answer stays
	 * the same. A risky row is never confirmed after the take-over: the revision is new. A taken-over answer of a row
	 * that was risky in the old report (by words or by the decider, or by its own risk hold) keeps a risk hold: it needs
	 * a Confirm in the new revision, unless the risk result of the new report says that the row is not risky.
	 */
	function takeOverRows(newRows: readonly OwnerRow[], kept: readonly RowViewState[], maybeSent: ReadonlySet<string>): RowViewState[] {
		const countOf = (texts: readonly string[]) => {
			const counts = new Map<string, number>();
			for (const text of texts) counts.set(text, (counts.get(text) ?? 0) + 1);
			return counts;
		};
		const keptCounts = countOf(kept.map((item) => item.row.text));
		const newCounts = countOf(newRows.map((row) => row.text));
		return newRows.map((row) => {
			const fresh: RowViewState = { row, selectedOptionId: null, customText: "", draft: "", confirmed: false, checked: false };
			if (keptCounts.get(row.text) !== 1 || newCounts.get(row.text) !== 1) return fresh;
			const old = kept.find((item) => item.row.text === row.text);
			if (!old || maybeSent.has(old.row.label)) return fresh;
			fresh.customText = old.customText;
			fresh.draft = old.draft;
			fresh.checked = old.checked;
			if (old.selectedOptionId) {
				const oldOption = [...old.row.options, ...old.row.candidates].find((opt) => opt.id === old.selectedOptionId);
				const sameOption = [...row.options, ...row.candidates].find(
					(opt) => opt.id === old.selectedOptionId && opt.text === oldOption?.text,
				);
				if (sameOption) fresh.selectedOptionId = sameOption.id;
				else if (oldOption && !fresh.customText) fresh.customText = oldOption.text;
			}
			if (!effectiveAnswer(fresh)) fresh.checked = false;
			else if (needsConfirm(old)) fresh.riskHold = true;
			return fresh;
		});
	}

	function handleTurnStart(address: string, eventTimeMs?: number): void {
		touch();
		if (!isValidReceiptAddress(address)) return;
		const lastTime = lastEventTimes.get(address);
		if (eventTimeMs !== undefined && lastTime !== undefined && eventTimeMs < lastTime) {
			return;
		}
		lastEventTimes.set(address, eventTimeMs ?? performance.timeOrigin + performance.now());
		// After a delivered send with no row left, the pending form ends now.
		dropHeldForm(address, true);
		const group = findGroup(address);
		if (!group) return;
		// The coordinator works: the surface stays, LOCKED, until its next report. No retry of an unknown send is kept,
		// because no press can send while the surface is locked. The labels of a possibly sent line stay for that report.
		unknownSends.delete(address);
		group.locked = true;
		dropSentNote(address, false);
		// The delivered line can start its turn before `hc send` returns: the pending form stays until the send result.
		if (group.receiptPending && inFlightSend.has(address)) return;
		// A press in its lookup brings the surface back itself when it sees the lock.
		if (group.receiptPending) return;
		broadcastSurfaceUpdate(group);
	}

	async function drainEventsOnce(): Promise<void> {
		const dir = options.eventsDir;
		if (!dir || closed) return;
		if (!existsSync(dir)) return;

		let allEntries: string[];
		try {
			allEntries = readdirSync(dir);
		} catch {
			return;
		}

		const names = allEntries.filter((name) => FINISHED_EVENT_RE.test(name) || TAKEN_EVENT_RE.test(name));
		const loaded: Array<
			| { name: string; type: "turn_start"; address: string; timeMs: number }
			| { name: string; type: "stop"; address: string; timeMs: number; coordName?: string; reportText: string }
		> = [];

		for (const name of names) {
			if (closed) return;
			const full = join(dir, name);
			let stat: ReturnType<typeof lstatSync>;
			try {
				stat = lstatSync(full);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink() || !stat.isFile()) continue;

			// Take each matched event file under a private reader name before reading or removing it,
			// so a newer event written to the original name is never unlinked unread.
			const takenName = `reading-${process.pid}-${randomBytes(6).toString("hex")}.json`;
			const takenPath = join(dir, takenName);
			try {
				renameSync(full, takenPath);
			} catch {
				continue;
			}

			let takenStat: ReturnType<typeof lstatSync>;
			let raw: string;
			try {
				takenStat = lstatSync(takenPath);
				if (takenStat.isSymbolicLink() || !takenStat.isFile()) continue;
				raw = readFileSync(takenPath, "utf8");
			} catch {
				continue;
			}

			// A taken file that cannot be removed stays for the next poll; applying it now would apply it twice.
			try {
				unlinkSync(takenPath);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException)?.code ?? "UNKNOWN";
				if (code !== "ENOENT") {
					if (demoMode) process.stderr.write(`owner-popup: failed to remove read event ${takenName} (${code})\n`);
					continue;
				}
			}

			let ev: unknown;
			try {
				ev = JSON.parse(raw);
			} catch {
				continue;
			}
			if (!isPlainObject(ev) || typeof ev.type !== "string" || typeof ev.address !== "string") continue;
			const parsedAt = typeof ev.at === "string" ? Date.parse(ev.at) : Number.NaN;
			const timeMs =
				typeof ev.timeMs === "number" && Number.isFinite(ev.timeMs)
					? ev.timeMs
					: Number.isFinite(parsedAt)
						? parsedAt
						: takenStat.mtimeMs;
			if (ev.type === "turn_start") {
				loaded.push({ name, type: "turn_start", address: ev.address, timeMs });
			} else if (ev.type === "stop" && typeof ev.reportText === "string") {
				loaded.push({
					name,
					type: "stop",
					address: ev.address,
					timeMs,
					coordName: typeof ev.name === "string" ? ev.name : undefined,
					reportText: ev.reportText,
				});
			}
		}

		loaded.sort(
			(a, b) =>
				a.timeMs - b.timeMs ||
				(a.type === b.type ? 0 : a.type === "stop" ? -1 : 1) ||
				a.name.localeCompare(b.name),
		);

		for (const ev of loaded) {
			if (closed) return;
			if (ev.type === "turn_start") {
				logEvent("turn-start", ev.address);
				handleTurnStart(ev.address, ev.timeMs);
			} else {
				const digest = sha256Hex(ev.reportText);
				if (Date.now() - ev.timeMs > STOP_EVENT_MAX_AGE_MS) {
					logEvent("stop", ev.address, digest, "too-old");
					continue;
				}
				const added = await addReport({
					address: ev.address,
					name: ev.coordName,
					reportText: ev.reportText,
					eventTimeMs: ev.timeMs,
				});
				logEvent("stop", ev.address, digest, added.accepted ? "accepted" : added.reason ?? "refused");
			}
		}
	}

	function pollEventsNow(): Promise<void> {
		const run = pollChain.then(() => drainEventsOnce());
		pollChain = run.catch(() => {});
		return run;
	}

	const ws = await createLocalWsServer({
		port: options.port ?? DEFAULT_PRODUCER_PORT,
		path: options.path ?? DEFAULT_PRODUCER_PATH,
		peerAddress: options.peerAddress,
		clientIdleTimeoutMs: options.clientIdleTimeoutMs,
		pingIntervalMs: options.pingIntervalMs,
		onConnect: sendFullToClient,
		onDisconnect: (client) => {
			pendingActionsByClient.delete(client.id);
		},
		onMessage: (client, text) => {
			const arrived = countArrival(text);
			const queued = pendingActionsByClient.get(client.id) ?? 0;
			if (queued >= maxPendingActionsPerClient) return;
			pendingActionsByClient.set(client.id, queued + 1);
			const job = actionQueue.then(() => processAction(text, arrived, client)).finally(() => {
				const cur = pendingActionsByClient.get(client.id) ?? 0;
				if (cur <= 1) pendingActionsByClient.delete(client.id);
				else pendingActionsByClient.set(client.id, cur - 1);
			});
			actionQueue = job.catch(() => {});
		},
		onActivity: touch,
	});

	sweepExpiredReceipts(receiptStateDir);

	if (options.eventsDir) {
		mkdirSync(options.eventsDir, { recursive: true, mode: 0o700 });
		pollTimer = setInterval(() => {
			void pollEventsNow();
		}, eventPollMs);
		pollTimer.unref();
		void trackJob(pollEventsNow());
	}

	/** Addresses whose check for a closed terminal runs. */
	const goneChecks = new Set<string>();
	/**
	 * A locked group of a coordinator whose terminal no longer exists would stay for ever and hold the idle shutdown:
	 * when herdr-core says that the terminal does not exist, the group ends and its surface is deleted. A failed or slow
	 * check removes nothing.
	 */
	const dropClosedTerminals = (): void => {
		if (printOnly || !hc.gone) return;
		for (const group of state.coordinators) {
			const address = group.address;
			if (!group.locked || group.receiptPending || inFlightSend.has(address) || goneChecks.has(address)) continue;
			const gen = generations.get(address) ?? 0;
			goneChecks.add(address);
			const check = Promise.resolve()
				.then(() => hc.gone?.(address) ?? false)
				.catch(() => false)
				.then((gone) => {
					if (!gone || !isCurrentGen(address, gen) || findGroup(address) !== group || !group.locked) return;
					if (group.receiptPending || inFlightSend.has(address)) return;
					bumpGeneration(address);
					unknownSends.delete(address);
					maybeSentLabels.delete(address);
					unresolvedLabels.delete(address);
					pastRevisions.delete(address);
					dropSentNote(address, false);
					state.coordinators = state.coordinators.filter((c) => c !== group);
					logEvent("terminal-gone", address, group.reportDigest, "surface-removed");
					broadcastSurfaceDelete(address);
				})
				.finally(() => goneChecks.delete(address));
			void trackJob(check);
		}
	};

	if (idleShutdownMs > 0) {
		idleTimer = setInterval(() => {
			if (closed) return;
			dropClosedTerminals();
			if (state.coordinators.length === 0 && ws.openSockets() === 0 && Date.now() - lastActivityAt >= idleShutdownMs) {
				void pollEventsNow().then(() => {
					if (closed) return;
					if (state.coordinators.length === 0 && ws.openSockets() === 0 && Date.now() - lastActivityAt >= idleShutdownMs) {
						void close().then(() => options.onIdleShutdown?.());
					}
				});
			}
		}, Math.min(30_000, Math.max(50, Math.floor(idleShutdownMs / 4))));
		idleTimer.unref();
	}

	async function close(): Promise<void> {
		if (closed) return;
		closed = true;
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = null;
		}
		if (idleTimer) {
			clearInterval(idleTimer);
			idleTimer = null;
		}
		for (const timer of heldForms.values()) if (timer) clearTimeout(timer);
		heldForms.clear();
		for (const timer of sentNoteTimers.values()) clearTimeout(timer);
		sentNoteTimers.clear();
		await ws.close();
	}

	return {
		get port() {
			return ws.port;
		},
		ws,
		getState: () => structuredClone(state),
		addReport,
		handleTurnStart,
		handleRawAction: (rawText: string) => {
			const arrived = countArrival(rawText);
			const result = actionQueue.then(() => processAction(rawText, arrived));
			actionQueue = result.catch(() => {});
			return result;
		},
		pollEventsNow,
		async waitForPendingWork() {
			await pollChain;
			while (pendingJobs.size > 0) {
				await Promise.all([...pendingJobs]);
			}
			await actionQueue;
			await pollChain;
		},
		close,
	};
}

/** Small demo WebSocket client (`--client`) so the owner can test the producer with no app. */
async function runDemoClient(argv: readonly string[]): Promise<number> {
	let port = DEFAULT_PRODUCER_PORT;
	let actionName: string | null = null;
	let targetCoordinator: string | undefined;
	let targetRow: string | undefined;
	let pick: string | undefined;
	let other: string | undefined;
	let listenOnly = false;
	let waitMs = 1500;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--port" && argv[i + 1]) port = Number(argv[++i]);
		else if (arg === "--action" && argv[i + 1]) actionName = argv[++i];
		else if (arg === "--coordinator" && argv[i + 1]) targetCoordinator = argv[++i];
		else if (arg === "--row" && argv[i + 1]) targetRow = argv[++i];
		else if (arg === "--pick" && argv[i + 1]) pick = argv[++i];
		else if (arg === "--other" && argv[i + 1]) other = argv[++i];
		else if (arg === "--listen") listenOnly = true;
		else if (arg === "--wait-ms" && argv[i + 1]) waitMs = Number(argv[++i]);
	}

	const url = `ws://127.0.0.1:${port}${DEFAULT_PRODUCER_PATH}`;
	return new Promise<number>((resolveCode) => {
		const ws = new WebSocket(url);
		let sentAction = false;
		const buttonsBySurface = new Map<
			string,
			Array<{ id: string; name: string; surfaceId: string; context: Record<string, unknown> }>
		>();
		let doneTimer: NodeJS.Timeout | null = null;

		const finish = (code: number) => {
			if (doneTimer) clearTimeout(doneTimer);
			if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
				try {
					ws.close();
				} catch {
					// ignore
				}
			}
			resolveCode(code);
		};

		const inspectSurface = (messages: unknown[]) => {
			for (const msg of messages) {
				const obj = msg as Record<string, unknown>;
				if (obj.deleteSurface && isPlainObject(obj.deleteSurface) && typeof obj.deleteSurface.surfaceId === "string") {
					buttonsBySurface.delete(obj.deleteSurface.surfaceId);
					continue;
				}
				const body = (obj.createSurface ?? obj.updateComponents) as
					| { surfaceId?: string; components?: Array<Record<string, unknown>> }
					| undefined;
				if (!body?.surfaceId || !body?.components) continue;
				const nextButtons: Array<{ id: string; name: string; surfaceId: string; context: Record<string, unknown> }> = [];
				for (const comp of body.components) {
					if (comp.component !== "Button" || typeof comp.id !== "string") continue;
					const ev = (comp.action as { event?: { name?: unknown; context?: unknown } } | undefined)?.event;
					if (!ev || typeof ev.name !== "string" || !isPlainObject(ev.context)) continue;
					nextButtons.push({ id: comp.id, name: ev.name, surfaceId: body.surfaceId, context: ev.context });
				}
				buttonsBySurface.set(body.surfaceId, nextButtons);
			}
		};

		const selectButton = () => {
			if (!actionName) return null;
			const allButtons = [...buttonsBySurface.values()].flat();
			return (
				allButtons.find((btn) => {
					if (btn.name !== actionName) return false;
					if (targetCoordinator && btn.context.targetCoordinator !== targetCoordinator) return false;
					if (targetRow && btn.context.targetLabel !== targetRow) return false;
					if (pick !== undefined && btn.name === "choose" && btn.context.optionId !== pick) return false;
					return true;
				}) ?? null
			);
		};

		ws.addEventListener("message", (event) => {
			const text = String(event.data);
			process.stdout.write(`${text}\n`);
			try {
				const parsed = JSON.parse(text);
				if (Array.isArray(parsed)) inspectSurface(parsed);
			} catch {
				// ignore
			}
			if (actionName && !sentAction) {
				const matched = selectButton();
				if (!matched) {
					process.stderr.write(`client: no rendered ${actionName} button matched the requested target\n`);
					finish(1);
					return;
				}
				sentAction = true;
				const context: Record<string, unknown> = {};
				for (const [k, v] of Object.entries(matched.context)) {
					if (typeof v === "string") context[k] = v;
				}
				// `--other` is the text in the "Other answer" field of the target row; the other fields send no draft.
				const otherKey = targetRow ? draftKey(targetRow) : null;
				if (other !== undefined && otherKey && Object.hasOwn(matched.context, otherKey)) {
					context[otherKey] = other;
				}

				const payload = {
					version: A2UI_VERSION,
					action: {
						name: matched.name,
						surfaceId: matched.surfaceId,
						sourceComponentId: matched.id,
						timestamp: new Date().toISOString(),
						context,
					},
				};
				ws.send(JSON.stringify(payload));
				if (!listenOnly) {
					doneTimer = setTimeout(() => finish(0), waitMs);
				}
			} else if (!actionName && !listenOnly) {
				if (doneTimer) clearTimeout(doneTimer);
				doneTimer = setTimeout(() => finish(0), waitMs);
			}
		});

		ws.addEventListener("close", () => finish(0));
		ws.addEventListener("error", () => {
			process.stderr.write(`client: could not connect to ${url}\n`);
			finish(1);
		});
	});
}

async function main(argv: readonly string[]): Promise<number> {
	if (argv.includes("--help") || argv.includes("-h")) {
		process.stdout.write(
			[
				"Usage:",
				"  Demo producer: node packages/tenantext/owner-popup/producer.ts --demo <fixture> --parent <address> [--name <name>] [--port <port>] [--print] [--no-decider] [--no-writer]",
				"  Event daemon:  node packages/tenantext/owner-popup/producer.ts --events-dir <dir> [--state-dir <dir>] [--port <port>]",
				"  Demo client:   node packages/tenantext/owner-popup/producer.ts --client [--port <port>] [--action choose|other|toggle|confirm|send|close] [--coordinator <addr>] [--row <label>] [--pick <optionId>] [--other <text>] [--listen]",
			].join("\n") + "\n",
		);
		return 0;
	}
	if (argv.includes("--client")) {
		return runDemoClient(argv);
	}

	let port = DEFAULT_PRODUCER_PORT;
	let demoFixture: string | undefined;
	let parentAddr = "t11y";
	let parentName: string | undefined;
	let printOnly = false;
	let eventsDir: string | undefined;
	let stateDir: string | undefined;
	let noDecider = false;
	let noWriter = false;
	let deciderUrl: string | undefined;
	let lockFile: string | undefined;

	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--port" && argv[i + 1]) port = Number(argv[++i]);
		else if (arg === "--demo" && argv[i + 1]) demoFixture = argv[++i];
		else if (arg === "--parent" && argv[i + 1]) parentAddr = argv[++i];
		else if (arg === "--name" && argv[i + 1]) parentName = argv[++i];
		else if (arg === "--print") printOnly = true;
		else if (arg === "--events-dir" && argv[i + 1]) eventsDir = argv[++i];
		else if (arg === "--state-dir" && argv[i + 1]) stateDir = argv[++i];
		else if (arg === "--no-decider") noDecider = true;
		else if (arg === "--no-writer") noWriter = true;
		else if (arg === "--decider-url" && argv[i + 1]) deciderUrl = argv[++i];
		else if (arg === "--lock-file" && argv[i + 1]) lockFile = argv[++i];
	}

	const resolvedState = stateDir && isAbsolute(stateDir) ? stateDir : defaultStateDir();
	if (!demoFixture) {
		eventsDir = eventsDir ?? join(resolvedState, "events");
	}

	// Single-instance lock: the bound loopback TCP socket on `127.0.0.1:<port>` is owned by the OS kernel
	// for the lifetime of the process. On EADDRINUSE, a daemon retries a few times over about 3 seconds
	// so it can take over when the previous daemon was shutting down, then exits 0 without touching event files.
	const producerOpts: ProducerOptions = {
		port,
		printOnly,
		demoMode: Boolean(demoFixture),
		eventsDir: demoFixture ? undefined : eventsDir,
		stateDir: resolvedState,
		pickLogPath: demoFixture ? undefined : join(resolvedState, "picks.jsonl"),
		decider: noDecider
			? false
			: { ...(deciderUrl ? { baseUrl: deciderUrl } : {}), ...(lockFile ? { lockFile } : {}) },
		writer: noWriter ? false : {},
		onIdleShutdown: () => {
			process.exit(0);
		},
	};
	const bindRetryDelaysMs = demoFixture ? [] : [100, 200, 300, 500, 700, 1200];
	let producer: ProducerHandle | null = null;
	for (let attempt = 0; attempt <= bindRetryDelaysMs.length; attempt += 1) {
		try {
			producer = await createProducer(producerOpts);
			break;
		} catch (err) {
			if (!demoFixture && (err as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
				if (attempt < bindRetryDelaysMs.length) {
					await new Promise((done) => setTimeout(done, bindRetryDelaysMs[attempt]));
					continue;
				}
				return 0;
			}
			if (demoFixture) {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(`owner-popup demo: failed to bind 127.0.0.1:${port} (${msg})\n`);
				return 1;
			}
			throw err;
		}
	}
	if (!producer) return 0;

	if (demoFixture) {
		const reportText = readFileSync(demoFixture, "utf8");
		const res = await producer.addReport({
			address: parentAddr,
			name: parentName ?? "tenant-pi-coordinator-9",
			reportText,
			skipRoleCheck: true,
		});
		if (!res.accepted) {
			process.stderr.write(`owner-popup demo: fixture not eligible (${res.reason})\n`);
			await producer.close();
			return 2;
		}
		process.stderr.write(`owner-popup demo listening on ws://127.0.0.1:${producer.port}${DEFAULT_PRODUCER_PATH}\n`);
	}

	const shutdown = async () => {
		await producer.close();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());

	await new Promise(() => {});
	return 0;
}

function isDirectEntry(): boolean {
	if (!process.argv[1]) return false;
	const self = fileURLToPath(import.meta.url);
	try {
		return realpathSync(self) === realpathSync(process.argv[1]);
	} catch {
		return resolve(self) === resolve(process.argv[1]);
	}
}

if (isDirectEntry()) {
	main(process.argv.slice(2)).then((code) => {
		process.exitCode = code;
	});
}
