// cwt dashboard — hand-rolled ANSI TUI showing all worktrees in one place.
//
// Layout:
//   row 1            : status bar (title, worktree count)
//   row 2            : table header
//   rows 3..N        : worktree rows (NAME, PHASE, SUMMARY, FILE, AGE)
//   spacer + divider : "── activity: <selected> ──"
//   activity rows    : last 12 lines of <selected>'s activity.jsonl
//   row termRows-1   : keybindings hint
//   row termRows     : flash message line (flash on action / new prompt)
//
// Modes:
//   - normal              : arrow keys / j-k navigate, ENTER attach, q quit
//   - permission_modal    : shown when a worktree's permission-requests.jsonl
//                           has a pending request. y allows, n denies, ESC
//                           dismisses (request stays pending).
//   - message_input       : 'm' opens a single-line input. ENTER submits to the
//                           selected worktree's inbox.jsonl. ESC cancels.
//
// State communication with the channel server is purely file-based — see
// channel/server.ts for the protocol. Each worktree has a secret at
// ~/.cwt/worktrees/<name>/secret which the dashboard signs every outbound
// line with.

import { readFile, appendFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import kleur from "kleur";
import { State, type WorktreeEntry } from "./state.ts";
import { statusDirForWorktree } from "./util.ts";

interface ChannelStatus {
  state: string;
  summary: string;
  currentFile: string | null;
  updatedAt: string;
}

interface ActivityLine {
  ts: string;
  tool: string;
  target: string | null;
  session?: string;
}

interface PermissionRequest {
  ts: string;
  worktree: string;
  request_id: string;
  tool_name: string;
  description: string;
  input_preview: string;
}

interface DashboardRow {
  entry: WorktreeEntry;
  status: ChannelStatus | null;
  activity: ActivityLine[];
  pendingPermissions: PermissionRequest[];
}

const ESC = "\x1b";
const ENTER_ALT_SCREEN = `${ESC}[?1049h`;
const EXIT_ALT_SCREEN = `${ESC}[?1049l`;
const HIDE_CURSOR = `${ESC}[?25l`;
const SHOW_CURSOR = `${ESC}[?25h`;
const HOME = `${ESC}[H`;
const CLEAR_SCREEN = `${ESC}[2J`;
const CLEAR_LINE = `${ESC}[K`;

function moveTo(row: number, col: number): string {
  return `${ESC}[${row};${col}H`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, "");
}

function padAnsi(s: string, w: number): string {
  const visible = stripAnsi(s).length;
  if (visible >= w) {
    if (visible === w) return s;
    // Truncate visible chars; ANSI codes don't count
    return truncateVisible(s, w);
  }
  return s + " ".repeat(w - visible);
}

function truncateVisible(s: string, w: number): string {
  let visible = 0;
  let out = "";
  let i = 0;
  while (i < s.length && visible < w) {
    if (s[i] === "\x1b") {
      const m = /^\x1b\[[0-9;]*m/.exec(s.slice(i));
      if (m) {
        out += m[0];
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    visible++;
    i++;
  }
  return out;
}

function truncate(s: string, w: number): string {
  if (s.length <= w) return s;
  return s.slice(0, Math.max(0, w - 1)) + "…";
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

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  if (!existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function readLastLines(path: string, n: number): Promise<ActivityLine[]> {
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, "utf8");
    const lines = raw.split("\n").filter((l) => l.trim());
    const last = lines.slice(-n);
    return last
      .map((line) => {
        try {
          return JSON.parse(line) as ActivityLine;
        } catch {
          return null;
        }
      })
      .filter((x): x is ActivityLine => x !== null);
  } catch {
    return [];
  }
}

// Permission tailer: tracks byte offset per worktree, returns NEW requests
// since last call. `state.offsets` is mutated in place.
interface TailerState {
  offsets: Map<string, number>;
  resolved: Set<string>; // request_ids we've already answered or dismissed
}

async function readNewPermissionRequests(
  worktreeName: string,
  state: TailerState,
): Promise<PermissionRequest[]> {
  const file = join(statusDirForWorktree(worktreeName), "permission-requests.jsonl");
  if (!existsSync(file)) return [];
  const size = (await stat(file)).size;
  const prev = state.offsets.get(worktreeName) ?? size; // skip history on first tick
  if (size <= prev) {
    state.offsets.set(worktreeName, size);
    return [];
  }
  const raw = await readFile(file, "utf8");
  const newSlice = raw.slice(prev);
  state.offsets.set(worktreeName, size);
  const out: PermissionRequest[] = [];
  for (const line of newSlice.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as PermissionRequest;
      if (state.resolved.has(parsed.request_id)) continue;
      out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

async function loadSecret(worktreeName: string): Promise<string | null> {
  const file = join(statusDirForWorktree(worktreeName), "secret");
  if (!existsSync(file)) return null;
  return (await readFile(file, "utf8")).trim();
}

async function appendVerdict(
  worktreeName: string,
  requestId: string,
  behavior: "allow" | "deny",
): Promise<void> {
  const secret = await loadSecret(worktreeName);
  if (!secret) {
    throw new Error(
      `No secret file at ~/.cwt/worktrees/${worktreeName}/secret — recreate the worktree.`,
    );
  }
  const file = join(statusDirForWorktree(worktreeName), "permission-verdicts.jsonl");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    secret,
    request_id: requestId,
    behavior,
  });
  await appendFile(file, line + "\n", "utf8");
}

async function appendInbox(worktreeName: string, content: string): Promise<void> {
  const secret = await loadSecret(worktreeName);
  if (!secret) {
    throw new Error(
      `No secret file at ~/.cwt/worktrees/${worktreeName}/secret — recreate the worktree.`,
    );
  }
  const file = join(statusDirForWorktree(worktreeName), "inbox.jsonl");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    secret,
    content,
    meta: { source: "dashboard" },
  });
  await appendFile(file, line + "\n", "utf8");
}

interface SnapshotResult {
  rows: DashboardRow[];
  newRequests: PermissionRequest[]; // NEW requests since last call, all worktrees
}

function inferBranchPrefix(rows: DashboardRow[]): string | null {
  // If existing worktrees use a username prefix in branch names (e.g.
  // "alexc/amphtt-959-..."), apply the same to new ones for consistency.
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    (b.entry.createdAt ?? "").localeCompare(a.entry.createdAt ?? ""),
  );
  const newest = sorted[0]!;
  const branch = newest.entry.branch;
  if (branch.includes("/")) {
    return branch.slice(0, branch.indexOf("/") + 1);
  }
  return null;
}

function inferNewDefaults(rows: DashboardRow[]): {
  repoRoot: string;
  serviceName: string;
  dataMount: string | null;
} | null {
  // Use the most recently created worktree's settings as the template
  // for new worktrees. Common case: a user is on one project and wants
  // a second worktree with the same shape as the first.
  if (rows.length === 0) return null;
  const sorted = [...rows].sort((a, b) =>
    (b.entry.createdAt ?? "").localeCompare(a.entry.createdAt ?? ""),
  );
  const newest = sorted[0]!;
  return {
    repoRoot: newest.entry.repoRoot,
    serviceName: newest.entry.serviceName ?? "app",
    dataMount: newest.entry.dataMount ?? null,
  };
}

async function snapshot(tailer: TailerState): Promise<SnapshotResult> {
  const state = new State();
  const entries = await state.listWorktrees();
  const rows: DashboardRow[] = [];
  const newRequests: PermissionRequest[] = [];
  for (const entry of entries) {
    const dir = statusDirForWorktree(entry.name);
    const status = await readJsonOrNull<ChannelStatus>(join(dir, "state.json"));
    const activity = await readLastLines(join(dir, "activity.jsonl"), 12);

    const newPending = await readNewPermissionRequests(entry.name, tailer);
    newRequests.push(...newPending);

    rows.push({
      entry,
      status,
      activity,
      pendingPermissions: [], // filled in by caller from queue
    });
  }
  return { rows, newRequests };
}

type Mode =
  | { kind: "normal" }
  | { kind: "permission"; req: PermissionRequest }
  | { kind: "message"; targetWorktree: string; buffer: string }
  | { kind: "new_worktree"; buffer: string };

interface RenderOpts {
  rows: DashboardRow[];
  selected: number;
  cols: number;
  termRows: number;
  message: string | null;
  mode: Mode;
  pendingByWorktree: Map<string, number>;
}

function renderTable(opts: RenderOpts): string {
  const { rows, selected, cols, termRows, message, mode, pendingByWorktree } = opts;
  const out: string[] = [];
  out.push(HOME);

  // Status bar
  const totalPending = Array.from(pendingByWorktree.values()).reduce((a, b) => a + b, 0);
  const pendingNote =
    totalPending > 0
      ? kleur.bold().yellow(` · ${totalPending} pending permission${totalPending === 1 ? "" : "s"} `)
      : "";
  const title =
    kleur.bold().bgBlue().white(
      ` cwt dashboard — ${rows.length} worktree${rows.length === 1 ? "" : "s"} `,
    ) + pendingNote;
  out.push(title + CLEAR_LINE + "\n");

  // Table header
  const colW = {
    name: 30,
    phase: 9,
    summary: Math.max(20, cols - 30 - 9 - 28 - 6 - 8),
    file: 28,
    age: 6,
  };
  const header = [
    padAnsi(kleur.bold("NAME"), colW.name),
    padAnsi(kleur.bold("PHASE"), colW.phase),
    padAnsi(kleur.bold("SUMMARY"), colW.summary),
    padAnsi(kleur.bold("FILE"), colW.file),
    padAnsi(kleur.bold("AGE"), colW.age),
  ].join(" ");
  out.push(header + CLEAR_LINE + "\n");

  if (rows.length === 0) {
    out.push(kleur.dim("  (no worktrees yet — `cwt new <name>`)") + CLEAR_LINE + "\n");
  }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const isSel = i === selected;
    const pendingForRow = pendingByWorktree.get(row.entry.name) ?? 0;
    const marker = isSel
      ? kleur.bold().yellow("›")
      : pendingForRow > 0
      ? kleur.bold().red("!")
      : " ";
    const name = padAnsi(row.entry.name, colW.name - 2);
    const phase = padAnsi(
      row.status ? colorState(row.status.state) : kleur.dim("—"),
      colW.phase,
    );
    const summaryRaw = row.status?.summary ?? "(no report yet)";
    const summary = padAnsi(
      row.status ? truncate(summaryRaw, colW.summary) : kleur.dim("(no report yet)"),
      colW.summary,
    );
    const file = padAnsi(
      row.status?.currentFile ? truncate(row.status.currentFile, colW.file) : kleur.dim("—"),
      colW.file,
    );
    const age = padAnsi(
      row.status ? relativeTime(row.status.updatedAt) : kleur.dim("—"),
      colW.age,
    );
    let line = `${marker} ${name} ${phase} ${summary} ${file} ${age}`;
    if (isSel) line = kleur.inverse(line);
    out.push(line + CLEAR_LINE + "\n");
  }

  // Activity pane
  out.push("\n");
  const sel = rows[selected];
  const activityTitle = sel
    ? `── activity: ${sel.entry.name} ${"─".repeat(Math.max(0, cols - 14 - sel.entry.name.length))}`
    : "── activity ".padEnd(cols, "─");
  out.push(kleur.dim(activityTitle.slice(0, cols)) + CLEAR_LINE + "\n");

  if (sel) {
    if (sel.activity.length === 0) {
      out.push(kleur.dim("  (no activity yet)") + CLEAR_LINE + "\n");
    } else {
      for (const a of sel.activity) {
        const ts = new Date(a.ts).toLocaleTimeString();
        const target = a.target ? truncate(a.target, cols - 30) : "";
        out.push(
          kleur.dim(ts) +
            "  " +
            kleur.cyan(padAnsi(a.tool, 14)) +
            "  " +
            target +
            CLEAR_LINE +
            "\n",
        );
      }
    }
  }

  // Hint bar
  out.push(moveTo(termRows - 1, 1));
  let hint: string;
  if (mode.kind === "permission") {
    hint = kleur.bold().yellow("PERMISSION: ") + kleur.dim("y allow · n deny · ESC dismiss");
  } else if (mode.kind === "message") {
    hint = kleur.bold().cyan("MESSAGE: ") + kleur.dim("type · ENTER send · ESC cancel");
  } else {
    hint = kleur.dim(
      "↑↓ navigate · ENTER attach (Ctrl+B D to detach) · n new · m message · p next prompt · q quit",
    );
  }
  out.push(hint + CLEAR_LINE);

  // Flash message
  out.push(moveTo(termRows, 1));
  if (message) {
    out.push(kleur.bold().bgYellow().black(` ${message} `) + CLEAR_LINE);
  } else {
    out.push(CLEAR_LINE);
  }

  return out.join("");
}

function renderPermissionModal(req: PermissionRequest, cols: number, termRows: number): string {
  const out: string[] = [];
  const w = Math.min(cols - 4, 80);
  const startRow = Math.max(2, Math.floor((termRows - 12) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));

  const horiz = "─".repeat(w - 2);
  const blank = " ".repeat(w - 2);

  const lines: string[] = [
    kleur.yellow(`┌${horiz}┐`),
    kleur.yellow("│") + kleur.bold().yellow(padAnsi(` PERMISSION REQUEST · ${req.worktree}`, w - 2)) + kleur.yellow("│"),
    kleur.yellow(`├${horiz}┤`),
    kleur.yellow("│") + padAnsi(` Tool:   ${kleur.cyan(req.tool_name)}`, w - 2) + kleur.yellow("│"),
    kleur.yellow("│") + padAnsi(` ID:     ${req.request_id}`, w - 2) + kleur.yellow("│"),
    kleur.yellow("│") + padAnsi(` What:   ${truncate(req.description, w - 12)}`, w - 2) + kleur.yellow("│"),
    kleur.yellow("│") + padAnsi(` Input:  ${truncate(req.input_preview, w - 12)}`, w - 2) + kleur.yellow("│"),
    kleur.yellow(`├${horiz}┤`),
    kleur.yellow("│") + padAnsi(`   ${kleur.bold().green("[y]")} allow      ${kleur.bold().red("[n]")} deny      ${kleur.dim("[ESC] dismiss")}`, w - 2) + kleur.yellow("│"),
    kleur.yellow(`└${horiz}┘`),
  ];

  for (let i = 0; i < lines.length; i++) {
    out.push(moveTo(startRow + i, startCol) + lines[i]);
  }
  return out.join("");
}

function renderMessageInput(
  targetWorktree: string,
  buffer: string,
  cols: number,
  termRows: number,
): string {
  const out: string[] = [];
  const w = Math.min(cols - 4, 80);
  const startRow = Math.max(2, Math.floor((termRows - 6) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));

  const horiz = "─".repeat(w - 2);
  const inputLine = ` > ${buffer}` + "_";
  const lines = [
    kleur.cyan(`┌${horiz}┐`),
    kleur.cyan("│") + padAnsi(` Send message to ${kleur.bold(targetWorktree)}`, w - 2) + kleur.cyan("│"),
    kleur.cyan(`├${horiz}┤`),
    kleur.cyan("│") + padAnsi(inputLine, w - 2) + kleur.cyan("│"),
    kleur.cyan(`└${horiz}┘`),
  ];
  for (let i = 0; i < lines.length; i++) {
    out.push(moveTo(startRow + i, startCol) + lines[i]);
  }
  return out.join("");
}

function renderNewWorktreeInput(
  buffer: string,
  defaults: { repoRoot: string; serviceName: string; dataMount: string | null } | null,
  branchPrefix: string | null,
  cols: number,
  termRows: number,
): string {
  const out: string[] = [];
  const w = Math.min(cols - 4, 86);
  const startRow = Math.max(2, Math.floor((termRows - 13) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));

  const horiz = "─".repeat(w - 2);
  const inputLine = ` issue id > ${buffer}` + "_";
  // Show what the worktree name + branch will resolve to as the user types
  const normalized = buffer.trim().toLowerCase();
  const previewName = normalized || kleur.dim("(type an issue id, e.g. AMPHTT-929)");
  const previewBranch = normalized
    ? `${branchPrefix ?? ""}${normalized}`
    : kleur.dim("(derived from issue id)");

  const lines: string[] = [
    kleur.green(`┌${horiz}┐`),
    kleur.green("│") + padAnsi(` ${kleur.bold("NEW WORKTREE")}`, w - 2) + kleur.green("│"),
    kleur.green(`├${horiz}┤`),
    kleur.green("│") + padAnsi(inputLine, w - 2) + kleur.green("│"),
    kleur.green(`├${horiz}┤`),
    kleur.green("│") +
      padAnsi(` ${kleur.dim("→ name:")}   ${previewName}`, w - 2) +
      kleur.green("│"),
    kleur.green("│") +
      padAnsi(` ${kleur.dim("→ branch:")} ${previewBranch}`, w - 2) +
      kleur.green("│"),
    kleur.green(`├${horiz}┤`),
  ];

  if (defaults) {
    lines.push(
      kleur.green("│") +
        padAnsi(
          ` ${kleur.dim("repo:")}    ${defaults.repoRoot}`,
          w - 2,
        ) +
        kleur.green("│"),
    );
    lines.push(
      kleur.green("│") +
        padAnsi(
          ` ${kleur.dim("service:")} ${defaults.serviceName}`,
          w - 2,
        ) +
        kleur.green("│"),
    );
    lines.push(
      kleur.green("│") +
        padAnsi(
          ` ${kleur.dim("data:")}    ${defaults.dataMount ?? "(none)"}`,
          w - 2,
        ) +
        kleur.green("│"),
    );
    lines.push(
      kleur.green("│") +
        padAnsi(
          ` ${kleur.dim("branch:")}  ${kleur.dim("(defaults to name)")}`,
          w - 2,
        ) +
        kleur.green("│"),
    );
  } else {
    lines.push(
      kleur.green("│") +
        padAnsi(
          ` ${kleur.yellow("No existing worktrees — defaults can't be inferred.")}`,
          w - 2,
        ) +
        kleur.green("│"),
    );
    lines.push(
      kleur.green("│") +
        padAnsi(
          ` ${kleur.dim("Use `cwt new` from the host CLI for the first worktree.")}`,
          w - 2,
        ) +
        kleur.green("│"),
    );
  }

  lines.push(kleur.green(`├${horiz}┤`));
  lines.push(
    kleur.green("│") +
      padAnsi(
        ` ${kleur.bold("ENTER")} create  ${kleur.bold("ESC")} cancel`,
        w - 2,
      ) +
      kleur.green("│"),
  );
  lines.push(kleur.green(`└${horiz}┘`));

  for (let i = 0; i < lines.length; i++) {
    out.push(moveTo(startRow + i, startCol) + lines[i]);
  }
  return out.join("");
}

export async function runDashboard(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error("cwt dashboard requires a TTY");
    process.exit(1);
  }

  const tailer: TailerState = {
    offsets: new Map(),
    resolved: new Set(),
  };
  const pendingQueue: PermissionRequest[] = [];
  const pendingByWorktree = new Map<string, number>();
  let mode: Mode = { kind: "normal" };

  let selected = 0;
  let message: string | null = null;
  let messageExpiresAt = 0;
  let stopped = false;

  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + CLEAR_SCREEN);

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  };

  process.on("SIGINT", () => {
    cleanup();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanup();
    process.exit(0);
  });
  process.on("exit", cleanup);

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let { rows, newRequests } = await snapshot(tailer);
  if (rows.length === 0) {
    cleanup();
    console.log("No worktrees yet. Try: cwt new <name>");
    return;
  }

  const flash = (m: string, ms = 2500): void => {
    message = m;
    messageExpiresAt = Date.now() + ms;
  };

  const recountPendingByWorktree = (): void => {
    pendingByWorktree.clear();
    for (const req of pendingQueue) {
      pendingByWorktree.set(req.worktree, (pendingByWorktree.get(req.worktree) ?? 0) + 1);
    }
  };

  const enterPermissionMode = (): void => {
    if (pendingQueue.length === 0) return;
    if (mode.kind !== "normal") return;
    const req = pendingQueue[0]!;
    mode = { kind: "permission", req };
  };

  const redraw = (): void => {
    const cols = process.stdout.columns ?? 120;
    const termRows = process.stdout.rows ?? 30;
    if (Date.now() > messageExpiresAt) message = null;
    let out =
      CLEAR_SCREEN +
      renderTable({
        rows,
        selected,
        cols,
        termRows,
        message,
        mode,
        pendingByWorktree,
      });
    if (mode.kind === "permission") {
      out += renderPermissionModal(mode.req, cols, termRows);
    } else if (mode.kind === "message") {
      out += renderMessageInput(mode.targetWorktree, mode.buffer, cols, termRows);
    } else if (mode.kind === "new_worktree") {
      const defaults = inferNewDefaults(rows);
      const branchPrefix = inferBranchPrefix(rows);
      out += renderNewWorktreeInput(mode.buffer, defaults, branchPrefix, cols, termRows);
    }
    process.stdout.write(out);
  };

  redraw();

  const tick = setInterval(async () => {
    const result = await snapshot(tailer);
    rows = result.rows;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);

    if (result.newRequests.length > 0) {
      for (const req of result.newRequests) {
        pendingQueue.push(req);
      }
      recountPendingByWorktree();
      // Auto-open the modal for the first new request when in normal mode
      if (mode.kind === "normal") {
        flash(`New permission request from ${result.newRequests[0]!.worktree}`);
        enterPermissionMode();
      }
    }
    redraw();
  }, 750);

  const handleVerdict = async (behavior: "allow" | "deny"): Promise<void> => {
    if (mode.kind !== "permission") return;
    const req = mode.req;
    try {
      await appendVerdict(req.worktree, req.request_id, behavior);
      tailer.resolved.add(req.request_id);
      pendingQueue.shift();
      recountPendingByWorktree();
      flash(`${behavior === "allow" ? "✓ allowed" : "✗ denied"} ${req.tool_name} (${req.request_id}) on ${req.worktree}`);
      mode = { kind: "normal" };
      // If more requests are queued, open the next one
      if (pendingQueue.length > 0) enterPermissionMode();
    } catch (e) {
      flash(`Error: ${(e as Error).message}`);
      mode = { kind: "normal" };
    }
    redraw();
  };

  const handleMessageSubmit = async (): Promise<void> => {
    if (mode.kind !== "message") return;
    const text = mode.buffer.trim();
    const target = mode.targetWorktree;
    if (!text) {
      mode = { kind: "normal" };
      redraw();
      return;
    }
    try {
      await appendInbox(target, text);
      flash(`Message sent to ${target}`);
    } catch (e) {
      flash(`Error: ${(e as Error).message}`);
    }
    mode = { kind: "normal" };
    redraw();
  };

  const onKey = (chunk: string): void => {
    // Permission modal
    if (mode.kind === "permission") {
      if (chunk === "y" || chunk === "Y") {
        void handleVerdict("allow");
      } else if (chunk === "n" || chunk === "N") {
        void handleVerdict("deny");
      } else if (chunk === "\x1b" || chunk === "\x1b\x1b") {
        // ESC → dismiss (request stays unresolved; remove from queue but
        // don't mark resolved, so it can re-appear if Claude retries)
        pendingQueue.shift();
        recountPendingByWorktree();
        mode = { kind: "normal" };
        flash("Dismissed (no verdict sent)");
        if (pendingQueue.length > 0) enterPermissionMode();
        redraw();
      } else if (chunk === "\x03") {
        // Ctrl+C
        clearInterval(tick);
        cleanup();
        process.exit(0);
      }
      return;
    }

    // New worktree input
    if (mode.kind === "new_worktree") {
      if (chunk === "\r" || chunk === "\n") {
        // Issue id is the canonical input. Normalise to lowercase so the
        // user can type AMPHTT-929 or amphtt-929 — same result.
        const name = mode.buffer.trim().toLowerCase();
        if (!name) {
          mode = { kind: "normal" };
          flash("Cancelled (empty input)");
          redraw();
          return;
        }
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          flash(`Invalid issue id "${name}" — letters, digits, hyphens only`);
          redraw();
          return;
        }
        const defaults = inferNewDefaults(rows);
        if (!defaults) {
          flash("No defaults available — use `cwt new` from the host CLI");
          mode = { kind: "normal" };
          redraw();
          return;
        }
        // Exit TUI cleanly so create() logs stream to the user's terminal
        // (docker build output is long; the TUI can't render it sensibly).
        clearInterval(tick);
        cleanup();
        const branchPrefix = inferBranchPrefix(rows);
        const branch = branchPrefix ? `${branchPrefix}${name}` : name;
        process.stdout.write(
          kleur.bold().green("→ creating worktree\n") +
            kleur.dim(`  name:    ${name}\n`) +
            kleur.dim(`  branch:  ${branch}\n`) +
            kleur.dim(`  repo:    ${defaults.repoRoot}\n`) +
            kleur.dim(`  service: ${defaults.serviceName}\n`) +
            kleur.dim(`  data:    ${defaults.dataMount ?? "(none)"}\n\n`),
        );
        // Defer to keep the same control flow as the existing CLI command.
        const { create } = require("./worktree.ts");
        create({
          name,
          branch,
          repoRoot: defaults.repoRoot,
          serviceName: defaults.serviceName,
          dataMount: defaults.dataMount ?? undefined,
        })
          .then(() => {
            process.stdout.write(
              "\n" +
                kleur.green("✓ done. ") +
                kleur.dim(`relaunch with: cwt dashboard\n`),
            );
            process.exit(0);
          })
          .catch((e: Error) => {
            process.stderr.write(kleur.red(`✗ ${e.message}\n`));
            process.exit(1);
          });
        return;
      } else if (chunk === "\x1b") {
        mode = { kind: "normal" };
        flash("Cancelled");
        redraw();
      } else if (chunk === "\x7f" || chunk === "\b") {
        mode = { ...mode, buffer: mode.buffer.slice(0, -1) };
        redraw();
      } else if (chunk === "\x03") {
        clearInterval(tick);
        cleanup();
        process.exit(0);
      } else if (chunk.length === 1 && chunk.charCodeAt(0) >= 32) {
        mode = { ...mode, buffer: mode.buffer + chunk };
        redraw();
      }
      return;
    }

    // Message input
    if (mode.kind === "message") {
      if (chunk === "\r" || chunk === "\n") {
        void handleMessageSubmit();
      } else if (chunk === "\x1b") {
        mode = { kind: "normal" };
        flash("Cancelled");
        redraw();
      } else if (chunk === "\x7f" || chunk === "\b") {
        // backspace
        mode = { ...mode, buffer: mode.buffer.slice(0, -1) };
        redraw();
      } else if (chunk === "\x03") {
        clearInterval(tick);
        cleanup();
        process.exit(0);
      } else if (chunk.length === 1 && chunk.charCodeAt(0) >= 32) {
        mode = { ...mode, buffer: mode.buffer + chunk };
        redraw();
      } else if (chunk.length > 1 && !chunk.startsWith("\x1b")) {
        // pasted text — accept printable chars
        const printable = chunk.replace(/[\x00-\x1f]/g, "");
        mode = { ...mode, buffer: mode.buffer + printable };
        redraw();
      }
      return;
    }

    // Normal mode
    if (chunk === "\x03" || chunk === "q") {
      clearInterval(tick);
      cleanup();
      process.exit(0);
    } else if (chunk === "\x1b[A" || chunk === "k") {
      selected = Math.max(0, selected - 1);
      redraw();
    } else if (chunk === "\x1b[B" || chunk === "j") {
      selected = Math.min(rows.length - 1, selected + 1);
      redraw();
    } else if (chunk === "\r" || chunk === "\n") {
      const target = rows[selected];
      if (!target) return;
      clearInterval(tick);
      cleanup();
      // Pre-attach reminder so the user knows how to get back out before
      // they're dropped into a tmux session.
      process.stdout.write(
        kleur.dim(`→ attaching to ${target.entry.name}\n`) +
          kleur.dim(`  detach with ${kleur.bold("Ctrl+B  D")} (session keeps running)\n`) +
          kleur.dim(`  exit shell with ${kleur.bold("Ctrl+D")} or ${kleur.bold("exit")}\n\n`),
      );
      const { spawnSync } = require("node:child_process");
      spawnSync(
        "docker",
        [
          "compose",
          "-p",
          target.entry.composeProject,
          "-f",
          join(target.entry.worktreePath, ".cwt", "docker-compose.yml"),
          "exec",
          target.entry.serviceName ?? "app",
          "tmux",
          "new-session",
          "-A",
          "-s",
          "cwt",
        ],
        { stdio: "inherit" },
      );
      process.exit(0);
    } else if (chunk === "m") {
      const target = rows[selected];
      if (!target) return;
      mode = { kind: "message", targetWorktree: target.entry.name, buffer: "" };
      redraw();
    } else if (chunk === "n") {
      mode = { kind: "new_worktree", buffer: "" };
      redraw();
    } else if (chunk === "p") {
      // Manually open the permission modal for the next pending request
      if (pendingQueue.length === 0) {
        flash("No pending permission requests");
      } else {
        enterPermissionMode();
      }
      redraw();
    }
  };

  process.stdin.on("data", onKey);
}
