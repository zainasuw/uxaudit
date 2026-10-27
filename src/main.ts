import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { startServer } from "./server.js";

// Minimal .env loader (no dependency): KEY=value lines, existing env wins.
async function loadDotEnv(): Promise<void> {
  const file = fileURLToPath(new URL("../.env", import.meta.url));
  const text = await readFile(file, "utf8").catch(() => "");
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match && process.env[match[1]!] === undefined) process.env[match[1]!] = match[2]!.replace(/^["']|["']$/g, "");
  }
}

await loadDotEnv();

const port = Number(process.env.PORT ?? 3131);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`uxaudit: invalid PORT ${process.env.PORT}`);
  process.exit(1);
}
// Hosts expose their public host name automatically (Hugging Face: SPACE_HOST, Render: RENDER_EXTERNAL_HOSTNAME); an explicit ALLOWED_HOSTS wins.
const hosting = (process.env.ALLOWED_HOSTS ?? process.env.SPACE_HOST ?? process.env.RENDER_EXTERNAL_HOSTNAME ?? "").trim();
const host = process.env.HOST ?? (hosting ? "0.0.0.0" : "127.0.0.1");
const trustProxy = process.env.TRUST_PROXY === "1";
const server = await startServer({
  port,
  host,
  allowedHosts: hosting ? hosting.split(",").map((h) => h.trim()).filter(Boolean) : [],
  trustProxy,
  geminiApiKey: process.env.GEMINI_API_KEY || undefined,
  geminiModel: process.env.GEMINI_MODEL || undefined,
  chromiumSandbox: process.env.CHROMIUM_SANDBOX !== "0",
  storeDir: process.env.UXAUDIT_STORE_DIR || undefined,
  log: (m) => console.log(`  ${m}`),
});

console.log(
  `\nUXAudit is running at ${server.url}\n` +
    `AI review: ${server.reviewEnabled ? `enabled (instruction from ${server.instructionSource})` : "disabled (set GEMINI_API_KEY and REVIEW_INSTRUCTION to enable)"}\n` +
    `Audits are stored in ${server.store.dir} for ${server.limits.retentionHours} hours\n` +
    (process.env.CHROMIUM_SANDBOX === "0" ? "WARNING: the Chromium sandbox is disabled.\n" : "") +
    (trustProxy && !["127.0.0.1", "::1", "localhost"].includes(host)
      ? "WARNING: TRUST_PROXY=1 takes client addresses from X-Forwarded-For. Use it only behind a reverse proxy; if this port is reachable directly, clients can pick their own address and slip past the per-visitor limits.\n"
      : "") +
    `Press Ctrl+C to stop.\n`,
);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
