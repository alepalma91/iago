import { describe, expect, it } from "bun:test";
import { parseGhApiResponse, parseGraphQLResponse } from "../../src/core/poller.js";

const RESPONSE_200 = `HTTP/2.0 200 OK
Last-Modified: Thu, 20 Mar 2025 10:00:00 GMT
X-Poll-Interval: 60
X-RateLimit-Remaining: 4998

[
  {
    "id": "1",
    "reason": "review_requested",
    "subject": {
      "title": "feat: add auth",
      "url": "https://api.github.com/repos/owner/repo/pulls/42",
      "type": "PullRequest"
    },
    "repository": {
      "full_name": "owner/repo",
      "html_url": "https://github.com/owner/repo"
    },
    "updated_at": "2025-03-20T10:00:00Z",
    "url": "https://api.github.com/notifications/threads/1"
  },
  {
    "id": "2",
    "reason": "mention",
    "subject": {
      "title": "fix: typo",
      "url": "https://api.github.com/repos/owner/repo/issues/10",
      "type": "Issue"
    },
    "repository": {
      "full_name": "owner/repo",
      "html_url": "https://github.com/owner/repo"
    },
    "updated_at": "2025-03-20T09:00:00Z",
    "url": "https://api.github.com/notifications/threads/2"
  },
  {
    "id": "3",
    "reason": "review_requested",
    "subject": {
      "title": "refactor: db layer",
      "url": "https://api.github.com/repos/org/project/pulls/7",
      "type": "PullRequest"
    },
    "repository": {
      "full_name": "org/project",
      "html_url": "https://github.com/org/project"
    },
    "updated_at": "2025-03-20T09:30:00Z",
    "url": "https://api.github.com/notifications/threads/3"
  }
]`;

const RESPONSE_304 = `HTTP/2.0 304 Not Modified
X-Poll-Interval: 60
X-RateLimit-Remaining: 4999

`;

const GRAPHQL_RESPONSE = JSON.stringify({
  data: {
    repository: {
      pullRequest: {
        number: 42,
        title: "feat: add auth",
        author: { login: "developer" },
        url: "https://github.com/owner/repo/pull/42",
        headRefName: "feat-auth",
        baseRefName: "main",
        additions: 150,
        deletions: 20,
        changedFiles: 5,
        body: "Adds OAuth2 authentication",
      },
    },
  },
});

describe("parseGhApiResponse", () => {
  it("should parse 200 response and filter review_requested", () => {
    const result = parseGhApiResponse(RESPONSE_200);
    expect(result.statusCode).toBe(200);
    expect(result.notifications).toHaveLength(2);
    expect(result.notifications[0]!.reason).toBe("review_requested");
    expect(result.notifications[1]!.reason).toBe("review_requested");
  });

  it("should extract Last-Modified header", () => {
    const result = parseGhApiResponse(RESPONSE_200);
    expect(result.lastModified).toBe("Thu, 20 Mar 2025 10:00:00 GMT");
  });

  it("should extract X-Poll-Interval header", () => {
    const result = parseGhApiResponse(RESPONSE_200);
    expect(result.pollInterval).toBe(60);
  });

  it("should parse 304 response with empty notifications", () => {
    const result = parseGhApiResponse(RESPONSE_304);
    expect(result.statusCode).toBe(304);
    expect(result.notifications).toHaveLength(0);
    expect(result.pollInterval).toBe(60);
  });

  it("should handle response with no review_requested notifications", () => {
    const noReviews = `HTTP/2.0 200 OK
Last-Modified: Thu, 20 Mar 2025 10:00:00 GMT

[{"id":"1","reason":"mention","subject":{"title":"test","url":"u","type":"Issue"},"repository":{"full_name":"a/b","html_url":"h"},"updated_at":"2025-01-01T00:00:00Z","url":"u"}]`;
    const result = parseGhApiResponse(noReviews);
    expect(result.statusCode).toBe(200);
    expect(result.notifications).toHaveLength(0);
  });
});

describe("parseGraphQLResponse", () => {
  it("should parse PR metadata from GraphQL response", () => {
    const metadata = parseGraphQLResponse(GRAPHQL_RESPONSE, "owner/repo");
    expect(metadata).not.toBeNull();
    expect(metadata!.number).toBe(42);
    expect(metadata!.title).toBe("feat: add auth");
    expect(metadata!.author).toBe("developer");
    expect(metadata!.branch).toBe("feat-auth");
    expect(metadata!.base_branch).toBe("main");
    expect(metadata!.additions).toBe(150);
    expect(metadata!.changed_files).toBe(5);
  });

  it("should return null for invalid GraphQL response", () => {
    const metadata = parseGraphQLResponse('{"data":{}}', "owner/repo");
    expect(metadata).toBeNull();
  });
});
