import { Command } from "commander";
import kleur from "kleur";
import * as worktree from "./worktree.ts";
import { log } from "./util.ts";

const VERSION = "0.1.0";

function formatRelative(iso: string): string {
  const then = new Date(iso).getTime();
  const seconds = Math.floor((Date.now() - then) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export function buildProgram(): Command {
  const program = new Command();

  program
    .name("cwt")
    .description("Multi-Claude worktree orchestration")
    .version(VERSION);

  program
    .command("new")
    .description("Create a new worktree + dev container")
    .argument("<name>", "worktree name (e.g. amphtt-864-foo)")
    .option("-b, --branch <branch>", "branch name (defaults to worktree name)")
    .option("--base <branch>", "base branch to fork from (defaults to main/master)")
    .option("-r, --repo-root <path>", "path to source git repo (defaults to cwd)")
    .option("-s, --service <name>", "compose service name for the app container (default: app)")
    .option("-d, --data <path>", "host path to mount as <workspace>/storage (e.g. populated repository data)")
    .option("--no-features", "skip devcontainer features/lifecycle even if .devcontainer/devcontainer.json exists")
    .action(
      async (
        name: string,
        opts: {
          branch?: string;
          base?: string;
          repoRoot?: string;
          service?: string;
          data?: string;
          features?: boolean;
        },
      ) => {
        try {
          const entry = await worktree.create({
            name,
            branch: opts.branch,
            baseBranch: opts.base,
            repoRoot: opts.repoRoot,
            serviceName: opts.service,
            dataMount: opts.data,
            noFeatures: opts.features === false,
          });
          log.success(`Worktree "${entry.name}" ready`);
          log.dim(`  branch:   ${entry.branch}`);
          log.dim(`  path:     ${entry.worktreePath}`);
          log.dim(`  ports:    ${entry.portBase}-${entry.portBase + 99}`);
          log.dim(`  attach:   cwt attach ${entry.name}`);
        } catch (e) {
          log.error((e as Error).message);
          process.exit(1);
        }
      },
    );

  program
    .command("list")
    .alias("ls")
    .description("List all worktrees")
    .action(async () => {
      try {
        const entries = await worktree.list();
        if (entries.length === 0) {
          log.dim("No worktrees yet. Try: cwt new <name>");
          return;
        }
        const headers = ["NAME", "BRANCH", "STATE", "PORTS", "LINEAR", "AGE"];
        const rows = entries.map((e) => [
          e.name,
          e.branch,
          e.running ? kleur.green("running") : kleur.dim("stopped"),
          `${e.portBase}-${e.portBase + 99}`,
          e.linearId ?? "-",
          formatRelative(e.createdAt),
        ]);
        const widths = headers.map((h, i) =>
          Math.max(
            stripAnsi(h).length,
            ...rows.map((r) => stripAnsi(r[i] ?? "").length),
          ),
        );
        console.log(
          headers
            .map((h, i) => kleur.bold(pad(h, widths[i] ?? 0)))
            .join("  "),
        );
        for (const row of rows) {
          console.log(
            row
              .map((c, i) => padAnsi(c ?? "", widths[i] ?? 0))
              .join("  "),
          );
        }
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("attach")
    .description("Attach to a worktree's container (tmux)")
    .argument("<name>", "worktree name")
    .action(async (name: string) => {
      try {
        await worktree.attach(name);
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("rm")
    .description("Remove a worktree and tear down its container")
    .argument("<name>", "worktree name")
    .action(async (name: string) => {
      try {
        await worktree.destroy(name);
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("status")
    .description("Show status from each worktree's channel server (M2)")
    .action(() => {
      log.warn("`cwt status` is part of Milestone 2 (channel server). Not yet implemented.");
    });

  program
    .command("dashboard")
    .description("Open the TUI dashboard (M3)")
    .action(() => {
      log.warn("`cwt dashboard` is part of Milestone 3. Not yet implemented.");
    });

  return program;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function padAnsi(s: string, w: number): string {
  const visible = stripAnsi(s).length;
  if (visible >= w) return s;
  return s + " ".repeat(w - visible);
}

export async function run(argv: string[]): Promise<void> {
  const program = buildProgram();
  await program.parseAsync(argv);
}
