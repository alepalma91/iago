import type { GitHubNotification, PollResult, PRMetadata } from "../types/index.js";

export interface PollState {
  lastModified: string | null;
  pollInterval: number;
}

export function createInitialPollState(): PollState {
  return { lastModified: null, pollInterval: 60 };
}

export async function pollNotifications(state: PollState): Promise<PollResult> {
  const args = ["api", "/notifications", "--include", "-H", "Accept: application/json"];

  if (state.lastModified) {
    args.push("-H", `If-Modified-Since: ${state.lastModified}`);
  }

  const proc = Bun.spawn(["gh", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdout = await new Response(proc.stdout).text();
  const stderr = await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`gh api failed (exit ${exitCode}): ${stderr}`);
  }

  return parseGhApiResponse(stdout);
}

export function parseGhApiResponse(raw: string): PollResult {
  const blankLineIdx = raw.indexOf("\n\n");

  if (blankLineIdx === -1) {
    // No headers found — try parsing as pure JSON
    try {
      const notifications = JSON.parse(raw) as GitHubNotification[];
      return {
        notifications: notifications.filter((n) => n.reason === "review_requested"),
        lastModified: null,
        pollInterval: 60,
        statusCode: 200,
      };
    } catch {
      return {
        notifications: [],
        lastModified: null,
        pollInterval: 60,
        statusCode: 200,
      };
    }
  }

  const headerBlock = raw.slice(0, blankLineIdx);
  const body = raw.slice(blankLineIdx + 2).trim();

  const headers = parseHeaders(headerBlock);
  const statusCode = parseStatusCode(headerBlock);
  const lastModified = headers["last-modified"] ?? null;
  const pollIntervalStr = headers["x-poll-interval"];
  const pollInterval = pollIntervalStr ? parseInt(pollIntervalStr, 10) : 60;

  if (statusCode === 304) {
    return {
      notifications: [],
      lastModified,
      pollInterval,
      statusCode: 304,
    };
  }

  let notifications: GitHubNotification[] = [];
  if (body) {
    try {
      notifications = JSON.parse(body) as GitHubNotification[];
    } catch {
      notifications = [];
    }
  }

  return {
    notifications: notifications.filter((n) => n.reason === "review_requested"),
    lastModified,
    pollInterval,
    statusCode,
  };
}

function parseHeaders(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};

  for (const line of headerBlock.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim().toLowerCase();
    const value = line.slice(colonIdx + 1).trim();
    headers[key] = value;
  }

  return headers;
}

function parseStatusCode(headerBlock: string): number {
  const firstLine = headerBlock.split("\n")[0] ?? "";
  const match = firstLine.match(/\d{3}/);
  return match ? parseInt(match[0], 10) : 200;
}

export async function enrichPR(apiUrl: string): Promise<PRMetadata | null> {
  // Extract owner/repo and PR number from the API URL
  // Format: https://api.github.com/repos/owner/repo/pulls/123
  const match = apiUrl.match(/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)/);
  if (!match) return null;

  const repo = match[1]!;
  const prNumber = parseInt(match[2]!, 10);

  const query = `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        number
        title
        author { login }
        url
        headRefName
        baseRefName
        additions
        deletions
        changedFiles
        body
      }
    }
  }`;

  const [owner, repoName] = repo.split("/");

  const proc = Bun.spawn(
    [
      "gh",
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `repo=${repoName}`,
      "-F",
      `number=${prNumber}`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) return null;

  try {
    return parseGraphQLResponse(stdout, repo);
  } catch {
    return null;
  }
}

export function parseGraphQLResponse(raw: string, repo: string): PRMetadata | null {
  const data = JSON.parse(raw);
  const pr = data?.data?.repository?.pullRequest;
  if (!pr) return null;

  return {
    number: pr.number,
    title: pr.title,
    author: pr.author?.login ?? "unknown",
    url: pr.url,
    branch: pr.headRefName,
    base_branch: pr.baseRefName,
    repo,
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changed_files: pr.changedFiles ?? 0,
    body: pr.body ?? null,
  };
}

export async function fetchPendingReviews(sinceHours: number = 8): Promise<PRMetadata[]> {
  const since = new Date(Date.now() - sinceHours * 3600_000).toISOString();

  const query = `query($searchQuery: String!, $first: Int!) {
    search(query: $searchQuery, type: ISSUE, first: $first) {
      nodes {
        ... on PullRequest {
          number
          title
          author { login }
          url
          headRefName
          baseRefName
          additions
          deletions
          changedFiles
          body
          repository { nameWithOwner }
          createdAt
          updatedAt
        }
      }
    }
  }`;

  const searchQuery = `type:pr review-requested:@me is:open -is:draft updated:>=${since}`;

  const proc = Bun.spawn(
    [
      "gh", "api", "graphql",
      "-f", `query=${query}`,
      "-f", `searchQuery=${searchQuery}`,
      "-F", "first=20",
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0) return [];

  try {
    const data = JSON.parse(stdout);
    const nodes = data?.data?.search?.nodes ?? [];

    return nodes
      .filter((pr: any) => pr.number) // filter out empty nodes
      .map((pr: any): PRMetadata => ({
        number: pr.number,
        title: pr.title,
        author: pr.author?.login ?? "unknown",
        url: pr.url,
        branch: pr.headRefName,
        base_branch: pr.baseRefName,
        repo: pr.repository.nameWithOwner,
        additions: pr.additions ?? 0,
        deletions: pr.deletions ?? 0,
        changed_files: pr.changedFiles ?? 0,
        body: pr.body ?? null,
      }));
  } catch {
    return [];
  }
}

export async function checkGhAuth(): Promise<boolean> {
  const proc = Bun.spawn(["gh", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}

export interface PRGitHubStatus {
  state: "OPEN" | "CLOSED" | "MERGED";
  reviewDecision: "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;
  isDraft: boolean;
  reviewRequestedByMe: boolean;
}

/**
 * Check the current GitHub status of a PR — whether it's still open,
 * merged, or closed, and whether a review has been submitted.
 */
export async function fetchPRGitHubStatus(
  repo: string,
  prNumber: number
): Promise<PRGitHubStatus | null> {
  const [owner, repoName] = repo.split("/");
  if (!owner || !repoName) return null;

  const query = `query($owner: String!, $repo: String!, $number: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        state
        isDraft
        reviewDecision
        reviewRequests(first: 20) {
          nodes {
            requestedReviewer {
              ... on User { login }
            }
          }
        }
      }
    }
    viewer { login }
  }`;

  const proc = Bun.spawn(
    [
      "gh", "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${owner}`,
      "-F", `repo=${repoName}`,
      "-F", `number=${prNumber}`,
    ],
    { stdout: "pipe", stderr: "pipe" }
  );

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;
  if (exitCode !== 0) return null;

  try {
    const data = JSON.parse(stdout);
    const pr = data?.data?.repository?.pullRequest;
    const viewerLogin = data?.data?.viewer?.login;
    if (!pr) return null;

    const reviewRequestedByMe = (pr.reviewRequests?.nodes ?? []).some(
      (r: any) => r.requestedReviewer?.login === viewerLogin
    );

    return {
      state: pr.state,
      reviewDecision: pr.reviewDecision ?? null,
      isDraft: pr.isDraft ?? false,
      reviewRequestedByMe,
    };
  } catch {
    return null;
  }
}
