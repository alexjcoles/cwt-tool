# cwt — Claude Worktree Tool

Run 1–5 Claude Code instances in parallel against the same repo. Each Claude gets its own git worktree, its own Docker dev container, its own Postgres, its own port block — no filesystem, DB, or process collisions.

> **Status:** Milestone 1 (CLI + container bootstrap). M2 (channel MCP server + status pipeline) and M3 (TUI dashboard + permission relay) are planned. See `CLAUDE.md` for architecture.

## Requirements

- [Bun](https://bun.sh) ≥ 1.1
- Docker + Docker Compose
- `git` 2.5+ (for `git worktree`)
- `tmux` (host-side optional; required inside the dev container, which the bundled Dockerfile installs)

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

## Usage

```bash
# Create a new worktree + dev container
cwt new amphtt-864-modular

# List worktrees and their state
cwt list

# Attach to the container's tmux session
cwt attach amphtt-864-modular
# (Inside: launch claude in the tmux pane.)

# Tear it all down
cwt rm amphtt-864-modular
```

The first `cwt new` will build the dev container image (~2-5 minutes). Subsequent worktrees reuse the image and shared bundle/cargo caches.

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
| State entry | `~/.cwt/state.json` |

## What's NOT in M1

- **Channel MCP server** for status / permission relay (M2)
- **TUI dashboard** that aggregates all worktrees (M3)
- **Linear integration** for issue title display (M4)

## Development

```bash
bun test            # run tests
bun run typecheck   # tsc --noEmit
```

## Repository layout

```
bin/cwt                          # Bun shebang entry point
src/
  cli.ts                         # commander dispatcher
  state.ts                       # ~/.cwt/state.json
  worktree.ts                    # git worktree + compose orchestration
  compose.ts                     # docker compose wrapper
  template.ts                    # eta template renderer
  util.ts                        # paths, exec, logging, name validation
templates/
  docker-compose.yml.eta         # per-worktree compose file
  Dockerfile                     # dev container (Ruby/Node/Bun/Rust)
tests/                           # bun test files
```
