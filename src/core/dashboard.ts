import type { Database } from "bun:sqlite";
import type { AppConfig } from "../types/index.js";
import type { Queries } from "../db/queries.js";
import { createQueries } from "../db/queries.js";
import type { PRReview } from "../types/index.js";

export interface DashboardServer {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
}

// ── Status colors ──────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  detected: "#71717a",
  notified: "#3b82f6",
  accepted: "#eab308",
  cloning: "#06b6d4",
  reviewing: "#f97316",
  done: "#22c55e",
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
  error: "Error",
  dismissed: "Dismissed",
};

// ── Helpers ────────────────────────────────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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

const RETRYABLE = new Set(["done", "error", "dismissed"]);
const IN_PROGRESS = new Set(["accepted", "cloning", "reviewing"]);
const PAGE_SIZE = 20;

// ── PR Row Rendering ───────────────────────────────────────────────────────

function renderPRRows(prs: PRReview[]): string {
  if (prs.length === 0) {
    return `<tr><td colspan="7" class="empty-state">
      <div class="empty-icon">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12h6m-3-3v6m-7 4h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/></svg>
      </div>
      <p>No reviews tracked yet</p>
      <p class="text-muted text-sm">PRs will appear here when review requests are detected</p>
    </td></tr>`;
  }
  return prs
    .map(
      (pr) => `<tr class="pr-row" data-status="${pr.status}">
      <td class="cell-repo">
        <span class="repo-name">${escapeHtml(pr.repo.split("/").pop() || pr.repo)}</span>
        <span class="repo-org text-muted">${escapeHtml(pr.repo.split("/")[0] || "")}</span>
      </td>
      <td><a href="${escapeHtml(pr.url)}" target="_blank" rel="noopener" class="pr-link">#${pr.pr_number}</a></td>
      <td>${pr.author ? `<span class="author">@${escapeHtml(pr.author)}</span>` : '<span class="text-muted">\u2014</span>'}</td>
      <td><span class="status-badge" style="--status-color:${STATUS_COLORS[pr.status] ?? "#71717a"}">${STATUS_LABELS[pr.status] ?? pr.status}</span></td>
      <td class="cell-title">${pr.title ? escapeHtml(pr.title) : '<span class="text-muted">\u2014</span>'}</td>
      <td class="cell-tools">${renderToolPills(pr.tool_status)}</td>
      <td class="cell-actions">
        ${RETRYABLE.has(pr.status) ? `<button class="btn btn-primary btn-sm" onclick="launchReview(${pr.id}, this)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>
          Review
        </button>` : ""}
        ${IN_PROGRESS.has(pr.status) ? `<span class="in-progress-indicator">
          <span class="spinner"></span> In progress
        </span>` : ""}
        <button class="btn ${pr.status === "done" || pr.status === "error" ? "btn-ghost" : "btn-ghost"} btn-sm" onclick="toggleDetail(${pr.id}, this)" title="View review output">
          ${pr.status === "done" || pr.status === "error" ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6M16 13H8m8 4H8m2-8H8"/></svg> Output` : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 9l-7 7-7-7"/></svg>`}
        </button>
      </td>
    </tr>
    <tr id="detail-${pr.id}" class="detail-row" style="display:none">
      <td colspan="7">
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
  const firstPage = prs.slice(0, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(prs.length / PAGE_SIZE));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>the-reviewer</title>
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
    table { width: 100%; border-collapse: collapse; }
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
    .cell-actions {
      text-align: right;
      white-space: nowrap;
      min-width: 140px;
    }

    /* ── Status badge ── */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 3px 10px;
      border-radius: 20px;
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
      .cell-tools, .cell-title { display: none; }
    }
  </style>
</head>
<body>

  <!-- Navigation -->
  <nav class="nav">
    <div class="nav-inner">
      <a href="/" class="nav-brand">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>
        the-reviewer
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
      </div>
      <div class="nav-right">
        <button class="sidebar-toggle" id="sidebar-toggle" onclick="toggleSidebar()" title="Chat Assistant">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
          Chat
        </button>
        <button class="btn btn-outline btn-sm" onclick="location.reload()" title="Refresh">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6M1 20v-6h6"/><path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15"/></svg>
        </button>
      </div>
    </div>
  </nav>

  <div class="main">

    <!-- Reviews Tab -->
    <div id="tab-reviews" class="tab-panel active" hx-ext="sse" sse-connect="/api/sse">
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Repository</th>
              <th>PR</th>
              <th>Author</th>
              <th>Status</th>
              <th>Title</th>
              <th>Tools</th>
              <th style="text-align:right">Actions</th>
            </tr>
          </thead>
          <tbody id="pr-table-body" sse-swap="pr-update" hx-swap="innerHTML">
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
            <button class="chat-suggestion" onclick="askSuggestion(this)">Common findings?</button>
            <button class="chat-suggestion" onclick="askSuggestion(this)">Show error patterns</button>
            <button class="chat-suggestion" onclick="askSuggestion(this)">Repos needing attention?</button>
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
    let totalPages = Math.max(1, Math.ceil(${prs.length} / ${PAGE_SIZE}));
    let chartInstances = {};
    let chatHistory = [];
    let analyticsLoaded = false;

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

    // ── Pagination ──
    async function goToPage(page) {
      if (page < 1 || page > totalPages) return;
      currentPage = page;
      try {
        var res = await fetch('/api/reviews/page?page=' + page + '&size=${PAGE_SIZE}');
        var data = await res.json();
        totalPages = data.totalPages;
        document.getElementById('pr-table-body').innerHTML = data.html;
        document.getElementById('page-info').textContent = 'Page ' + currentPage + ' of ' + totalPages;
        document.getElementById('prev-btn').disabled = currentPage <= 1;
        document.getElementById('next-btn').disabled = currentPage >= totalPages;
        document.getElementById('pagination').style.display = totalPages <= 1 ? 'none' : 'flex';
      } catch(e) {}
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

    async function toggleDetail(prId, btn) {
      var row = document.getElementById('detail-' + prId);
      if (!row) return;
      if (row.style.display === 'none') {
        row.style.display = 'table-row';
        if (btn) btn.querySelector('svg').style.transform = 'rotate(180deg)';
        var content = document.getElementById('detail-content-' + prId);
        try {
          var [evRes, outRes] = await Promise.all([
            fetch('/api/reviews/' + prId + '/events'),
            fetch('/api/reviews/' + prId + '/outputs')
          ]);
          var events = await evRes.json();
          var outputs = await outRes.json();
          var html = '<div class="detail-section-title">Events</div>';
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
        + '<button class="chat-suggestion" onclick="askSuggestion(this)">What are the common findings?</button>'
        + '<button class="chat-suggestion" onclick="askSuggestion(this)">Show error patterns</button>'
        + '</div></div>';
    }

    // ── SSE live updates ──
    document.body.addEventListener('htmx:sseMessage', function() {
      var badges = document.querySelectorAll('.status-badge');
      var active = 0;
      badges.forEach(function(b) {
        var s = b.textContent.trim();
        if (s !== 'Done' && s !== 'Error' && s !== 'Dismissed') active++;
      });
      var badge = document.getElementById('active-count');
      if (badge) badge.textContent = active;
      if (analyticsLoaded) loadAnalytics();
    });

  </script>
</body>
</html>`;
}

// ── Server ─────────────────────────────────────────────────────────────────

export function createDashboardServer(
  db: Database,
  config: AppConfig
): DashboardServer {
  const queries = createQueries(db);
  let lastUpdatedMap = new Map<number, string>();
  const sseClients = new Set<ReadableStreamDefaultController>();

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

  // SSE poll
  const sseInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      const prs = db.transaction(() => queries.getAllPRs())();
      const currentMap = getUpdatedMap(prs);
      if (hasChanges(currentMap, lastUpdatedMap)) {
        lastUpdatedMap = currentMap;
        const pageRows = prs.slice(0, PAGE_SIZE);
        const html = renderPRRows(pageRows);
        const data = `event: pr-update\ndata: ${html.replace(/\n/g, "\ndata: ")}\n\n`;
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

  // Build system prompt for chat with review context
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

    return `You are an AI assistant embedded in "the-reviewer", a code review automation tool. Your job is to help the user understand their review history, patterns, and insights.

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

RULES:
1. Answer questions about review history, patterns, and statistics
2. Be concise but thorough
3. When asked for summaries, organize by repo or status
4. Point out notable patterns (recurring errors, slow reviews, etc.)
5. Format responses with markdown (bold, code, lists)
6. If asked about a specific PR, reference its details from the data above`;
  }

  const server = Bun.serve({
    port: config.dashboard.port,
    async fetch(req) {
      try {
        const url = new URL(req.url);
        const path = url.pathname;

        // GET / — HTML page
        if (path === "/" && req.method === "GET") {
          const prs = queries.getAllPRs();
          lastUpdatedMap = getUpdatedMap(prs);
          return new Response(renderHTML(prs, queries), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // GET /api/reviews
        if (path === "/api/reviews" && req.method === "GET") {
          return Response.json(db.transaction(() => queries.getAllPRs())());
        }

        // GET /api/reviews/page
        if (path === "/api/reviews/page" && req.method === "GET") {
          const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
          const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get("size") || String(PAGE_SIZE), 10)));
          const allPRs = db.transaction(() => queries.getAllPRs())();
          const totalPages = Math.max(1, Math.ceil(allPRs.length / size));
          const offset = (page - 1) * size;
          const pagePRs = allPRs.slice(offset, offset + size);
          return Response.json({ html: renderPRRows(pagePRs), page, totalPages, totalItems: allPRs.length });
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
          Bun.spawn(["bun", "run", "src/index.ts", "review", pr.url, "--force"], {
            stdout: "ignore",
            stderr: "ignore",
            cwd: import.meta.dir + "/../..",
          });
          return Response.json({ ok: true, status: "launched" });
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

        // POST /api/chat — Chat with Claude via CLI
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

            return Response.json({ ok: true, response: stdout.trim() });
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
