// Audits are kept under ~/.uxaudit so results survive restarts and nothing is
// written into the project directory.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuditResult, Screenshots } from "./analyze.js";

const SAFE = /^[A-Za-z0-9_-]+$/;

export interface AuditSummary {
  id: string;
  url: string;
  title: string;
  capturedAt: string;
  failed: number;
  warned: number;
}

export function defaultStoreDir(): string {
  return path.join(os.homedir(), ".uxaudit", "audits");
}

export function summarize(id: string, result: AuditResult): AuditSummary {
  return {
    id,
    url: result.finalUrl,
    title: result.title,
    capturedAt: result.capturedAt,
    failed: result.checks.filter((c) => c.status === "fail").length,
    warned: result.checks.filter((c) => c.status === "warn").length,
  };
}

export async function createStore(dir = defaultStoreDir()) {
  await mkdir(dir, { recursive: true });
  const dirOf = (id: string) => {
    if (!SAFE.test(id)) throw new Error("Invalid audit id");
    return path.join(dir, id);
  };
  async function get(id: string): Promise<AuditResult | null> {
    if (!SAFE.test(id)) return null;
    try {
      return JSON.parse(await readFile(path.join(dir, id, "audit.json"), "utf8")) as AuditResult;
    } catch {
      return null;
    }
  }
  return {
    dir,
    newId: () => `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`,
    get,
    async save(id: string, result: AuditResult, shots: Screenshots): Promise<void> {
      const target = dirOf(id);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "desktop.png"), shots.desktop);
      await writeFile(path.join(target, "desktop-full.png"), shots.desktopFull);
      await writeFile(path.join(target, "mobile.png"), shots.mobile);
      await writeFile(path.join(target, "audit.json"), JSON.stringify(result, null, 2));
    },
    async list(limit = 20): Promise<AuditSummary[]> {
      const names = (await readdir(dir).catch(() => [])).filter((n) => SAFE.test(n)).sort().reverse().slice(0, limit);
      const out: AuditSummary[] = [];
      for (const name of names) {
        const result = await get(name);
        if (result) out.push(summarize(name, result));
      }
      return out;
    },
    async remove(id: string): Promise<boolean> {
      if (!SAFE.test(id)) return false;
      const exists = await get(id);
      if (!exists) return false;
      await rm(path.join(dir, id), { recursive: true, force: true });
      return true;
    },
    imagePath(id: string, name: string): string | null {
      if (!SAFE.test(id) || !["desktop", "desktop-full", "mobile"].includes(name)) return null;
      return path.join(dir, id, `${name}.png`);
    },
  };
}

export type Store = Awaited<ReturnType<typeof createStore>>;
