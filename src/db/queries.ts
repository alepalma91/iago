import type { Database } from "bun:sqlite";
import type { PRReview, ReviewOutput, ReviewEvent, PRStatus } from "../types/index.js";

export interface Queries {
  insertPR(pr: {
    pr_number: number;
    repo: string;
    title?: string | null;
    author?: string | null;
    url: string;
    branch?: string | null;
    base_branch?: string;
  }): PRReview;

  updatePRStatus(id: number, status: PRStatus): void;
  updatePRToolStatus(id: number, toolStatus: Record<string, string>): void;
  getPR(id: number): PRReview | null;
  getPRByRepoAndNumber(repo: string, prNumber: number): PRReview | null;
  getAllPRs(): PRReview[];
  getActivePRs(): PRReview[];

  insertEvent(prReviewId: number, eventType: string, message?: string | null): ReviewEvent;
  getEvents(prReviewId: number): ReviewEvent[];

  insertOutput(output: {
    pr_review_id: number;
    tool_name: string;
    output?: string | null;
    exit_code?: number | null;
    duration_ms?: number | null;
  }): ReviewOutput;
  getOutputs(prReviewId: number): ReviewOutput[];

  // Analytics queries
  getStatusCounts(): { status: string; count: number }[];
  getToolStats(): {
    tool_name: string;
    total: number;
    success: number;
    error: number;
    timeout: number;
    avg_duration_ms: number;
    min_duration_ms: number;
    max_duration_ms: number;
  }[];
  getReviewTimeline(period: "day" | "week" | "month"): {
    date: string;
    total: number;
    success: number;
    error: number;
  }[];
  getRepoStats(): {
    repo: string;
    total: number;
    success: number;
    error: number;
    avg_duration_ms: number;
    last_review: string;
  }[];
  getAllOutputs(): { output: string | null }[];
  getAvgCompletionTime(): { avg_seconds: number | null };
}

export function createQueries(db: Database): Queries {
  const stmts = {
    insertPR: db.prepare(`
      INSERT INTO pr_reviews (pr_number, repo, title, author, url, branch, base_branch)
      VALUES ($pr_number, $repo, $title, $author, $url, $branch, $base_branch)
    `),
    updateStatus: db.prepare(`
      UPDATE pr_reviews SET status = $status, updated_at = datetime('now') WHERE id = $id
    `),
    updateToolStatus: db.prepare(`
      UPDATE pr_reviews SET tool_status = $tool_status, updated_at = datetime('now') WHERE id = $id
    `),
    getPR: db.prepare("SELECT * FROM pr_reviews WHERE id = $id"),
    getPRByRepoAndNumber: db.prepare(
      "SELECT * FROM pr_reviews WHERE repo = $repo AND pr_number = $pr_number"
    ),
    getAllPRs: db.prepare("SELECT * FROM pr_reviews ORDER BY created_at DESC"),
    getActivePRs: db.prepare(
      "SELECT * FROM pr_reviews WHERE status NOT IN ('done', 'error', 'dismissed') ORDER BY created_at DESC"
    ),
    insertEvent: db.prepare(`
      INSERT INTO review_events (pr_review_id, event_type, message)
      VALUES ($pr_review_id, $event_type, $message)
    `),
    getEvents: db.prepare(
      "SELECT * FROM review_events WHERE pr_review_id = $pr_review_id ORDER BY created_at ASC"
    ),
    insertOutput: db.prepare(`
      INSERT INTO review_output (pr_review_id, tool_name, output, exit_code, duration_ms)
      VALUES ($pr_review_id, $tool_name, $output, $exit_code, $duration_ms)
    `),
    getOutputs: db.prepare(
      "SELECT * FROM review_output WHERE pr_review_id = $pr_review_id ORDER BY created_at ASC"
    ),
    // Analytics statements
    getStatusCounts: db.prepare(`
      SELECT status, COUNT(*) as count
      FROM pr_reviews
      GROUP BY status
      ORDER BY count DESC
    `),
    getToolStats: db.prepare(`
      SELECT
        tool_name,
        COUNT(*) as total,
        SUM(CASE WHEN exit_code = 0 THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN exit_code IS NOT NULL AND exit_code != 0 THEN 1 ELSE 0 END) as error,
        SUM(CASE WHEN exit_code IS NULL THEN 1 ELSE 0 END) as timeout,
        COALESCE(AVG(duration_ms), 0) as avg_duration_ms,
        COALESCE(MIN(duration_ms), 0) as min_duration_ms,
        COALESCE(MAX(duration_ms), 0) as max_duration_ms
      FROM review_output
      GROUP BY tool_name
      ORDER BY total DESC
    `),
    getReviewTimelineDay: db.prepare(`
      SELECT
        date(created_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
      FROM pr_reviews
      WHERE created_at >= datetime('now', '-30 days')
      GROUP BY date(created_at)
      ORDER BY date ASC
    `),
    getReviewTimelineWeek: db.prepare(`
      SELECT
        strftime('%Y-W%W', created_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
      FROM pr_reviews
      WHERE created_at >= datetime('now', '-12 weeks')
      GROUP BY strftime('%Y-W%W', created_at)
      ORDER BY date ASC
    `),
    getReviewTimelineMonth: db.prepare(`
      SELECT
        strftime('%Y-%m', created_at) as date,
        COUNT(*) as total,
        SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error
      FROM pr_reviews
      WHERE created_at >= datetime('now', '-12 months')
      GROUP BY strftime('%Y-%m', created_at)
      ORDER BY date ASC
    `),
    getRepoStats: db.prepare(`
      SELECT
        r.repo,
        COUNT(*) as total,
        SUM(CASE WHEN r.status = 'done' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN r.status = 'error' THEN 1 ELSE 0 END) as error,
        COALESCE(AVG(o.avg_dur), 0) as avg_duration_ms,
        MAX(r.created_at) as last_review
      FROM pr_reviews r
      LEFT JOIN (
        SELECT pr_review_id, AVG(duration_ms) as avg_dur
        FROM review_output
        GROUP BY pr_review_id
      ) o ON o.pr_review_id = r.id
      GROUP BY r.repo
      ORDER BY total DESC
    `),
    getAllOutputs: db.prepare("SELECT output FROM review_output WHERE output IS NOT NULL"),
    getAvgCompletionTime: db.prepare(`
      SELECT AVG(
        CAST((julianday(done_at) - julianday(detected_at)) * 86400 AS INTEGER)
      ) as avg_seconds
      FROM (
        SELECT
          r.id,
          MIN(CASE WHEN e.event_type = 'detected' THEN e.created_at END) as detected_at,
          MIN(CASE WHEN e.event_type = 'done' THEN e.created_at END) as done_at
        FROM pr_reviews r
        JOIN review_events e ON e.pr_review_id = r.id
        WHERE r.status = 'done'
        GROUP BY r.id
        HAVING detected_at IS NOT NULL AND done_at IS NOT NULL
      )
    `),
  };

  function rowToPR(row: Record<string, unknown>): PRReview {
    return {
      ...row,
      tool_status: row.tool_status ? JSON.parse(row.tool_status as string) : null,
    } as PRReview;
  }

  return {
    insertPR(pr) {
      stmts.insertPR.run({
        $pr_number: pr.pr_number,
        $repo: pr.repo,
        $title: pr.title ?? null,
        $author: pr.author ?? null,
        $url: pr.url,
        $branch: pr.branch ?? null,
        $base_branch: pr.base_branch ?? "main",
      });
      const id = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
      return this.getPR(id.id)!;
    },

    updatePRStatus(id, status) {
      stmts.updateStatus.run({ $id: id, $status: status });
    },

    updatePRToolStatus(id, toolStatus) {
      stmts.updateToolStatus.run({
        $id: id,
        $tool_status: JSON.stringify(toolStatus),
      });
    },

    getPR(id) {
      const row = stmts.getPR.get({ $id: id }) as Record<string, unknown> | null;
      return row ? rowToPR(row) : null;
    },

    getPRByRepoAndNumber(repo, prNumber) {
      const row = stmts.getPRByRepoAndNumber.get({
        $repo: repo,
        $pr_number: prNumber,
      }) as Record<string, unknown> | null;
      return row ? rowToPR(row) : null;
    },

    getAllPRs() {
      const rows = stmts.getAllPRs.all() as Record<string, unknown>[];
      return rows.map(rowToPR);
    },

    getActivePRs() {
      const rows = stmts.getActivePRs.all() as Record<string, unknown>[];
      return rows.map(rowToPR);
    },

    insertEvent(prReviewId, eventType, message = null) {
      stmts.insertEvent.run({
        $pr_review_id: prReviewId,
        $event_type: eventType,
        $message: message,
      });
      const id = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
      return stmts.getEvents
        .all({ $pr_review_id: prReviewId })
        .find((e: any) => e.id === id.id) as ReviewEvent;
    },

    getEvents(prReviewId) {
      return stmts.getEvents.all({ $pr_review_id: prReviewId }) as ReviewEvent[];
    },

    insertOutput(output) {
      stmts.insertOutput.run({
        $pr_review_id: output.pr_review_id,
        $tool_name: output.tool_name,
        $output: output.output ?? null,
        $exit_code: output.exit_code ?? null,
        $duration_ms: output.duration_ms ?? null,
      });
      const id = db.query("SELECT last_insert_rowid() as id").get() as { id: number };
      return stmts.getOutputs
        .all({ $pr_review_id: output.pr_review_id })
        .find((o: any) => o.id === id.id) as ReviewOutput;
    },

    getOutputs(prReviewId) {
      return stmts.getOutputs.all({ $pr_review_id: prReviewId }) as ReviewOutput[];
    },

    // Analytics methods
    getStatusCounts() {
      return stmts.getStatusCounts.all() as { status: string; count: number }[];
    },

    getToolStats() {
      return stmts.getToolStats.all() as {
        tool_name: string;
        total: number;
        success: number;
        error: number;
        timeout: number;
        avg_duration_ms: number;
        min_duration_ms: number;
        max_duration_ms: number;
      }[];
    },

    getReviewTimeline(period) {
      const stmt =
        period === "week"
          ? stmts.getReviewTimelineWeek
          : period === "month"
            ? stmts.getReviewTimelineMonth
            : stmts.getReviewTimelineDay;
      return stmt.all() as { date: string; total: number; success: number; error: number }[];
    },

    getRepoStats() {
      return stmts.getRepoStats.all() as {
        repo: string;
        total: number;
        success: number;
        error: number;
        avg_duration_ms: number;
        last_review: string;
      }[];
    },

    getAllOutputs() {
      return stmts.getAllOutputs.all() as { output: string | null }[];
    },

    getAvgCompletionTime() {
      return (stmts.getAvgCompletionTime.get() as { avg_seconds: number | null }) ?? {
        avg_seconds: null,
      };
    },
  };
}
