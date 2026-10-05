// Non-executing pending queue/composer with a strict JSON codec.
// Pure: no I/O, no clock, no randomness, no dispatch. Queued text is inert data.

import { createHash } from "node:crypto";

export type PendingItem = {
  id: string;
  requestId: string;
  text: string;
  source?: { documentRevision: number; startLine: number; endLine: number };
  /** Short lowercase provenance tag shown as a card badge (`web` for browser-inbox thoughts). Display metadata only. */
  origin?: string;
};

export type PendingQueue = {
  version: 1;
  revision: number;
  composer: string;
  items: readonly PendingItem[];
};

type SourceMeta = NonNullable<PendingItem["source"]>;
type Action = "enqueue" | "composer";
type Receipt = { requestId: string; action: Action; digest: string };
/** Immutable, single-item deletion token used by the view's one-level in-memory undo. */
export type RemovedItem = Readonly<{
  index: number;
  item: PendingItem;
  receipt: Readonly<{ requestId: string; action: "enqueue"; digest: string }>;
}>;
/** Internal shape: the sole permitted extension to the displayed queue. */
type StoredQueue = PendingQueue & { receipts: readonly Receipt[] };

const MAX_SNAPSHOT_BYTES = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES = 256 * 1024;
const MAX_ITEMS = 1000;
const MAX_REQUEST_ID_BYTES = 256;

class QueueValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueValidationError";
  }
}
class QueueRequestMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueRequestMismatchError";
  }
}
class QueueConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueueConflictError";
  }
}

// Messages below are fixed strings: never interpolate queued text, composer
// text, source metadata or request IDs into an error.
function fail(message: string): never {
  throw new QueueValidationError(message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`unknown field in ${label}`);
  }
}

function isNonNegativeSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function checkRequestId(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) fail("requestId must be a nonempty string");
  if (Buffer.byteLength(value, "utf8") > MAX_REQUEST_ID_BYTES) fail("requestId exceeds its byte bound");
  return value;
}

/** Item text must be nonempty; composer text may be empty. Never normalized. */
function checkText(value: unknown, action: Action): string {
  if (typeof value !== "string") fail("text must be a string");
  if (action === "enqueue" && value.length === 0) fail("queued text must not be zero-byte");
  if (Buffer.byteLength(value, "utf8") > MAX_ENTRY_BYTES) fail("text exceeds the 256 KiB entry bound");
  return value;
}

const ORIGIN_RULE = /^[a-z][a-z0-9-]{0,15}$/;

function checkOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ORIGIN_RULE.test(value)) fail("origin must be a short lowercase tag");
  return value;
}

function checkSource(value: unknown): SourceMeta | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) fail("source metadata must be an object");
  assertKeys(value, ["documentRevision", "startLine", "endLine"], "source metadata");
  const { documentRevision, startLine, endLine } = value;
  if (!isNonNegativeSafeInt(documentRevision)) fail("documentRevision must be a nonnegative safe integer");
  if (!isPositiveSafeInt(startLine) || !isPositiveSafeInt(endLine)) fail("source line numbers must be positive safe integers");
  if (startLine > endLine) fail("source range is reversed");
  return Object.freeze({ documentRevision, startLine, endLine });
}

function sourceKey(source: SourceMeta | undefined): string {
  return source === undefined ? "-" : `${source.documentRevision}:${source.startLine}:${source.endLine}`;
}

/** Length-prefixed digest so no field boundary can be forged from content. */
function digestParts(...parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(`${Buffer.byteLength(part, "utf8")}:`);
    hash.update(part, "utf8");
    hash.update("\0");
  }
  return hash.digest("hex");
}

function itemIdOf(requestId: string, text: string, source: SourceMeta | undefined): string {
  return digestParts("item", requestId, sourceKey(source), text).slice(0, 32);
}

/** Binds a request ID to action, expectedRevision, exact text and source. */
function bindDigest(
  action: Action,
  requestId: string,
  expectedRevision: number,
  text: string,
  source: SourceMeta | undefined,
): string {
  return digestParts("bind", action, requestId, String(expectedRevision), sourceKey(source), text);
}

function freezeItem(item: PendingItem): PendingItem {
  const copy: PendingItem = { id: item.id, requestId: item.requestId, text: item.text };
  if (item.source !== undefined) copy.source = Object.freeze({ ...item.source });
  if (item.origin !== undefined) copy.origin = item.origin;
  return Object.freeze(copy);
}

function makeQueue(
  revision: number,
  composer: string,
  items: readonly PendingItem[],
  receipts: readonly Receipt[],
): StoredQueue {
  // Central construction guard: every effective operation increments through
  // this seam, so a maximum codec-valid revision is refused atomically.
  if (!isNonNegativeSafeInt(revision)) fail("revision must be a nonnegative safe integer");
  return Object.freeze({
    version: 1 as const,
    revision,
    composer,
    items: Object.freeze(items.slice()),
    receipts: Object.freeze(receipts.slice()),
  });
}

/** Canonical field order: serialize(parse(s)) === s for any canonical s. */
function canonicalize(queue: StoredQueue): string {
  return JSON.stringify({
    version: 1,
    revision: queue.revision,
    composer: queue.composer,
    items: queue.items.map((item) => {
      const out: Record<string, unknown> = { id: item.id, requestId: item.requestId, text: item.text };
      if (item.source !== undefined) {
        out.source = {
          documentRevision: item.source.documentRevision,
          startLine: item.source.startLine,
          endLine: item.source.endLine,
        };
      }
      if (item.origin !== undefined) out.origin = item.origin;
      return out;
    }),
    receipts: queue.receipts.map((r) => ({ requestId: r.requestId, action: r.action, digest: r.digest })),
  });
}

function enforceSnapshotBytes(queue: StoredQueue): void {
  if (Buffer.byteLength(canonicalize(queue), "utf8") > MAX_SNAPSHOT_BYTES) {
    fail("serialized queue exceeds the 2 MiB snapshot bound");
  }
}

/**
 * Full runtime validation of an untrusted queue value: TypeScript types are not
 * trusted. Returns a frozen, copy-isolated snapshot. Never falls back to empty.
 */
function normalizeQueue(value: unknown): StoredQueue {
  if (!isPlainObject(value)) fail("queue must be an object");
  assertKeys(value, ["version", "revision", "composer", "items", "receipts"], "queue");
  if (value.version !== 1) fail("unsupported queue version");
  if (!isNonNegativeSafeInt(value.revision)) fail("revision must be a nonnegative safe integer");
  const composer = checkText(value.composer, "composer");
  if (!Array.isArray(value.items)) fail("items must be an array");
  if (value.items.length > MAX_ITEMS) fail("queue exceeds the 1000 item bound");
  if (!Array.isArray(value.receipts)) fail("receipts must be an array");

  const items: PendingItem[] = [];
  const itemIds = new Set<string>();
  const itemRequestIds = new Set<string>();
  for (const raw of value.items) {
    if (!isPlainObject(raw)) fail("item must be an object");
    assertKeys(raw, ["id", "requestId", "text", "source", "origin"], "item");
    const requestId = checkRequestId(raw.requestId);
    const text = checkText(raw.text, "enqueue");
    const source = checkSource(raw.source);
    const origin = checkOrigin(raw.origin);
    if (typeof raw.id !== "string" || raw.id !== itemIdOf(requestId, text, source)) {
      fail("item id does not match its payload");
    }
    if (itemIds.has(raw.id)) fail("duplicate item id");
    if (itemRequestIds.has(requestId)) fail("duplicate item requestId");
    itemIds.add(raw.id);
    itemRequestIds.add(requestId);
    items.push(freezeItem({ id: raw.id, requestId, text, ...(source === undefined ? {} : { source }), ...(origin === undefined ? {} : { origin }) }));
  }

  const receipts: Receipt[] = [];
  const receiptIds = new Set<string>();
  const enqueueReceiptIds = new Set<string>();
  for (const raw of value.receipts) {
    if (!isPlainObject(raw)) fail("receipt must be an object");
    assertKeys(raw, ["requestId", "action", "digest"], "receipt");
    const requestId = checkRequestId(raw.requestId);
    if (raw.action !== "enqueue" && raw.action !== "composer") fail("receipt action is unknown");
    if (typeof raw.digest !== "string" || !/^[0-9a-f]{64}$/.test(raw.digest)) fail("receipt digest is malformed");
    if (receiptIds.has(requestId)) fail("duplicate receipt requestId");
    receiptIds.add(requestId);
    if (raw.action === "enqueue") enqueueReceiptIds.add(requestId);
    receipts.push(Object.freeze({ requestId, action: raw.action, digest: raw.digest }));
  }

  // Available receipt/item data must agree: one enqueue receipt per item.
  if (enqueueReceiptIds.size !== itemRequestIds.size) fail("receipt and item data are inconsistent");
  for (const requestId of itemRequestIds) {
    if (!enqueueReceiptIds.has(requestId)) fail("receipt and item data are inconsistent");
  }

  const queue = makeQueue(value.revision, composer, items, receipts);
  enforceSnapshotBytes(queue);
  return queue;
}

function applyOperation(queue: PendingQueue, input: unknown, action: Action): PendingQueue {
  const base = normalizeQueue(queue);
  if (!isPlainObject(input)) fail("operation input must be an object");
  assertKeys(
    input,
    action === "enqueue" ? ["expectedRevision", "requestId", "text", "source", "origin"] : ["expectedRevision", "requestId", "text"],
    "operation input",
  );
  if (!isNonNegativeSafeInt(input.expectedRevision)) fail("expectedRevision must be a nonnegative safe integer");
  const expectedRevision = input.expectedRevision;
  const requestId = checkRequestId(input.requestId);
  const text = checkText(input.text, action);
  const source = action === "enqueue" ? checkSource(input.source) : undefined;
  const origin = action === "enqueue" ? checkOrigin(input.origin) : undefined;
  const digest = bindDigest(action, requestId, expectedRevision, text, source);

  // A known receipt is checked before stale-revision rejection.
  const prior = base.receipts.find((receipt) => receipt.requestId === requestId);
  if (prior !== undefined) {
    if (prior.action !== action || prior.digest !== digest) {
      throw new QueueRequestMismatchError("requestId is already bound to different input");
    }
    return base; // Idempotent no-op: keeps the supplied queue's newer state.
  }
  if (expectedRevision !== base.revision) {
    throw new QueueConflictError("expectedRevision is stale for this queue");
  }

  const receipts = [...base.receipts, Object.freeze({ requestId, action, digest })];
  let next: StoredQueue;
  if (action === "enqueue") {
    if (base.items.length >= MAX_ITEMS) fail("queue exceeds the 1000 item bound");
    const item = freezeItem({ id: itemIdOf(requestId, text, source), requestId, text, ...(source === undefined ? {} : { source }), ...(origin === undefined ? {} : { origin }) });
    if (base.items.some((existing) => existing.id === item.id)) fail("duplicate item id");
    next = makeQueue(base.revision + 1, base.composer, [...base.items, item], receipts);
  } else {
    next = makeQueue(base.revision + 1, text, base.items, receipts);
  }
  enforceSnapshotBytes(next); // Reject whole operation; never trim or evict.
  return next;
}

export function emptyQueue(): PendingQueue {
  return makeQueue(0, "", [], []);
}

export function enqueue(
  queue: PendingQueue,
  input: {
    expectedRevision: number;
    requestId: string;
    text: string;
    source?: { documentRevision: number; startLine: number; endLine: number };
    origin?: string;
  },
): PendingQueue {
  return applyOperation(queue, input, "enqueue");
}

export function setComposer(
  queue: PendingQueue,
  input: { expectedRevision: number; requestId: string; text: string },
): PendingQueue {
  return applyOperation(queue, input, "composer");
}

/**
 * Clear all queued items, preserving the composer buffer.
 *
 * Keeps composer receipts (they do not affect item consistency), drops all
 * enqueue receipts, bumps revision by one. Idempotent: clearing an already
 * empty queue returns the validated input unchanged (no revision bump) so
 * repeated Clear Queue presses do not churn the revision counter.
 */
export function clearQueue(queue: PendingQueue): PendingQueue {
  const base = normalizeQueue(queue);
  if (base.items.length === 0) return base;
  const composerReceipts = base.receipts.filter((r) => r.action === "composer");
  const next = makeQueue(base.revision + 1, base.composer, [], composerReceipts);
  enforceSnapshotBytes(next);
  return next;
}

/**
 * Remove one queued item by id, preserving the composer buffer and every
 * receipt that is not that item's enqueue receipt. Unknown id: returns the
 * validated input unchanged (no revision bump). Otherwise bumps revision by
 * one, like clearQueue.
 */
export function removeItem(queue: PendingQueue, itemId: string): PendingQueue {
  return removeItemWithUndo(queue, itemId).queue;
}

/** Move one item by one position. Unknown ids and boundaries are revision-preserving no-ops. */
export function moveItem(queue: PendingQueue, itemId: string, delta: -1 | 1): PendingQueue {
  const base = normalizeQueue(queue);
  if (delta !== -1 && delta !== 1) fail("move delta must be -1 or 1");
  const index = typeof itemId === "string" ? base.items.findIndex((item) => item.id === itemId) : -1;
  const destination = index + delta;
  if (index < 0 || destination < 0 || destination >= base.items.length) return base;
  const items = [...base.items];
  const [item] = items.splice(index, 1);
  items.splice(destination, 0, item as PendingItem);
  const next = makeQueue(base.revision + 1, base.composer, items, base.receipts);
  enforceSnapshotBytes(next);
  return next;
}

/** Duplicate an item immediately after itself with a caller-supplied fresh request identity. */
export function duplicateItem(queue: PendingQueue, itemId: string, requestId: string): PendingQueue {
  const base = normalizeQueue(queue);
  const index = typeof itemId === "string" ? base.items.findIndex((item) => item.id === itemId) : -1;
  if (index < 0) return base;
  const freshRequestId = checkRequestId(requestId);
  if (base.receipts.some((receipt) => receipt.requestId === freshRequestId)) {
    throw new QueueConflictError("requestId is already present in this queue");
  }
  if (base.items.length >= MAX_ITEMS) fail("queue exceeds the 1000 item bound");
  const source = base.items[index] as PendingItem;
  const copy = freezeItem({
    id: itemIdOf(freshRequestId, source.text, source.source),
    requestId: freshRequestId,
    text: source.text,
    ...(source.source === undefined ? {} : { source: source.source }),
    ...(source.origin === undefined ? {} : { origin: source.origin }),
  });
  if (base.items.some((item) => item.id === copy.id)) throw new QueueConflictError("item identity is already present in this queue");
  const receipt = Object.freeze({
    requestId: freshRequestId,
    action: "enqueue" as const,
    digest: bindDigest("enqueue", freshRequestId, base.revision, copy.text, copy.source),
  });
  const items = [...base.items.slice(0, index + 1), copy, ...base.items.slice(index + 1)];
  const next = makeQueue(base.revision + 1, base.composer, items, [...base.receipts, receipt]);
  enforceSnapshotBytes(next);
  return next;
}

/** Remove one item and return the exact bounded token needed to restore just that item. */
export function removeItemWithUndo(
  queue: PendingQueue,
  itemId: string,
): { queue: PendingQueue; undo?: RemovedItem } {
  const base = normalizeQueue(queue);
  const index = typeof itemId === "string" ? base.items.findIndex((item) => item.id === itemId) : -1;
  if (index < 0) return { queue: base };
  const item = base.items[index] as PendingItem;
  const receipt = base.receipts.find((entry) => entry.action === "enqueue" && entry.requestId === item.requestId);
  if (receipt === undefined) fail("receipt and item data are inconsistent");
  const undo: RemovedItem = Object.freeze({
    index,
    item: freezeItem(item),
    receipt: Object.freeze({ requestId: receipt.requestId, action: "enqueue", digest: receipt.digest }),
  });
  const items = base.items.filter((entry) => entry.id !== item.id);
  const receipts = base.receipts.filter((entry) => entry !== receipt);
  const next = makeQueue(base.revision + 1, base.composer, items, receipts);
  enforceSnapshotBytes(next);
  return { queue: next, undo };
}

function normalizeRemovedItem(value: unknown): RemovedItem {
  if (!isPlainObject(value)) fail("removed item must be an object");
  assertKeys(value, ["index", "item", "receipt"], "removed item");
  if (!isNonNegativeSafeInt(value.index)) fail("removed item index must be a nonnegative safe integer");
  if (!isPlainObject(value.item)) fail("removed item payload must be an object");
  assertKeys(value.item, ["id", "requestId", "text", "source", "origin"], "removed item payload");
  const requestId = checkRequestId(value.item.requestId);
  const text = checkText(value.item.text, "enqueue");
  const source = checkSource(value.item.source);
  const origin = checkOrigin(value.item.origin);
  if (typeof value.item.id !== "string" || value.item.id !== itemIdOf(requestId, text, source)) {
    fail("removed item id does not match its payload");
  }
  if (!isPlainObject(value.receipt)) fail("removed item receipt must be an object");
  assertKeys(value.receipt, ["requestId", "action", "digest"], "removed item receipt");
  if (checkRequestId(value.receipt.requestId) !== requestId || value.receipt.action !== "enqueue") {
    fail("removed item receipt does not match its payload");
  }
  if (typeof value.receipt.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.receipt.digest)) {
    fail("removed item receipt digest is malformed");
  }
  return Object.freeze({
    index: value.index,
    item: freezeItem({ id: value.item.id, requestId, text, ...(source === undefined ? {} : { source }), ...(origin === undefined ? {} : { origin }) }),
    receipt: Object.freeze({ requestId, action: "enqueue", digest: value.receipt.digest }),
  });
}

/** Restore one deletion into the current queue without rolling back intervening changes. */
export function restoreItem(queue: PendingQueue, removed: RemovedItem): PendingQueue {
  const base = normalizeQueue(queue);
  const undo = normalizeRemovedItem(removed);
  if (base.items.length >= MAX_ITEMS) fail("queue exceeds the 1000 item bound");
  if (base.items.some((item) => item.id === undo.item.id)) throw new QueueConflictError("item identity is already present in this queue");
  if (base.receipts.some((receipt) => receipt.requestId === undo.item.requestId)) {
    throw new QueueConflictError("requestId is already present in this queue");
  }
  const index = Math.min(undo.index, base.items.length);
  const items = [...base.items.slice(0, index), freezeItem(undo.item), ...base.items.slice(index)];
  const next = makeQueue(base.revision + 1, base.composer, items, [...base.receipts, Object.freeze({ ...undo.receipt })]);
  enforceSnapshotBytes(next);
  return normalizeQueue(next);
}

export function serializeQueue(queue: PendingQueue): string {
  const normalized = normalizeQueue(queue);
  const serialized = canonicalize(normalized);
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    fail("serialized queue exceeds the 2 MiB snapshot bound");
  }
  return serialized;
}

export function parseQueue(serialized: string): PendingQueue {
  if (typeof serialized !== "string") fail("serialized queue must be a string");
  if (Buffer.byteLength(serialized, "utf8") > MAX_SNAPSHOT_BYTES) {
    fail("serialized queue exceeds the 2 MiB snapshot bound");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch {
    fail("serialized queue is not valid JSON");
  }
  return normalizeQueue(decoded);
}
