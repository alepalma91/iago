import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { DEFAULT_CONFIG, loadConfig, resolveHome, getDataDir } from "../../src/core/config.js";
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
    expect(DEFAULT_CONFIG.dashboard.port).toBe(3847);
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
