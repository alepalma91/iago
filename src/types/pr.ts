export type PRStatus =
  | "detected"
  | "notified"
  | "accepted"
  | "cloning"
  | "reviewing"
  | "done"
  | "error"
  | "dismissed";

export interface PRReview {
  id: number;
  pr_number: number;
  repo: string;
  title: string | null;
  author: string | null;
  url: string;
  branch: string | null;
  base_branch: string;
  status: PRStatus;
  tool_status: Record<string, string> | null;
  worktree_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface ReviewOutput {
  id: number;
  pr_review_id: number;
  tool_name: string;
  output: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  created_at: string;
}

export interface ReviewEvent {
  id: number;
  pr_review_id: number;
  event_type: string;
  message: string | null;
  created_at: string;
}
