// A forwarding proxy that sits between Chromium and the internet. Chromium is
// launched with this proxy and never resolves DNS itself: every hostname is
// resolved here, refused when any address is private, and connected by the
// vetted IP. That closes DNS rebinding (the name is resolved once and pinned),
// redirect chains (each hop is a new proxy connection) and WebSockets (they
// tunnel through CONNECT like everything else).

import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { createHostGuard, isPrivateIp, lookupWithTimeout, systemLookup, type Lookup } from "./url-guard.js";

export interface EgressProxyOptions {
  /** Tests only: let loopback through (the fixture server lives there). */
  allowPrivate?: boolean;
  /** Tests only: these hostnames (or IP literals) may resolve to private addresses. */
  allowPrivateHosts?: string[];
  lookup?: Lookup;
  allowedPorts?: number[];
  /** Max concurrent tunnels; further CONNECTs are refused. */
  maxConnections?: number;
  log?: (message: string) => void;
}

export type FailureReason = "blocked" | "unreachable";

export interface EgressProxy {
  url: string;
  port: number;
  stats(): { refused: number; connections: number };
  /** Why the most recent attempt to reach `hostname` failed, if it did. Lets the analyzer explain errors Chromium reports identically. */
  reasonFor(hostname: string): FailureReason | undefined;
  close(): Promise<void>;
}

const DEFAULT_PORTS = [80, 443, 8080, 8443];

export async function startEgressProxy(opts: EgressProxyOptions = {}): Promise<EgressProxy> {
  const lookup = opts.lookup ?? systemLookup;
  const guard = createHostGuard(lookup);
  const allowedPorts = new Set(opts.allowedPorts ?? DEFAULT_PORTS);
  const maxConnections = opts.maxConnections ?? 64;
  const log = opts.log ?? (() => undefined);
  const exempt = new Set((opts.allowPrivateHosts ?? []).map((h) => h.toLowerCase()));
  const failures = new Map<string, FailureReason>();
  let refused = 0;
  let connections = 0;
  const noteFailure = (hostname: string, reason: FailureReason) => {
    failures.set(hostname.replace(/^\[|\]$/g, "").toLowerCase(), reason);
    if (failures.size > 500) failures.delete(failures.keys().next().value!);
  };

  /** Resolve a hostname to the single IP we will connect to, or null when refused. */
  async function pin(hostname: string, port: number): Promise<string | null> {
    const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const trusted = opts.allowPrivate || exempt.has(host);
    if (!allowedPorts.has(port) && !trusted) return null;
    if (net.isIP(host)) {
      if (isPrivateIp(host) && !trusted) return null;
      return host;
    }
    if (trusted) {
      const addresses = await lookupWithTimeout(lookup, host).catch(() => []);
      return addresses[0] ?? null;
    }
    if ((await guard.classify(host)) !== "public") return null;
    const addresses = await lookupWithTimeout(lookup, host).catch(() => []);
    const first = addresses.find((a) => !isPrivateIp(a));
    return first ?? null;
  }

  const server = http.createServer(async (req, res) => {
    // Plain http:// requests arrive as absolute URLs.
    let url: URL;
    try {
      url = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.protocol !== "http:") {
      res.writeHead(400).end();
      return;
    }
    const port = Number(url.port || 80);
    const ip = await pin(url.hostname, port);
    if (!ip) {
      refused += 1;
      noteFailure(url.hostname, "blocked");
      log(`refused http://${url.hostname}:${port}`);
      // Drop the connection instead of answering: Chromium then reports a
      // network error rather than rendering a "blocked" page we would screenshot.
      req.socket.destroy();
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    const upstream = http.request(
      { host: ip, port, method: req.method, path: url.pathname + url.search, headers, setHost: false, timeout: 20_000 },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("timeout")));
    upstream.on("error", () => {
      // The site itself failed (refused, reset, timed out): surface it as a
      // network failure, not as a page we could screenshot.
      noteFailure(url.hostname, "unreachable");
      if (!res.headersSent) req.socket.destroy();
      else res.end();
    });
    req.pipe(upstream);
  });

  server.on("connect", async (req, socket, head) => {
    const [hostname = "", portText = "443"] = (req.url ?? "").split(/:(?=\d+$)/);
    const port = Number(portText);
    if (connections >= maxConnections) {
      socket.end("HTTP/1.1 503 Service Unavailable\r\n\r\n");
      return;
    }
    const ip = await pin(hostname, port);
    if (!ip) {
      refused += 1;
      noteFailure(hostname, "blocked");
      log(`refused ${hostname}:${port}`);
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    connections += 1;
    let established = false;
    const upstream = net.connect({ host: ip, port }, () => {
      established = true;
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.setTimeout(30_000, () => upstream.destroy());
    const done = () => {
      connections = Math.max(0, connections - 1);
      upstream.destroy();
      socket.destroy();
    };
    upstream.on("error", () => {
      if (!established) noteFailure(hostname, "unreachable");
      done();
    });
    upstream.on("close", done);
    socket.on("error", done);
    socket.on("close", done);
  });

  server.on("clientError", (_err, socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    stats: () => ({ refused, connections }),
    reasonFor: (hostname) => failures.get(hostname.replace(/^\[|\]$/g, "").toLowerCase()),
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
