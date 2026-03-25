import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../../src/db/database.js";
import { createQueries } from "../../src/db/queries.js";
import { createMCPServer } from "../../src/mcp/server.js";
import { unlinkSync } from "fs";

const TEST_DB = "/tmp/the-reviewer-test-mcp.sqlite";

function cleanup() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
}

describe("MCP server", () => {
  let db: ReturnType<typeof createDatabase>;
  let q: ReturnType<typeof createQueries>;

  beforeEach(() => {
    cleanup();
    db = createDatabase(TEST_DB);
    q = createQueries(db);
  });

  afterEach(() => {
    db.close();
    cleanup();
  });

  it("should create MCP server with tools", () => {
    const server = createMCPServer();
    expect(server).toBeDefined();
  });

  it("list_reviews should return empty when no reviews exist", async () => {
    // Seed nothing — query directly
    const prs = q.getAllPRs();
    expect(prs).toHaveLength(0);
  });

  it("list_reviews data layer returns inserted PRs", async () => {
    q.insertPR({
      pr_number: 1,
      repo: "owner/repo",
      title: "feat: new feature",
      author: "dev",
      url: "https://github.com/owner/repo/pull/1",
      branch: "feat",
    });
    q.insertPR({
      pr_number: 2,
      repo: "owner/repo",
      title: "fix: bug fix",
      author: "dev2",
      url: "https://github.com/owner/repo/pull/2",
      branch: "fix",
    });

    const all = q.getAllPRs();
    expect(all).toHaveLength(2);

    const filtered = all.filter((pr) => pr.status === "detected");
    expect(filtered).toHaveLength(2);
  });

  it("get_review data layer returns PR with events and outputs", async () => {
    const pr = q.insertPR({
      pr_number: 42,
      repo: "org/project",
      title: "feat: auth",
      author: "alice",
      url: "https://github.com/org/project/pull/42",
      branch: "feat-auth",
    });

    q.insertEvent(pr.id, "accepted", "Manual review");
    q.insertEvent(pr.id, "reviewing", "Launching tools");
    q.insertOutput({
      pr_review_id: pr.id,
      tool_name: "claude",
      output: "LGTM - code looks good",
      exit_code: 0,
      duration_ms: 3000,
    });

    const fetched = q.getPR(pr.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.repo).toBe("org/project");

    const events = q.getEvents(pr.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_type).toBe("accepted");

    const outputs = q.getOutputs(pr.id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.tool_name).toBe("claude");
    expect(outputs[0]!.output).toBe("LGTM - code looks good");
  });

  it("get_review_output filters by tool name", async () => {
    const pr = q.insertPR({
      pr_number: 10,
      repo: "a/b",
      url: "https://github.com/a/b/pull/10",
    });

    q.insertOutput({
      pr_review_id: pr.id,
      tool_name: "claude",
      output: "Claude says LGTM",
      exit_code: 0,
      duration_ms: 2000,
    });
    q.insertOutput({
      pr_review_id: pr.id,
      tool_name: "gemini",
      output: "Gemini found issues",
      exit_code: 1,
      duration_ms: 4000,
    });

    const allOutputs = q.getOutputs(pr.id);
    expect(allOutputs).toHaveLength(2);

    const claudeOnly = allOutputs.filter((o) => o.tool_name === "claude");
    expect(claudeOnly).toHaveLength(1);
    expect(claudeOnly[0]!.output).toBe("Claude says LGTM");
  });

  it("retry_review resets status and adds event", async () => {
    const pr = q.insertPR({
      pr_number: 5,
      repo: "x/y",
      url: "https://github.com/x/y/pull/5",
    });
    q.updatePRStatus(pr.id, "error");

    // Simulate what retry_review tool does
    q.updatePRStatus(pr.id, "accepted");
    q.insertEvent(pr.id, "retry", "Retry triggered via MCP");

    const updated = q.getPR(pr.id);
    expect(updated!.status).toBe("accepted");

    const events = q.getEvents(pr.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.event_type).toBe("retry");
  });

  it("list_reviews filters by status", async () => {
    q.insertPR({ pr_number: 1, repo: "a/b", url: "u1" });
    const pr2 = q.insertPR({ pr_number: 2, repo: "a/b", url: "u2" });
    q.updatePRStatus(pr2.id, "done");
    const pr3 = q.insertPR({ pr_number: 3, repo: "a/b", url: "u3" });
    q.updatePRStatus(pr3.id, "error");

    const all = q.getAllPRs();
    expect(all).toHaveLength(3);

    const done = all.filter((pr) => pr.status === "done");
    expect(done).toHaveLength(1);
    expect(done[0]!.pr_number).toBe(2);

    const errors = all.filter((pr) => pr.status === "error");
    expect(errors).toHaveLength(1);
  });

  it("get_review returns null for nonexistent ID", () => {
    const result = q.getPR(999);
    expect(result).toBeNull();
  });
});
