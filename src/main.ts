import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 3131);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`uxaudit: invalid PORT ${process.env.PORT}`);
  process.exit(1);
}

const server = await startServer({ port, log: (m) => console.log(`  ${m}`) });
console.log(`\nUXAudit is running at ${server.url}\nAudits are stored in ${server.store.dir}\nPress Ctrl+C to stop.\n`);

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await server.close().catch(() => undefined);
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
