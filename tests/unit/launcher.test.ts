import { describe, expect, it } from "bun:test";
import { interpolateArgs, parseTimeout, launchTool, launchAllTools, writeOutput } from "../../src/core/launcher.js";
import { mkdirSync, readFileSync, rmSync } from "fs";
import type { LauncherProfile } from "../../src/types/index.js";

const echoProfile: LauncherProfile = {
  display_name: "Echo Tool",
  command: "echo",
  args: ["hello world"],
  stdin_mode: "none",
  output_mode: "stdout",
  timeout: "5s",
  enabled: true,
};

describe("interpolateArgs", () => {
  it("should replace single variable", () => {
    const result = interpolateArgs(["--prompt", "{{prompt}}"], { prompt: "review this" });
    expect(result).toEqual(["--prompt", "review this"]);
  });

  it("should replace multiple variables", () => {
    const result = interpolateArgs(
      ["{{repo}}", "#{{pr_number}}", "{{branch}}"],
      { repo: "owner/repo", pr_number: "42", branch: "feat-auth" }
    );
    expect(result).toEqual(["owner/repo", "#42", "feat-auth"]);
  });

  it("should keep unmatched variables as-is", () => {
    const result = interpolateArgs(["{{missing}}"], {});
    expect(result).toEqual(["{{missing}}"]);
  });

  it("should handle args with no variables", () => {
    const result = interpolateArgs(["--verbose", "--json"], {});
    expect(result).toEqual(["--verbose", "--json"]);
  });
});

describe("parseTimeout", () => {
  it("should parse minutes", () => {
    expect(parseTimeout("5m")).toBe(300_000);
  });

  it("should parse seconds", () => {
    expect(parseTimeout("300s")).toBe(300_000);
  });

  it("should parse hours", () => {
    expect(parseTimeout("1h")).toBe(3_600_000);
  });

  it("should parse milliseconds", () => {
    expect(parseTimeout("500ms")).toBe(500);
  });

  it("should default to 5m for invalid input", () => {
    expect(parseTimeout("invalid")).toBe(300_000);
  });
});

describe("launchTool", () => {
  it("should capture stdout from a process", async () => {
    const result = await launchTool(echoProfile, {}, "/tmp");
    expect(result.output).toBe("hello world");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("should record non-zero exit codes", async () => {
    const profile: LauncherProfile = {
      ...echoProfile,
      command: "sh",
      args: ["-c", "exit 1"],
    };
    const result = await launchTool(profile, {}, "/tmp");
    expect(result.exitCode).toBe(1);
  });

  it("should enforce timeout", async () => {
    const profile: LauncherProfile = {
      ...echoProfile,
      command: "sleep",
      args: ["10"],
      timeout: "100ms",
    };
    const result = await launchTool(profile, {}, "/tmp");
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(2000);
  });

  it("should interpolate variables in args", async () => {
    const profile: LauncherProfile = {
      ...echoProfile,
      args: ["repo: {{repo}}"],
    };
    const result = await launchTool(profile, { repo: "owner/repo" }, "/tmp");
    expect(result.output).toBe("repo: owner/repo");
  });
});

describe("launchAllTools", () => {
  it("should run multiple tools in parallel", async () => {
    const profiles = [
      { ...echoProfile, args: ["tool1"], display_name: "Tool 1" },
      { ...echoProfile, args: ["tool2"], display_name: "Tool 2" },
      { ...echoProfile, args: ["tool3"], display_name: "Tool 3" },
    ];
    const results = await launchAllTools(profiles, {}, "/tmp", 3);
    expect(results).toHaveLength(3);
    const outputs = results.map((r) => r.output).sort();
    expect(outputs).toEqual(["tool1", "tool2", "tool3"]);
  });
});

describe("writeOutput", () => {
  const testDir = "/tmp/iago-output-test";

  it("should write output to file", () => {
    rmSync(testDir, { recursive: true, force: true });
    const path = writeOutput(testDir, "claude", "# Review\nLGTM");
    const content = readFileSync(path, "utf-8");
    expect(content).toBe("# Review\nLGTM");
    rmSync(testDir, { recursive: true, force: true });
  });
});
