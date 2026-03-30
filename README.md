# iago

AI-powered PR review daemon for macOS. Watches GitHub for PR review requests and automatically reviews them using Claude Code.

## Install

### Homebrew (recommended)

```bash
brew tap alepalma91/iago
brew install iago
iago setup
```

### Script

```bash
curl -fsSL https://raw.githubusercontent.com/alepalma91/iago/main/install.sh | bash
```

### From source

```bash
git clone https://github.com/alepalma91/iago.git
cd iago
bun install
bun run src/index.ts setup
```

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) — authenticated with `gh auth login`
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`claude`)

## Usage

```bash
iago start       # Start the daemon
iago stop        # Stop the daemon
iago status      # Show active PR reviews
iago review <url> # Manually review a PR
iago dashboard   # Start the web dashboard
iago setup       # Interactive setup wizard
```

## Configuration

Config lives at `~/.config/iago/config.yaml`. Run `iago setup` to create it interactively, or `iago config init` for defaults.

```yaml
github:
  poll_interval: "60s"
  watched_repos: []          # empty = all repos
  ignored_repos: []

launchers:
  max_parallel: 3
  default_tools:
    - claude

dashboard:
  enabled: true
  port: 1460

# Per-repo overrides
repos:
  "org/repo":
    auto_review: true
```

## Development

```bash
bun test          # Run all tests
bun test --watch  # Watch mode
make compile      # Build standalone binary
make dist         # Build distributable tarball
```

## How It Works

1. Polls GitHub for PR review requests assigned to you
2. Shows a macOS notification with Accept/Dismiss actions
3. On accept: clones the repo via bare reference + worktree, generates the diff
4. Assembles a review prompt and launches Claude Code
5. Posts review comments back to GitHub
6. Tracks PR lifecycle: detects author pushes, auto-dismisses merged/closed PRs

## Dashboard

Web UI at `http://localhost:1460` with sections for To Review, In Progress, and Recent reviews. Live updates via SSE.

## Menu Bar App

Native macOS menu bar app showing review status. Build with `make menubar-install`.
