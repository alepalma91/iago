# the-reviewer

A macOS CLI daemon that watches GitHub for PR review assignments and launches configurable AI review tools (Claude, Gemini, Codex, or any CLI tool) in parallel against the PR diff.

## Prerequisites

- [Bun](https://bun.sh/) >= 1.1
- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated with `gh auth login`
- [alerter](https://github.com/vjeantet/alerter) — `brew install vjeantet/tap/alerter`
- At least one review tool CLI installed (e.g., `claude`, `gemini`, `codex`)

## Installation

```bash
git clone https://github.com/your-org/the-reviewer.git
cd the-reviewer
bun install
```

## Usage

```bash
# Start the daemon (polls GitHub for review requests)
bun run src/index.ts start

# Check active PR reviews
bun run src/index.ts status

# Stop the daemon
bun run src/index.ts stop
```

## Configuration

Create `~/.config/the-reviewer/config.yaml` to customize behavior:

```yaml
github:
  poll_interval: "60s"
  ignored_repos:
    - "org/legacy-repo"

launchers:
  max_parallel: 3
  default_tools:
    - "claude"
  tools:
    claude:
      command: "claude"
      args: ["-p", "{{prompt}}", "--output-format", "text"]
      timeout: "5m"
      enabled: true
```

See `docs/ARCHITECTURE.md` for the full configuration schema and architecture details.

## Development

```bash
# Run tests
bun test

# Run tests in watch mode
bun test --watch
```

## How It Works

1. Polls GitHub notifications for `review_requested` events
2. Shows a macOS notification with Accept/View/Snooze/Dismiss actions
3. On accept: clones the repo (bare reference + worktree), generates the diff
4. Assembles a review prompt and launches configured AI tools in parallel
5. Captures output from each tool and stores it locally

## Architecture

See `docs/ARCHITECTURE.md` for the complete architecture document.
