import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../../src/db/database.js";
import { createQueries } from "../../src/db/queries.js";
import { unlinkSync } from "fs";
import type { PRMetadata } from "../../src/types/index.js";
import type { PipelineContext } from "../../src/core/pipeline.js";
import { DEFAULT_CONFIG } from "../../src/core/config.js";

const TEST_DB = "/tmp/the-reviewer-pipeline-test.sqlite";

function cleanup() {
  try { unlinkSync(TEST_DB); } catch {}
  try { unlinkSync(TEST_DB + "-wal"); } catch {}
  try { unlinkSync(TEST_DB + "-shm"); } catch {}
}

const sampleMetadata: PRMetadata = {
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

describe("pipeline - database operations", () => {
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

  it("should insert PR and track status transitions", () => {
    const pr = queries.insertPR({
      pr_number: sampleMetadata.number,
      repo: sampleMetadata.repo,
      title: sampleMetadata.title,
      author: sampleMetadata.author,
      url: sampleMetadata.url,
      branch: sampleMetadata.branch,
      base_branch: sampleMetadata.base_branch,
    });

    expect(pr.status).toBe("detected");

    queries.updatePRStatus(pr.id, "notified");
    expect(queries.getPR(pr.id)!.status).toBe("notified");

    queries.updatePRStatus(pr.id, "accepted");
    expect(queries.getPR(pr.id)!.status).toBe("accepted");

    queries.updatePRStatus(pr.id, "reviewing");
    expect(queries.getPR(pr.id)!.status).toBe("reviewing");

    queries.updatePRStatus(pr.id, "done");
    expect(queries.getPR(pr.id)!.status).toBe("done");
  });

  it("should not duplicate existing PRs", () => {
    queries.insertPR({
      pr_number: 42,
      repo: "owner/repo",
      url: "https://github.com/owner/repo/pull/42",
    });

    const existing = queries.getPRByRepoAndNumber("owner/repo", 42);
    expect(existing).not.toBeNull();
  });

  it("should track events and errors", () => {
    const pr = queries.insertPR({
      pr_number: 42,
      repo: "owner/repo",
      url: "https://github.com/owner/repo/pull/42",
    });

    queries.insertEvent(pr.id, "detected", "PR detected");
    queries.insertEvent(pr.id, "error", "Clone failed: network error");

    queries.updatePRStatus(pr.id, "error");

    const events = queries.getEvents(pr.id);
    expect(events).toHaveLength(2);
    expect(events[0]!.event_type).toBe("detected");
    expect(events[1]!.event_type).toBe("error");
    expect(events[1]!.message).toContain("network error");

    expect(queries.getPR(pr.id)!.status).toBe("error");
  });
});
