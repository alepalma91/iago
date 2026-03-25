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
  if (!toolStatus) return '<span class="dim">—</span>';
  return Object.entries(toolStatus)
    .map(([tool, status]) => {
      const color = STATUS_COLORS[status] ?? "#6b7280";
      return `<span class="pill" style="background:${color}">${tool}: ${status}</span>`;
    })
    .join(" ");
}

const RETRYABLE = new Set(["done", "error", "dismissed"]);

function renderPRRows(prs: PRReview[]): string {
  if (prs.length === 0) {
    return '<tr><td colspan="7" class="empty">No PRs tracked yet.</td></tr>';
  }
  return prs
    .map(
      (pr) => `<tr>
      <td>${pr.repo}</td>
      <td><a href="${pr.url}" target="_blank">#${pr.pr_number}</a></td>
      <td>${pr.author ?? "—"}</td>
      <td><span class="badge" style="background:${STATUS_COLORS[pr.status] ?? "#6b7280"}">${pr.status}</span></td>
      <td>${pr.title ?? "—"}</td>
      <td>${renderToolPills(pr.tool_status)}</td>
      <td>
        ${RETRYABLE.has(pr.status) ? `<button class="retry-btn" onclick="retryReview(${pr.id})">↻ review</button>` : ""}
        <button class="detail-btn" onclick="toggleDetail(${pr.id})">▶</button>
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

function renderHTML(prs: PRReview[]): string {
  const activePRs = prs.filter(
    (pr) => !["done", "error", "dismissed"].includes(pr.status)
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>the-reviewer dashboard</title>
  <script src="https://unpkg.com/htmx.org@2.0.4"></script>
  <script src="https://unpkg.com/htmx-ext-sse@2.2.2/sse.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 1.5rem; }
    header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; border-bottom: 1px solid #21262d; padding-bottom: 1rem; }
    h1 { font-size: 1.25rem; font-weight: 600; }
    .count { background: #238636; color: #fff; padding: 0.2rem 0.6rem; border-radius: 10px; font-size: 0.8rem; }
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
  </style>
</head>
<body>
  <header>
    <h1>the-reviewer</h1>
    <span class="count">${activePRs.length} active</span>
  </header>
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
        ${renderPRRows(prs)}
      </tbody>
    </table>
  </div>
  <script>
    async function retryReview(prId) {
      const btn = event.target;
      btn.disabled = true;
      btn.textContent = "starting...";
      try {
        const res = await fetch("/api/reviews/" + prId + "/retry", { method: "POST" });
        if (!res.ok) { const msg = await res.text(); btn.textContent = "error"; setTimeout(function() { btn.textContent = "↻ review"; btn.disabled = false; }, 2000); return; }
        btn.textContent = "launched";
      } catch { btn.textContent = "↻ review"; btn.disabled = false; }
    }
    async function toggleDetail(prId) {
      const row = document.getElementById("detail-" + prId);
      if (!row) return;
      if (row.style.display === "none") {
        row.style.display = "table-row";
        const content = document.getElementById("detail-content-" + prId);
        try {
          const [eventsRes, outputsRes] = await Promise.all([
            fetch("/api/reviews/" + prId + "/events"),
            fetch("/api/reviews/" + prId + "/outputs")
          ]);
          const events = await eventsRes.json();
          const outputs = await outputsRes.json();
          let html = "<h4>Events</h4>";
          if (events.length === 0) html += '<div class="event-item dim">No events</div>';
          else events.forEach(function(e) {
            html += '<div class="event-item"><span class="event-time">' + e.created_at + '</span>' + e.event_type + (e.message ? ": " + e.message : "") + '</div>';
          });
          html += "<h4>Tool Outputs</h4>";
          if (outputs.length === 0) html += '<div class="event-item dim">No outputs</div>';
          else outputs.forEach(function(o) {
            html += '<div class="output-block"><div class="output-header">' + o.tool_name + ' (exit: ' + (o.exit_code ?? "—") + ', ' + (o.duration_ms ? (o.duration_ms / 1000).toFixed(1) + 's' : '—') + ')</div><div class="output-text">' + (o.output ?? "No output") + '</div></div>';
          });
          content.innerHTML = html;
        } catch { content.innerHTML = '<span class="dim">Failed to load details</span>'; }
      } else {
        row.style.display = "none";
      }
    }
    // SSE will push new table body HTML; update active count too
    document.body.addEventListener("htmx:sseMessage", function() {
      const badges = document.querySelectorAll(".badge");
      let active = 0;
      badges.forEach(function(b) {
        const s = b.textContent;
        if (s !== "done" && s !== "error" && s !== "dismissed") active++;
      });
      document.querySelector(".count").textContent = active + " active";
    });
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
        const html = renderPRRows(prs);
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
          return new Response(renderHTML(prs), {
            headers: { "Content-Type": "text/html; charset=utf-8" },
          });
        }

        // GET /api/reviews — JSON list of all PRs
        if (path === "/api/reviews" && req.method === "GET") {
          return Response.json(queries.getAllPRs());
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
          // Spawn review in background
          queries.updatePRStatus(pr.id, "accepted");
          queries.insertEvent(pr.id, "accepted", "Retry triggered from dashboard");
          Bun.spawn(["bun", "run", "src/index.ts", "review", pr.url, "--force"], {
            stdout: "ignore",
            stderr: "ignore",
            cwd: import.meta.dir + "/../..",
          });
          return Response.json({ ok: true, status: "launched" });
        }

        // GET /api/sse — Server-Sent Events
        if (path === "/api/sse" && req.method === "GET") {
          const stream = new ReadableStream({
            start(controller) {
              sseClients.add(controller);
              // Send initial keepalive
              controller.enqueue(new TextEncoder().encode(":ok\n\n"));
            },
            cancel() {
              // Client disconnected — cleanup handled by Set
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
      // Close all SSE connections
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
