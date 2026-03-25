import { describe, expect, it } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { parseGhApiResponse, parseGraphQLResponse } from "../../src/core/poller.js";

const FIXTURES = join(import.meta.dir, "..", "fixtures");

describe("poller integration", () => {
  it("should parse a full 200 response from fixture", () => {
    const raw = readFileSync(join(FIXTURES, "notification-200.txt"), "utf-8");
    const result = parseGhApiResponse(raw);

    expect(result.statusCode).toBe(200);
    expect(result.lastModified).toBe("Thu, 20 Mar 2025 09:55:00 GMT");
    expect(result.pollInterval).toBe(60);
    // Should filter to only review_requested (2 out of 3)
    expect(result.notifications).toHaveLength(2);
    expect(result.notifications[0]!.subject.title).toBe("feat: add user authentication flow");
    expect(result.notifications[1]!.subject.title).toBe("refactor: extract database module");
  });

  it("should parse a full 304 response from fixture", () => {
    const raw = readFileSync(join(FIXTURES, "notification-304.txt"), "utf-8");
    const result = parseGhApiResponse(raw);

    expect(result.statusCode).toBe(304);
    expect(result.notifications).toHaveLength(0);
    expect(result.pollInterval).toBe(60);
  });

  it("should parse GraphQL PR metadata from fixture", () => {
    const raw = readFileSync(join(FIXTURES, "graphql-pr-metadata.json"), "utf-8");
    const metadata = parseGraphQLResponse(raw, "acme/webapp");

    expect(metadata).not.toBeNull();
    expect(metadata!.number).toBe(42);
    expect(metadata!.title).toBe("feat: add user authentication flow");
    expect(metadata!.author).toBe("jsmith");
    expect(metadata!.branch).toBe("feat/auth-flow");
    expect(metadata!.base_branch).toBe("main");
    expect(metadata!.additions).toBe(342);
    expect(metadata!.deletions).toBe(15);
    expect(metadata!.changed_files).toBe(8);
    expect(metadata!.repo).toBe("acme/webapp");
  });
});
