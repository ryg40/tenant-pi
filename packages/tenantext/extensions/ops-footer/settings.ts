import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { dirname, join } from "node:path";

export interface Settings {
  enabled: boolean;
  placement: "belowEditor";
  minimumRows: number; maximumRows: number;
  healthPollSeconds: number; healthTimeoutMs: number; gitCacheMs: number; gitIdlePollSeconds: number;
  showHealthyServices: boolean; showUnavailableOptionalSources: boolean;
  healthUrls: Partial<Record<"OK" | "OV", string>>;
}
export const defaults: Settings = {
  enabled: true, placement: "belowEditor", minimumRows: 1, maximumRows: 8,
  healthPollSeconds: 60, healthTimeoutMs: 2000, gitCacheMs: 1000, gitIdlePollSeconds: 15,
  showHealthyServices: false, showUnavailableOptionalSources: false, healthUrls: {},
};
export const settingsPath = () => join(getAgentDir(), "ops-footer", "settings.json");
export function healthUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2048) return;
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) return;
    return url.href;
  } catch { return; }
}
export function parseSettings(value: unknown): Settings {
  const out = { ...defaults, healthUrls: {} } as Settings;
  if (!value || typeof value !== "object") return out;
  const v = value as Record<string, unknown>;
  for (const key of ["enabled", "showHealthyServices", "showUnavailableOptionalSources"] as const) {
    if (typeof v[key] === "boolean") out[key] = v[key];
  }
  for (const [key, low, high] of [["minimumRows", 1, 12], ["maximumRows", 3, 12],
    ["healthPollSeconds", 10, 3600], ["healthTimeoutMs", 100, 10000], ["gitCacheMs", 250, 60000], ["gitIdlePollSeconds", 2, 3600]] as const) {
    const n = v[key];
    if (typeof n === "number" && Number.isFinite(n)) out[key] = Math.max(low, Math.min(high, Math.floor(n)));
  }
  out.minimumRows = Math.min(out.minimumRows, out.maximumRows);
  const urls = v.healthUrls as Record<string, unknown> | undefined;
  for (const key of ["OK", "OV"] as const) {
    const url = healthUrl(urls?.[key]);
    if (url) out.healthUrls[key] = url;
  }
  return out;
}
export async function loadLocalSettings(path = settingsPath()): Promise<Settings> {
  try { return parseSettings(JSON.parse(await readFile(path, "utf8"))); }
  catch { return parseSettings({}); }
}
export async function loadSettings(path = settingsPath()): Promise<Settings> {
  const settings = await loadLocalSettings(path);
  for (const key of ["OK", "OV"] as const) {
    const url = healthUrl(process.env[`OPS_FOOTER_${key}_HEALTH_URL`]);
    if (url) settings.healthUrls[key] = url;
  }
  return settings;
}
export async function saveSettings(settings: Settings, path = settingsPath(), persistHealthUrls = false): Promise<void> {
  // Ordinary saves preserve local endpoints and never persist environment overrides.
  const urls = persistHealthUrls ? settings.healthUrls : (await loadLocalSettings(path)).healthUrls;
  const safeUrls: Settings["healthUrls"] = {};
  for (const key of ["OK", "OV"] as const) {
    const url = healthUrl(urls[key]);
    if (url) safeUrls[key] = url;
  }
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ ...parseSettings(settings), healthUrls: safeUrls }, null, 2) + "\n", { mode: 0o600 });
  await rename(temporary, path);
}

/** Populate missing/blank settings and a read-only example without replacing user values. */
export async function ensureSettings(path = settingsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  let missing = false;
  try { missing = !(await readFile(path, "utf8")).trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; missing = true; }
  if (missing) {
    // The first writer wins if another Pi instance creates the file at the same time.
    try { await writeFile(path, JSON.stringify(defaults, null, 2) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (!(await readFile(path, "utf8")).trim()) await saveSettings(defaults, path, true);
    }
  }
  const guide = join(dirname(path), "settings.example.jsonc");
  try { await writeFile(guide, `// Operations footer options. Copy values into settings.json (plain JSON, without comments).\n{\n  // enabled: true | false — show the operations footer.\n  "enabled": true,\n  // placement: "belowEditor" — fixed location.\n  "placement": "belowEditor",\n  // minimumRows: 1–12, not greater than maximumRows.\n  "minimumRows": 1,\n  // maximumRows: 3–12, not less than minimumRows.\n  "maximumRows": 8,\n  // healthPollSeconds: 10–3600 seconds.\n  "healthPollSeconds": 60,\n  // healthTimeoutMs: 100–10000 milliseconds.\n  "healthTimeoutMs": 2000,\n  // gitCacheMs: 250–60000 milliseconds; the Git poll interval during an agent turn.\n  "gitCacheMs": 1000,\n  // gitIdlePollSeconds: 2–3600 seconds; the Git poll interval while the agent is idle.\n  "gitIdlePollSeconds": 15,\n  // showHealthyServices: true | false.\n  "showHealthyServices": false,\n  // showUnavailableOptionalSources: true | false.\n  "showUnavailableOptionalSources": false,\n  // healthUrls: optional credential-free, query-free HTTP(S) URLs; empty means disabled.\n  "healthUrls": { "OK": "", "OV": "" }\n}\n`, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}
