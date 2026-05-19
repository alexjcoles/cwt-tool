import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { State, type WorktreeEntry } from "./state.ts";
import { templatePath, writeTemplate } from "./template.ts";
import * as compose from "./compose.ts";
import * as devcontainer from "./devcontainer.ts";
import {
  LINEAR_ID_PATTERN,
  composeProject,
  ensureDir,
  log,
  run,
  runOrThrow,
  statusDirForWorktree,
  validateName,
  worktreePath,
  worktreeRootForRepo,
} from "./util.ts";

const here = dirname(fileURLToPath(import.meta.url));
const CWT_PROJECT_ROOT = resolve(here, "..");
const CHANNEL_DIST = join(CWT_PROJECT_ROOT, "channel", "dist");
const SKILLS_SRC = join(CWT_PROJECT_ROOT, "skills");
const HOOKS_SRC = join(CWT_PROJECT_ROOT, "hooks");

function autoDetectJavaRef(repoRoot: string): string | null {
  // Convention: Java reference repo is a sibling named "patentsafe" next to
  // the source repo (matches the existing devcontainer's `../../patentsafe`).
  const sibling = resolve(repoRoot, "..", "patentsafe");
  return existsSync(sibling) ? sibling : null;
}

async function copySkillsInto(targetDir: string): Promise<void> {
  if (!existsSync(SKILLS_SRC)) {
    log.warn(`Skills directory missing at ${SKILLS_SRC} — skipping skill copy`);
    return;
  }
  await ensureDir(targetDir);
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(SKILLS_SRC, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const src = join(SKILLS_SRC, entry.name);
    const dest = join(targetDir, entry.name);
    await fs.cp(src, dest, { recursive: true, force: true });
  }
  log.info(`Copied ${entries.filter((e) => e.isDirectory()).length} cwt skills into ${targetDir}`);
}

async function copyHooksInto(targetDir: string): Promise<void> {
  if (!existsSync(HOOKS_SRC)) {
    log.warn(`Hooks directory missing at ${HOOKS_SRC} — skipping hook copy`);
    return;
  }
  await ensureDir(targetDir);
  const fs = await import("node:fs/promises");
  const entries = await fs.readdir(HOOKS_SRC, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const src = join(HOOKS_SRC, entry.name);
    const dest = join(targetDir, entry.name);
    await fs.cp(src, dest, { force: true });
    // cp preserves mode but be explicit — hooks must be executable
    await fs.chmod(dest, 0o755);
    count++;
  }
  log.info(`Copied ${count} cwt hooks into ${targetDir}`);
}

export interface CreateOptions {
  name: string;
  branch?: string;
  baseBranch?: string;
  repoRoot?: string;
  serviceName?: string;
  dataMount?: string;
  javaRef?: string;
  noFeatures?: boolean;
}

function detectLinearId(name: string): string | null {
  const match = LINEAR_ID_PATTERN.exec(name);
  return match ? `${match[1]?.toUpperCase()}-${match[2]}` : null;
}

function composeFilePath(wtPath: string): string {
  return join(wtPath, ".cwt", "docker-compose.yml");
}

async function getRepoRoot(cwd: string): Promise<string> {
  const result = await runOrThrow(["git", "rev-parse", "--show-toplevel"], {
    cwd,
  });
  return result.stdout.trim();
}

async function getDefaultBranch(repoRoot: string): Promise<string> {
  const tryRefs = ["main", "master"];
  for (const ref of tryRefs) {
    const r = await run(
      ["git", "show-ref", "--verify", `refs/heads/${ref}`],
      { cwd: repoRoot, quiet: true },
    );
    if (r.exitCode === 0) return ref;
  }
  const remote = await run(
    ["git", "symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: repoRoot, quiet: true },
  );
  if (remote.exitCode === 0) {
    return remote.stdout.trim().replace("refs/remotes/origin/", "");
  }
  throw new Error("Could not determine default branch (tried main, master, origin/HEAD)");
}

interface DockerfileResolution {
  source: string;
  contextRelative: string;
  description: string;
}

function resolveProjectDockerfile(repoRoot: string): DockerfileResolution | null {
  const dev = join(repoRoot, ".devcontainer", "Dockerfile");
  if (existsSync(dev)) {
    return {
      source: dev,
      contextRelative: ".devcontainer/Dockerfile",
      description: "project .devcontainer/Dockerfile",
    };
  }
  const root = join(repoRoot, "Dockerfile");
  if (existsSync(root)) {
    return {
      source: root,
      contextRelative: "Dockerfile",
      description: "project Dockerfile",
    };
  }
  return null;
}

export async function create(opts: CreateOptions): Promise<WorktreeEntry> {
  validateName(opts.name);
  const state = new State();

  if (await state.findWorktree(opts.name)) {
    throw new Error(`Worktree "${opts.name}" already exists`);
  }

  const repoRoot = opts.repoRoot ?? (await getRepoRoot(process.cwd()));
  const baseBranch = opts.baseBranch ?? (await getDefaultBranch(repoRoot));
  const branch = opts.branch ?? opts.name;
  const wtPath = worktreePath(repoRoot, opts.name);

  if (existsSync(wtPath)) {
    throw new Error(`Path already exists: ${wtPath}`);
  }

  log.info(`Repo:   ${repoRoot}`);
  log.info(`Branch: ${branch}  (base: ${baseBranch})`);
  log.info(`Path:   ${wtPath}`);

  await ensureDir(worktreeRootForRepo(repoRoot));

  // Fetch origin so we branch from the actual current tip, not whatever
  // local refs happen to be — local `main` is often stale because the
  // user works mostly in worktrees and rarely pulls the source repo.
  // Without this, `git worktree add ... main` forks from a stale commit
  // and the new branch is born behind origin.
  log.info("Fetching origin (so the new branch starts from up-to-date refs)...");
  const fetched = await run(["git", "fetch", "origin", "--prune"], {
    cwd: repoRoot,
    quiet: true,
  });
  if (fetched.exitCode !== 0) {
    log.warn(`git fetch failed — proceeding with local refs:\n${fetched.stderr.trim()}`);
  }

  const branchExists = await run(
    ["git", "show-ref", "--verify", `refs/heads/${branch}`],
    { cwd: repoRoot, quiet: true },
  );
  const remoteBranchExists = await run(
    ["git", "show-ref", "--verify", `refs/remotes/origin/${branch}`],
    { cwd: repoRoot, quiet: true },
  );
  const remoteBaseExists = await run(
    ["git", "show-ref", "--verify", `refs/remotes/origin/${baseBranch}`],
    { cwd: repoRoot, quiet: true },
  );

  if (branchExists.exitCode === 0) {
    await runOrThrow(["git", "worktree", "add", wtPath, branch], {
      cwd: repoRoot,
    });
  } else if (remoteBranchExists.exitCode === 0) {
    await runOrThrow(
      ["git", "worktree", "add", "--track", "-b", branch, wtPath, `origin/${branch}`],
      { cwd: repoRoot },
    );
  } else {
    // Prefer origin/<base> over local <base>: local can be days/weeks behind.
    // Falls back to local only if origin doesn't have it (rare — would mean
    // an unpushed default branch).
    const startPoint = remoteBaseExists.exitCode === 0 ? `origin/${baseBranch}` : baseBranch;
    log.info(`Forking new branch from ${startPoint}`);
    await runOrThrow(
      ["git", "worktree", "add", "-b", branch, wtPath, startPoint],
      { cwd: repoRoot },
    );
  }

  const portBase = await state.nextPortBase();
  const project = composeProject(opts.name);
  const linearId = detectLinearId(opts.name);

  log.info(`Ports:  ${portBase}-${portBase + 99}`);
  log.info(`Compose project: ${project}`);

  const dbName = `patentsafe_wt_${opts.name.replace(/-/g, "_")}`;
  const composeFile = composeFilePath(wtPath);
  const statusDir = statusDirForWorktree(opts.name);
  await ensureDir(statusDir);

  // Generate a sender-gate secret on first create. Channel server reads it,
  // dashboard reads it, both check incoming verdicts/messages against it.
  // Without the secret, anything that can write to the status dir could
  // approve tool calls on Claude's behalf.
  const secretFile = join(statusDir, "secret");
  if (!existsSync(secretFile)) {
    const fs = await import("node:fs/promises");
    const crypto = await import("node:crypto");
    const secret = crypto.randomBytes(32).toString("hex");
    await fs.writeFile(secretFile, secret + "\n", { mode: 0o600 });
    log.info(`Wrote sender-gate secret to ${secretFile}`);
  }

  if (!existsSync(join(CHANNEL_DIST, "server.js"))) {
    log.info("Channel server bundle missing — running build:channel");
    await runOrThrow(["bun", "run", "build:channel"], { cwd: CWT_PROJECT_ROOT });
  }

  // Pre-create the shared volumes that span all cwt worktrees. They're
  // declared `external: true` in the compose template so `cwt rm`'s
  // `compose down -v` never touches them — auth in cwt-claude-config /
  // cwt-gh-config and gem caches in cwt-bundle-cache / cwt-cargo-registry
  // need to survive a worktree being removed. `docker volume create` is
  // idempotent: succeeds if the volume already exists.
  for (const volName of [
    "cwt-claude-config",
    "cwt-gh-config",
    "cwt-bundle-cache",
    "cwt-cargo-registry",
  ]) {
    await run(["docker", "volume", "create", "--label", "cwt=shared", volName], {
      quiet: true,
    });
  }

  // Choose Dockerfile: prefer project's existing devcontainer/Dockerfile
  // (mounted at build time as part of the worktree itself), else fall back
  // to bundled generic image.
  const projectDockerfile = resolveProjectDockerfile(wtPath);
  let dockerfileRel: string;
  if (projectDockerfile) {
    log.info(`Using ${projectDockerfile.description}: ${projectDockerfile.contextRelative}`);
    dockerfileRel = projectDockerfile.contextRelative;
  } else {
    log.info("No project Dockerfile found; using bundled generic image");
    await ensureDir(join(wtPath, ".cwt"));
    await copyFile(templatePath("Dockerfile"), join(wtPath, ".cwt", "Dockerfile"));
    dockerfileRel = ".cwt/Dockerfile";
  }

  const serviceName = opts.serviceName ?? "app";
  const dataMount = opts.dataMount ?? null;
  if (dataMount && !existsSync(dataMount)) {
    throw new Error(`--data path does not exist: ${dataMount}`);
  }

  const javaRef = opts.javaRef ?? autoDetectJavaRef(repoRoot);
  if (opts.javaRef && !existsSync(opts.javaRef)) {
    throw new Error(`--java-ref path does not exist: ${opts.javaRef}`);
  }
  if (javaRef) {
    log.info(`Java reference repo: ${javaRef} → /workspaces/patentsafe`);
  } else {
    log.dim("No Java reference repo found (looked for sibling 'patentsafe' dir). Java exploration skill will fail until one is mounted.");
  }

  await writeTemplate(
    "docker-compose.yml.eta",
    composeFile,
    {
      worktreeName: opts.name,
      portBase,
      worktreePath: wtPath,
      repoRoot,
      composeProject: project,
      dbName,
      dockerfile: dockerfileRel,
      serviceName,
      dataMount,
      javaRef,
      channelDist: CHANNEL_DIST,
      statusDir,
    },
  );

  // Write .mcp.json and .claude/settings.json into the worktree so Claude Code
  // (started inside the container) registers cwt-channel and the activity hook.
  await writeTemplate(
    "mcp.json.eta",
    join(wtPath, ".mcp.json"),
    { worktreeName: opts.name },
  );
  await writeTemplate(
    "claude-settings.json.eta",
    join(wtPath, ".claude", "settings.json"),
    { worktreeName: opts.name },
  );

  // Copy cwt's bundled skills into the worktree's .claude/skills/. These are
  // gitignored at the source, so git worktree add doesn't carry over the
  // project's own skills, and our cwt-* skills won't conflict with project ones
  // because the names are prefixed.
  await copySkillsInto(join(wtPath, ".claude", "skills"));
  await copyHooksInto(join(wtPath, ".claude", "hooks"));

  log.info(`Wrote compose file to ${composeFile}`);

  const useDevcontainer =
    !opts.noFeatures && devcontainer.projectHasDevcontainer(wtPath);

  if (useDevcontainer) {
    log.info(
      "Detected project devcontainer.json — using devcontainer CLI (features + lifecycle hooks)",
    );
    await devcontainer.up({
      worktreePath: wtPath,
      cwtName: opts.name,
      composeFileAbs: composeFile,
      serviceName,
      containerEnv: {
        CWT_WORKTREE_NAME: opts.name,
        CWT_PORT_BASE: String(portBase),
      },
    });
  } else {
    log.info("Starting containers via docker compose (no devcontainer features)");
    await compose.up({ projectName: project, composeFile });
  }
  log.success(`Containers up for ${opts.name}`);

  const entry: WorktreeEntry = {
    name: opts.name,
    branch,
    repoRoot,
    worktreePath: wtPath,
    composeProject: project,
    serviceName,
    portBase,
    linearId,
    dataMount,
    createdAt: new Date().toISOString(),
  };
  await state.addWorktree(entry);

  // Persist defaults so the dashboard can still offer 'n' after this and
  // every other worktree is removed. Branch prefix is the path-prefix
  // before the issue id, e.g. "alexc/" from "alexc/amphtt-959-...".
  const branchPrefix = branch.includes("/")
    ? branch.slice(0, branch.indexOf("/") + 1)
    : null;
  await state.setLastDefaults({
    repoRoot,
    serviceName,
    dataMount,
    branchPrefix,
  });

  return entry;
}

export async function destroy(name: string): Promise<void> {
  validateName(name);
  const state = new State();
  const entry = await state.findWorktree(name);
  if (!entry) {
    throw new Error(`Worktree "${name}" not found`);
  }

  const composeFile = composeFilePath(entry.worktreePath);
  if (existsSync(composeFile)) {
    log.info(`Stopping containers for ${name}`);
    try {
      await compose.down({
        projectName: entry.composeProject,
        composeFile,
      });
    } catch (e) {
      log.warn(`compose down failed: ${(e as Error).message}`);
    }
  }

  // Remove the per-worktree app image. `compose down -v` does NOT remove the
  // image — only containers + volumes. Without this each worktree leaves a
  // ~4GB image behind on every cwt rm.
  const imageName = `${entry.composeProject}-app`;
  const imgRm = await run(["docker", "image", "rm", imageName], { quiet: true });
  if (imgRm.exitCode === 0) {
    log.info(`Removed image ${imageName}`);
  } else if (imgRm.stderr.includes("No such image")) {
    // already gone — fine
  } else {
    log.warn(`Could not remove image ${imageName}: ${imgRm.stderr.trim()}`);
  }

  if (existsSync(entry.worktreePath)) {
    log.info(`Removing git worktree at ${entry.worktreePath}`);
    const cwd = entry.repoRoot ?? (await getRepoRoot(entry.worktreePath).catch(() => process.cwd()));
    const result = await run(
      ["git", "worktree", "remove", "--force", entry.worktreePath],
      { cwd },
    );
    if (result.exitCode !== 0) {
      log.warn(`git worktree remove failed; force-removing path`);
      await rm(entry.worktreePath, { recursive: true, force: true });
    }
  }

  await state.removeWorktree(name);
  log.success(`Removed worktree ${name}`);
}

// Find docker resources that look cwt-managed but don't correspond to any
// tracked worktree, and remove them. Useful after we discovered the image-
// leak bug — earlier cwt rm runs left ~4GB images behind per worktree.
export interface PruneResult {
  removedImages: string[];
  removedContainers: string[];
  failed: Array<{ resource: string; reason: string }>;
}

export async function prune(): Promise<PruneResult> {
  const state = new State();
  const entries = await state.listWorktrees();
  const tracked = new Set(entries.map((e) => e.composeProject));
  const result: PruneResult = {
    removedImages: [],
    removedContainers: [],
    failed: [],
  };

  // Orphan containers: matching cwt-* prefix but not in any tracked compose project
  const psOut = await run(
    ["docker", "ps", "-a", "--format", "{{.Names}}|{{.Status}}"],
    { quiet: true },
  );
  if (psOut.exitCode === 0) {
    for (const line of psOut.stdout.split("\n")) {
      if (!line.trim()) continue;
      const [name] = line.split("|");
      if (!name?.startsWith("cwt-")) continue;
      // name format: cwt-<worktree>-<service>; project = cwt-<worktree>
      const m = /^(cwt-.+)-(app|pg|selenium)$/.exec(name);
      if (!m) continue;
      const project = m[1]!;
      if (tracked.has(project)) continue;
      const rm = await run(["docker", "rm", "-f", name], { quiet: true });
      if (rm.exitCode === 0) {
        result.removedContainers.push(name);
      } else {
        result.failed.push({ resource: `container ${name}`, reason: rm.stderr.trim() });
      }
    }
  }

  // Orphan images: cwt-<worktree>-app where no tracked worktree uses that name
  const imgOut = await run(
    ["docker", "images", "--filter", "reference=cwt-*", "--format", "{{.Repository}}"],
    { quiet: true },
  );
  if (imgOut.exitCode === 0) {
    const trackedImages = new Set(
      entries.map((e) => `${e.composeProject}-app`),
    );
    for (const repo of imgOut.stdout.split("\n")) {
      if (!repo.trim()) continue;
      if (trackedImages.has(repo)) continue;
      const rm = await run(["docker", "image", "rm", repo], { quiet: true });
      if (rm.exitCode === 0) {
        result.removedImages.push(repo);
      } else if (!rm.stderr.includes("No such image")) {
        result.failed.push({ resource: `image ${repo}`, reason: rm.stderr.trim() });
      }
    }
  }

  return result;
}

export async function execCommand(name: string, command: string): Promise<number> {
  validateName(name);
  const state = new State();
  const entry = await state.findWorktree(name);
  if (!entry) {
    throw new Error(`Worktree "${name}" not found`);
  }
  const composeFile = composeFilePath(entry.worktreePath);
  const service = entry.serviceName ?? "app";
  const { spawnSync } = await import("node:child_process");
  // bash -ic so mise activates and project tools (ruby, bundler, rails, gh)
  // are on PATH. Stdio inherited so output streams to the user's terminal.
  const result = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      entry.composeProject,
      "-f",
      composeFile,
      "exec",
      service,
      "bash",
      "-ic",
      command,
    ],
    { stdio: "inherit" },
  );
  return result.status ?? 1;
}

// Container fixups that devcontainer CLI's postStartCommand would run on a
// fresh up, but that don't fire when the container is brought back up via
// bare `docker compose up` (e.g. after a system reboot). cwt attach calls
// this every time to self-heal — all checks are guarded so this is a
// no-op when everything is already in place.
async function ensureContainerFixups(opts: {
  projectName: string;
  composeFile: string;
  service: string;
}): Promise<void> {
  const fixup = [
    // Volume ownership (docker creates named volumes root-owned)
    "sudo chown -R vscode:vscode /home/vscode/.claude /home/vscode/.config/gh 2>/dev/null || true",
    // tmux — cwt attach needs it
    "command -v tmux >/dev/null 2>&1 || (sudo apt-get update -qq && sudo apt-get install -y --no-install-recommends tmux >/dev/null 2>&1) || true",
    // claude binary — sometimes postCreate didn't finish
    "test -x /home/vscode/.local/bin/claude || curl -fsSL https://claude.ai/install.sh | bash >/dev/null 2>&1 || true",
    // .claude.json symlink into the shared volume (auth carries across containers)
    "if [ ! -L /home/vscode/.claude.json ]; then if [ -f /home/vscode/.claude/.claude.json ]; then rm -f /home/vscode/.claude.json; ln -sf /home/vscode/.claude/.claude.json /home/vscode/.claude.json; elif [ -f /home/vscode/.claude.json ]; then mv /home/vscode/.claude.json /home/vscode/.claude/.claude.json && ln -sf /home/vscode/.claude/.claude.json /home/vscode/.claude.json; fi; fi",
  ].join("; ");
  await compose.exec({
    projectName: opts.projectName,
    composeFile: opts.composeFile,
    service: opts.service,
    command: ["bash", "-c", fixup],
  });
}

export async function attach(name: string): Promise<void> {
  validateName(name);
  const state = new State();
  const entry = await state.findWorktree(name);
  if (!entry) {
    throw new Error(`Worktree "${name}" not found`);
  }
  const composeFile = composeFilePath(entry.worktreePath);
  // Older state entries (pre-serviceName field) default to "app".
  const service = entry.serviceName ?? "app";

  // Self-heal the container if a system restart wiped tmux / symlinks
  // (postStartCommand only fires on devcontainer up, not bare docker
  // compose up). Cheap and idempotent so we run unconditionally.
  await ensureContainerFixups({
    projectName: entry.composeProject,
    composeFile,
    service,
  }).catch((e) => {
    log.warn(`Container fixup failed: ${(e as Error).message}; attach may fail if tmux is missing`);
  });

  log.info(`Attaching to ${name}`);
  log.dim(`  detach: Ctrl+B  D   (session keeps running, re-attach later)`);
  log.dim(`  exit:   Ctrl+D or 'exit'   (closes the shell)`);
  compose.execInteractive({
    projectName: entry.composeProject,
    composeFile,
    service,
    command: ["tmux", "new-session", "-A", "-s", "cwt"],
  });
}

export interface ListEntry extends WorktreeEntry {
  running: boolean;
}

export interface StatusEntry {
  name: string;
  status: ChannelStatus | null;
}

interface ChannelStatus {
  state: string;
  summary: string;
  currentFile: string | null;
  updatedAt: string;
}

export async function statusReport(): Promise<StatusEntry[]> {
  const state = new State();
  const entries = await state.listWorktrees();
  const fs = await import("node:fs/promises");
  const results: StatusEntry[] = [];
  for (const entry of entries) {
    const stateFile = join(statusDirForWorktree(entry.name), "state.json");
    let status: ChannelStatus | null = null;
    if (existsSync(stateFile)) {
      try {
        const raw = await fs.readFile(stateFile, "utf8");
        const parsed = JSON.parse(raw) as ChannelStatus;
        status = parsed;
      } catch {
        status = null;
      }
    }
    results.push({ name: entry.name, status });
  }
  return results;
}

export async function tailActivity(
  name: string,
  opts: { follow: boolean; lines: number },
): Promise<void> {
  validateName(name);
  const state = new State();
  const entry = await state.findWorktree(name);
  if (!entry) {
    throw new Error(`Worktree "${name}" not found`);
  }
  const activityFile = join(statusDirForWorktree(name), "activity.jsonl");
  if (!existsSync(activityFile)) {
    log.dim(`(no activity logged yet at ${activityFile})`);
    return;
  }
  const tailArgs = ["-n", String(opts.lines)];
  if (opts.follow) tailArgs.push("-f");
  tailArgs.push(activityFile);
  Bun.spawnSync(["tail", ...tailArgs], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
}

export async function list(): Promise<ListEntry[]> {
  const state = new State();
  const entries = await state.listWorktrees();
  const results: ListEntry[] = [];
  for (const entry of entries) {
    const composeFile = composeFilePath(entry.worktreePath);
    let running = false;
    if (existsSync(composeFile)) {
      try {
        running = await compose.isRunning({
          projectName: entry.composeProject,
          composeFile,
        });
      } catch {
        running = false;
      }
    }
    results.push({ ...entry, running });
  }
  return results;
}
