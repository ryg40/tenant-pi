import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWrite } from "../state/paths.mts";
import { briefingTarget, validateBriefing, type BriefingTarget, type OpenKnowledgeBriefing } from "./openknowledge.mts";

type Metadata = { target?: BriefingTarget; baseline?: string | null; updated?: string; status: string };
function optionalRead(file: string): string | undefined {
  try { return fs.readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

/** One local Markdown entry point; retained revisions are additive, not a task database. */
export class BriefingStore {
  readonly file: string;
  private readonly metadataFile: string;
  private metadata: Metadata;
  text: string;
  saved: boolean;
  constructor(cwd: string, initial: string) {
    this.file = path.join(cwd, ".promptr", "briefing.md");
    this.metadataFile = path.join(cwd, ".promptr", "briefing.json");
    const text = optionalRead(this.file);
    this.saved = text !== undefined;
    this.text = text ?? initial;
    validateBriefing(this.text);
    this.metadata = { status: text === undefined ? "not saved" : "local" };
    const raw = optionalRead(this.metadataFile);
    if (raw) {
      try {
        const data = JSON.parse(raw) as Metadata;
        if (data.target) data.target = briefingTarget(data.target.origin, data.target.docName);
        if (data.baseline !== undefined && data.baseline !== null) validateBriefing(data.baseline);
        if (typeof data.status !== "string") throw new Error("Invalid metadata");
        this.metadata = data;
      } catch { this.metadata.status = "local — sync metadata unreadable; reconnect and refresh"; }
    }
    if (this.metadata.target && this.metadata.baseline !== this.text) this.metadata.status = "pending — local differs from remote baseline";
  }
  get target(): BriefingTarget | undefined { return this.metadata.target; }
  get status(): string { return this.metadata.status; }
  get updated(): string { return this.metadata.updated ?? "unknown"; }
  private persistMetadata(): void { atomicWrite(this.metadataFile, JSON.stringify(this.metadata, null, 2) + "\n"); }
  private retain(text: string, kind: string): void {
    atomicWrite(path.join(path.dirname(this.file), "briefing-history", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}-${kind}.md`), text);
  }
  save(text: string): void {
    validateBriefing(text);
    const previous = optionalRead(this.file);
    if (previous !== undefined && previous !== text) this.retain(previous, "local");
    atomicWrite(this.file, text);
    this.text = text;
    this.saved = true;
    this.metadata.updated = new Date().toISOString();
    this.metadata.status = this.target ? "pending — saved locally" : "local";
    this.persistMetadata();
  }
  connect(target: BriefingTarget): void {
    const checked = briefingTarget(target.origin, target.docName);
    if (JSON.stringify(checked) !== JSON.stringify(this.target)) {
      this.metadata = { target: checked, status: "local — remote not loaded" };
    }
    this.persistMetadata();
  }
  private checkTarget(remote: OpenKnowledgeBriefing): void {
    if (JSON.stringify(remote.target) !== JSON.stringify(this.target)) throw new Error("Remote target changed; reconnect first.");
  }
  /** Refresh never replaces divergent local work; caller may explicitly adopt the retained remote copy. */
  async refresh(remote: OpenKnowledgeBriefing): Promise<{ conflict: boolean; remote: string | null }> {
    this.checkTarget(remote);
    try {
      const text = await remote.read();
      if (text === this.text) {
        this.metadata.baseline = text;
        this.metadata.status = "synced";
      } else if (!this.saved || this.text === this.metadata.baseline) {
        if (text !== null) this.save(text);
        this.metadata.baseline = text;
        this.metadata.status = text === null ? "pending — remote page missing" : "synced";
      } else if (text === null) {
        // A saved local briefing with no remote page is not a conflict: Save + sync creates the page.
        this.metadata.status = "pending — remote page missing; Save + sync creates it";
      } else {
        this.retain(text, "remote");
        this.metadata.status = "conflict — local kept; remote revision retained in briefing-history";
        this.persistMetadata();
        return { conflict: true, remote: text };
      }
      this.persistMetadata();
      return { conflict: false, remote: text };
    } catch (error) { this.metadata.status = "pending/offline — local retained"; this.persistMetadata(); throw error; }
  }
  adoptRemote(text: string): void {
    this.save(text);
    this.metadata.baseline = text;
    this.metadata.status = "synced";
    this.persistMetadata();
  }
  /** Read comparison is not CAS: another client can still race the write. Never auto-retry. */
  async sync(remote: OpenKnowledgeBriefing): Promise<void> {
    this.checkTarget(remote);
    try {
      const current = await remote.read();
      if (current !== this.text) {
        if (current !== this.metadata.baseline && !(current === null && this.metadata.baseline === undefined)) {
          if (current !== null) this.retain(current, "remote");
          this.metadata.status = "conflict — remote changed; refresh/reconcile before sync";
          this.persistMetadata();
          return;
        }
        await remote.write(this.text, current === null);
        if (await remote.read() !== this.text) throw new Error("Remote read-back differs; local retained. Refresh to reconcile.");
      }
      this.metadata.baseline = this.text;
      this.metadata.status = "synced";
      this.persistMetadata();
    } catch (error) {
      this.metadata.status = "pending/unknown — local retained; refresh before retrying";
      this.persistMetadata();
      throw error;
    }
  }
}
