import path from "node:path";
import { BriefingStore } from "./store.mts";
import { hasOpenKnowledgeCredentials, OpenKnowledgeBriefing, OpenKnowledgeClient, openKnowledgeOrigin } from "./openknowledge.mts";
import { bootstrapProjectPages, projectPagesFor, type PagesClient, type ProjectPages } from "../sync/project-pages.mts";
import { gitSnapshot } from "../git/snapshot.mts";
import { buildBrowseModel, buildResumeDraft, guardResume, inspectRow, rowLabel } from "../project/browse.mts";
import { defaultDiscoveryConfig, discoverRecentProjects, nodeDiscoveryFS } from "../project/discovery.mts";
import { buildRoutingIndex, defaultRoutingConfig, nodeWorkstreamFS } from "../project/workstreams.mts";

export interface BriefingDialogs {
  select(title: string, choices: string[]): Promise<string | undefined>;
  editor(title: string, text: string): Promise<string | undefined>;
  input(title: string, initial: string): Promise<string | undefined>;
  confirm(title: string, message: string): Promise<boolean>;
  notify(message: string, level: "info" | "warning" | "error"): void;
}
export interface BriefingHost { cwd: string; targetLabel: string; ui: BriefingDialogs }

/** Host hooks: prompt-log capture, shared-page reads, stable project id. */
export interface BriefingHooks {
  /** Called after every local briefing save, with the saved text. */
  onSave?: ((text: string) => void) | undefined;
  /** Read-only client for the bound origin when credentials are present; undefined otherwise. */
  sharedReader?: ((origin: string) => PagesClient | undefined) | undefined;
  /** Default project id for Connect: git remote name, else directory basename. */
  projectLabel?: ((cwd: string) => string) | undefined;
}

const SHARED_TAIL_CHARS = 12_000;

function tail(text: string | null, chars = SHARED_TAIL_CHARS): string {
  if (text === null) return "(page does not exist yet)";
  if (text.length <= chars) return text;
  return `[... ${String(text.length - chars)} earlier characters omitted ...]\n${text.slice(-chars)}`;
}

/** A resume draft seeded from shared pages; the operator edits it before any explicit send. */
export function buildSharedResumeDraft(cwd: string, source: string, text: string): string {
  return [
    `# Resume ${path.basename(cwd)} from ${source}`,
    "",
    "Read the shared context below, verify `git status --short --branch` and the live tracker,",
    "then restate the smallest runnable next step before editing. Nothing here was sent automatically.",
    "",
    `## ${source} (as read)`,
    "",
    text.trimEnd(),
    "",
  ].join("\n");
}

/** Overview owns only briefing state; it never edits the workspace or Pi composer. */
export class BriefingController {
  private remote: OpenKnowledgeBriefing | undefined;
  readonly store: BriefingStore;
  private readonly hooks: BriefingHooks;
  constructor(store: BriefingStore, hooks: BriefingHooks = {}) { this.store = store; this.hooks = hooks; }

  private save(text: string): void {
    this.store.save(text);
    try { this.hooks.onSave?.(text); } catch { /* history capture is advisory */ }
  }

  /** Shared pages readable right now: a saved binding plus exported credentials. Reads only. */
  private shared(ctx: BriefingHost): { pages: ProjectPages; client: PagesClient } | undefined {
    const target = this.store.target;
    if (!target || !this.hooks.sharedReader) return undefined;
    try {
      const client = this.hooks.sharedReader(target.origin);
      if (!client) return undefined;
      return { pages: projectPagesFor(target.origin, path.basename(ctx.cwd), target.docName), client };
    } catch { return undefined; }
  }

  private async readShared(shared: { pages: ProjectPages; client: PagesClient }, kind: "workspace" | "history"): Promise<string> {
    if (kind === "workspace") return tail(await shared.client.readDocument(shared.pages.workspace));
    const [log, handoffs] = await Promise.all([
      shared.client.readDocument(shared.pages.promptLog),
      shared.client.readDocument(shared.pages.handoffs),
    ]);
    return [`## ${shared.pages.promptLog} (tail)`, "", tail(log, SHARED_TAIL_CHARS / 2), "", `## ${shared.pages.handoffs} (tail)`, "", tail(handoffs, SHARED_TAIL_CHARS / 2)].join("\n");
  }

  async show(
    ctx: BriefingHost, isCurrent: () => boolean,
    continueHere: (text: string) => Promise<boolean>,
    startFresh?: (text: string) => Promise<boolean>,
    autoStatus?: string | undefined,
  ): Promise<"workspace" | "new-task" | "close" | "sent" | "fresh"> {
    const store = this.store;
    while (isCurrent()) {
      const target = store.target ? `${store.target.origin} / ${store.target.docName}` : "not connected";
      const shared = this.shared(ctx);
      const choice = await ctx.ui.select(
        `PROMPTR · ${path.basename(ctx.cwd)}\n${ctx.cwd}\nBriefing: ${store.status} · updated ${store.updated}\n${store.text.split("\n").filter(Boolean).slice(0, 6).map(line => line.slice(0, 160)).join("\n")}\nRemote: ${target}\nLocal: ${store.file}${autoStatus ? `\n${autoStatus}` : ""}`,
        ["Resume", "Edit briefing", "Save locally", ...(this.remote ? ["Save + sync", "Refresh remote"] : []),
          "Connect OpenKnowledge", ...(shared ? ["Shared workspace", "Shared history"] : []),
          "Browse projects", "New task", "Open workspace", "View sources", "Close"],
      );
      if (!isCurrent()) return "close";
      try {
        if (!choice || choice === "Close") return "close";
        if (choice === "Open workspace") return "workspace";
        if (choice === "New task") return "new-task";
        if (choice === "View sources") {
          ctx.ui.notify(`Briefing: ${store.file}\nRetained revisions: ${path.join(path.dirname(store.file), "briefing-history")}\nRemote: ${target}\nGitea remains authoritative for tasks. Read-first links are editable in the briefing. Attempt packets (*-resume-attempt.json, *-fresh-attempt.json) are send records, not revisions; only *.md files are briefing revisions.`, "info");
        } else if (choice === "Edit briefing") {
          const edited = await ctx.ui.editor("Project briefing — save locally; Esc cancels (no sync/send)", store.text);
          if (edited !== undefined && isCurrent()) { this.save(edited); ctx.ui.notify(`Saved locally ${store.updated}.`, "info"); }
        } else if (choice === "Save locally") {
          this.save(store.text);
          ctx.ui.notify(`Saved locally ${store.updated}.`, "info");
        } else if (choice === "Save + sync" && this.remote) {
          this.save(store.text); // Never make remote availability a prerequisite to saving.
          ctx.ui.notify(`Saved locally; syncing ${target} (bounded request, no automatic retry)`, "info");
          await store.sync(this.remote);
        } else if (choice === "Connect OpenKnowledge") {
          let origin: string;
          try { origin = openKnowledgeOrigin(); }
          catch (error) { ctx.ui.notify(error instanceof Error ? error.message : "Invalid OPENKNOWLEDGE_ORIGIN.", "warning"); continue; }
          if (!hasOpenKnowledgeCredentials()) {
            ctx.ui.notify("OpenKnowledge unbound: export OPENKNOWLEDGE_USERNAME and OPENKNOWLEDGE_PASSWORD in the shell that launches this companion, then reopen. Local save remains available.", "warning");
            continue;
          }
          const label = this.hooks.projectLabel ? this.hooks.projectLabel(ctx.cwd) : path.basename(ctx.cwd);
          const pages = projectPagesFor(origin, label, store.target?.docName);
          const confirmed = await ctx.ui.confirm("Connect OpenKnowledge project pages?",
            `${origin}\nbrief: ${pages.brief}\ninbox: ${pages.inbox}\nworkspace: ${pages.workspace}\nhandoffs: ${pages.handoffs}\nConnect reads the brief and creates the missing inbox/workspace/handoffs pages with a short seed. The brief is never created or replaced until Save + sync. Other clients can still race a write. Credentials come only from the environment.`);
          if (!confirmed || !isCurrent()) continue;
          store.connect({ origin, docName: pages.brief });
          this.remote = new OpenKnowledgeBriefing({ origin, docName: pages.brief });
          const status = await bootstrapProjectPages(new OpenKnowledgeClient(origin), pages, Date.now);
          if (status.state === "ok") ctx.ui.notify(`OpenKnowledge connected · created ${status.created.length > 0 ? status.created.join(", ") : "nothing"} · OK`, "info");
          else if (status.state === "offline") ctx.ui.notify(`OpenKnowledge offline: ${status.reason} — local retained`, "warning");
          await this.refresh(ctx, isCurrent);
        } else if (choice === "Refresh remote" && this.remote) {
          await this.refresh(ctx, isCurrent);
        } else if ((choice === "Shared workspace" || choice === "Shared history") && shared) {
          // Fresh-client read path: read the shared pages, never write.
          // Saving the view turns it into a resume draft for the explicit
          // Continue here / Start fresh flow; Esc just closes it.
          ctx.ui.notify(`Reading ${shared.pages.origin} (bounded, read-only)…`, "info");
          let text: string;
          try { text = await this.readShared(shared, choice === "Shared workspace" ? "workspace" : "history"); }
          catch (error) { ctx.ui.notify(`${choice} unavailable: ${error instanceof Error ? error.message : "read failed"}. Nothing changed.`, "warning"); continue; }
          if (!isCurrent()) return "close";
          const viewed = await ctx.ui.editor(`${choice} · ${shared.pages.origin} — read-only view; Esc closes; save = draft a resume from it (no send)`, text);
          if (viewed === undefined || !isCurrent()) continue;
          const edited = await ctx.ui.editor("Review/edit resume draft — save locally, then choose where; Esc cancels", buildSharedResumeDraft(ctx.cwd, choice, viewed));
          if (edited === undefined || !isCurrent()) continue;
          this.save(edited);
          const destination = await ctx.ui.select(`Resume ${ctx.cwd}\nCurrent Pi session: ${ctx.targetLabel}`, ["Continue here", "Start fresh", "Cancel"]);
          if (!isCurrent()) return "close";
          if (destination === "Start fresh") {
            if (!startFresh) { ctx.ui.notify("Start fresh is unavailable here; no session launched.", "warning"); continue; }
            if (await startFresh(edited)) return "fresh";
          } else if (destination === "Continue here") {
            if (await continueHere(edited)) return "sent";
          }
        } else if (choice === "Browse projects") {
          const done = await this.browseProjects(ctx, isCurrent, continueHere, startFresh);
          if (done === "sent" || done === "fresh") return done;
        } else if (choice === "Resume") {
          const edited = await ctx.ui.editor("Review/edit continuation — save locally, then choose where; Esc cancels", store.text);
          if (edited === undefined || !isCurrent()) continue;
          this.save(edited);
          const destination = await ctx.ui.select(`Resume ${ctx.cwd}\nCurrent Pi session: ${ctx.targetLabel}`, ["Continue here", "Start fresh", "Cancel"]);
          if (!isCurrent()) return "close";
          if (destination === "Start fresh") {
            if (!startFresh) { ctx.ui.notify("Start fresh is unavailable here; no session launched.", "warning"); continue; }
            if (await startFresh(edited)) return "fresh";
          } else if (destination === "Continue here") {
            if (await continueHere(edited)) return "sent";
          }
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : "Briefing operation failed; nothing sent.", "warning");
      }
    }
    return "close";
  }

  /**
   * Recent-project browsing over project discovery + the routing index.
   * Read-only scan (bounded); Inspect shows evidence, Draft resume feeds
   * the existing editor → Continue here / Start fresh flow. Selecting or
   * inspecting a row never sends or launches; guards block wrong-cwd,
   * moved-HEAD, missing, and live-writer resumes with a visible reason.
   */
  private async browseProjects(
    ctx: BriefingHost, isCurrent: () => boolean,
    continueHere: (text: string) => Promise<boolean>,
    startFresh?: (text: string) => Promise<boolean>,
  ): Promise<"sent" | "fresh" | "back"> {
    ctx.ui.notify("Scanning recent projects (bounded, read-only)…", "info");
    let discovered;
    try {
      discovered = discoverRecentProjects(defaultDiscoveryConfig(), nodeDiscoveryFS());
    } catch {
      ctx.ui.notify("Project scan failed; browsing unavailable. Nothing changed.", "warning");
      return "back";
    }
    if (discovered.projects.length === 0) {
      ctx.ui.notify("No recent projects found in this window. Nothing changed.", "info");
      return "back";
    }
    const index = buildRoutingIndex(discovered.projects, [], nodeWorkstreamFS(), defaultRoutingConfig({ projectRoots: [] }));
    const model = buildBrowseModel(discovered.projects, index);
    const labels = new Map(model.rows.map((r) => [rowLabel(r), r.key] as const));
    while (isCurrent()) {
      const picked = await ctx.ui.select(
        `Recent projects (${model.rows.length}${model.partial ? `, partial: ${model.stoppedBy}` : ""})\nSelecting a row inspects only — nothing sends or launches.`,
        [...labels.keys(), "Back"],
      );
      if (!isCurrent() || !picked || picked === "Back") return "back";
      const key = labels.get(picked);
      const row = model.rows.find((r) => r.key === key);
      if (!row) continue;
      const action = await ctx.ui.select(`${row.slug} — ${row.status}\n${row.staleness}${row.activeWriter ? " · LIVE WRITER" : ""}${row.missing ? " · MISSING" : ""}`, ["Inspect", "Draft resume", "Back"]);
      if (!isCurrent() || !action || action === "Back") continue;
      if (action === "Inspect") {
        ctx.ui.notify(inspectRow(model, index, row.key).join("\n"), "info");
        continue;
      }
      // Draft resume: guard against live facts first, then reuse the
      // existing review → destination flow. No new send path.
      const live = { cwd: ctx.cwd, head: gitSnapshot(ctx.cwd).head };
      const guard = guardResume(row, live);
      if (!guard.ok) {
        ctx.ui.notify(`${guard.warnings.join(" ")} Nothing launched.`, "warning");
        continue;
      }
      const entry = index.entries.find((e) => e.projectKey === row.key);
      const draft = buildResumeDraft(row, entry);
      if (guard.warnings.length > 0) ctx.ui.notify(guard.warnings.join(" "), "warning");
      const edited = await ctx.ui.editor("Review/edit resume draft — save locally, then choose where; Esc cancels", draft.text);
      if (edited === undefined || !isCurrent()) continue;
      const destination = await ctx.ui.select(`Resume ${row.cwd}\nCurrent Pi session: ${ctx.targetLabel}`, ["Continue here", "Start fresh", "Cancel"]);
      if (!isCurrent()) return "back";
      if (destination === "Start fresh") {
        if (!startFresh) { ctx.ui.notify("Start fresh is unavailable here; no session launched.", "warning"); continue; }
        if (await startFresh(edited)) return "fresh";
      } else if (destination === "Continue here") {
        if (await continueHere(edited)) return "sent";
      }
    }
    return "back";
  }

  private async refresh(ctx: BriefingHost, isCurrent: () => boolean): Promise<void> {
    if (!this.remote) return;
    ctx.ui.notify("Reading remote briefing; local work will be retained on conflict.", "info");
    const result = await this.store.refresh(this.remote);
    if (result.conflict && result.remote !== null && isCurrent()) {
      if (await ctx.ui.confirm("Use remote briefing instead?", "Local and remote differ. Your local revision will be retained in briefing-history. Cancel keeps local work; edit the retained copies to reconcile.") && isCurrent()) {
        this.store.adoptRemote(result.remote);
        try { this.hooks.onSave?.(result.remote); } catch { /* advisory */ }
      }
    }
  }
}
