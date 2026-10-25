import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BlockedUrlError, createHostGuard, isPrivateIp, parseTargetUrl } from "../src/url-guard.ts";

describe("parseTargetUrl", () => {
  it("accepts public http(s) addresses and adds https when the scheme is missing", () => {
    assert.equal(parseTargetUrl("example.com").toString(), "https://example.com/");
    assert.equal(parseTargetUrl(" http://example.com/path?q=1 ").toString(), "http://example.com/path?q=1");
  });

  it("refuses non-web schemes, credentials and junk", () => {
    for (const bad of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "https://user:pw@example.com", "", "not a url", "https://"]) {
      assert.throws(() => parseTargetUrl(bad), BlockedUrlError, bad);
    }
    assert.throws(() => parseTargetUrl("https://example.com/" + "a".repeat(3000)), /too long/);
  });

  it("refuses local and private hosts before touching the network", () => {
    for (const bad of [
      "http://localhost:3000",
      "http://LOCALHOST",
      "http://foo.localhost",
      "http://127.0.0.1",
      "http://127.1.2.3",
      "http://0.0.0.0",
      "http://10.0.0.5",
      "http://172.16.3.4",
      "http://192.168.1.1",
      "http://169.254.169.254/latest/meta-data/",
      "http://metadata.google.internal",
      "http://[::1]",
      "http://[fe80::1]",
      "http://[::ffff:127.0.0.1]",
      "http://intranet",
      "http://printer.local",
      "http://100.64.0.1",
      "http://2130706433", // 127.0.0.1 as a decimal integer, normalised by the URL parser
      "http://0x7f000001",
    ]) {
      assert.throws(() => parseTargetUrl(bad), BlockedUrlError, bad);
    }
  });
});

describe("isPrivateIp", () => {
  it("classifies IPv4 and IPv6 ranges", () => {
    for (const ip of ["127.0.0.1", "10.1.1.1", "192.168.0.9", "172.31.255.255", "169.254.169.254", "0.0.0.0", "224.0.0.1", "255.255.255.255", "::1", "::", "fc00::1", "fd12::1", "fe80::abcd", "::ffff:10.0.0.1", "64:ff9b::7f00:1"]) {
      assert.equal(isPrivateIp(ip), true, ip);
    }
    for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "2606:4700::1111", "2001:4860:4860::8888", "::ffff:8.8.8.8"]) {
      assert.equal(isPrivateIp(ip), false, ip);
    }
  });
});

describe("host guard", () => {
  it("refuses hosts that resolve to any private address, including DNS tricks", async () => {
    const guard = createHostGuard(async (host) => {
      if (host === "public.example") return ["93.184.216.34"];
      if (host === "rebind.example") return ["93.184.216.34", "127.0.0.1"];
      if (host === "v6.example") return ["2606:4700::1111"];
      if (host === "mapped.example") return ["::ffff:192.168.1.1"];
      if (host === "nowhere.example") return [];
      throw new Error("ENOTFOUND");
    });
    assert.equal(await guard.isPublic("public.example"), true);
    assert.equal(await guard.isPublic("v6.example"), true);
    assert.equal(await guard.isPublic("rebind.example"), false);
    assert.equal(await guard.isPublic("mapped.example"), false);
    assert.equal(await guard.isPublic("nowhere.example"), false);
    assert.equal(await guard.isPublic("missing.example"), false);
    assert.equal(await guard.isPublic("127.0.0.1"), false);
    assert.equal(await guard.isPublic("localhost"), false);
  });

  it("caches lookups per host", async () => {
    let calls = 0;
    const guard = createHostGuard(async () => {
      calls += 1;
      return ["93.184.216.34"];
    });
    await Promise.all([guard.isPublic("a.example"), guard.isPublic("a.example"), guard.isPublic("A.example")]);
    assert.equal(calls, 1);
  });
});
