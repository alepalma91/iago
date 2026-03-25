import { loadConfig, getDataDir } from "../core/config.js";
import { createDatabase } from "../db/database.js";
import { createQueries } from "../db/queries.js";
import { pollNotifications, enrichPR, fetchPendingReviews, createInitialPollState, checkGhAuth } from "../core/poller.js";
import { handleNewReview } from "../core/pipeline.js";
import { sendPRNotification } from "../core/notifier.js";
import { writePidFile, removePidFile } from "../core/pid.js";
import { createDashboardServer } from "../core/dashboard.js";
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
  // Catch-up: check for pending review requests from the last 8 hours
  console.log("Checking for pending review requests...");
  try {
    const pending = await fetchPendingReviews(8);
    if (pending.length > 0) {
      console.log(`  Found ${pending.length} pending PR(s) awaiting your review:`);
      for (const pr of pending) {
        const existing = queries.getPRByRepoAndNumber(pr.repo, pr.number);
        const status = existing ? ` (already tracked: ${existing.status})` : "";
        console.log(`    - ${pr.repo}#${pr.number}: ${pr.title} by @${pr.author}${status}`);
      }
      console.log("");

      // Send notification for each new PR (one at a time)
      const newPRs = pending.filter(
        (pr) => !queries.getPRByRepoAndNumber(pr.repo, pr.number)
      );

      if (newPRs.length > 0) {
        console.log(`  Sending notifications for ${newPRs.length} new PR(s)...\n`);
        for (const pr of newPRs) {
          // Register in DB
          const row = queries.insertPR({
            pr_number: pr.number,
            repo: pr.repo,
            title: pr.title,
            author: pr.author,
            url: pr.url,
            branch: pr.branch,
            base_branch: pr.base_branch,
          });
          queries.insertEvent(row.id, "detected", "Found during startup catch-up");
          queries.updatePRStatus(row.id, "notified");

          // Send macOS notification
          console.log(`  [notify] ${pr.repo}#${pr.number}: ${pr.title}`);
          try {
            const action = await sendPRNotification({
              repo: pr.repo,
              pr_number: pr.number,
              title: pr.title,
              author: pr.author,
              url: pr.url,
            });
            console.log(`  [action] ${pr.repo}#${pr.number}: ${action}`);
            queries.insertEvent(row.id, "user_action", `User action: ${action}`);

            if (action === "accept") {
              queries.updatePRStatus(row.id, "accepted");
              // Run review pipeline in background
              const metadata = await enrichPR(`https://api.github.com/repos/${pr.repo}/pulls/${pr.number}`);
              if (metadata) {
                handleNewReview(metadata, { config, queries }).catch((err) => {
                  console.error(`  [error] Review failed for ${pr.repo}#${pr.number}: ${err.message}`);
                });
              }
            } else if (action === "dismiss" || action === "timeout" || action === "snooze") {
              queries.updatePRStatus(row.id, "dismissed");
            } else if (action === "view") {
              const { openInBrowser } = await import("../core/notifier.js");
              await openInBrowser(pr.url);
              queries.updatePRStatus(row.id, "dismissed");
            }
          } catch {
            // alerter not available — register and let user pick
            console.log(`  [skip] No alerter — registered for manual review`);
            console.log(`    make review PR=${pr.url}`);
          }
        }
      }
    } else {
      console.log("  No pending reviews found.");
    }
  } catch (err: any) {
    console.error(`  Catch-up check failed: ${err.message}`);
  }

  // Start dashboard if enabled
  let dashboardServer: ReturnType<typeof createDashboardServer> | null = null;
  if (config.dashboard.enabled) {
    dashboardServer = createDashboardServer(db, config);
    const dashboardUrl = `http://localhost:${dashboardServer.server.port}`;
    console.log(`Dashboard: ${dashboardUrl}`);
    if (config.dashboard.auto_open) {
      try {
        Bun.spawn(["open", dashboardUrl]);
      } catch {}
    }
  }

  console.log("\nPolling for PR review requests... (Ctrl+C to stop)");

  // Graceful shutdown
  const shutdown = () => {
    console.log("\nthe-reviewer: shutting down...");
    if (dashboardServer) {
      dashboardServer.stop();
    }
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

      const ts = new Date().toLocaleTimeString();
      if (result.statusCode === 304) {
        process.stdout.write(`\r  [${ts}] Polling... 304 Not Modified (no new notifications)`);
      } else if (result.notifications.length === 0) {
        process.stdout.write(`\r  [${ts}] Polling... 200 OK (0 review requests)          `);
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
