// The shadow record of the chain: one JSON line for each run, or for a hook input that started no run.
// This module imports nothing from `packages/openviking-pi`, so the hook can write a line without the
// vendored helpers. No code of the chain removes a record file: a removal needs the owner's word.
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";
import { STATE_PARTS, stateBase } from "./switch.mjs";

function utcDate(ms) {
	return new Date(ms).toISOString().slice(0, 10);
}

/** A folder that is a real folder, not a symbolic link. Creates it with mode 0700 when it is missing. */
function realFolder(path, { create }) {
	let info = null;
	try { info = lstatSync(path); } catch (error) { if (error?.code !== "ENOENT") throw error; }
	if (!info && create) {
		mkdirSync(path, { mode: 0o700 });
		info = lstatSync(path);
	}
	if (!info || info.isSymbolicLink() || !info.isDirectory()) throw new Error("record folder refused");
}

const DIR_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
// O_NONBLOCK: a FIFO at the record path gives an error at once instead of a hang.
const FILE_FLAGS = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/** Set the mode through a descriptor that does not follow a link. Never a chmod of a path. */
function withDescriptor(path, flags, mode, job) {
	const fd = openSync(path, flags, mode);
	try { return job(fd); } finally { closeSync(fd); }
}

/**
 * Append one record line: folder 0700, file 0600. It removes no file.
 * The record holds times, kinds, reasons, store names, counts, opaque identifiers, scores and lengths only.
 * A symbolic link at the record folder, at a folder that the chain creates, or at the day file is
 * refused: the call throws and writes nothing.
 */
export function writeShadowRecord(record, { env = process.env, now = Date.now() } = {}) {
	const base = stateBase(env);
	if (!existsSync(base)) mkdirSync(base, { recursive: true, mode: 0o700 });
	let dir = base;
	for (const part of STATE_PARTS) {
		dir = join(dir, part);
		realFolder(dir, { create: true });
	}
	withDescriptor(dir, DIR_FLAGS, undefined, (fd) => fchmodSync(fd, 0o700));
	const file = join(dir, `shadow-${utcDate(now)}.jsonl`);
	const line = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
	withDescriptor(file, FILE_FLAGS, 0o600, (fd) => {
		if (!fstatSync(fd).isFile()) throw new Error("record file refused");
		fchmodSync(fd, 0o600);
		// One write call for the whole line, so two sessions never mix their lines.
		if (writeSync(fd, line, 0, line.length) !== line.length) throw new Error("record line cut");
	});
	return file;
}

/** The fixed reasons of a `skipped` line. A line takes no other string. */
export const SKIP_REASONS = Object.freeze({ inputOverCap: "input over cap" });

/** The record of a hook input that started no run: the time, the harness, the kind and a fixed reason. */
export function skipRecord(harness, reason, now) {
	if (!Object.values(SKIP_REASONS).includes(reason)) throw new Error("unknown skip reason");
	return { v: 1, at: new Date(now).toISOString(), harness, kind: "skipped", reason };
}
