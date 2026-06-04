# cwt — Claude Worktree Tool

Run 1–5 Claude Code instances in parallel against the same repo. Each Claude gets its own git worktree, its own Docker dev container, its own Postgres, its own port block — no filesystem, DB, or process collisions. A live TUI dashboard aggregates every worktree, relays status/permission/decision prompts back to you, and lets you attach to any Claude with a keystroke.

Built for the patentsafe-ai (Rails 8.1) rewrite, with optional mounts for the patentsafe Java reference repo and a documents dataset.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Docker + Docker Compose
- `git` 2.5+ (for `git worktree`)
- `tmux` (host-side optional; required inside the dev container, which the bundled Dockerfile installs)
- `node` on the host (the channel MCP server is built to a Node target and runs inside the container)

## Install

```bash
git clone https://github.com/alexjcoles/cwt-tool ~/cwt-tool
cd ~/cwt-tool
bun install
```

Either run via `bun`:

```bash
bun run cwt --help
```

…or symlink onto your `$PATH`:

```bash
ln -s ~/cwt-tool/bin/cwt ~/.local/bin/cwt
```

The channel MCP server that ships into each container is prebuilt with:

```bash
bun run build:channel
```

## Usage

```bash
# Create a new worktree + dev container
cwt new amphtt-864-modular

# List worktrees and their state
cwt list            # alias: cwt ls

# Open the TUI dashboard (recommended driver for day-to-day work)
cwt dashboard

# Attach to a worktree's tmux session (claude in window 0, bash in window 1)
cwt attach amphtt-864-modular

# Run a one-shot command inside a worktree's container
cwt exec amphtt-864-modular bin/rails test

# See what each Claude is reporting via the channel
cwt status

# Tail a worktree's activity log
cwt logs amphtt-864-modular -f

# Tear it all down (use -b to return immediately and tear down in the background)
cwt rm amphtt-864-modular
cwt rm amphtt-864-modular -b

# Clean up docker resources for worktrees no longer tracked in state
cwt prune
```

The first `cwt new` builds the dev container image (~2–5 minutes). Subsequent worktrees reuse the image and shared bundle/cargo caches.

### `cwt new` options

| Flag | Purpose |
|---|---|
| `-b, --branch <branch>` | Branch name (defaults to the worktree name) |
| `--base <branch>` | Base branch to fork from (defaults to `main`/`master`). Fetches `origin` first and forks from `origin/<base>` so the new branch starts up to date |
| `-r, --repo-root <path>` | Path to the source git repo (defaults to cwd) |
| `-s, --service <name>` | Compose service name for the app container (default: `app`) |
| `-d, --data <path>` | Host documents dir to mount as `storage/repository` (auto-detects a `repository/` subdir so the per-worktree search index isn't shared) |
| `-j, --java-ref <path>` | Host path to the Java reference repo (auto-detected as a sibling `patentsafe/` if omitted) |
| `--no-features` | Skip devcontainer features/lifecycle even if `.devcontainer/devcontainer.json` exists |

## The dashboard

`cwt dashboard` opens a full-screen TUI that aggregates every worktree, polls each one's activity log, and surfaces prompts the Claudes raise through the channel.

```
↑↓ nav · ENTER attach · n new · x kill · v plan · g diff · b bash · d decide · m msg · p perm · q quit
```

- **Decision prompts** (`await_decision`) and **permission requests** pop as modals; answer them without leaving the dashboard. In a decision modal, **^V** opens the plan viewer (q/ESC returns to the prompt with your partial answer intact).
- **Killing a worktree** removes it from state immediately and tears the container/image/git registration down in a detached background process, so the dashboard stays responsive. Logs land in `~/.cwt/teardown-logs/<name>-<ts>.log`.
- Set `CWT_DEBUG=1` to write tick logs to `~/.cwt/dashboard-debug.log`.

## The channel (MCP)

Each container runs a `cwt-channel` MCP server that gives its Claude three tools, written to file-based IPC under `/var/cwt/<name>/` and read by the host dashboard / `cwt status`:

- `report_status(phase, summary, file?)` — phase changes (`working` / `waiting` / `blocked` / `done`)
- `note(message)` — freeform activity-feed entries
- `await_decision(question, options)` — blocks the Claude until you answer from the host

## Skills

The `skills/` directory holds the cwt workflow as Claude Code skills (symlink or copy into your skills dir):

- `/cwt-plan-minor` — generate a minor implementation plan for a Linear issue, stop for approval
- `/cwt-execute` — implement an approved plan commit-by-commit, then auto-chain into peer review
- `/cwt-agent-view` — automated cold peer-review pass; loops fix → re-review (max 3), then auto-pushes + opens the PR
- `/cwt-review-pr` — triage CI/bot review feedback, apply fixes, push, post replies
- `/cwt-java-explore` — explore the Java reference repo for behaviour parity

## What gets created

For a worktree named `foo`:

| Resource | Location |
|---|---|
| Worktree | `~/work/patentsafe/wt/foo/` |
| Branch | `foo` (or whatever you pass via `-b`) |
| Compose project | `cwt-foo` |
| Postgres DB | `patentsafe_wt_foo` (inside `cwt-foo`'s pg container) |
| Port block | next free 10-port slot starting at 3000 — Rails on `+0`, Vite on `+1`, Sidekiq on `+2`, channel HTTP on `+9` |
| Compose file | `~/work/patentsafe/wt/foo/.cwt/docker-compose.yml` |
| Channel IPC | `/var/cwt/foo/` (status, activity, decisions, permissions) |
| State entry | `~/.cwt/state.json` |

Shared external Docker volumes (`cwt-claude-config`, `cwt-gh-config`, `cwt-bundle-cache`, `cwt-cargo-registry`) carry Claude/gh auth and dependency caches across worktrees.

## Development

```bash
bun test            # run tests
bun run typecheck   # tsc --noEmit
bun run build:channel   # rebuild the in-container channel MCP server
```

## Repository layout

```
bin/cwt                          # Bun shebang entry point
src/
  cli.ts                         # commander dispatcher
  state.ts                       # ~/.cwt/state.json
  worktree.ts                    # git worktree + compose orchestration, teardown
  compose.ts                     # docker compose wrapper
  devcontainer.ts                # @devcontainers/cli features + lifecycle
  dashboard.ts                   # TUI dashboard (alt-screen, modals, IPC tailer)
  linear.ts                      # Linear issue-title lookup
  template.ts                    # eta template renderer
  util.ts                        # paths, exec, logging, name validation
channel/
  server.ts                      # cwt-channel MCP server (report_status/note/await_decision)
  hook.js                        # Claude Code hook bridging permissions to the host
templates/
  docker-compose.yml.eta         # per-worktree compose file
  Dockerfile                     # dev container (Ruby/Node/Bun/Rust)
  claude-settings.json.eta       # in-container Claude settings
  mcp.json.eta                   # registers cwt-channel inside the container
skills/                          # the cwt workflow as Claude Code skills
tests/                           # bun test files
```
