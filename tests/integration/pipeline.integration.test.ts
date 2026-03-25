import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../../src/db/database.js";
import { createQueries } from "../../src/db/queries.js";
import { assemblePrompt } from "../../src/core/prompt.js";
import { interpolateArgs, launchTool } from "../../src/core/launcher.js";
import { formatStatusTable } from "../../src/commands/status.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";
import { unlinkSync } from "fs";
import type { PRMetadata, LauncherProfile } from "../../src/types/index.js";

const TEST_DB = "/tmp/the-reviewer-e2e-test.sqlite";

function cleanup() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
}

const metadata: PRMetadata = {
  number: 42,
  title: "feat: add auth",
  author: "developer",
  url: "https://github.com/owner/repo/pull/42",
  branch: "feat-auth",
  base_branch: "main",
  repo: "owner/repo",
  additions: 100,
  deletions: 10,
  changed_files: 3,
  body: null,
};

const diff = `diff --git a/src/auth.ts b/src/auth.ts
+export function auth() { return true; }`;

describe("pipeline integration", () => {
  let db: ReturnType<typeof createDatabase>;
  let queries: ReturnType<typeof createQueries>;

  beforeEach(() => {
    cleanup();
    db = createDatabase(TEST_DB);
    queries = createQueries(db);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it("should handle a complete happy path with echo as review tool", async () => {
    // 1. Insert PR
    const pr = queries.insertPR({
      pr_number: metadata.number,
      repo: metadata.repo,
      title: metadata.title,
      author: metadata.author,
      url: metadata.url,
      branch: metadata.branch,
      base_branch: metadata.base_branch,
    });
    queries.insertEvent(pr.id, "detected", "PR detected");

    // 2. Assemble prompt
    const prompt = assemblePrompt({ metadata, diff });
    expect(prompt).toContain("feat: add auth");
    expect(prompt).toContain("```diff");

    // 3. Launch a mock tool (echo)
    queries.updatePRStatus(pr.id, "reviewing");

    const echoProfile: LauncherProfile = {
      display_name: "Mock Reviewer",
      command: "echo",
      args: ["LGTM - no issues found"],
      stdin_mode: "none",
      output_mode: "stdout",
      timeout: "5s",
      enabled: true,
    };

    const result = await launchTool(echoProfile, {}, "/tmp");
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("LGTM - no issues found");

    // 4. Save output
    queries.insertOutput({
      pr_review_id: pr.id,
      tool_name: result.toolName,
      output: result.output,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });

    queries.updatePRStatus(pr.id, "done");
    queries.insertEvent(pr.id, "done", "Review complete");

    // 5. Verify final state
    const final = queries.getPR(pr.id);
    expect(final!.status).toBe("done");

    const outputs = queries.getOutputs(pr.id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.output).toBe("LGTM - no issues found");

    const events = queries.getEvents(pr.id);
    expect(events).toHaveLength(2); // detected, done
  });

  it("should handle dismissed review", () => {
    const pr = queries.insertPR({
      pr_number: 99,
      repo: "a/b",
      url: "https://github.com/a/b/pull/99",
      title: "fix: typo",
    });
    queries.updatePRStatus(pr.id, "notified");
    queries.updatePRStatus(pr.id, "dismissed");

    const final = queries.getPR(pr.id);
    expect(final!.status).toBe("dismissed");

    // Dismissed PRs should not appear in active list
    expect(queries.getActivePRs()).toHaveLength(0);

    // But should appear in all PRs
    expect(queries.getAllPRs()).toHaveLength(1);
  });

  it("should handle tool timeout gracefully", async () => {
    const pr = queries.insertPR({
      pr_number: 100,
      repo: "a/b",
      url: "u",
      title: "slow PR",
    });
    queries.updatePRStatus(pr.id, "reviewing");

    const slowProfile: LauncherProfile = {
      display_name: "Slow Tool",
      command: "sleep",
      args: ["10"],
      stdin_mode: "none",
      output_mode: "stdout",
      timeout: "100ms",
      enabled: true,
    };

    const result = await launchTool(slowProfile, {}, "/tmp");
    expect(result.timedOut).toBe(true);

    queries.insertOutput({
      pr_review_id: pr.id,
      tool_name: result.toolName,
      output: "",
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });
    queries.updatePRToolStatus(pr.id, { "Slow Tool": "timeout" });
    queries.updatePRStatus(pr.id, "error");

    const final = queries.getPR(pr.id);
    expect(final!.status).toBe("error");
    expect(final!.tool_status).toEqual({ "Slow Tool": "timeout" });
  });
});
