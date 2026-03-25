# 03 - Sandbox Environment, CLI Launcher & Configuration Architecture

## Overview

This document defines three core subsystems of **the-reviewer**: the sandbox isolation layer for safe PR review, the CLI launcher that orchestrates multiple AI review tools in parallel, and the YAML-based configuration system that ties everything together.

---

## 1. Sandbox Environment

### 1.1 Strategy: Git Worktrees (Primary) + Shallow Clone (Fallback)

**Git worktrees** are the primary isolation mechanism. They share the `.git` object store with the main repo, making them fast to create (sub-second) and disk-efficient (only new/changed files are written). Each concurrent PR review gets its own worktree.

**Fallback**: If the repo is not yet cloned locally (first-time review of a new repo), we perform a **shallow clone** (`--depth=1 --single-branch`) into a reference cache, then create worktrees from that.

### 1.2 Directory Layout

```
~/.local/share/the-reviewer/
  repos/                        # Reference repo cache (bare clones)
    github.com/
      owner/
        repo.git/               # Bare reference clone (shared object store)
  worktrees/                    # Active review worktrees
    github.com/
      owner/
        repo/
          pr-1234/              # Worktree for PR #1234
          pr-5678/              # Worktree for PR #5678
  output/                       # Review output capture
    github.com/
      owner/
        repo/
          pr-1234/
            claude.md           # Output from claude
            gemini.md           # Output from gemini
            codex.md            # Output from codex
            aggregated.md       # Merged/aggregated review
```

### 1.3 Lifecycle

```
┌─────────────────────────────────────────────────────────────┐
│                    Sandbox Lifecycle                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  1. ENSURE REFERENCE REPO                                   │
│     ├─ If bare clone exists: git fetch origin               │
│     └─ If not: git clone --bare --filter=blob:none <url>    │
│                                                             │
│  2. CREATE WORKTREE                                         │
│     git worktree add ../worktrees/.../pr-{N} pr-branch      │
│     (from reference bare repo)                              │
│                                                             │
│  3. PREPARE ENVIRONMENT                                     │
│     ├─ Checkout the PR's head commit (detached HEAD)        │
│     ├─ Generate diff: git diff main...HEAD > pr.diff        │
│     └─ Optionally install deps (if configured)              │
│                                                             │
│  4. RUN REVIEW TOOLS (parallel)                             │
│     ├─ Launch configured tools in worktree cwd              │
│     ├─ Capture stdout/stderr per tool                       │
│     └─ Enforce per-tool timeout                             │
│                                                             │
│  5. COLLECT & AGGREGATE OUTPUT                              │
│     ├─ Save per-tool output to output dir                   │
│     └─ Run aggregation step (if configured)                 │
│                                                             │
│  6. CLEANUP                                                 │
│     ├─ git worktree remove ../worktrees/.../pr-{N}          │
│     └─ Prune: git worktree prune                            │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 1.4 Implementation Notes

| Concern | Approach |
|---------|----------|
| **Speed** | Bare clones with `--filter=blob:none` (blobless) fetch only needed blobs on checkout. Worktree creation is O(ms). |
| **Disk** | Worktrees share the object store. A repo with 10 concurrent PR reviews uses ~1x disk for objects. |
| **Parallel safety** | Each worktree is an independent directory. Multiple tools can read the same worktree concurrently (review tools are read-only). |
| **Stale cleanup** | A periodic sweep removes worktrees older than `sandbox.ttl` (default: 24h). Also triggered on startup. |
| **Lock files** | Worktree lock mechanism prevents accidental removal of in-use worktrees (`git worktree lock`). |
| **Network** | Fetches are batched: one `git fetch` per repo per poll cycle, not per PR. |

### 1.5 Shallow Clone Fallback

For repos not yet in the reference cache, or when the user disables worktrees:

```bash
# First-time: create reference bare clone
git clone --bare --filter=blob:none https://github.com/owner/repo.git \
  ~/.local/share/the-reviewer/repos/github.com/owner/repo.git

# Subsequent: fetch latest
cd ~/.local/share/the-reviewer/repos/github.com/owner/repo.git
git fetch origin '+refs/pull/*/head:refs/pull/*/head'
```

If worktrees are disabled in config (`sandbox.strategy: shallow-clone`), we fall back to:

```bash
git clone --depth=1 --single-branch --branch pr-branch <url> /tmp/the-reviewer/pr-1234
```

This is slower and uses more disk but works without a persistent reference repo.

---

## 2. CLI Launcher System

### 2.1 Design Philosophy

The launcher is a **process orchestrator** that runs multiple AI review tools in parallel against the same PR diff. Each tool is defined as a **launcher profile** in YAML, specifying the command template, arguments, environment variables, and timeout.

### 2.2 Launcher Profile Schema

```yaml
# A single launcher profile
name: string              # Unique identifier (e.g., "claude", "gemini", "codex")
display_name: string      # Human-readable name for output
command: string           # Executable path or command name
args: string[]            # Argument template (supports variable interpolation)
env: map[string, string]  # Additional environment variables
stdin_mode: enum          # "pipe" | "file" | "none"
                          # - pipe: stream prompt via stdin
                          # - file: write prompt to temp file, pass path as arg
                          # - none: prompt is embedded in args
output_mode: enum         # "stdout" | "file" | "json"
                          # - stdout: capture stdout as review text
                          # - file: tool writes to a file, we read it
                          # - json: parse structured JSON from stdout
output_file: string       # Path template (if output_mode is "file")
timeout: duration         # Max execution time (e.g., "5m", "300s")
retry: object             # Retry policy
  max_attempts: int       # Default: 1 (no retry)
  delay: duration         # Delay between retries
enabled: boolean          # Can be toggled on/off (default: true)
```

### 2.3 Built-in Launcher Profiles

```yaml
launchers:
  claude:
    display_name: "Claude Code"
    command: "claude"
    args:
      - "-p"
      - "{{prompt}}"
      - "--output-format"
      - "text"
    stdin_mode: "none"
    output_mode: "stdout"
    timeout: "5m"
    env:
      CLAUDE_CODE_HEADLESS: "1"

  gemini:
    display_name: "Gemini CLI"
    command: "gemini"
    args:
      - "-p"
      - "{{prompt}}"
    stdin_mode: "none"
    output_mode: "stdout"
    timeout: "5m"

  codex:
    display_name: "Codex CLI"
    command: "codex"
    args:
      - "exec"
      - "--prompt"
      - "{{prompt}}"
      - "--json"
    stdin_mode: "none"
    output_mode: "json"
    timeout: "5m"
    env:
      CODEX_QUIET: "1"

  # Custom alias example: a wrapped Claude with special flags
  clauded-at:
    display_name: "Claude (Deep Analysis)"
    command: "claude"
    args:
      - "-p"
      - "{{prompt}}"
      - "--output-format"
      - "text"
      - "--model"
      - "opus"
    stdin_mode: "none"
    output_mode: "stdout"
    timeout: "10m"
    env:
      CLAUDE_CODE_HEADLESS: "1"
```

### 2.4 Variable Interpolation

Templates in `args` support these variables:

| Variable | Description |
|----------|-------------|
| `{{prompt}}` | The fully assembled review prompt (system + instructions + diff) |
| `{{diff_file}}` | Path to the PR diff file |
| `{{worktree}}` | Path to the sandbox worktree |
| `{{pr_number}}` | PR number |
| `{{pr_url}}` | Full PR URL |
| `{{repo}}` | Repository name (owner/repo) |
| `{{branch}}` | PR branch name |
| `{{base_branch}}` | Target branch (e.g., main) |

### 2.5 Execution Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                   Launcher Orchestrator                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Input: PR metadata + diff + resolved prompt                │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ claude   │  │ gemini   │  │ codex    │  ← parallel      │
│  │ (spawn)  │  │ (spawn)  │  │ (spawn)  │    child procs   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       │              │              │                        │
│       ▼              ▼              ▼                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                  │
│  │ stdout   │  │ stdout   │  │ JSON     │  ← output        │
│  │ capture  │  │ capture  │  │ parse    │    collection     │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                  │
│       │              │              │                        │
│       └──────────────┼──────────────┘                       │
│                      ▼                                      │
│              ┌──────────────┐                                │
│              │  Aggregator  │                                │
│              │  (optional)  │                                │
│              └──────────────┘                                │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

### 2.6 Process Management

**Spawning**: Use Node.js `child_process.spawn()` with:
- `cwd` set to the worktree path
- `env` merged from process.env + launcher env + review-specific vars
- `stdio: ['pipe', 'pipe', 'pipe']` for full I/O control

**Concurrency Control**:
- Default: run all enabled launchers in parallel (`Promise.allSettled()`)
- Configurable concurrency limit: `launcher.max_parallel` (default: 4)
- Use a semaphore/queue pattern to limit concurrent spawns

**Timeout Handling**:
```typescript
// Pseudocode
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), launcher.timeout);
const proc = spawn(cmd, args, { signal: controller.signal, cwd: worktree });
```

**Lifecycle Events** (emitted for monitoring/logging):
- `launcher:start` - tool process spawned
- `launcher:stdout` - incremental output received
- `launcher:complete` - tool finished successfully
- `launcher:timeout` - tool exceeded timeout, killed
- `launcher:error` - tool exited with non-zero code
- `launcher:retry` - retrying after failure

**Output Collection**:
- Stream stdout/stderr into memory buffers (bounded: max 10MB per tool)
- On completion, write to `output/{repo}/{pr}/{tool}.md`
- Structured output (JSON mode) is parsed and normalized

---

## 3. Configuration System

### 3.1 Config Directory Structure

```
~/.config/the-reviewer/
  config.yaml                 # Global configuration
  prompts/
    default-system.md         # Default system prompt
    default-instructions.md   # Default review instructions
    security-review.md        # Technique: security-focused prompt
    perf-review.md            # Technique: performance-focused prompt
  launchers/
    custom-tool.yaml          # User-defined launcher profiles

# Per-repo config (lives in the target repo)
<repo-root>/
  .the-reviewer/
    config.yaml               # Repo-specific overrides
    prompts/
      system.md               # Repo-specific system prompt
      instructions.md         # Repo-specific review instructions
      rust-safety.md          # Repo-specific technique
```

### 3.2 Global Config Schema (`~/.config/the-reviewer/config.yaml`)

```yaml
# =============================================================================
# the-reviewer: Global Configuration
# =============================================================================

# -- GitHub Integration -------------------------------------------------------
github:
  # Polling interval for new notifications
  poll_interval: "60s"
  # Filter: which notification reasons trigger a review
  trigger_reasons:
    - "review_requested"
    - "mention"
    - "assign"
  # Filter: only watch specific repos (empty = all repos)
  watched_repos: []
  # Filter: ignore repos
  ignored_repos:
    - "owner/ignored-repo"
  # GitHub API token (or set GITHUB_TOKEN env var)
  # token: "ghp_..."  # Prefer env var over config file

# -- Sandbox ------------------------------------------------------------------
sandbox:
  # Strategy: "worktree" (default) or "shallow-clone"
  strategy: "worktree"
  # Base directory for reference repos and worktrees
  base_dir: "~/.local/share/the-reviewer"
  # Time-to-live for worktrees before auto-cleanup
  ttl: "24h"
  # Run cleanup on startup
  cleanup_on_start: true
  # Fetch PR refs pattern
  fetch_pr_refs: true

# -- Launchers ----------------------------------------------------------------
launchers:
  # Maximum tools running in parallel per review
  max_parallel: 3

  # Default tools to run (by name). Order determines output order.
  default_tools:
    - "claude"
    - "gemini"

  # Tool definitions (built-ins can be overridden here)
  tools:
    claude:
      display_name: "Claude Code"
      command: "claude"
      args: ["-p", "{{prompt}}", "--output-format", "text"]
      stdin_mode: "none"
      output_mode: "stdout"
      timeout: "5m"
      enabled: true

    gemini:
      display_name: "Gemini CLI"
      command: "gemini"
      args: ["-p", "{{prompt}}"]
      stdin_mode: "none"
      output_mode: "stdout"
      timeout: "5m"
      enabled: true

    codex:
      display_name: "Codex CLI"
      command: "codex"
      args: ["exec", "--prompt", "{{prompt}}", "--json"]
      stdin_mode: "none"
      output_mode: "json"
      timeout: "5m"
      enabled: false  # Disabled by default, enable per-repo

    # Custom tool example
    clauded-at:
      display_name: "Claude Deep Analysis"
      command: "claude"
      args: ["-p", "{{prompt}}", "--output-format", "text", "--model", "opus"]
      stdin_mode: "none"
      output_mode: "stdout"
      timeout: "10m"
      enabled: false

# -- Prompts ------------------------------------------------------------------
prompts:
  # Path to the system prompt file
  system_prompt: "~/.config/the-reviewer/prompts/default-system.md"

  # Path to the default review instructions
  instructions: "~/.config/the-reviewer/prompts/default-instructions.md"

  # Named review techniques (can be combined)
  techniques:
    security:
      description: "Security-focused review (OWASP, injection, auth)"
      prompt_file: "~/.config/the-reviewer/prompts/security-review.md"
    performance:
      description: "Performance-focused review (complexity, allocations, caching)"
      prompt_file: "~/.config/the-reviewer/prompts/perf-review.md"
    testing:
      description: "Test coverage and quality review"
      prompt_file: "~/.config/the-reviewer/prompts/testing-review.md"

  # Default techniques applied to every review (can be overridden per-repo)
  default_techniques: []

  # Template for assembling the final prompt sent to tools
  # Variables: {{system_prompt}}, {{instructions}}, {{techniques}}, {{diff}},
  #            {{pr_title}}, {{pr_body}}, {{pr_url}}, {{file_list}}
  assembly_template: |
    {{system_prompt}}

    ## Review Instructions
    {{instructions}}

    {{#if techniques}}
    ## Additional Focus Areas
    {{techniques}}
    {{/if}}

    ## Pull Request
    **Title**: {{pr_title}}
    **URL**: {{pr_url}}

    ### Changed Files
    {{file_list}}

    ### Diff
    ```diff
    {{diff}}
    ```

# -- Notifications ------------------------------------------------------------
notifications:
  # Enable macOS native notifications
  native: true
  # Notification events
  on_new_pr: true
  on_review_complete: true
  on_review_error: true
  # Sound
  sound: "default"  # "default", "none", or path to .aiff

# -- Dashboard ----------------------------------------------------------------
dashboard:
  enabled: true
  port: 3847
  # Auto-open browser on first review
  auto_open: false

# -- Output & Formatting ------------------------------------------------------
output:
  # Where to store review outputs
  dir: "~/.local/share/the-reviewer/output"
  # Format for individual tool outputs
  format: "markdown"  # "markdown" | "json"
  # Enable output aggregation (combine multiple tool reviews)
  aggregate: true
  # Aggregation strategy
  aggregation_strategy: "concatenate"  # "concatenate" | "ai-merge"
  # AI merge tool (if aggregation_strategy is "ai-merge")
  aggregation_tool: "claude"
```

### 3.3 Per-Repo Config Schema (`<repo>/.the-reviewer/config.yaml`)

Per-repo config uses **the same schema** but only includes overridden fields. Values are deep-merged with the global config (repo wins on conflict).

```yaml
# =============================================================================
# the-reviewer: Per-Repo Configuration
# =============================================================================
# This file overrides global settings for this specific repository.
# Only include fields you want to change.

# -- Launchers ----------------------------------------------------------------
# Override which tools are used for this repo
launchers:
  default_tools:
    - "claude"
    - "codex"
    - "clauded-at"  # Enable deep analysis for this critical repo

  tools:
    codex:
      enabled: true  # Enable codex for this repo
    clauded-at:
      enabled: true

# -- Prompts ------------------------------------------------------------------
prompts:
  # Repo-specific system prompt (overrides global)
  system_prompt: ".the-reviewer/prompts/system.md"

  # Repo-specific review instructions
  instructions: ".the-reviewer/prompts/instructions.md"

  # Repo-specific techniques
  techniques:
    rust-safety:
      description: "Rust-specific safety review (unsafe blocks, lifetimes, Send/Sync)"
      prompt_file: ".the-reviewer/prompts/rust-safety.md"

  # Apply these techniques to every review in this repo
  default_techniques:
    - "security"       # From global config
    - "rust-safety"    # From repo config

# -- Sandbox ------------------------------------------------------------------
# Optionally override sandbox settings per repo
sandbox:
  # Some repos may need deps installed before review
  post_checkout:
    - "cargo fetch"
```

### 3.4 Config Resolution Order

Configuration is resolved with the following precedence (highest wins):

```
1. CLI flags            (--tool=claude --timeout=10m)
2. Per-repo config      (<repo>/.the-reviewer/config.yaml)
3. Global config        (~/.config/the-reviewer/config.yaml)
4. Built-in defaults    (hardcoded in source)
```

**Deep merge rules**:
- Scalars: higher precedence wins
- Arrays: higher precedence **replaces** (not appends) - use explicit `+append` syntax to append
- Maps: recursively merged (keys from higher precedence override matching keys)

```yaml
# Example: appending to an array instead of replacing
launchers:
  default_tools:
    - "+claude"        # Prepend: keep existing tools, add claude at start
    - "+codex"         # Append: add codex at end
```

### 3.5 Prompt Assembly

The final prompt sent to each tool is assembled from multiple sources:

```
┌────────────────┐     ┌────────────────┐     ┌───────────────┐
│ System Prompt   │ +   │ Instructions   │ +   │ Techniques    │
│ (global or repo)│     │ (global/repo)  │     │ (selected)    │
└───────┬────────┘     └───────┬────────┘     └──────┬────────┘
        │                      │                      │
        └──────────────────────┼──────────────────────┘
                               │
                      ┌────────▼────────┐
                      │ Assembly        │
                      │ Template        │
                      │ + PR metadata   │
                      │ + diff          │
                      └────────┬────────┘
                               │
                      ┌────────▼────────┐
                      │ Final Prompt    │
                      │ (per tool)      │
                      └─────────────────┘
```

**Example system prompt** (`prompts/default-system.md`):
```markdown
You are an expert code reviewer. You review pull requests for correctness,
security, performance, and maintainability. You provide actionable feedback
with specific line references. You are concise and prioritize the most
impactful issues.
```

**Example instructions** (`prompts/default-instructions.md`):
```markdown
Review the following pull request diff. For each issue found:
1. State the severity: CRITICAL, WARNING, or SUGGESTION
2. Reference the specific file and line(s)
3. Explain the issue clearly
4. Suggest a concrete fix

Focus on:
- Bugs and logic errors
- Security vulnerabilities
- Performance regressions
- API contract violations
- Missing error handling
```

**Example technique** (`prompts/security-review.md`):
```markdown
Additionally, pay special attention to security concerns:
- SQL injection and parameterized queries
- XSS and output encoding
- Authentication and authorization checks
- Sensitive data exposure (secrets, PII in logs)
- CSRF protections
- Input validation at trust boundaries
```

### 3.6 Config Validation

On startup and config reload, validate against a JSON Schema:

- All referenced prompt files exist and are readable
- All launcher commands are resolvable in PATH
- Timeout values parse correctly
- No circular technique references
- Port numbers are valid
- Paths expand correctly (`~` expansion)

Emit clear error messages pointing to the exact YAML line on validation failure.

---

## 4. Putting It All Together: Review Flow

```
 GitHub Notification: "review_requested on owner/repo#42"
    │
    ▼
 ┌──────────────────────┐
 │ 1. Resolve Config     │  Merge: defaults + global + repo config
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐
 │ 2. Ensure Reference   │  git clone --bare (if first time)
 │    Repo               │  git fetch origin (if exists)
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐
 │ 3. Create Worktree    │  git worktree add .../pr-42 <sha>
 │                       │  git diff main...HEAD > pr.diff
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐
 │ 4. Assemble Prompt    │  system + instructions + techniques + diff
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐
 │ 5. Launch Tools       │  Parallel: claude, gemini, codex
 │    (in worktree cwd)  │  Each with assembled prompt
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐
 │ 6. Collect Output     │  Per-tool: capture stdout → .md
 │                       │  Aggregate: concatenate or AI merge
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐
 │ 7. Notify User        │  macOS notification + dashboard update
 └──────────┬───────────┘
            │
            ▼
 ┌──────────────────────┐
 │ 8. Cleanup Worktree   │  git worktree remove (after TTL or manual)
 └──────────────────────┘
```

---

## 5. Key Design Decisions & Rationale

| Decision | Rationale |
|----------|-----------|
| **Worktrees over containers** | Sub-second creation, shared object store, no Docker dependency. Review tools are read-only so no isolation concerns. |
| **Bare reference clones** | Blobless `--filter=blob:none` keeps initial clone small. Blobs fetched on-demand during checkout. One clone per repo, shared across all PRs. |
| **Launcher profiles in YAML** | Users can define any CLI tool without code changes. Variable interpolation makes profiles flexible. |
| **`child_process.spawn`** | Streams output in real-time (vs `exec` which buffers). `AbortController` provides clean timeout. |
| **Prompt assembly template** | Separating system prompt, instructions, and techniques allows mix-and-match composition per repo. Handlebars-style templates are familiar. |
| **Config in `~/.config/`** | Follows XDG Base Directory spec. Repo config in `.the-reviewer/` is gitignore-friendly. |
| **Deep merge with replace arrays** | Predictable override semantics. Explicit `+append` syntax when appending is intentional. |
| **Output to `~/.local/share/`** | Follows XDG for user data. Separates config (small, backed up) from data (large, transient). |

---

## 6. Open Questions

1. **PR diff size limits**: Should we truncate diffs beyond a certain size (e.g., 100KB)? Large diffs may exceed tool context windows.
2. **Dependency installation**: Should `post_checkout` commands run in every review, or only when explicitly enabled? (Current: only when configured per-repo.)
3. **AI-merge aggregation**: If using one tool to merge outputs from others, which tool should be the default aggregator? (Current: configurable, defaults to `claude`.)
4. **GitHub comment posting**: Should the tool auto-post reviews as PR comments, or only show them in the dashboard? (Deferred to notification/dashboard design.)
5. **Config hot-reload**: Should the daemon watch config files for changes, or require restart? (Recommend: watch with debounce.)
