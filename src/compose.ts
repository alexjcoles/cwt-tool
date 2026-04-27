import { run, runOrThrow } from "./util.ts";

export interface ComposeOptions {
  projectName: string;
  composeFile: string;
  cwd?: string;
}

export async function up(opts: ComposeOptions): Promise<void> {
  await runOrThrow(
    [
      "docker",
      "compose",
      "-p",
      opts.projectName,
      "-f",
      opts.composeFile,
      "up",
      "-d",
      "--build",
    ],
    { cwd: opts.cwd },
  );
}

export async function down(opts: ComposeOptions): Promise<void> {
  await runOrThrow(
    [
      "docker",
      "compose",
      "-p",
      opts.projectName,
      "-f",
      opts.composeFile,
      "down",
      "-v",
    ],
    { cwd: opts.cwd },
  );
}

export async function ps(
  opts: ComposeOptions,
): Promise<Array<{ service: string; state: string; name: string }>> {
  const result = await run(
    [
      "docker",
      "compose",
      "-p",
      opts.projectName,
      "-f",
      opts.composeFile,
      "ps",
      "--format",
      "json",
    ],
    { cwd: opts.cwd, quiet: true },
  );
  if (result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const obj = JSON.parse(line) as {
        Service: string;
        State: string;
        Name: string;
      };
      return { service: obj.Service, state: obj.State, name: obj.Name };
    });
}

export async function isRunning(opts: ComposeOptions): Promise<boolean> {
  const services = await ps(opts);
  return services.some((s) => s.state === "running");
}

export async function exec(
  opts: ComposeOptions & { service: string; command: string[]; tty?: boolean },
): Promise<void> {
  const flags = opts.tty ? [] : ["-T"];
  await runOrThrow(
    [
      "docker",
      "compose",
      "-p",
      opts.projectName,
      "-f",
      opts.composeFile,
      "exec",
      ...flags,
      opts.service,
      ...opts.command,
    ],
    { cwd: opts.cwd },
  );
}

export function execInteractive(
  opts: ComposeOptions & { service: string; command: string[] },
): never {
  const args = [
    "compose",
    "-p",
    opts.projectName,
    "-f",
    opts.composeFile,
    "exec",
    opts.service,
    ...opts.command,
  ];
  Bun.spawnSync(["docker", ...args], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  process.exit(0);
}
