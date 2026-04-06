import type { Database } from "bun:sqlite";
import type { AppConfig } from "../types/index.js";
import type { Queries } from "../db/queries.js";
import { createQueries } from "../db/queries.js";
import type { PRReview } from "../types/index.js";
import { killProcess, getProcess } from "./process-registry.js";
import { loadConfig, saveConfig, getConfigDir, resolveHome } from "./config.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from "fs";
import { join, resolve } from "path";

export interface DashboardServer {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
}

/** Returns the command array to invoke ourselves (handles compiled binary vs bun run). */
function getSelfCommand(): string[] {
  // process.execPath is always the real binary path:
  //   compiled: /Users/.../bin/iago
  //   source:   /Users/.../.bun/bin/bun
  // For source mode, we also need "run <script>" args
  const scriptArg = process.argv.find(a => a.endsWith(".ts") || a.endsWith(".js"));
  if (scriptArg) {
    return [process.execPath, "run", scriptArg];
  }
  // Compiled binary
  return [process.execPath];
}

// ── Status colors ──────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  detected: "#71717a",
  notified: "#3b82f6",
  accepted: "#eab308",
  cloning: "#06b6d4",
  reviewing: "#f97316",
  done: "#22c55e",
  changes_requested: "#f59e0b",
  updated: "#8b5cf6",
  error: "#ef4444",
  dismissed: "#71717a",
};

const STATUS_LABELS: Record<string, string> = {
  detected: "Detected",
  notified: "Awaiting",
  accepted: "Accepted",
  cloning: "Cloning",
  reviewing: "Reviewing",
  done: "Done",
  changes_requested: "Changes Req.",
  updated: "Updated",
  error: "Error",
  dismissed: "Dismissed",
};

const GH_STATE_COLORS: Record<string, string> = {
  open: "#22c55e",
  merged: "#a855f7",
  closed: "#ef4444",
};

const GH_STATE_LABELS: Record<string, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatRelativeTime(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr + (dateStr.includes("Z") || dateStr.includes("+") ? "" : "Z")).getTime();
  const diffMs = now - then;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function renderToolPills(toolStatus: Record<string, string> | null): string {
  if (!toolStatus) return '<span class="text-muted">\u2014</span>';
  return Object.entries(toolStatus)
    .map(([tool, status]) => {
      const color = STATUS_COLORS[status] ?? "#71717a";
      return `<span class="pill" style="--pill-color:${color}">${escapeHtml(tool)}: ${escapeHtml(status)}</span>`;
    })
    .join("");
}

function timeAgo(dateStr: string): string {
  const now = Date.now();
  const then = new Date(dateStr + "Z").getTime();
  const diff = now - then;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

const RETRYABLE = new Set(["done", "error", "dismissed", "notified", "detected", "changes_requested", "updated"]);
const IN_PROGRESS = new Set(["accepted", "cloning", "reviewing"]);
const PAGE_SIZE = 10;

// ── PR Row Rendering ───────────────────────────────────────────────────────

function renderPRRows(prs: PRReview[]): string {
  if (prs.length === 0) {
    return `<tr><td colspan="8" class="empty-state">
      <div class="empty-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12h6m-3-3v6m-7 4h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
      </div>
      <p>No reviews tracked yet</p>
      <p class="text-muted text-sm">PRs will appear here when review requests are detected</p>
    </td></tr>`;
  }
  return prs
    .map(
      (pr) => `<tr class="pr-row" data-status="${pr.status}" data-gh-state="${pr.github_state ?? "open"}">
      <td class="cell-repo">
        <span class="repo-name">${escapeHtml(pr.repo.split("/").pop() || pr.repo)}</span>
        <span class="repo-org text-muted">${escapeHtml(pr.repo.split("/")[0] || "")}</span>
      </td>
      <td>
        <a href="${escapeHtml(pr.url)}" target="_blank" rel="noopener" class="pr-link">#${pr.pr_number}</a>
        <span class="gh-state-badge" style="--gh-color:${GH_STATE_COLORS[pr.github_state] ?? "#22c55e"}">${GH_STATE_LABELS[pr.github_state] ?? "Open"}</span>
      </td>
      <td>${pr.author ? `<span class="author">@${escapeHtml(pr.author)}</span>` : '<span class="text-muted">\u2014</span>'}</td>
      <td><span class="status-badge" style="--status-color:${STATUS_COLORS[pr.status] ?? "#71717a"}">${STATUS_LABELS[pr.status] ?? pr.status}</span></td>
      <td class="cell-title">${pr.title ? escapeHtml(pr.title) : '<span class="text-muted">\u2014</span>'}</td>
      <td class="cell-tools">${renderToolPills(pr.tool_status)}</td>
      <td class="cell-age">
        <span class="age-created" title="Opened: ${pr.opened_at ?? "unknown"}">${pr.opened_at ? formatRelativeTime(pr.opened_at) : "\u2014"}</span>
        <span class="age-updated text-muted" title="Last activity: ${pr.updated_at}">${formatRelativeTime(pr.updated_at)}</span>
      </td>
      <td class="cell-actions"><div class="cell-actions-inner">${IN_PROGRESS.has(pr.status)
        ? `<button class="btn btn-danger btn-sm" onclick="cancelReview(${pr.id}, this)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 18L18 6M6 6l12 12"/></svg>
            Cancel
          </button>`
        : `<button class="btn btn-primary btn-sm" onclick="launchReview(${pr.id}, this)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
            Review
          </button>`}
        <button class="btn btn-ghost btn-sm" onclick="toggleDetail(${pr.id}, this)" title="Details">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 9l-7 7-7-7"/></svg>
        </button>
      </div></td>
    </tr>
    <tr id="detail-${pr.id}" class="detail-row" style="display:none">
      <td colspan="8">
        <div class="detail-content" id="detail-content-${pr.id}">
          <div class="detail-loading"><span class="spinner"></span> Loading details...</div>
        </div>
      </td>
    </tr>`
    )
    .join("\n");
}

// ── Stats ──────────────────────────────────────────────────────────────────

function computeStats(queries: Queries) {
  const statusCounts = queries.getStatusCounts();
  const totalReviews = statusCounts.reduce((sum, s) => sum + s.count, 0);
  const doneCount = statusCounts.find((s) => s.status === "done")?.count ?? 0;
  const errorCount = statusCounts.find((s) => s.status === "error")?.count ?? 0;
  const completedCount = doneCount + errorCount;
  const successRate = completedCount > 0 ? Math.round((doneCount / completedCount) * 100) : 0;
  const avgCompletion = queries.getAvgCompletionTime();
  const avgDurationSec = avgCompletion.avg_seconds ?? 0;
  const avgDurationStr =
    avgDurationSec > 0
      ? `${Math.floor(avgDurationSec / 60)}m ${Math.round(avgDurationSec % 60)}s`
      : "\u2014";

  const outputs = queries.getAllOutputs();
  let criticalCount = 0;
  let warningCount = 0;
  let suggestionCount = 0;
  for (const { output } of outputs) {
    if (!output) continue;
    const critMatches = output.match(/\b(CRITICAL|critical|BLOCKER|blocker)\b/g);
    const warnMatches = output.match(/\b(WARNING|warning|WARN|warn)\b/g);
    const suggMatches = output.match(/\b(SUGGESTION|suggestion|NOTE|note|INFO|info)\b/g);
    if (critMatches) criticalCount += critMatches.length;
    if (warnMatches) warningCount += warnMatches.length;
    if (suggMatches) suggestionCount += suggMatches.length;
  }
  const totalFindings = criticalCount + warningCount + suggestionCount;

  return {
    totalReviews,
    statusCounts,
    successRate,
    avgDurationStr,
    totalFindings,
    criticalCount,
    warningCount,
    suggestionCount,
    doneCount,
    errorCount,
  };
}

// ── Main HTML ──────────────────────────────────────────────────────────────

function renderHTML(prs: PRReview[], queries: Queries): string {
  const activePRs = prs.filter((pr) => !["done", "error", "dismissed"].includes(pr.status));
  const toReviewPRs = prs.filter((pr) => ["detected", "notified", "updated"].includes(pr.status) && (pr.github_state ?? "open") === "open");
  const inProgressPRs = prs.filter((pr) => ["accepted", "cloning", "reviewing", "changes_requested"].includes(pr.status) && (pr.github_state ?? "open") === "open");
  const recentPRs = prs.filter((pr) => ["done", "error"].includes(pr.status));
  // Default view: show non-dismissed PRs
  const defaultFiltered = prs.filter((pr) => pr.status !== "dismissed");
  const firstPage = defaultFiltered.slice(0, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(defaultFiltered.length / PAGE_SIZE));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>iago</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #09090b;
      --bg-raised: #18181b;
      --bg-hover: #27272a;
      --border: #27272a;
      --border-subtle: #1f1f23;
      --text: #fafafa;
      --text-secondary: #a1a1aa;
      --text-muted: #52525b;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #22c55e;
      --error: #ef4444;
      --warning: #f59e0b;
      --radius: 8px;
      --radius-sm: 6px;
      --font: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    }

    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }

    /* ── Navigation ── */
    .nav {
      position: sticky;
      top: 0;
      z-index: 50;
      background: rgba(9, 9, 11, 0.8);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 0 24px;
    }
    .nav-inner {
      max-width: 1400px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      height: 56px;
      gap: 32px;
    }
    .nav-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 700;
      font-size: 15px;
      color: var(--text);
      text-decoration: none;
      letter-spacing: -0.02em;
    }
    .nav-brand svg { opacity: 0.9; }
    .nav-tabs {
      display: flex;
      gap: 4px;
      height: 100%;
      align-items: stretch;
    }
    .nav-tab {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 14px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-secondary);
      text-decoration: none;
      border: none;
      background: none;
      cursor: pointer;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .nav-tab:hover { color: var(--text); }
    .nav-tab.active {
      color: var(--text);
      border-bottom-color: var(--text);
    }
    .nav-tab svg { opacity: 0.6; }
    .nav-tab.active svg { opacity: 1; }
    .nav-badge {
      background: var(--accent);
      color: #fff;
      font-size: 11px;
      font-weight: 600;
      padding: 1px 6px;
      border-radius: 10px;
      min-width: 18px;
      text-align: center;
    }
    .nav-right {
      margin-left: auto;
      display: flex;
      align-items: center;
      gap: 8px;
    }

    /* ── Main content ── */
    .main {
      max-width: 1400px;
      margin: 0 auto;
      padding: 24px;
    }

    /* ── Tab panels ── */
    .tab-panel { display: none; }
    .tab-panel.active { display: block; }

    /* ── Buttons ── */
    .btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-family: var(--font);
      font-size: 13px;
      font-weight: 500;
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s;
      white-space: nowrap;
      border: 1px solid transparent;
    }
    .btn-sm { padding: 5px 10px; font-size: 12px; }
    .btn-primary {
      background: var(--accent);
      color: #fff;
      border-color: var(--accent);
    }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-primary:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-ghost {
      background: transparent;
      color: var(--text-secondary);
      border-color: var(--border);
    }
    .btn-ghost:hover {
      background: var(--bg-hover);
      color: var(--text);
    }
    .btn-danger {
      background: transparent;
      color: var(--error);
      border-color: color-mix(in srgb, var(--error) 40%, transparent);
    }
    .btn-danger:hover {
      background: color-mix(in srgb, var(--error) 12%, transparent);
      border-color: var(--error);
    }
    .btn-danger:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-outline {
      background: transparent;
      color: var(--text-secondary);
      border-color: var(--border);
      padding: 7px 14px;
    }
    .btn-outline:hover {
      background: var(--bg-hover);
      color: var(--text);
      border-color: var(--text-muted);
    }

    /* ── Table ── */
    .table-wrap {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    table { width: 100%; border-collapse: collapse; table-layout: fixed; }
    thead th {
      text-align: left;
      padding: 10px 16px;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      background: var(--bg-raised);
    }
    tbody td {
      padding: 12px 16px;
      font-size: 13px;
      border-bottom: 1px solid var(--border-subtle);
      vertical-align: middle;
    }
    tbody tr.pr-row:hover { background: rgba(255,255,255,0.02); }
    .cell-repo { min-width: 120px; }
    .repo-name { font-weight: 500; display: block; font-size: 13px; }
    .repo-org { font-size: 11px; }
    .pr-link {
      color: var(--accent);
      text-decoration: none;
      font-weight: 500;
      font-variant-numeric: tabular-nums;
    }
    .pr-link:hover { text-decoration: underline; }
    .author { color: var(--text-secondary); font-size: 13px; }
    .cell-title {
      max-width: 300px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .cell-tools { min-width: 100px; }
    .cell-age {
      font-size: 12px;
      white-space: nowrap;
    }
    .age-created { display: block; }
    .age-updated { display: block; font-size: 11px; }
    .cell-actions {
      white-space: nowrap;
      padding-right: 12px !important;
    }
    .cell-actions-inner {
      display: flex;
      align-items: center;
      gap: 4px;
      justify-content: flex-end;
    }

    /* ── Status badge ── */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 20px;
      white-space: nowrap;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--status-color);
      background: color-mix(in srgb, var(--status-color) 12%, transparent);
    }
    .status-badge::before {
      content: '';
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: var(--status-color);
    }

    /* ── GitHub state badge ── */
    .gh-state-badge {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 3px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--gh-color);
      background: color-mix(in srgb, var(--gh-color) 12%, transparent);
      margin-left: 6px;
      vertical-align: middle;
      text-transform: uppercase;
    }

    /* ── Section tabs ── */
    .section-tabs {
      display: flex;
      gap: 0;
      padding: 0 16px;
      background: var(--bg-raised);
      border-bottom: 1px solid var(--border);
    }
    .section-tab {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      cursor: pointer;
      border: none;
      background: none;
      border-bottom: 2px solid transparent;
      transition: color 0.15s, border-color 0.15s;
    }
    .section-tab:hover { color: var(--text-secondary); }
    .section-tab.active {
      color: var(--text);
      border-bottom-color: var(--accent);
    }
    .section-tab .section-count {
      font-size: 11px;
      font-weight: 600;
      padding: 1px 7px;
      border-radius: 10px;
      background: var(--bg-hover);
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }
    .section-tab.active .section-count {
      background: color-mix(in srgb, var(--accent) 15%, transparent);
      color: var(--accent);
    }

    /* ── Filter bar ── */
    .filter-bar {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: var(--bg-raised);
      flex-wrap: wrap;
    }
    .filter-bar label {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
    }
    .filter-summary {
      margin-left: auto;
      font-size: 12px;
      color: var(--text-muted);
    }

    /* ── Multi-select dropdown ── */
    .multi-select {
      position: relative;
      display: inline-block;
    }
    .multi-select-btn {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: var(--font);
      font-size: 12px;
      padding: 5px 10px;
      cursor: pointer;
      transition: border-color 0.15s;
      min-width: 100px;
      white-space: nowrap;
    }
    .multi-select-btn:hover { border-color: var(--text-muted); }
    .multi-select-btn.open { border-color: var(--accent); }
    .multi-select-btn svg {
      width: 12px; height: 12px;
      opacity: 0.5;
      transition: transform 0.15s;
      flex-shrink: 0;
    }
    .multi-select-btn.open svg { transform: rotate(180deg); }
    .multi-select-panel {
      display: none;
      position: absolute;
      top: calc(100% + 4px);
      left: 0;
      z-index: 100;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 4px 0;
      min-width: 180px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    }
    .multi-select-panel.open { display: block; }
    .multi-select-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.1s;
      user-select: none;
    }
    .multi-select-item:hover { background: var(--bg-hover); }
    .multi-select-item input[type="checkbox"] {
      accent-color: var(--accent);
      width: 14px;
      height: 14px;
      cursor: pointer;
      flex-shrink: 0;
    }
    .multi-select-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      flex-shrink: 0;
    }
    .multi-select-divider {
      height: 1px;
      background: var(--border);
      margin: 4px 0;
    }

    /* ── Pills ── */
    .pill {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      color: var(--pill-color);
      background: color-mix(in srgb, var(--pill-color) 10%, transparent);
      margin-right: 4px;
      white-space: nowrap;
    }

    /* ── Spinner ── */
    .spinner {
      display: inline-block;
      width: 14px;
      height: 14px;
      border: 2px solid var(--border);
      border-top-color: var(--accent);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }

    .in-progress-indicator {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-muted);
      margin-right: 8px;
    }

    /* ── Detail rows ── */
    .detail-row td { padding: 0 !important; border-bottom: 1px solid var(--border) !important; }
    .detail-content {
      padding: 16px 24px;
      background: var(--bg);
    }
    .detail-actions {
      display: flex;
      gap: 8px;
      margin-bottom: 12px;
    }
    .detail-actions:empty { display: none; }
    .detail-loading {
      display: flex;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
      font-size: 13px;
      padding: 8px 0;
    }
    .detail-section-title {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin: 16px 0 8px;
    }
    .detail-section-title:first-child { margin-top: 0; }
    .event-item {
      display: flex;
      align-items: baseline;
      gap: 8px;
      font-size: 13px;
      padding: 3px 0;
    }
    .event-time {
      font-size: 11px;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    .event-type { font-weight: 500; }
    .event-msg { color: var(--text-secondary); }
    .output-block {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin: 8px 0;
      overflow: hidden;
    }
    .output-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 12px;
      background: rgba(255,255,255,0.02);
      border-bottom: 1px solid var(--border-subtle);
      font-size: 12px;
      font-weight: 500;
    }
    .output-meta { color: var(--text-muted); font-size: 11px; }
    .output-text {
      padding: 12px;
      font-size: 12px;
      font-family: 'SF Mono', 'Fira Code', monospace;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 400px;
      overflow-y: auto;
      color: var(--text-secondary);
      line-height: 1.6;
    }

    /* ── Empty state ── */
    .empty-state {
      text-align: center;
      padding: 48px 24px !important;
      color: var(--text-muted);
    }
    .empty-icon { margin-bottom: 12px; opacity: 0.3; }
    .empty-state p { margin: 4px 0; }

    /* ── Pagination ── */
    .pagination {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 16px;
      border-top: 1px solid var(--border-subtle);
    }
    .page-info { font-size: 12px; color: var(--text-muted); padding: 0 8px; }

    /* ── Stat cards ── */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 16px;
      margin-bottom: 24px;
    }
    .stat-card {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
    }
    .stat-label {
      font-size: 12px;
      font-weight: 500;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 8px;
    }
    .stat-value {
      font-size: 28px;
      font-weight: 700;
      color: var(--text);
      letter-spacing: -0.02em;
      line-height: 1;
    }
    .stat-sub {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 6px;
    }

    /* ── Chart grid ── */
    .chart-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
      margin-bottom: 24px;
    }
    .chart-card {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px;
    }
    .chart-title {
      font-size: 13px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 16px;
    }
    .chart-card canvas { max-height: 250px; }

    /* ── Repo table (in analytics) ── */
    .repo-table { width: 100%; border-collapse: collapse; }
    .repo-table th {
      text-align: left;
      padding: 8px 12px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.04em;
      border-bottom: 1px solid var(--border);
    }
    .repo-table td {
      padding: 8px 12px;
      font-size: 13px;
      border-bottom: 1px solid var(--border-subtle);
    }
    .bar-track { background: var(--bg-hover); border-radius: 3px; height: 4px; position: relative; }
    .bar-fill { height: 4px; border-radius: 3px; position: absolute; top: 0; left: 0; background: var(--accent); }

    /* ── Chat ── */
    .chat-container {
      display: flex;
      flex-direction: column;
      height: calc(100vh - 140px);
      max-height: 800px;
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .chat-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      background: rgba(255,255,255,0.02);
    }
    .chat-header-title {
      font-size: 13px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .chat-msg {
      max-width: 80%;
      padding: 10px 14px;
      border-radius: var(--radius);
      font-size: 13px;
      line-height: 1.6;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .chat-msg-user {
      align-self: flex-end;
      background: var(--accent);
      color: #fff;
    }
    .chat-msg-assistant {
      align-self: flex-start;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text-secondary);
    }
    .chat-msg-assistant code {
      background: rgba(255,255,255,0.06);
      padding: 1px 5px;
      border-radius: 3px;
      font-size: 12px;
      font-family: 'SF Mono', monospace;
    }
    .chat-msg-assistant pre {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px;
      margin: 8px 0;
      overflow-x: auto;
      font-size: 12px;
      font-family: 'SF Mono', monospace;
    }
    .chat-msg-system {
      align-self: center;
      color: var(--text-muted);
      font-size: 12px;
      padding: 4px 12px;
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
    }
    .chat-thinking {
      align-self: flex-start;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      font-size: 12px;
      color: var(--text-muted);
    }
    .chat-input-row {
      display: flex;
      gap: 8px;
      padding: 12px 16px;
      border-top: 1px solid var(--border);
      background: rgba(255,255,255,0.02);
    }
    .chat-input {
      flex: 1;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      color: var(--text);
      font-size: 13px;
      font-family: var(--font);
      outline: none;
      transition: border-color 0.15s;
    }
    .chat-input:focus { border-color: var(--accent); }
    .chat-input::placeholder { color: var(--text-muted); }
    .chat-send {
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius-sm);
      padding: 10px 20px;
      font-size: 13px;
      font-weight: 500;
      font-family: var(--font);
      cursor: pointer;
      transition: background 0.15s;
    }
    .chat-send:hover { background: var(--accent-hover); }
    .chat-send:disabled { opacity: 0.4; cursor: not-allowed; }
    .chat-welcome {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      flex: 1;
      text-align: center;
      padding: 32px;
      color: var(--text-muted);
    }
    .chat-welcome h3 {
      font-size: 16px;
      font-weight: 600;
      color: var(--text);
      margin-bottom: 8px;
    }
    .chat-welcome p { font-size: 13px; max-width: 400px; margin: 4px 0; }
    .chat-suggestions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 16px;
      justify-content: center;
    }
    .chat-suggestion {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 12px;
      color: var(--text-secondary);
      cursor: pointer;
      transition: all 0.15s;
      font-family: var(--font);
    }
    .chat-suggestion:hover {
      border-color: var(--accent);
      color: var(--accent);
    }

    /* ── Sidebar ── */
    .sidebar {
      position: fixed;
      top: 57px;
      right: 0;
      bottom: 0;
      width: 420px;
      background: var(--bg-raised);
      border-left: 1px solid var(--border);
      transform: translateX(100%);
      transition: transform 0.25s cubic-bezier(0.4, 0, 0.2, 1);
      z-index: 40;
      display: flex;
      flex-direction: column;
    }
    .sidebar.open {
      transform: translateX(0);
    }
    body.sidebar-open .main {
      margin-right: 420px;
      transition: margin-right 0.25s cubic-bezier(0.4, 0, 0.2, 1);
    }
    .sidebar .chat-container {
      height: 100%;
      max-height: none;
      border: none;
      border-radius: 0;
      background: transparent;
    }
    .sidebar-toggle {
      position: relative;
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 5px 10px;
      font-size: 12px;
      font-weight: 500;
      font-family: var(--font);
      color: var(--text-secondary);
      background: transparent;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      cursor: pointer;
      transition: all 0.15s;
    }
    .sidebar-toggle:hover {
      background: var(--bg-hover);
      color: var(--text);
      border-color: var(--text-muted);
    }
    .sidebar-toggle.active {
      background: color-mix(in srgb, var(--accent) 12%, transparent);
      color: var(--accent);
      border-color: color-mix(in srgb, var(--accent) 30%, transparent);
    }

    /* ── Utilities ── */
    .text-muted { color: var(--text-muted); }
    .text-sm { font-size: 12px; }
    .text-secondary { color: var(--text-secondary); }
    .flex { display: flex; }
    .items-center { align-items: center; }
    .gap-2 { gap: 8px; }
    .gap-4 { gap: 16px; }
    .justify-between { justify-content: space-between; }
    .mb-4 { margin-bottom: 16px; }
    .mb-6 { margin-bottom: 24px; }

    /* ── Responsive ── */
    @media (max-width: 1200px) {
      .sidebar { width: 360px; }
      body.sidebar-open .main { margin-right: 360px; }
    }
    @media (max-width: 1024px) {
      .stat-grid { grid-template-columns: repeat(2, 1fr); }
      .chart-grid { grid-template-columns: 1fr; }
      .sidebar { width: 100%; max-width: 420px; }
      body.sidebar-open .main { margin-right: 0; }
    }
    @media (max-width: 768px) {
      .main { padding: 16px; }
      .nav-inner { padding: 0 16px; }
      .cell-tools, .cell-title, .cell-age { display: none; }
    }

    /* ── Settings ── */
    .settings-section {
      background: var(--bg-raised);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 16px;
      overflow: hidden;
    }
    .settings-section-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 14px 20px;
      cursor: pointer;
      user-select: none;
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
      border-bottom: 1px solid transparent;
      transition: border-color 0.15s;
    }
    .settings-section-header:hover { background: rgba(255,255,255,0.02); }
    .settings-section-header .chevron {
      transition: transform 0.2s;
      opacity: 0.5;
    }
    .settings-section.open .settings-section-header {
      border-bottom-color: var(--border);
    }
    .settings-section.open .settings-section-header .chevron {
      transform: rotate(90deg);
    }
    .settings-section-body {
      display: none;
      padding: 20px;
    }
    .settings-section.open .settings-section-body {
      display: block;
    }
    .settings-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 16px;
    }
    .settings-field {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }
    .settings-field.full-width {
      grid-column: 1 / -1;
    }
    .settings-field label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-secondary);
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }
    .settings-field input[type="text"],
    .settings-field input[type="number"],
    .settings-field textarea,
    .settings-field select {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: var(--font);
      font-size: 13px;
      padding: 8px 10px;
      transition: border-color 0.15s;
    }
    .settings-field input:focus,
    .settings-field textarea:focus,
    .settings-field select:focus {
      outline: none;
      border-color: var(--accent);
    }
    .settings-field textarea {
      resize: vertical;
      min-height: 80px;
    }
    .settings-field textarea.prompt-editor {
      font-family: 'SF Mono', 'Fira Code', 'Cascadia Code', monospace;
      font-size: 12px;
      line-height: 1.6;
      min-height: 200px;
    }
    .settings-field .hint {
      font-size: 11px;
      color: var(--text-muted);
    }
    .settings-check {
      display: flex;
      align-items: center;
      gap: 8px;
      cursor: pointer;
    }
    .settings-check input[type="checkbox"] {
      accent-color: var(--accent);
      width: 16px;
      height: 16px;
    }
    .settings-check span {
      font-size: 13px;
      color: var(--text);
    }
    .settings-actions {
      display: flex;
      gap: 8px;
      margin-top: 16px;
      padding-top: 16px;
      border-top: 1px solid var(--border);
    }
    .repo-card {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      margin-bottom: 10px;
    }
    .repo-card-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 14px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      color: var(--text);
    }
    .repo-card-header:hover { background: rgba(255,255,255,0.02); }
    .repo-card-header .chevron {
      transition: transform 0.2s;
      opacity: 0.5;
      margin-left: auto;
    }
    .repo-card.open .repo-card-header .chevron {
      transform: rotate(90deg);
    }
    .repo-card-body {
      display: none;
      padding: 14px;
      border-top: 1px solid var(--border);
    }
    .repo-card.open .repo-card-body {
      display: block;
    }
    .prompt-file-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 6px 10px;
      border-radius: var(--radius-sm);
      cursor: pointer;
      font-size: 12px;
      color: var(--text-secondary);
      transition: background 0.15s;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .prompt-file-item:hover {
      background: var(--bg-hover);
      color: var(--text);
    }
    .prompt-file-item.active {
      background: color-mix(in srgb, var(--accent) 10%, transparent);
      color: var(--accent);
      border-left: 2px solid var(--accent);
    }
    .prompt-file-item svg { opacity: 0.5; flex-shrink: 0; }
    .prompt-file-item.indented { padding-left: 24px; }
    .folder-header {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      cursor: pointer;
      font-size: 12px;
      font-weight: 600;
      color: var(--text);
      user-select: none;
      border-radius: var(--radius-sm);
    }
    .folder-header:hover { background: var(--bg-hover); }
    .folder-header .folder-chevron {
      transition: transform 0.2s;
      opacity: 0.5;
      width: 10px;
      height: 10px;
      flex-shrink: 0;
    }
    .folder-header.collapsed .folder-chevron { transform: rotate(-90deg); }
    .folder-files { overflow: hidden; }
    .folder-files.collapsed { display: none; }
    .prompts-layout {
      display: flex;
      gap: 16px;
      min-height: 350px;
      border-top: 1px solid var(--border);
      padding-top: 16px;
      margin-top: 16px;
    }
    .prompts-tree {
      width: 240px;
      flex-shrink: 0;
      display: flex;
      flex-direction: column;
      gap: 4px;
      overflow-y: auto;
      max-height: 500px;
    }
    .prompts-editor {
      flex: 1;
      display: flex;
      flex-direction: column;
    }
    .technique-row {
      display: grid;
      grid-template-columns: 1fr 2fr 2fr auto;
      gap: 8px;
      align-items: center;
      margin-bottom: 8px;
    }
    .technique-row input, .technique-row select {
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      color: var(--text);
      font-family: var(--font);
      font-size: 12px;
      padding: 6px 8px;
    }
    .toast {
      position: fixed;
      bottom: 24px;
      right: 24px;
      padding: 12px 20px;
      border-radius: var(--radius);
      font-size: 13px;
      font-weight: 500;
      z-index: 1000;
      animation: slideIn 0.2s ease-out;
      pointer-events: none;
    }
    .toast.success {
      background: color-mix(in srgb, var(--success) 15%, var(--bg-raised));
      border: 1px solid var(--success);
      color: var(--success);
    }
    .toast.error {
      background: color-mix(in srgb, var(--error) 15%, var(--bg-raised));
      border: 1px solid var(--error);
      color: var(--error);
    }
    @keyframes slideIn {
      from { transform: translateY(10px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }
  </style>
</head>
<body>

  <!-- Navigation -->
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="nav-brand">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
        iago
      </a>
      <div class="nav-tabs">
        <button class="nav-tab active" onclick="switchTab('reviews')" id="tab-btn-reviews">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8m8 4H8m2-8H8"/></svg>
          Reviews
          <span class="nav-badge" id="active-count">${activePRs.length}</span>
        </button>
        <button class="nav-tab" onclick="switchTab('analytics')" id="tab-btn-analytics">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 20V10M12 20V4M6 20v-6"/></svg>
          Analytics
        </button>
        <button class="nav-tab" onclick="switchTab('settings')" id="tab-btn-settings">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
          Settings
        </button>
      </div>
      <div class="nav-right">
        <button class="sidebar-toggle" id="sidebar-toggle" onclick="toggleSidebar()" title="Chat Assistant">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          Chat
        </button>
        <button class="btn btn-outline btn-sm" onclick="refreshData()" title="Refresh data">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
        </button>
      </div>
    </div>
  </nav>

  <div class="main">

    <!-- Reviews Tab -->
    <div id="tab-reviews" class="tab-panel active">
      <div class="table-wrap">
        <div class="section-tabs" id="section-tabs">
          <button class="section-tab active" data-section="all" onclick="switchSection('all')">
            All <span class="section-count" id="count-all">${defaultFiltered.length}</span>
          </button>
          <button class="section-tab" data-section="to-review" onclick="switchSection('to-review')">
            To Review <span class="section-count" id="count-to-review">${toReviewPRs.length}</span>
          </button>
          <button class="section-tab" data-section="in-progress" onclick="switchSection('in-progress')">
            In Progress <span class="section-count" id="count-in-progress">${inProgressPRs.length}</span>
          </button>
          <button class="section-tab" data-section="recent" onclick="switchSection('recent')">
            Recent <span class="section-count" id="count-recent">${recentPRs.length}</span>
          </button>
        </div>
        <div class="filter-bar">
          <label>Status</label>
          <div class="multi-select" id="ms-status">
            <button class="multi-select-btn" onclick="togglePanel('ms-status', event)">
              <span class="ms-label">Active</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="multi-select-panel" id="ms-status-panel">
              <label class="multi-select-item" data-value="detected"><input type="checkbox" checked><span class="multi-select-dot" style="background:#71717a"></span>Detected</label>
              <label class="multi-select-item" data-value="notified"><input type="checkbox" checked><span class="multi-select-dot" style="background:#3b82f6"></span>Awaiting</label>
              <label class="multi-select-item" data-value="accepted"><input type="checkbox" checked><span class="multi-select-dot" style="background:#eab308"></span>Accepted</label>
              <label class="multi-select-item" data-value="cloning"><input type="checkbox" checked><span class="multi-select-dot" style="background:#06b6d4"></span>Cloning</label>
              <label class="multi-select-item" data-value="reviewing"><input type="checkbox" checked><span class="multi-select-dot" style="background:#f97316"></span>Reviewing</label>
              <label class="multi-select-item" data-value="done"><input type="checkbox" checked><span class="multi-select-dot" style="background:#22c55e"></span>Done</label>
              <label class="multi-select-item" data-value="changes_requested"><input type="checkbox" checked><span class="multi-select-dot" style="background:#f59e0b"></span>Changes Req.</label>
              <label class="multi-select-item" data-value="updated"><input type="checkbox" checked><span class="multi-select-dot" style="background:#8b5cf6"></span>Updated</label>
              <label class="multi-select-item" data-value="error"><input type="checkbox" checked><span class="multi-select-dot" style="background:#ef4444"></span>Error</label>
              <div class="multi-select-divider"></div>
              <label class="multi-select-item" data-value="dismissed"><input type="checkbox"><span class="multi-select-dot" style="background:#71717a"></span>Dismissed</label>
            </div>
          </div>
          <label>GitHub</label>
          <div class="multi-select" id="ms-gh">
            <button class="multi-select-btn" onclick="togglePanel('ms-gh', event)">
              <span class="ms-label">All</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>
            </button>
            <div class="multi-select-panel" id="ms-gh-panel">
              <label class="multi-select-item" data-value="open"><input type="checkbox" checked><span class="multi-select-dot" style="background:#22c55e"></span>Open</label>
              <label class="multi-select-item" data-value="merged"><input type="checkbox" checked><span class="multi-select-dot" style="background:#a855f7"></span>Merged</label>
              <label class="multi-select-item" data-value="closed"><input type="checkbox" checked><span class="multi-select-dot" style="background:#ef4444"></span>Closed</label>
            </div>
          </div>
          <button class="btn btn-ghost btn-sm" onclick="refreshData()" id="refresh-btn" title="Refresh">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
            Refresh
          </button>
          <span class="filter-summary" id="filter-summary">${defaultFiltered.length} review(s)</span>
        </div>
        <table>
          <thead>
            <tr>
              <th style="width:11%">Repository</th>
              <th style="width:5%">PR</th>
              <th style="width:8%">Author</th>
              <th style="width:9%">Status</th>
              <th>Title</th>
              <th style="width:11%">Tools</th>
              <th style="width:7%">Age</th>
              <th style="width:20%;text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="pr-table-body">
            ${renderPRRows(firstPage)}
          </tbody>
        </table>
        <div class="pagination" id="pagination" ${totalPages <= 1 ? 'style="display:none"' : ""}>
          <button class="btn btn-ghost btn-sm" onclick="goToPage(currentPage - 1)" id="prev-btn" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
            Prev
          </button>
          <span class="page-info" id="page-info">Page 1 of ${totalPages}</span>
          <button class="btn btn-ghost btn-sm" onclick="goToPage(currentPage + 1)" id="next-btn" ${totalPages <= 1 ? "disabled" : ""}>
            Next
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg>
          </button>
        </div>
      </div>
    </div>

    <!-- Analytics Tab -->
    <div id="tab-analytics" class="tab-panel">
      <div id="analytics-content">
        <div style="text-align:center;padding:48px;color:var(--text-muted)">
          <span class="spinner"></span>
          <p style="margin-top:12px">Loading analytics...</p>
        </div>
      </div>
    </div>

    <!-- Settings Tab -->
    <div id="tab-settings" class="tab-panel">
      <div id="settings-content">
        <div style="text-align:center;padding:48px;color:var(--text-muted)">
          <span class="spinner"></span>
          <p style="margin-top:12px">Loading settings...</p>
        </div>
      </div>
    </div>

  </div>

  <!-- Chat Sidebar -->
  <div class="sidebar" id="chat-sidebar">
    <div class="chat-container">
      <div class="chat-header">
        <div class="chat-header-title">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          Review Assistant
        </div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-ghost btn-sm" onclick="clearChat()">Clear</button>
          <button class="btn btn-ghost btn-sm" onclick="toggleSidebar()" title="Close">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
          </button>
        </div>
      </div>
      <div class="chat-messages" id="chat-messages">
        <div class="chat-welcome" id="chat-welcome">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3;margin-bottom:10px"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          <h3>Review Assistant</h3>
          <p>Ask about your code reviews, get summaries, or analyze patterns.</p>
          <p class="text-sm" style="margin-top:4px">Powered by your Claude session</p>
          <div class="chat-suggestions">
            <button class="chat-suggestion" onclick="askSuggestion(this)">Summarize recent reviews</button>
            <button class="chat-suggestion" onclick="askSuggestion(this)">Show current config</button>
            <button class="chat-suggestion" onclick="askSuggestion(this)">Improve the system prompt</button>
            <button class="chat-suggestion" onclick="askSuggestion(this)">Show error patterns</button>
          </div>
        </div>
      </div>
      <div class="chat-input-row">
        <input type="text" id="chat-input" class="chat-input" placeholder="Ask about your reviews..."
               onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendChat();}">
        <button class="chat-send" id="chat-send-btn" onclick="sendChat()">Send</button>
      </div>
    </div>
  </div>

  <script>
    // ── State ──
    let currentPage = 1;
    let totalPages = ${totalPages};
    let totalItems = ${defaultFiltered.length};
    let chartInstances = {};
    let chatHistory = [];
    let analyticsLoaded = false;
    let settingsLoaded = false;
    let settingsData = null;
    let currentFilters = { status: 'active', githubState: 'all' };

    // ── Tab switching ──
    function switchTab(tab) {
      document.querySelectorAll('.tab-panel').forEach(function(p) { p.classList.remove('active'); });
      document.querySelectorAll('.nav-tab').forEach(function(t) { t.classList.remove('active'); });
      document.getElementById('tab-' + tab).classList.add('active');
      document.getElementById('tab-btn-' + tab).classList.add('active');
      if (tab === 'analytics' && !analyticsLoaded) {
        analyticsLoaded = true;
        loadAnalytics();
      }
      if (tab === 'settings' && !settingsLoaded) {
        settingsLoaded = true;
        loadSettings();
      }
    }

    // ── Sidebar ──
    function toggleSidebar() {
      var sidebar = document.getElementById('chat-sidebar');
      var toggle = document.getElementById('sidebar-toggle');
      var isOpen = sidebar.classList.toggle('open');
      document.body.classList.toggle('sidebar-open', isOpen);
      toggle.classList.toggle('active', isOpen);
      if (isOpen) {
        sessionStorage.setItem('sidebar-open', '1');
        setTimeout(function() { document.getElementById('chat-input').focus(); }, 300);
      } else {
        sessionStorage.setItem('sidebar-open', '0');
      }
    }

    // Restore sidebar state
    if (sessionStorage.getItem('sidebar-open') === '1') {
      document.getElementById('chat-sidebar').classList.add('open');
      document.body.classList.add('sidebar-open');
      document.getElementById('sidebar-toggle').classList.add('active');
    }

    // ── Multi-select dropdowns ──
    var allStatuses = ['detected','notified','accepted','cloning','reviewing','done','changes_requested','updated','error','dismissed'];
    var activeStatuses = ['detected','notified','accepted','cloning','reviewing','done','changes_requested','updated','error'];
    var allGhStates = ['open','merged','closed'];

    var sectionMap = {
      'all': ['detected','notified','accepted','cloning','reviewing','done','changes_requested','updated','error'],
      'to-review': ['detected','notified','updated'],
      'in-progress': ['accepted','cloning','reviewing','changes_requested'],
      'recent': ['done','error']
    };
    var currentSection = 'all';

    function togglePanel(id, event) {
      if (event) event.stopPropagation();
      var panel = document.getElementById(id + '-panel');
      var btn = panel.previousElementSibling;
      var isOpen = panel.classList.toggle('open');
      btn.classList.toggle('open', isOpen);
      // Close other panels
      document.querySelectorAll('.multi-select-panel.open').forEach(function(p) {
        if (p.id !== id + '-panel') { p.classList.remove('open'); p.previousElementSibling.classList.remove('open'); }
      });
    }

    // Close panels on outside click
    document.addEventListener('click', function(e) {
      if (!e.target.closest('.multi-select')) {
        document.querySelectorAll('.multi-select-panel.open').forEach(function(p) {
          p.classList.remove('open');
          p.previousElementSibling.classList.remove('open');
        });
      }
    });

    function getSelected(panelId) {
      var items = document.querySelectorAll('#' + panelId + ' .multi-select-item');
      var selected = [];
      items.forEach(function(item) {
        if (item.querySelector('input').checked) selected.push(item.getAttribute('data-value'));
      });
      return selected;
    }

    function updateLabel(msId, allValues, labelMap) {
      var panel = document.getElementById(msId + '-panel');
      var label = panel.previousElementSibling.querySelector('.ms-label');
      var selected = getSelected(msId + '-panel');
      if (selected.length === 0) { label.textContent = 'None'; }
      else if (selected.length === allValues.length) { label.textContent = 'All'; }
      else if (selected.length <= 2) {
        label.textContent = selected.map(function(v) { return labelMap[v] || v; }).join(', ');
      } else {
        label.textContent = selected.length + ' selected';
      }
    }

    var statusLabels = {detected:'Detected',notified:'Awaiting',accepted:'Accepted',cloning:'Cloning',reviewing:'Reviewing',done:'Done',changes_requested:'Changes Req.',updated:'Updated',error:'Error',dismissed:'Dismissed'};
    var ghLabels = {open:'Open',merged:'Merged',closed:'Closed'};

    // Listen for checkbox changes
    document.getElementById('ms-status-panel').addEventListener('change', function() {
      updateLabel('ms-status', allStatuses, statusLabels);
      currentPage = 1;
      fetchPage(1);
    });
    document.getElementById('ms-gh-panel').addEventListener('change', function() {
      updateLabel('ms-gh', allGhStates, ghLabels);
      currentPage = 1;
      fetchPage(1);
    });

    // ── Section tabs ──
    // Sections that should only show open PRs
    var sectionGhFilter = { 'in-progress': ['open'], 'to-review': ['open'] };

    function switchSection(section) {
      currentSection = section;
      var statuses = sectionMap[section] || sectionMap['all'];
      // Update status checkboxes
      var panel = document.getElementById('ms-status-panel');
      var checkboxes = panel.querySelectorAll('input[type="checkbox"]');
      checkboxes.forEach(function(cb) {
        var val = cb.closest('.multi-select-item').getAttribute('data-value');
        cb.checked = statuses.indexOf(val) !== -1;
      });
      updateLabel('ms-status', allStatuses, statusLabels);
      // Update GitHub state checkboxes for sections that filter by gh state
      var ghFilter = sectionGhFilter[section];
      if (ghFilter) {
        var ghPanel = document.getElementById('ms-gh-panel');
        ghPanel.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
          var val = cb.closest('.multi-select-item').getAttribute('data-value');
          cb.checked = ghFilter.indexOf(val) !== -1;
        });
        updateLabel('ms-gh', allGhStates, ghLabels);
      } else {
        // Reset to all gh states
        var ghPanel = document.getElementById('ms-gh-panel');
        ghPanel.querySelectorAll('input[type="checkbox"]').forEach(function(cb) { cb.checked = true; });
        updateLabel('ms-gh', allGhStates, ghLabels);
      }
      // Update active tab
      document.querySelectorAll('.section-tab').forEach(function(t) { t.classList.remove('active'); });
      document.querySelector('.section-tab[data-section="' + section + '"]').classList.add('active');
      currentPage = 1;
      fetchPage(1);
    }

    function updateSectionCounts() {
      var sections = {
        'all': activeStatuses,
        'to-review': sectionMap['to-review'],
        'in-progress': sectionMap['in-progress'],
        'recent': sectionMap['recent']
      };
      Object.keys(sections).forEach(function(key) {
        var qs = 'status=' + sections[key].join(',') + '&size=1&page=1';
        // Filter by open gh state for sections that need it
        if (sectionGhFilter[key]) qs += '&github_state=' + sectionGhFilter[key].join(',');
        fetch('/api/reviews/page?' + qs)
          .then(function(r) { return r.json(); })
          .then(function(d) {
            var el = document.getElementById('count-' + key);
            if (el) el.textContent = d.totalItems;
          })
          .catch(function() {});
      });
    }

    // ── Filtering & Pagination ──
    function buildQueryString(page) {
      var params = new URLSearchParams();
      params.set('page', page);
      params.set('size', '${PAGE_SIZE}');
      var statuses = getSelected('ms-status-panel');
      if (statuses.length > 0 && statuses.length < allStatuses.length) {
        params.set('status', statuses.join(','));
      }
      if (currentSection === 'to-review') {
        params.set('sort', 'opened_at');
      }
      var ghStates = getSelected('ms-gh-panel');
      if (ghStates.length > 0 && ghStates.length < allGhStates.length) {
        params.set('github_state', ghStates.join(','));
      }
      return params.toString();
    }

    async function fetchPage(page) {
      try {
        var res = await fetch('/api/reviews/page?' + buildQueryString(page));
        var data = await res.json();
        totalPages = data.totalPages;
        totalItems = data.totalItems;
        currentPage = data.page;
        document.getElementById('pr-table-body').innerHTML = data.html;
        document.getElementById('page-info').textContent = 'Page ' + currentPage + ' of ' + totalPages;
        document.getElementById('prev-btn').disabled = currentPage <= 1;
        document.getElementById('next-btn').disabled = currentPage >= totalPages;
        document.getElementById('pagination').style.display = totalPages <= 1 ? 'none' : 'flex';
        document.getElementById('filter-summary').textContent = totalItems + ' review(s)';
      } catch(e) {}
    }

    async function goToPage(page) {
      if (page < 1 || page > totalPages) return;
      await fetchPage(page);
    }

    async function refreshData() {
      var btn = document.getElementById('refresh-btn');
      if (btn) { btn.disabled = true; btn.style.opacity = '0.5'; }
      await fetchPage(currentPage);
      // Also refresh active count badge + section counts
      try {
        var res = await fetch('/api/reviews/page?status=' + activeStatuses.join(',') + '&size=1&page=1');
        var data = await res.json();
        var badge = document.getElementById('active-count');
        if (badge) badge.textContent = data.totalItems;
      } catch(e) {}
      updateSectionCounts();
      if (btn) { btn.disabled = false; btn.style.opacity = ''; }
    }

    // ── Analytics ──
    async function loadAnalytics() {
      try {
        var [statsRes, toolsRes, timelineRes, reposRes, findingsRes] = await Promise.all([
          fetch('/api/stats'), fetch('/api/stats/tools'), fetch('/api/stats/timeline?period=day'),
          fetch('/api/stats/repos'), fetch('/api/stats/findings')
        ]);
        var stats = await statsRes.json();
        var tools = await toolsRes.json();
        var timeline = await timelineRes.json();
        var repos = await reposRes.json();
        var findings = await findingsRes.json();
        renderAnalytics(stats, tools, timeline, repos, findings);
      } catch(e) {
        document.getElementById('analytics-content').innerHTML = '<div style="text-align:center;padding:48px;color:var(--text-muted)">Failed to load analytics</div>';
      }
    }

    function renderAnalytics(stats, tools, timeline, repos, findings) {
      var c = document.getElementById('analytics-content');
      c.innerHTML = '<div class="stat-grid">'
        + statCard('Total Reviews', stats.totalReviews, stats.todayCount + ' today, ' + stats.weekCount + ' this week')
        + statCard('Success Rate', stats.successRate + '%', stats.doneCount + ' done, ' + stats.errorCount + ' errors')
        + statCard('Avg Duration', stats.avgDuration, 'detected \\u2192 done')
        + statCard('Findings', findings.total, findings.critical + ' critical, ' + findings.warning + ' warnings')
        + '</div>'
        + '<div class="chart-grid">'
        + '<div class="chart-card"><div class="chart-title">Reviews Timeline</div><canvas id="chart-timeline"></canvas></div>'
        + '<div class="chart-card"><div class="chart-title">Status Breakdown</div><canvas id="chart-status"></canvas></div>'
        + '<div class="chart-card"><div class="chart-title">Tool Performance</div><canvas id="chart-tools"></canvas></div>'
        + '<div class="chart-card"><div class="chart-title">Findings Severity</div><canvas id="chart-findings"></canvas></div>'
        + '<div class="chart-card"><div class="chart-title">Repository Breakdown</div><div id="repo-table-container"></div></div>'
        + '<div class="chart-card"><div class="chart-title">Duration Distribution</div><canvas id="chart-duration"></canvas></div>'
        + '</div>';
      renderCharts(stats, tools, timeline, repos, findings);
    }

    function statCard(label, value, sub) {
      return '<div class="stat-card"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + '</div><div class="stat-sub">' + sub + '</div></div>';
    }

    function renderCharts(stats, tools, timeline, repos, findings) {
      var cc = { detected:'#71717a', notified:'#3b82f6', accepted:'#eab308', cloning:'#06b6d4', reviewing:'#f97316', done:'#22c55e', error:'#ef4444', dismissed:'#71717a' };
      Chart.defaults.color = '#71717a';
      Chart.defaults.borderColor = '#27272a';
      Object.values(chartInstances).forEach(function(c) { if(c) c.destroy(); });
      chartInstances = {};

      if (timeline.length > 0) {
        chartInstances.timeline = new Chart(document.getElementById('chart-timeline'), {
          type: 'line',
          data: {
            labels: timeline.map(function(t){return t.date;}),
            datasets: [
              {label:'Total',data:timeline.map(function(t){return t.total;}),borderColor:'#3b82f6',backgroundColor:'rgba(59,130,246,0.08)',fill:true,tension:0.3,borderWidth:2,pointRadius:3},
              {label:'Success',data:timeline.map(function(t){return t.success;}),borderColor:'#22c55e',backgroundColor:'rgba(34,197,94,0.08)',fill:true,tension:0.3,borderWidth:2,pointRadius:3},
              {label:'Error',data:timeline.map(function(t){return t.error;}),borderColor:'#ef4444',backgroundColor:'rgba(239,68,68,0.08)',fill:true,tension:0.3,borderWidth:2,pointRadius:3}
            ]
          },
          options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:16}}},scales:{y:{beginAtZero:true,ticks:{stepSize:1},grid:{color:'rgba(39,39,42,0.5)'}},x:{grid:{display:false}}}}
        });
      }

      var sd = stats.statusBreakdown || [];
      if (sd.length > 0) {
        chartInstances.status = new Chart(document.getElementById('chart-status'), {
          type: 'doughnut',
          data: { labels:sd.map(function(s){return s.status;}), datasets:[{data:sd.map(function(s){return s.count;}), backgroundColor:sd.map(function(s){return cc[s.status]||'#71717a';}), borderWidth:0}]},
          options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:16}}},cutout:'65%'}
        });
      }

      if (tools.length > 0) {
        chartInstances.tools = new Chart(document.getElementById('chart-tools'), {
          type: 'bar',
          data: { labels:tools.map(function(t){return t.tool_name;}), datasets:[
            {label:'Avg (s)',data:tools.map(function(t){return (t.avg_duration_ms/1000).toFixed(1);}),backgroundColor:'#3b82f6',borderRadius:4},
            {label:'Max (s)',data:tools.map(function(t){return (t.max_duration_ms/1000).toFixed(1);}),backgroundColor:'rgba(59,130,246,0.2)',borderRadius:4}
          ]},
          options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:16}}},scales:{y:{beginAtZero:true,grid:{color:'rgba(39,39,42,0.5)'}},x:{grid:{display:false}}}}
        });
      }

      if (findings.total > 0) {
        chartInstances.findings = new Chart(document.getElementById('chart-findings'), {
          type: 'doughnut',
          data: { labels:['Critical','Warning','Suggestion'], datasets:[{data:[findings.critical,findings.warning,findings.suggestion], backgroundColor:['#ef4444','#f59e0b','#3b82f6'], borderWidth:0}]},
          options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:16}}},cutout:'65%'}
        });
      }

      var rc = document.getElementById('repo-table-container');
      if (repos.length > 0) {
        var maxT = Math.max.apply(null, repos.map(function(r){return r.total;}));
        var h = '<table class="repo-table"><thead><tr><th>Repo</th><th>Reviews</th><th>Success</th><th>Errors</th><th>Avg</th><th></th></tr></thead><tbody>';
        repos.forEach(function(r) {
          var pct = maxT>0 ? (r.total/maxT*100) : 0;
          var dur = r.avg_duration_ms > 0 ? (r.avg_duration_ms/1000).toFixed(0)+'s' : '\\u2014';
          h += '<tr><td style="font-weight:500">'+r.repo+'</td><td>'+r.total+'</td><td style="color:#22c55e">'+r.success+'</td><td style="color:#ef4444">'+r.error+'</td><td>'+dur+'</td><td style="width:25%"><div class="bar-track"><div class="bar-fill" style="width:'+pct+'%"></div></div></td></tr>';
        });
        h += '</tbody></table>';
        rc.innerHTML = h;
      } else { rc.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)">No repository data</div>'; }

      if (tools.length > 0) {
        var d = tools.map(function(t){return {name:t.tool_name,min:t.min_duration_ms/1000,avg:t.avg_duration_ms/1000,max:t.max_duration_ms/1000};});
        chartInstances.duration = new Chart(document.getElementById('chart-duration'), {
          type: 'bar',
          data: { labels:d.map(function(x){return x.name;}), datasets:[
            {label:'Min (s)',data:d.map(function(x){return x.min.toFixed(1);}),backgroundColor:'#22c55e',borderRadius:4},
            {label:'Avg (s)',data:d.map(function(x){return x.avg.toFixed(1);}),backgroundColor:'#3b82f6',borderRadius:4},
            {label:'Max (s)',data:d.map(function(x){return x.max.toFixed(1);}),backgroundColor:'#ef4444',borderRadius:4}
          ]},
          options:{responsive:true,plugins:{legend:{position:'bottom',labels:{boxWidth:12,padding:16}}},scales:{y:{beginAtZero:true,grid:{color:'rgba(39,39,42,0.5)'}},x:{grid:{display:false}}}}
        });
      }
    }

    // ── PR Actions ──
    async function launchReview(prId, btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span> Starting...';
      try {
        var res = await fetch('/api/reviews/' + prId + '/retry', { method: 'POST' });
        if (!res.ok) {
          btn.innerHTML = 'Error';
          btn.style.borderColor = 'var(--error)';
          btn.style.color = 'var(--error)';
          setTimeout(function() { btn.innerHTML = 'Review'; btn.disabled = false; btn.style = ''; }, 2000);
          return;
        }
        btn.innerHTML = '\\u2713 Launched';
        btn.style.background = 'var(--success)';
        btn.style.borderColor = 'var(--success)';
      } catch(e) {
        btn.innerHTML = 'Review';
        btn.disabled = false;
      }
    }

    async function dismissReview(prId, btn) {
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span>';
      try {
        var res = await fetch('/api/reviews/' + prId + '/dismiss', { method: 'POST' });
        if (!res.ok) {
          var data = await res.json();
          btn.innerHTML = data.error || 'Error';
          setTimeout(function() { btn.innerHTML = 'Dismiss'; btn.disabled = false; }, 2000);
          return;
        }
        refreshData();
      } catch(e) {
        btn.innerHTML = 'Dismiss';
        btn.disabled = false;
      }
    }

    async function cancelReview(prId, btn) {
      if (!confirm('Cancel this review? The running process will be killed.')) return;
      btn.disabled = true;
      btn.innerHTML = '<span class="spinner" style="width:12px;height:12px;border-width:1.5px"></span> Cancelling...';
      try {
        var res = await fetch('/api/reviews/' + prId + '/cancel', { method: 'POST' });
        if (!res.ok) {
          var data = await res.json();
          btn.innerHTML = data.error || 'Error';
          setTimeout(function() { btn.innerHTML = 'Cancel'; btn.disabled = false; }, 2000);
          return;
        }
        refreshData();
      } catch(e) {
        btn.innerHTML = 'Cancel';
        btn.disabled = false;
      }
    }

    function copyAttach(prId, sessionId, btn) {
      var cmd = 'iago attach ' + prId;
      navigator.clipboard.writeText(cmd).then(function() {
        var orig = btn.innerHTML;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg> Copied';
        setTimeout(function() { btn.innerHTML = orig; }, 1500);
      });
    }

    // ── Progress polling for in-progress rows ──
    var progressIntervals = {};
    function startProgressPolling() {
      // Clear old intervals
      Object.values(progressIntervals).forEach(function(id) { clearInterval(id); });
      progressIntervals = {};
      // Find in-progress rows and poll
      document.querySelectorAll('.in-progress-indicator').forEach(function(el) {
        var match = el.id && el.id.match(/^progress-(\\d+)$/);
        if (!match) return;
        var prId = match[1];
        function poll() {
          fetch('/api/reviews/' + prId + '/progress')
            .then(function(r) { return r.json(); })
            .then(function(d) {
              var textEl = el.querySelector('.progress-text');
              if (!textEl) return;
              if (d.lastEvent && d.lastEvent.message) {
                var elapsed = d.elapsed ? ' (' + formatElapsed(d.elapsed) + ')' : '';
                textEl.textContent = d.lastEvent.message + elapsed;
              }
              if (!['accepted','cloning','reviewing'].includes(d.status)) {
                clearInterval(progressIntervals[prId]);
                delete progressIntervals[prId];
                refreshData();
              }
            }).catch(function(){});
        }
        poll();
        progressIntervals[prId] = setInterval(poll, 5000);
      });
    }

    function formatElapsed(sec) {
      if (sec < 60) return sec + 's';
      var m = Math.floor(sec / 60);
      var s = sec % 60;
      return m + 'm ' + s + 's';
    }

    // Start polling after page load and after each page fetch
    var origFetchPage = fetchPage;
    fetchPage = async function(page) {
      await origFetchPage(page);
      startProgressPolling();
    };
    startProgressPolling();

    async function toggleDetail(prId, btn) {
      var row = document.getElementById('detail-' + prId);
      if (!row) return;
      if (row.style.display === 'none') {
        row.style.display = 'table-row';
        if (btn) btn.querySelector('svg').style.transform = 'rotate(180deg)';
        var content = document.getElementById('detail-content-' + prId);
        try {
          var [evRes, outRes, prRes] = await Promise.all([
            fetch('/api/reviews/' + prId + '/events'),
            fetch('/api/reviews/' + prId + '/outputs'),
            fetch('/api/reviews/' + prId + '/progress')
          ]);
          var events = await evRes.json();
          var outputs = await outRes.json();
          var prInfo = await prRes.json();

          // Action bar
          var html = '<div class="detail-actions">';
          if (prInfo.status === 'notified' || prInfo.status === 'detected') {
            html += '<button class="btn btn-ghost btn-sm" onclick="dismissReview(' + prId + ', this)">Dismiss</button>';
          }
          if (prInfo.session_id && (prInfo.status === 'accepted' || prInfo.status === 'cloning' || prInfo.status === 'reviewing')) {
            html += '<button class="btn btn-ghost btn-sm" onclick="copyAttach(' + prId + ', \\'' + prInfo.session_id + '\\', this)">Copy attach command</button>';
          }
          html += '</div>';

          html += '<div class="detail-section-title">Events</div>';
          if (events.length === 0) html += '<div class="text-muted text-sm">No events</div>';
          else events.forEach(function(e) {
            html += '<div class="event-item"><span class="event-time">' + e.created_at + '</span><span class="event-type">' + e.event_type + '</span>' + (e.message ? '<span class="event-msg"> \\u2014 ' + e.message + '</span>' : '') + '</div>';
          });
          html += '<div class="detail-section-title">Tool Outputs</div>';
          if (outputs.length === 0) html += '<div class="text-muted text-sm">No outputs</div>';
          else outputs.forEach(function(o) {
            var exitColor = o.exit_code === 0 ? 'var(--success)' : o.exit_code != null ? 'var(--error)' : 'var(--text-muted)';
            html += '<div class="output-block"><div class="output-header"><span>' + o.tool_name + '</span><span class="output-meta">exit: <span style="color:' + exitColor + '">' + (o.exit_code != null ? o.exit_code : '\\u2014') + '</span> \\u00b7 ' + (o.duration_ms ? (o.duration_ms / 1000).toFixed(1) + 's' : '\\u2014') + '</span></div><div class="output-text">' + (o.output ? o.output.replace(/</g,'&lt;').replace(/>/g,'&gt;') : 'No output') + '</div></div>';
          });
          content.innerHTML = html;
        } catch(e) { content.innerHTML = '<div class="text-muted">Failed to load details</div>'; }
      } else {
        row.style.display = 'none';
        if (btn) btn.querySelector('svg').style.transform = '';
      }
    }

    // ── Chat ──
    function addChatMsg(role, text) {
      var welcome = document.getElementById('chat-welcome');
      if (welcome) welcome.remove();
      var container = document.getElementById('chat-messages');
      var div = document.createElement('div');
      if (role === 'user') {
        div.className = 'chat-msg chat-msg-user';
        div.textContent = text;
      } else if (role === 'assistant') {
        div.className = 'chat-msg chat-msg-assistant';
        var html = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        html = html.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>');
        html = html.replace(/\`([^\`]+)\`/g, '<code>$1</code>');
        html = html.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
        div.innerHTML = html;
      } else {
        div.className = 'chat-msg chat-msg-system';
        div.textContent = text;
      }
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return div;
    }

    function showThinking() {
      var welcome = document.getElementById('chat-welcome');
      if (welcome) welcome.remove();
      var container = document.getElementById('chat-messages');
      var div = document.createElement('div');
      div.className = 'chat-thinking';
      div.id = 'chat-thinking';
      div.innerHTML = '<span class="spinner"></span> Thinking...';
      container.appendChild(div);
      container.scrollTop = container.scrollHeight;
      return div;
    }

    function removeThinking() {
      var el = document.getElementById('chat-thinking');
      if (el) el.remove();
    }

    async function sendChat() {
      var input = document.getElementById('chat-input');
      var text = input.value.trim();
      if (!text) return;
      input.value = '';
      document.getElementById('chat-send-btn').disabled = true;

      addChatMsg('user', text);
      chatHistory.push({ role: 'user', content: text });
      showThinking();

      try {
        var res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: chatHistory })
        });
        removeThinking();
        var data = await res.json();
        if (data.ok) {
          addChatMsg('assistant', data.response);
          chatHistory.push({ role: 'assistant', content: data.response });
          // Handle actions
          if (data.actions && data.actions.length > 0) {
            data.actions.forEach(function(a) {
              if (!a.result.startsWith('Error')) {
                showToast(a.result);
              }
            });
            // Reload settings if on settings tab
            settingsLoaded = false;
            var settingsTab = document.getElementById('tab-settings');
            if (settingsTab && settingsTab.classList.contains('active')) {
              loadSettings();
            }
          }
        } else {
          addChatMsg('system', 'Error: ' + (data.error || 'Unknown error'));
        }
      } catch(e) {
        removeThinking();
        addChatMsg('system', 'Failed to connect to chat service');
      }
      document.getElementById('chat-send-btn').disabled = false;
      document.getElementById('chat-input').focus();
    }

    function askSuggestion(btn) {
      document.getElementById('chat-input').value = btn.textContent;
      sendChat();
    }

    function clearChat() {
      chatHistory = [];
      var container = document.getElementById('chat-messages');
      container.innerHTML = '<div class="chat-welcome" id="chat-welcome">'
        + '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="opacity:0.3;margin-bottom:12px"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>'
        + '<h3>Review Assistant</h3>'
        + '<p>Ask questions about your code reviews, get summaries, or analyze patterns.</p>'
        + '<div class="chat-suggestions">'
        + '<button class="chat-suggestion" onclick="askSuggestion(this)">Summarize recent reviews</button>'
        + '<button class="chat-suggestion" onclick="askSuggestion(this)">Show current config</button>'
        + '<button class="chat-suggestion" onclick="askSuggestion(this)">Improve the system prompt</button>'
        + '</div></div>';
    }

    // ── SSE live updates (single connection, clean up on page hide) ──
    var sseSource = null;
    function connectSSE() {
      if (sseSource) return;
      sseSource = new EventSource('/api/sse');
      sseSource.addEventListener('pr-update', function() {
        fetchPage(currentPage);
        fetch('/api/reviews/page?status=' + activeStatuses.join(',') + '&size=1&page=1')
          .then(function(r) { return r.json(); })
          .then(function(d) {
            var badge = document.getElementById('active-count');
            if (badge) badge.textContent = d.totalItems;
          }).catch(function(){});
        updateSectionCounts();
        if (analyticsLoaded) loadAnalytics();
      });
    }
    function disconnectSSE() {
      if (sseSource) { sseSource.close(); sseSource = null; }
    }
    connectSSE();
    document.addEventListener('visibilitychange', function() {
      if (document.hidden) disconnectSSE(); else connectSSE();
    });
    window.addEventListener('beforeunload', disconnectSSE);

    // ── Settings ──
    function showToast(msg, type) {
      var existing = document.querySelector('.toast');
      if (existing) existing.remove();
      var el = document.createElement('div');
      el.className = 'toast ' + (type || 'success');
      el.textContent = msg;
      document.body.appendChild(el);
      setTimeout(function() { el.remove(); }, 3000);
    }

    function toggleSettingsSection(el) {
      el.closest('.settings-section').classList.toggle('open');
    }

    function toggleRepoCard(el) {
      el.closest('.repo-card').classList.toggle('open');
    }

    async function loadSettings() {
      try {
        var res = await fetch('/api/settings');
        settingsData = await res.json();
        renderSettings();
      } catch(e) {
        document.getElementById('settings-content').innerHTML = '<div style="text-align:center;padding:48px;color:var(--text-muted)">Failed to load settings</div>';
      }
    }

    function renderSettings() {
      var d = settingsData;
      if (!d) return;
      var c = d.config;
      var html = '';

      // Section 1: Global Settings
      html += '<div class="settings-section open">';
      html += '<div class="settings-section-header" onclick="toggleSettingsSection(this)"><svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg> Global Settings</div>';
      html += '<div class="settings-section-body">';
      html += '<div class="settings-grid">';
      html += '<div class="settings-field"><label>Poll Interval</label><input type="text" id="s-poll-interval" value="' + esc(c.github.poll_interval) + '"><div class="hint">e.g. 60s, 5m</div></div>';
      html += '<div class="settings-field"><label>Max Parallel Reviews</label><input type="number" id="s-max-parallel" value="' + c.launchers.max_parallel + '" min="1" max="10"></div>';
      html += '<div class="settings-field"><label>Dashboard Port</label><input type="number" id="s-dashboard-port" value="' + c.dashboard.port + '"></div>';
      html += '<div class="settings-field"><label>Notifications</label>';
      html += '<label class="settings-check"><input type="checkbox" id="s-notif-native" ' + (c.notifications.native ? 'checked' : '') + '><span>Native notifications</span></label>';
      html += '<label class="settings-check"><input type="checkbox" id="s-notif-new-pr" ' + (c.notifications.on_new_pr ? 'checked' : '') + '><span>On new PR</span></label>';
      html += '<label class="settings-check"><input type="checkbox" id="s-notif-complete" ' + (c.notifications.on_review_complete ? 'checked' : '') + '><span>On review complete</span></label>';
      html += '<label class="settings-check"><input type="checkbox" id="s-notif-error" ' + (c.notifications.on_review_error ? 'checked' : '') + '><span>On review error</span></label>';
      html += '</div>';
      html += '<div class="settings-field full-width"><label>Watched Repos</label><textarea id="s-watched-repos" rows="3">' + esc((c.github.watched_repos || []).join('\\n')) + '</textarea><div class="hint">One repo per line (owner/repo)</div></div>';
      html += '<div class="settings-field full-width"><label>Ignored Repos</label><textarea id="s-ignored-repos" rows="3">' + esc((c.github.ignored_repos || []).join('\\n')) + '</textarea><div class="hint">One repo per line (owner/repo)</div></div>';
      html += '</div>';
      html += '<div class="settings-actions"><button class="btn btn-primary btn-sm" onclick="saveGlobalSettings()">Save Global Settings</button></div>';
      html += '</div></div>';

      // Section 2: Prompts (merged with file browser)
      html += '<div class="settings-section">';
      html += '<div class="settings-section-header" onclick="toggleSettingsSection(this)"><svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg> Prompts</div>';
      html += '<div class="settings-section-body">';

      // Config fields
      html += '<div class="settings-grid">';
      html += '<div class="settings-field"><label>System Prompt File</label><input type="text" id="s-system-prompt-path" value="' + esc(c.prompts.system_prompt || '') + '"><div class="hint">Path to system prompt .md file</div></div>';
      html += '<div class="settings-field"><label>Instructions File</label><input type="text" id="s-instructions-path" value="' + esc(c.prompts.instructions || '') + '"><div class="hint">Path to instructions .md file</div></div>';
      html += '</div>';

      // Techniques
      html += '<div class="settings-field full-width" style="margin-top:12px"><label>Techniques</label>';
      var techKeys = Object.keys(c.prompts.techniques || {});
      html += '<div id="techniques-list">';
      techKeys.forEach(function(key) {
        var t = c.prompts.techniques[key];
        html += renderTechniqueRow(key, t.description || '', t.prompt_file || '');
      });
      html += '</div>';
      html += '<button class="btn btn-ghost btn-sm" onclick="addTechnique()" style="margin-top:8px">+ Add Technique</button>';
      html += '</div>';

      html += '<div class="settings-actions" style="border-top:none;margin-top:8px;padding-top:0"><button class="btn btn-primary btn-sm" onclick="savePromptConfig()">Save Config</button></div>';

      // Two-panel layout: file tree + editor
      html += '<div class="prompts-layout">';
      // Left: file tree
      html += '<div class="prompts-tree">';
      html += '<div id="prompt-file-tree"></div>';
      html += '<div style="margin-top:10px;display:flex;gap:6px"><input type="text" id="new-prompt-file" placeholder="path/file.md" style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:var(--font);font-size:12px;padding:6px 8px"><button class="btn btn-ghost btn-sm" onclick="createPromptFile()">New</button></div>';
      html += '</div>';
      // Right: editor
      html += '<div class="prompts-editor">';
      html += '<div id="prompt-editor-label" style="font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:8px">Select a file to edit</div>';
      html += '<textarea class="prompt-editor" id="prompt-file-editor" style="flex:1" disabled placeholder="Select a file from the left panel..."></textarea>';
      html += '<div style="display:flex;gap:8px;margin-top:8px"><button class="btn btn-primary btn-sm" id="save-prompt-btn" onclick="savePromptFile()" disabled>Save File</button><button class="btn btn-danger btn-sm" id="delete-prompt-btn" onclick="deletePromptFile()" disabled>Delete File</button></div>';
      html += '</div>';
      html += '</div>'; // end prompts-layout

      html += '</div></div>';

      // Section 3: Repository Overrides
      html += '<div class="settings-section">';
      html += '<div class="settings-section-header" onclick="toggleSettingsSection(this)"><svg class="chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg> Repository Overrides</div>';
      html += '<div class="settings-section-body">';
      var repoKeys = Object.keys(c.repos || {});
      html += '<div id="repo-list">';
      repoKeys.forEach(function(pattern) {
        html += renderRepoCard(pattern, c.repos[pattern]);
      });
      html += '</div>';
      html += '<div style="display:flex;gap:8px;margin-top:12px"><input type="text" id="new-repo-pattern" placeholder="owner/repo or glob pattern" style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm);color:var(--text);font-family:var(--font);font-size:13px;padding:8px 10px"><button class="btn btn-ghost btn-sm" onclick="addRepo()">Add Repository</button></div>';
      html += '<div class="hint" style="margin-top:4px">Supports glob patterns: * matches all, org/* matches org repos</div>';
      html += '<div class="settings-actions"><button class="btn btn-primary btn-sm" onclick="saveRepos()">Save Repository Overrides</button></div>';
      html += '</div></div>';

      document.getElementById('settings-content').innerHTML = html;
      renderFileTree(d.promptFiles || []);
    }

    function esc(s) {
      if (s == null) return '';
      return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    function renderTechniqueRow(name, description, promptFile) {
      return '<div class="technique-row"><input type="text" value="' + esc(name) + '" placeholder="name" class="tech-name"><input type="text" value="' + esc(description) + '" placeholder="description" class="tech-desc"><input type="text" value="' + esc(promptFile) + '" placeholder="prompt file path" class="tech-file"><button class="btn btn-danger btn-sm" onclick="this.closest(\\'.technique-row\\').remove()">x</button></div>';
    }

    function addTechnique() {
      var list = document.getElementById('techniques-list');
      list.insertAdjacentHTML('beforeend', renderTechniqueRow('', '', ''));
    }

    function renderFileTree(files) {
      var container = document.getElementById('prompt-file-tree');
      if (!container) return;
      // Group by directory
      var folders = {};
      var rootFiles = [];
      files.forEach(function(f) {
        var idx = f.indexOf('/');
        if (idx === -1) {
          rootFiles.push(f);
        } else {
          var dir = f.substring(0, idx);
          if (!folders[dir]) folders[dir] = [];
          folders[dir].push(f);
        }
      });
      var html = '';
      var fileIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/></svg>';
      var folderIcon = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z"/></svg>';
      var chevronSvg = '<svg class="folder-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 9l6 6 6-6"/></svg>';
      // Root files first
      rootFiles.forEach(function(f) {
        html += '<div class="prompt-file-item" data-path="' + esc(f) + '" onclick="loadPromptFile(\\'' + esc(f) + '\\', this)">' + fileIcon + ' ' + esc(f) + '</div>';
      });
      // Folder groups
      Object.keys(folders).sort().forEach(function(dir) {
        html += '<div class="folder-group">';
        html += '<div class="folder-header" onclick="toggleFolder(this)">' + chevronSvg + ' ' + folderIcon + ' ' + esc(dir) + '/</div>';
        html += '<div class="folder-files">';
        folders[dir].forEach(function(f) {
          var name = f.substring(f.indexOf('/') + 1);
          html += '<div class="prompt-file-item indented" data-path="' + esc(f) + '" onclick="loadPromptFile(\\'' + esc(f) + '\\', this)">' + fileIcon + ' ' + esc(name) + '</div>';
        });
        html += '</div></div>';
      });
      container.innerHTML = html;
    }

    function toggleFolder(el) {
      el.classList.toggle('collapsed');
      var files = el.nextElementSibling;
      if (files) files.classList.toggle('collapsed');
    }

    async function savePromptConfig() {
      var c = settingsData.config;
      c.prompts.system_prompt = document.getElementById('s-system-prompt-path').value.trim();
      c.prompts.instructions = document.getElementById('s-instructions-path').value.trim();
      var techniques = {};
      var defaultTechniques = [];
      document.querySelectorAll('.technique-row').forEach(function(row) {
        var name = row.querySelector('.tech-name').value.trim();
        var desc = row.querySelector('.tech-desc').value.trim();
        var file = row.querySelector('.tech-file').value.trim();
        if (name) {
          techniques[name] = { description: desc, prompt_file: file };
          defaultTechniques.push(name);
        }
      });
      c.prompts.techniques = techniques;
      c.prompts.default_techniques = defaultTechniques;
      try {
        var res = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(c) });
        var data = await res.json();
        if (data.ok) { showToast('Prompt config saved'); } else { showToast(data.error || 'Save failed', 'error'); }
      } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
    }

    function renderRepoCard(pattern, cfg) {
      var html = '<div class="repo-card" data-pattern="' + esc(pattern) + '">';
      html += '<div class="repo-card-header" onclick="toggleRepoCard(this)"><code>' + esc(pattern) + '</code><svg class="chevron" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 18l6-6-6-6"/></svg></div>';
      html += '<div class="repo-card-body">';
      html += '<label class="settings-check" style="margin-bottom:10px"><input type="checkbox" class="repo-auto-review" ' + (cfg.auto_review ? 'checked' : '') + '><span>Auto-review PRs</span></label>';
      if (cfg.prompts) {
        html += '<div class="settings-field"><label>System Prompt Override</label><input type="text" class="repo-system-prompt" value="' + esc(cfg.prompts.system_prompt || '') + '"></div>';
        html += '<div class="settings-field"><label>Instructions Override</label><input type="text" class="repo-instructions" value="' + esc(cfg.prompts.instructions || '') + '"></div>';
      } else {
        html += '<div class="settings-field"><label>System Prompt Override</label><input type="text" class="repo-system-prompt" value=""></div>';
        html += '<div class="settings-field"><label>Instructions Override</label><input type="text" class="repo-instructions" value=""></div>';
      }
      html += '<button class="btn btn-danger btn-sm" onclick="removeRepo(this)" style="margin-top:10px">Remove</button>';
      html += '</div></div>';
      return html;
    }

    function addRepo() {
      var input = document.getElementById('new-repo-pattern');
      var pattern = input.value.trim();
      if (!pattern) return;
      var list = document.getElementById('repo-list');
      list.insertAdjacentHTML('beforeend', renderRepoCard(pattern, {}));
      input.value = '';
    }

    function removeRepo(btn) {
      btn.closest('.repo-card').remove();
    }

    async function saveGlobalSettings() {
      var c = settingsData.config;
      c.github.poll_interval = document.getElementById('s-poll-interval').value;
      c.launchers.max_parallel = parseInt(document.getElementById('s-max-parallel').value, 10) || 3;
      c.dashboard.port = parseInt(document.getElementById('s-dashboard-port').value, 10) || 1460;
      c.notifications.native = document.getElementById('s-notif-native').checked;
      c.notifications.on_new_pr = document.getElementById('s-notif-new-pr').checked;
      c.notifications.on_review_complete = document.getElementById('s-notif-complete').checked;
      c.notifications.on_review_error = document.getElementById('s-notif-error').checked;
      c.github.watched_repos = document.getElementById('s-watched-repos').value.split('\\n').map(function(s) { return s.trim(); }).filter(Boolean);
      c.github.ignored_repos = document.getElementById('s-ignored-repos').value.split('\\n').map(function(s) { return s.trim(); }).filter(Boolean);
      try {
        var res = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(c) });
        var data = await res.json();
        if (data.ok) { showToast('Global settings saved'); } else { showToast(data.error || 'Save failed', 'error'); }
      } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
    }

    // savePrompts is now split into savePromptConfig (config) and savePromptFile (file content)

    async function saveRepos() {
      var repos = {};
      document.querySelectorAll('.repo-card').forEach(function(card) {
        var pattern = card.getAttribute('data-pattern');
        var autoReview = card.querySelector('.repo-auto-review').checked;
        var systemPrompt = card.querySelector('.repo-system-prompt').value.trim();
        var instructions = card.querySelector('.repo-instructions').value.trim();
        var cfg = { auto_review: autoReview };
        if (systemPrompt || instructions) {
          cfg.prompts = {};
          if (systemPrompt) cfg.prompts.system_prompt = systemPrompt;
          if (instructions) cfg.prompts.instructions = instructions;
        }
        repos[pattern] = cfg;
      });
      settingsData.config.repos = repos;
      try {
        var res = await fetch('/api/settings', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(settingsData.config) });
        var data = await res.json();
        if (data.ok) { showToast('Repository overrides saved'); } else { showToast(data.error || 'Save failed', 'error'); }
      } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
    }

    var currentPromptFile = null;
    async function loadPromptFile(path, el) {
      document.querySelectorAll('.prompt-file-item').forEach(function(i) { i.classList.remove('active'); });
      if (el) el.classList.add('active');
      currentPromptFile = path;
      document.getElementById('prompt-editor-label').textContent = path;
      document.getElementById('prompt-file-editor').disabled = false;
      document.getElementById('save-prompt-btn').disabled = false;
      document.getElementById('delete-prompt-btn').disabled = false;
      try {
        var res = await fetch('/api/settings/prompts/' + encodeURIComponent(path));
        var data = await res.json();
        document.getElementById('prompt-file-editor').value = data.content || '';
      } catch(e) {
        document.getElementById('prompt-file-editor').value = '';
      }
    }

    async function savePromptFile() {
      if (!currentPromptFile) return;
      var content = document.getElementById('prompt-file-editor').value;
      try {
        var res = await fetch('/api/settings/prompts/' + encodeURIComponent(currentPromptFile), { method: 'POST', headers: {'Content-Type':'text/plain'}, body: content });
        var data = await res.json();
        if (data.ok) { showToast('File saved'); } else { showToast(data.error || 'Save failed', 'error'); }
      } catch(e) { showToast('Save failed: ' + e.message, 'error'); }
    }

    async function deletePromptFile() {
      if (!currentPromptFile) return;
      if (!confirm('Delete ' + currentPromptFile + '?')) return;
      try {
        var res = await fetch('/api/settings/prompts/' + encodeURIComponent(currentPromptFile), { method: 'DELETE' });
        var data = await res.json();
        if (data.ok) {
          showToast('File deleted');
          currentPromptFile = null;
          document.getElementById('prompt-editor-label').textContent = 'Select a file to edit';
          document.getElementById('prompt-file-editor').value = '';
          document.getElementById('prompt-file-editor').disabled = true;
          document.getElementById('save-prompt-btn').disabled = true;
          document.getElementById('delete-prompt-btn').disabled = true;
          // Refresh file list
          settingsLoaded = false;
          loadSettings();
        } else { showToast(data.error || 'Delete failed', 'error'); }
      } catch(e) { showToast('Delete failed: ' + e.message, 'error'); }
    }

    async function createPromptFile() {
      var input = document.getElementById('new-prompt-file');
      var path = input.value.trim();
      if (!path) return;
      if (!path.endsWith('.md')) path += '.md';
      try {
        var res = await fetch('/api/settings/prompts/' + encodeURIComponent(path), { method: 'POST', headers: {'Content-Type':'text/plain'}, body: '' });
        var data = await res.json();
        if (data.ok) {
          showToast('File created');
          input.value = '';
          settingsLoaded = false;
          loadSettings();
        } else { showToast(data.error || 'Create failed', 'error'); }
      } catch(e) { showToast('Create failed: ' + e.message, 'error'); }
    }

  </script>
</body>
</html>`;
}

// ── Server ─────────────────────────────────────────────────────────────────

export function createDashboardServer(
  db: Database,
  config: AppConfig
): DashboardServer {
  let currentConfig = config;
  const queries = createQueries(db);
  let lastUpdatedMap = new Map<number, string>();
  const sseClients = new Set<ReadableStreamDefaultController>();

  function getPromptsDir(): string {
    return join(getConfigDir(), "prompts");
  }

  function listPromptFiles(dir: string, base?: string): string[] {
    const result: string[] = [];
    if (!existsSync(dir)) return result;
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = base ? base + "/" + entry.name : entry.name;
      if (entry.isDirectory()) {
        result.push(...listPromptFiles(join(dir, entry.name), rel));
      } else if (entry.name.endsWith(".md")) {
        result.push(rel);
      }
    }
    return result.sort();
  }

  function isPathSafe(promptsDir: string, filePath: string): boolean {
    const resolved = resolve(promptsDir, filePath);
    return resolved.startsWith(resolve(promptsDir) + "/") || resolved === resolve(promptsDir);
  }

  function getUpdatedMap(prs: PRReview[]): Map<number, string> {
    const m = new Map<number, string>();
    for (const pr of prs) m.set(pr.id, pr.updated_at);
    return m;
  }

  function hasChanges(current: Map<number, string>, previous: Map<number, string>): boolean {
    if (current.size !== previous.size) return true;
    for (const [id, ts] of current) {
      if (previous.get(id) !== ts) return true;
    }
    return false;
  }

  // SSE poll — send lightweight signal so client re-fetches with its filters
  const sseInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      const prs = db.transaction(() => queries.getAllPRs())();
      const currentMap = getUpdatedMap(prs);
      if (hasChanges(currentMap, lastUpdatedMap)) {
        lastUpdatedMap = currentMap;
        const data = `event: pr-update\ndata: refresh\n\n`;
        for (const controller of sseClients) {
          try {
            controller.enqueue(new TextEncoder().encode(data));
          } catch {
            sseClients.delete(controller);
          }
        }
      }
    } catch {}
  }, 2000);

  function buildStatsResponse() {
    const stats = computeStats(queries);
    const allPRs = queries.getAllPRs();
    const now = new Date();
    const todayStr = now.toISOString().slice(0, 10);
    const weekAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
    const todayCount = allPRs.filter((p) => p.created_at >= todayStr).length;
    const weekCount = allPRs.filter((p) => p.created_at >= weekAgo).length;
    return {
      totalReviews: stats.totalReviews,
      statusBreakdown: stats.statusCounts,
      successRate: stats.successRate,
      doneCount: stats.doneCount,
      errorCount: stats.errorCount,
      avgDuration: stats.avgDurationStr,
      todayCount,
      weekCount,
    };
  }

  function buildFindingsResponse() {
    const stats = computeStats(queries);
    const allPRs = queries.getAllPRs();
    const doneCount = allPRs.filter((p) => p.status === "done").length;
    const totalCompleted = allPRs.filter((p) => p.status === "done" || p.status === "error").length;
    const approvalRate = totalCompleted > 0 ? Math.round((doneCount / totalCompleted) * 100) : 0;
    return {
      total: stats.totalFindings,
      critical: stats.criticalCount,
      warning: stats.warningCount,
      suggestion: stats.suggestionCount,
      approvalRate,
    };
  }

  // Build system prompt for chat with review context + settings awareness
  function buildChatSystemPrompt(): string {
    const allPRs = queries.getAllPRs();
    const stats = computeStats(queries);
    const repoStats = queries.getRepoStats();
    const toolStats = queries.getToolStats();

    const prSummaries = allPRs.slice(0, 30).map((pr) => {
      return `- ${pr.repo}#${pr.pr_number}: "${pr.title}" by @${pr.author} [${pr.status}] (${pr.created_at})`;
    }).join("\n");

    const repoSummaries = repoStats.map((r) => {
      return `- ${r.repo}: ${r.total} reviews, ${r.success} success, ${r.error} errors`;
    }).join("\n");

    const toolSummaries = toolStats.map((t) => {
      return `- ${t.tool_name}: ${t.total} runs, ${t.success} success, avg ${(t.avg_duration_ms / 1000).toFixed(1)}s`;
    }).join("\n");

    // Settings context
    const cfg = currentConfig;
    const repoOverrides = Object.keys(cfg.repos || {}).map((pattern) => {
      const r = cfg.repos[pattern];
      return `- ${pattern}: auto_review=${r.auto_review ?? false}${r.prompts?.system_prompt ? ', system_prompt=' + r.prompts.system_prompt : ''}${r.prompts?.instructions ? ', instructions=' + r.prompts.instructions : ''}`;
    }).join("\n");

    const promptFiles = listPromptFiles(getPromptsDir());
    const promptFilesList = promptFiles.map(f => `- ${f}`).join("\n");

    const techList = Object.keys(cfg.prompts.techniques || {}).map((k) => {
      const t = cfg.prompts.techniques[k];
      return `- ${k}: ${t.description || '(no description)'} -> ${t.prompt_file || '(no file)'}`;
    }).join("\n");

    return `You are an AI assistant embedded in "iago", a code review automation tool. You help users understand their review history and also modify iago settings.

REVIEW STATISTICS:
- Total reviews: ${stats.totalReviews}
- Success rate: ${stats.successRate}%
- Done: ${stats.doneCount}, Errors: ${stats.errorCount}
- Avg completion time: ${stats.avgDurationStr}
- Findings: ${stats.totalFindings} total (${stats.criticalCount} critical, ${stats.warningCount} warnings, ${stats.suggestionCount} suggestions)

RECENT REVIEWS (up to 30):
${prSummaries || "No reviews yet."}

REPOSITORY STATS:
${repoSummaries || "No repository data."}

TOOL STATS:
${toolSummaries || "No tool data."}

CURRENT CONFIG:
- Poll interval: ${cfg.github.poll_interval}
- Max parallel: ${cfg.launchers.max_parallel}
- Dashboard port: ${cfg.dashboard.port}
- System prompt file: ${cfg.prompts.system_prompt || '(not set)'}
- Instructions file: ${cfg.prompts.instructions || '(not set)'}
- Notifications: native=${cfg.notifications.native}, on_new_pr=${cfg.notifications.on_new_pr}, on_review_complete=${cfg.notifications.on_review_complete}, on_review_error=${cfg.notifications.on_review_error}
- Watched repos: ${(cfg.github.watched_repos || []).join(', ') || '(none)'}
- Ignored repos: ${(cfg.github.ignored_repos || []).join(', ') || '(none)'}

REPOSITORY OVERRIDES:
${repoOverrides || "No overrides configured."}

TECHNIQUES:
${techList || "No techniques configured."}

PROMPT FILES (in ~/.config/iago/prompts/):
${promptFilesList || "No prompt files."}

SETTINGS ACTIONS:
You can modify iago settings by including action blocks in your response.
Wrap each action in a \`\`\`iago-action JSON block:

To update the full config (merges with existing):
\`\`\`iago-action
{"action": "save_config", "config": {"github": {"poll_interval": "2m"}}}
\`\`\`

To update a prompt file:
\`\`\`iago-action
{"action": "save_prompt", "file": "system.md", "content": "...new content..."}
\`\`\`

To create a new prompt file:
\`\`\`iago-action
{"action": "create_prompt", "file": "myrepo/system.md", "content": "..."}
\`\`\`

To add or update a repo override:
\`\`\`iago-action
{"action": "add_repo", "pattern": "owner/repo", "config": {"auto_review": true}}
\`\`\`

RULES:
1. Answer questions about review history, patterns, and statistics
2. Be concise but thorough
3. When asked for summaries, organize by repo or status
4. Point out notable patterns (recurring errors, slow reviews, etc.)
5. Format responses with markdown (bold, code, lists)
6. If asked about a specific PR, reference its details from the data above
7. When asked to change settings, emit the appropriate iago-action blocks
8. When modifying prompt files, always provide the FULL content (not partial)
9. Always explain what you changed after emitting action blocks`;
  }

  // Execute a settings action from chat
  function executeSettingsAction(actionData: any): string {
    try {
      switch (actionData.action) {
        case "save_config": {
          // Merge partial config into current config
          const partial = actionData.config;
          if (!partial || typeof partial !== "object") return "Error: missing config object";
          const merged = { ...currentConfig };
          for (const [key, val] of Object.entries(partial)) {
            if (typeof val === "object" && val !== null && !Array.isArray(val) && typeof (merged as any)[key] === "object") {
              (merged as any)[key] = { ...(merged as any)[key], ...val };
            } else {
              (merged as any)[key] = val;
            }
          }
          saveConfig(merged as AppConfig);
          currentConfig = loadConfig();
          return "Updated config: " + Object.keys(partial).join(", ");
        }
        case "save_prompt":
        case "create_prompt": {
          const filePath = actionData.file;
          const content = actionData.content;
          if (!filePath || typeof filePath !== "string") return "Error: missing file path";
          if (content == null) return "Error: missing content";
          const promptsDir = getPromptsDir();
          if (!isPathSafe(promptsDir, filePath)) return "Error: invalid path";
          const fullPath = resolve(promptsDir, filePath);
          const dir = join(fullPath, "..");
          if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
          writeFileSync(fullPath, content, "utf-8");
          return (actionData.action === "create_prompt" ? "Created " : "Updated ") + filePath;
        }
        case "add_repo": {
          const pattern = actionData.pattern;
          const repoCfg = actionData.config;
          if (!pattern || typeof pattern !== "string") return "Error: missing pattern";
          if (!currentConfig.repos) currentConfig.repos = {};
          currentConfig.repos[pattern] = { ...currentConfig.repos[pattern], ...repoCfg };
          saveConfig(currentConfig);
          currentConfig = loadConfig();
          return "Updated repo override: " + pattern;
        }
        default:
          return "Error: unknown action: " + actionData.action;
      }
    } catch (e: any) {
      return "Error: " + e.message;
    }
  }

  const server = Bun.serve({
    port: config.dashboard.port,
    idleTimeout: 255, // max value — prevents SSE connections from being killed
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const path = url.pathname;

        // GET / — HTML page
        if (path === "/" && req.method === "GET") {
          const allPRs = queries.getAllPRs();
          lastUpdatedMap = getUpdatedMap(allPRs);
          return new Response(renderHTML(allPRs, queries), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // GET /api/reviews
        if (path === "/api/reviews" && req.method === "GET") {
          return Response.json(db.transaction(() => queries.getAllPRs())());
        }

        // GET /api/reviews/page — supports comma-separated status and github_state filters
        if (path === "/api/reviews/page" && req.method === "GET") {
          const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
          const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get("size") || String(PAGE_SIZE), 10)));
          const statusParam = url.searchParams.get("status") || "";
          const ghParam = url.searchParams.get("github_state") || "";

          // Parse comma-separated values
          const statusFilters = statusParam ? statusParam.split(",").filter(Boolean) : [];
          const ghFilters = ghParam ? ghParam.split(",").filter(Boolean) : [];

          // Filter in-memory for multi-select
          const allPRs = db.transaction(() => queries.getAllPRs())();
          let filtered = allPRs;
          if (statusFilters.length > 0) {
            filtered = filtered.filter((pr) => statusFilters.includes(pr.status));
          }
          if (ghFilters.length > 0) {
            filtered = filtered.filter((pr) => ghFilters.includes(pr.github_state));
          }

          // Sort
          const sort = url.searchParams.get("sort") || "";
          if (sort === "opened_at") {
            filtered.sort((a, b) => {
              const aDate = a.opened_at ? new Date(a.opened_at).getTime() : 0;
              const bDate = b.opened_at ? new Date(b.opened_at).getTime() : 0;
              return bDate - aDate;
            });
          }

          const totalPages = Math.max(1, Math.ceil(filtered.length / size));
          const offset = (page - 1) * size;
          const pagePRs = filtered.slice(offset, offset + size);
          return Response.json({ html: renderPRRows(pagePRs), page, totalPages, totalItems: filtered.length });
        }

        // GET /api/reviews/:id/events
        const eventsMatch = path.match(/^\/api\/reviews\/(\d+)\/events$/);
        if (eventsMatch && req.method === "GET") {
          return Response.json(queries.getEvents(parseInt(eventsMatch[1]!, 10)));
        }

        // GET /api/reviews/:id/outputs
        const outputsMatch = path.match(/^\/api\/reviews\/(\d+)\/outputs$/);
        if (outputsMatch && req.method === "GET") {
          return Response.json(queries.getOutputs(parseInt(outputsMatch[1]!, 10)));
        }

        // POST /api/reviews/:id/retry
        const retryMatch = path.match(/^\/api\/reviews\/(\d+)\/retry$/);
        if (retryMatch && req.method === "POST") {
          const id = parseInt(retryMatch[1]!, 10);
          const pr = queries.getPR(id);
          if (!pr) return Response.json({ error: "PR not found" }, { status: 404 });
          if (!pr.url) return Response.json({ error: "PR has no URL" }, { status: 400 });
          queries.updatePRStatus(pr.id, "accepted");
          queries.insertEvent(pr.id, "accepted", "Review launched from dashboard");
          // Use the same entry point that started us — works for both compiled binary and bun run
          const selfCmd = getSelfCommand();
          Bun.spawn([...selfCmd, "review", pr.url, "--force"], {
            stdout: "ignore",
            stderr: "ignore",
          });
          return Response.json({ ok: true, status: "launched" });
        }

        // POST /api/reviews/:id/cancel — kill in-progress review
        const cancelMatch = path.match(/^\/api\/reviews\/(\d+)\/cancel$/);
        if (cancelMatch && req.method === "POST") {
          const id = parseInt(cancelMatch[1]!, 10);
          const pr = queries.getPR(id);
          if (!pr) return Response.json({ error: "PR not found" }, { status: 404 });
          if (!["accepted", "cloning", "reviewing"].includes(pr.status)) {
            return Response.json({ error: "PR is not in progress" }, { status: 400 });
          }
          const killed = killProcess(id);
          queries.updatePRStatus(id, "error");
          queries.updatePRPid(id, null);
          queries.insertEvent(id, "cancelled", killed ? "Review cancelled from dashboard (process killed)" : "Review cancelled from dashboard");
          return Response.json({ ok: true, killed });
        }

        // POST /api/reviews/:id/dismiss — dismiss notified/detected review
        const dismissMatch = path.match(/^\/api\/reviews\/(\d+)\/dismiss$/);
        if (dismissMatch && req.method === "POST") {
          const id = parseInt(dismissMatch[1]!, 10);
          const pr = queries.getPR(id);
          if (!pr) return Response.json({ error: "PR not found" }, { status: 404 });
          if (!["notified", "detected"].includes(pr.status)) {
            return Response.json({ error: "PR cannot be dismissed from status: " + pr.status }, { status: 400 });
          }
          queries.updatePRStatus(id, "dismissed");
          queries.insertEvent(id, "dismissed", "Dismissed from dashboard");
          return Response.json({ ok: true });
        }

        // GET /api/reviews/:id/progress — live progress info
        const progressMatch = path.match(/^\/api\/reviews\/(\d+)\/progress$/);
        if (progressMatch && req.method === "GET") {
          const id = parseInt(progressMatch[1]!, 10);
          const pr = queries.getPR(id);
          if (!pr) return Response.json({ error: "PR not found" }, { status: 404 });
          const events = queries.getEvents(id);
          const lastEvent = events.length > 0 ? events[events.length - 1] : null;
          const processEntry = getProcess(id);
          const isAlive = !!processEntry;
          const elapsed = processEntry ? Math.round((Date.now() - processEntry.startedAt) / 1000) : null;
          return Response.json({
            status: pr.status,
            session_id: pr.session_id,
            pid: pr.pid,
            isAlive,
            elapsed,
            lastEvent: lastEvent ? { type: lastEvent.event_type, message: lastEvent.message, at: lastEvent.created_at } : null,
          });
        }

        // GET /api/stats
        if (path === "/api/stats" && req.method === "GET") {
          return Response.json(buildStatsResponse());
        }

        // GET /api/stats/tools
        if (path === "/api/stats/tools" && req.method === "GET") {
          return Response.json(queries.getToolStats());
        }

        // GET /api/stats/timeline
        if (path === "/api/stats/timeline" && req.method === "GET") {
          const period = (url.searchParams.get("period") || "day") as "day" | "week" | "month";
          return Response.json(queries.getReviewTimeline(period));
        }

        // GET /api/stats/repos
        if (path === "/api/stats/repos" && req.method === "GET") {
          return Response.json(queries.getRepoStats());
        }

        // GET /api/stats/findings
        if (path === "/api/stats/findings" && req.method === "GET") {
          return Response.json(buildFindingsResponse());
        }

        // POST /api/chat — Chat with Claude via CLI (settings-aware)
        if (path === "/api/chat" && req.method === "POST") {
          try {
            const body = await req.json() as { messages: { role: string; content: string }[] };
            const messages = body.messages || [];
            if (messages.length === 0) {
              return Response.json({ ok: false, error: "No messages" });
            }

            const systemPrompt = buildChatSystemPrompt();

            // Build conversation for claude CLI
            let conversationPrompt = systemPrompt + "\n\n";
            for (const msg of messages) {
              if (msg.role === "user") {
                conversationPrompt += `Human: ${msg.content}\n\n`;
              } else if (msg.role === "assistant") {
                conversationPrompt += `Assistant: ${msg.content}\n\n`;
              }
            }
            // Ensure it ends with the last user message as the prompt
            const lastUserMsg = messages.filter(m => m.role === "user").pop();
            if (!lastUserMsg) {
              return Response.json({ ok: false, error: "No user message" });
            }

            // Use claude CLI with user's OAuth session
            const proc = Bun.spawn(
              ["claude", "-p", conversationPrompt, "--output-format", "text"],
              {
                stdout: "pipe",
                stderr: "pipe",
                env: { ...process.env },
              }
            );

            const stdout = await new Response(proc.stdout).text();
            const stderr = await new Response(proc.stderr).text();
            const exitCode = await proc.exited;

            if (exitCode !== 0) {
              return Response.json({ ok: false, error: stderr || "Claude CLI failed" });
            }

            let responseText = stdout.trim();

            // Parse and execute iago-action blocks
            const actionRegex = /```iago-action\s*\n([\s\S]*?)\n```/g;
            const actions: { action: string; result: string }[] = [];
            let match;
            while ((match = actionRegex.exec(responseText)) !== null) {
              try {
                const actionData = JSON.parse(match[1]!);
                const result = executeSettingsAction(actionData);
                actions.push({ action: actionData.action, result });
              } catch (e: any) {
                actions.push({ action: "parse_error", result: e.message });
              }
            }

            // Strip action blocks from displayed response
            let cleanedText = responseText.replace(/```iago-action\s*\n[\s\S]*?\n```/g, "").trim();

            // Append action summary if any actions were taken
            if (actions.length > 0) {
              const successActions = actions.filter(a => !a.result.startsWith("Error"));
              if (successActions.length > 0) {
                cleanedText += "\n\n---\n" + successActions.map(a => "Applied: " + a.result).join("\n");
              }
              const failedActions = actions.filter(a => a.result.startsWith("Error"));
              if (failedActions.length > 0) {
                cleanedText += "\n" + failedActions.map(a => "Failed: " + a.result).join("\n");
              }
            }

            return Response.json({ ok: true, response: cleanedText, actions });
          } catch (err: any) {
            return Response.json({ ok: false, error: err.message });
          }
        }

        // GET /api/sse
        if (path === "/api/sse" && req.method === "GET") {
          let ctrl: ReadableStreamDefaultController;
          const stream = new ReadableStream({
            start(controller) {
              ctrl = controller;
              sseClients.add(controller);
              controller.enqueue(new TextEncoder().encode(":ok\n\n"));
            },
            cancel() {
              sseClients.delete(ctrl);
            },
          });
          return new Response(stream, {
            headers: {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            },
          });
        }

        // GET /api/settings — return config + prompt contents + prompt file list
        if (path === "/api/settings" && req.method === "GET") {
          const promptsDir = getPromptsDir();
          const promptFiles = listPromptFiles(promptsDir);
          const promptContents: Record<string, string> = {};

          // Read system prompt and instructions file contents
          if (currentConfig.prompts.system_prompt) {
            try {
              const p = resolveHome(currentConfig.prompts.system_prompt);
              if (existsSync(p)) promptContents.system_prompt = readFileSync(p, "utf-8");
            } catch {}
          }
          if (currentConfig.prompts.instructions) {
            try {
              const p = resolveHome(currentConfig.prompts.instructions);
              if (existsSync(p)) promptContents.instructions = readFileSync(p, "utf-8");
            } catch {}
          }

          return Response.json({
            config: currentConfig,
            promptFiles,
            promptContents,
          });
        }

        // POST /api/settings — save full config
        if (path === "/api/settings" && req.method === "POST") {
          try {
            const body = await req.json() as AppConfig;
            saveConfig(body);
            currentConfig = loadConfig();
            return Response.json({ ok: true });
          } catch (err: any) {
            return Response.json({ ok: false, error: err.message }, { status: 400 });
          }
        }

        // GET /api/settings/prompts — list prompt files
        if (path === "/api/settings/prompts" && req.method === "GET") {
          return Response.json(listPromptFiles(getPromptsDir()));
        }

        // /api/settings/prompts/:path — CRUD for prompt files
        const promptPathMatch = path.match(/^\/api\/settings\/prompts\/(.+)$/);
        if (promptPathMatch) {
          const filePath = decodeURIComponent(promptPathMatch[1]!);
          const promptsDir = getPromptsDir();
          if (!isPathSafe(promptsDir, filePath)) {
            return Response.json({ error: "Invalid path" }, { status: 400 });
          }
          const fullPath = resolve(promptsDir, filePath);

          if (req.method === "GET") {
            if (!existsSync(fullPath)) {
              return Response.json({ error: "File not found" }, { status: 404 });
            }
            return Response.json({ content: readFileSync(fullPath, "utf-8"), path: filePath });
          }

          if (req.method === "POST") {
            const dir = join(fullPath, "..");
            if (!existsSync(dir)) {
              mkdirSync(dir, { recursive: true });
            }
            const content = await req.text();
            writeFileSync(fullPath, content, "utf-8");
            return Response.json({ ok: true });
          }

          if (req.method === "DELETE") {
            if (!existsSync(fullPath)) {
              return Response.json({ error: "File not found" }, { status: 404 });
            }
            unlinkSync(fullPath);
            return Response.json({ ok: true });
          }
        }

        return new Response("Not Found", { status: 404 });
      } catch (err: any) {
        return new Response(`Internal Server Error: ${err.message}`, { status: 500 });
      }
    },
  });

  return {
    server,
    stop() {
      clearInterval(sseInterval);
      for (const controller of sseClients) {
        try { controller.close(); } catch {}
      }
      sseClients.clear();
      server.stop();
    },
  };
}
