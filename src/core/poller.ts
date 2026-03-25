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

export async function checkGhAuth(): Promise<boolean> {
  const proc = Bun.spawn(["gh", "auth", "status"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  return exitCode === 0;
}
