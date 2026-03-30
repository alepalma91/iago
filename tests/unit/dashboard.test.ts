import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../../src/db/database.js";
import { createQueries } from "../../src/db/queries.js";
import { createDashboardServer } from "../../src/core/dashboard.js";
import { unlinkSync } from "fs";
import type { AppConfig } from "../../src/types/index.js";

let testCounter = 0;
function getTestDB() {
  return `/tmp/iago-test-dash-${++testCounter}.sqlite`;
}

function cleanupDB(path: string) {
  try { unlinkSync(path); } catch {}
  try { unlinkSync(path + "-wal"); } catch {}
  try { unlinkSync(path + "-shm"); } catch {}
}

function testConfig(port: number): AppConfig {
  return {
    github: { poll_interval: "60s", trigger_reasons: ["review_requested"], watched_repos: [], ignored_repos: [] },
    sandbox: { strategy: "worktree", base_dir: "/tmp", ttl: "24h", cleanup_on_start: false, fetch_pr_refs: true },
    launchers: { max_parallel: 3, default_tools: ["claude"], tools: {} },
    prompts: { system_prompt: "", instructions: "", techniques: {}, default_techniques: [] },
    notifications: { native: false, on_new_pr: false, on_review_complete: false, on_review_error: false, sound: "default" },
    dashboard: { enabled: true, port, auto_open: false },
  };
}

describe("dashboard server", () => {
  let db: ReturnType<typeof createDatabase>;
  let q: ReturnType<typeof createQueries>;
  let dashboard: ReturnType<typeof createDashboardServer> | null = null;
  let dbPath: string;
  let port: number;

  beforeEach(() => {
    dbPath = getTestDB();
    port = 39847 + testCounter;
    cleanupDB(dbPath);
    db = createDatabase(dbPath);
    q = createQueries(db);
  });

  afterEach(() => {
    if (dashboard) {
      dashboard.stop();
      dashboard = null;
    }
    db.close();
    cleanupDB(dbPath);
  });

  it("should start server on configured port", () => {
    dashboard = createDashboardServer(db, testConfig(port));
    expect(dashboard.server.port).toBe(port);
  });

  it("GET / should return HTML with htmx", async () => {
    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const html = await res.text();
    expect(html).toContain("htmx.org");
    expect(html).toContain("iago");
    expect(html).toContain("EventSource");
  });

  it("GET / should show empty state when no PRs", async () => {
    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    expect(html).toContain("No reviews tracked yet");
    expect(html).toContain("0");
  });

  it("GET / should show PR data with status badges", async () => {
    q.insertPR({
      pr_number: 42,
      repo: "owner/repo",
      title: "feat: add auth",
      author: "developer",
      url: "https://github.com/owner/repo/pull/42",
      branch: "feat-auth",
    });
    q.updatePRStatus(1, "reviewing");

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    expect(html).toContain("repo");
    expect(html).toContain("#42");
    expect(html).toContain("developer");
    expect(html).toContain("Reviewing");
    expect(html).toContain("feat: add auth");
    expect(html).toContain("1");
  });

  it("GET /api/reviews should return JSON array", async () => {
    q.insertPR({
      pr_number: 1,
      repo: "a/b",
      url: "https://github.com/a/b/pull/1",
      title: "PR 1",
      author: "alice",
    });
    q.insertPR({
      pr_number: 2,
      repo: "a/b",
      url: "https://github.com/a/b/pull/2",
      title: "PR 2",
      author: "bob",
    });

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/api/reviews`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].repo).toBe("a/b");
  });

  it("GET /api/reviews/:id/events should return events", async () => {
    const pr = q.insertPR({ pr_number: 1, repo: "a/b", url: "u" });
    q.insertEvent(pr.id, "detected", "PR found");
    q.insertEvent(pr.id, "notified", "User notified");

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/api/reviews/${pr.id}/events`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].event_type).toBe("detected");
    expect(data[1].event_type).toBe("notified");
  });

  it("GET /api/reviews/:id/outputs should return outputs", async () => {
    const pr = q.insertPR({ pr_number: 1, repo: "a/b", url: "u" });
    q.insertOutput({
      pr_review_id: pr.id,
      tool_name: "claude",
      output: "LGTM",
      exit_code: 0,
      duration_ms: 5000,
    });

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/api/reviews/${pr.id}/outputs`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].tool_name).toBe("claude");
    expect(data[0].output).toBe("LGTM");
  });

  it("GET /api/sse should return event stream", async () => {
    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/api/sse`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    expect(res.headers.get("cache-control")).toBe("no-cache");
  });

  it("should return 404 for unknown routes", async () => {
    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/unknown`);
    expect(res.status).toBe(404);
  });

  it("should stop cleanly", async () => {
    dashboard = createDashboardServer(db, testConfig(port));
    expect(dashboard.server.port).toBe(port);

    dashboard.stop();
    dashboard = null;

    // Give the OS a moment to release the port
    await new Promise((r) => setTimeout(r, 50));

    try {
      await fetch(`http://localhost:${port}/`);
    } catch {
      // Expected: connection refused
    }
  });

  it("should show tool status pills", async () => {
    const pr = q.insertPR({
      pr_number: 10,
      repo: "a/b",
      url: "https://github.com/a/b/pull/10",
      title: "Test PR",
    });
    q.updatePRToolStatus(pr.id, { claude: "running", gemini: "done" });

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();
    expect(html).toContain("claude: running");
    expect(html).toContain("gemini: done");
  });
});
