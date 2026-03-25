import { loadConfig, getDataDir } from "../core/config.js";
import { createDatabase } from "../db/database.js";
import { createQueries } from "../db/queries.js";
import { pollNotifications, enrichPR, createInitialPollState, checkGhAuth } from "../core/poller.js";
import { handleNewReview } from "../core/pipeline.js";
import { writePidFile, removePidFile } from "../core/pid.js";
import { join } from "path";
import { mkdirSync } from "fs";

function parseDuration(duration: string): number {
  const match = duration.match(/^(\d+)(ms|s|m|h)$/);
  if (!match) return 60_000;

  const value = parseInt(match[1]!, 10);
  switch (match[2]!) {
    case "ms": return value;
    case "s": return value * 1_000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    default: return 60_000;
  }
}

export async function startCommand(_args: string[]): Promise<void> {
  const config = loadConfig();
  const dataDir = getDataDir(config);

  mkdirSync(dataDir, { recursive: true });

  // Check gh auth
  const authed = await checkGhAuth();
  if (!authed) {
    console.error("the-reviewer: GitHub CLI not authenticated. Run `gh auth login` first.");
    process.exit(1);
  }

  // Set up database
  const dbPath = join(dataDir, "the-reviewer.db");
  const db = createDatabase(dbPath);
  const queries = createQueries(db);

  // Write PID file
  writePidFile();

  const pollIntervalMs = parseDuration(config.github.poll_interval);
  const pollState = createInitialPollState();

  console.log("the-reviewer: starting daemon...");
  console.log(`  Poll interval: ${config.github.poll_interval}`);
  console.log(`  Tools: ${config.launchers.default_tools.join(", ")}`);
  console.log(`  Max parallel: ${config.launchers.max_parallel}`);
  console.log(`  Data dir: ${dataDir}`);
  console.log("");
  console.log("Polling for PR review requests... (Ctrl+C to stop)");

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nthe-reviewer: shutting down...");
    removePidFile();
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Poll loop
  const ctx = { config, queries };

  while (true) {
    try {
      const result = await pollNotifications(pollState);

      // Update state for next poll
      if (result.lastModified) {
        pollState.lastModified = result.lastModified;
      }
      pollState.pollInterval = result.pollInterval;

      if (result.statusCode === 304) {
        // No new notifications
      } else if (result.notifications.length > 0) {
        console.log(`[${new Date().toISOString()}] Found ${result.notifications.length} review request(s)`);

        for (const notification of result.notifications) {
          // Check repo filters
          const repo = notification.repository.full_name;
          if (config.github.ignored_repos.includes(repo)) continue;
          if (
            config.github.watched_repos.length > 0 &&
            !config.github.watched_repos.includes(repo)
          ) continue;

          // Enrich PR metadata
          const metadata = await enrichPR(notification.subject.url);
          if (!metadata) continue;

          // Run the review pipeline
          await handleNewReview(metadata, ctx);
        }
      }
    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] Poll error: ${err.message}`);
    }

    // Sleep until next poll
    const sleepMs = Math.max(pollState.pollInterval * 1000, pollIntervalMs);
    await new Promise((resolve) => setTimeout(resolve, sleepMs));
  }
}
