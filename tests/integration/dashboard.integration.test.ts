import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { createDatabase } from "../../src/db/database.js";
import { createQueries } from "../../src/db/queries.js";
import { createDashboardServer } from "../../src/core/dashboard.js";
import { unlinkSync } from "fs";
import type { AppConfig } from "../../src/types/index.js";

let testCounter = 0;
function getTestDB() {
  return `/tmp/the-reviewer-integ-dash-${++testCounter}.sqlite`;
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

describe("dashboard integration", () => {
  let db: ReturnType<typeof createDatabase>;
  let q: ReturnType<typeof createQueries>;
  let dashboard: ReturnType<typeof createDashboardServer> | null = null;
  let dbPath: string;
  let port: number;

  beforeEach(() => {
    dbPath = getTestDB();
    port = 41000 + testCounter;
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

  it("should reflect inserted PR in /api/reviews", async () => {
    dashboard = createDashboardServer(db, testConfig(port));

    // Insert a PR via queries
    q.insertPR({
      pr_number: 99,
      repo: "org/project",
      title: "fix: memory leak",
      author: "alice",
      url: "https://github.com/org/project/pull/99",
      branch: "fix-leak",
    });
    q.updatePRStatus(1, "reviewing");

    const res = await fetch(`http://localhost:${port}/api/reviews`);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].pr_number).toBe(99);
    expect(data[0].status).toBe("reviewing");
    expect(data[0].title).toBe("fix: memory leak");
  });

  it("should emit SSE update when PR is inserted", async () => {
    dashboard = createDashboardServer(db, testConfig(port));

    // Connect to SSE
    const res = await fetch(`http://localhost:${port}/api/sse`);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read initial keepalive
    const { value: initial } = await reader.read();
    expect(decoder.decode(initial)).toContain(":ok");

    // Insert a PR to trigger an update
    q.insertPR({
      pr_number: 1,
      repo: "a/b",
      title: "test PR",
      url: "https://github.com/a/b/pull/1",
    });

    // Wait for SSE poll cycle (2s interval + buffer)
    const sseData = await Promise.race([
      (async () => {
        const { value } = await reader.read();
        return decoder.decode(value);
      })(),
      new Promise<string>((resolve) => setTimeout(() => resolve("timeout"), 5000)),
    ]);

    reader.cancel();

    expect(sseData).not.toBe("timeout");
    expect(sseData).toContain("event: pr-update");
    expect(sseData).toContain("a/b");
  });

  it("GET /api/reviews/:id/events returns events for a PR", async () => {
    const pr = q.insertPR({ pr_number: 1, repo: "x/y", url: "u" });
    q.insertEvent(pr.id, "detected", "Found in poll");
    q.insertEvent(pr.id, "cloning", "Cloning repo");
    q.insertEvent(pr.id, "reviewing", "Tools launched");

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/api/reviews/${pr.id}/events`);
    const data = await res.json();
    expect(data).toHaveLength(3);
    expect(data[0].event_type).toBe("detected");
    expect(data[0].message).toBe("Found in poll");
    expect(data[2].event_type).toBe("reviewing");
  });

  it("GET /api/reviews/:id/outputs returns outputs for a PR", async () => {
    const pr = q.insertPR({ pr_number: 1, repo: "x/y", url: "u" });
    q.insertOutput({
      pr_review_id: pr.id,
      tool_name: "claude",
      output: "# Review\nLooks good!",
      exit_code: 0,
      duration_ms: 12000,
    });
    q.insertOutput({
      pr_review_id: pr.id,
      tool_name: "gemini",
      output: "No issues found",
      exit_code: 0,
      duration_ms: 8000,
    });

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/api/reviews/${pr.id}/outputs`);
    const data = await res.json();
    expect(data).toHaveLength(2);
    expect(data[0].tool_name).toBe("claude");
    expect(data[0].duration_ms).toBe(12000);
    expect(data[1].tool_name).toBe("gemini");
  });

  it("server respects config.dashboard.port", async () => {
    const customPort = port + 100;
    dashboard = createDashboardServer(db, testConfig(customPort));
    expect(dashboard.server.port).toBe(customPort);

    const res = await fetch(`http://localhost:${customPort}/api/reviews`);
    expect(res.status).toBe(200);
  });

  it("HTML page includes status badges and PR data", async () => {
    q.insertPR({
      pr_number: 7,
      repo: "team/app",
      title: "feat: dark mode",
      author: "bob",
      url: "https://github.com/team/app/pull/7",
    });
    q.updatePRStatus(1, "done");

    q.insertPR({
      pr_number: 8,
      repo: "team/app",
      title: "fix: button color",
      author: "carol",
      url: "https://github.com/team/app/pull/8",
    });
    q.updatePRStatus(2, "error");
    q.updatePRToolStatus(2, { claude: "error" });

    dashboard = createDashboardServer(db, testConfig(port));
    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    // Both PRs shown
    expect(html).toContain("team/app");
    expect(html).toContain("#7");
    expect(html).toContain("#8");
    expect(html).toContain("feat: dark mode");
    expect(html).toContain("fix: button color");

    // Status badges present
    expect(html).toContain("done");
    expect(html).toContain("error");

    // Tool status pills
    expect(html).toContain("claude: error");

    // Active count (neither done nor error counts)
    expect(html).toContain("0 active");
  });

  it("returns empty arrays for non-existent PR events/outputs", async () => {
    dashboard = createDashboardServer(db, testConfig(port));

    const eventsRes = await fetch(`http://localhost:${port}/api/reviews/999/events`);
    expect(await eventsRes.json()).toEqual([]);

    const outputsRes = await fetch(`http://localhost:${port}/api/reviews/999/outputs`);
    expect(await outputsRes.json()).toEqual([]);
  });
});
