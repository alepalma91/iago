# Iago — AI PR Review Daemon

## Quick Reference

- **Runtime**: Bun (TypeScript, no build step)
- **Tests**: `bun test` — 161 tests, all must pass before any restart
- **Start daemon**: `bun run src/index.ts start`
- **Menubar build**: `make menubar-build` (uses `swiftc`, NOT `swift build`)
- **Menubar install + restart**: `make menubar-install && launchctl unload ~/Library/LaunchAgents/com.iago.menubar.plist && launchctl load ~/Library/LaunchAgents/com.iago.menubar.plist`
- **Dashboard**: http://localhost:1460
- **Database**: `~/.local/share/iago/iago.db` (SQLite)
- **Config**: `~/.config/iago/config.yaml`

## PR Status Lifecycle

```
detected → notified → accepted → cloning → reviewing → done
                                                        ├→ changes_requested (waiting for author)
                                                        ├→ error
                                                        └→ dismissed
```

## Key Architecture Decisions

- **GitHub state sync**: Bulk sync at startup (`getAllPRsForSync`), incremental during polling (`getSyncablePRs` with LIMIT 10 + 5-min cooldown)
- **Auto-dismiss**: Only dismisses `notified/detected` PRs when review request removed AND we haven't reviewed (`!reviewRequestedByMe && !reviewedByMe`)
- **Menubar singleton**: POSIX file lock at `~/.local/share/iago/iago-bar.lock`, managed by launchd with KeepAlive
- **Dashboard sections**: All / To Review / In Progress / Recent — section tabs set multi-select filters
- **PAGE_SIZE = 10** for dashboard pagination

## Important Files

| File | Purpose |
|------|---------|
| `src/commands/start.ts` | Daemon entry: startup sync, polling, auto-dismiss |
| `src/core/poller.ts` | GitHub API: fetchPRGitHubStatus, getCurrentGithubUser |
| `src/core/dashboard.ts` | Web dashboard (HTML + API + SSE) |
| `src/db/queries.ts` | All SQL queries and Queries interface |
| `src/types/pr.ts` | PRStatus, GitHubState types |
| `extras/menubar/` | Swift menubar app (build with Makefile, NOT SPM) |

## Conventions

- No emojis in code/output unless asked
- Run `bun test` before deploying changes
- Kill daemon by PID (`ps aux | grep "src/index.ts start"`), restart with full bun path
- Menubar app must be restarted via launchd after rebuild
