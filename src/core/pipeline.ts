import type { Database } from "bun:sqlite";
import type { Queries } from "../db/queries.js";
import type { PRMetadata, AppConfig, NotificationAction } from "../types/index.js";
import { sendPRNotification, openInBrowser, sendReviewCompleteNotification, sendReviewErrorNotification } from "./notifier.js";
import { ensureReferenceRepo, createWorktree, generateDiff, getOutputPath, removeWorktree, getBareRepoPath, getWorktreePath } from "./sandbox.js";
import { launchAllTools, writeOutput } from "./launcher.js";
import { assemblePrompt, loadPromptFile } from "./prompt.js";
import { getDataDir, loadRepoConfig, mergeConfigs } from "./config.js";
import type { LauncherProfile } from "../types/index.js";

export interface PipelineContext {
  config: AppConfig;
  queries: Queries;
}

export async function handleNewReview(
  metadata: PRMetadata,
  ctx: PipelineContext
): Promise<void> {
  const { config, queries } = ctx;
  const dataDir = getDataDir(config);

  // 1. Check if already tracked
  const existing = queries.getPRByRepoAndNumber(metadata.repo, metadata.number);

  let pr;
  if (existing && existing.status === "accepted") {
    // Already accepted (e.g. from startup catch-up) — skip notification, proceed to review
    pr = existing;
  } else if (existing) {
    return; // Already tracking this PR in another state
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

    queries.insertEvent(pr.id, "detected", `PR #${metadata.number} detected`);

    // 2. Notify user
    queries.updatePRStatus(pr.id, "notified");
    queries.insertEvent(pr.id, "notified", "User notified");

    let action: NotificationAction;
    try {
      action = await sendPRNotification({
        repo: metadata.repo,
        pr_number: metadata.number,
        title: metadata.title,
        author: metadata.author,
        url: metadata.url,
      });
    } catch {
      // Alerter not available — auto-accept for MVP
      action = "accept";
    }

    queries.insertEvent(pr.id, "user_action", `User action: ${action}`);

    // 3. Handle user action
    if (action === "dismiss" || action === "timeout") {
      queries.updatePRStatus(pr.id, "dismissed");
      return;
    }

    if (action === "view") {
      await openInBrowser(metadata.url);
      queries.updatePRStatus(pr.id, "dismissed");
      return;
    }

    if (action === "snooze") {
      queries.updatePRStatus(pr.id, "dismissed");
      return;
    }

    // action === "accept"
    queries.updatePRStatus(pr.id, "accepted");
    queries.insertEvent(pr.id, "accepted", "Review accepted");
  }

  // 4. Set up sandbox
  queries.updatePRStatus(pr.id, "cloning");

  try {
    await ensureReferenceRepo(metadata.repo, dataDir);
    const worktreePath = await createWorktree(
      metadata.repo,
      metadata.number,
      metadata.branch,
      dataDir
    );

    // 5. Merge repo-level config
    const repoConfig = loadRepoConfig(worktreePath);
    const mergedConfig = mergeConfigs(config, repoConfig);

    // 6. Generate diff
    const diff = await generateDiff(worktreePath, metadata.base_branch);

    // 7. Assemble prompt
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

    // 8. Launch review tools
    queries.updatePRStatus(pr.id, "reviewing");
    queries.insertEvent(pr.id, "reviewing", "Launching review tools");

    const enabledTools = getEnabledTools(mergedConfig);
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

    // Update tool_status to "running" for all tools
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

    // 8. Save outputs
    const outputDir = getOutputPath(metadata.repo, metadata.number, dataDir);
    for (const result of results) {
      writeOutput(outputDir, result.toolName, result.output);
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

    // Compute brief summary from tool results
    const passed = results.filter((r) => r.exitCode === 0).length;
    const failed = results.filter((r) => r.exitCode !== 0 && !r.timedOut).length;
    const timedOut = results.filter((r) => r.timedOut).length;
    const summaryParts: string[] = [];
    if (passed > 0) summaryParts.push(`${passed} passed`);
    if (failed > 0) summaryParts.push(`${failed} failed`);
    if (timedOut > 0) summaryParts.push(`${timedOut} timed out`);
    const reviewSummary = summaryParts.length > 0 ? summaryParts.join(", ") : "no tools ran";

    // Notify user that review is done
    sendReviewCompleteNotification({
      repo: metadata.repo,
      pr_number: metadata.number,
      title: metadata.title,
      author: metadata.author,
      url: metadata.url,
    }, reviewSummary).catch(() => {}); // best-effort

    // Clean up worktree
    const barePath = getBareRepoPath(metadata.repo, dataDir);
    await removeWorktree(worktreePath, barePath);
  } catch (err: any) {
    queries.updatePRStatus(pr.id, "error");
    queries.insertEvent(pr.id, "error", err.message);

    // Notify user of error
    sendReviewErrorNotification(
      {
        repo: metadata.repo,
        pr_number: metadata.number,
        title: metadata.title,
        author: metadata.author,
        url: metadata.url,
      },
      err.message,
    ).catch(() => {}); // best-effort

    // Best-effort worktree cleanup on error
    try {
      const barePath = getBareRepoPath(metadata.repo, dataDir);
      const worktreePath = getWorktreePath(metadata.repo, metadata.number, dataDir);
      await removeWorktree(worktreePath, barePath);
    } catch {}
  }
}

function getEnabledTools(config: AppConfig): LauncherProfile[] {
  return config.launchers.default_tools
    .map((name) => config.launchers.tools[name])
    .filter((tool): tool is LauncherProfile => !!tool && tool.enabled);
}

function loadTechniques(config: AppConfig): string[] {
  return config.prompts.default_techniques
    .map((name) => {
      const technique = config.prompts.techniques[name];
      if (!technique) return "";
      return loadPromptFile(technique.prompt_file);
    })
    .filter((content) => content.length > 0);
}
