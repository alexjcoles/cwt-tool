import { existsSync } from "node:fs";
import {
  copyFile,
  open,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { CWT_HOME, ensureDir, log } from "./util.ts";
import {
  CLAUDE_INSTALL_FIXUP,
  CLAUDE_JSON_SYMLINK_FIXUP,
  CLAUDE_RESTORE_FIXUP,
  TMUX_CONF_FIXUP,
  VOLUME_CHOWN_FIXUP,
} from "./fixup.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CWT_PROJECT_ROOT = resolve(here, "..");
export const DEVCONTAINER_BIN = join(
  CWT_PROJECT_ROOT,
  "node_modules",
  ".bin",
  "devcontainer",
);

export function projectHasDevcontainer(repoRoot: string): boolean {
  return (
    existsSync(join(repoRoot, ".devcontainer", "devcontainer.json")) ||
    existsSync(join(repoRoot, ".devcontainer.json"))
  );
}

interface ProjectDevcontainer {
  features?: Record<string, unknown>;
  customizations?: Record<string, unknown>;
  containerEnv?: Record<string, string>;
  remoteEnv?: Record<string, string>;
  remoteUser?: string;
  containerUser?: string;
  onCreateCommand?: unknown;
  updateContentCommand?: unknown;
  postCreateCommand?: unknown;
  postStartCommand?: unknown;
  postAttachCommand?: unknown;
  initializeCommand?: unknown;
  waitFor?: string;
  forwardPorts?: number[];
  portsAttributes?: Record<string, unknown>;
  shutdownAction?: string;
  userEnvProbe?: string;
  overrideCommand?: boolean;
}

// Combine a project-supplied lifecycle command with a cwt-injected one.
// devcontainer.json supports three forms: undefined, a string, an array, or
// an object mapping a name to a command/array. Object form lets multiple
// commands run in parallel, which is what we want.
function mergeLifecycle(
  existing: unknown,
  cwtKey: string,
  cwtCmd: string,
): unknown {
  if (existing === undefined || existing === null) {
    return { [cwtKey]: cwtCmd };
  }
  if (typeof existing === "string" || Array.isArray(existing)) {
    return {
      project: existing,
      [cwtKey]: cwtCmd,
    };
  }
  if (typeof existing === "object") {
    return {
      ...(existing as Record<string, unknown>),
      [cwtKey]: cwtCmd,
    };
  }
  // Unknown shape — fall back to cwt-only and log nothing (devcontainer CLI
  // will surface schema issues if any).
  return { [cwtKey]: cwtCmd };
}

function shellQuote(arg: string): string {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

// Sequence cwt's command BEFORE a project-supplied lifecycle command.
// mergeLifecycle's object form runs entries in PARALLEL, which is wrong for
// onCreateCommand: cwt's volume chown must complete before a project
// onCreate that installs into those volumes, or the install races a
// root-owned mountpoint. Array-form commands (bare argv, no shell) are
// shell-quoted and folded into one string — same effective command, now
// ordered. For object form each entry gets the (idempotent, cheap) cwt
// command prefixed so every parallel branch sees prepared volumes.
function sequenceLifecycle(existing: unknown, cwtCmd: string): unknown {
  if (existing === undefined || existing === null) return cwtCmd;
  if (typeof existing === "string") return `${cwtCmd}; ${existing}`;
  if (Array.isArray(existing)) {
    return `${cwtCmd}; ${existing.map((a) => shellQuote(String(a))).join(" ")}`;
  }
  if (typeof existing === "object") {
    const entries = Object.entries(existing as Record<string, unknown>);
    if (entries.length === 0) return cwtCmd;
    return Object.fromEntries(
      entries.map(([k, v]) => {
        if (typeof v === "string") return [k, `${cwtCmd}; ${v}`];
        if (Array.isArray(v)) {
          return [k, `${cwtCmd}; ${v.map((a) => shellQuote(String(a))).join(" ")}`];
        }
        return [k, v];
      }),
    );
  }
  return cwtCmd;
}

async function readProjectDevcontainer(
  repoRoot: string,
): Promise<ProjectDevcontainer | null> {
  const candidates = [
    join(repoRoot, ".devcontainer", "devcontainer.json"),
    join(repoRoot, ".devcontainer.json"),
  ];
  for (const path of candidates) {
    if (existsSync(path)) {
      const raw = await readFile(path, "utf8");
      return parseJsonc(raw) as ProjectDevcontainer;
    }
  }
  return null;
}

export interface UpOpts {
  worktreePath: string;
  cwtName: string;
  composeFileAbs: string;
  serviceName: string;
  containerEnv: Record<string, string>;
}

export async function up(opts: UpOpts): Promise<string> {
  const project = await readProjectDevcontainer(opts.worktreePath);
  if (!project) {
    throw new Error(
      `No project devcontainer.json found at ${opts.worktreePath}/.devcontainer/`,
    );
  }

  const cwtConfigDir = join(opts.worktreePath, ".cwt");
  await ensureDir(cwtConfigDir);
  const configPath = join(cwtConfigDir, "devcontainer.json");
  const composeFileRel = relative(cwtConfigDir, opts.composeFileAbs);

  // cwt's channel server runs under Node inside the container. Inject the
  // node feature so any project devcontainer gets a working JS runtime,
  // regardless of whether the project itself needs one.
  const featuresWithNode = {
    ...(project.features ?? {}),
    "ghcr.io/devcontainers/features/node:1": { version: "lts" },
  };

  // cwt-side lifecycle fixups, split across two hooks:
  //
  // onCreateCommand (runs once per container, BEFORE the project's
  // postCreateCommand):
  //   1. Chown the shared volumes — Docker creates fresh named volumes
  //      root-owned, but the rails devcontainer runs as vscode. This must
  //      precede postCreate, or the project's bundle install can't write
  //      to the gem-cache volume and every worktree reinstalls all gems.
  //   2. Restore the claude binary symlink from the cwt-claude-share
  //      volume so a guarded installer in postCreate sees it and skips
  //      the ~250MB download.
  //
  // postStartCommand (runs on every devcontainer-up start, AFTER
  // postCreate; kept cheap — no apt work, tmux installs at attach time
  // via ensureContainerFixups instead):
  //   3. Re-run the guarded chown (no-op when ownership is already right)
  //      for containers restarted without a fresh create.
  //   4. Write ~/.tmux.conf (paste-friendly config for cwt attach).
  //   5. Self-heal the claude binary if postCreate didn't leave one.
  //   6. Symlink ~/.claude.json into the cwt-claude-config volume so auth
  //      persists across containers.
  const cwtOnCreate = [VOLUME_CHOWN_FIXUP, CLAUDE_RESTORE_FIXUP].join("; ");
  const cwtPostStart = [
    VOLUME_CHOWN_FIXUP,
    TMUX_CONF_FIXUP,
    CLAUDE_INSTALL_FIXUP,
    CLAUDE_JSON_SYMLINK_FIXUP,
  ].join("; ");
  const mergedOnCreate = sequenceLifecycle(project.onCreateCommand, cwtOnCreate);
  const mergedPostStart = mergeLifecycle(
    project.postStartCommand,
    "cwt-fixups",
    cwtPostStart,
  );

  const merged: Record<string, unknown> = {
    name: `cwt-${opts.cwtName}`,
    dockerComposeFile: [composeFileRel],
    service: opts.serviceName,
    workspaceFolder: `/workspaces/${opts.cwtName}`,
    features: featuresWithNode,
    customizations: project.customizations,
    containerEnv: {
      ...(project.containerEnv ?? {}),
      ...opts.containerEnv,
    },
    remoteEnv: project.remoteEnv,
    remoteUser: project.remoteUser,
    containerUser: project.containerUser,
    initializeCommand: project.initializeCommand,
    onCreateCommand: mergedOnCreate,
    updateContentCommand: project.updateContentCommand,
    postCreateCommand: project.postCreateCommand,
    postStartCommand: mergedPostStart,
    postAttachCommand: project.postAttachCommand,
    waitFor: project.waitFor,
    forwardPorts: project.forwardPorts,
    portsAttributes: project.portsAttributes,
    shutdownAction: project.shutdownAction ?? "none",
    userEnvProbe: project.userEnvProbe,
    overrideCommand: project.overrideCommand,
  };

  const filtered = Object.fromEntries(
    Object.entries(merged).filter(([, v]) => v !== undefined),
  );

  await writeFile(configPath, JSON.stringify(filtered, null, 2) + "\n", "utf8");
  log.info(`Wrote merged devcontainer config: ${configPath}`);

  // The CLI only looks for devcontainer-lock.json beside --config, so the
  // project's lockfile is invisible unless we copy it next to the merged
  // config. With it, feature manifests are fetched by pinned digest instead
  // of floating tag — reproducible, and immune to a surprise multi-GB
  // rebuild when an upstream feature tag moves.
  const projectLock = join(
    opts.worktreePath,
    ".devcontainer",
    "devcontainer-lock.json",
  );
  if (existsSync(projectLock)) {
    await copyFile(projectLock, join(cwtConfigDir, "devcontainer-lock.json"));
    log.info("Copied devcontainer-lock.json (pins feature digests)");
  }

  log.info(
    "Running devcontainer up — builds image with features, runs lifecycle commands",
  );
  log.info("(may take several minutes on first run)");

  if (!existsSync(DEVCONTAINER_BIN)) {
    throw new Error(
      `devcontainer CLI not found at ${DEVCONTAINER_BIN}. Run 'bun install' in the cwt-tool dir.`,
    );
  }

  // Stream the CLI's full debug output to a persistent log. devcontainer up
  // has stalled for 50s+ inside its ghcr.io feature fetch before; without a
  // log those stalls are undiagnosable after the fact (and un-tailable
  // during). Mirrors the ~/.cwt/teardown-logs pattern.
  const logDir = join(CWT_HOME, "up-logs");
  await ensureDir(logDir);
  // Debug logs include full build streams (MBs per create) — prune anything
  // older than a week so the dir doesn't grow without bound.
  const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
  for (const f of await readdir(logDir)) {
    const p = join(logDir, f);
    try {
      if ((await stat(p)).mtimeMs < cutoff) await unlink(p);
    } catch {
      // best-effort
    }
  }
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logPath = join(logDir, `${opts.cwtName}-${ts}.log`);
  log.dim(`  devcontainer up log (tail -f to watch): ${logPath}`);

  const logFd = await open(logPath, "a");
  try {
    const proc = Bun.spawn(
      [
        DEVCONTAINER_BIN,
        "up",
        "--log-level",
        "debug",
        "--workspace-folder",
        opts.worktreePath,
        "--config",
        configPath,
        "--id-label",
        `cwt.worktree=${opts.cwtName}`,
      ],
      {
        cwd: CWT_PROJECT_ROOT,
        stdout: logFd.fd,
        stderr: logFd.fd,
      },
    );
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const tail = (await readFile(logPath, "utf8"))
        .split("\n")
        .slice(-40)
        .join("\n");
      throw new Error(
        `devcontainer up failed (exit ${exitCode}). Full log: ${logPath}\n${tail}`,
      );
    }
  } finally {
    await logFd.close();
  }

  return configPath;
}
