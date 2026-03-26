import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { DEFAULT_CONFIG, loadConfig, resolveHome, getDataDir, loadRepoConfig, mergeConfigs } from "../../src/core/config.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { homedir } from "os";

const TEST_DIR = "/tmp/the-reviewer-config-test";

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
    expect(config.dashboard.port).toBe(3847);
  });

  it("should expand tilde in paths", () => {
    const resolved = resolveHome("~/Documents/test");
    expect(resolved).toBe(join(homedir(), "Documents/test"));
    expect(resolveHome("/absolute/path")).toBe("/absolute/path");
  });

  it("should get data directory from config", () => {
    const dir = getDataDir();
    expect(dir).toBe(join(homedir(), ".local/share/the-reviewer"));
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

  it("should load repo config from .the-reviewer/config.yaml", () => {
    const configDir = join(TEST_DIR, ".the-reviewer");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      join(configDir, "config.yaml"),
      `launchers:\n  default_tools:\n    - "gemini"\n`
    );

    const result = loadRepoConfig(TEST_DIR);
    expect(result.launchers?.default_tools).toEqual(["gemini"]);
  });

  it("should return empty object on invalid YAML", () => {
    const configDir = join(TEST_DIR, ".the-reviewer");
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
