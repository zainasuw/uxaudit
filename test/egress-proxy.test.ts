import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { startEgressProxy, type EgressProxy } from "../src/egress-proxy.ts";
import { startFixtureServer } from "./helpers.ts";

/** Issues a CONNECT through the proxy and resolves with the status line. */
function connectVia(proxyPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, "127.0.0.1", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.once("data", (d) => {
      resolve(String(d).split("\r\n")[0]!);
      socket.destroy();
    });
    socket.once("error", reject);
    socket.once("close", () => resolve("closed"));
  });
}

/** Fetches a plain http URL through the proxy; resolves with the status code or "closed". */
function httpVia(proxyPort: number, url: string): Promise<number | "closed"> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: proxyPort, path: url, method: "GET", headers: { host: new URL(url).host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", (err) => ((err as NodeJS.ErrnoException).code === "ECONNRESET" ? resolve("closed") : reject(err)));
    req.end();
  });
}

describe("egress proxy", () => {
  let fixture: Awaited<ReturnType<typeof startFixtureServer>>;
  let proxy: EgressProxy;
  const lookups: string[] = [];
  const lookup = async (host: string) => {
    lookups.push(host);
    if (host === "fixture.test") return ["127.0.0.1"];
    if (host === "public.example") return ["93.184.216.34"];
    if (host === "rebind.example") return ["93.184.216.34", "10.0.0.1"];
    throw new Error("ENOTFOUND");
  };

  before(async () => {
    fixture = await startFixtureServer();
    proxy = await startEgressProxy({ lookup, allowPrivateHosts: ["fixture.test"] });
  });
  after(async () => {
    await proxy.close();
    await fixture.close();
  });

  it("refuses CONNECT to private addresses, metadata hosts, and names that resolve privately", async () => {
    for (const target of ["127.0.0.1:443", "10.0.0.5:443", "169.254.169.254:80", "[::1]:443", "localhost:443", "rebind.example:443", "metadata.google.internal:80"]) {
      const line = await connectVia(proxy.port, target);
      assert.match(line, /403|closed/, target);
    }
    assert.ok(proxy.stats().refused >= 6);
  });

  it("refuses unusual ports even for public hosts", async () => {
    assert.match(await connectVia(proxy.port, "public.example:22"), /403/);
    assert.match(await connectVia(proxy.port, "public.example:6379"), /403/);
  });

  it("drops plain-http requests to private hosts without answering", async () => {
    assert.equal(await httpVia(proxy.port, "http://127.0.0.1:9/"), "closed");
    assert.equal(await httpVia(proxy.port, "http://169.254.169.254/latest/meta-data/"), "closed");
  });

  it("forwards plain-http requests for an allowed host by its vetted address", async () => {
    const port = new URL(fixture.url).port;
    const status = await httpVia(proxy.port, `http://fixture.test:${port}/`);
    assert.equal(status, 200);
    assert.ok(lookups.includes("fixture.test"));
  });

  it("establishes CONNECT tunnels for an allowed host", async () => {
    const port = new URL(fixture.url).port;
    assert.match(await connectVia(proxy.port, `fixture.test:${port}`), /200/);
  });
});
