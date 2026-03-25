import { loadConfig, getDataDir, loadRepoConfig, mergeConfigs } from "../core/config.js";
import { createDatabase } from "../db/database.js";
import { createQueries } from "../db/queries.js";
import { enrichPR } from "../core/poller.js";
import { ensureReferenceRepo, createWorktree, generateDiff, getOutputPath } from "../core/sandbox.js";
import { launchAllTools, writeOutput } from "../core/launcher.js";
import { assemblePrompt, loadPromptFile } from "../core/prompt.js";
import { join } from "path";
import { mkdirSync } from "fs";
import type { PRMetadata, LauncherProfile } from "../types/index.js";

function parseGitHubPRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return { owner: match[1]!, repo: match[2]!, number: parseInt(match[3]!, 10) };
}

export async function reviewCommand(args: string[]): Promise<void> {
  const prUrl = args[0];
  if (!prUrl) {
    console.error("Usage: the-reviewer review <pr-url>");
    console.error("Example: the-reviewer review https://github.com/owner/repo/pull/42");
    process.exit(1);
  }

  const parsed = parseGitHubPRUrl(prUrl);
  if (!parsed) {
    console.error(`Invalid PR URL: ${prUrl}`);
    process.exit(1);
  }

  const fullRepo = `${parsed.owner}/${parsed.repo}`;
  console.log(`Reviewing ${fullRepo}#${parsed.number}...`);

  // Fetch PR metadata via GraphQL
  const apiUrl = `https://api.github.com/repos/${fullRepo}/pulls/${parsed.number}`;
  console.log("  Fetching PR metadata...");
  const metadata = await enrichPR(apiUrl);

  if (!metadata) {
    console.error("Failed to fetch PR metadata. Check the URL and your gh auth.");
    process.exit(1);
  }

  console.log(`  Title: ${metadata.title}`);
  console.log(`  Author: ${metadata.author}`);
  console.log(`  Branch: ${metadata.branch} -> ${metadata.base_branch}`);
  console.log(`  Changes: +${metadata.additions} -${metadata.deletions} (${metadata.changed_files} files)`);

  const config = loadConfig();
  const dataDir = getDataDir(config);
  mkdirSync(dataDir, { recursive: true });

  // Set up database
  const dbPath = join(dataDir, "the-reviewer.db");
  const db = createDatabase(dbPath);
  const queries = createQueries(db);

  // Check if already tracked
  const existing = queries.getPRByRepoAndNumber(metadata.repo, metadata.number);
  if (existing && existing.status === "done") {
    console.log(`\n  Already reviewed (status: ${existing.status}). Use --force to re-review.`);
    db.close();
    return;
  }

  // Insert into DB
  let pr;
  if (existing) {
    pr = existing;
    queries.updatePRStatus(pr.id, "accepted");
  } else {
    pr = queries.insertPR({
      pr_number: metadata.number,
      repo: metadata.repo,
      title: metadata.title,
      author: metadata.author,
      url: metadata.url,
      branch: metadata.branch,
      base_branch: metadata.base_branch,
    });
  }
  queries.insertEvent(pr.id, "accepted", "Manual review triggered");

  // Clone / fetch
  console.log("\n  Setting up sandbox...");
  queries.updatePRStatus(pr.id, "cloning");
  try {
    await ensureReferenceRepo(metadata.repo, dataDir);
  } catch (err: any) {
    console.error(`  Failed to set up reference repo: ${err.message}`);
    queries.updatePRStatus(pr.id, "error");
    queries.insertEvent(pr.id, "error", err.message);
    db.close();
    process.exit(1);
  }

  console.log("  Creating worktree...");
  let worktreePath: string;
  try {
    worktreePath = await createWorktree(metadata.repo, metadata.number, metadata.branch, dataDir);
  } catch (err: any) {
    console.error(`  Failed to create worktree: ${err.message}`);
    queries.updatePRStatus(pr.id, "error");
    queries.insertEvent(pr.id, "error", err.message);
    db.close();
    process.exit(1);
  }

  console.log(`  Worktree: ${worktreePath}`);

  // Merge repo-level config
  const repoConfig = loadRepoConfig(worktreePath);
  const mergedConfig = mergeConfigs(config, repoConfig);

  // Generate diff
  console.log("  Generating diff...");
  const diff = await generateDiff(worktreePath, metadata.base_branch);
  if (!diff) {
    console.log("  Warning: empty diff");
  } else {
    console.log(`  Diff size: ${(diff.length / 1024).toFixed(1)}KB`);
  }

  // Assemble prompt
  const systemPrompt = mergedConfig.prompts.system_prompt
    ? loadPromptFile(mergedConfig.prompts.system_prompt)
    : undefined;
  const instructions = mergedConfig.prompts.instructions
    ? loadPromptFile(mergedConfig.prompts.instructions)
    : undefined;

  const techniques = loadTechniques(mergedConfig);

  const prompt = assemblePrompt({
    metadata,
    diff,
    systemPrompt: systemPrompt || undefined,
    instructions: instructions || undefined,
    techniques,
  });

  // Launch tools
  const enabledTools = getEnabledTools(mergedConfig);
  if (enabledTools.length === 0) {
    console.error("  No review tools enabled in config.");
    db.close();
    process.exit(1);
  }

  console.log(`\n  Launching ${enabledTools.length} tool(s): ${enabledTools.map(t => t.display_name || t.command).join(", ")}`);
  queries.updatePRStatus(pr.id, "reviewing");
  queries.insertEvent(pr.id, "reviewing", "Launching review tools");

  const variables: Record<string, string> = {
    prompt,
    diff_file: `${worktreePath}/pr.diff`,
    worktree: worktreePath,
    pr_number: String(metadata.number),
    pr_url: metadata.url,
    repo: metadata.repo,
    branch: metadata.branch,
    base_branch: metadata.base_branch,
  };

  const toolStatus: Record<string, string> = {};
  for (const tool of enabledTools) {
    toolStatus[tool.display_name || tool.command] = "running";
  }
  queries.updatePRToolStatus(pr.id, toolStatus);

  const results = await launchAllTools(
    enabledTools,
    variables,
    worktreePath,
    mergedConfig.launchers.max_parallel
  );

  // Save outputs
  const outputDir = getOutputPath(metadata.repo, metadata.number, dataDir);
  console.log(`\n  Results:`);

  for (const result of results) {
    const status = result.timedOut ? "TIMEOUT" : result.exitCode === 0 ? "OK" : `ERROR (exit ${result.exitCode})`;
    console.log(`    ${result.toolName}: ${status} (${(result.durationMs / 1000).toFixed(1)}s)`);

    const filePath = writeOutput(outputDir, result.toolName, result.output);
    queries.insertOutput({
      pr_review_id: pr.id,
      tool_name: result.toolName,
      output: result.output,
      exit_code: result.exitCode,
      duration_ms: result.durationMs,
    });

    toolStatus[result.toolName] = result.timedOut
      ? "timeout"
      : result.exitCode === 0
        ? "done"
        : "error";
  }

  queries.updatePRToolStatus(pr.id, toolStatus);
  queries.updatePRStatus(pr.id, "done");
  queries.insertEvent(pr.id, "done", "Review complete");

  console.log(`\n  Output saved to: ${outputDir}`);
  console.log("  Done!");
  db.close();
}

function getEnabledTools(config: ReturnType<typeof loadConfig>): LauncherProfile[] {
  return config.launchers.default_tools
    .map((name) => config.launchers.tools[name])
    .filter((tool): tool is LauncherProfile => !!tool && tool.enabled);
}

function loadTechniques(config: ReturnType<typeof loadConfig>): string[] {
  return config.prompts.default_techniques
    .map((name) => {
      const technique = config.prompts.techniques[name];
      if (!technique) return "";
      return loadPromptFile(technique.prompt_file);
    })
    .filter((content) => content.length > 0);
}
