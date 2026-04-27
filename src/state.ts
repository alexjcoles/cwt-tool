import { readFile, writeFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { CWT_HOME, CWT_STATE_FILE, ensureDir } from "./util.ts";

export interface WorktreeEntry {
  name: string;
  branch: string;
  repoRoot: string;
  worktreePath: string;
  composeProject: string;
  portBase: number;
  linearId: string | null;
  dataMount: string | null;
  createdAt: string;
}

export interface StateData {
  version: number;
  worktrees: WorktreeEntry[];
}

const EMPTY_STATE: StateData = { version: 1, worktrees: [] };
const PORT_BLOCK_SIZE = 100;
const PORT_BASE_START = 8000;
const PORT_BASE_MAX = 9900;

export class State {
  constructor(private readonly filePath: string = CWT_STATE_FILE) {}

  async load(): Promise<StateData> {
    if (!existsSync(this.filePath)) {
      return structuredClone(EMPTY_STATE);
    }
    const raw = await readFile(this.filePath, "utf8");
    if (raw.trim() === "") return structuredClone(EMPTY_STATE);
    const parsed = JSON.parse(raw) as StateData;
    if (!parsed.worktrees) parsed.worktrees = [];
    return parsed;
  }

  async save(data: StateData): Promise<void> {
    await ensureDir(dirname(this.filePath));
    const tmp = `${this.filePath}.tmp.${process.pid}`;
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf8");
    await rename(tmp, this.filePath);
  }

  async listWorktrees(): Promise<WorktreeEntry[]> {
    const data = await this.load();
    return data.worktrees;
  }

  async findWorktree(name: string): Promise<WorktreeEntry | null> {
    const data = await this.load();
    return data.worktrees.find((w) => w.name === name) ?? null;
  }

  async addWorktree(entry: WorktreeEntry): Promise<void> {
    const data = await this.load();
    if (data.worktrees.some((w) => w.name === entry.name)) {
      throw new Error(`Worktree "${entry.name}" already exists in state`);
    }
    data.worktrees.push(entry);
    await this.save(data);
  }

  async removeWorktree(name: string): Promise<void> {
    const data = await this.load();
    const before = data.worktrees.length;
    data.worktrees = data.worktrees.filter((w) => w.name !== name);
    if (data.worktrees.length === before) {
      throw new Error(`Worktree "${name}" not found in state`);
    }
    await this.save(data);
  }

  async nextPortBase(): Promise<number> {
    const data = await this.load();
    const used = new Set(data.worktrees.map((w) => w.portBase));
    for (let p = PORT_BASE_START; p <= PORT_BASE_MAX; p += PORT_BLOCK_SIZE) {
      if (!used.has(p)) return p;
    }
    throw new Error(
      `No free port block available in range ${PORT_BASE_START}-${PORT_BASE_MAX}`,
    );
  }
}

export const PORT_BLOCK = PORT_BLOCK_SIZE;
