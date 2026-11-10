/**
 * Extra Host header values that the server accepts, from HUMAN_REVIEW_ALLOWED_HOSTS: a comma-separated list of exact
 * `name:port` values. The default is none, so a DNS-rebound host name is refused. The owner names each value;
 * no wildcard exists. With HUMAN_REVIEW_BIND it opens the Compare page to another computer. The server accepts
 * such a host only for the Compare routes and the theme files; every other route stays loopback-only.
 */
export function allowedHosts(value = process.env.HUMAN_REVIEW_ALLOWED_HOSTS) {
  return String(value || "").split(",").map((item) => item.trim().toLowerCase()).filter((item) => /^[a-z0-9.-]+:\d{1,5}$|^\[[0-9a-f:]+\]:\d{1,5}$/.test(item));
}
