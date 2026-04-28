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

// Combine a project-supplied postStartCommand with cwt's own chown step.
// devcontainer.json supports three forms: undefined, a string, an array, or
// an object mapping a name to a command/array. Object form lets multiple
// commands run in parallel, which is what we want.
function mergePostStart(
  existing: unknown,
  cwtCmd: string,
): unknown {
  if (existing === undefined || existing === null) {
    return { "cwt-fix-volume-ownership": cwtCmd };
  }
  if (typeof existing === "string" || Array.isArray(existing)) {
    return {
      project: existing,
      "cwt-fix-volume-ownership": cwtCmd,
    };
  }
  if (typeof existing === "object") {
    return {
      ...(existing as Record<string, unknown>),
      "cwt-fix-volume-ownership": cwtCmd,
    };
  }
  // Unknown shape — fall back to cwt-only and log nothing (devcontainer CLI
  // will surface schema issues if any).
  return { "cwt-fix-volume-ownership": cwtCmd };
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

  // Docker creates new named volumes root-owned. Our shared cwt-claude-config
  // and cwt-gh-config volumes are mounted into vscode's home, so chown them
  // every container start (idempotent). Combined with any project-supplied
  // postStartCommand under the named-key form so both run.
  const cwtChown =
    "sudo chown -R vscode:vscode /home/vscode/.claude /home/vscode/.config/gh 2>/dev/null || true";
  const mergedPostStart = mergePostStart(project.postStartCommand, cwtChown);

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
    onCreateCommand: project.onCreateCommand,
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
