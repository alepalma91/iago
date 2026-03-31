# Iago — AI PR Review Daemon

## Quick Reference

- **Runtime**: Bun (TypeScript, no build step)
- **Tests**: `bun test` — 162 tests, all must pass before any restart
- **Start daemon**: `bun run src/index.ts start`
- **Compile binary**: `bun build --compile --minify src/index.ts --outfile ~/bin/iago`
- **Menubar build**: `make menubar-build` (uses `swiftc`, NOT `swift build`)
- **Menubar install + restart**: `make menubar-install && launchctl unload ~/Library/LaunchAgents/com.iago.menubar.plist && launchctl load ~/Library/LaunchAgents/com.iago.menubar.plist`
- **Dashboard**: http://localhost:1460
- **Database**: `~/.local/share/iago/iago.db` (SQLite, migration v5)
- **Config**: `~/.config/iago/config.yaml`
- **Repo**: `alepalma91/iago` (private), single `origin` remote
- **Homebrew tap**: `alepalma91/homebrew-iago` (public, prebuilt binaries)

## Install & Release

```bash
# User install
brew tap alepalma91/iago && brew install iago

# Script install (private repo)
gh api repos/alepalma91/iago/contents/install.sh --jq .content | base64 -d | bash

# Release workflow
bun build --compile --minify src/index.ts --outfile iago
make menubar-build && cp extras/menubar/.build/IagoBar iago-bar
tar -czf iago-VERSION-darwin-arm64.tar.gz iago iago-bar system.md instructions.md
gh release create vX.Y.Z FILE.tar.gz
# Then update SHA + version in homebrew-iago formula
```

## PR Status Lifecycle

```
detected → notified → accepted → cloning → reviewing → done
                                                        ├→ changes_requested → updated → (re-review)
                                                        ├→ error
                                                        └→ dismissed
```

## Key Architecture Decisions

- **GitHub state sync**: Bulk sync at startup (`getAllPRsForSync`), incremental during polling (`getSyncablePRs` with LIMIT 10 + 5-min cooldown)
- **Auto-dismiss**: Only dismisses `notified/detected` PRs when review request removed AND we haven't reviewed (`!reviewRequestedByMe && !reviewedByMe`)
- **Menubar singleton**: POSIX file lock at `~/.local/share/iago/iago-bar.lock`, managed by launchd with KeepAlive
- **Dashboard sections**: All / To Review (sorted by opened_at) / In Progress / Recent
- **PAGE_SIZE = 10** for dashboard pagination, `table-layout: fixed`
- **Process tracking**: `session_id` + `pid` columns, in-memory process registry
- **Prompt resolution**: `loadPromptFile(path, basePath?)` resolves `~/` and relative paths against worktree
- **Compiled binary**: Use `process.execPath` (not `process.argv[0]`) for self-spawning
- **Config merge**: DEFAULT → global config.yaml → repos[match] → .iago/config.yaml (4 layers)

## Important Files

| File | Purpose |
|------|---------|
| `src/commands/start.ts` | Daemon entry: startup sync, polling, auto-dismiss |
| `src/commands/attach.ts` | `iago attach <id>` — resume Claude session interactively |
| `src/commands/uninstall.ts` | `iago uninstall` — remove binaries, config, data, PATH |
| `src/core/poller.ts` | GitHub API: fetchPRGitHubStatus, getCurrentGithubUser |
| `src/core/dashboard.ts` | Web dashboard (HTML + API + SSE) |
| `src/core/pipeline.ts` | Review pipeline: clone → prompt → tools → comments |
| `src/core/prompt.ts` | Prompt assembly and file loading (supports basePath) |
| `src/core/process-registry.ts` | In-memory active process Map |
| `src/core/config.ts` | Config loading, 4-layer merge, glob matching |
| `src/db/queries.ts` | All SQL queries and Queries interface |
| `src/types/pr.ts` | PRStatus, GitHubState types |
| `extras/menubar/` | Swift menubar app (build with Makefile, NOT SPM) |
| `install-prompts/` | Default prompts shipped with binary |
| `install.sh` | Script installer (auto-installs deps + prompts) |

## Conventions

- No emojis in code/output unless asked
- Run `bun test` before deploying changes
- Kill daemon by PID (`ps aux | grep "src/index.ts start"`), restart with full bun path
- Menubar app must be restarted via launchd after rebuild
- Dashboard UI: consistent 2-button layout per row (primary + chevron)
