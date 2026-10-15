/**
 * The contract of the shared AgentCore Memory core.
 *
 * This file holds types and function signatures only. It has no code.
 * The core implementation ticket implements it in `src/index.mjs`.
 * The Pi extension, the Claude Code plugin, the review CLI and the
 * registry script build against this file. A change of this file is a
 * change of the contract and needs the coordinator's word.
 *
 * Rules that every implementation keeps:
 * - No function logs an SDK error text, a query text or a record text.
 *   A diagnostic is a static code of `MemoryErrorCode`.
 * - No function reads a credential. The SDK credential chain reads the
 *   AWS profile that the config names.
 * - A write happens only after the confirm callback returns true.
 * - Recall never names a proposals namespace or a rejected namespace.
 * - No function deletes a record. Approve and reject move a record.
 * - Every namespace comes from `Namespaces`, never from a caller string.
 */

/** A person id or a project id: `[a-z0-9][a-z0-9-]{0,63}`. No wildcard, no slash, no colon. */
export type ActorId = string;
export type ProjectId = string;

/** A namespace: a leading slash, segments of ids, a trailing slash. */
export type Namespace = string;

/** The harness that runs the core. The CLI reports `cli`. */
export type Harness = "pi" | "claude-code" | "cli";

export type Role = "member" | "maintainer";

/** One project of a person's local config. The registry script renders it. */
export interface ProjectMembership {
  projectId: ProjectId;
  role: Role;
  /** Git remote URLs of the project, in any common form. Matched after normalization. */
  remotes?: string[];
  /** Local directories of the project. `~` expands to the home directory. */
  directories?: string[];
}

/**
 * The local config of one person. One file serves Pi, Claude Code and the CLI.
 * It holds no key. `profile` names an AWS profile of the shared credentials file.
 */
export interface MemoryConfig {
  schemaVersion: 1;
  memoryId: string;
  /** An AWS region, for example `us-east-1`. */
  region: string;
  /** The AWS profile of the person. Absent: the default credential chain. */
  profile?: string;
  actorId: ActorId;
  projects: ProjectMembership[];
  /** Results per namespace, 1 to 100. Default 10. */
  topK?: number;
  /** Per-call deadline of a recall in milliseconds, 1 to 600000. Default 3000. */
  recallTimeoutMs?: number;
  /** Per-call deadline of a write or a move in milliseconds. Default 10000. */
  writeTimeoutMs?: number;
  /** The private review ledger of a maintainer, JSON Lines, outside any repository. */
  ledgerPath?: string;
  /** The value of the metadata key `host`. Default: the operating system host name. */
  hostLabel?: string;
}

/** The config sources, in this order: `AGENTCORE_MEMORY_CONFIG` (inline JSON), `AGENTCORE_MEMORY_CONFIG_FILE`, the default path. */
export interface ConfigSource {
  /** `~/.config/agentcore-memory/config.json`, or below `XDG_CONFIG_HOME` when set. */
  defaultPath: string;
  /** The kill switch. When `AGENTCORE_MEMORY_DISABLE` is `1`, `loadConfig` returns null. */
  disableVariable: "AGENTCORE_MEMORY_DISABLE";
}

/** Who makes a call. The harness fills it. The core copies it into record metadata. */
export interface Origin {
  /** The agent name, for example the Pi profile name or `claude-code`. */
  agent: string;
  harness: Harness;
  /** The session id of the harness. */
  session: string;
}

/** The metadata of a record. All values are strings. At most 20 keys. */
export interface RecordMetadata {
  actorId: ActorId;
  projectId: ProjectId;
  agent: string;
  harness: Harness;
  host: string;
  session: string;
  /** ISO 8601, UTC. */
  proposedAt: string;
  /** Set by approve. */
  approvedBy?: ActorId;
  approvedAt?: string;
  /** Set by reject. The reason stays in the private ledger. */
  rejectedBy?: ActorId;
  rejectedAt?: string;
}

/** The result of the project resolution. `source` says which rule matched. */
export interface ProjectResolution {
  projectId: ProjectId | null;
  role: Role | null;
  source: "env" | "remote" | "directory" | "none";
  /** A static reason when `projectId` is null and a rule refused: `env_not_member`, `env_invalid`. */
  reason?: "env_not_member" | "env_invalid";
}

export interface RecalledRecord {
  memoryRecordId: string;
  namespaces: Namespace[];
  text: string;
  score?: number;
  metadata?: Partial<RecordMetadata>;
}

export interface RecallResult {
  records: RecalledRecord[];
  /** The namespaces whose query failed or timed out. The turn continues. */
  failed: Namespace[];
}

export interface ProposalSummary {
  memoryRecordId: string;
  namespace: Namespace;
  actorId: ActorId;
  projectId: ProjectId;
  text: string;
  /** ISO 8601 from the record. */
  createdAt: string;
  metadata: Partial<RecordMetadata>;
}

/** What a person sees before a write. The harness shows it; the person answers. */
export interface ProposePreview {
  action: "propose";
  projectId: ProjectId;
  namespace: Namespace;
  text: string;
  metadata: RecordMetadata;
}

/** What a maintainer sees before an approve or a reject. */
export interface ReviewPreview {
  action: "approve" | "reject";
  projectId: ProjectId;
  proposal: ProposalSummary;
  /** The target namespace of an approve. */
  targetNamespace?: Namespace;
  reason?: string;
}

/** The confirmation gate. False or a throw stops the write. */
export type ConfirmFn = (preview: ProposePreview | ReviewPreview) => Promise<boolean>;

export interface ProposeResult {
  memoryRecordId: string;
  namespace: Namespace;
  requestIdentifier: string;
}

/** A move keeps the record id. */
export interface MoveResult {
  memoryRecordId: string;
  sourceNamespace: Namespace;
  targetNamespace: Namespace;
}

export type ApproveResult = MoveResult;
export type RejectResult = MoveResult;

/** Static diagnostics. No code carries request data. */
export type MemoryErrorCode =
  | "config"
  | "disabled"
  | "project_none"
  | "not_member"
  | "not_maintainer"
  | "text_empty"
  | "text_too_long"
  | "not_confirmed"
  | "proposal_missing"
  | "proposal_outside_project"
  | "ledger"
  | "aws_denied"
  | "aws_failed"
  | "timeout";

export interface MemoryError extends Error {
  code: MemoryErrorCode;
}

/** The namespace builder. Every id passes `validateId` first. */
export interface Namespaces {
  /** `/shared/` */
  global(): Namespace;
  /** `/actor/{actorId}/` */
  actor(actorId: ActorId): Namespace;
  /** `/project/{projectId}/shared/` */
  projectShared(projectId: ProjectId): Namespace;
  /** `/project/{projectId}/proposals/{actorId}/` */
  proposals(projectId: ProjectId, actorId: ActorId): Namespace;
  /** `/project/{projectId}/proposals/`, the prefix of every proposals namespace of the project. */
  proposalsOfProject(projectId: ProjectId): Namespace;
  /** `/project/{projectId}/rejected/{actorId}/` */
  rejected(projectId: ProjectId, actorId: ActorId): Namespace;
  /** `/project/{projectId}/rejected/`, the prefix of every rejected namespace of the project. */
  rejectedOfProject(projectId: ProjectId): Namespace;
  /** The recall set: global, actor, and the project shared namespace when `projectId` is set. Never a proposals or a rejected namespace. */
  recallSet(actorId: ActorId, projectId: ProjectId | null): Namespace[];
}

/** The AWS client of the core. The tests replace it. No method retries. */
export interface MemoryClient {
  retrieve(input: {
    memoryId: string;
    namespace: Namespace;
    searchCriteria: { searchQuery: string; topK: number };
    maxResults: number;
  }, options: { abortSignal: AbortSignal }): Promise<{ memoryRecordSummaries?: RecordSummaryLike[] }>;
  list(input: {
    memoryId: string;
    namespace: Namespace;
    maxResults: number;
    nextToken?: string;
  }, options: { abortSignal: AbortSignal }): Promise<{ memoryRecordSummaries?: RecordSummaryLike[]; nextToken?: string }>;
  batchCreate(input: {
    memoryId: string;
    clientToken: string;
    records: Array<{
      requestIdentifier: string;
      namespaces: Namespace[];
      content: { text: string };
      timestamp: Date;
      metadata: Record<string, { stringValue: string }>;
    }>;
  }, options: { abortSignal: AbortSignal }): Promise<{
    successfulRecords: Array<{ memoryRecordId: string; status: string; requestIdentifier?: string }>;
    failedRecords: Array<{ memoryRecordId?: string; status: string; requestIdentifier?: string }>;
  }>;
  /** The move of approve and reject: one record, `sourceNamespaces` and `namespaces` with one entry each, no `content`. */
  batchUpdate(input: {
    memoryId: string;
    records: Array<{
      memoryRecordId: string;
      timestamp: Date;
      namespaces: Namespace[];
      sourceNamespaces: Namespace[];
      metadata: Record<string, { stringValue: string }>;
    }>;
  }, options: { abortSignal: AbortSignal }): Promise<{
    successfulRecords: Array<{ memoryRecordId: string; status: string }>;
    failedRecords: Array<{ memoryRecordId?: string; status: string }>;
  }>;
  destroy(): void;
}

/** The shape of a record summary as the SDK returns it. Unknown fields are ignored. */
export interface RecordSummaryLike {
  memoryRecordId: string;
  namespaces?: Namespace[];
  content?: { text?: string };
  createdAt?: Date | string;
  score?: number;
  metadata?: Record<string, { stringValue?: string }>;
}

/** One line of the private review ledger. Append only. */
export interface LedgerEntry {
  at: string;
  /** The line before the move names the intent; the line after it names the result. */
  action: "approve" | "approve-done" | "reject" | "reject-done";
  maintainer: ActorId;
  projectId: ProjectId;
  proposalRecordId: string;
  actorId: ActorId;
  text: string;
  metadata: Partial<RecordMetadata>;
  reason?: string;
  targetNamespace?: Namespace;
}

export interface ReviewLedger {
  append(entry: LedgerEntry): Promise<void>;
  /** The entries of one record, oldest first. Used to report an interrupted move. */
  entriesFor(proposalRecordId: string): Promise<LedgerEntry[]>;
}

/** The injectable parts. A test gives fakes. The defaults use the SDK, Git and the file system. */
export interface CoreDependencies {
  createClient?: (config: MemoryConfig) => Promise<MemoryClient>;
  /** The `origin` remote URL of a directory, or null. Bounded, no shell. */
  gitRemote?: (cwd: string) => Promise<string | null>;
  ledger?: ReviewLedger;
  now?: () => Date;
  hostname?: () => string;
  /** A static line. Never request data. */
  log?: (line: string) => void;
}

export interface MemoryCore {
  readonly config: MemoryConfig;
  readonly namespaces: Namespaces;

  /** `AGENTCORE_PROJECT`, then the Git remote, then the directory. See `ProjectResolution`. */
  resolveProject(input: { cwd: string; env: Record<string, string | undefined> }): Promise<ProjectResolution>;

  /** One query per namespace of the recall set. A failed namespace is reported, not thrown. */
  recall(input: { query: string; projectId: ProjectId | null; signal?: AbortSignal }): Promise<RecallResult>;

  /** The one context block of both harnesses. Null when there is no record. */
  formatContext(result: RecallResult): string | null;

  /** One record into the proposals namespace of the person for the project. Refuses without a project or a membership. */
  propose(input: { text: string; projectId: ProjectId; origin: Origin }, confirm: ConfirmFn): Promise<ProposeResult>;

  /** The proposals of a project, all members, through the proposals prefix. Needs the maintainer role. */
  listProposals(input: { projectId: ProjectId; actorId?: ActorId }): Promise<ProposalSummary[]>;

  /** One proposal by id, found through `listProposals`. Null when absent. */
  showProposal(input: { projectId: ProjectId; memoryRecordId: string }): Promise<ProposalSummary | null>;

  /** Journal, then move the proposal to the shared namespace of the project with `approvedBy` and `approvedAt`, then journal. No copy, no delete. */
  approve(input: { projectId: ProjectId; memoryRecordId: string; reason?: string; reviewer: Origin }, confirm: ConfirmFn): Promise<ApproveResult>;

  /** Journal with the reason, then move the proposal to the rejected namespace of its actor with `rejectedBy` and `rejectedAt`, then journal. */
  reject(input: { projectId: ProjectId; memoryRecordId: string; reason: string; reviewer: Origin }, confirm: ConfirmFn): Promise<RejectResult>;

  /** Abort pending calls and destroy the client. */
  close(): Promise<void>;
}

/* The registry. The registry script of the owner host reads and renders it. The core validates it
 * and decides the scope of each identity, so the IAM renderer and the local checks agree. */

export interface Person {
  actorId: ActorId;
  name: string;
  /** A contact field. Never part of a namespace, an IAM name or a record. */
  email: string;
  /** A person number for a human reader, `XYZ` followed by four digits. Not a credential. */
  pin?: string;
  status: "active" | "offboarded";
}

export interface Project {
  projectId: ProjectId;
  maintainers: ActorId[];
  members: ActorId[];
  /** Rendered into the person config of each member. */
  remotes?: string[];
}

export interface Registry {
  schemaVersion: 1;
  memory: { region: string; memoryId: string };
  /** The two fixed identities. The IAM user names live in the private registry. */
  service: { submitUser: string; workerReadUser: string };
  people: Person[];
  projects: Project[];
}

/** The namespace scope of one identity. The IAM renderer and the local checks read it. */
export interface IdentityScope {
  /** Patterns for the read statement, each ends with `*`. */
  read: string[];
  /** Patterns for the write statement (`BatchCreateMemoryRecords`), each ends with `*`. */
  write: string[];
  /** Patterns for the move statement (`BatchUpdateMemoryRecords`): the proposals, shared and rejected trees of each maintained project. Empty for a member. No identity has a delete statement. */
  move: string[];
}

export interface MemoryCoreModule {
  /** Null when the kill switch is set or no source has a config. Throws `config` on an invalid value. */
  loadConfig(env: Record<string, string | undefined>): MemoryConfig | null;
  validateConfig(value: unknown): MemoryConfig;
  /** Throws `config` on an id outside `[a-z0-9][a-z0-9-]{0,63}`. */
  validateId(value: unknown): ActorId;
  namespaces: Namespaces;
  createCore(config: MemoryConfig, deps?: CoreDependencies): MemoryCore;
  /** The 64 hex characters of a SHA-256 over the actor, the project, the text and the time. */
  requestIdentifier(input: { actorId: ActorId; projectId: ProjectId; text: string; proposedAt: string }): string;

  validateRegistry(value: unknown): Registry;
  /** The scope of a person: own actor, own proposals and shared of each member project; the proposals and rejected trees of each maintained project in `read`, its three trees in `move`. */
  personScope(registry: Registry, actorId: ActorId): IdentityScope;
  /** `/shared/*` and `/actor/*` for writes, moves and reads; no delete. */
  submitScope(registry: Registry): IdentityScope;
  /** `/shared/*` and `/project/*/shared/*` for reads; no write, no move, no delete. */
  workerScope(registry: Registry): IdentityScope;
  /** The person config without `profile`, `ledgerPath` and `hostLabel`. */
  renderPersonConfig(registry: Registry, actorId: ActorId): MemoryConfig;
}
