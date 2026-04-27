import { existsSync } from "node:fs";
import { copyFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { State, type WorktreeEntry } from "./state.ts";
import { templatePath, writeTemplate } from "./template.ts";
import * as compose from "./compose.ts";
import {
  LINEAR_ID_PATTERN,
  composeProject,
  ensureDir,
  log,
  run,
  runOrThrow,
  validateName,
  worktreePath,
  worktreeRootForRepo,
} from "./util.ts";

export interface CreateOptions {
  name: string;
  branch?: string;
  baseBranch?: string;
  repoRoot?: string;
  serviceName?: string;
  dataMount?: string;
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

  const branchExists = await run(
    ["git", "show-ref", "--verify", `refs/heads/${branch}`],
    { cwd: repoRoot, quiet: true },
  );
  const remoteBranchExists = await run(
    ["git", "show-ref", "--verify", `refs/remotes/origin/${branch}`],
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
    await runOrThrow(
      ["git", "worktree", "add", "-b", branch, wtPath, baseBranch],
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

  await writeTemplate(
    "docker-compose.yml.eta",
    composeFile,
    {
      worktreeName: opts.name,
      portBase,
      worktreePath: wtPath,
      composeProject: project,
      dbName,
      dockerfile: dockerfileRel,
      serviceName,
      dataMount,
    },
  );
  log.info(`Wrote compose file to ${composeFile}`);

  log.info("Starting containers (first build can take 5-10 min)...");
  await compose.up({ projectName: project, composeFile });
  log.success(`Containers up for ${opts.name}`);

  const entry: WorktreeEntry = {
    name: opts.name,
    branch,
    repoRoot,
    worktreePath: wtPath,
    composeProject: project,
    portBase,
    linearId,
    dataMount,
    createdAt: new Date().toISOString(),
  };
  await state.addWorktree(entry);
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

export async function attach(name: string): Promise<void> {
  validateName(name);
  const state = new State();
  const entry = await state.findWorktree(name);
  if (!entry) {
    throw new Error(`Worktree "${name}" not found`);
  }
  const composeFile = composeFilePath(entry.worktreePath);
  log.info(`Attaching to ${name} (Ctrl-b d to detach tmux)`);
  compose.execInteractive({
    projectName: entry.composeProject,
    composeFile,
    service: "app",
    command: ["tmux", "new-session", "-A", "-s", "cwt"],
  });
}

export interface ListEntry extends WorktreeEntry {
  running: boolean;
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
