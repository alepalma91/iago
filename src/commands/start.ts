import { loadConfig, getDataDir, getConfigDir, shouldAutoReview } from "../core/config.js";
import { createDatabase } from "../db/database.js";
import { createQueries } from "../db/queries.js";
import { pollNotifications, enrichPR, fetchPendingReviews, createInitialPollState, checkGhAuth, fetchPRGitHubStatus, getCurrentGithubUser } from "../core/poller.js";
import { handleNewReview } from "../core/pipeline.js";
import { sendPRNotification } from "../core/notifier.js";
import { writePidFile, removePidFile } from "../core/pid.js";
import { createDashboardServer } from "../core/dashboard.js";
import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync } from "fs";

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
  // First-run detection: if no config file exists, hint at setup
  const configPath = join(getConfigDir(), "config.yaml");
  if (!existsSync(configPath)) {
    console.log("No config found. Run 'iago setup' to configure, or press Enter for defaults.");
    if (process.stdin.isTTY) {
      await new Promise<void>((resolve) => {
        process.stdin.once("data", () => resolve());
        // Auto-continue after 5 seconds
        setTimeout(resolve, 5000);
      });
    }
  }

  const config = loadConfig();
  const dataDir = getDataDir(config);

  mkdirSync(dataDir, { recursive: true });

  // Check gh auth
  const authed = await checkGhAuth();
  if (!authed) {
    console.error("iago: GitHub CLI not authenticated. Run `gh auth login` first.");
    process.exit(1);
  }

  // Identify GitHub user
  const ghUser = await getCurrentGithubUser();
  console.log(`  GitHub user: ${ghUser ?? "unknown"}`);

  // Set up database
  const dbPath = join(dataDir, "iago.db");
  const db = createDatabase(dbPath);
  const queries = createQueries(db);

  // Write PID file
  writePidFile();

  const pollIntervalMs = parseDuration(config.github.poll_interval);
  const pollState = createInitialPollState();

  console.log("iago: starting daemon...");
  console.log(`  Poll interval: ${config.github.poll_interval}`);
  console.log(`  Tools: ${config.launchers.default_tools.join(", ")}`);
  console.log(`  Max parallel: ${config.launchers.max_parallel}`);
  console.log(`  Data dir: ${dataDir}`);
  console.log("");

  // Reset stuck reviews from previous sessions
  const stuckReviews = queries.getStuckReviews();
  if (stuckReviews.length > 0) {
    console.log(`Resetting ${stuckReviews.length} stuck review(s)...`);
    for (const pr of stuckReviews) {
      console.log(`  [reset] ${pr.repo}#${pr.pr_number}: ${pr.status} -> error`);
      queries.updatePRStatus(pr.id, "error");
      queries.insertEvent(pr.id, "error", `Reset: review stuck in "${pr.status}" from previous session`);
    }
    console.log("");
  }

  // Bulk sync github_state for ALL tracked PRs
  console.log("Syncing PR states with GitHub...");
  const allPRs = queries.getAllPRsForSync();
  let synced = 0;
  for (const pr of allPRs) {
    try {
      const ghStatus = await fetchPRGitHubStatus(pr.repo, pr.pr_number);
      if (!ghStatus) continue;
      const newState = ghStatus.state.toLowerCase() as "open" | "merged" | "closed";
      queries.updatePRGitHubState(pr.id, newState);
      if (newState !== pr.github_state) {
        console.log(`  [sync] ${pr.repo}#${pr.pr_number}: ${pr.github_state} → ${newState}`);
      }

      // Promote "done" PRs to "changes_requested" if we requested changes on GitHub
      if (pr.status === "done" && ghStatus.reviewedByMe && ghStatus.myReviewState === "CHANGES_REQUESTED") {
        console.log(`  [sync] ${pr.repo}#${pr.pr_number}: done → changes_requested`);
        queries.updatePRStatus(pr.id, "changes_requested");
        queries.updatePRHeadSha(pr.id, ghStatus.headRefOid);
        queries.insertEvent(pr.id, "changes_requested", "Review requested changes on GitHub");
      }

      // Detect author pushes: if changes_requested and head SHA changed → updated
      if (pr.status === "changes_requested" && pr.head_sha && ghStatus.headRefOid && ghStatus.headRefOid !== pr.head_sha) {
        console.log(`  [sync] ${pr.repo}#${pr.pr_number}: changes_requested → updated (new commits pushed)`);
        queries.updatePRStatus(pr.id, "updated");
        queries.insertEvent(pr.id, "updated", "Author pushed new commits since last review");
      }

      synced++;
    } catch {}
  }
  console.log(`  Synced ${synced}/${allPRs.length} PRs\n`);

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
        console.log(`  Processing ${newPRs.length} new PR(s)...\n`);
        for (const pr of newPRs) {
          const autoReview = shouldAutoReview(config, pr.repo);
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

          if (autoReview) {
            console.log(`  [auto-review] ${pr.repo}#${pr.number}: ${pr.title}`);
            queries.updatePRStatus(row.id, "accepted");
            queries.insertEvent(row.id, "accepted", "Auto-review enabled for this repo");
            handleNewReview(
              { ...pr, number: pr.number },
              { config, queries }
            ).catch((err) => {
              console.error(`  [auto-review] Error: ${err.message}`);
            });
          } else {
            queries.updatePRStatus(row.id, "notified");
            console.log(`  [notify] ${pr.repo}#${pr.number}: ${pr.title}`);
            await sendPRNotification({
              repo: pr.repo,
              pr_number: pr.number,
              title: pr.title,
              author: pr.author,
              url: pr.url,
            });
          }
        }
      }

      // Re-notify PRs still awaiting action (notified/detected from a previous session)
      const stillPending = pending.filter((pr) => {
        const existing = queries.getPRByRepoAndNumber(pr.repo, pr.number);
        return existing && (existing.status === "notified" || existing.status === "detected");
      });
      if (stillPending.length > 0) {
        console.log(`  Re-notifying ${stillPending.length} PR(s) still awaiting action...\n`);
        for (const pr of stillPending) {
          console.log(`  [re-notify] ${pr.repo}#${pr.number}: ${pr.title}`);
          await sendPRNotification({
            repo: pr.repo,
            pr_number: pr.number,
            title: pr.title,
            author: pr.author,
            url: pr.url,
          });
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

  // Launch menubar app if installed and not already running
  let menubarProc: ReturnType<typeof Bun.spawn> | null = null;
  try {
    const menubarBin = join(homedir(), "bin", "iago-bar");
    if (existsSync(menubarBin)) {
      // Check if already running
      const pgrep = Bun.spawnSync(["pgrep", "-f", "iago-bar"], { stdout: "pipe", stderr: "pipe" });
      if (pgrep.exitCode !== 0) {
        menubarProc = Bun.spawn([menubarBin], { stdout: "ignore", stderr: "ignore" });
        console.log("Menu bar: started");
      } else {
        console.log("Menu bar: already running");
      }
    }
  } catch {}

  console.log("\nPolling for PR review requests... (Ctrl+C to stop)");

  // Graceful shutdown
  const shutdown = () => {
    console.log("\niago: shutting down...");
    if (menubarProc) {
      menubarProc.kill();
    }
    if (dashboardServer) {
      dashboardServer.stop();
    }
    removePidFile();
    db.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  // Poll loop — use GraphQL search to find all open PRs requesting review
  const ctx = { config, queries };

  while (true) {
    try {
      const ts = new Date().toLocaleTimeString();
      const pending = await fetchPendingReviews(168); // look back 7 days

      // Filter to only new PRs not yet tracked
      const newPRs = pending.filter((pr) => {
        // Check repo filters
        if (config.github.ignored_repos.includes(pr.repo)) return false;
        if (
          config.github.watched_repos.length > 0 &&
          !config.github.watched_repos.includes(pr.repo)
        ) return false;

        // Skip if already tracked
        const existing = queries.getPRByRepoAndNumber(pr.repo, pr.number);
        return !existing;
      });

      if (newPRs.length === 0) {
        process.stdout.write(`\r  [${ts}] Polling... ${pending.length} open PR(s), 0 new          `);
      } else {
        console.log(`\n  [${ts}] Found ${newPRs.length} new review request(s)`);

        for (const pr of newPRs) {
          const autoReview = shouldAutoReview(config, pr.repo);
          const row = queries.insertPR({
            pr_number: pr.number,
            repo: pr.repo,
            title: pr.title,
            author: pr.author,
            url: pr.url,
            branch: pr.branch,
            base_branch: pr.base_branch,
          });
          queries.insertEvent(row.id, "detected", "Found during poll");

          if (autoReview) {
            console.log(`  [auto-review] ${pr.repo}#${pr.number}: ${pr.title}`);
            queries.updatePRStatus(row.id, "accepted");
            queries.insertEvent(row.id, "accepted", "Auto-review enabled for this repo");
            handleNewReview(
              { ...pr, number: pr.number },
              { config, queries }
            ).catch((err) => {
              console.error(`  [auto-review] Error: ${err.message}`);
            });
          } else {
            queries.updatePRStatus(row.id, "notified");
            console.log(`  [notify] ${pr.repo}#${pr.number}: ${pr.title}`);
            await sendPRNotification({
              repo: pr.repo,
              pr_number: pr.number,
              title: pr.title,
              author: pr.author,
              url: pr.url,
            });
          }
        }
      }
      // Sync tracked PRs against GitHub — update github_state and dismiss stale ones
      const syncablePRs = queries.getSyncablePRs();
      for (const pr of syncablePRs) {
        try {
          const ghStatus = await fetchPRGitHubStatus(pr.repo, pr.pr_number);
          if (!ghStatus) continue;

          // Update github_state for all PRs
          const newGhState = ghStatus.state.toLowerCase() as "open" | "merged" | "closed";
          if (newGhState !== pr.github_state) {
            queries.updatePRGitHubState(pr.id, newGhState);
            if (newGhState !== "open") {
              console.log(`\n  [sync] ${pr.repo}#${pr.pr_number}: ${newGhState} on GitHub`);
            }
          } else {
            // Touch synced_at even if state unchanged
            queries.updatePRGitHubState(pr.id, pr.github_state);
          }

          // Auto-dismiss PRs still awaiting action if they're merged/closed/no longer requested
          if (pr.status === "notified" || pr.status === "detected") {
            if (ghStatus.state === "MERGED" || ghStatus.state === "CLOSED") {
              console.log(`\n  [sync] ${pr.repo}#${pr.pr_number}: ${newGhState} → dismissed`);
              queries.updatePRStatus(pr.id, "dismissed");
              queries.insertEvent(pr.id, "dismissed", `PR ${newGhState} on GitHub`);
            } else if (!ghStatus.reviewRequestedByMe && !ghStatus.reviewedByMe) {
              console.log(`\n  [sync] ${pr.repo}#${pr.pr_number}: review no longer requested → dismissed`);
              queries.updatePRStatus(pr.id, "dismissed");
              queries.insertEvent(pr.id, "dismissed", "Review no longer requested from us");
            }
          }

          // Detect author pushes on changes_requested PRs → updated
          if (pr.status === "changes_requested" && pr.head_sha && ghStatus.headRefOid && ghStatus.headRefOid !== pr.head_sha) {
            console.log(`\n  [sync] ${pr.repo}#${pr.pr_number}: changes_requested → updated (new commits pushed)`);
            queries.updatePRStatus(pr.id, "updated");
            queries.insertEvent(pr.id, "updated", "Author pushed new commits since last review");
          }
        } catch {}
      }

    } catch (err: any) {
      console.error(`[${new Date().toISOString()}] Poll error: ${err.message}`);
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
