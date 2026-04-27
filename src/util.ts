import { homedir } from "node:os";
import { basename, join } from "node:path";
import { mkdir } from "node:fs/promises";
import kleur from "kleur";

export const HOME = homedir();
export const CWT_HOME = join(HOME, ".cwt");
export const CWT_STATE_FILE = join(CWT_HOME, "state.json");

export const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const LINEAR_ID_PATTERN = /^([a-z]+)-(\d+)(?:-(.+))?$/;

export function validateName(name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new Error(
      `Invalid worktree name "${name}". Must match ${NAME_PATTERN} (lowercase letters, digits, hyphens; must start with letter or digit).`,
    );
  }
}

export function worktreeRootForRepo(repoRoot: string): string {
  return `${repoRoot}-wt`;
}

export function worktreePath(repoRoot: string, name: string): string {
  return join(worktreeRootForRepo(repoRoot), name);
}

export function composeProject(name: string): string {
  return `cwt-${name}`;
}

export function repoSlug(repoRoot: string): string {
  return basename(repoRoot);
}

export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
}

export const log = {
  info: (msg: string) => console.log(kleur.cyan("→ ") + msg),
  success: (msg: string) => console.log(kleur.green("✓ ") + msg),
  warn: (msg: string) => console.log(kleur.yellow("⚠ ") + msg),
  error: (msg: string) => console.error(kleur.red("✗ ") + msg),
  dim: (msg: string) => console.log(kleur.dim(msg)),
};

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function run(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string>; quiet?: boolean } = {},
): Promise<RunResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (!opts.quiet && exitCode !== 0) {
    log.dim(`$ ${cmd.join(" ")}`);
    if (stderr) log.dim(stderr.trimEnd());
  }
  return { exitCode, stdout, stderr };
}

export async function runOrThrow(
  cmd: string[],
  opts: { cwd?: string; env?: Record<string, string> } = {},
): Promise<RunResult> {
  const result = await run(cmd, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (exit ${result.exitCode}): ${cmd.join(" ")}\n${result.stderr}`,
    );
  }
  return result;
}
