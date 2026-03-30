import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import {
  DEFAULT_CONFIG, loadConfig, resolveHome, getDataDir, loadRepoConfig, mergeConfigs,
  globMatch, matchRepoConfig, shouldAutoReview, applyStrategy, resolveFullConfig,
} from "../../src/core/config.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AppConfig } from "../../src/types/config.js";

const TEST_DIR = "/tmp/iago-config-test";

describe("config", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should have correct default structure", () => {
    expect(DEFAULT_CONFIG.github.poll_interval).toBe("60s");
    expect(DEFAULT_CONFIG.sandbox.strategy).toBe("worktree");
    expect(DEFAULT_CONFIG.launchers.max_parallel).toBe(3);
    expect(DEFAULT_CONFIG.notifications.native).toBe(true);
    expect(DEFAULT_CONFIG.dashboard.port).toBe(1460);
  });

  it("should have claude enabled by default", () => {
    expect(DEFAULT_CONFIG.launchers.default_tools).toContain("claude");
    expect(DEFAULT_CONFIG.launchers.tools.claude).toBeDefined();
    expect(DEFAULT_CONFIG.launchers.tools.claude!.enabled).toBe(true);
  });

  it("should return defaults when config file is missing", () => {
    const config = loadConfig("/tmp/nonexistent-config.yaml");
    expect(config.github.poll_interval).toBe("60s");
    expect(config.launchers.max_parallel).toBe(3);
  });

  it("should merge YAML config with defaults", () => {
    const yamlContent = `
github:
  poll_interval: "30s"
  ignored_repos:
    - "org/legacy"
launchers:
  max_parallel: 5
`;
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(configPath, yamlContent);

    const config = loadConfig(configPath);
    expect(config.github.poll_interval).toBe("30s");
    expect(config.github.ignored_repos).toEqual(["org/legacy"]);
    expect(config.launchers.max_parallel).toBe(5);
    // Defaults preserved for unset fields
    expect(config.sandbox.strategy).toBe("worktree");
    expect(config.dashboard.port).toBe(1460);
  });

  it("should expand tilde in paths", () => {
    const resolved = resolveHome("~/Documents/test");
    expect(resolved).toBe(join(homedir(), "Documents/test"));
    expect(resolveHome("/absolute/path")).toBe("/absolute/path");
  });

  it("should get data directory from config", () => {
    const dir = getDataDir();
    expect(dir).toBe(join(homedir(), ".local/share/iago"));
  });
});

describe("loadRepoConfig", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should return empty object when no repo config exists", () => {
    const result = loadRepoConfig(TEST_DIR);
    expect(result).toEqual({});
  });

  it("should load repo config from .iago/config.yaml", () => {
    const configDir = join(TEST_DIR, ".iago");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      `launchers:\n  default_tools:\n    - "gemini"\n`
    );

    const result = loadRepoConfig(TEST_DIR);
    expect(result.launchers?.default_tools).toEqual(["gemini"]);
  });

  it("should return empty object on invalid YAML", () => {
    const configDir = join(TEST_DIR, ".iago");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(join(configDir, "config.yaml"), "");

    const result = loadRepoConfig(TEST_DIR);
    expect(result).toEqual({});
  });
});

describe("mergeConfigs", () => {
  it("should return global config unchanged when repo config is empty", () => {
    const global = { ...DEFAULT_CONFIG };
    const result = mergeConfigs(global, {});
    expect(result).toEqual(global);
  });

  it("should override default_tools from repo config", () => {
    const global = { ...DEFAULT_CONFIG };
    const repo = { launchers: { default_tools: ["gemini"] } } as any;
    const result = mergeConfigs(global, repo);
    expect(result.launchers.default_tools).toEqual(["gemini"]);
    // Other launcher settings preserved
    expect(result.launchers.max_parallel).toBe(3);
  });

  it("should add technique from repo config", () => {
    const global = { ...DEFAULT_CONFIG };
    const repo = {
      prompts: {
        default_techniques: ["security"],
        techniques: {
          security: {
            description: "Security focused",
            prompt_file: "~/prompts/security.md",
          },
        },
      },
    } as any;
    const result = mergeConfigs(global, repo);
    expect(result.prompts.default_techniques).toEqual(["security"]);
    expect(result.prompts.techniques.security).toBeDefined();
  });

  it("should preserve non-overridden sections", () => {
    const global = { ...DEFAULT_CONFIG };
    const repo = { github: { poll_interval: "120s" } } as any;
    const result = mergeConfigs(global, repo);
    expect(result.github.poll_interval).toBe("120s");
    expect(result.sandbox.strategy).toBe("worktree");
    expect(result.notifications.native).toBe(true);
  });
});

describe("globMatch", () => {
  it("should match exact strings", () => {
    expect(globMatch("org/repo", "org/repo")).toBe(true);
    expect(globMatch("org/repo", "org/other")).toBe(false);
  });

  it("should match wildcard *", () => {
    expect(globMatch("*", "org/repo")).toBe(true);
    expect(globMatch("*", "anything")).toBe(true);
  });

  it("should match glob patterns with trailing wildcard", () => {
    expect(globMatch("org/repo-*", "org/repo-foo")).toBe(true);
    expect(globMatch("org/repo-*", "org/repo-bar-baz")).toBe(true);
    expect(globMatch("org/repo-*", "org/other")).toBe(false);
  });

  it("should match glob patterns with prefix wildcard", () => {
    expect(globMatch("*/repo", "org/repo")).toBe(true);
    expect(globMatch("*/repo", "other/repo")).toBe(true);
    expect(globMatch("*/repo", "org/other")).toBe(false);
  });

  it("should match ? as single character", () => {
    expect(globMatch("org/repo-?", "org/repo-1")).toBe(true);
    expect(globMatch("org/repo-?", "org/repo-ab")).toBe(false);
  });

  it("should escape regex special chars", () => {
    expect(globMatch("org/repo.v2", "org/repo.v2")).toBe(true);
    expect(globMatch("org/repo.v2", "org/repoxv2")).toBe(false);
  });
});

describe("matchRepoConfig", () => {
  const baseConfig: AppConfig = {
    ...DEFAULT_CONFIG,
    repos: {
      "*": { notifications: { sound: "default" } as any },
      "org/platform-*": { auto_review: false, prompts: { instructions: "platform.md" } as any },
      "org/platform-core": { auto_review: true },
    },
  };

  it("should return empty for no repos config", () => {
    const config = { ...DEFAULT_CONFIG, repos: {} };
    expect(matchRepoConfig(config, "org/repo")).toEqual({});
  });

  it("should match exact repo", () => {
    const result = matchRepoConfig(baseConfig, "org/platform-core");
    expect(result.auto_review).toBe(true);
  });

  it("should match glob pattern", () => {
    const result = matchRepoConfig(baseConfig, "org/platform-api");
    expect(result.auto_review).toBe(false);
    expect((result.prompts as any)?.instructions).toBe("platform.md");
  });

  it("should match wildcard fallback", () => {
    const result = matchRepoConfig(baseConfig, "other/unrelated");
    expect((result.notifications as any)?.sound).toBe("default");
  });

  it("should merge all matches with specificity priority", () => {
    // org/platform-core matches: wildcard, glob "org/platform-*", and exact
    // Exact should win for auto_review
    const result = matchRepoConfig(baseConfig, "org/platform-core");
    expect(result.auto_review).toBe(true); // exact match wins
    expect((result.notifications as any)?.sound).toBe("default"); // from wildcard
    expect((result.prompts as any)?.instructions).toBe("platform.md"); // from glob
  });
});

describe("shouldAutoReview", () => {
  it("should return true when auto_review is enabled for exact match", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      repos: { "org/repo": { auto_review: true } },
    };
    expect(shouldAutoReview(config, "org/repo")).toBe(true);
  });

  it("should return false when not configured", () => {
    expect(shouldAutoReview(DEFAULT_CONFIG, "org/repo")).toBe(false);
  });

  it("should return false when explicitly disabled", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      repos: { "org/repo": { auto_review: false } },
    };
    expect(shouldAutoReview(config, "org/repo")).toBe(false);
  });

  it("should match via glob pattern", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      repos: { "org/auto-*": { auto_review: true } },
    };
    expect(shouldAutoReview(config, "org/auto-deploy")).toBe(true);
    expect(shouldAutoReview(config, "org/manual-deploy")).toBe(false);
  });
});

describe("applyStrategy", () => {
  it("should override array with _strategy: override", () => {
    const parent = ["a", "b"];
    const child = { _strategy: "override", _values: ["x", "y"] };
    expect(applyStrategy(parent, child)).toEqual(["x", "y"]);
  });

  it("should extend array with _strategy: extend", () => {
    const parent = ["a", "b"];
    const child = { _strategy: "extend", _values: ["c"] };
    expect(applyStrategy(parent, child)).toEqual(["a", "b", "c"]);
  });

  it("should shallow-merge object with _strategy: extend", () => {
    const parent = { a: 1, b: 2 };
    const child = { _strategy: "extend", c: 3 };
    const result = applyStrategy(parent, child);
    expect(result).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("should deep-merge object with _strategy: merge", () => {
    const parent = { a: { x: 1 }, b: 2 };
    const child = { _strategy: "merge", a: { y: 2 } };
    const result = applyStrategy(parent, child);
    expect(result.a).toEqual({ x: 1, y: 2 });
    expect(result.b).toBe(2);
  });

  it("should return undefined when no strategy present", () => {
    expect(applyStrategy("parent", "child")).toBeUndefined();
    expect(applyStrategy(1, 2)).toBeUndefined();
  });

  it("should return parent when child is null", () => {
    expect(applyStrategy("parent", null)).toBe("parent");
  });
});

describe("resolveFullConfig", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should apply repo-level config from global repos section", () => {
    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      repos: {
        "org/repo": {
          prompts: { instructions: "custom.md" } as any,
        },
      },
    };
    const resolved = resolveFullConfig(config, "org/repo");
    expect(resolved.prompts.instructions).toBe("custom.md");
    // Other settings preserved
    expect(resolved.launchers.max_parallel).toBe(3);
  });

  it("should apply in-repo config as highest priority", () => {
    mkdirSync(join(TEST_DIR, ".iago"), { recursive: true });
    writeFileSync(
      join(TEST_DIR, ".iago", "config.yaml"),
      `launchers:\n  max_parallel: 10\n`
    );

    const config: AppConfig = {
      ...DEFAULT_CONFIG,
      repos: {
        "org/repo": {
          prompts: { instructions: "from-global.md" } as any,
        },
      },
    };
    const resolved = resolveFullConfig(config, "org/repo", TEST_DIR);
    expect(resolved.launchers.max_parallel).toBe(10);
    expect(resolved.prompts.instructions).toBe("from-global.md");
  });

  it("should return base config when no repo matches", () => {
    const resolved = resolveFullConfig(DEFAULT_CONFIG, "org/repo");
    expect(resolved).toEqual(DEFAULT_CONFIG);
  });
});

describe("loadRepoConfig backward compatibility", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("should fall back to .the-reviewer/config.yaml", () => {
    const oldConfigDir = join(TEST_DIR, ".the-reviewer");
    mkdirSync(oldConfigDir, { recursive: true });
    writeFileSync(
      join(oldConfigDir, "config.yaml"),
      `launchers:\n  max_parallel: 7\n`
    );

    const result = loadRepoConfig(TEST_DIR);
    expect(result.launchers?.max_parallel).toBe(7);
  });

  it("should prefer .iago over .the-reviewer", () => {
    const oldDir = join(TEST_DIR, ".the-reviewer");
    const newDir = join(TEST_DIR, ".iago");
    mkdirSync(oldDir, { recursive: true });
    mkdirSync(newDir, { recursive: true });
    writeFileSync(join(oldDir, "config.yaml"), `launchers:\n  max_parallel: 7\n`);
    writeFileSync(join(newDir, "config.yaml"), `launchers:\n  max_parallel: 9\n`);

    const result = loadRepoConfig(TEST_DIR);
    expect(result.launchers?.max_parallel).toBe(9);
  });
});

describe("default config has repos field", () => {
  it("should have empty repos by default", () => {
    expect(DEFAULT_CONFIG.repos).toEqual({});
  });

  it("should load config with repos from YAML", () => {
    mkdirSync(TEST_DIR, { recursive: true });
    const yamlContent = `
repos:
  "org/repo":
    auto_review: true
  "org/other-*":
    auto_review: false
`;
    const configPath = join(TEST_DIR, "config.yaml");
    writeFileSync(configPath, yamlContent);

    const config = loadConfig(configPath);
    expect(config.repos["org/repo"]?.auto_review).toBe(true);
    expect(config.repos["org/other-*"]?.auto_review).toBe(false);
  });
});
