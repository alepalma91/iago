import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../../src/db/database.js";
import { createQueries } from "../../src/db/queries.js";
import { unlinkSync } from "fs";
import type { Database } from "bun:sqlite";

const TEST_DB = "/tmp/iago-test-queries.sqlite";

function cleanup() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
}

describe("queries", () => {
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

  it("should insert and retrieve a PR", () => {
    const pr = q.insertPR({
      pr_number: 42,
      repo: "owner/repo",
      title: "feat: add auth",
      author: "developer",
      url: "https://github.com/owner/repo/pull/42",
      branch: "feat-auth",
    });
    expect(pr.id).toBe(1);
    expect(pr.pr_number).toBe(42);
    expect(pr.repo).toBe("owner/repo");
    expect(pr.status).toBe("detected");

    const fetched = q.getPR(pr.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe("feat: add auth");
  });

  it("should get PR by repo and number", () => {
    q.insertPR({
      pr_number: 10,
      repo: "org/project",
      url: "https://github.com/org/project/pull/10",
    });
    const found = q.getPRByRepoAndNumber("org/project", 10);
    expect(found).not.toBeNull();
    expect(found!.pr_number).toBe(10);

    const missing = q.getPRByRepoAndNumber("org/project", 999);
    expect(missing).toBeNull();
  });

  it("should enforce unique constraint on (repo, pr_number)", () => {
    q.insertPR({
      pr_number: 1,
      repo: "owner/repo",
      url: "https://github.com/owner/repo/pull/1",
    });
    expect(() =>
      q.insertPR({
        pr_number: 1,
        repo: "owner/repo",
        url: "https://github.com/owner/repo/pull/1",
      })
    ).toThrow();
  });

  it("should update PR status", () => {
    const pr = q.insertPR({
      pr_number: 5,
      repo: "a/b",
      url: "https://github.com/a/b/pull/5",
    });
    q.updatePRStatus(pr.id, "reviewing");
    const updated = q.getPR(pr.id);
    expect(updated!.status).toBe("reviewing");
  });

  it("should update and parse JSON tool_status", () => {
    const pr = q.insertPR({
      pr_number: 6,
      repo: "a/b",
      url: "https://github.com/a/b/pull/6",
    });
    q.updatePRToolStatus(pr.id, { claude: "running", gemini: "done" });
    const updated = q.getPR(pr.id);
    expect(updated!.tool_status).toEqual({ claude: "running", gemini: "done" });
  });

  it("should get all PRs and active PRs", () => {
    q.insertPR({ pr_number: 1, repo: "a/b", url: "u1" });
    q.insertPR({ pr_number: 2, repo: "a/b", url: "u2" });
    const pr3 = q.insertPR({ pr_number: 3, repo: "a/b", url: "u3" });
    q.updatePRStatus(pr3.id, "done");

    expect(q.getAllPRs()).toHaveLength(3);
    expect(q.getActivePRs()).toHaveLength(2);
  });

  it("should insert and retrieve events", () => {
    const pr = q.insertPR({ pr_number: 1, repo: "a/b", url: "u" });
    q.insertEvent(pr.id, "detected", "PR detected");
    q.insertEvent(pr.id, "notified", "User notified");

    const events = q.getEvents(pr.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_type).toBe("detected");
    expect(events[1]!.event_type).toBe("notified");
  });

  it("should insert and retrieve outputs", () => {
    const pr = q.insertPR({ pr_number: 1, repo: "a/b", url: "u" });
    const output = q.insertOutput({
      pr_review_id: pr.id,
      tool_name: "claude",
      output: "# Review\nLGTM",
      exit_code: 0,
      duration_ms: 5000,
    });
    expect(output.tool_name).toBe("claude");
    expect(output.exit_code).toBe(0);

    const outputs = q.getOutputs(pr.id);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.output).toBe("# Review\nLGTM");
  });
});
