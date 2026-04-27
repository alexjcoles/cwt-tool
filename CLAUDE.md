# CWT - Claude Worktree Tool

CWT is a CLI for running 1-5 Claude Code instances in parallel, each in an isolated Docker dev container with its own git worktree. It orchestrates git worktree creation, Docker Compose environments, port allocation, and container lifecycle management so you can work on multiple branches simultaneously without conflicts.

## How to Run

```bash
bun install
bun run cwt help
bun run cwt new <worktree-name>
bun run cwt list
bun run cwt attach <worktree-name>
bun run cwt rm <worktree-name>
```

After `bun install` you can also invoke directly:

```bash
./bin/cwt help
```

## How to Test

```bash
bun test
bun run typecheck
```

## Architecture

- **Language**: TypeScript on Bun (single runtime across CLI + future channel server)
- **CLI framework**: `commander` for subcommand routing, `kleur` for colors
- **Templating**: `eta` for compose/Dockerfile template rendering
- **Container orchestration**: Docker Compose per worktree, each with its own app container and Postgres instance
- **State management**: JSON file at `~/.cwt/state.json` tracking active worktrees, port allocations, and compose project names
- **Port isolation**: Each worktree gets a 10-port block (3000-3009, 3010-3019, etc.) with gap reuse
- **Channel MCP server** (M2): Bun/TS HTTP+SSE server, one per worktree, exposes `report_status` and `note` tools to Claude
- **TUI dashboard** (M3): Bun/TS, likely using `blessed` or `ink`

## File Layout

```
bin/cwt                           # Bun shebang entry point
src/cli.ts                        # Commander subcommand dispatcher
src/state.ts                      # ~/.cwt/state.json management
src/worktree.ts                   # Git worktree + Docker operations
src/compose.ts                    # Docker Compose shell-out wrapper
src/template.ts                   # Eta template renderer
src/util.ts                       # Shared helpers (paths, exec, logging)
templates/docker-compose.cwt.yml.eta  # Compose template
templates/Dockerfile.devcontainer     # Dev container Dockerfile
tests/                            # Bun test files
```

## Project conventions

- All filesystem paths under `~/work/patentsafe/wt/<name>/` for worktrees, `~/.cwt/` for host state, `/var/cwt/<name>/` for in-container shared state.
- Compose project name is always `cwt-<worktree-name>`.
- Branch names follow `<linear-id>-<slug>` (e.g. `amphtt-864-modular-restructure`).
- Port base allocation: scan existing state, find lowest gap starting at 3000, in 10-port blocks. Channel HTTP lives at `port_base + 9`.
- All shell-outs use `Bun.spawn`; never `exec` raw user input. Validate worktree names against `/^[a-z0-9][a-z0-9-]*$/`.
