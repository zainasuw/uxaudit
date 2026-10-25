// Decides which URLs UXAudit is allowed to open. The browser runs on the
// user's machine, so a pasted URL must never reach localhost, private
// networks, cloud metadata endpoints or local files. Every request the page
// makes (including redirects and subresources) is checked with the same rules.

import dns from "node:dns/promises";
import net from "node:net";

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

export const MAX_URL_LENGTH = 2048;

const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data"]);
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home", ".lan", ".localdomain", ".onion"];

function ipv4ToNumber(ip: string): number {
  const parts = ip.split(".").map(Number);
  return ((parts[0]! << 24) >>> 0) + (parts[1]! << 16) + (parts[2]! << 8) + parts[3]!;
}

function inCidr4(ip: string, cidr: string): boolean {
  const [base, bits] = cidr.split("/") as [string, string];
  const mask = bits === "0" ? 0 : (~0 << (32 - Number(bits))) >>> 0;
  return ((ipv4ToNumber(ip) & mask) >>> 0) === ((ipv4ToNumber(base) & mask) >>> 0);
}

const PRIVATE_V4 = [
  "0.0.0.0/8", // "this" network
  "10.0.0.0/8",
  "100.64.0.0/10", // carrier-grade NAT
  "127.0.0.0/8",
  "169.254.0.0/16", // link-local, includes cloud metadata 169.254.169.254
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4", // multicast
  "240.0.0.0/4", // reserved + broadcast
];

/** Expand an IPv6 address into eight 16-bit groups; null when it is not valid. */
function expandIpv6(ip: string): number[] | null {
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone !== -1) addr = addr.slice(0, zone);
  // Embedded IPv4 (::ffff:1.2.3.4) becomes two hex groups.
  const v4 = /:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (v4) {
    const n = ipv4ToNumber(v4[1]!);
    addr = addr.slice(0, -v4[1]!.length) + ((n >>> 16) & 0xffff).toString(16) + ":" + (n & 0xffff).toString(16);
  }
  const halves = addr.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...head, ...Array(missing).fill("0"), ...tail].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => Number.isFinite(g)) ? groups : null;
}

export function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) return PRIVATE_V4.some((cidr) => inCidr4(ip, cidr));
  if (!net.isIPv6(ip)) return true; // unknown shapes are never public
  const g = expandIpv6(ip);
  if (!g) return true;
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  const isZero = g.slice(0, 5).every((x) => x === 0);
  if (isZero && g5 === 0 && g6 === 0 && (g7 === 0 || g7 === 1)) return true; // :: and ::1
  if (isZero && g5 === 0xffff) {
    // IPv4-mapped: apply the IPv4 rules to the embedded address.
    return isPrivateIp(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`);
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return isPrivateIp(`${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`); // NAT64
  }
  if ((g0 & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((g0 & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  if ((g0 & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isBlockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return true;
  if (!host.includes(".") && !net.isIP(host)) return true; // bare intranet names
  return false;
}

/**
 * Validates the shape of a pasted URL without touching the network.
 * `allowPrivate` exists for the test suite, whose fixture server runs on
 * loopback; the application never sets it.
 */
export function parseTargetUrl(input: unknown, opts: { allowPrivate?: boolean } = {}): URL {
  if (typeof input !== "string" || !input.trim()) throw new BlockedUrlError("Paste a website address to analyze.");
  const text = input.trim();
  if (text.length > MAX_URL_LENGTH) throw new BlockedUrlError("That address is too long.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new BlockedUrlError("That does not look like a valid website address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new BlockedUrlError(`Only http and https addresses can be analyzed (got ${url.protocol.replace(":", "")}).`);
  }
  if (url.username || url.password) throw new BlockedUrlError("Addresses with embedded credentials are not allowed.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (opts.allowPrivate) return url;
  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new BlockedUrlError("Private, local and reserved network addresses cannot be analyzed.");
  } else if (isBlockedHostname(host)) {
    throw new BlockedUrlError("Local and internal host names cannot be analyzed. Use a public website address.");
  }
  return url;
}

export type Lookup = (hostname: string) => Promise<string[]>;

export const systemLookup: Lookup = async (hostname) => {
  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  return records.map((r) => r.address);
};

/**
 * Resolves a host and refuses it when ANY of its addresses is private. A host
 * that resolves to nothing is refused too. Results are cached per guard so the
 * dozens of requests a page makes do not re-resolve the same names.
 */
export type HostVerdict = "public" | "private" | "unresolvable";

export function createHostGuard(lookup: Lookup = systemLookup) {
  const cache = new Map<string, Promise<HostVerdict>>();
  async function classify(hostname: string): Promise<HostVerdict> {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    if (net.isIP(host)) return isPrivateIp(host) ? "private" : "public";
    if (isBlockedHostname(host)) return "private";
    let pending = cache.get(host);
    if (!pending) {
      pending = lookup(host)
        .then((addresses): HostVerdict => {
          if (addresses.length === 0) return "unresolvable";
          return addresses.every((a) => !isPrivateIp(a)) ? "public" : "private";
        })
        .catch((): HostVerdict => "unresolvable");
      cache.set(host, pending);
    }
    return pending;
  }
  return {
    classify,
    async isPublic(hostname: string): Promise<boolean> {
      return (await classify(hostname)) === "public";
    },
  };
}

export type HostGuard = ReturnType<typeof createHostGuard>;
