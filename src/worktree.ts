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
} from "./util.ts";

export interface CreateOptions {
  name: string;
  branch?: string;
  baseBranch?: string;
  repoRoot?: string;
}

function detectLinearId(name: string): string | null {
  const match = LINEAR_ID_PATTERN.exec(name);
  return match ? `${match[1]?.toUpperCase()}-${match[2]}` : null;
}

function composeFilePath(name: string): string {
  return join(worktreePath(name), ".cwt", "docker-compose.yml");
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

export async function create(opts: CreateOptions): Promise<WorktreeEntry> {
  validateName(opts.name);
  const state = new State();

  if (await state.findWorktree(opts.name)) {
    throw new Error(`Worktree "${opts.name}" already exists`);
  }

  const repoRoot = opts.repoRoot ?? (await getRepoRoot(process.cwd()));
  const baseBranch = opts.baseBranch ?? (await getDefaultBranch(repoRoot));
  const branch = opts.branch ?? opts.name;
  const wtPath = worktreePath(opts.name);

  if (existsSync(wtPath)) {
    throw new Error(`Path already exists: ${wtPath}`);
  }

  log.info(`Creating worktree at ${wtPath} from ${baseBranch}`);
  await ensureDir(join(wtPath, ".."));

  const branchExists = await run(
    ["git", "show-ref", "--verify", `refs/heads/${branch}`],
    { cwd: repoRoot, quiet: true },
  );
  if (branchExists.exitCode === 0) {
    await runOrThrow(["git", "worktree", "add", wtPath, branch], {
      cwd: repoRoot,
    });
  } else {
    await runOrThrow(
      ["git", "worktree", "add", "-b", branch, wtPath, baseBranch],
      { cwd: repoRoot },
    );
  }

  const portBase = await state.nextPortBase();
  const project = composeProject(opts.name);
  const linearId = detectLinearId(opts.name);

  log.info(`Allocated port block ${portBase}-${portBase + 9}`);
  log.info(`Compose project: ${project}`);

  const dbName = `patentsafe_wt_${opts.name.replace(/-/g, "_")}`;
  const composeFile = composeFilePath(opts.name);
  const dockerfileDest = join(wtPath, ".cwt", "Dockerfile");

  await writeTemplate(
    "docker-compose.yml.eta",
    composeFile,
    {
      worktreeName: opts.name,
      portBase,
      worktreePath: wtPath,
      composeProject: project,
      dbName,
    },
  );
  await ensureDir(join(wtPath, ".cwt"));
  await copyFile(templatePath("Dockerfile"), dockerfileDest);
  log.info(`Wrote compose file to ${composeFile}`);

  log.info("Starting containers (this may take a while on first build)...");
  await compose.up({ projectName: project, composeFile });
  log.success(`Containers up for ${opts.name}`);

  const entry: WorktreeEntry = {
    name: opts.name,
    branch,
    worktreePath: wtPath,
    composeProject: project,
    portBase,
    linearId,
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

  const composeFile = composeFilePath(name);
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
    const repoRoot = await getRepoRoot(entry.worktreePath).catch(() => null);
    const cwd = repoRoot ?? process.cwd();
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
  const composeFile = composeFilePath(name);
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
    const composeFile = composeFilePath(entry.name);
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
