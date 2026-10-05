export type BriefingTarget = { origin: string; docName: string };

export function briefingTarget(origin: string, docName: string): BriefingTarget {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use an HTTPS origin without credentials, path, query or fragment.");
  }
  if (!/^projects\/[a-z0-9][a-z0-9_-]{0,79}\/brief$/.test(docName)) {
    throw new Error("Use projects/<project-id>/brief (lowercase letters, digits, - or _).");
  }
  return { origin: url.origin, docName };
}

export function validateBriefing(text: unknown): asserts text is string {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > 256 * 1024
    || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/.test(text)) {
    throw new Error("Briefing must be Markdown text, at most 256 KiB, without terminal control characters.");
  }
}

/**
 * History page hypothesis: a briefing at `projects/<id>/brief` keeps additive
 * history at `projects/<id>/handoffs`. Illustrative working tree, not a verified
 * schema — callers must treat a failed history sync as pending, never fatal.
 */
export function historyDocName(docName: string): string {
  if (!docName.endsWith("/brief") || docName.length <= "/brief".length) {
    throw new Error("History sync needs a projects/<project-id>/brief target.");
  }
  return `${docName.slice(0, -"/brief".length)}/handoffs`;
}

/** Thin pinned-upstream adapter. No redirects, retries, logs or credential persistence. */
export class OpenKnowledgeBriefing {
  readonly target: BriefingTarget;
  private readonly authorization: string;
  private readonly request: typeof fetch;
  constructor(target: BriefingTarget, env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
    this.request = request;
    this.target = briefingTarget(target.origin, target.docName);
    if (!env.OPENKNOWLEDGE_USERNAME || !env.OPENKNOWLEDGE_PASSWORD) {
      throw new Error("Export OPENKNOWLEDGE_USERNAME and OPENKNOWLEDGE_PASSWORD before starting Pi; local save remains available.");
    }
    this.authorization = `Basic ${Buffer.from(`${env.OPENKNOWLEDGE_USERNAME}:${env.OPENKNOWLEDGE_PASSWORD}`).toString("base64")}`;
  }
  private async call(route: string, body?: object): Promise<Response> {
    try {
      return await this.request(`${this.target.origin}/api/${route}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: this.authorization, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error("OpenKnowledge unavailable (network, timeout or redirect); local copy retained."); }
  }
  async read(): Promise<string | null> {
    const response = await this.call(`document?docName=${encodeURIComponent(this.target.docName)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenKnowledge read HTTP ${response.status}; local copy retained.`);
    let data: { docName?: unknown; content?: unknown };
    try { data = await response.json() as typeof data; } catch { throw new Error("Invalid OpenKnowledge document response."); }
    if (!data || data.docName !== this.target.docName) throw new Error("OpenKnowledge returned a different document.");
    validateBriefing(data.content);
    return data.content;
  }
  async write(text: string, missing: boolean): Promise<void> {
    validateBriefing(text);
    if (missing) {
      const created = await this.call("create-page", { path: `${this.target.docName}.md` });
      // A concurrent create is a conflict, not permission to replace its contents.
      if (!created.ok) throw new Error(`OpenKnowledge create HTTP ${created.status}; refresh before retrying.`);
    }
    const response = await this.call("agent-write-md", {
      docName: this.target.docName, markdown: text, position: "replace",
      summary: "Update project briefing", clientName: "promptr",
    });
    if (!response.ok) throw new Error(`OpenKnowledge write HTTP ${response.status}; outcome unknown, refresh before retrying.`);
  }
  /** Best-effort additive history record. A missing history page is created; an
   * existing one is appended to, never replaced. Throws on failure so callers
   * can show pending sync without blocking local continuation. */
  async appendHistory(markdown: string): Promise<void> {
    validateBriefing(markdown);
    const history = historyDocName(this.target.docName);
    const created = await this.call("create-page", { path: `${history}.md` });
    // 409 means the history page already exists — the expected case after first use.
    if (!created.ok && created.status !== 409) {
      throw new Error(`OpenKnowledge create HTTP ${created.status}; history not synced, local copy retained.`);
    }
    const response = await this.call("agent-write-md", {
      docName: history, markdown: `\n\n---\n\n${markdown}`, position: "append",
      summary: "Promptr automatic context wrap-up", clientName: "promptr",
    });
    if (!response.ok) throw new Error(`OpenKnowledge history write HTTP ${response.status}; local copy retained.`);
  }
}

const DEFAULT_OPENKNOWLEDGE_ORIGIN = "https://openknowledge.example.com";
const UNAVAILABLE = "OpenKnowledge unavailable (network, timeout or redirect); local copy retained.";

/** Origin from OPENKNOWLEDGE_ORIGIN (trimmed) or the pinned default; validated like a briefing target. */
export function openKnowledgeOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env.OPENKNOWLEDGE_ORIGIN?.trim();
  return briefingTarget(raw ? raw : DEFAULT_OPENKNOWLEDGE_ORIGIN, "projects/promptr/brief").origin;
}

export function hasOpenKnowledgeCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENKNOWLEDGE_USERNAME && env.OPENKNOWLEDGE_PASSWORD);
}

/** Generic pinned-upstream adapter for any document: same request rules as the briefing adapter. */
export class OpenKnowledgeClient {
  readonly origin: string;
  private readonly authorization: string;
  private readonly request: typeof fetch;
  constructor(origin: string, env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
    this.origin = briefingTarget(origin, "projects/promptr/brief").origin;
    this.request = request;
    if (!env.OPENKNOWLEDGE_USERNAME || !env.OPENKNOWLEDGE_PASSWORD) {
      throw new Error("Export OPENKNOWLEDGE_USERNAME and OPENKNOWLEDGE_PASSWORD before starting Pi; local save remains available.");
    }
    this.authorization = `Basic ${Buffer.from(`${env.OPENKNOWLEDGE_USERNAME}:${env.OPENKNOWLEDGE_PASSWORD}`).toString("base64")}`;
  }
  static fromEnv(origin: string, env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): OpenKnowledgeClient | undefined {
    if (!hasOpenKnowledgeCredentials(env)) return undefined;
    return new OpenKnowledgeClient(origin, env, request);
  }
  private async call(route: string, body?: object): Promise<Response> {
    try {
      return await this.request(`${this.origin}/api/${route}`, {
        method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { Authorization: this.authorization, ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
    } catch { throw new Error(UNAVAILABLE); }
  }
  async readDocument(docName: string): Promise<string | null> {
    const response = await this.call(`document?docName=${encodeURIComponent(docName)}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`OpenKnowledge read HTTP ${response.status}`);
    let data: { docName?: unknown; content?: unknown };
    try { data = await response.json() as typeof data; } catch { throw new Error("Invalid OpenKnowledge document response."); }
    if (!data || data.docName !== docName) throw new Error("OpenKnowledge returned a different document.");
    validateBriefing(data.content);
    return data.content;
  }
  async createPage(docName: string): Promise<"created" | "exists"> {
    const response = await this.call("create-page", { path: `${docName}.md` });
    if (response.status === 409) return "exists";
    if (!response.ok) throw new Error(`OpenKnowledge create HTTP ${response.status}`);
    return "created";
  }
  async writeMarkdown(docName: string, markdown: string, position: "replace" | "append", summary: string): Promise<void> {
    validateBriefing(markdown);
    const response = await this.call("agent-write-md", { docName, markdown, position, summary, clientName: "promptr" });
    if (!response.ok) throw new Error(`OpenKnowledge write HTTP ${response.status}`);
  }
}
