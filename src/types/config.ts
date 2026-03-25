export interface AppConfig {
  github: GitHubConfig;
  sandbox: SandboxConfig;
  launchers: LaunchersConfig;
  prompts: PromptsConfig;
  notifications: NotificationsConfig;
  dashboard: DashboardConfig;
}

export interface GitHubConfig {
  poll_interval: string;
  trigger_reasons: string[];
  watched_repos: string[];
  ignored_repos: string[];
}

export interface SandboxConfig {
  strategy: "worktree" | "shallow-clone";
  base_dir: string;
  ttl: string;
  cleanup_on_start: boolean;
  fetch_pr_refs: boolean;
}

export interface LaunchersConfig {
  max_parallel: number;
  default_tools: string[];
  tools: Record<string, LauncherProfile>;
}

export interface LauncherProfile {
  display_name: string;
  command: string;
  args: string[];
  stdin_mode: "pipe" | "file" | "none";
  output_mode: "stdout" | "file" | "json";
  output_file?: string;
  timeout: string;
  enabled: boolean;
  env?: Record<string, string>;
}

export interface PromptsConfig {
  system_prompt: string;
  instructions: string;
  techniques: Record<string, TechniqueConfig>;
  default_techniques: string[];
}

export interface TechniqueConfig {
  description: string;
  prompt_file: string;
}

export interface NotificationsConfig {
  native: boolean;
  on_new_pr: boolean;
  on_review_complete: boolean;
  on_review_error: boolean;
  sound: string;
}

export interface DashboardConfig {
  enabled: boolean;
  port: number;
  auto_open: boolean;
}
