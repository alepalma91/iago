import { readFileSync, existsSync } from "fs";
import type { PRMetadata } from "../types/index.js";
import { resolveHome } from "./config.js";

export function getDefaultSystemPrompt(): string {
  return `You are an expert code reviewer. You review pull requests for correctness, security, performance, and maintainability. You provide actionable feedback with specific line references. You are concise and prioritize the most impactful issues.`;
}

export function getDefaultInstructions(): string {
  return `Review the following pull request diff. For each issue found:
1. State the severity: CRITICAL, WARNING, or SUGGESTION
2. Reference the specific file and line(s)
3. Explain the issue clearly
4. Suggest a concrete fix

Focus on:
- Bugs and logic errors
- Security vulnerabilities
- Performance regressions
- API contract violations
- Missing error handling`;
}

export function loadPromptFile(path: string): string {
  const resolved = resolveHome(path);
  if (!resolved || !existsSync(resolved)) {
    return "";
  }
  try {
    return readFileSync(resolved, "utf-8").trim();
  } catch {
    return "";
  }
}

export interface PromptContext {
  metadata: PRMetadata;
  diff: string;
  systemPrompt?: string;
  instructions?: string;
  techniques?: string[];
}

export function assemblePrompt(ctx: PromptContext): string {
  const systemPrompt = ctx.systemPrompt || getDefaultSystemPrompt();
  const instructions = ctx.instructions || getDefaultInstructions();

  const techniques = (ctx.techniques || []).filter((t) => t.trim().length > 0);

  const parts: string[] = [
    systemPrompt,
    "",
    "## Review Instructions",
    instructions,
  ];

  if (techniques.length > 0) {
    parts.push("", "## Additional Focus Areas");
    for (const technique of techniques) {
      parts.push("", technique);
    }
  }

  parts.push(
    "",
    "## Pull Request",
    `**Title**: ${ctx.metadata.title}`,
    `**URL**: ${ctx.metadata.url}`,
    `**Author**: ${ctx.metadata.author}`,
    `**Branch**: ${ctx.metadata.branch} -> ${ctx.metadata.base_branch}`,
    "",
    "### Diff",
    "```diff",
    ctx.diff,
    "```"
  );

  return parts.join("\n");
}
