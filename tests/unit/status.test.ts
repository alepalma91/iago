import { describe, expect, it } from "bun:test";
import { formatStatusTable } from "../../src/commands/status.js";
import type { PRReview } from "../../src/types/index.js";

describe("formatStatusTable", () => {
  it("should show empty message when no reviews", () => {
    const result = formatStatusTable([]);
    expect(result).toBe("No active PR reviews.");
  });

  it("should format reviews into a table", () => {
    const reviews: PRReview[] = [
      {
        id: 1,
        pr_number: 42,
        repo: "owner/repo",
        title: "feat: add auth",
        author: "dev",
        url: "https://github.com/owner/repo/pull/42",
        branch: "feat-auth",
        base_branch: "main",
        status: "reviewing",
        tool_status: null,
        worktree_path: null,
        created_at: "2025-03-20T10:00:00",
        updated_at: "2025-03-20T10:00:00",
      },
    ];
    const result = formatStatusTable(reviews);
    expect(result).toContain("owner/repo");
    expect(result).toContain("#42");
    expect(result).toContain("reviewing");
    expect(result).toContain("feat: add auth");
  });
});
