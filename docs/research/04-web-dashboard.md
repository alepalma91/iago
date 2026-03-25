# Research: Web Dashboard for PR Review Tracking

## Executive Summary

**Recommendation: Bun.serve + Inline HTML + htmx SSE Extension + SQLite (WAL mode)**

The dashboard should be an ultra-lightweight, embedded web server that launches on-demand from the CLI. It serves a single HTML page with real-time SSE updates. No build step, no bundler, no frontend framework — just server-rendered HTML with htmx for live updates. SQLite provides persistent state shared between the CLI process and the dashboard server.

---

## 1. Technology Options Evaluated

### Option A: Bun.serve (Built-in HTTP Server) — RECOMMENDED

Bun ships with a built-in HTTP server (`Bun.serve()`) that requires zero dependencies.

**Pros:**
- Zero dependencies — no framework needed for simple routing
- 2.5x faster than Node.js HTTP server
- Built-in SSE support via async generators and ReadableStream
- Routes API supports path matching natively
- Can serve inline HTML strings (no static file directory needed)
- Starts in ~2ms (Bun's fast startup time)

**Cons:**
- Bun-specific API (not portable to Node.js)
- Route matching is basic compared to frameworks

**SSE Example (async generator — recommended pattern):**
```ts
Bun.serve({
  port: 3000,
  routes: {
    "/events": (req, server) => {
      server.timeout(req, 0); // disable idle timeout for SSE
      return new Response(
        async function* () {
          yield `data: connected\n\n`;
          while (true) {
            await Bun.sleep(2000);
            const state = getReviewState(); // read from SQLite
            yield `event: pr-update\ndata: ${renderPRRow(state)}\n\n`;
          }
        },
        { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
      );
    },
  },
});
```

### Option B: Hono on Bun

Hono is a lightweight web framework (~12kB for hono/tiny) built on Web Standards.

**Pros:**
- Clean middleware/routing API
- Works on Node.js, Deno, Cloudflare Workers (portable)
- 1.8M weekly npm downloads — well maintained
- JSX support for HTML templating (hono/jsx)
- Built-in helpers for streaming responses

**Cons:**
- Adds a dependency where none is strictly needed
- Overhead for ~4 routes is unnecessary
- The portability benefit is irrelevant since we're committed to Bun

**Verdict:** Hono is excellent but overkill for 3-4 routes. Use Bun.serve directly.

### Option C: Elysia on Bun

Elysia is a Bun-native framework optimized for maximum performance (~2.5M req/s).

**Pros:**
- Fastest Bun framework (static code analysis optimization)
- End-to-end type safety via Eden Treaty
- Elegant decorator pattern API

**Cons:**
- Heavier dependency than Hono
- Designed for API-heavy apps, not simple HTML serving
- Eden Treaty is useless for an HTML dashboard

**Verdict:** Overkill. Performance is irrelevant for a local dashboard.

### Option D: Fastify (Node.js)

Fastify is a mature, fast Node.js framework with an SSE plugin.

**Pros:**
- Battle-tested, huge ecosystem
- Official `@fastify/sse` plugin
- Great for complex apps

**Cons:**
- Node.js-only — we're using Bun
- Heavier dependency footprint
- Plugin-based SSE adds complexity vs native streaming

**Verdict:** Not appropriate if we're using Bun runtime.

### Option E: Static HTML Generation (meta-refresh)

Generate an HTML file on disk, open it in browser, CLI rewrites it periodically.

**Pros:**
- Zero server process — just a file
- Works offline
- Simplest possible approach

**Cons:**
- Full page refresh every N seconds (jarring UX)
- No real-time updates — minimum 5-10s polling
- File I/O on every update
- Race condition if browser reads while CLI writes
- Cannot show streaming tool output

**Verdict:** Too crude. The UX gap vs SSE is significant with no real simplicity gain.

---

## 2. Frontend Approach

### Option A: htmx + SSE Extension — RECOMMENDED

htmx (14KB gzipped) enables real-time DOM updates from SSE with zero custom JavaScript.

**How it works:**
```html
<!-- Connect to SSE endpoint, swap PR list on updates -->
<div hx-ext="sse" sse-connect="/events" sse-swap="pr-update">
  <!-- Server sends HTML fragments that replace this content -->
  <div class="pr-list">Loading...</div>
</div>
```

**Multiple event types for different dashboard sections:**
```html
<div hx-ext="sse" sse-connect="/events">
  <div sse-swap="pr-list"><!-- PR table updates here --></div>
  <div sse-swap="tool-status"><!-- Running tool info here --></div>
  <div sse-swap="activity-log"><!-- Recent activity --></div>
</div>
```

**Server sends HTML fragments:**
```
event: pr-update
data: <tr class="pr-row"><td>fix: auth bug</td><td class="status done">Done</td><td><a href="...">PR #42</a></td></tr>

event: tool-status
data: <div class="tool running">ESLint: scanning 42 files...</div>
```

**Advantages:**
- Server renders HTML — no client-side templating
- Auto-reconnect with exponential backoff built-in
- Named events allow targeted partial updates
- Swap strategies (innerHTML, outerHTML, beforeend, etc.)
- Works without JavaScript knowledge for maintenance

### Option B: Pure EventSource (No Library)

```html
<script>
const es = new EventSource('/events');
es.addEventListener('pr-update', (e) => {
  document.getElementById('pr-list').innerHTML = e.data;
});
</script>
```

**Pros:** Zero dependencies (not even htmx)
**Cons:** Manual DOM manipulation, manual reconnect logic, grows messy fast

**Verdict:** htmx at 14KB is worth it for the declarative SSE handling alone.

### Option C: React/Preact/Solid SPA

**Verdict:** Massive overkill. We're rendering a table with ~10-50 rows.

---

## 3. Data Layer

### SQLite with WAL Mode — RECOMMENDED

Bun has a built-in SQLite driver (`bun:sqlite`) that is 3-6x faster than better-sqlite3.

**Schema:**
```sql
CREATE TABLE IF NOT EXISTS pr_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number INTEGER NOT NULL,
  repo TEXT NOT NULL,
  title TEXT,
  author TEXT,
  url TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'detected',
  -- status: detected | notified | accepted | cloning | reviewing | done | error
  tool_status TEXT, -- JSON: {"eslint": "running", "tests": "done", ...}
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS review_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_review_id INTEGER REFERENCES pr_reviews(id),
  event_type TEXT NOT NULL,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
```

**WAL Mode Configuration:**
```ts
import { Database } from "bun:sqlite";

const db = new Database("the-reviewer.db");
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA synchronous = NORMAL");
db.exec("PRAGMA busy_timeout = 5000");
```

**Why WAL mode:**
- Concurrent reads while writing — CLI writes state, dashboard reads it
- No locking conflicts between processes
- Single writer + multiple readers pattern is perfect for this use case

**Why SQLite over alternatives:**
| Approach | Persistence | Concurrent Access | Query Power | Complexity |
|----------|------------|-------------------|-------------|------------|
| SQLite (WAL) | Durable | Yes (WAL) | Full SQL | Low |
| JSON file | Durable | Race conditions | None | Very Low |
| In-memory + backup | Volatile | Process-local | Limited | Medium |
| LevelDB/RocksDB | Durable | Yes | Key-value only | Medium |

SQLite wins on every axis that matters for this use case.

---

## 4. Architecture: CLI ↔ Dashboard Communication

### Approach: Shared SQLite Database (RECOMMENDED)

The simplest and most robust pattern: both CLI and dashboard read/write the same SQLite database.

```
┌──────────────┐     ┌─────────────────┐     ┌─────────────┐
│   CLI Tool   │────▶│  SQLite (WAL)   │◀────│  Dashboard  │
│  (writer)    │     │  the-reviewer.db│     │  Server     │
└──────────────┘     └─────────────────┘     │  (reader +  │
                                              │   SSE push) │
                                              └──────┬──────┘
                                                     │ SSE
                                                     ▼
                                              ┌──────────────┐
                                              │   Browser    │
                                              │   (htmx)     │
                                              └──────────────┘
```

**How it works:**
1. CLI process writes PR state changes to SQLite
2. Dashboard server polls SQLite every 1-2 seconds (cheap — it's in-process)
3. On change detected, server pushes HTML fragment via SSE to all connected browsers
4. htmx swaps the fragment into the page — zero JS needed

**Change detection (simple polling):**
```ts
let lastCheck = 0;
async function* prUpdateStream() {
  while (true) {
    const updated = db.query(
      "SELECT * FROM pr_reviews WHERE updated_at > ? ORDER BY updated_at DESC",
    ).all(lastCheck);
    if (updated.length > 0) {
      lastCheck = Date.now();
      yield `event: pr-update\ndata: ${renderPRTable(updated)}\n\n`;
    }
    await Bun.sleep(1500);
  }
}
```

**Alternative: File-based signal**
The CLI could touch a signal file (`~/.the-reviewer/.dashboard-notify`) when state changes, and the dashboard watches it with `fs.watch()`. This avoids polling but adds complexity for minimal gain.

**Alternative: Unix domain socket / IPC**
The CLI could send state changes directly to the dashboard process. This is the most "real-time" approach but requires the dashboard to be running when the CLI writes — adds coupling and error handling.

**Verdict:** Shared SQLite is simpler, decoupled, and fast enough (1-2s latency is fine for a PR dashboard).

---

## 5. Dashboard Server Implementation

### Single-File Server (~100 lines)

```ts
// dashboard.ts
import { Database } from "bun:sqlite";

const db = new Database("the-reviewer.db", { readonly: true });
const PORT = 3847; // arbitrary high port

const HTML = `<!DOCTYPE html>
<html>
<head>
  <title>The Reviewer - PR Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/htmx.org@2.0.8/dist/htmx.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/htmx-ext-sse@2.2.4"></script>
  <style>
    /* Minimal dark theme CSS here */
  </style>
</head>
<body hx-ext="sse">
  <h1>PR Reviews</h1>
  <div sse-connect="/events">
    <table>
      <thead><tr><th>PR</th><th>Repo</th><th>Status</th><th>Author</th></tr></thead>
      <tbody sse-swap="pr-update" hx-swap="innerHTML">
        <!-- SSE populates this -->
      </tbody>
    </table>
    <div id="activity" sse-swap="activity" hx-swap="innerHTML"></div>
  </div>
</body>
</html>`;

Bun.serve({
  port: PORT,
  routes: {
    "/": () => new Response(HTML, { headers: { "Content-Type": "text/html" } }),
    "/events": (req, server) => {
      server.timeout(req, 0);
      return new Response(
        async function* () {
          let lastId = 0;
          while (true) {
            const prs = db.query("SELECT * FROM pr_reviews ORDER BY updated_at DESC").all();
            yield renderSSE("pr-update", renderPRRows(prs));
            await Bun.sleep(2000);
          }
        },
        { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
      );
    },
  },
});
```

### Opening the Browser

Use the `open` npm package (or Bun's native shell):
```ts
// Cross-platform browser open
import { $ } from "bun";
await $`open http://localhost:${PORT}`; // macOS
// Or: Bun.spawn(["xdg-open", url]); // Linux
// Or: Bun.spawn(["cmd", "/c", "start", url]); // Windows
```

For macOS-first, `open` command is built-in — no npm package needed.

---

## 6. Dashboard Features & UX

### PR Status Display

| Column | Content |
|--------|---------|
| PR | Title (linked to GitHub) |
| Repo | `owner/repo` |
| Status | Badge: detected → notified → accepted → cloning → reviewing → done |
| Tools | Running tools with progress indicators |
| Time | Relative time (2m ago, 1h ago) |

### Status Badge Colors (CSS)

```css
.status-detected  { background: #6b7280; } /* gray */
.status-notified  { background: #f59e0b; } /* amber */
.status-accepted  { background: #3b82f6; } /* blue */
.status-cloning   { background: #8b5cf6; } /* purple */
.status-reviewing  { background: #f97316; } /* orange, animated pulse */
.status-done      { background: #22c55e; } /* green */
.status-error     { background: #ef4444; } /* red */
```

### Minimal Interaction

The dashboard is primarily **read-only**. Possible interactions:
- Click PR title → opens GitHub PR in new tab
- Click "Accept" on a pending PR → sends accept signal (writes to SQLite)
- Click "Dismiss" → marks as ignored
- Filter dropdown: All / Pending / In Progress / Done

These interactions can use htmx `hx-post` to hit dashboard server endpoints that write to SQLite.

---

## 7. Lifecycle & Resource Management

### Starting the Dashboard

```bash
the-reviewer dashboard          # starts server + opens browser
the-reviewer dashboard --port 4000  # custom port
the-reviewer dashboard --no-open    # start server without opening browser
```

### Implementation:
```ts
// In CLI command handler
async function startDashboard(options: { port: number; open: boolean }) {
  const port = options.port || 3847;

  // Check if already running
  try {
    await fetch(`http://localhost:${port}/health`);
    console.log(`Dashboard already running at http://localhost:${port}`);
  } catch {
    // Start the server (same process or spawn)
    startDashboardServer(port);
    console.log(`Dashboard started at http://localhost:${port}`);
  }

  if (options.open) {
    await Bun.spawn(["open", `http://localhost:${port}`]);
  }
}
```

### Same-Process vs Separate Process

**Same process (recommended for simplicity):**
- Dashboard server runs in the main CLI process
- Shares SQLite connection directly
- Stops when CLI exits

**Separate process (if CLI exits frequently):**
- `Bun.spawn` a detached dashboard process
- Writes PID to `~/.the-reviewer/dashboard.pid`
- `the-reviewer dashboard stop` kills it

**Recommendation:** Start with same-process. If users want the dashboard to persist after CLI commands complete, add detached mode later.

---

## 8. Offline / CDN Considerations

htmx and the SSE extension can be:
1. **CDN-loaded** (14KB + 3KB) — simplest, always up-to-date
2. **Bundled inline** — embed the minified JS directly in the HTML string for zero external requests
3. **Vendored** — ship htmx.min.js alongside the CLI binary

**Recommendation:** Bundle inline. The total is ~17KB of JS which fits easily in a template literal. This means the dashboard works without internet and has zero external dependencies.

---

## 9. Alternative Considered: Terminal UI (TUI)

For completeness, a TUI approach was evaluated:
- **Ink** (React for terminals): Rich, but heavy (~2MB deps)
- **blessed/blessed-contrib**: Powerful dashboards, but unmaintained
- **bubbletea** (Go): Excellent, but wrong language

**Verdict:** A TUI is a separate concern from a web dashboard. The CLI should have a simple status display (`the-reviewer status`), but a TUI dashboard duplicates the web dashboard effort. If needed later, Ink is the best option for a Bun/TS project.

---

## 10. Final Recommendation

### Stack
| Layer | Choice | Rationale |
|-------|--------|-----------|
| Server | `Bun.serve()` | Zero deps, built-in SSE, fast startup |
| Frontend | htmx + SSE extension (inline) | 17KB, declarative, no build step |
| Styling | Inline `<style>` (dark theme) | Single HTML response, no static files |
| Data | `bun:sqlite` (WAL mode) | Built-in, fast, concurrent r/w |
| Communication | Shared SQLite file | Decoupled, simple, reliable |
| Browser launch | `open` command (macOS) | Built-in, no npm deps |

### What We're NOT Doing
- No React/Vue/Svelte — table with 50 rows doesn't need a framework
- No WebSockets — SSE is simpler, unidirectional is enough
- No build step — everything is inline HTML/CSS/JS
- No separate frontend project — it's one HTML string in the server file
- No Docker/containerization — it's a local dev tool

### Total Footprint
- ~150-200 lines of TypeScript for the dashboard server
- ~17KB of inline JavaScript (htmx + SSE extension)
- Zero npm dependencies beyond what the CLI already needs
- One SQLite file for all state

This approach keeps the dashboard truly secondary to the CLI while providing a polished, real-time experience for PR tracking.
