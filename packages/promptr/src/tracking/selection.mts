/**
 * Tracking navigation controller.
 *
 * Owns list/detail/preview state for the companion's tracking region: which
 * page is loaded, which issue is selected (by stable identity, never by row
 * index), what the last detail read said, and whether a Generate Prompt
 * request may be prepared at all.
 *
 * Boundaries this file exists to hold:
 *
 * - The tracking *summary* snapshot is display data with a ten-per-milestone
 *   cap. Navigation never reads it as the task set; it asks the injected
 *   ports for explicit, bounded pages instead.
 * - Selection is `host+owner+repo+number`. A refresh that reorders the page
 *   keeps the same selection; a refresh that removes it clears the selection
 *   and demands a new deliberate one. Nothing is ever silently retargeted.
 * - Every async read carries a generation stamp. A response that arrives
 *   after a newer action (or after cancellation) is dropped, so a slow page
 *   can never overwrite what the operator is looking at now.
 * - Preparing a request is a *packet*, not an execution. Nothing here sends,
 *   launches, enqueues, writes a file, or touches credentials.
 */
import {
  detailSignature,
  isRetired,
  isValidIssueNumber,
  isValidTrackingRepo,
  issueKey,
  ISSUE_PAGE_SIZE,
  type DependencyRead,
  type IssueDetail,
  type IssuePage,
  type TrackedIssue,
  type TrackingRepo,
  repoIdentity,
} from "./gitea.mts";
import {
  CATALOG_UNAVAILABLE,
  DEFAULT_WORKFLOW_EXECUTION,
  WORKFLOW_EXECUTIONS,
  isWorkflowCatalogPort,
  type WorkflowCatalogPort,
  type WorkflowChoice,
  type WorkflowExecution,
  type WorkflowExpansion,
  type WorkflowInput,
} from "./workflow-port.mts";

/** Which pane of the navigation modal is showing. */
export type TrackingView = "list" | "detail" | "workflow" | "provider" | "execution" | "preview";

/** Outcome of an async controller action, so callers and tests can see staleness. */
export type NavOutcome = "applied" | "stale" | "refused";

export interface TrackingNavPorts {
  /** One explicit page of issues. May reject; the controller reports offline. */
  listPage(repo: TrackingRepo, page: number): Promise<IssuePage>;
  /** One issue plus native dependency state. `undefined` means unavailable. */
  loadDetail(repo: TrackingRepo, number: number): Promise<IssueDetail | undefined>;
  /** Injected clock: the controller never calls Date.now() itself. */
  now(): string;
  /** Workflow catalog. Absent means the picker says so and offers nothing. */
  catalog?: WorkflowCatalogPort | undefined;
}

export interface TrackingNavOptions {
  repo: TrackingRepo;
  ports: TrackingNavPorts;
  pageSize?: number;
}

export interface TrackingListState {
  page: number;
  perPage: number;
  items: readonly TrackedIssue[];
  hasMore: boolean;
  fetchedAt: string;
  /** Rows never came back, or came back from an earlier successful read. */
  offline: boolean;
  /** Row cursor inside the current page. Display position only. */
  cursor: number;
}

export interface TrackingNavState {
  view: TrackingView;
  repo: TrackingRepo;
  list: TrackingListState;
  busy: boolean;
  notice: string;
  /** Stable identity of the selected issue, or undefined when nothing is selected. */
  selectedKey: string | undefined;
  selectedNumber: number | undefined;
  selectedTitle: string | undefined;
  detail: IssueDetail | undefined;
  /** Detail could not be re-read; what is shown is cached and cannot create a request. */
  detailStale: boolean;
  /** The issue moved under a reviewed detail; a deliberate re-review is required. */
  changed: boolean;
  workflowId: string | undefined;
  providerId: string | undefined;
  /** Chosen at the execution step; `undefined` until then. */
  executionId: WorkflowExecution | undefined;
  expansion: WorkflowExpansion | undefined;
  /** Why a request cannot be prepared right now. Empty means it can. */
  blockers: readonly string[];
  catalogAvailable: boolean;
  /** A packet is waiting to be consumed by the host. */
  requestReady: boolean;
}

/**
 * The one object this module hands onward. Deeply frozen and attributed: it
 * names the task it came from and the workflow that was previewed, and
 * carries no credential, notebook, composer, queue or session transcript.
 * `kind` is deliberately literal so a downstream reader cannot mistake it
 * for an instruction to run anything.
 */
export interface GeneratePromptRequest {
  readonly version: 1;
  readonly kind: "generate-prompt-request";
  readonly task: {
    readonly repo: TrackingRepo;
    readonly number: number;
    readonly url: string;
    readonly title: string;
    readonly body: string;
    readonly bodyTruncated: boolean;
    readonly state: "open" | "closed";
    readonly labels: readonly string[];
    readonly updatedAt: string;
    readonly fetchedAt: string;
    readonly dependencies: DependencyRead;
  };
  readonly workflow: WorkflowExpansion;
  readonly createdAt: string;
}

export type PrepareResult =
  | { readonly ok: true; readonly value: GeneratePromptRequest }
  | { readonly ok: false; readonly error: string };

/** Recursively freeze a plain data tree. Packets must not be mutable downstream. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  for (const inner of Object.values(value as Record<string, unknown>)) deepFreeze(inner);
  return Object.freeze(value);
}

const EMPTY_LIST: TrackingListState = {
  page: 1,
  perPage: ISSUE_PAGE_SIZE,
  items: [],
  hasMore: false,
  fetchedAt: "",
  offline: false,
  cursor: 0,
};

export class TrackingNavigationController {
  private repo: TrackingRepo;
  private readonly ports: TrackingNavPorts;
  private readonly pageSize: number;

  /**
   * Monotonic stamp for every async action. A resolution whose stamp is no
   * longer current belongs to a superseded action (or to one the operator
   * cancelled) and is dropped without touching state.
   */
  private seq = 0;
  private busy = false;
  private view: TrackingView = "list";
  /** Where the current selection came from; decides where `back()` from detail lands. */
  private entry: "list" | "board" = "list";
  private list: TrackingListState = EMPTY_LIST;
  private notice = "";
  private selectedKey: string | undefined = undefined;
  private selected: TrackedIssue | undefined = undefined;
  private detail: IssueDetail | undefined = undefined;
  private reviewedSignature: string | undefined = undefined;
  private detailStale = false;
  private changed = false;
  private workflowId: string | undefined = undefined;
  private providerId: string | undefined = undefined;
  private executionId: WorkflowExecution | undefined = undefined;
  private expansion: WorkflowExpansion | undefined = undefined;
  private readiness: WorkflowInput["readiness"] = "unknown";
  /** One packet per preview: a repeated confirm must not emit a second one. */
  private emittedForPreview = false;
  private pendingRequest: GeneratePromptRequest | undefined = undefined;
  private lastRequest: GeneratePromptRequest | undefined = undefined;

  constructor(options: TrackingNavOptions) {
    if (!isValidTrackingRepo(options.repo)) throw new Error("invalid repository binding");
    // Keep the provider: every port read routes by it, so dropping it would send a GitHub binding to the Gitea adapter.
    this.repo = repoIdentity(options.repo);
    this.ports = options.ports;
    this.pageSize = Math.max(1, Math.min(50, Math.trunc(options.pageSize ?? ISSUE_PAGE_SIZE)));
    this.list = { ...EMPTY_LIST, perPage: this.pageSize };
    this.notice = "No page loaded yet.";
  }

  /** Change repositories atomically: discard stale selections, previews and in-flight reads. */
  rebind(repo: TrackingRepo): void {
    if (!isValidTrackingRepo(repo)) throw new Error("invalid repository binding");
    this.cancel();
    this.repo = repoIdentity(repo);
    this.clearSelection();
    this.lastRequest = undefined;
    this.readiness = "unknown";
    this.list = { ...EMPTY_LIST, perPage: this.pageSize };
    this.view = "list";
    this.entry = "list";
    this.notice = "Tracker changed; choose an issue again.";
  }

  getState(): TrackingNavState {
    return {
      view: this.view,
      repo: { ...this.repo },
      list: { ...this.list, items: this.list.items },
      busy: this.busy,
      notice: this.notice,
      selectedKey: this.selectedKey,
      selectedNumber: this.selected?.number,
      selectedTitle: this.selected?.title,
      detail: this.detail,
      detailStale: this.detailStale,
      changed: this.changed,
      workflowId: this.workflowId,
      providerId: this.providerId,
      executionId: this.executionId,
      expansion: this.expansion,
      blockers: this.requestBlockers(),
      catalogAvailable: isWorkflowCatalogPort(this.ports.catalog),
      requestReady: this.pendingRequest !== undefined,
    };
  }

  // ---- async plumbing ----

  private begin(): number {
    this.seq += 1;
    this.busy = true;
    return this.seq;
  }

  private current(stamp: number): boolean {
    return stamp === this.seq;
  }

  /**
   * Abandon whatever is in flight. The stamp moves, so a response already on
   * its way resolves into nothing: no list swap, no detail swap, no packet.
   */
  cancel(): void {
    this.seq += 1;
    this.busy = false;
    this.notice = "Cancelled. Nothing was sent, launched or queued.";
  }

  // ---- list navigation ----

  /**
   * Load one page. `retainIdentity` marks a refresh of the page the selection
   * lives on: there, a selection that has disappeared is *cleared*, never
   * moved to whatever row now sits at the same index.
   */
  private async loadPage(page: number, retainIdentity: boolean): Promise<NavOutcome> {
    const stamp = this.begin();
    const wanted = Math.max(1, Math.trunc(page));
    let loaded: IssuePage | undefined;
    let failure = "";
    try {
      loaded = await this.ports.listPage(this.repo, wanted);
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 160) : "list read failed";
    }
    if (!this.current(stamp)) return "stale";
    this.busy = false;
    if (!loaded) {
      // Cached rows may still be displayed; they are marked offline and the
      // request path refuses to build anything from them.
      this.list = { ...this.list, offline: true };
      this.notice = `Issue list unavailable (${failure || "read failed"}); showing cached rows.`;
      return "applied";
    }
    const items = loaded.items;
    let cursor = 0;
    if (this.selectedKey !== undefined) {
      const index = items.findIndex((item) => issueKey(this.repo, item.number) === this.selectedKey);
      if (index >= 0) {
        cursor = index;
        this.selected = items[index];
      } else if (retainIdentity) {
        this.clearSelection();
        this.notice = "The selected issue is no longer on this page; selection cleared. Choose an issue again.";
      }
    }
    this.list = {
      page: loaded.page,
      perPage: loaded.perPage,
      items,
      hasMore: loaded.hasMore,
      fetchedAt: loaded.fetchedAt,
      offline: false,
      cursor: Math.min(cursor, Math.max(0, items.length - 1)),
    };
    if (!this.notice.startsWith("The selected issue is no longer")) {
      this.notice = `Page ${String(loaded.page)} · ${String(items.length)} issue(s)${loaded.hasMore ? " · more pages" : ""}.`;
    }
    this.view = "list";
    this.entry = "list";
    return "applied";
  }

  getEntry(): "list" | "board" {
    return this.entry;
  }

  openList(page = 1): Promise<NavOutcome> {
    return this.loadPage(page, false);
  }

  /** Same page again, keeping the selected identity if it is still there. */
  refresh(): Promise<NavOutcome> {
    return this.loadPage(this.list.page, true);
  }

  nextPage(): Promise<NavOutcome> {
    if (!this.list.hasMore) {
      this.notice = "Last page.";
      return Promise.resolve<NavOutcome>("refused");
    }
    return this.loadPage(this.list.page + 1, false);
  }

  previousPage(): Promise<NavOutcome> {
    if (this.list.page <= 1) {
      this.notice = "First page.";
      return Promise.resolve<NavOutcome>("refused");
    }
    return this.loadPage(this.list.page - 1, false);
  }

  /** Move the row cursor inside the loaded page. Never crosses a page boundary. */
  moveCursor(delta: number): void {
    const count = this.list.items.length;
    if (count === 0) {
      this.notice = "No issues on this page.";
      return;
    }
    const next = Math.min(count - 1, Math.max(0, this.list.cursor + Math.trunc(delta)));
    this.list = { ...this.list, cursor: next };
  }

  private clearSelection(): void {
    this.selectedKey = undefined;
    this.selected = undefined;
    this.detail = undefined;
    this.reviewedSignature = undefined;
    this.detailStale = false;
    this.changed = false;
    this.resetPreview();
  }

  private resetPreview(): void {
    this.workflowId = undefined;
    this.providerId = undefined;
    this.executionId = undefined;
    this.expansion = undefined;
    this.emittedForPreview = false;
    this.pendingRequest = undefined;
  }

  /**
   * Bind the selection to the row under the cursor, by identity. Re-selecting
   * the same issue is the deliberate act that clears a `changed` flag: the
   * operator has looked again.
   */
  select(): NavOutcome {
    const item = this.list.items[this.list.cursor];
    if (!item) {
      this.notice = "Nothing to select on this page.";
      return "refused";
    }
    if (this.list.offline) {
      this.notice = "Rows are cached/offline. Refresh before selecting.";
      return "refused";
    }
    const key = issueKey(this.repo, item.number);
    if (key !== this.selectedKey) {
      this.clearSelection();
      this.selectedKey = key;
    } else {
      this.resetPreview();
    }
    this.selected = item;
    this.entry = "list";
    this.notice = `Selected #${String(item.number)} ${item.title}`;
    return "applied";
  }

  /**
   * Bind the selection directly to an issue handed in by the workboard,
   * bypassing the list cursor. Identity is validated, previous selection and
   * preview are dropped, and `back()` from detail returns to the board.
   */
  selectIssue(item: TrackedIssue): NavOutcome {
    if (!item || !isValidIssueNumber(item.number)) {
      this.notice = "Issue number is not usable.";
      return "refused";
    }
    this.clearSelection();
    this.selectedKey = issueKey(this.repo, item.number);
    this.selected = item;
    this.entry = "board";
    this.notice = `Selected #${String(item.number)} ${item.title}`;
    return "applied";
  }

  /** Read the selected issue's detail and dependencies, then show the detail pane. */
  async openDetail(): Promise<NavOutcome> {
    if (this.selectedKey === undefined || !this.selected) {
      this.notice = "Select an issue first.";
      return "refused";
    }
    const number = this.selected.number;
    if (!isValidIssueNumber(number)) {
      this.notice = "Selected issue number is not usable.";
      return "refused";
    }
    const stamp = this.begin();
    let detail: IssueDetail | undefined;
    let failure = "";
    try {
      detail = await this.ports.loadDetail(this.repo, number);
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 160) : "detail read failed";
    }
    if (!this.current(stamp)) return "stale";
    this.busy = false;
    if (!detail) {
      this.detailStale = true;
      this.view = "detail";
      this.notice = failure
        ? `Detail unavailable (${failure}). Nothing can be prepared from a failed read.`
        : "Detail unavailable or malformed. Treated as unavailable, not as open work.";
      return "applied";
    }
    if (detail.key !== this.selectedKey) {
      // A detail for another issue is never accepted into this selection.
      this.notice = "Detail did not match the selected issue; discarded.";
      return "refused";
    }
    this.detail = detail;
    this.reviewedSignature = detailSignature(detail);
    this.detailStale = false;
    this.changed = false;
    this.resetPreview();
    this.view = "detail";
    this.notice = `#${String(detail.number)} ${detail.state} · updated ${detail.updatedAt} · read ${detail.fetchedAt}`;
    return "applied";
  }

  /**
   * Accept the currently displayed detail as reviewed. This is the deliberate
   * re-review a changed issue demands; it never re-reads and never approves
   * anything by itself.
   */
  acceptReviewedDetail(): NavOutcome {
    if (!this.detail) {
      this.notice = "Nothing to review.";
      return "refused";
    }
    this.reviewedSignature = detailSignature(this.detail);
    this.changed = false;
    this.notice = `Reviewed #${String(this.detail.number)} at ${this.detail.fetchedAt}.`;
    return "applied";
  }

  /** Readiness is stated, never inferred from an issue's title or body. */
  setReadiness(readiness: WorkflowInput["readiness"]): void {
    this.readiness = readiness;
    this.resetPreview();
  }

  getReadiness(): WorkflowInput["readiness"] {
    return this.readiness;
  }

  // ---- request gating ----

  /**
   * Every reason a Generate Prompt request must not be built right now.
   * A blocker is native state — closed, retired, an open native dependency,
   * or a read we could not complete — never a checklist parsed out of prose.
   */
  requestBlockers(): readonly string[] {
    const reasons: string[] = [];
    if (this.selectedKey === undefined) {
      reasons.push("no issue selected");
      return Object.freeze(reasons);
    }
    const detail = this.detail;
    if (!detail) {
      reasons.push("issue detail was never read");
      return Object.freeze(reasons);
    }
    if (this.detailStale || this.list.offline) {
      reasons.push("detail is cached/offline; refresh before preparing a request");
    }
    if (this.changed) {
      reasons.push("the issue changed since it was reviewed; review it again");
    }
    if (detail.state === "closed") reasons.push("issue is closed");
    if (isRetired(detail.labels)) reasons.push("issue is labelled resolution:retired (not planned/superseded)");
    const deps = detail.dependencies;
    if (deps.status !== "complete") {
      reasons.push(`dependency read ${deps.status}${deps.reason ? ` (${deps.reason})` : ""}; cannot claim unblocked`);
    } else if (deps.blockers > 0) {
      reasons.push(`${String(deps.blockers)} open native dependency blocker(s)`);
    }
    return Object.freeze(reasons);
  }

  // ---- generate-prompt flow: workflow -> provider -> inert preview ----

  /**
   * The explicit Generate Prompt action. Re-reads the issue and its
   * dependencies first: a preview built on a stale read is a preview of work
   * that may no longer exist.
   */
  async startGenerate(): Promise<NavOutcome> {
    if (!this.detail || this.selectedKey === undefined) {
      this.notice = "Open an issue's details before generating.";
      return "refused";
    }
    const number = this.detail.number;
    const stamp = this.begin();
    let fresh: IssueDetail | undefined;
    let failure = "";
    try {
      fresh = await this.ports.loadDetail(this.repo, number);
    } catch (error) {
      failure = error instanceof Error ? error.message.slice(0, 160) : "detail read failed";
    }
    if (!this.current(stamp)) return "stale";
    this.busy = false;
    if (!fresh || fresh.key !== this.selectedKey) {
      this.detailStale = true;
      this.view = "detail";
      this.notice = `Could not re-read the issue (${failure || "unavailable"}). Request blocked; nothing generated.`;
      return "refused";
    }
    this.detailStale = false;
    const signature = detailSignature(fresh);
    this.detail = fresh;
    if (this.reviewedSignature !== undefined && signature !== this.reviewedSignature) {
      this.changed = true;
      this.view = "detail";
      this.notice = "Issue changed since you reviewed it. Read it again and re-confirm before generating.";
      return "refused";
    }
    this.reviewedSignature = signature;
    const blockers = this.requestBlockers();
    if (blockers.length > 0) {
      this.view = "detail";
      this.notice = `Blocked: ${blockers.join("; ")}.`;
      return "refused";
    }
    if (!isWorkflowCatalogPort(this.ports.catalog)) {
      this.view = "workflow";
      this.notice = CATALOG_UNAVAILABLE;
      return "refused";
    }
    this.resetPreview();
    this.view = "workflow";
    this.notice = "Choose a workflow. Nothing is launched or sent by choosing.";
    return "applied";
  }

  listWorkflows(): readonly WorkflowChoice[] {
    const catalog = this.ports.catalog;
    return isWorkflowCatalogPort(catalog) ? catalog.listWorkflows() : [];
  }

  listProviders(): readonly WorkflowChoice[] {
    const catalog = this.ports.catalog;
    return isWorkflowCatalogPort(catalog) ? catalog.listProviders() : [];
  }

  /** Execution modes are fixed presentation choices; the catalog validates the id at expansion. */
  listExecutions(): readonly WorkflowChoice[] {
    return isWorkflowCatalogPort(this.ports.catalog) ? WORKFLOW_EXECUTIONS : [];
  }

  chooseWorkflow(id: string): NavOutcome {
    const choice = this.listWorkflows().find((w) => w.id === id);
    if (!choice) {
      this.notice = isWorkflowCatalogPort(this.ports.catalog)
        ? `Unknown workflow: ${id}`
        : CATALOG_UNAVAILABLE;
      return "refused";
    }
    this.workflowId = choice.id;
    this.providerId = undefined;
    this.executionId = undefined;
    this.expansion = undefined;
    this.emittedForPreview = false;
    this.pendingRequest = undefined;
    this.view = "provider";
    this.notice = `Workflow ${choice.label}. Choose a provider.`;
    return "applied";
  }

  /**
   * Provider choice moves to the execution step. The template is expanded
   * here too, with the default execution, so a template/provider refusal
   * (an unresolved design on a simple template) shows up now rather than
   * one step later.
   */
  chooseProvider(id: string): NavOutcome {
    const catalog = this.ports.catalog;
    if (!isWorkflowCatalogPort(catalog)) {
      this.notice = CATALOG_UNAVAILABLE;
      return "refused";
    }
    if (this.workflowId === undefined) {
      this.notice = "Choose a workflow first.";
      return "refused";
    }
    const choice = catalog.listProviders().find((p) => p.id === id);
    if (!choice) {
      this.notice = `Unknown provider: ${id}`;
      return "refused";
    }
    const probe = catalog.expandWorkflow({
      template: this.workflowId,
      provider: choice.id,
      readiness: this.readiness,
    });
    if (!probe.ok) {
      this.providerId = choice.id;
      this.executionId = undefined;
      this.expansion = undefined;
      this.view = "provider";
      this.notice = `Workflow error: ${probe.error}`;
      return "refused";
    }
    this.providerId = choice.id;
    this.executionId = undefined;
    this.expansion = undefined;
    this.emittedForPreview = false;
    this.pendingRequest = undefined;
    this.view = "execution";
    this.notice = `Provider ${choice.label}. Choose how delegated roles run: ${DEFAULT_WORKFLOW_EXECUTION} or herdr-native.`;
    return "applied";
  }

  /** Execution choice expands the template into an inert role preview. */
  chooseExecution(id: string): NavOutcome {
    const catalog = this.ports.catalog;
    if (!isWorkflowCatalogPort(catalog)) {
      this.notice = CATALOG_UNAVAILABLE;
      return "refused";
    }
    if (this.workflowId === undefined || this.providerId === undefined) {
      this.notice = "Choose a workflow and a provider first.";
      return "refused";
    }
    const choice = WORKFLOW_EXECUTIONS.find((e) => e.id === id);
    if (!choice) {
      this.notice = `Unknown execution: ${id}`;
      return "refused";
    }
    const result = catalog.expandWorkflow({
      template: this.workflowId,
      provider: this.providerId,
      readiness: this.readiness,
      execution: choice.id,
    });
    if (!result.ok) {
      this.executionId = choice.id;
      this.expansion = undefined;
      this.view = "execution";
      this.notice = `Workflow error: ${result.error}`;
      return "refused";
    }
    this.executionId = choice.id;
    this.expansion = result.value;
    this.emittedForPreview = false;
    this.pendingRequest = undefined;
    this.view = "preview";
    this.notice = `Preview only — static role plan on ${choice.label}, runtime unverified. Nothing launched or sent.`;
    return "applied";
  }

  /**
   * Build the one attributed packet for this preview. Named for what it does:
   * it prepares a request object and hands it back. It launches nothing,
   * sends nothing, enqueues nothing and writes no file.
   */
  prepareRequest(): PrepareResult {
    const blockers = this.requestBlockers();
    if (blockers.length > 0) {
      this.notice = `Blocked: ${blockers.join("; ")}.`;
      return { ok: false, error: blockers.join("; ") };
    }
    const detail = this.detail;
    const expansion = this.expansion;
    if (!detail || !expansion) {
      this.notice = "No workflow preview to prepare.";
      return { ok: false, error: "no workflow preview" };
    }
    if (this.emittedForPreview) {
      this.notice = "Request already prepared for this preview; nothing further was emitted.";
      return { ok: false, error: "request already prepared for this preview" };
    }
    const packet = deepFreeze<GeneratePromptRequest>({
      version: 1,
      kind: "generate-prompt-request",
      task: {
        repo: { ...detail.repo },
        number: detail.number,
        url: detail.url,
        title: detail.title,
        body: detail.body,
        bodyTruncated: detail.bodyTruncated,
        state: detail.state,
        labels: [...detail.labels],
        updatedAt: detail.updatedAt,
        fetchedAt: detail.fetchedAt,
        dependencies: {
          status: detail.dependencies.status,
          items: detail.dependencies.items.map((d) => ({ ...d })),
          blockers: detail.dependencies.blockers,
          reason: detail.dependencies.reason,
        },
      },
      workflow: expansion,
      createdAt: this.ports.now(),
    });
    this.emittedForPreview = true;
    this.pendingRequest = packet;
    this.lastRequest = packet;
    this.notice = "Request prepared. Nothing launched or sent.";
    return { ok: true, value: packet };
  }

  /** Hand the packet to the host exactly once. */
  consumeRequest(): GeneratePromptRequest | undefined {
    const packet = this.pendingRequest;
    this.pendingRequest = undefined;
    return packet;
  }

  /** In-memory accessor for the most recent packet. Never written to disk here. */
  getLastRequest(): GeneratePromptRequest | undefined {
    return this.lastRequest;
  }

  /**
   * Step back one pane. From the list this returns "exit", which the host
   * turns into "give focus back to the workspace" — never into closing the
   * companion window.
   */
  back(): "exit" | TrackingView {
    switch (this.view) {
      case "preview":
        this.view = "execution";
        this.executionId = undefined;
        this.expansion = undefined;
        this.emittedForPreview = false;
        this.pendingRequest = undefined;
        this.notice = "Preview discarded. Nothing was prepared.";
        return this.view;
      case "execution":
        this.view = "provider";
        this.executionId = undefined;
        this.expansion = undefined;
        this.notice = "Choose a provider.";
        return this.view;
      case "provider":
        this.view = "workflow";
        this.providerId = undefined;
        this.notice = "Choose a workflow.";
        return this.view;
      case "workflow":
        this.view = "detail";
        this.resetPreview();
        this.notice = "Generation cancelled. Nothing launched or sent.";
        return this.view;
      case "detail":
        if (this.entry === "board") {
          this.view = "list";
          this.notice = "Back to the workboard.";
          return "exit";
        }
        this.view = "list";
        this.notice = "Back to the issue list.";
        return this.view;
      default:
        return "exit";
    }
  }
}
