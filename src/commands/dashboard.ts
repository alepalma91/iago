import { loadConfig, getDataDir } from "../core/config.js";
import { createDatabase } from "../db/database.js";
import { createDashboardServer } from "../core/dashboard.js";
import { join } from "path";

export async function dashboardCommand(_args: string[]): Promise<void> {
  const config = loadConfig();
  const dataDir = getDataDir(config);
  const dbPath = join(dataDir, "iago.db");

  const db = createDatabase(dbPath);
  const { server, stop } = createDashboardServer(db, config);

  const url = `http://localhost:${server.port}`;
  console.log(`iago: dashboard running at ${url}`);

  if (config.dashboard.auto_open) {
    try {
      Bun.spawn(["open", url]);
    } catch {}
  }

  // Keep alive until signal
  const shutdown = () => {
    console.log("\niago: stopping dashboard...");
    stop();
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Block forever
  await new Promise(() => {});
}
