import { parse as parseYAML, stringify as stringifyYAML } from "yaml";
import { readFileSync, writeFileSync, existsSync, cpSync, mkdirSync, renameSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { AppConfig, RepoConfig } from "../types/index.js";

// ── Environment variable overrides ───────────────────────────────────

export function getConfigDir(): string {
  return process.env.IAGO_CONFIG ?? resolveHome("~/.config/iago");
}

function getDefaultDataDir(): string {
  return process.env.IAGO_DATA ?? resolveHome("~/.local/share/iago");
}

// ── Migration from the-reviewer to iago ──────────────────────────────

let migrationChecked = false;

export function migrateFromOldPaths(): void {
  if (migrationChecked) return;
  migrationChecked = true;

  const oldConfigDir = resolveHome("~/.config/the-reviewer");
  const newConfigDir = getConfigDir();
  const oldDataDir = resolveHome("~/.local/share/the-reviewer");
  const newDataDir = getDefaultDataDir();

  // Migrate config dir
  if (existsSync(oldConfigDir) && !existsSync(newConfigDir)) {
    console.log(`iago: migrating config from ${oldConfigDir} to ${newConfigDir}...`);
    mkdirSync(newConfigDir, { recursive: true });
    cpSync(oldConfigDir, newConfigDir, { recursive: true });
  }

  // Migrate data dir
  if (existsSync(oldDataDir) && !existsSync(newDataDir)) {
    console.log(`iago: migrating data from ${oldDataDir} to ${newDataDir}...`);
    mkdirSync(newDataDir, { recursive: true });
    cpSync(oldDataDir, newDataDir, { recursive: true });
  }
}

export const DEFAULT_CONFIG: AppConfig = {
  github: {
    poll_interval: "60s",
    trigger_reasons: ["review_requested"],
    watched_repos: [],
    ignored_repos: [],
  },
  sandbox: {
    strategy: "worktree",
    base_dir: "~/.local/share/iago",
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
        args: ["--dangerously-skip-permissions", "-p", "{{prompt}}", "--output-format", "text", "--session-id", "{{session_id}}"],
        stdin_mode: "none",
        output_mode: "stdout",
        timeout: "5m",
        enabled: true,
        env: {
          CLAUDE_CODE_HEADLESS: "1",
          CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
        },
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
    port: 1460,
    auto_open: false,
  },
  repos: {},
};

export function resolveHome(filepath: string): string {
  if (filepath.startsWith("~/") || filepath === "~") {
    return join(homedir(), filepath.slice(1));
  }
  return filepath;
}

export function getDataDir(config?: AppConfig): string {
  if (process.env.IAGO_DATA) return process.env.IAGO_DATA;
  const base = config?.sandbox.base_dir ?? DEFAULT_CONFIG.sandbox.base_dir;
  return resolveHome(base);
}

export function loadConfig(path?: string): AppConfig {
  // Run migration check on first load
  if (!path) migrateFromOldPaths();

  const configPath = path ?? join(getConfigDir(), "config.yaml");

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

export function saveConfig(config: AppConfig, path?: string): void {
  const configPath = path ?? join(getConfigDir(), "config.yaml");
  const configDir = join(configPath, "..");
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const yaml = stringifyYAML(config, { lineWidth: 120 });
  const tmpPath = configPath + ".tmp";
  writeFileSync(tmpPath, yaml, "utf-8");
  renameSync(tmpPath, configPath);
}

export function loadRepoConfig(worktreePath: string): Partial<AppConfig> {
  // Check .iago first, then fall back to .the-reviewer for backward compatibility
  let repoConfigPath = join(worktreePath, ".iago", "config.yaml");
  if (!existsSync(repoConfigPath)) {
    repoConfigPath = join(worktreePath, ".the-reviewer", "config.yaml");
  }
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

// ── Strategy-aware merge ─────────────────────────────────────────────

/**
 * Apply merge strategy for values that include a `_strategy` field.
 *
 * - `override` — replace parent value entirely (default for arrays)
 * - `extend`  — append to parent array, or shallow-merge into parent object
 * - `merge`   — deep merge (default for objects)
 */
export function applyStrategy(parent: any, child: any): any {
  if (child == null) return parent;

  // If child has a _strategy directive
  if (typeof child === "object" && !Array.isArray(child) && "_strategy" in child) {
    const strategy = child._strategy as string;
    const values = "_values" in child ? child._values : undefined;

    switch (strategy) {
      case "override":
        return values !== undefined ? values : child;
      case "extend":
        if (Array.isArray(parent) && Array.isArray(values)) {
          return [...parent, ...values];
        }
        if (typeof parent === "object" && !Array.isArray(parent)) {
          // Shallow-merge, excluding _strategy and _values keys
          const { _strategy, _values, ...rest } = child;
          return { ...parent, ...rest };
        }
        return values !== undefined ? values : child;
      case "merge":
      default:
        if (typeof parent === "object" && !Array.isArray(parent)) {
          const { _strategy, _values, ...rest } = child;
          return deepMerge(parent as Record<string, any>, rest);
        }
        return values !== undefined ? values : child;
    }
  }

  return undefined; // signal: no strategy found, use default merge
}

// ── Glob matching for repo names ─────────────────────────────────────

/**
 * Match a repo name against a pattern that may contain glob wildcards.
 * Supports `*` as a wildcard segment and `?` for single chars.
 */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === "*") return true;
  if (pattern === value) return true;

  // Convert glob pattern to regex
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")  // escape regex chars (not * and ?)
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");

  return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Find and merge all matching repo configs for a given repo name.
 * Priority: exact match > glob match > wildcard ("*")
 * All matches are merged, with more specific configs taking precedence.
 */
export function matchRepoConfig(config: AppConfig, repo: string): RepoConfig {
  if (!config.repos || Object.keys(config.repos).length === 0) {
    return {};
  }

  // Collect matches in priority order (least specific first)
  const matches: RepoConfig[] = [];

  // 1. Wildcard fallback
  if (config.repos["*"]) {
    matches.push(config.repos["*"]);
  }

  // 2. Glob matches (excluding exact and wildcard)
  for (const [pattern, repoConfig] of Object.entries(config.repos)) {
    if (pattern === "*" || pattern === repo) continue;
    if (pattern.includes("*") || pattern.includes("?")) {
      if (globMatch(pattern, repo)) {
        matches.push(repoConfig);
      }
    }
  }

  // 3. Exact match (highest priority)
  if (config.repos[repo]) {
    matches.push(config.repos[repo]);
  }

  if (matches.length === 0) return {};

  // Merge all matches (later entries override earlier)
  let result: RepoConfig = {};
  for (const match of matches) {
    result = deepMerge(result, match) as RepoConfig;
  }
  return result;
}

/**
 * Check if a repo should be auto-reviewed based on config.
 */
export function shouldAutoReview(config: AppConfig, repo: string): boolean {
  const repoConfig = matchRepoConfig(config, repo);
  return repoConfig?.auto_review === true;
}

/**
 * Resolve the full config for a specific repo, applying the 4-layer merge:
 * 1. DEFAULT_CONFIG
 * 2. Global config.yaml (already merged by loadConfig())
 * 3. Repo-level config from global repos[match]
 * 4. In-repo .iago/config.yaml (from worktree) — highest priority
 */
export function resolveFullConfig(
  config: AppConfig,
  repo: string,
  worktreePath?: string
): AppConfig {
  // Layer 1+2: config already has DEFAULT_CONFIG merged with global config.yaml

  // Layer 3: repo-level config from global repos section
  const repoConfig = matchRepoConfig(config, repo);
  let merged = config;
  if (Object.keys(repoConfig).length > 0) {
    // Apply repo-specific overrides to the relevant sections
    const repoOverrides: Partial<AppConfig> = {};
    if (repoConfig.prompts) repoOverrides.prompts = repoConfig.prompts as any;
    if (repoConfig.launchers) repoOverrides.launchers = repoConfig.launchers as any;
    if (repoConfig.notifications) repoOverrides.notifications = repoConfig.notifications as any;
    merged = deepMerge(merged, repoOverrides) as AppConfig;
  }

  // Layer 4: in-repo config (highest priority)
  if (worktreePath) {
    const inRepoConfig = loadRepoConfig(worktreePath);
    if (Object.keys(inRepoConfig).length > 0) {
      merged = deepMerge(merged, inRepoConfig) as AppConfig;
    }
  }

  return merged;
}

// ── Deep merge utility ───────────────────────────────────────────────

export function deepMerge(target: Record<string, any>, source: Record<string, any>): Record<string, any> {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const targetVal = target[key];
    const sourceVal = source[key];

    // Check for strategy-aware merge
    const strategyResult = applyStrategy(targetVal, sourceVal);
    if (strategyResult !== undefined) {
      result[key] = strategyResult;
      continue;
    }

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
