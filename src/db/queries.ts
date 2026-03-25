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
  };
}
