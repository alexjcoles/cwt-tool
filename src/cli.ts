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
    .option("-d, --data <path>", "host documents dir to mount as storage/repository (auto-detected when path is a storage/ parent with a repository/ subdir)")
    .option("-j, --java-ref <path>", "host path to the Java reference repo (auto-detected as sibling 'patentsafe/' if omitted)")
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
          javaRef?: string;
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
            javaRef: opts.javaRef,
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
    .command("exec")
    .description("Run a one-shot command inside a worktree's container (bash -ic)")
    .argument("<name>", "worktree name")
    .argument("<command...>", "the command and its args")
    .action(async (name: string, command: string[]) => {
      try {
        const code = await worktree.execCommand(name, command.join(" "));
        process.exit(code);
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("rm")
    .description("Remove a worktree and tear down its container")
    .argument("<name>", "worktree name")
    .option("-b, --background", "run teardown (compose down + image rm + git worktree remove) in a detached child process so the CLI returns immediately")
    .action(async (name: string, opts: { background?: boolean }) => {
      try {
        if (opts.background) {
          const { logPath, pid } = await worktree.destroyInBackground(name);
          log.success(`Detached teardown started (pid ${pid})`);
          log.dim(`  log: ${logPath}`);
          log.dim(`  tail -f "${logPath}"`);
        } else {
          await worktree.destroy(name);
        }
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  // Internal: invoked by destroyInBackground in a detached child to do the
  // actual docker + git teardown. Not user-facing. Takes the WorktreeEntry
  // JSON as a single positional arg so the child doesn't need to read state.
  program
    .command("_teardown", { hidden: true })
    .argument("<entry-json>")
    .action(async (entryJson: string) => {
      try {
        const entry = JSON.parse(entryJson);
        await worktree.destroyResources(entry);
        log.success(`Teardown complete for ${entry.name}`);
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("prune")
    .description("Remove docker containers + images for worktrees no longer tracked in cwt state")
    .action(async () => {
      try {
        log.info("Scanning for orphaned cwt containers and images...");
        const result = await worktree.prune();
        if (result.removedContainers.length > 0) {
          log.success(`Removed ${result.removedContainers.length} orphan container(s):`);
          for (const c of result.removedContainers) log.dim(`  ${c}`);
        }
        if (result.removedImages.length > 0) {
          log.success(`Removed ${result.removedImages.length} orphan image(s) (~4GB each):`);
          for (const i of result.removedImages) log.dim(`  ${i}`);
        }
        if (result.failed.length > 0) {
          log.warn(`${result.failed.length} resource(s) could not be removed:`);
          for (const f of result.failed) log.dim(`  ${f.resource}: ${f.reason}`);
        }
        if (
          result.removedContainers.length === 0 &&
          result.removedImages.length === 0 &&
          result.failed.length === 0
        ) {
          log.info("Nothing to prune.");
        }
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("status")
    .description("Show what each Claude is reporting via the cwt-channel server")
    .action(async () => {
      try {
        const entries = await worktree.statusReport();
        if (entries.length === 0) {
          log.dim("No worktrees yet. Try: cwt new <name>");
          return;
        }
        const headers = ["NAME", "PHASE", "SUMMARY", "FILE", "AGE"];
        const rows = entries.map((e) => [
          e.name,
          e.status ? colorState(e.status.state) : kleur.dim("—"),
          e.status?.summary ?? kleur.dim("(no report yet)"),
          e.status?.currentFile ?? kleur.dim("—"),
          e.status ? formatRelative(e.status.updatedAt) : kleur.dim("—"),
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
    .command("logs")
    .description("Tail a worktree's activity log")
    .argument("<name>", "worktree name")
    .option("-f, --follow", "follow as new entries arrive")
    .option("-n, --lines <n>", "number of trailing lines", "20")
    .action(async (name: string, opts: { follow?: boolean; lines?: string }) => {
      try {
        await worktree.tailActivity(name, {
          follow: opts.follow ?? false,
          lines: parseInt(opts.lines ?? "20", 10),
        });
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  program
    .command("dashboard")
    .description("Open the TUI dashboard — table of worktrees with live activity")
    .action(async () => {
      try {
        const { runDashboard } = await import("./dashboard.ts");
        await runDashboard();
      } catch (e) {
        log.error((e as Error).message);
        process.exit(1);
      }
    });

  return program;
}

function colorState(state: string): string {
  switch (state) {
    case "planning":
      return kleur.cyan(state);
    case "working":
      return kleur.green(state);
    case "blocked":
      return kleur.red(state);
    case "waiting":
      return kleur.yellow(state);
    case "done":
      return kleur.gray(state);
    default:
      return state;
  }
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
