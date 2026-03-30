import { describe, expect, it } from "bun:test";
import {
  assemblePrompt,
  getDefaultSystemPrompt,
  getDefaultInstructions,
  loadPromptFile,
} from "../../src/core/prompt.js";
import type { PRMetadata } from "../../src/types/index.js";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";

const sampleMetadata: PRMetadata = {
  number: 42,
  title: "feat: add auth",
  author: "developer",
  url: "https://github.com/owner/repo/pull/42",
  branch: "feat-auth",
  base_branch: "main",
  repo: "owner/repo",
  additions: 100,
  deletions: 10,
  changed_files: 3,
  body: null,
};

const sampleDiff = `diff --git a/src/auth.ts b/src/auth.ts
new file mode 100644
--- /dev/null
+++ b/src/auth.ts
@@ -0,0 +1,5 @@
+export function authenticate(token: string) {
+  return token === "secret";
+}`;

describe("getDefaultSystemPrompt", () => {
  it("should return a non-empty system prompt", () => {
    const prompt = getDefaultSystemPrompt();
    expect(prompt.length).toBeGreaterThan(50);
    expect(prompt).toContain("code reviewer");
  });
});

describe("getDefaultInstructions", () => {
  it("should return instructions with severity levels", () => {
    const instructions = getDefaultInstructions();
    expect(instructions).toContain("CRITICAL");
    expect(instructions).toContain("WARNING");
    expect(instructions).toContain("SUGGESTION");
  });
});

describe("loadPromptFile", () => {
  const testDir = "/tmp/iago-prompt-test";

  it("should return empty string for missing file", () => {
    expect(loadPromptFile("/tmp/nonexistent-prompt.md")).toBe("");
  });

  it("should load content from existing file", () => {
    mkdirSync(testDir, { recursive: true });
    const path = join(testDir, "test.md");
    writeFileSync(path, "Custom system prompt content");
    expect(loadPromptFile(path)).toBe("Custom system prompt content");
    rmSync(testDir, { recursive: true, force: true });
  });
});

describe("assemblePrompt", () => {
  it("should include system prompt", () => {
    const result = assemblePrompt({ metadata: sampleMetadata, diff: sampleDiff });
    expect(result).toContain("code reviewer");
  });

  it("should include review instructions", () => {
    const result = assemblePrompt({ metadata: sampleMetadata, diff: sampleDiff });
    expect(result).toContain("## Review Instructions");
    expect(result).toContain("CRITICAL");
  });

  it("should include PR metadata", () => {
    const result = assemblePrompt({ metadata: sampleMetadata, diff: sampleDiff });
    expect(result).toContain("**Title**: feat: add auth");
    expect(result).toContain("**Author**: developer");
    expect(result).toContain("**Branch**: feat-auth -> main");
  });

  it("should include diff in code block", () => {
    const result = assemblePrompt({ metadata: sampleMetadata, diff: sampleDiff });
    expect(result).toContain("```diff");
    expect(result).toContain("diff --git");
    expect(result).toContain("```");
  });

  it("should use custom system prompt when provided", () => {
    const result = assemblePrompt({
      metadata: sampleMetadata,
      diff: sampleDiff,
      systemPrompt: "You are a security auditor.",
    });
    expect(result).toContain("You are a security auditor.");
    expect(result).not.toContain("expert code reviewer");
  });

  it("should use custom instructions when provided", () => {
    const result = assemblePrompt({
      metadata: sampleMetadata,
      diff: sampleDiff,
      instructions: "Only check for SQL injection.",
    });
    expect(result).toContain("Only check for SQL injection.");
  });

  it("should include techniques as additional focus areas", () => {
    const result = assemblePrompt({
      metadata: sampleMetadata,
      diff: sampleDiff,
      techniques: ["Check for memory leaks in closures."],
    });
    expect(result).toContain("## Additional Focus Areas");
    expect(result).toContain("Check for memory leaks in closures.");
  });

  it("should skip techniques section when empty", () => {
    const result = assemblePrompt({
      metadata: sampleMetadata,
      diff: sampleDiff,
      techniques: [],
    });
    expect(result).not.toContain("## Additional Focus Areas");
  });

  it("should skip whitespace-only techniques", () => {
    const result = assemblePrompt({
      metadata: sampleMetadata,
      diff: sampleDiff,
      techniques: ["  ", ""],
    });
    expect(result).not.toContain("## Additional Focus Areas");
  });

  it("should concatenate multiple techniques", () => {
    const result = assemblePrompt({
      metadata: sampleMetadata,
      diff: sampleDiff,
      techniques: ["Focus on security.", "Check for race conditions."],
    });
    expect(result).toContain("## Additional Focus Areas");
    expect(result).toContain("Focus on security.");
    expect(result).toContain("Check for race conditions.");
  });

  it("should place techniques between instructions and PR metadata", () => {
    const result = assemblePrompt({
      metadata: sampleMetadata,
      diff: sampleDiff,
      techniques: ["Check concurrency."],
    });
    const instructionsIdx = result.indexOf("## Review Instructions");
    const techniquesIdx = result.indexOf("## Additional Focus Areas");
    const prIdx = result.indexOf("## Pull Request");
    expect(instructionsIdx).toBeLessThan(techniquesIdx);
    expect(techniquesIdx).toBeLessThan(prIdx);
  });
});
