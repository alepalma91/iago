# The Reviewer — Architecture Document

## 1. What It Is

A macOS CLI daemon that watches GitHub for PR review assignments, notifies you, and launches configurable AI review tools (Claude, Gemini, Codex, or any CLI tool) in parallel against the PR diff — all from your terminal.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         the-reviewer                                 │
│                                                                      │
│  ┌──────────┐   ┌────────────┐   ┌──────────┐   ┌──────────────┐  │
│  │ GitHub    │──▶│ Notifier   │──▶│ Sandbox  │──▶│ Launcher     │  │
│  │ Poller    │   │ (alerter)  │   │ Manager  │   │ Orchestrator │  │
│  └──────────┘   └────────────┘   └──────────┘   └──────┬───────┘  │
│       │                                                  │          │
│       │          ┌────────────┐              ┌──────────▼───────┐  │
│       └─────────▶│ SQLite DB  │◀─────────────│ Tool Processes   │  │
│                  │ (WAL mode) │              │ claude | gemini  │  │
│                  └─────┬──────┘              │ codex  | custom  │  │
│                        │                     └──────────────────┘  │
│                  ┌─────▼──────┐                                     │
│                  │ Dashboard  │                                     │
│                  │ (SSE+htmx) │                                     │
│                  └────────────┘                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technology Stack

| Layer | Choice | Why |
|-------|--------|-----|
| **Runtime** | **Bun** | Built-in SQLite, fast startup (~2ms), native TS, `Bun.serve()` for dashboard, `Bun.spawn()` for process management |
| **Language** | **TypeScript** | Type safety for config schemas, fast iteration, huge ecosystem |
| **GitHub API** | **`gh` CLI** (via `Bun.spawn`) | Zero token management, handles auth, supports REST + GraphQL |
| **Notifications** | **alerter** (Homebrew) | Action buttons with stdout callback, JSON output, notification grouping |
| **Sandbox** | **Git worktrees** (bare reference clones) | Sub-second creation, shared object store, disk efficient |
| **Dashboard** | **Bun.serve + htmx + SSE** | Zero deps, inline HTML, 17KB JS total, real-time updates |
| **State** | **SQLite (WAL mode)** via `bun:sqlite` | Built-in, concurrent read/write, persistent, queryable |
| **Config** | **YAML** (`~/.config/the-reviewer/`) | Human-readable, supports global + per-repo overrides |
| **Distribution** | **Homebrew tap** or `bun build --compile` | Single binary, easy install |

### Why Bun over Node.js/Go/Rust?

- **vs Node.js**: Bun has built-in SQLite, faster startup, native `Bun.serve()` — fewer deps for everything we need.
- **vs Go**: Go would give us a single binary, but the config/YAML/template ecosystem is weaker. TypeScript is faster to iterate in.
- **vs Rust**: Best performance but highest development cost. This is a developer tool, not a hot path — Bun is fast enough.

---

## 3. Component Design

### 3.1 GitHub Poller

**Strategy: Conditional REST Notifications + GraphQL Enrichment**

```
Poll Loop (every 60s):
  GET /notifications (with If-Modified-Since header)
    │
    ├─ 304 Not Modified → sleep (costs 0 rate limit)
    │
    └─ 200 OK → filter for reason == "review_requested"
                  │
                  └─ GraphQL query: search(type:pr review-requested:@me)
                       → returns rich PR metadata (title, author, files, additions)
```

**Rate limit budget**: ~1-2% of 5,000 requests/hour. Effectively free.

**Implementation**:
```ts
// Core polling loop
async function pollNotifications(lastModified: string): Promise<PollResult> {
  const { stdout, exitCode } = await $`gh api /notifications \
    --include \
    -H "If-Modified-Since: ${lastModified}" \
    -H "Accept: application/json"`;

  // Parse response headers for next If-Modified-Since and X-Poll-Interval
  // Filter notifications for review_requested reason
  // Enrich with GraphQL for PR details
}
```

**Key details**:
- `X-Poll-Interval` header tells us exact sleep duration (usually 60s)
- 304 responses cost zero rate limit — free during quiet periods
- One API call covers ALL repos (no per-repo polling needed)
- GraphQL enrichment fires only when new review requests detected

### 3.2 Notification Manager

**Tool**: `alerter` (Homebrew: `vjeantet/tap/alerter`)

```
New PR detected → spawn alerter process
  │
  ├─ User clicks "Accept Review" → stdout: JSON with activationValue
  │     └─ trigger sandbox + launcher pipeline
  │
  ├─ User clicks "View on GitHub" → open PR URL in browser
  │
  ├─ User clicks "Snooze" → re-notify in 30 min
  │
  └─ Timeout (5 min) → mark as "missed", re-notify on next poll
```

**Notification format**:
```bash
alerter \
  --title "PR Review Request" \
  --subtitle "owner/repo #42" \
  --message "feat: add user authentication — @developer" \
  --actions "Accept Review,View on GitHub,Snooze" \
  --closeLabel "Dismiss" \
  --sound "Ping" \
  --timeout 300 \
  --group "pr-reviews" \
  --json
```

**Fallback chain**: alerter → osascript (no actions) → terminal bell + stdout

### 3.3 Sandbox Manager

**Strategy: Bare reference clones + git worktrees**

```
Directory layout:
~/.local/share/the-reviewer/
  repos/                          # Bare reference clones (shared object store)
    github.com/owner/repo.git/
  worktrees/                      # Active review worktrees
    github.com/owner/repo/pr-42/
  output/                         # Review tool output
    github.com/owner/repo/pr-42/
      claude.md
      gemini.md
      aggregated.md
```

**Lifecycle**:
1. **Ensure reference repo**: `git clone --bare --filter=blob:none` (first time) or `git fetch` (subsequent)
2. **Create worktree**: `git worktree add .../pr-42 <pr-branch>` — sub-second, shares objects
3. **Generate diff**: `git diff main...HEAD > pr.diff`
4. **Run post_checkout hooks** (if configured, e.g., `cargo fetch`)
5. **Launch review tools** in worktree cwd
6. **Cleanup**: `git worktree remove` after TTL (default 24h) or manual

**Why worktrees over temp clones**:
- Creation: milliseconds vs seconds
- Disk: shared object store (10 concurrent PRs ≈ 1x disk for objects)
- Network: one `git fetch` per repo, not per PR

### 3.4 Launcher Orchestrator

**Runs multiple AI tools in parallel against the same PR diff.**

```
Prompt Assembly:
  system_prompt (global/repo) + instructions (global/repo) + techniques → template → final prompt

Execution:
  ┌──────────┐  ┌──────────┐  ┌──────────┐
  │ claude   │  │ gemini   │  │ codex    │  ← parallel child processes
  │ (5m max) │  │ (5m max) │  │ (5m max) │     in worktree cwd
  └────┬─────┘  └────┬─────┘  └────┬─────┘
       └──────────────┼──────────────┘
                      ▼
              ┌──────────────┐
              │  Aggregator  │  optional: concatenate or AI-merge
              └──────────────┘
```

**Launcher profiles** are YAML-defined, supporting any CLI tool:
```yaml
launchers:
  tools:
    claude:
      command: "claude"
      args: ["-p", "{{prompt}}", "--output-format", "text"]
      timeout: "5m"
    clauded-at:  # Custom alias with different model
      command: "claude"
      args: ["-p", "{{prompt}}", "--output-format", "text", "--model", "opus"]
      timeout: "10m"
    gemini:
      command: "gemini"
      args: ["-p", "{{prompt}}"]
      timeout: "5m"
```

**Variable interpolation**: `{{prompt}}`, `{{diff_file}}`, `{{worktree}}`, `{{pr_number}}`, `{{pr_url}}`, `{{repo}}`, `{{branch}}`

**Process management**:
- `Bun.spawn()` with `AbortController` for timeout
- `Promise.allSettled()` for parallel execution
- Configurable `max_parallel` (default: 3)
- Stdout/stderr captured per tool, written to `output/` dir
- Lifecycle events emitted for dashboard updates

### 3.5 Configuration System

```
~/.config/the-reviewer/
  config.yaml                   # Global config
  prompts/
    default-system.md           # Default system prompt
    default-instructions.md     # Default review instructions
    security-review.md          # Technique: security focus
    perf-review.md              # Technique: performance focus

Per-repo (in target repo):
  .the-reviewer/
    config.yaml                 # Overrides global config (deep merge)
    prompts/
      system.md                 # Repo-specific system prompt
      instructions.md           # Repo-specific instructions
```

**Resolution order** (highest wins):
1. CLI flags (`--tool=claude --timeout=10m`)
2. Per-repo config (`.the-reviewer/config.yaml`)
3. Global config (`~/.config/the-reviewer/config.yaml`)
4. Built-in defaults

See `docs/research/03-sandbox-launcher-config.md` for full YAML schemas.

### 3.6 Dashboard

**Ultra-lightweight: Bun.serve + inline HTML + htmx SSE**

- Single HTML response (no static files, no build step)
- htmx (14KB) + SSE extension (3KB) inlined in HTML
- Real-time updates via Server-Sent Events
- Reads from shared SQLite database

```
┌─────────────┐  writes   ┌──────────────┐  reads   ┌─────────────┐
│ CLI daemon  │──────────▶│ SQLite (WAL) │◀─────────│ Dashboard   │
│             │           │              │           │ server      │
└─────────────┘           └──────────────┘           └──────┬──────┘
                                                            │ SSE
                                                     ┌──────▼──────┐
                                                     │   Browser   │
                                                     │   (htmx)    │
                                                     └─────────────┘
```

**PR states**: `detected → notified → accepted → cloning → reviewing → done | error`

**Features**: PR table with status badges, links to GitHub PRs, tool status indicators, activity log. ~150-200 lines of TypeScript.

---

## 4. Data Model (SQLite)

```sql
CREATE TABLE pr_reviews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_number     INTEGER NOT NULL,
  repo          TEXT NOT NULL,           -- "owner/repo"
  title         TEXT,
  author        TEXT,
  url           TEXT NOT NULL,
  branch        TEXT,
  base_branch   TEXT DEFAULT 'main',
  status        TEXT NOT NULL DEFAULT 'detected',
  tool_status   TEXT,                    -- JSON: {"claude":"running","gemini":"done"}
  worktree_path TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now')),
  UNIQUE(repo, pr_number)
);

CREATE TABLE review_output (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_review_id  INTEGER REFERENCES pr_reviews(id),
  tool_name     TEXT NOT NULL,
  output        TEXT,                    -- Review content (markdown)
  exit_code     INTEGER,
  duration_ms   INTEGER,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE review_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  pr_review_id  INTEGER REFERENCES pr_reviews(id),
  event_type    TEXT NOT NULL,           -- "detected","notified","accepted","error", etc.
  message       TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);
```

---

## 5. CLI Commands

```bash
the-reviewer start              # Start daemon (poller + dashboard)
the-reviewer stop               # Stop daemon gracefully
the-reviewer status             # Show current PR review queue
the-reviewer dashboard          # Open dashboard in browser
the-reviewer dashboard --no-open # Start dashboard server only
the-reviewer review <pr-url>    # Manually trigger review of a specific PR
the-reviewer config             # Show resolved config
the-reviewer config init        # Generate default config files
the-reviewer config validate    # Validate config files
the-reviewer logs               # Tail daemon logs
the-reviewer cleanup            # Remove stale worktrees and old data
```

---

## 6. Process Model

```
the-reviewer start
  │
  ├─ Main Process (Bun)
  │    ├─ GitHub Poller (setInterval loop)
  │    ├─ Dashboard Server (Bun.serve, same process)
  │    ├─ Cleanup Scheduler (periodic worktree cleanup)
  │    └─ Signal handlers (SIGTERM, SIGINT → graceful shutdown)
  │
  ├─ Child Processes (per review)
  │    ├─ alerter (notification, blocks until user acts)
  │    ├─ git (clone, fetch, worktree operations)
  │    ├─ claude / gemini / codex (review tools, parallel)
  │    └─ aggregator tool (optional, after all tools complete)
  │
  └─ PID file: ~/.local/share/the-reviewer/daemon.pid
```

Single main process. Child processes spawned on-demand for notifications and reviews. Dashboard runs in-process (no separate server).

---

## 7. End-to-End Flow

```
1. POLL     gh api /notifications (If-Modified-Since) ─── 304? sleep.
                                                          200? ──▶

2. DETECT   Filter: reason == "review_requested"
            GraphQL: enrich PR metadata (title, author, files)
            SQLite: INSERT pr_reviews (status: "detected")

3. NOTIFY   Spawn alerter with "Accept Review" button
            SQLite: UPDATE status → "notified"

4. ACCEPT   User clicks "Accept Review"
            alerter stdout → JSON { activationValue: "Accept Review" }
            SQLite: UPDATE status → "accepted"

5. SANDBOX  Ensure bare clone (git clone --bare --filter=blob:none)
            git fetch origin
            git worktree add .../pr-42 <branch>
            git diff main...HEAD > pr.diff
            SQLite: UPDATE status → "cloning"

6. PROMPT   Load config: global ← repo merge
            Assemble: system_prompt + instructions + techniques + diff
            SQLite: UPDATE status → "reviewing"

7. LAUNCH   For each enabled tool (parallel):
              Bun.spawn(tool.command, tool.args, { cwd: worktree })
              Capture stdout → output/{repo}/pr-42/{tool}.md
            SQLite: UPDATE tool_status per tool

8. COLLECT  All tools done → aggregate if configured
            SQLite: UPDATE status → "done"
            Notification: "Review complete for PR #42"

9. CLEANUP  After TTL: git worktree remove
            Prune: git worktree prune
```

---

## 8. Implementation Roadmap

### Phase 1: MVP (Core Loop) — ~2-3 days
- [ ] Project scaffolding (Bun + TypeScript)
- [ ] GitHub poller (REST notifications + conditional requests)
- [ ] SQLite state management
- [ ] macOS notifications via alerter
- [ ] Basic sandbox (git worktree lifecycle)
- [ ] Single tool launcher (claude only)
- [ ] `the-reviewer start` / `stop` / `status` commands

### Phase 2: Config + Multi-Tool — ~2 days
- [ ] YAML config loader (global + per-repo merge)
- [ ] Prompt assembly engine (templates + techniques)
- [ ] Multi-tool parallel launcher
- [ ] Variable interpolation in launcher profiles
- [ ] `the-reviewer config init` / `validate`

### Phase 3: Dashboard — ~1 day
- [ ] Bun.serve with inline HTML + htmx
- [ ] SSE endpoint with PR state updates
- [ ] Status badges, PR links, tool status
- [ ] `the-reviewer dashboard` command

### Phase 4: Polish — ~1 day
- [ ] Graceful shutdown / signal handling
- [ ] Stale worktree cleanup scheduler
- [ ] Output aggregation (concatenate + AI-merge)
- [ ] Snooze / re-notify logic
- [ ] Error recovery and retry
- [ ] Logging system
- [ ] Homebrew formula

---

## 9. Dependencies

### Runtime
- **Bun** ≥ 1.1 (runtime, package manager, bundler, SQLite)

### External Tools (Homebrew)
- **`gh`** — GitHub CLI (authentication + API calls)
- **`alerter`** — macOS actionable notifications (`brew install vjeantet/tap/alerter`)
- **`git`** — repo management, worktrees

### npm packages (minimal)
- **`yaml`** — YAML parsing for config files
- **`mustache`** or **`handlebars`** — prompt template rendering
- **`commander`** or **`citty`** — CLI argument parsing

Zero frontend dependencies (htmx inlined).

---

## 10. Open Design Decisions

| Question | Current Default | Notes |
|----------|----------------|-------|
| Max PR diff size | 100KB | Large diffs may exceed tool context windows. Truncate with warning? |
| Auto-post reviews to GitHub | No | Start with local-only output. Add `--post` flag later. |
| Config hot-reload | Yes (fs.watch) | Watch config files, reload on change with debounce |
| Daemon vs foreground | Daemon (background) | `start` backgrounds, `run` for foreground mode |
| Output format | Markdown | Could support JSON for programmatic consumption |
| Notification for completed reviews | Yes | Configurable per-user preference |
