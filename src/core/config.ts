import { parse as parseYAML } from "yaml";
import { readFileSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AppConfig } from "../types/index.js";

export const DEFAULT_CONFIG: AppConfig = {
  github: {
    poll_interval: "60s",
    trigger_reasons: ["review_requested"],
    watched_repos: [],
    ignored_repos: [],
  },
  sandbox: {
    strategy: "worktree",
    base_dir: "~/.local/share/the-reviewer",
    ttl: "24h",
    cleanup_on_start: true,
    fetch_pr_refs: true,
  },
  launchers: {
    max_parallel: 3,
    default_tools: ["claude"],
    tools: {
      claude: {
        display_name: "Claude Code",
        command: "claude",
        args: ["-p", "{{prompt}}", "--output-format", "text"],
        stdin_mode: "none",
        output_mode: "stdout",
        timeout: "5m",
        enabled: true,
        env: { CLAUDE_CODE_HEADLESS: "1" },
      },
    },
  },
  prompts: {
    system_prompt: "",
    instructions: "",
    techniques: {},
    default_techniques: [],
  },
  notifications: {
    native: true,
    on_new_pr: true,
    on_review_complete: true,
    on_review_error: true,
    sound: "default",
  },
  dashboard: {
    enabled: true,
    port: 3847,
    auto_open: false,
  },
};

export function resolveHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}

export function getDataDir(config?: AppConfig): string {
  const base = config?.sandbox.base_dir ?? DEFAULT_CONFIG.sandbox.base_dir;
  return resolveHome(base);
}

export function loadConfig(path?: string): AppConfig {
  const configPath = path ?? resolveHome("~/.config/the-reviewer/config.yaml");

  if (!existsSync(configPath)) {
    return { ...DEFAULT_CONFIG };
  }

  const raw = readFileSync(configPath, "utf-8");
  const parsed = parseYAML(raw) as Partial<AppConfig> | null;

  if (!parsed) {
    return { ...DEFAULT_CONFIG };
  }

  return deepMerge(DEFAULT_CONFIG, parsed) as AppConfig;
}

export function loadRepoConfig(worktreePath: string): Partial<AppConfig> {
  const repoConfigPath = join(worktreePath, ".the-reviewer", "config.yaml");
  if (!existsSync(repoConfigPath)) {
    return {};
  }
  try {
    const raw = readFileSync(repoConfigPath, "utf-8");
    return (parseYAML(raw) as Partial<AppConfig>) ?? {};
  } catch {
    return {};
  }
}

export function mergeConfigs(global: AppConfig, repo: Partial<AppConfig>): AppConfig {
  if (!repo || Object.keys(repo).length === 0) {
    return global;
  }
  return deepMerge(global, repo) as AppConfig;
}

export function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];

    if (
      sourceVal !== null &&
      typeof sourceVal === "object" &&
      !Array.isArray(sourceVal) &&
      targetVal !== null &&
      typeof targetVal === "object" &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(targetVal, sourceVal);
    } else {
      result[key] = sourceVal;
    }
  }

  return result;
}
