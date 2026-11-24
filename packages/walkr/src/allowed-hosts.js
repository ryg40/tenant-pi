import fs from "node:fs";

/**
 * Extra Host header values that the server accepts, from HUMAN_REVIEW_ALLOWED_HOSTS: a comma-separated list of exact
 * `name:port` values. The default is none, so a DNS-rebound host name is refused. The owner names each value;
 * no wildcard exists. With HUMAN_REVIEW_BIND it opens the Compare page to another computer. The server accepts
 * such a host only for the Compare routes and the theme files; every other route stays loopback-only.
 */
export function allowedHosts(value = process.env.HUMAN_REVIEW_ALLOWED_HOSTS) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => /^[a-z0-9.-]+:\d{1,5}$|^\[[0-9a-f:]+\]:\d{1,5}$/.test(item));
}

// The key `walkrPublicOrigin` of the artifacts config file: the one public origin of the Compare page behind a reverse
// proxy, exactly `https://<name>` or `https://<name>:<port>`. The copy of PUBLIC_ORIGIN in
// packages/artifacts/server/artifacts_store.py has the same rule: a DNS name (no IP address, no loopback name), no path,
// no query, no user part, a port from 1 to 65535 and not 443 (a browser sends no port for 443).
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const PUBLIC_ORIGIN = new RegExp(`^https://(${LABEL}(?:\\.${LABEL})*)(?::([1-9][0-9]{0,4}))?$`);
export const PUBLIC_KEY = "walkrPublicOrigin";

/** `{ origin, host }` in lower case for a value of the rule above, else null. `host` is the value of a Host header. */
export function parsePublicOrigin(value) {
  if (typeof value !== "string" || !/^[\x21-\x7e]+$/.test(value)) return null;
  const origin = value.toLowerCase();
  const match = PUBLIC_ORIGIN.exec(origin);
  if (!match) return null;
  const [, name, port] = match;
  // A last label of digits or of 0x hex makes the name an IPv4 address in a browser (the URL standard).
  if (name.length > 253 || /^(?:[0-9]+|0x[0-9a-f]*)$/.test(name.split(".").pop()) || name === "localhost"
    || name.endsWith(".localhost") || port && (Number(port) > 65535 || port === "443")) return null;
  return { origin, host: origin.slice("https://".length) };
}

/**
 * The public origin of the key walkrPublicOrigin in the artifacts config file `file`, or null without the key. A
 * file that cannot be read or a value that does not fit the rule gives null and one line to `warn` (fail closed).
 */
export function publicOrigin(file, warn = () => {}) {
  let data;
  try { data = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if (error.code !== "ENOENT") warn(`walkr: public origin off: cannot read ${file} (${error.code || error.name})`);
    return null;
  }
  const value = data && typeof data === "object" && !Array.isArray(data) ? data[PUBLIC_KEY] : undefined;
  if (value === undefined || value === null) return null;
  const parsed = parsePublicOrigin(value);
  if (!parsed) warn(`walkr: public origin off: ${PUBLIC_KEY} in ${file} is not one origin https://NAME or https://NAME:PORT`);
  return parsed;
}
