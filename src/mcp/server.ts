import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "path";
import { mkdirSync } from "fs";
import { loadConfig, getDataDir } from "../core/config.js";
import { createDatabase } from "../db/database.js";
import { createQueries } from "../db/queries.js";
import type { Queries } from "../db/queries.js";
import type { PRReview } from "../types/index.js";

function initDB(): { queries: Queries; close: () => void } {
  const config = loadConfig();
  const dataDir = getDataDir(config);
  mkdirSync(dataDir, { recursive: true });
  const db = createDatabase(join(dataDir, "iago.db"));
  return { queries: createQueries(db), close: () => db.close() };
}

function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

function formatPR(pr: PRReview): string {
  const tools = pr.tool_status ? Object.keys(pr.tool_status).join(", ") : "none";
  return `#${pr.id} ${pr.repo}#${pr.pr_number} [${pr.status}] "${pr.title ?? "untitled"}" by ${pr.author ?? "unknown"} (tools: ${tools})`;
}

export function createMCPServer() {
  const server = new McpServer({
    name: "iago",
    version: "0.1.0",
  });

  server.tool(
    "list_reviews",
    "List all tracked PR reviews. Optionally filter by status.",
    { status: z.string().optional().describe("Filter by status (e.g. done, reviewing, error)") },
    async ({ status }) => {
      const { queries, close } = initDB();
      try {
        let prs = queries.getAllPRs();
        if (status) {
          prs = prs.filter((pr) => pr.status === status);
        }
        if (prs.length === 0) {
          return textResult(status ? `No reviews with status "${status}".` : "No reviews found.");
        }
        return textResult(prs.map(formatPR).join("\n"));
      } finally {
        close();
      }
    }
  );

  server.tool(
    "get_review",
    "Get full details for a PR review including events timeline and tool outputs.",
    { id: z.number().describe("PR review ID") },
    async ({ id }) => {
      const { queries, close } = initDB();
      try {
        const pr = queries.getPR(id);
        if (!pr) return textResult(`Review #${id} not found.`);

        const events = queries.getEvents(id);
        const outputs = queries.getOutputs(id);

        const lines = [
          `Review #${pr.id}: ${pr.repo}#${pr.pr_number}`,
          `Title: ${pr.title ?? "untitled"}`,
          `Author: ${pr.author ?? "unknown"}`,
          `URL: ${pr.url}`,
          `Branch: ${pr.branch ?? "?"} -> ${pr.base_branch}`,
          `Status: ${pr.status}`,
          `Tools: ${pr.tool_status ? JSON.stringify(pr.tool_status) : "none"}`,
          `Created: ${pr.created_at}`,
          `Updated: ${pr.updated_at}`,
          "",
          "--- Events ---",
          ...events.map((e) => `[${e.created_at}] ${e.event_type}: ${e.message ?? ""}`),
          "",
          "--- Tool Outputs ---",
          ...outputs.map((o) => `${o.tool_name} (exit ${o.exit_code}, ${o.duration_ms}ms): ${(o.output?.length ?? 0)} chars`),
        ];
        return textResult(lines.join("\n"));
      } finally {
        close();
      }
    }
  );

  server.tool(
    "get_review_output",
    "Get the actual text output from review tools for a PR.",
    {
      id: z.number().describe("PR review ID"),
      tool_name: z.string().optional().describe("Filter to a specific tool's output"),
    },
    async ({ id, tool_name }) => {
      const { queries, close } = initDB();
      try {
        const pr = queries.getPR(id);
        if (!pr) return textResult(`Review #${id} not found.`);

        let outputs = queries.getOutputs(id);
        if (tool_name) {
          outputs = outputs.filter((o) => o.tool_name === tool_name);
        }
        if (outputs.length === 0) {
          return textResult(tool_name ? `No output from tool "${tool_name}" for review #${id}.` : `No outputs for review #${id}.`);
        }
        const sections = outputs.map(
          (o) => `=== ${o.tool_name} (exit ${o.exit_code}, ${o.duration_ms}ms) ===\n${o.output ?? "(empty)"}`
        );
        return textResult(sections.join("\n\n"));
      } finally {
        close();
      }
    }
  );

  server.tool(
    "review_pr",
    "Trigger a new PR review by URL. Runs in the background.",
    { url: z.string().describe("GitHub PR URL (e.g. https://github.com/owner/repo/pull/42)") },
    async ({ url }) => {
      const match = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
      if (!match) return textResult(`Invalid PR URL: ${url}`);

      const bunPath = Bun.which("bun") ?? process.execPath;
      const proc = Bun.spawn([bunPath, "run", "src/index.ts", "review", url, "--force"], {
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
      });
      proc.unref();

      return textResult(`Review started in background for ${match[1]}/${match[2]}#${match[3]} (pid ${proc.pid}).`);
    }
  );

  server.tool(
    "retry_review",
    "Reset a failed or completed review and re-run it.",
    { id: z.number().describe("PR review ID to retry") },
    async ({ id }) => {
      const { queries, close } = initDB();
      try {
        const pr = queries.getPR(id);
        if (!pr) return textResult(`Review #${id} not found.`);

        queries.updatePRStatus(id, "accepted");
        queries.insertEvent(id, "retry", "Retry triggered via MCP");

        const bunPath = Bun.which("bun") ?? process.execPath;
        const proc = Bun.spawn([bunPath, "run", "src/index.ts", "review", pr.url, "--force"], {
          stdout: "ignore",
          stderr: "ignore",
          stdin: "ignore",
        });
        proc.unref();

        return textResult(`Retry started for review #${id} (${pr.repo}#${pr.pr_number}, pid ${proc.pid}).`);
      } finally {
        close();
      }
    }
  );

  return server;
}

export async function startMCPServer(): Promise<void> {
  const server = createMCPServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("iago MCP server started on stdio");
}
