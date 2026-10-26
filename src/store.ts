// Audits are kept on disk (default ~/.uxaudit) with random ids that act as the
// only handle to a result. Nothing is ever written into the project directory.

import { randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AuditResult, Screenshots } from "./analyze.js";
import type { Review } from "./review.js";

const SAFE = /^[a-f0-9]{24}$/;
const IMAGES = ["desktop", "desktop-full", "mobile", "mobile-full"] as const;
const FRAME = /^(desktop|mobile)-frame-\d{1,2}$/;
export type ImageName = (typeof IMAGES)[number] | `desktop-frame-${number}` | `mobile-frame-${number}`;

export function defaultStoreDir(): string {
  return path.join(os.homedir(), ".uxaudit", "audits");
}

export async function createStore(dir = defaultStoreDir()) {
  await mkdir(dir, { recursive: true });
  const dirOf = (id: string) => {
    if (!SAFE.test(id)) throw new Error("Invalid audit id");
    return path.join(dir, id);
  };
  async function readJson<T>(id: string, name: string): Promise<T | null> {
    if (!SAFE.test(id)) return null;
    try {
      return JSON.parse(await readFile(path.join(dir, id, name), "utf8")) as T;
    } catch {
      return null;
    }
  }
  return {
    dir,
    newId: () => randomBytes(12).toString("hex"),
    get: (id: string) => readJson<AuditResult>(id, "audit.json"),
    getReview: (id: string) => readJson<Review>(id, "review.json"),
    async save(id: string, result: AuditResult, shots: Screenshots): Promise<void> {
      const target = dirOf(id);
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "desktop.jpg"), shots.desktop);
      await writeFile(path.join(target, "desktop-full.jpg"), shots.desktopFull);
      await writeFile(path.join(target, "mobile.jpg"), shots.mobile);
      await writeFile(path.join(target, "mobile-full.jpg"), shots.mobileFull);
      await Promise.all([
        ...shots.desktopFrames.map((buf, i) => writeFile(path.join(target, `desktop-frame-${i + 1}.jpg`), buf)),
        ...shots.mobileFrames.map((buf, i) => writeFile(path.join(target, `mobile-frame-${i + 1}.jpg`), buf)),
      ]);
      await writeFile(path.join(target, "audit.json"), JSON.stringify(result, null, 2));
    },
    async saveReview(id: string, review: Review): Promise<void> {
      await writeFile(path.join(dirOf(id), "review.json"), JSON.stringify(review, null, 2));
    },
    async image(id: string, name: string): Promise<Buffer | null> {
      if (!SAFE.test(id) || !((IMAGES as readonly string[]).includes(name) || FRAME.test(name))) return null;
      try {
        return await readFile(path.join(dir, id, `${name}.jpg`));
      } catch {
        return null;
      }
    },
    async remove(id: string): Promise<boolean> {
      if (!SAFE.test(id)) return false;
      const info = await stat(path.join(dir, id)).catch(() => null);
      if (!info?.isDirectory()) return false;
      await rm(path.join(dir, id), { recursive: true, force: true });
      return true;
    },
    /** Deletes audits older than `maxAgeMs` and, if still too many, the oldest beyond `maxCount`. Returns how many were removed. */
    async sweep(maxAgeMs: number, maxCount: number): Promise<number> {
      const names = (await readdir(dir).catch(() => [])).filter((n) => SAFE.test(n));
      const entries: Array<{ id: string; mtimeMs: number }> = [];
      for (const id of names) {
        const info = await stat(path.join(dir, id)).catch(() => null);
        if (info?.isDirectory()) entries.push({ id, mtimeMs: info.mtimeMs });
      }
      entries.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const now = Date.now();
      let removed = 0;
      for (const [index, entry] of entries.entries()) {
        if (now - entry.mtimeMs > maxAgeMs || index >= maxCount) {
          await rm(path.join(dir, entry.id), { recursive: true, force: true });
          removed += 1;
        }
      }
      return removed;
    },
    /** Small counters that must survive a restart, such as the daily AI-review budget. */
    async readCounter(name: string): Promise<{ day: string; count: number }> {
      try {
        const parsed = JSON.parse(await readFile(path.join(dir, `${name}.json`), "utf8")) as { day?: unknown; count?: unknown };
        if (typeof parsed.day === "string" && typeof parsed.count === "number") return { day: parsed.day, count: parsed.count };
      } catch {
        // missing or corrupt: start fresh
      }
      return { day: "", count: 0 };
    },
    async writeCounter(name: string, value: { day: string; count: number }): Promise<void> {
      await writeFile(path.join(dir, `${name}.json`), JSON.stringify(value));
    },
  };
}

export type Store = Awaited<ReturnType<typeof createStore>>;
