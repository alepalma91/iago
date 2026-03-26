import type { Database } from "bun:sqlite";
import type { AppConfig } from "../types/index.js";
import type { Queries } from "../db/queries.js";
import { createQueries } from "../db/queries.js";
import type { PRReview } from "../types/index.js";

export interface DashboardServer {
  server: ReturnType<typeof Bun.serve>;
  stop: () => void;
}

const STATUS_COLORS: Record<string, string> = {
  detected: "#6b7280",
  notified: "#3b82f6",
  accepted: "#eab308",
  cloning: "#06b6d4",
  reviewing: "#f97316",
  done: "#22c55e",
  error: "#ef4444",
  dismissed: "#9ca3af",
};

function renderToolPills(toolStatus: Record<string, string> | null): string {
  if (!toolStatus) return '<span class="dim">&mdash;</span>';
  return Object.entries(toolStatus)
    .map(([tool, status]) => {
      const color = STATUS_COLORS[status] ?? "#6b7280";
      return `<span class="pill" style="background:${color}">${tool}: ${status}</span>`;
    })
    .join(" ");
}

const RETRYABLE = new Set(["done", "error", "dismissed"]);
const PAGE_SIZE = 20;

function renderPRRows(prs: PRReview[]): string {
  if (prs.length === 0) {
    return '<tr><td colspan="7" class="empty">No PRs tracked yet.</td></tr>';
  }
  return prs
    .map(
      (pr) => `<tr>
      <td>${pr.repo}</td>
      <td><a href="${pr.url}" target="_blank">#${pr.pr_number}</a></td>
      <td>${pr.author ?? "&mdash;"}</td>
      <td><span class="badge" style="background:${STATUS_COLORS[pr.status] ?? "#6b7280"}">${pr.status}</span></td>
      <td>${pr.title ?? "&mdash;"}</td>
      <td>${renderToolPills(pr.tool_status)}</td>
      <td>
        ${RETRYABLE.has(pr.status) ? `<button class="retry-btn" onclick="retryReview(${pr.id})">&#x21bb; review</button>` : ""}
        <button class="detail-btn" onclick="toggleDetail(${pr.id})">&#x25b6;</button>
      </td>
    </tr>
    <tr id="detail-${pr.id}" class="detail-row" style="display:none">
      <td colspan="7">
        <div class="detail-content" id="detail-content-${pr.id}">Loading...</div>
      </td>
    </tr>`
    )
    .join("\n");
}

function computeStats(queries: Queries) {
  const statusCounts = queries.getStatusCounts();
  const totalReviews = statusCounts.reduce((sum, s) => sum + s.count, 0);
  const doneCount = statusCounts.find((s) => s.status === "done")?.count ?? 0;
  const errorCount = statusCounts.find((s) => s.status === "error")?.count ?? 0;
  const completedCount = doneCount + errorCount;
  const successRate = completedCount > 0 ? Math.round((doneCount / completedCount) * 100) : 0;
  const avgCompletion = queries.getAvgCompletionTime();
  const avgDurationSec = avgCompletion.avg_seconds ?? 0;
  const avgDurationStr = avgDurationSec > 0
    ? `${Math.floor(avgDurationSec / 60)}m ${Math.round(avgDurationSec % 60)}s`
    : "&mdash;";

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

function renderHTML(prs: PRReview[], queries: Queries): string {
  const activePRs = prs.filter(
    (pr) => !["done", "error", "dismissed"].includes(pr.status)
  );
  const firstPage = prs.slice(0, PAGE_SIZE);
  const totalPages = Math.max(1, Math.ceil(prs.length / PAGE_SIZE));
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>the-reviewer dashboard</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 1.5rem; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; border-bottom: 1px solid #21262d; padding-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    .count { background: #238636; color: #fff; padding: 0.2rem 0.6rem; border-radius: 10px; font-size: 0.8rem; }
    section { margin-bottom: 2rem; }
    h2 { font-size: 1rem; font-weight: 600; color: #c9d1d9; margin-bottom: 1rem; }
    /* Table */
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid #21262d; font-size: 0.75rem; text-transform: uppercase; color: #8b949e; }
    td { padding: 0.5rem 0.75rem; border-bottom: 1px solid #161b22; font-size: 0.85rem; }
    tr:hover { background: #161b22; }
    a { color: #58a6ff; text-decoration: none; }
    a:hover { text-decoration: underline; }
    .badge { display: inline-block; padding: 0.15rem 0.5rem; border-radius: 10px; font-size: 0.75rem; color: #fff; font-weight: 500; }
    .pill { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 6px; font-size: 0.7rem; color: #fff; margin-right: 0.25rem; }
    .dim { color: #484f58; }
    .empty { text-align: center; color: #484f58; padding: 2rem; }
    .detail-btn { background: none; border: 1px solid #30363d; color: #8b949e; cursor: pointer; padding: 0.15rem 0.4rem; border-radius: 4px; font-size: 0.75rem; }
    .detail-btn:hover { border-color: #58a6ff; color: #58a6ff; }
    .retry-btn { background: none; border: 1px solid #238636; color: #3fb950; cursor: pointer; padding: 0.15rem 0.5rem; border-radius: 4px; font-size: 0.75rem; margin-right: 0.3rem; }
    .retry-btn:hover { background: #238636; color: #fff; }
    .retry-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .detail-row td { padding: 0; }
    .detail-content { padding: 1rem 1.5rem; background: #161b22; }
    .detail-content h4 { font-size: 0.8rem; color: #8b949e; margin: 0.75rem 0 0.3rem; text-transform: uppercase; }
    .detail-content h4:first-child { margin-top: 0; }
    .event-item { font-size: 0.8rem; padding: 0.2rem 0; color: #c9d1d9; }
    .event-time { color: #484f58; margin-right: 0.5rem; }
    .output-block { background: #0d1117; border: 1px solid #21262d; border-radius: 6px; padding: 0.75rem; margin: 0.4rem 0; }
    .output-header { font-size: 0.75rem; color: #8b949e; margin-bottom: 0.3rem; }
    .output-text { font-size: 0.8rem; white-space: pre-wrap; word-break: break-word; max-height: 300px; overflow-y: auto; }
    /* Analytics */
    .stat-cards { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
    .stat-card { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 1rem 1.25rem; }
    .stat-card .label { font-size: 0.75rem; color: #8b949e; text-transform: uppercase; margin-bottom: 0.25rem; }
    .stat-card .value { font-size: 1.5rem; font-weight: 600; color: #c9d1d9; }
    .stat-card .sub { font-size: 0.75rem; color: #484f58; margin-top: 0.15rem; }
    .chart-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-bottom: 2rem; }
    .chart-box { background: #161b22; border: 1px solid #21262d; border-radius: 8px; padding: 1rem; }
    .chart-box h3 { font-size: 0.85rem; color: #8b949e; margin-bottom: 0.75rem; font-weight: 500; }
    .chart-box canvas { max-height: 250px; }
    /* Repo table */
    .repo-table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    .repo-table th { text-align: left; padding: 0.4rem 0.5rem; border-bottom: 1px solid #21262d; font-size: 0.7rem; color: #8b949e; text-transform: uppercase; }
    .repo-table td { padding: 0.4rem 0.5rem; border-bottom: 1px solid #161b22; }
    .bar-bg { background: #21262d; border-radius: 3px; height: 6px; width: 100%; position: relative; }
    .bar-fill { height: 6px; border-radius: 3px; position: absolute; top: 0; left: 0; }
    /* Pagination */
    .pagination { display: flex; align-items: center; justify-content: center; gap: 0.5rem; margin-top: 1rem; }
    .pagination button { background: #161b22; border: 1px solid #30363d; color: #c9d1d9; padding: 0.35rem 0.75rem; border-radius: 6px; cursor: pointer; font-size: 0.8rem; font-family: inherit; }
    .pagination button:hover:not(:disabled) { border-color: #58a6ff; color: #58a6ff; }
    .pagination button:disabled { opacity: 0.3; cursor: not-allowed; }
    .pagination button.active { background: #58a6ff; color: #fff; border-color: #58a6ff; }
    .pagination .page-info { font-size: 0.8rem; color: #8b949e; }
    @media (max-width: 768px) {
      .stat-cards { grid-template-columns: repeat(2, 1fr); }
      .chart-grid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <header>
    <h1>the-reviewer</h1>
    <span class="count">${activePRs.length} active</span>
  </header>

  <!-- Analytics Section -->
  <section id="analytics-section">
    <div id="analytics-content">
      <p class="dim" style="padding:2rem;text-align:center">Loading analytics...</p>
    </div>
  </section>

  <!-- PR Table Section -->
  <section>
    <h2>Pull Requests</h2>
    <div hx-ext="sse" sse-connect="/api/sse" sse-swap="pr-update">
      <table>
        <thead>
          <tr>
            <th>Repo</th>
            <th>PR</th>
            <th>Author</th>
            <th>Status</th>
            <th>Title</th>
            <th>Tools</th>
            <th></th>
          </tr>
        </thead>
        <tbody id="pr-table-body">
          ${renderPRRows(firstPage)}
        </tbody>
      </table>
    </div>
    <div class="pagination" id="pagination" ${totalPages <= 1 ? 'style="display:none"' : ""}>
      <button onclick="goToPage(currentPage - 1)" id="prev-btn" disabled>&larr; Prev</button>
      <span class="page-info" id="page-info">Page 1 of ${totalPages}</span>
      <button onclick="goToPage(currentPage + 1)" id="next-btn" ${totalPages <= 1 ? "disabled" : ""}>&rarr; Next</button>
    </div>
  </section>

  <script>
    let currentPage = 1;
    const totalItems = ${prs.length};
    const pageSize = ${PAGE_SIZE};
    let totalPages = Math.max(1, Math.ceil(totalItems / pageSize));
    let chartInstances = {};

    // ── Pagination ──

    async function goToPage(page) {
      if (page < 1 || page > totalPages) return;
      currentPage = page;
      try {
        const res = await fetch('/api/reviews/page?page=' + page + '&size=' + pageSize);
        const data = await res.json();
        totalPages = data.totalPages;
        document.getElementById('pr-table-body').innerHTML = data.html;
        document.getElementById('page-info').textContent = 'Page ' + currentPage + ' of ' + totalPages;
        document.getElementById('prev-btn').disabled = currentPage <= 1;
        document.getElementById('next-btn').disabled = currentPage >= totalPages;
        document.getElementById('pagination').style.display = totalPages <= 1 ? 'none' : 'flex';
      } catch {}
    }

    // ── Analytics ──

    async function loadAnalytics() {
      try {
        const [statsRes, toolsRes, timelineRes, reposRes, findingsRes] = await Promise.all([
          fetch('/api/stats'),
          fetch('/api/stats/tools'),
          fetch('/api/stats/timeline?period=day'),
          fetch('/api/stats/repos'),
          fetch('/api/stats/findings')
        ]);
        const stats = await statsRes.json();
        const tools = await toolsRes.json();
        const timeline = await timelineRes.json();
        const repos = await reposRes.json();
        const findings = await findingsRes.json();
        renderAnalytics(stats, tools, timeline, repos, findings);
      } catch (e) {
        document.getElementById('analytics-content').innerHTML = '<p class="dim" style="padding:2rem;text-align:center">Failed to load analytics</p>';
      }
    }

    function renderAnalytics(stats, tools, timeline, repos, findings) {
      const container = document.getElementById('analytics-content');
      container.innerHTML = \`
        <div class="stat-cards">
          <div class="stat-card">
            <div class="label">Total Reviews</div>
            <div class="value">\${stats.totalReviews}</div>
            <div class="sub">\${stats.todayCount} today &middot; \${stats.weekCount} this week</div>
          </div>
          <div class="stat-card">
            <div class="label">Success Rate</div>
            <div class="value">\${stats.successRate}%</div>
            <div class="sub">\${stats.doneCount} done &middot; \${stats.errorCount} errors</div>
          </div>
          <div class="stat-card">
            <div class="label">Avg Duration</div>
            <div class="value">\${stats.avgDuration}</div>
            <div class="sub">detected &rarr; done</div>
          </div>
          <div class="stat-card">
            <div class="label">Findings</div>
            <div class="value">\${findings.total}</div>
            <div class="sub">\${findings.critical} critical &middot; \${findings.warning} warnings</div>
          </div>
        </div>
        <div class="chart-grid">
          <div class="chart-box">
            <h3>Reviews Timeline</h3>
            <canvas id="chart-timeline"></canvas>
          </div>
          <div class="chart-box">
            <h3>Status Breakdown</h3>
            <canvas id="chart-status"></canvas>
          </div>
          <div class="chart-box">
            <h3>Tool Performance</h3>
            <canvas id="chart-tools"></canvas>
          </div>
          <div class="chart-box">
            <h3>Findings Severity</h3>
            <canvas id="chart-findings"></canvas>
          </div>
          <div class="chart-box">
            <h3>Repository Breakdown</h3>
            <div id="repo-table-container"></div>
          </div>
          <div class="chart-box">
            <h3>Duration Distribution</h3>
            <canvas id="chart-duration"></canvas>
          </div>
        </div>
      \`;
      renderCharts(stats, tools, timeline, repos, findings);
    }

    function renderCharts(stats, tools, timeline, repos, findings) {
      const chartColors = {
        detected: '#6b7280', notified: '#3b82f6', accepted: '#eab308',
        cloning: '#06b6d4', reviewing: '#f97316', done: '#22c55e',
        error: '#ef4444', dismissed: '#9ca3af'
      };
      Chart.defaults.color = '#8b949e';
      Chart.defaults.borderColor = '#21262d';

      // Destroy old chart instances
      Object.values(chartInstances).forEach(function(c) { if (c) c.destroy(); });
      chartInstances = {};

      if (timeline.length > 0) {
        chartInstances.timeline = new Chart(document.getElementById('chart-timeline'), {
          type: 'line',
          data: {
            labels: timeline.map(function(t) { return t.date; }),
            datasets: [
              { label: 'Total', data: timeline.map(function(t) { return t.total; }), borderColor: '#58a6ff', backgroundColor: 'rgba(88,166,255,0.1)', fill: true, tension: 0.3 },
              { label: 'Success', data: timeline.map(function(t) { return t.success; }), borderColor: '#22c55e', backgroundColor: 'rgba(34,197,94,0.1)', fill: true, tension: 0.3 },
              { label: 'Error', data: timeline.map(function(t) { return t.error; }), borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.1)', fill: true, tension: 0.3 }
            ]
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true, ticks: { stepSize: 1 } } } }
        });
      }

      var statusData = stats.statusBreakdown || [];
      if (statusData.length > 0) {
        chartInstances.status = new Chart(document.getElementById('chart-status'), {
          type: 'doughnut',
          data: {
            labels: statusData.map(function(s) { return s.status; }),
            datasets: [{ data: statusData.map(function(s) { return s.count; }), backgroundColor: statusData.map(function(s) { return chartColors[s.status] || '#6b7280'; }) }]
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
        });
      }

      if (tools.length > 0) {
        chartInstances.tools = new Chart(document.getElementById('chart-tools'), {
          type: 'bar',
          data: {
            labels: tools.map(function(t) { return t.tool_name; }),
            datasets: [
              { label: 'Avg (s)', data: tools.map(function(t) { return (t.avg_duration_ms / 1000).toFixed(1); }), backgroundColor: '#58a6ff' },
              { label: 'Max (s)', data: tools.map(function(t) { return (t.max_duration_ms / 1000).toFixed(1); }), backgroundColor: 'rgba(88,166,255,0.3)' }
            ]
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
        });
      }

      if (findings.total > 0) {
        chartInstances.findings = new Chart(document.getElementById('chart-findings'), {
          type: 'doughnut',
          data: {
            labels: ['Critical', 'Warning', 'Suggestion'],
            datasets: [{ data: [findings.critical, findings.warning, findings.suggestion], backgroundColor: ['#ef4444', '#f97316', '#3b82f6'] }]
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
        });
      }

      var repoContainer = document.getElementById('repo-table-container');
      if (repos.length > 0) {
        var maxTotal = Math.max.apply(null, repos.map(function(r) { return r.total; }));
        var html = '<table class="repo-table"><thead><tr><th>Repo</th><th>Reviews</th><th>Success</th><th>Errors</th><th>Avg Duration</th><th></th></tr></thead><tbody>';
        repos.forEach(function(r) {
          var pct = maxTotal > 0 ? (r.total / maxTotal * 100) : 0;
          var dur = r.avg_duration_ms > 0 ? (r.avg_duration_ms / 1000).toFixed(1) + 's' : '&mdash;';
          html += '<tr><td>' + r.repo + '</td><td>' + r.total + '</td><td>' + r.success + '</td><td>' + r.error + '</td><td>' + dur + '</td><td style="width:30%"><div class="bar-bg"><div class="bar-fill" style="width:' + pct + '%;background:#58a6ff"></div></div></td></tr>';
        });
        html += '</tbody></table>';
        repoContainer.innerHTML = html;
      } else {
        repoContainer.innerHTML = '<p class="dim">No repository data</p>';
      }

      if (tools.length > 0) {
        var durations = tools.map(function(t) { return { name: t.tool_name, min: t.min_duration_ms / 1000, avg: t.avg_duration_ms / 1000, max: t.max_duration_ms / 1000 }; });
        chartInstances.duration = new Chart(document.getElementById('chart-duration'), {
          type: 'bar',
          data: {
            labels: durations.map(function(d) { return d.name; }),
            datasets: [
              { label: 'Min (s)', data: durations.map(function(d) { return d.min.toFixed(1); }), backgroundColor: '#22c55e' },
              { label: 'Avg (s)', data: durations.map(function(d) { return d.avg.toFixed(1); }), backgroundColor: '#58a6ff' },
              { label: 'Max (s)', data: durations.map(function(d) { return d.max.toFixed(1); }), backgroundColor: '#ef4444' }
            ]
          },
          options: { responsive: true, plugins: { legend: { position: 'bottom' } }, scales: { y: { beginAtZero: true } } }
        });
      }
    }

    // ── PR Actions ──

    async function retryReview(prId) {
      var btn = event.target;
      btn.disabled = true;
      btn.textContent = "starting...";
      try {
        var res = await fetch("/api/reviews/" + prId + "/retry", { method: "POST" });
        if (!res.ok) { btn.textContent = "error"; setTimeout(function() { btn.textContent = "\\u21bb review"; btn.disabled = false; }, 2000); return; }
        btn.textContent = "launched";
      } catch(e) { btn.textContent = "\\u21bb review"; btn.disabled = false; }
    }

    async function toggleDetail(prId) {
      var row = document.getElementById("detail-" + prId);
      if (!row) return;
      if (row.style.display === "none") {
        row.style.display = "table-row";
        var content = document.getElementById("detail-content-" + prId);
        try {
          var results = await Promise.all([
            fetch("/api/reviews/" + prId + "/events"),
            fetch("/api/reviews/" + prId + "/outputs")
          ]);
          var events = await results[0].json();
          var outputs = await results[1].json();
          var html = "<h4>Events</h4>";
          if (events.length === 0) html += '<div class="event-item dim">No events</div>';
          else events.forEach(function(e) {
            html += '<div class="event-item"><span class="event-time">' + e.created_at + '</span>' + e.event_type + (e.message ? ": " + e.message : "") + '</div>';
          });
          html += "<h4>Tool Outputs</h4>";
          if (outputs.length === 0) html += '<div class="event-item dim">No outputs</div>';
          else outputs.forEach(function(o) {
            html += '<div class="output-block"><div class="output-header">' + o.tool_name + ' (exit: ' + (o.exit_code != null ? o.exit_code : "\\u2014") + ', ' + (o.duration_ms ? (o.duration_ms / 1000).toFixed(1) + 's' : '\\u2014') + ')</div><div class="output-text">' + (o.output || "No output") + '</div></div>';
          });
          content.innerHTML = html;
        } catch(e) { content.innerHTML = '<span class="dim">Failed to load details</span>'; }
      } else {
        row.style.display = "none";
      }
    }

    // ── SSE live updates ──

    document.body.addEventListener("htmx:sseMessage", function() {
      var badges = document.querySelectorAll(".badge");
      var active = 0;
      badges.forEach(function(b) {
        var s = b.textContent;
        if (s !== "done" && s !== "error" && s !== "dismissed") active++;
      });
      document.querySelector(".count").textContent = active + " active";
      // Refresh analytics on updates
      loadAnalytics();
    });

    // ── Init ──

    loadAnalytics();
  </script>
</body>
</html>`;
}

export function createDashboardServer(
  db: Database,
  config: AppConfig
): DashboardServer {
  const queries = createQueries(db);
  let lastUpdatedMap = new Map<number, string>();
  const sseClients = new Set<ReadableStreamDefaultController>();

  function getUpdatedMap(prs: PRReview[]): Map<number, string> {
    const m = new Map<number, string>();
    for (const pr of prs) {
      m.set(pr.id, pr.updated_at);
    }
    return m;
  }

  function hasChanges(
    current: Map<number, string>,
    previous: Map<number, string>
  ): boolean {
    if (current.size !== previous.size) return true;
    for (const [id, ts] of current) {
      if (previous.get(id) !== ts) return true;
    }
    return false;
  }

  // SSE poll interval
  const sseInterval = setInterval(() => {
    if (sseClients.size === 0) return;
    try {
      const prs = queries.getAllPRs();
      const currentMap = getUpdatedMap(prs);
      if (hasChanges(currentMap, lastUpdatedMap)) {
        lastUpdatedMap = currentMap;
        // For SSE, send the current page (page 1) rows
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
    } catch {
      // DB might be closed during shutdown
    }
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

  const server = Bun.serve({
    port: config.dashboard.port,
    fetch(req) {
      try {
        const url = new URL(req.url);
        const path = url.pathname;

        // GET / — full HTML page
        if (path === "/" && req.method === "GET") {
          const prs = queries.getAllPRs();
          lastUpdatedMap = getUpdatedMap(prs);
          return new Response(renderHTML(prs, queries), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // GET /api/reviews — JSON list of all PRs
        if (path === "/api/reviews" && req.method === "GET") {
          return Response.json(queries.getAllPRs());
        }

        // GET /api/reviews/page?page=1&size=20 — paginated PR rows as HTML
        if (path === "/api/reviews/page" && req.method === "GET") {
          const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10));
          const size = Math.min(100, Math.max(1, parseInt(url.searchParams.get("size") || String(PAGE_SIZE), 10)));
          const allPRs = queries.getAllPRs();
          const totalPages = Math.max(1, Math.ceil(allPRs.length / size));
          const offset = (page - 1) * size;
          const pagePRs = allPRs.slice(offset, offset + size);
          return Response.json({
            html: renderPRRows(pagePRs),
            page,
            totalPages,
            totalItems: allPRs.length,
          });
        }

        // GET /api/reviews/:id/events
        const eventsMatch = path.match(/^\/api\/reviews\/(\d+)\/events$/);
        if (eventsMatch && req.method === "GET") {
          const id = parseInt(eventsMatch[1]!, 10);
          return Response.json(queries.getEvents(id));
        }

        // GET /api/reviews/:id/outputs
        const outputsMatch = path.match(/^\/api\/reviews\/(\d+)\/outputs$/);
        if (outputsMatch && req.method === "GET") {
          const id = parseInt(outputsMatch[1]!, 10);
          return Response.json(queries.getOutputs(id));
        }

        // POST /api/reviews/:id/retry — re-run review
        const retryMatch = path.match(/^\/api\/reviews\/(\d+)\/retry$/);
        if (retryMatch && req.method === "POST") {
          const id = parseInt(retryMatch[1]!, 10);
          const pr = queries.getPR(id);
          if (!pr) {
            return Response.json({ error: "PR not found" }, { status: 404 });
          }
          if (!pr.url) {
            return Response.json({ error: "PR has no URL" }, { status: 400 });
          }
          queries.updatePRStatus(pr.id, "accepted");
          queries.insertEvent(pr.id, "accepted", "Retry triggered from dashboard");
          Bun.spawn(["bun", "run", "src/index.ts", "review", pr.url, "--force"], {
            stdout: "ignore",
            stderr: "ignore",
            cwd: import.meta.dir + "/../..",
          });
          return Response.json({ ok: true, status: "launched" });
        }

        // GET /api/stats — overall stats
        if (path === "/api/stats" && req.method === "GET") {
          return Response.json(buildStatsResponse());
        }

        // GET /api/stats/tools — per-tool stats
        if (path === "/api/stats/tools" && req.method === "GET") {
          return Response.json(queries.getToolStats());
        }

        // GET /api/stats/timeline?period=day|week|month
        if (path === "/api/stats/timeline" && req.method === "GET") {
          const period = (url.searchParams.get("period") || "day") as "day" | "week" | "month";
          return Response.json(queries.getReviewTimeline(period));
        }

        // GET /api/stats/repos — per-repo stats
        if (path === "/api/stats/repos" && req.method === "GET") {
          return Response.json(queries.getRepoStats());
        }

        // GET /api/stats/findings — findings severity
        if (path === "/api/stats/findings" && req.method === "GET") {
          return Response.json(buildFindingsResponse());
        }

        // GET /api/sse — Server-Sent Events
        if (path === "/api/sse" && req.method === "GET") {
          const stream = new ReadableStream({
            start(controller) {
              sseClients.add(controller);
              controller.enqueue(new TextEncoder().encode(":ok\n\n"));
            },
            cancel() {
              // Client disconnected
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
        return new Response(`Internal Server Error: ${err.message}`, {
          status: 500,
        });
      }
    },
  });

  return {
    server,
    stop() {
      clearInterval(sseInterval);
      for (const controller of sseClients) {
        try {
          controller.close();
        } catch {}
      }
      sseClients.clear();
      server.stop();
    },
  };
}
