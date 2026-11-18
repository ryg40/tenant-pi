export type Slot = "1" | "2";
export const SLOTS: Slot[];
export class AccountError extends Error {}
export interface Login { oauth?: Record<string, unknown>; account?: Record<string, unknown> }
export interface SlotSource { slot: Slot; active: boolean; configDir: string; renewable: boolean; accountKey?: string }
export interface Options { env?: NodeJS.ProcessEnv; home?: string; now?: number }
export function accountsRoot(env?: NodeJS.ProcessEnv, home?: string): string;
export function slotDir(root: string, slot: string): string;
export function liveDir(env?: NodeJS.ProcessEnv, home?: string): string;
export function liveClaudeJson(env?: NodeJS.ProcessEnv, home?: string): string;
export function isSlot(value: unknown): value is Slot;
export function writeAtomic(path: string, value: unknown): void;
export function readState(root: string): { active: Slot; switchedAt: number } | undefined;
export function storeExists(root: string): boolean;
export function readLogin(credentialsPath: string, claudeJsonPath: string, read?: (path: string) => unknown): Login;
export function slotLogin(root: string, slot: string, read?: (path: string) => unknown): Login;
export function liveLogin(env?: NodeJS.ProcessEnv, home?: string, read?: (path: string) => unknown): Login;
export function accountKey(uuid: unknown): string | undefined;
export function sameAccount(a: Login, b: Login): boolean;
export function slotOfLive(root: string, env?: NodeJS.ProcessEnv, home?: string, read?: (path: string) => unknown): Slot | undefined;
export function slotSources(root: string, env?: NodeJS.ProcessEnv, home?: string, read?: (path: string) => unknown): SlotSource[] | undefined;
export function adopt(slot: string, options?: Options): { slot: Slot };
export function use(slot: string, options?: Options): { slot: Slot; previous?: Slot; changed: boolean };
export function login(slot: string, options?: Options & { claude?: string; run?: (...args: never[]) => { status: number | null; error?: Error } }): { slot: Slot; status: number };
export interface SlotStatus { slot: Slot; active: boolean; login: boolean; plan?: string; token: "none" | "valid" | "expired"; expiresAt?: number; email?: string }
export function status(options?: Options & { email?: boolean }): { store: boolean; stateActive?: Slot; liveSaved: boolean; slots: SlotStatus[] };
export const RENEW_PERIOD_MS: number;
export function claimRenew(cacheDir: string, slot: string, now: number): boolean;
export function renewSlot(configDir: string, options?: { env?: NodeJS.ProcessEnv; claude?: string; timeoutMs?: number; killMs?: number }): Promise<boolean>;
