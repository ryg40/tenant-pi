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
	effectiveAnswer,
	formatSendLine,
	isRowConfirmed,
	renderedButtonSpecs,
	resolveFocused,
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
	isValidReceiptAddress,
	RECEIPT_MAX_AGE_MS,
	removeReceipt,
	removeReceiptsForAddress,
	sha256Hex,
	sweepExpiredReceipts,
	writeReceipt,
	type CreatedReceipt,
} from "./receipt.ts";
import { extractOwnerRows, FIXED_DECISION_OPTIONS, isRiskyByWords, makeOptions } from "./rows.ts";
import { runWriter, type WriterConfig } from "./suggest.ts";
import { createLocalWsServer, type LocalWsClient, type LocalWsServer } from "./ws.ts";

/**
 * Local A2UI producer for the owner-task rail.
 * Listens on 127.0.0.1 (default port 18766, path /a2ui), owns surface state and focus,
 * fills split/decider/writer updates in series, validates every client action completely
 * against rendered buttons and report revisions before mutating state, and delivers one
 * `[Owner popup]` line per coordinator via `hc get` + `hc send` with a single-use receipt.
 * A coordinator has cards only between its Stop event and its next turn-start event: then it sits at its prompt,
 * so a press sends at once, whatever status `hc get` reports.
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
 * above that hold, so a normal hold does not end as an unknown result.
 */
export const HC_SEND_TIMEOUT_MS = 75_000;
// Event file name forms (shared between owner-popup-hook.mjs and producer.ts):
// - Stop event: `stop-<16-digit ms>-<8 lowercase hex>.json`
// - Turn-start event: `turn-start-<address>.json` (address uses only `[A-Za-z0-9._-]`, never starts with `-`, not `.` or `..`)
// - Taken event (reader-owned, never written by the hook): `reading-<pid>-<12 lowercase hex>.json`
const FINISHED_EVENT_RE = /^(?:stop-[0-9]{16}-[0-9a-f]{8}|turn-start-(?!\.{1,2}\.json$)[A-Za-z0-9._][A-Za-z0-9._-]*)\.json$/;
const TAKEN_EVENT_RE = /^reading-[0-9]+-[0-9a-f]{12}\.json$/;
const ALLOWED_ACTION_KEYS = new Set(["name", "surfaceId", "sourceComponentId", "timestamp", "context", "userMessage"]);
const ALLOWED_CONTEXT_KEYS = new Set([
	"focusedCoordinator",
	"focusedLabel",
	"focusedRevision",
	"focusedPick",
	"focusedOther",
	"targetCoordinator",
	"targetLabel",
	"targetRevision",
]);
const TARGET_LITERAL_KEYS = ["targetCoordinator", "targetLabel", "targetRevision"] as const;

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
}

export interface HcClient {
	get(address: string): Promise<TerminalRecord | null>;
	/** An abort of `signal` ends the client process; a client that ends during the draft hold types nothing. */
	send(address: string, text: string, signal?: AbortSignal): Promise<HcSendResult>;
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

/** A send whose `hc send` gave no result: a later press of the same cards sends this same line again. */
interface UnknownSend {
	/** Generation of the address at the first try; a new report, a turn-start or a Close bumps it. */
	gen: number;
	/** The line of the first try with its receipt suffix. */
	wireLine: string;
	/** A frozen copy of the cards at the first try, for the pick log; later edits of the cards do not change it. */
	group: CoordinatorGroup;
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

/** Run `hc get <address> --json` and `hc send` (never `--force` or `--if`, minimal child environment). */
export function createHcClient(hcBin = "hc", env: NodeJS.ProcessEnv = process.env): HcClient {
	return {
		get(address: string): Promise<TerminalRecord | null> {
			if (!isValidReceiptAddress(address)) return Promise.resolve(null);
			const childEnv = buildHcEnv(env);
			return new Promise((resolveDone) => {
				execFile(hcBin, ["get", address, "--json"], { timeout: 10_000, env: childEnv }, (error, stdout) => {
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
		send(address: string, text: string, signal?: AbortSignal): Promise<HcSendResult> {
			if (!isValidReceiptAddress(address)) return Promise.resolve({ ok: false, code: 2, detail: "invalid address" });
			if (signal?.aborted) return Promise.resolve({ ok: false, code: 1, aborted: true, detail: "aborted" });
			// No `--if`: a coordinator at its prompt reports `idle`, `done`, or `working` while it holds background
			// waits, and `--if idle` refuses `done` and `working`. The hook events decide that it sits at its prompt.
			const args = ["send", address, text];
			const childEnv = buildHcEnv(env);
			return new Promise((resolveDone) => {
				execFile(hcBin, args, { timeout: HC_SEND_TIMEOUT_MS, env: childEnv, signal }, (error, stdout, stderr) => {
					if (!error) {
						resolveDone({ ok: true, code: 0, detail: stdout.trim() });
						return;
					}
					if (signal?.aborted) {
						resolveDone({ ok: false, code: 1, aborted: true, detail: "aborted" });
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
					});
				});
			});
		},
	};
}

/** Write one privacy-safe JSON line to the pick log (mode 0600, no report or answer text). */
function recordPickLog(pickLogPath: string | undefined, group: CoordinatorGroup): void {
	if (!pickLogPath) return;
	const entry = {
		at: new Date().toISOString(),
		count: group.rows.length,
		rows: group.rows.map((item) => {
			const confirmed = isRowConfirmed(item);
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
	/** For each address, the send whose `hc send` gave no result; memory only, one per address. */
	const unknownSends = new Map<string, UnknownSend>();
	/** For each address, the abort handle of the `hc send` in flight; a new Stop report of the address aborts it. */
	const sendAborts = new Map<string, AbortController>();
	/** For each known coordinator address, the count of client actions that named it, raised at arrival. */
	const actionArrivals = new Map<string, number>();
	const pendingJobs = new Set<Promise<unknown>>();
	const pendingActionsByClient = new Map<number, number>();
	let nextRevision = 0;
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
		`Answers for ${address} not sent: an action on its cards came after the send request. The cards stay; check them and press Send answers again.`;
	const sendingText = (address: string): string =>
		`Sending the answer to ${address} ... An unsent draft in that terminal can hold it for up to 60 seconds.`;
	const reuseMinutes = Math.floor((RECEIPT_MAX_AGE_MS - HC_SEND_TIMEOUT_MS) / 60_000);
	const unknownText = (address: string): string =>
		`Send status unknown for ${address}: hc send gave no result in ${HC_SEND_TIMEOUT_MS / 1000} seconds. The answer can still arrive; check the terminal. The cards stay. For ${reuseMinutes} minutes, a new press of Send answers sends the same answer with the same receipt, so ${address} accepts it only one time. After that, a press sends the answers that the cards show, with a new receipt.`;
	/** A refusal text; after an unknown send of the same cards, the unknown text stays in front of it. */
	const withUnknownNote = (address: string, gen: number, text: string): string =>
		unknownSends.get(address)?.gen === gen ? `${unknownText(address)} ${text}` : text;

	const touch = () => {
		lastActivityAt = Date.now();
	};

	const ensureGroupFocusValid = (group: CoordinatorGroup) => {
		const resolved = resolveFocused(group);
		group.focusedLabel = resolved ? resolved.row.label : null;
	};

	const broadcastSurfaceCreate = (group: CoordinatorGroup) => {
		ensureGroupFocusValid(group);
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
		ensureGroupFocusValid(group);
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

	const clearAddressCards = (address: string): number => {
		const gen = bumpGeneration(address);
		unknownSends.delete(address);
		const before = state.coordinators.length;
		state.coordinators = state.coordinators.filter((c) => c.address !== address);
		if (state.coordinators.length !== before) {
			broadcastSurfaceDelete(address);
		}
		return gen;
	};

	const sendFullToClient = (client: LocalWsClient) => {
		for (const group of state.coordinators) {
			if (group.rows.length === 0) continue;
			ensureGroupFocusValid(group);
			client.sendMessages(toCreateSurfaceMessages(group));
		}
	};

	/**
	 * Count one client action at its arrival, before it waits in the action queue: raise the arrival count of
	 * each known coordinator that it names (`focusedCoordinator`, `targetCoordinator`, or its `surfaceId`),
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
			const keys = ["focusedCoordinator", "targetCoordinator"];
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
				if (isKnown(address)) named.add(address);
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
	 * count of the address against the count of the press, and the terminal `live` in this lookup. Then one
	 * receipt, `hc send` (never `--force`), pick log, card removal. `inFlightSend` covers only the final step.
	 */
	async function deliverAnswers(
		destination: string,
		gen: number,
		baseLine: string | null,
		group: CoordinatorGroup,
		pressArrivals: number,
	): Promise<DeliveryOutcome> {
		const term = await hc.get(destination);
		await pollEventsNow();
		if (!isCurrentGen(destination, gen)) {
			return { handled: false, reason: "stale-after-get" };
		}
		const liveGroup = findGroup(destination) ?? group;
		if ((actionArrivals.get(destination) ?? 0) !== pressArrivals) {
			liveGroup.statusMessage = withUnknownNote(destination, gen, withdrawnText(destination));
			broadcastSurfaceUpdate(liveGroup);
			return { handled: false, reason: "press-withdrawn" };
		}
		if (term === null) {
			liveGroup.statusMessage = withUnknownNote(
				destination,
				gen,
				`Send refused: hc get found no terminal ${destination}. The cards stay; press Send answers again.`,
			);
			broadcastSurfaceUpdate(liveGroup);
			return { handled: false, reason: "hc-get-failed" };
		}
		if (term.state !== undefined && term.state !== "live") {
			liveGroup.statusMessage = withUnknownNote(destination, gen, `Send refused: the terminal ${destination} is gone (${term.state}).`);
			broadcastSurfaceUpdate(liveGroup);
			return { handled: false, reason: "terminal-gone" };
		}
		if (inFlightSend.has(destination)) {
			return { handled: false, reason: "send-in-flight" };
		}
		inFlightSend.add(destination);
		try {
			return await finishDelivery(destination, gen, baseLine, group, liveGroup);
		} finally {
			inFlightSend.delete(destination);
		}
	}

	async function finishDelivery(
		destination: string,
		gen: number,
		baseLine: string | null,
		pressGroup: CoordinatorGroup,
		liveGroup: CoordinatorGroup,
	): Promise<DeliveryOutcome> {
		// After an unknown result, a new press of the same cards sends the line of the first try with its receipt:
		// when both arrive, the receipt verifies one time, so the coordinator applies the answer once. A receipt
		// that can expire before the line arrives is removed instead, and the press is a new send with a new
		// receipt: a late first copy then cannot verify, so there is one answer.
		const retry = unknownSends.get(destination);
		let reuse: UnknownSend | undefined;
		if (retry && retry.gen === gen) {
			if (canReuseUnknownSend(retry)) {
				reuse = retry;
			} else {
				removeReceipt(retry.receiptPath);
				unknownSends.delete(destination);
				logEvent("receipt", destination, retry.group.reportDigest ?? sha256Hex(""), "removed-too-old-to-reuse");
			}
		}
		if (!reuse && !baseLine) {
			liveGroup.statusMessage = `The first try for ${destination} is too old to send again. Pick the answers and press Send answers.`;
			broadcastSurfaceUpdate(liveGroup);
			return { handled: false, reason: "no-confirmed-answers" };
		}
		const deliveryGroup: CoordinatorGroup = reuse ? reuse.group : structuredClone(pressGroup);
		const digest = deliveryGroup.reportDigest ?? sha256Hex("");
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
					baseLine: baseLine as string,
					reportDigest: digest,
				});
				receiptPath = receipt.path;
				receiptCreatedAtMs = Date.parse(receipt.record.createdAt);
				wireLine = appendReceiptSuffix(baseLine as string, receipt.id);
			} catch {
				logEvent("receipt", destination, digest, "write-failed");
				if (isCurrentGen(destination, gen)) {
					liveGroup.statusMessage = `Send failed for ${destination} (receipt write error). Try Send answers again.`;
					broadcastSurfaceUpdate(liveGroup);
				}
				return { handled: false, reason: "receipt-write-failed" };
			}
			logEvent("receipt", destination, digest, "written");
		}

		let result: HcSendResult;
		const abort = new AbortController();
		sendAborts.set(destination, abort);
		try {
			logEvent("send", destination, digest, reuse ? "retry" : "first");
			result = await hc.send(destination, wireLine, abort.signal);
		} catch {
			result = abort.signal.aborted
				? { ok: false, code: 1, aborted: true, detail: "aborted" }
				: { ok: false, code: 1, unknown: true, detail: "hc send threw" };
		} finally {
			if (sendAborts.get(destination) === abort) sendAborts.delete(destination);
		}

		if (!result.ok && (result.aborted || abort.signal.aborted)) {
			// A new report came during the send: the old line counts as not sent. The new report removed the receipts
			// of the address; the new cards get no status text from this send.
			removeReceipt(receiptPath);
			logEvent("delivery", destination, digest, "aborted-new-report");
			return { handled: false, reason: "hc-send-aborted" };
		}
		logEvent("delivery", destination, digest, result.ok ? "ok" : result.unknown ? "hc-send-unknown" : `hc-send-failed-${result.code}`);
		if (!result.ok) {
			if (result.unknown) {
				// Keep the receipt: a line that did arrive can still verify. A new press sends the same line.
				if (isCurrentGen(destination, gen)) {
					unknownSends.set(destination, { gen, wireLine, group: deliveryGroup, receiptPath, receiptCreatedAtMs });
					liveGroup.statusMessage = unknownText(destination);
					broadcastSurfaceUpdate(liveGroup);
				}
				return { handled: false, reason: "hc-send-unknown" };
			}
			// A definite refusal: remove the receipt, except the reused receipt of a first try that can still arrive.
			if (!reuse) removeReceipt(receiptPath);
			if (isCurrentGen(destination, gen)) {
				liveGroup.statusMessage = reuse
					? `Send failed for ${destination} (exit ${result.code}). The first try can still arrive; check the terminal. A new press of Send answers sends the same answer with the same receipt.`
					: `Send failed for ${destination} (exit ${result.code}). Try Send answers again.`;
				broadcastSurfaceUpdate(liveGroup);
			}
			return { handled: false, reason: "hc-send-failed" };
		}

		unknownSends.delete(destination);
		recordPickLog(pickLogPath, deliveryGroup);
		if (isCurrentGen(destination, gen)) {
			bumpGeneration(destination);
			state.coordinators = state.coordinators.filter((c) => c.address !== destination);
			broadcastSurfaceDelete(destination);
		}
		return { handled: true };
	}

	/**
	 * Validate a client action completely against rendered buttons, surface ID, report revisions, focus, and options
	 * BEFORE mutating any state.
	 */
	async function processAction(
		rawText: string,
		arrived: ReadonlyMap<string, number>,
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
		if (Object.keys(context).some((k) => !ALLOWED_CONTEXT_KEYS.has(k))) {
			return { handled: false, reason: "invalid-context-keys" };
		}
		if (
			(context.targetCoordinator !== undefined && context.targetCoordinator !== surfaceAddress) ||
			(context.focusedCoordinator !== undefined && context.focusedCoordinator !== surfaceAddress)
		) {
			return { handled: false, reason: "surface-coordinator-mismatch" };
		}

		// Match sourceComponentId, action name, and every bound literal (target + focused + revision) to a rendered Button.
		const buttons = renderedButtonSpecs(group);
		const button = buttons.get(action.sourceComponentId);
		if (!button) {
			return { handled: false, reason: "unknown-source-component" };
		}
		if (button.name !== action.name) {
			return { handled: false, reason: "action-mismatch" };
		}
		for (const [key, expected] of Object.entries(button.literals)) {
			if (context[key] !== expected) {
				return { handled: false, reason: `mismatch-${key}` };
			}
		}
		for (const targetKey of TARGET_LITERAL_KEYS) {
			if (!Object.hasOwn(button.literals, targetKey) && context[targetKey] !== undefined) {
				return { handled: false, reason: "unexpected-target" };
			}
		}

		// Purely validate focused card context values (no state mutation yet).
		ensureGroupFocusValid(group);
		const focusedAddr = button.literals.focusedCoordinator;
		const focusedLbl = button.literals.focusedLabel;
		const focusedRev = button.literals.focusedRevision;
		if (
			!focusedAddr ||
			!focusedLbl ||
			!focusedRev ||
			focusedAddr !== group.address ||
			group.focusedLabel !== focusedLbl
		) {
			return { handled: false, reason: "stale-focus" };
		}
		const focusedItem = group.rows.find((r) => r.row.label === focusedLbl);
		if (!focusedItem || group.revision !== focusedRev) {
			return { handled: false, reason: "stale-revision" };
		}

		let plannedPick = focusedItem.selectedOptionId;
		let plannedOther = focusedItem.customText;

		if (Object.hasOwn(context, "focusedPick") && context.focusedPick !== null && context.focusedPick !== undefined) {
			if (!button.bindsPick) return { handled: false, reason: "unrendered-pick" };
			if (!Array.isArray(context.focusedPick) || context.focusedPick.length > 1) {
				return { handled: false, reason: "invalid-pick" };
			}
			if (context.focusedPick.length === 0) {
				plannedPick = null;
			} else {
				const chosen = context.focusedPick[0];
				if (typeof chosen !== "string") return { handled: false, reason: "invalid-pick" };
				const valid =
					focusedItem.row.options.some((opt) => opt.id === chosen) ||
					focusedItem.row.candidates.some((opt) => opt.id === chosen);
				if (!valid) return { handled: false, reason: "unknown-option" };
				plannedPick = chosen;
			}
		}

		if (Object.hasOwn(context, "focusedOther") && context.focusedOther !== null && context.focusedOther !== undefined) {
			if (!button.bindsOther) return { handled: false, reason: "unrendered-other" };
			if (typeof context.focusedOther !== "string") return { handled: false, reason: "invalid-other" };
			plannedOther = context.focusedOther.slice(0, CUSTOM_TEXT_MAX);
		}

		const plannedConfirmed =
			focusedItem.row.risky &&
			(plannedPick !== focusedItem.selectedOptionId || plannedOther !== focusedItem.customText)
				? false
				: focusedItem.confirmed;

		const previewFocusedItem: RowViewState = {
			...focusedItem,
			selectedOptionId: plannedPick,
			customText: plannedOther,
			confirmed: plannedConfirmed,
		};

		const applyPlannedFocus = () => {
			focusedItem.selectedOptionId = plannedPick;
			focusedItem.customText = plannedOther;
			focusedItem.confirmed = plannedConfirmed;
		};

		// The status text of an unknown send stays until the cards end: it says what a new press sends.
		const keepStatus = unknownSends.has(group.address);

		// Action-specific preconditions before any mutation.
		switch (button.name) {
			case "focus": {
				const targetAddr = button.literals.targetCoordinator;
				const targetLbl = button.literals.targetLabel;
				const targetRev = button.literals.targetRevision;
				const targetItem =
					targetAddr === group.address && targetLbl ? group.rows.find((r) => r.row.label === targetLbl) : null;
				if (!targetItem || group.revision !== targetRev) {
					return { handled: false, reason: "unknown-row" };
				}
				applyPlannedFocus();
				group.focusedLabel = targetItem.row.label;
				if (!keepStatus) group.statusMessage = "";
				broadcastSurfaceUpdate(group);
				return { handled: true };
			}
			case "confirm": {
				const targetAddr = button.literals.targetCoordinator;
				const targetLbl = button.literals.targetLabel;
				const targetRev = button.literals.targetRevision;
				if (
					targetAddr !== focusedAddr ||
					targetLbl !== focusedLbl ||
					targetRev !== focusedRev ||
					!focusedItem.row.risky
				) {
					return { handled: false, reason: "not-focused-risky-row" };
				}
				if (!effectiveAnswer(previewFocusedItem)) {
					return { handled: false, reason: "no-answer-to-confirm" };
				}
				applyPlannedFocus();
				focusedItem.confirmed = true;
				if (!keepStatus) group.statusMessage = "";
				broadcastSurfaceUpdate(group);
				return { handled: true };
			}
			case "send": {
				const targetAddr = button.literals.targetCoordinator;
				const targetRev = button.literals.targetRevision;
				if (targetAddr !== group.address || group.revision !== targetRev || group.rows.length === 0) {
					return { handled: false, reason: "unknown-coordinator" };
				}
				if (inFlightSend.has(group.address)) {
					return { handled: false, reason: "send-in-flight" };
				}

				const previewGroup: CoordinatorGroup = {
					...group,
					rows: group.rows.map((item) => (item === focusedItem ? previewFocusedItem : item)),
				};
				const destination = group.address;
				const gen = generations.get(destination) ?? 0;
				// A valid retry of an unknown send goes to its saved line, whatever the cards show now.
				const retry = unknownSends.get(destination);
				const retryReady = !printOnly && retry !== undefined && retry.gen === gen && canReuseUnknownSend(retry);
				const baseLine = formatSendLine(previewGroup);
				if (!baseLine && !retryReady) {
					return { handled: false, reason: "no-confirmed-answers" };
				}

				// All validation passed; now apply the focused card changes.
				applyPlannedFocus();

				if (printOnly && baseLine) {
					onPrint(baseLine);
					recordPickLog(pickLogPath, group);
					bumpGeneration(destination);
					state.coordinators = state.coordinators.filter((c) => c.address !== destination);
					broadcastSurfaceDelete(destination);
					return { handled: true };
				}

				// Show the accepted press at once: `hc send` can wait for an unsent draft in the terminal.
				group.statusMessage = sendingText(destination);
				broadcastSurfaceUpdate(group);
				const pressArrivals = arrived.get(destination) ?? actionArrivals.get(destination) ?? 0;
				return deliverAnswers(destination, gen, baseLine, group, pressArrivals);
			}
			case "close": {
				const targetAddr = button.literals.targetCoordinator;
				const targetRev = button.literals.targetRevision;
				if (targetAddr !== group.address || group.revision !== targetRev) {
					return { handled: false, reason: "unknown-coordinator" };
				}
				applyPlannedFocus();
				recordPickLog(pickLogPath, group);
				bumpGeneration(group.address);
				unknownSends.delete(group.address);
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
				item.row = applyDeciderScore(item.row, score, thresholds);
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
		removeReceiptsForAddress(receiptStateDir, input.address);
		logEvent("receipts-removed", input.address, sha256Hex(input.reportText), "new-report");
		// A new report means a new prompt: a held send of the old line must not reach it. A turn-start does not abort,
		// because the delivered line itself starts a turn.
		sendAborts.get(input.address)?.abort();
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
		const rows: RowViewState[] = rowsWithCard.map((row) => ({
			row,
			selectedOptionId: null,
			customText: "",
			confirmed: false,
		}));
		const nextGroup: CoordinatorGroup = {
			address: input.address,
			revision,
			reportDigest,
			...(coordName ? { name: coordName } : {}),
			excerpt: extracted.excerpt,
			rows,
			focusedLabel: rows[0].row.label,
			deciderStatus: options.decider === false ? "no decider" : "decider ...",
			statusMessage: "",
		};

		state.coordinators.push(nextGroup);
		broadcastSurfaceCreate(nextGroup);

		void trackJob(fillCoordinatorAsync(input.address, gen));
		return { accepted: true };
	}

	function handleTurnStart(address: string, eventTimeMs?: number): void {
		touch();
		if (!isValidReceiptAddress(address)) return;
		const lastTime = lastEventTimes.get(address);
		if (eventTimeMs !== undefined && lastTime !== undefined && eventTimeMs < lastTime) {
			return;
		}
		lastEventTimes.set(address, eventTimeMs ?? performance.timeOrigin + performance.now());
		clearAddressCards(address);
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
			const job = actionQueue.then(() => processAction(text, arrived)).finally(() => {
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

	if (idleShutdownMs > 0) {
		idleTimer = setInterval(() => {
			if (closed) return;
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
				if (pick !== undefined && Object.hasOwn(matched.context, "focusedPick")) {
					context.focusedPick = pick === "" ? [] : [pick];
				}
				if (other !== undefined && Object.hasOwn(matched.context, "focusedOther")) {
					context.focusedOther = other;
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
				"  Demo client:   node packages/tenantext/owner-popup/producer.ts --client [--port <port>] [--action focus|confirm|send|close] [--coordinator <addr>] [--row <label>] [--pick <optionId>] [--other <text>] [--listen]",
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
