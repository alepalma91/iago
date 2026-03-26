import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../../src/db/database.js";
import { unlinkSync } from "fs";
import { Database } from "bun:sqlite";

const TEST_DB = "/tmp/the-reviewer-test-db.sqlite";

function cleanup() {
  try {
    unlinkSync(TEST_DB);
  } catch {}
  try {
    unlinkSync(TEST_DB + "-wal");
  } catch {}
  try {
    unlinkSync(TEST_DB + "-shm");
  } catch {}
}

describe("createDatabase", () => {
  beforeEach(cleanup);
  afterEach(cleanup);

  it("should enable WAL journal mode", () => {
    const db = createDatabase(TEST_DB);
    const row = db.query("PRAGMA journal_mode").get() as { journal_mode: string };
    expect(row.journal_mode).toBe("wal");
    db.close();
  });

  it("should create pr_reviews table", () => {
    const db = createDatabase(TEST_DB);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='pr_reviews'")
      .all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("should create review_output table", () => {
    const db = createDatabase(TEST_DB);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='review_output'")
      .all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("should create review_events table", () => {
    const db = createDatabase(TEST_DB);
    const tables = db
      .query("SELECT name FROM sqlite_master WHERE type='table' AND name='review_events'")
      .all();
    expect(tables).toHaveLength(1);
    db.close();
  });

  it("should have correct columns on pr_reviews", () => {
    const db = createDatabase(TEST_DB);
    const cols = db.query("PRAGMA table_info(pr_reviews)").all() as { name: string }[];
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("pr_number");
    expect(colNames).toContain("repo");
    expect(colNames).toContain("title");
    expect(colNames).toContain("author");
    expect(colNames).toContain("url");
    expect(colNames).toContain("branch");
    expect(colNames).toContain("base_branch");
    expect(colNames).toContain("status");
    expect(colNames).toContain("tool_status");
    expect(colNames).toContain("worktree_path");
    expect(colNames).toContain("created_at");
    expect(colNames).toContain("updated_at");
    db.close();
  });

  it("should be idempotent (calling twice doesn't error)", () => {
    const db1 = createDatabase(TEST_DB);
    db1.close();
    const db2 = createDatabase(TEST_DB);
    const row = db2.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBe(2);
    db2.close();
  });

  it("should set schema_version to 2", () => {
    const db = createDatabase(TEST_DB);
    const row = db.query("SELECT version FROM schema_version LIMIT 1").get() as { version: number };
    expect(row.version).toBe(2);
    db.close();
  });
});
