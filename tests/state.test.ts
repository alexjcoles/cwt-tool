import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State, type WorktreeEntry } from "../src/state.ts";

function makeEntry(name: string, portBase: number): WorktreeEntry {
  return {
    name,
    branch: name,
    repoRoot: "/tmp/repo",
    worktreePath: `/tmp/wt/${name}`,
    composeProject: `cwt-${name}`,
    serviceName: "app",
    portBase,
    linearId: null,
    dataMount: null,
    createdAt: new Date().toISOString(),
  };
}

describe("State", () => {
  let dir: string;
  let stateFile: string;
  let state: State;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cwt-state-"));
    stateFile = join(dir, "state.json");
    state = new State(stateFile);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns empty state when file is missing", async () => {
    const data = await state.load();
    expect(data.worktrees).toEqual([]);
    expect(data.version).toBe(1);
  });

  test("addWorktree persists entry to disk", async () => {
    await state.addWorktree(makeEntry("foo", 8000));
    const reloaded = new State(stateFile);
    const list = await reloaded.listWorktrees();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("foo");
    expect(list[0]?.portBase).toBe(8000);
  });

  test("addWorktree refuses duplicates", async () => {
    await state.addWorktree(makeEntry("foo", 8000));
    await expect(state.addWorktree(makeEntry("foo", 8100))).rejects.toThrow(
      /already exists/,
    );
  });

  test("removeWorktree removes entry", async () => {
    await state.addWorktree(makeEntry("foo", 8000));
    await state.addWorktree(makeEntry("bar", 8100));
    await state.removeWorktree("foo");
    const list = await state.listWorktrees();
    expect(list).toHaveLength(1);
    expect(list[0]?.name).toBe("bar");
  });

  test("removeWorktree throws when worktree absent", async () => {
    await expect(state.removeWorktree("nope")).rejects.toThrow(/not found/);
  });

  test("findWorktree returns null when absent", async () => {
    expect(await state.findWorktree("missing")).toBeNull();
  });

  test("nextPortBase starts at 8000 when empty", async () => {
    expect(await state.nextPortBase()).toBe(8000);
  });

  test("nextPortBase returns sequential blocks", async () => {
    await state.addWorktree(makeEntry("a", 8000));
    expect(await state.nextPortBase()).toBe(8100);
    await state.addWorktree(makeEntry("b", 8100));
    expect(await state.nextPortBase()).toBe(8200);
  });

  test("nextPortBase reuses gaps", async () => {
    await state.addWorktree(makeEntry("a", 8000));
    await state.addWorktree(makeEntry("b", 8100));
    await state.addWorktree(makeEntry("c", 8200));
    await state.removeWorktree("b");
    expect(await state.nextPortBase()).toBe(8100);
  });

  test("save writes valid JSON", async () => {
    await state.addWorktree(makeEntry("foo", 8000));
    const raw = await Bun.file(stateFile).text();
    const parsed = JSON.parse(raw);
    expect(parsed.worktrees).toHaveLength(1);
  });

  test("getLastDefaults returns null when never set", async () => {
    expect(await state.getLastDefaults()).toBeNull();
  });

  test("setLastDefaults persists across worktree removes", async () => {
    await state.setLastDefaults({
      repoRoot: "/path/to/repo",
      serviceName: "rails-app",
      dataMount: "/data",
      branchPrefix: "alexc/",
    });
    await state.addWorktree(makeEntry("foo", 8000));
    await state.removeWorktree("foo");
    const reloaded = new State(stateFile);
    const defaults = await reloaded.getLastDefaults();
    expect(defaults?.repoRoot).toBe("/path/to/repo");
    expect(defaults?.branchPrefix).toBe("alexc/");
  });

  test("setLastDefaults overwrites previous value", async () => {
    await state.setLastDefaults({
      repoRoot: "/old",
      serviceName: "app",
      dataMount: null,
      branchPrefix: null,
    });
    await state.setLastDefaults({
      repoRoot: "/new",
      serviceName: "rails-app",
      dataMount: "/data",
      branchPrefix: "alexc/",
    });
    const defaults = await state.getLastDefaults();
    expect(defaults?.repoRoot).toBe("/new");
    expect(defaults?.serviceName).toBe("rails-app");
  });
});
