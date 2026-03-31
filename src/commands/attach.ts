import { loadConfig, getDataDir } from "../core/config.js";
import { createDatabase } from "../db/database.js";
import { createQueries } from "../db/queries.js";
import { join } from "path";
import { existsSync } from "fs";

export async function attachCommand(args: string[]): Promise<void> {
  const idStr = args[0];
  if (!idStr) {
    console.error("Usage: iago attach <review-id>");
    process.exit(1);
  }

  const id = parseInt(idStr, 10);
  if (isNaN(id)) {
    console.error(`Invalid review ID: ${idStr}`);
    process.exit(1);
  }

  const config = loadConfig();
  const dataDir = getDataDir(config);
  const dbPath = join(dataDir, "iago.db");

  if (!existsSync(dbPath)) {
    console.error("Database not found. Is the daemon running?");
    process.exit(1);
  }

  const db = createDatabase(dbPath);
  const queries = createQueries(db);

  const pr = queries.getPR(id);
  if (!pr) {
    console.error(`Review #${id} not found.`);
    db.close();
    process.exit(1);
  }

  if (!pr.session_id) {
    console.error(`Review #${id} has no session ID. It may not have started a Claude session.`);
    db.close();
    process.exit(1);
  }

  // Warn if the review isn't currently running
  const IN_PROGRESS = ["accepted", "cloning", "reviewing"];
  if (!IN_PROGRESS.includes(pr.status)) {
    console.log(`Note: review #${id} is in status "${pr.status}" (not currently running).`);
    console.log(`The session may no longer exist if it was a short-lived or failed run.`);
  }

  console.log(`Attaching to review #${id} (${pr.repo}#${pr.pr_number})...`);
  console.log(`Session: ${pr.session_id}`);
  db.close();

  // Determine CWD: prefer worktree path, fall back to data dir
  let cwd = dataDir;
  if (pr.worktree_path && existsSync(pr.worktree_path)) {
    cwd = pr.worktree_path;
  }

  // Check if session exists before trying to resume
  const check = Bun.spawnSync(["claude", "--resume", pr.session_id, "-p", "ping", "--output-format", "text"], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });

  if (check.exitCode !== 0) {
    const stderr = check.stderr.toString().trim();
    if (stderr.includes("No conversation found")) {
      console.error(`Session ${pr.session_id} does not exist.`);
      if (pr.status === "error") {
        console.error(`The review errored — the Claude process likely never created a session.`);
        console.error(`Re-review this PR first, then attach while it's running.`);
      }
      process.exit(1);
    }
  }

  const proc = Bun.spawn(["claude", "--resume", pr.session_id], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
    cwd,
  });

  const exitCode = await proc.exited;
  process.exit(exitCode);
}
