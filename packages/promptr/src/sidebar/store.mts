import { randomUUID } from "node:crypto";
import type { PendingQueue } from "../queue/pending.mts";
import { emptyQueue, enqueue, parseQueue, removeItem, serializeQueue } from "../queue/pending.mts";
import { atomicWrite, projectPaths, readText, type ProjectPaths } from "../state/paths.mts";

export interface SidebarData {
  queue: PendingQueue;
  composer: string;
  note: string;
  error: string;
}

/** Read-only until an explicit action. Never persist a fallback notebook. */
export class SidebarStore {
  readonly paths: ProjectPaths;
  constructor(cwd: string) { this.paths = projectPaths(cwd); }

  read(): SidebarData {
    const raw = readText(this.paths.queue);
    let queue = emptyQueue();
    let error = "";
    try { if (raw !== undefined) queue = parseQueue(raw); }
    catch { error = "Queue unreadable; writes blocked. Recover queue.json first."; }
    return { queue, composer: readText(this.paths.composer) ?? queue.composer,
      note: readText(this.paths.scratch) ?? "", error };
  }

  saveText(kind: "composer" | "note", expected: string, text: string): void {
    if (Buffer.byteLength(text, "utf8") > 256 * 1024) throw new Error("Text exceeds 256 KiB. Nothing saved.");
    // Preserve the existing notebook's ASCII+LF contract for the legacy workspace.
    if (!/^[\x20-\x7e\n]*$/.test(text)) throw new Error("This prototype stores ASCII + LF only. Nothing saved.");
    if (this.read()[kind] !== expected) throw new Error("Text changed elsewhere. Reopen the editor; nothing overwritten.");
    atomicWrite(kind === "note" ? this.paths.scratch : this.paths.composer, text);
  }

  queueDraft(): PendingQueue {
    const current = this.read();
    if (current.error) throw new Error(current.error);
    if (!current.composer.trim()) throw new Error("Draft is empty. Compose a prompt first.");
    const next = enqueue(current.queue, { expectedRevision: current.queue.revision, requestId: randomUUID(), text: current.composer });
    atomicWrite(this.paths.queue, serializeQueue(next));
    // Retain the draft intentionally: a failed second file write cannot lose it.
    return next;
  }

  remove(id: string, expectedRevision: number): PendingQueue {
    const current = this.read();
    if (current.error) throw new Error(current.error);
    if (current.queue.revision !== expectedRevision) throw new Error("Queue changed. Reopen the picker; nothing removed.");
    const next = removeItem(current.queue, id);
    atomicWrite(this.paths.queue, serializeQueue(next));
    return next;
  }
}
