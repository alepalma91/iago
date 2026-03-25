export interface GitHubNotification {
  id: string;
  reason: string;
  subject: {
    title: string;
    url: string;
    type: string;
  };
  repository: {
    full_name: string;
    html_url: string;
  };
  updated_at: string;
  url: string;
}

export interface PollResult {
  notifications: GitHubNotification[];
  lastModified: string | null;
  pollInterval: number;
  statusCode: number;
}

export interface PRMetadata {
  number: number;
  title: string;
  author: string;
  url: string;
  branch: string;
  base_branch: string;
  repo: string;
  additions: number;
  deletions: number;
  changed_files: number;
  body: string | null;
}
