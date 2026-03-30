import { describe, expect, it } from "bun:test";
import { getBareRepoPath, getWorktreePath, getOutputPath } from "../../src/core/sandbox.js";

describe("sandbox path builders", () => {
  const baseDir = "/home/user/.local/share/iago";

  it("should build correct bare repo path", () => {
    expect(getBareRepoPath("owner/repo", baseDir)).toBe(
      "/home/user/.local/share/iago/repos/github.com/owner/repo.git"
    );
  });

  it("should build correct worktree path", () => {
    expect(getWorktreePath("owner/repo", 42, baseDir)).toBe(
      "/home/user/.local/share/iago/worktrees/github.com/owner/repo/pr-42"
    );
  });

  it("should build correct output path", () => {
    expect(getOutputPath("owner/repo", 42, baseDir)).toBe(
      "/home/user/.local/share/iago/output/github.com/owner/repo/pr-42"
    );
  });

  it("should handle nested org/repo names", () => {
    expect(getBareRepoPath("my-org/my-repo", baseDir)).toBe(
      "/home/user/.local/share/iago/repos/github.com/my-org/my-repo.git"
    );
  });

  it("should handle different base dirs", () => {
    expect(getWorktreePath("a/b", 1, "/tmp/test")).toBe(
      "/tmp/test/worktrees/github.com/a/b/pr-1"
    );
  });

  it("should handle large PR numbers", () => {
    expect(getWorktreePath("org/repo", 99999, baseDir)).toBe(
      "/home/user/.local/share/iago/worktrees/github.com/org/repo/pr-99999"
    );
  });
});
