import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { ensureDir, log, runOrThrow } from "./util.ts";

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

  const merged: Record<string, unknown> = {
    name: `cwt-${opts.cwtName}`,
    dockerComposeFile: [composeFileRel],
    service: opts.serviceName,
    workspaceFolder: `/workspaces/${opts.cwtName}`,
    features: project.features ?? {},
    customizations: project.customizations,
    containerEnv: {
      ...(project.containerEnv ?? {}),
      ...opts.containerEnv,
    },
    remoteEnv: project.remoteEnv,
    remoteUser: project.remoteUser,
    containerUser: project.containerUser,
    initializeCommand: project.initializeCommand,
    onCreateCommand: project.onCreateCommand,
    updateContentCommand: project.updateContentCommand,
    postCreateCommand: project.postCreateCommand,
    postStartCommand: project.postStartCommand,
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
  log.info(
    "Running devcontainer up — builds image with features, runs lifecycle commands",
  );
  log.info("(may take several minutes on first run)");

  if (!existsSync(DEVCONTAINER_BIN)) {
    throw new Error(
      `devcontainer CLI not found at ${DEVCONTAINER_BIN}. Run 'bun install' in the cwt-tool dir.`,
    );
  }

  await runOrThrow(
    [
      DEVCONTAINER_BIN,
      "up",
      "--workspace-folder",
      opts.worktreePath,
      "--config",
      configPath,
      "--id-label",
      `cwt.worktree=${opts.cwtName}`,
    ],
    { cwd: CWT_PROJECT_ROOT },
  );

  return configPath;
}
