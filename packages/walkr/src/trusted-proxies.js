import { BlockList, isIP } from "node:net";

/**
 * Proxy peers that hosted mode trusts as loopback peers, from HUMAN_REVIEW_TRUSTED_PROXIES: a comma-separated list
 * of exact IP addresses (IPv4 or IPv6). No CIDR range, host name or wildcard exists. A value that is not an IP address
 * throws, so a typo stops the start with a cause instead of a silent 403 on each request.
 */
export function trustedProxies(value = process.env.HUMAN_REVIEW_TRUSTED_PROXIES) {
  const items = String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
  const bad = items.filter((item) => !isIP(item) || item.includes("%"));
  if (bad.length) {
    throw new Error(`HUMAN_REVIEW_TRUSTED_PROXIES lists exact IP addresses only. Not an IP address: ${bad.join(", ")}`);
  }
  return items;
}

const familyOf = (address) => (isIP(address) === 6 ? "ipv6" : "ipv4");

/**
 * The decision whether a connection peer counts as local. A loopback address always does. In hosted mode a listed
 * proxy peer does too; outside hosted mode the list has no effect. The Host check stays with the caller.
 */
export function localPeerCheck({ hosted = false, proxies = [] } = {}) {
  const peers = new BlockList();
  peers.addSubnet("127.0.0.0", 8, "ipv4");
  peers.addAddress("::1", "ipv6");
  if (hosted) for (const address of proxies) peers.addAddress(address, familyOf(address));
  return (peer) => Boolean(peer) && isIP(peer) !== 0 && peers.check(peer, familyOf(peer));
}
