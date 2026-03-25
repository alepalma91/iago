import { join } from "path";
import { existsSync, statSync, readdirSync } from "fs";

export function getBareRepoPath(repo: string, baseDir: string): string {
  return join(baseDir, "repos", "github.com", `${repo}.git`);
}

export function getWorktreePath(repo: string, prNumber: number, baseDir: string): string {
  return join(baseDir, "worktrees", "github.com", repo, `pr-${prNumber}`);
}

export function getOutputPath(repo: string, prNumber: number, baseDir: string): string {
  return join(baseDir, "output", "github.com", repo, `pr-${prNumber}`);
}

async function runGit(args: string[], cwd?: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    stdout: "pipe",
    stderr: "pipe",
    cwd,
  });

  const stdout = await new Response(proc.stdout).text();
  const exitCode = await proc.exited;

  return { stdout: stdout.trim(), exitCode };
}

export async function ensureReferenceRepo(repo: string, baseDir: string): Promise<string> {
  const barePath = getBareRepoPath(repo, baseDir);

  if (existsSync(barePath)) {
    const { exitCode } = await runGit(["fetch", "origin"], barePath);
    if (exitCode !== 0) {
      throw new Error(`Failed to fetch origin in ${barePath}`);
    }
    return barePath;
  }

  // Create parent directory
  const parentDir = join(barePath, "..");
  await Bun.spawn(["mkdir", "-p", parentDir], { stdout: "pipe" }).exited;

  const repoUrl = `https://github.com/${repo}.git`;
  const { exitCode } = await runGit([
    "clone",
    "--bare",
    "--filter=blob:none",
    repoUrl,
    barePath,
  ]);

  if (exitCode !== 0) {
    throw new Error(`Failed to clone ${repoUrl}`);
  }

  return barePath;
}

export async function createWorktree(
  repo: string,
  prNumber: number,
  branch: string,
  baseDir: string
): Promise<string> {
  const barePath = getBareRepoPath(repo, baseDir);
  const worktreePath = getWorktreePath(repo, prNumber, baseDir);

  // Fetch the PR branch
  await runGit(["fetch", "origin", `${branch}:${branch}`], barePath);

  // If worktree already exists, reuse it (just pull latest)
  if (existsSync(join(worktreePath, ".git"))) {
    await runGit(["checkout", branch], worktreePath);
    await runGit(["reset", "--hard", `origin/${branch}`], worktreePath);
    return worktreePath;
  }

  // Clean up stale git worktree reference if path was removed but not pruned
  await runGit(["worktree", "prune"], barePath);

  // Create parent directory
  const parentDir = join(worktreePath, "..");
  await Bun.spawn(["mkdir", "-p", parentDir], { stdout: "pipe" }).exited;

  const { exitCode } = await runGit(
    ["worktree", "add", worktreePath, branch],
    barePath
  );

  if (exitCode !== 0) {
    throw new Error(`Failed to create worktree for PR #${prNumber} at ${worktreePath}`);
  }

  return worktreePath;
}

export async function generateDiff(worktreePath: string, baseBranch: string): Promise<string> {
  const { stdout, exitCode } = await runGit(
    ["diff", `${baseBranch}...HEAD`],
    worktreePath
  );

  if (exitCode !== 0) {
    // Fallback: try simple diff
    const fallback = await runGit(["diff", baseBranch], worktreePath);
    return fallback.stdout;
  }

  return stdout;
}

export async function removeWorktree(worktreePath: string, barePath?: string): Promise<void> {
  if (barePath) {
    const { exitCode } = await runGit(["worktree", "remove", worktreePath, "--force"], barePath);
    if (exitCode !== 0) {
      await Bun.spawn(["rm", "-rf", worktreePath], { stdout: "pipe" }).exited;
    }
    await runGit(["worktree", "prune"], barePath);
  } else {
    const { exitCode } = await runGit(["worktree", "remove", worktreePath, "--force"]);
    if (exitCode !== 0) {
      await Bun.spawn(["rm", "-rf", worktreePath], { stdout: "pipe" }).exited;
    }
  }
}

export async function cleanupStaleWorktrees(baseDir: string, ttlMs: number): Promise<string[]> {
  const worktreesBase = join(baseDir, "worktrees", "github.com");
  const removed: string[] = [];

  if (!existsSync(worktreesBase)) return removed;

  const now = Date.now();

  // Walk the directory tree to find PR worktrees
  try {
    for (const owner of readdirSync(worktreesBase)) {
      const ownerPath = join(worktreesBase, owner);
      if (!statSync(ownerPath).isDirectory()) continue;

      for (const repoName of readdirSync(ownerPath)) {
        const repoPath = join(ownerPath, repoName);
        if (!statSync(repoPath).isDirectory()) continue;

        for (const prDir of readdirSync(repoPath)) {
          const prPath = join(repoPath, prDir);
          if (!statSync(prPath).isDirectory()) continue;

          const mtime = statSync(prPath).mtimeMs;
          if (now - mtime > ttlMs) {
            await removeWorktree(prPath);
            removed.push(prPath);
          }
        }
      }
    }
  } catch {
    // Directory walk can fail if dirs are removed concurrently
  }

  return removed;
}
