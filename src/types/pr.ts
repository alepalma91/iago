export type PRStatus =
  | "detected"
  | "notified"
  | "accepted"
  | "cloning"
  | "reviewing"
  | "done"
  | "changes_requested"
  | "updated"
  | "error"
  | "dismissed";

export type GitHubState = "open" | "merged" | "closed";

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
  github_state: GitHubState;
  tool_status: Record<string, string> | null;
  head_sha: string | null;
  session_id: string | null;
  pid: number | null;
  worktree_path: string | null;
  opened_at: string | null;
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
