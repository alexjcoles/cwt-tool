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

interface DecisionRequest {
  ts: string;
  worktree: string;
  request_id: string;
  question: string;
  options: string[];
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

// List the files that differ between main..HEAD in the worktree, with
// add/delete counts. Uses host-side git (the worktree's .git is on the host
// filesystem) so we don't need to docker exec.
async function listDiffFiles(entry: WorktreeEntry): Promise<DiffFileStat[]> {
  const { spawnSync } = await import("node:child_process");
  // --numstat: "added\tdeleted\tpath" per line. Binary files show "-\t-\tpath".
  const result = spawnSync(
    "git",
    ["-C", entry.worktreePath, "diff", "--numstat", "main..HEAD"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) return [];
  const lines = result.stdout.split("\n").filter((l) => l.trim());
  const out: DiffFileStat[] = [];
  for (const line of lines) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const [a, d, ...pathParts] = parts;
    const path = pathParts.join("\t"); // path may contain tabs theoretically
    const binary = a === "-" && d === "-";
    out.push({
      added: binary ? 0 : parseInt(a ?? "0", 10),
      deleted: binary ? 0 : parseInt(d ?? "0", 10),
      path,
      binary,
    });
  }
  return out;
}

// Find the plan file for a worktree by globbing
// <worktreePath>/docs/plans/**/<issue-id-lowercase>-*.md.
// Returns null if no plan exists yet. Falls back to checking just the
// numeric portion of the issue ID if linearId isn't set on the entry.
async function findPlanForWorktree(
  entry: WorktreeEntry,
): Promise<string | null> {
  const plansDir = join(entry.worktreePath, "docs", "plans");
  if (!existsSync(plansDir)) return null;
  const fs = await import("node:fs/promises");
  const issueId = entry.linearId?.toLowerCase() ?? entry.name;
  // Walk all plan files and find one whose filename matches the issue id
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const items = await fs.readdir(dir, { withFileTypes: true });
    for (const item of items) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        await walk(full);
      } else if (item.isFile() && item.name.endsWith(".md")) {
        // match amphtt-NNN-*.md or amphtt-NNN.md
        if (item.name.toLowerCase().startsWith(issueId.toLowerCase())) {
          found.push(full);
        }
      }
    }
  }
  try {
    await walk(plansDir);
  } catch {
    return null;
  }
  return found[0] ?? null;
}

// Extract the printable portion of a stdin chunk in raw mode.
//
// Possible chunk shapes:
//   - "x"                          single printable char (most keys)
//   - "\x1b[A"                     arrow key / ANSI escape — return null
//   - "\x1b[200~hello\x1b[201~"    bracketed paste with markers
//   - "hello world"                plain paste (multi-byte chunk, no escapes)
//   - "\r" / "\n" / "\x7f" / etc   control chars — return null
//
// Returns the printable chars to append, or null if the chunk should be
// handled by other branches (escape, control, etc.).
function extractPaste(chunk: string): string | null {
  // Bracketed paste — strip markers, then control chars.
  if (chunk.startsWith("\x1b[200~")) {
    const end = chunk.indexOf("\x1b[201~");
    const inner = end >= 0 ? chunk.slice(6, end) : chunk.slice(6);
    const cleaned = inner.replace(/[\x00-\x1f]/g, "");
    return cleaned || null;
  }
  // Other escape sequences are non-input (arrow keys etc).
  if (chunk.startsWith("\x1b")) return null;
  // Single printable char.
  if (chunk.length === 1) {
    const code = chunk.charCodeAt(0);
    return code >= 32 && code !== 127 ? chunk : null;
  }
  // Multi-byte non-escape chunk — almost certainly a paste. Strip control
  // chars (newlines, tabs, etc.) and return whatever's left.
  const cleaned = chunk.replace(/[\x00-\x1f\x7f]/g, "");
  return cleaned || null;
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

// Permission + decision tailer: tracks byte offset per worktree per file
// kind, returns NEW requests since last call. `state.offsets` is mutated.
interface TailerState {
  offsets: Map<string, number>; // key: "<worktree>::<kind>"
  resolved: Set<string>; // request_ids we've already answered or dismissed
}

async function readNewLines<T extends { request_id: string }>(
  worktreeName: string,
  fileName: string,
  state: TailerState,
): Promise<T[]> {
  const file = join(statusDirForWorktree(worktreeName), fileName);
  if (!existsSync(file)) return [];
  const size = (await stat(file)).size;
  const key = `${worktreeName}::${fileName}`;
  // Default to 0 (read from start) so files that didn't exist when the
  // dashboard started — e.g. a brand-new worktree's decision-requests.jsonl
  // appearing mid-session — are read in full. Files that DID exist at
  // startup are explicitly seeded with their then-current size, so this
  // default doesn't accidentally replay history. tailer.resolved
  // deduplicates anything we've already seen via loadPendingDecisions.
  const prev = state.offsets.get(key) ?? 0;
  if (size <= prev) {
    state.offsets.set(key, size);
    return [];
  }
  // Read as Buffer (bytes) and slice by byte offset, then decode to UTF-8.
  // String slicing operates on UTF-16 code units, which doesn't match the
  // byte count returned by stat() when the file contains multi-byte UTF-8
  // characters (em-dashes, arrows, emoji). Slicing the string by a byte
  // offset overshoots the end and silently drops appended lines.
  const buf = await readFile(file);
  const newSlice = buf.subarray(prev).toString("utf8");
  state.offsets.set(key, size);
  const out: T[] = [];
  for (const line of newSlice.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as T;
      if (state.resolved.has(parsed.request_id)) continue;
      out.push(parsed);
    } catch {
      // skip malformed
    }
  }
  return out;
}

interface DecisionsLoad {
  pending: DecisionRequest[];
  answeredIds: Set<string>;
  allRequestIds: Set<string>;
}

// Walk a worktree's decision-requests.jsonl and decision-answers.jsonl,
// returning what's pending and what's answered. Used at dashboard startup
// to (a) surface still-pending decisions even though the byte-offset
// tailer would skip them, and (b) seed tailer.resolved with already-seen
// IDs so the tailer's read-from-zero default doesn't replay history.
async function loadDecisions(worktreeName: string): Promise<DecisionsLoad> {
  const dir = statusDirForWorktree(worktreeName);
  const requestsFile = join(dir, "decision-requests.jsonl");
  const result: DecisionsLoad = {
    pending: [],
    answeredIds: new Set(),
    allRequestIds: new Set(),
  };
  if (!existsSync(requestsFile)) return result;

  const requestsRaw = await readFile(requestsFile, "utf8");
  const allRequests: DecisionRequest[] = [];
  for (const line of requestsRaw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const req = JSON.parse(line) as DecisionRequest;
      allRequests.push(req);
      result.allRequestIds.add(req.request_id);
    } catch {
      // skip malformed
    }
  }

  const answersFile = join(dir, "decision-answers.jsonl");
  if (existsSync(answersFile)) {
    const answersRaw = await readFile(answersFile, "utf8");
    for (const line of answersRaw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as { request_id?: string };
        if (typeof parsed.request_id === "string") {
          result.answeredIds.add(parsed.request_id);
        }
      } catch {
        // skip malformed
      }
    }
  }

  result.pending = allRequests.filter(
    (r) => !result.answeredIds.has(r.request_id),
  );
  return result;
}

async function readNewPermissionRequests(
  worktreeName: string,
  state: TailerState,
): Promise<PermissionRequest[]> {
  return readNewLines<PermissionRequest>(
    worktreeName,
    "permission-requests.jsonl",
    state,
  );
}

async function readNewDecisionRequests(
  worktreeName: string,
  state: TailerState,
): Promise<DecisionRequest[]> {
  return readNewLines<DecisionRequest>(
    worktreeName,
    "decision-requests.jsonl",
    state,
  );
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

async function appendDecisionAnswer(
  worktreeName: string,
  requestId: string,
  answer: string,
): Promise<void> {
  const secret = await loadSecret(worktreeName);
  if (!secret) {
    throw new Error(
      `No secret file at ~/.cwt/worktrees/${worktreeName}/secret — recreate the worktree.`,
    );
  }
  const file = join(statusDirForWorktree(worktreeName), "decision-answers.jsonl");
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    secret,
    request_id: requestId,
    answer,
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
  newRequests: PermissionRequest[]; // NEW permission requests since last call
  newDecisions: DecisionRequest[]; // NEW decision requests since last call
  lastDefaults: import("./state.ts").LastDefaults | null;
}

function inferBranchPrefix(
  rows: DashboardRow[],
  persisted: { branchPrefix: string | null } | null,
): string | null {
  // Prefer the most recently created worktree's branch prefix; fall back to
  // the persisted lastDefaults so 'n' still works after removing the last
  // worktree.
  if (rows.length > 0) {
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
  return persisted?.branchPrefix ?? null;
}

function inferNewDefaults(
  rows: DashboardRow[],
  persisted: {
    repoRoot: string;
    serviceName: string;
    dataMount: string | null;
  } | null,
): {
  repoRoot: string;
  serviceName: string;
  dataMount: string | null;
} | null {
  // Prefer most recently created worktree (covers the common case of "make
  // another like the last one"); fall back to persisted lastDefaults so
  // the dashboard's 'n' flow still works after removing every worktree.
  if (rows.length > 0) {
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
  return persisted;
}

async function snapshot(tailer: TailerState): Promise<SnapshotResult> {
  const state = new State();
  const entries = await state.listWorktrees();
  const lastDefaults = await state.getLastDefaults();
  const rows: DashboardRow[] = [];
  const newRequests: PermissionRequest[] = [];
  const newDecisions: DecisionRequest[] = [];
  for (const entry of entries) {
    const dir = statusDirForWorktree(entry.name);
    const status = await readJsonOrNull<ChannelStatus>(join(dir, "state.json"));
    const activity = await readLastLines(join(dir, "activity.jsonl"), 12);

    const newPending = await readNewPermissionRequests(entry.name, tailer);
    newRequests.push(...newPending);

    const newDecPending = await readNewDecisionRequests(entry.name, tailer);
    newDecisions.push(...newDecPending);

    rows.push({
      entry,
      status,
      activity,
      pendingPermissions: [], // filled in by caller from queue
    });
  }
  return { rows, newRequests, newDecisions, lastDefaults };
}

type Mode =
  | { kind: "normal" }
  | { kind: "permission"; req: PermissionRequest }
  | { kind: "decision"; req: DecisionRequest; buffer: string }
  | { kind: "message"; targetWorktree: string; buffer: string }
  | { kind: "new_worktree"; buffer: string }
  | { kind: "remove_confirm"; entry: WorktreeEntry }
  | { kind: "bash_input"; entry: WorktreeEntry; buffer: string }
  | {
      kind: "view_plan";
      entry: WorktreeEntry;
      planPath: string;
      lines: string[];
      scrollOffset: number;
    }
  | {
      kind: "view_diff_files";
      entry: WorktreeEntry;
      files: DiffFileStat[];
      selected: number;
      scrollOffset: number;
    };

interface DiffFileStat {
  added: number; // null if binary
  deleted: number;
  path: string;
  binary: boolean;
}

interface RenderOpts {
  rows: DashboardRow[];
  selected: number;
  cols: number;
  termRows: number;
  message: string | null;
  mode: Mode;
  pendingByWorktree: Map<string, number>;
  pendingDecisionCount: number;
}

function renderTable(opts: RenderOpts): string {
  const { rows, selected, cols, termRows, message, mode, pendingByWorktree } = opts;
  const out: string[] = [];
  out.push(HOME);

  // Status bar — always show the counts (including 0) so the user can
  // tell at a glance whether the loaders/tailers are tracking anything.
  const totalPending = Array.from(pendingByWorktree.values()).reduce((a, b) => a + b, 0);
  const pendingStyle = totalPending > 0 ? kleur.bold().yellow : kleur.dim;
  const pendingNote = pendingStyle(
    ` · ${totalPending} perm${totalPending === 1 ? "" : "s"} pending `,
  );
  const decisionStyle =
    opts.pendingDecisionCount > 0 ? kleur.bold().magenta : kleur.dim;
  const decisionNote = decisionStyle(
    ` · ${opts.pendingDecisionCount} decision${opts.pendingDecisionCount === 1 ? "" : "s"} pending `,
  );
  const linearNote = process.env.LINEAR_API_KEY
    ? kleur.dim(` · Linear: ${kleur.green("on")} `)
    : kleur.dim(` · Linear: ${kleur.red("off")} `);
  const title =
    kleur.bold().bgBlue().white(
      ` cwt dashboard — ${rows.length} worktree${rows.length === 1 ? "" : "s"} `,
    ) + pendingNote + decisionNote + linearNote;
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
    out.push(
      kleur.dim("  (no worktrees yet — press ") +
        kleur.bold("n") +
        kleur.dim(" to create one)") +
        CLEAR_LINE +
        "\n",
    );
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
  } else if (mode.kind === "decision") {
    hint =
      kleur.bold().magenta("DECISION: ") +
      kleur.dim("type answer · ENTER send · ESC dismiss");
  } else if (mode.kind === "message") {
    hint = kleur.bold().cyan("MESSAGE: ") + kleur.dim("type · ENTER send · ESC cancel");
  } else if (mode.kind === "remove_confirm") {
    hint = kleur.bold().red("REMOVE: ") + kleur.dim("y confirm · n cancel");
  } else if (mode.kind === "bash_input") {
    hint =
      kleur.bold().cyan("BASH: ") +
      kleur.dim("type · ENTER run · ESC cancel");
  } else if (mode.kind === "view_plan") {
    // Plan view renders its own footer; this hint is unused but assigned
    // so we don't write the table-mode hint line on top of the plan body.
    hint = "";
  } else if (mode.kind === "view_diff_files") {
    // Diff file list renders its own footer too.
    hint = "";
  } else {
    hint = kleur.dim(
      "↑↓ nav · ENTER attach · n new · x kill · v plan · g diff · b bash · d decide · m msg · p perm · q quit",
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

function renderDecisionInput(
  req: DecisionRequest,
  buffer: string,
  cols: number,
  termRows: number,
): string {
  const out: string[] = [];
  const w = Math.min(cols - 4, 90);
  // Wrap question to width-4
  const wrapWidth = w - 4;
  const wrapped: string[] = [];
  for (const para of req.question.split("\n")) {
    if (para.length <= wrapWidth) {
      wrapped.push(para);
      continue;
    }
    let line = "";
    for (const word of para.split(" ")) {
      if (line.length + word.length + 1 > wrapWidth) {
        wrapped.push(line);
        line = word;
      } else {
        line = line ? `${line} ${word}` : word;
      }
    }
    if (line) wrapped.push(line);
  }
  const optionsLine =
    req.options && req.options.length > 0
      ? ` ${kleur.dim("preset:")} ${req.options.map((o) => kleur.bold().yellow(`[${o}]`)).join("  ")}`
      : null;

  const totalLines =
    1 + // top border
    1 + // title
    1 + // separator
    wrapped.length + // question body
    (optionsLine ? 1 : 0) +
    1 + // separator
    1 + // input
    1 + // separator
    1 + // footer
    1; // bottom border
  const startRow = Math.max(2, Math.floor((termRows - totalLines) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));

  const horiz = "─".repeat(w - 2);
  const lines: string[] = [];
  lines.push(kleur.magenta(`┌${horiz}┐`));
  lines.push(
    kleur.magenta("│") +
      padAnsi(
        ` ${kleur.bold().magenta("DECISION")} · ${kleur.dim(req.worktree)} · ${kleur.dim(req.request_id)}`,
        w - 2,
      ) +
      kleur.magenta("│"),
  );
  lines.push(kleur.magenta(`├${horiz}┤`));
  for (const line of wrapped) {
    lines.push(kleur.magenta("│") + padAnsi(`  ${line}`, w - 2) + kleur.magenta("│"));
  }
  if (optionsLine) {
    lines.push(kleur.magenta("│") + padAnsi(optionsLine, w - 2) + kleur.magenta("│"));
  }
  lines.push(kleur.magenta(`├${horiz}┤`));
  const inputLine = ` answer > ${buffer}_`;
  lines.push(kleur.magenta("│") + padAnsi(inputLine, w - 2) + kleur.magenta("│"));
  lines.push(kleur.magenta(`├${horiz}┤`));
  lines.push(
    kleur.magenta("│") +
      padAnsi(
        ` ${kleur.bold("ENTER")} send  ${kleur.bold("ESC")} dismiss (no answer)`,
        w - 2,
      ) +
      kleur.magenta("│"),
  );
  lines.push(kleur.magenta(`└${horiz}┘`));

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

// Word-wrap a line to fit within `width` characters. Preserves indent for
// continuation lines so wrapped bullet-list text lines up under the content
// after the bullet, not under the bullet itself. Hard-breaks single words
// longer than the width (URLs, etc.).
function wrapLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const bulletMatch = /^(\s*(?:[-*+]|\d+\.)\s+)/.exec(line);
  const indentMatch = /^(\s+)/.exec(line);
  const continuationIndent = bulletMatch
    ? " ".repeat(bulletMatch[1]!.length)
    : indentMatch
      ? indentMatch[1]!
      : "";
  const out: string[] = [];
  const words = line.split(" ");
  let current = "";
  for (const word of words) {
    const sep = current ? " " : "";
    if (current.length + sep.length + word.length <= width) {
      current += sep + word;
      continue;
    }
    if (current) out.push(current);
    if (word.length > width) {
      // Single word longer than width — hard break.
      let remaining = continuationIndent + word;
      while (remaining.length > width) {
        out.push(remaining.slice(0, width));
        remaining = continuationIndent + remaining.slice(width);
      }
      current = remaining;
    } else {
      current = continuationIndent + word;
    }
  }
  if (current) out.push(current);
  return out;
}

// Wrap a whole document and return both the flat wrapped lines and a map
// from each wrapped line back to its source line index (for scrollbar /
// position display). Markdown highlighting is applied per source line so
// every wrapped fragment of a heading is bold, etc.
function wrapPlanLines(
  lines: string[],
  width: number,
): { wrapped: string[]; total: number } {
  const wrapped: string[] = [];
  for (const line of lines) {
    const fragments = wrapLine(line, width);
    let style: ((s: string) => string) | null = null;
    if (/^#+\s/.test(line)) style = (s) => kleur.bold().cyan(s);
    else if (/^\s*[-*]\s/.test(line)) style = (s) => kleur.dim(s);
    for (const frag of fragments) {
      wrapped.push(style ? style(frag) : frag);
    }
  }
  return { wrapped, total: wrapped.length };
}

function renderDiffFiles(
  entry: WorktreeEntry,
  files: DiffFileStat[],
  selected: number,
  scrollOffset: number,
  cols: number,
  termRows: number,
): string {
  const out: string[] = [];
  out.push(HOME + CLEAR_SCREEN);

  const headerRows = 3;
  const footerRows = 2;
  const visibleRows = Math.max(5, termRows - headerRows - footerRows);

  // Header — title + summary (total files, total + / -).
  let totalAdded = 0;
  let totalDeleted = 0;
  for (const f of files) {
    if (!f.binary) {
      totalAdded += f.added;
      totalDeleted += f.deleted;
    }
  }
  const titleLine = kleur
    .bold()
    .bgBlue()
    .white(` git diff: ${entry.name} `);
  const summaryLine =
    `${files.length} file${files.length === 1 ? "" : "s"} · ` +
    `${kleur.green(`+${totalAdded}`)} ${kleur.red(`-${totalDeleted}`)}` +
    `  ${kleur.dim("(main..HEAD)")}`;
  out.push(titleLine + CLEAR_LINE + "\n");
  out.push(summaryLine + CLEAR_LINE + "\n");
  out.push(kleur.dim("─".repeat(cols)) + CLEAR_LINE + "\n");

  if (files.length === 0) {
    out.push(kleur.dim("  (no changes between main and HEAD)") + CLEAR_LINE + "\n");
  }

  // Body — file list with stats.
  // Adjust scroll so selected stays in view.
  const slice = files.slice(scrollOffset, scrollOffset + visibleRows);
  for (let i = 0; i < slice.length; i++) {
    const file = slice[i]!;
    const realIdx = scrollOffset + i;
    const isSel = realIdx === selected;
    const marker = isSel ? kleur.bold().yellow("›") : " ";
    const stat = file.binary
      ? kleur.magenta(padAnsi("binary", 13))
      : `${kleur.green(("+" + file.added).padStart(5))} ${kleur.red(("-" + file.deleted).padStart(5))}  `;
    const path = isSel ? kleur.bold(file.path) : file.path;
    let line = `${marker} ${stat} ${path}`;
    if (isSel) line = kleur.inverse(line);
    out.push(line + CLEAR_LINE + "\n");
  }
  // Pad
  for (let i = slice.length; i < visibleRows; i++) {
    out.push(CLEAR_LINE + "\n");
  }

  // Footer
  out.push(moveTo(termRows - 1, 1));
  const footer = kleur.dim(
    `j/↓ down · k/↑ up · ENTER view file in less · q/ESC close`,
  );
  out.push(footer + CLEAR_LINE);
  out.push(moveTo(termRows, 1));
  out.push(CLEAR_LINE);

  return out.join("");
}

function renderPlanView(
  entry: WorktreeEntry,
  planPath: string,
  lines: string[],
  scrollOffset: number,
  cols: number,
  termRows: number,
): string {
  const out: string[] = [];
  out.push(HOME + CLEAR_SCREEN);

  const headerRows = 3;
  const footerRows = 2;
  const visibleRows = Math.max(5, termRows - headerRows - footerRows);

  // Header
  const titleLine = kleur
    .bold()
    .bgBlue()
    .white(` plan: ${entry.name} `);
  const pathLine = kleur.dim(planPath);
  out.push(titleLine + CLEAR_LINE + "\n");
  out.push(pathLine + CLEAR_LINE + "\n");
  out.push(kleur.dim("─".repeat(cols)) + CLEAR_LINE + "\n");

  // Wrap all lines to terminal width with markdown styling applied.
  const { wrapped, total } = wrapPlanLines(lines, cols);
  const slice = wrapped.slice(scrollOffset, scrollOffset + visibleRows);
  for (const line of slice) {
    out.push(line + CLEAR_LINE + "\n");
  }
  // Pad remaining rows so stale content is cleared on shorter scrolls
  for (let i = slice.length; i < visibleRows; i++) {
    out.push(CLEAR_LINE + "\n");
  }

  // Footer
  out.push(moveTo(termRows - 1, 1));
  const start = scrollOffset + 1;
  const end = Math.min(scrollOffset + visibleRows, total);
  const footer = kleur.dim(
    `lines ${start}-${end} of ${total}  ·  j/↓ down · k/↑ up · g top · G bottom · q/ESC close`,
  );
  out.push(footer + CLEAR_LINE);

  out.push(moveTo(termRows, 1));
  out.push(CLEAR_LINE);

  return out.join("");
}

function renderBashInput(
  entry: WorktreeEntry,
  buffer: string,
  cols: number,
  termRows: number,
): string {
  const out: string[] = [];
  const w = Math.min(cols - 4, 100);
  const startRow = Math.max(2, Math.floor((termRows - 6) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));

  const horiz = "─".repeat(w - 2);
  const inputLine = ` $ ${buffer}_`;
  const lines = [
    kleur.cyan(`┌${horiz}┐`),
    kleur.cyan("│") +
      padAnsi(
        ` ${kleur.bold("BASH")} in ${kleur.bold(entry.name)} ${kleur.dim("(bash -ic, mise active)")}`,
        w - 2,
      ) +
      kleur.cyan("│"),
    kleur.cyan(`├${horiz}┤`),
    kleur.cyan("│") + padAnsi(inputLine, w - 2) + kleur.cyan("│"),
    kleur.cyan(`├${horiz}┤`),
    kleur.cyan("│") +
      padAnsi(
        ` ${kleur.bold("ENTER")} run · ${kleur.bold("ESC")} cancel`,
        w - 2,
      ) +
      kleur.cyan("│"),
    kleur.cyan(`└${horiz}┘`),
  ];
  for (let i = 0; i < lines.length; i++) {
    out.push(moveTo(startRow + i, startCol) + lines[i]);
  }
  return out.join("");
}

function renderRemoveConfirm(
  entry: WorktreeEntry,
  cols: number,
  termRows: number,
): string {
  const out: string[] = [];
  const w = Math.min(cols - 4, 80);
  const startRow = Math.max(2, Math.floor((termRows - 10) / 2));
  const startCol = Math.max(2, Math.floor((cols - w) / 2));

  const horiz = "─".repeat(w - 2);
  const lines: string[] = [
    kleur.red(`┌${horiz}┐`),
    kleur.red("│") + padAnsi(` ${kleur.bold("REMOVE WORKTREE")}`, w - 2) + kleur.red("│"),
    kleur.red(`├${horiz}┤`),
    kleur.red("│") + padAnsi(` ${kleur.dim("name:")}   ${entry.name}`, w - 2) + kleur.red("│"),
    kleur.red("│") + padAnsi(` ${kleur.dim("branch:")} ${entry.branch}`, w - 2) + kleur.red("│"),
    kleur.red("│") + padAnsi(` ${kleur.dim("path:")}   ${entry.worktreePath}`, w - 2) + kleur.red("│"),
    kleur.red(`├${horiz}┤`),
    kleur.red("│") + padAnsi(` This will:`, w - 2) + kleur.red("│"),
    kleur.red("│") + padAnsi(`   ${kleur.dim("• stop containers (compose down -v)")}`, w - 2) + kleur.red("│"),
    kleur.red("│") + padAnsi(`   ${kleur.dim("• remove the git worktree directory")}`, w - 2) + kleur.red("│"),
    kleur.red("│") + padAnsi(`   ${kleur.dim("• drop the cwt state entry")}`, w - 2) + kleur.red("│"),
    kleur.red("│") + padAnsi(`   ${kleur.dim("• keep the local branch (delete with `git branch -D`)")}`, w - 2) + kleur.red("│"),
    kleur.red(`├${horiz}┤`),
    kleur.red("│") +
      padAnsi(
        `   ${kleur.bold().red("[y]")} confirm        ${kleur.bold("[n/ESC]")} cancel`,
        w - 2,
      ) +
      kleur.red("│"),
    kleur.red(`└${horiz}┘`),
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
  // Show what the worktree name + branch will resolve to as the user types.
  // Linear lookup happens on submit, so the preview shows the no-Linear
  // fallback. The actual values may include a title-derived slug.
  const normalized = buffer.trim().toLowerCase();
  const looksLikeIssueId = /^[a-z]+-\d+$/.test(normalized);
  const linearAvailable = !!process.env.LINEAR_API_KEY;
  const previewName = normalized || kleur.dim("(type an issue id, e.g. AMPHTT-929)");
  const previewBranch = normalized
    ? `${branchPrefix ?? ""}${normalized}`
    : kleur.dim("(derived from issue id)");
  const linearNote =
    looksLikeIssueId && linearAvailable
      ? kleur.dim("  (Linear lookup on submit will fill in title slug)")
      : looksLikeIssueId && !linearAvailable
        ? kleur.dim("  (set LINEAR_API_KEY for title-derived slug)")
        : "";

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
  ];
  if (linearNote) {
    lines.push(kleur.green("│") + padAnsi(linearNote, w - 2) + kleur.green("│"));
  }
  lines.push(kleur.green(`├${horiz}┤`));

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

async function runRemoveFlow(name: string): Promise<void> {
  const { destroy } = await import("./worktree.ts");
  try {
    await destroy(name);
    // Also clean up the host status dir so it doesn't sit empty next launch.
    const fs = await import("node:fs/promises");
    const dir = statusDirForWorktree(name);
    try {
      await fs.rm(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
    process.stdout.write(
      "\n" + kleur.green("✓ removed. ") + kleur.dim("reopening dashboard...\n"),
    );
    await runDashboard();
    process.exit(0);
  } catch (e) {
    process.stderr.write(kleur.red(`✗ ${(e as Error).message}\n`));
    process.exit(1);
  }
}

async function runCreateFlow(
  rawInput: string,
  defaults: { repoRoot: string; serviceName: string; dataMount: string | null },
  branchPrefix: string | null,
): Promise<void> {
  // Try to enrich via Linear if the input looks like an issue id and an
  // API key is available. Fall back gracefully if Linear is unreachable
  // or unconfigured — the user still gets a worktree, just without a
  // title-derived slug.
  const looksLikeIssueId = /^[A-Za-z]+-\d+$/.test(rawInput);
  let name = rawInput.toLowerCase();
  let branchSlug = name;
  let issueTitle: string | null = null;
  let linearBranch: string | null = null;

  if (looksLikeIssueId && process.env.LINEAR_API_KEY) {
    try {
      process.stdout.write(kleur.dim(`→ fetching ${rawInput} from Linear...\n`));
      const linear = await import("./linear.ts");
      const issue = await linear.fetchIssue(rawInput.toUpperCase());
      if (issue) {
        // Single source of truth: Linear's branchName. Strip the user prefix
        // (e.g. "alexc/") and use the rest as both the worktree name and
        // (with the prefix) the branch. Avoids divergence between my
        // title-based slug and Linear's slug rules.
        const branch = issue.branchName;
        const slugFromBranch = branch.includes("/")
          ? branch.slice(branch.indexOf("/") + 1)
          : branch;
        // Sanity check: the slug should match cwt's NAME_PATTERN
        // (lowercase, digits, hyphens). Linear's slugs do, in practice.
        if (/^[a-z0-9][a-z0-9-]*$/.test(slugFromBranch)) {
          name = slugFromBranch;
          branchSlug = slugFromBranch;
          linearBranch = branch;
          issueTitle = issue.title;
          process.stdout.write(
            kleur.green(`✓ ${issue.identifier} — ${issue.title}\n`),
          );
        } else {
          // Linear gave us a branch name that doesn't fit our pattern; fall
          // back to title-derivation so we still have a valid worktree name.
          name = linear.worktreeNameFromIssue(issue);
          branchSlug = name;
          linearBranch = branch;
          issueTitle = issue.title;
          process.stdout.write(
            kleur.green(`✓ ${issue.identifier} — ${issue.title}\n`) +
              kleur.dim(`  (Linear branch slug had unexpected chars; using title-derived name)\n`),
          );
        }
      } else {
        process.stdout.write(
          kleur.yellow(`⚠ Linear returned no issue for ${rawInput}; using id only\n`),
        );
      }
    } catch (e) {
      process.stdout.write(
        kleur.yellow(`⚠ Linear lookup failed: ${(e as Error).message}\n`),
      );
      process.stdout.write(kleur.dim(`  continuing with id-only worktree\n`));
    }
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    process.stderr.write(kleur.red(`✗ Invalid worktree name "${name}" after derivation\n`));
    process.exit(1);
  }

  // Branch: prefer Linear's gitBranchName (matches user's Linear branch
  // setting), else <prefix><slug>.
  const branch = linearBranch ?? (branchPrefix ? `${branchPrefix}${branchSlug}` : branchSlug);

  process.stdout.write(
    "\n" +
      kleur.bold().green("→ creating worktree\n") +
      kleur.dim(`  name:    ${name}\n`) +
      kleur.dim(`  branch:  ${branch}\n`) +
      (issueTitle ? kleur.dim(`  title:   ${issueTitle}\n`) : "") +
      kleur.dim(`  repo:    ${defaults.repoRoot}\n`) +
      kleur.dim(`  service: ${defaults.serviceName}\n`) +
      kleur.dim(`  data:    ${defaults.dataMount ?? "(none)"}\n\n`),
  );

  const { create } = await import("./worktree.ts");
  try {
    const entry = await create({
      name,
      branch,
      repoRoot: defaults.repoRoot,
      serviceName: defaults.serviceName,
      dataMount: defaults.dataMount ?? undefined,
    });
    // Auto-launch Claude in a detached tmux session inside the container.
    // The session has the claude command pre-typed (NOT submitted) so the
    // user sees it on attach and presses Enter to confirm — that handles
    // both the dangerous-flag confirmation prompt (if not yet cached in
    // the shared cwt-claude-config volume) and the user's choice of
    // whether the auto-prompt is what they actually want.
    // Pre-load /cwt-plan-minor whenever input looks like an issue id, even
    // if Linear isn't reachable — the skill still works without the title.
    const initialPrompt = looksLikeIssueId
      ? `/cwt-plan-minor ${rawInput.toUpperCase()}`
      : null;
    process.stdout.write(kleur.dim(`→ pre-loading claude in detached tmux...\n`));
    autoLaunchClaude(entry, initialPrompt);
    process.stdout.write(
      "\n" +
        kleur.green("✓ done. ") +
        kleur.dim("reopening dashboard — press ENTER on the new row to attach.\n") +
        (initialPrompt
          ? kleur.dim(`  claude is pre-loaded with: ${kleur.cyan(initialPrompt)}\n`)
          : kleur.dim(`  claude is pre-loaded with the channel flag.\n`)),
    );
    await runDashboard();
    process.exit(0);
  } catch (e) {
    process.stderr.write(kleur.red(`✗ ${(e as Error).message}\n`));
    process.exit(1);
  }
}

// Spawn a detached tmux session inside the worktree's container, then type
// the claude launch command into it (without pressing Enter — the user
// confirms on attach). Idempotent: if the session already exists, send-keys
// targets the existing one. Errors are logged but non-fatal — the worktree
// is still usable, they'll just have to type the command themselves.
function autoLaunchClaude(
  entry: { composeProject: string; worktreePath: string; serviceName?: string },
  initialPrompt: string | null,
): void {
  const { spawnSync } = require("node:child_process");
  const composeFile = join(entry.worktreePath, ".cwt", "docker-compose.yml");
  const service = entry.serviceName ?? "app";

  // Shell-quote the prompt for tmux send-keys. Use absolute path because
  // tmux opens a non-login interactive shell that doesn't have
  // /home/vscode/.local/bin on PATH (claude lives there).
  // The `--` separator is required when there's a positional prompt
  // because --dangerously-load-development-channels is a multi-value flag
  // that would otherwise greedily eat the prompt as another channel entry.
  const claudeCmdParts = [
    "/home/vscode/.local/bin/claude",
    "--dangerously-load-development-channels",
    "server:cwt-channel",
  ];
  if (initialPrompt) {
    claudeCmdParts.push("--");
    // Single-quote and escape any embedded single quotes
    const safe = initialPrompt.replace(/'/g, `'\\''`);
    claudeCmdParts.push(`'${safe}'`);
  }
  const claudeCmd = claudeCmdParts.join(" ");

  // Step 1: ensure the detached tmux session exists. -A attaches to existing
  // session if present; -d means detached; -s names it.
  const newSession = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      entry.composeProject,
      "-f",
      composeFile,
      "exec",
      "-T",
      service,
      "tmux",
      "new-session",
      "-A",
      "-d",
      "-s",
      "cwt",
    ],
    { stdio: "pipe" },
  );
  if (newSession.status !== 0) {
    process.stdout.write(
      kleur.yellow(
        `⚠ Could not create tmux session for auto-launch (${newSession.stderr?.toString().trim()}); you'll need to run claude manually after attach.\n`,
      ),
    );
    return;
  }

  // Step 2: type the claude command into the session. NOT followed by Enter.
  // tmux send-keys queues into the pane; the shell sees the chars when it's
  // reading input. The user presses Enter on attach to actually run.
  const sendKeys = spawnSync(
    "docker",
    [
      "compose",
      "-p",
      entry.composeProject,
      "-f",
      composeFile,
      "exec",
      "-T",
      service,
      "tmux",
      "send-keys",
      "-t",
      "cwt",
      claudeCmd,
    ],
    { stdio: "pipe" },
  );
  if (sendKeys.status !== 0) {
    process.stdout.write(
      kleur.yellow(
        `⚠ Could not pre-type claude command (${sendKeys.stderr?.toString().trim()}); you'll need to run it manually.\n`,
      ),
    );
  }
}

export async function runDashboard(): Promise<void> {
  if (!process.stdout.isTTY) {
    console.error("cwt dashboard requires a TTY");
    process.exit(1);
  }
  // Optional debug dump — set CWT_DEBUG=1 to see what env vars / paths the
  // dashboard sees at startup. Useful when "Linear: off" but you swear it's set.
  if (process.env.CWT_DEBUG) {
    process.stderr.write(
      `cwt-debug: LINEAR_API_KEY=${process.env.LINEAR_API_KEY ? "set (" + process.env.LINEAR_API_KEY.slice(0, 8) + "...)" : "unset"}\n`,
    );
    process.stderr.write(`cwt-debug: cwd=${process.cwd()}\n`);
    process.stderr.write(`cwt-debug: argv=${process.argv.join(" ")}\n`);
    await new Promise((r) => setTimeout(r, 1500));
  }

  // Pre-fetch state outside the Promise executor so we can await it; the
  // executor itself can't be async.
  const tailer: TailerState = {
    offsets: new Map(),
    resolved: new Set(),
  };
  const initialSnapshot = await snapshot(tailer);

  // For each EXISTING worktree at startup:
  //   1. Seed tailer.offsets to the current file size for the tailable
  //      files. The tailer's default of 0 means "read from start" — that's
  //      right for files that appear later, but wrong for files that were
  //      already populated when the dashboard launched.
  //   2. Load every existing decision request, surface pending ones, seed
  //      resolved with both pending IDs (so the tailer-from-zero doesn't
  //      double-add) and answered IDs (so historic answered requests
  //      don't get replayed if the file is read fresh).
  const initialPendingDecisions: DecisionRequest[] = [];
  for (const row of initialSnapshot.rows) {
    const dir = statusDirForWorktree(row.entry.name);
    for (const fname of [
      "decision-requests.jsonl",
      "permission-requests.jsonl",
    ]) {
      const path = join(dir, fname);
      if (existsSync(path)) {
        const size = (await stat(path)).size;
        tailer.offsets.set(`${row.entry.name}::${fname}`, size);
      }
    }
    const decs = await loadDecisions(row.entry.name);
    initialPendingDecisions.push(...decs.pending);
    for (const id of decs.allRequestIds) tailer.resolved.add(id);
    for (const id of decs.answeredIds) tailer.resolved.add(id);
  }

  // Wrap the entire interactive lifecycle in an explicit Promise so that
  // `await runDashboard()` actually waits for the user to quit instead of
  // returning as soon as the function body finishes setting up handlers.
  // Without this, the recursive call in runCreateFlow / runRemoveFlow would
  // resolve instantly and the surrounding process.exit(0) would fire before
  // the new dashboard rendered anything.
  return new Promise<void>((resolveDashboard) => {
  const pendingQueue: PermissionRequest[] = [];
  const pendingDecisionQueue: DecisionRequest[] = [];
  const pendingByWorktree = new Map<string, number>();
  // request_ids the user has explicitly ESC'd from a modal; auto-pop skips
  // these but 'd' / 'p' can force-open them again.
  const dismissedDecisionIds = new Set<string>();
  const dismissedPermissionIds = new Set<string>();
  let mode: Mode = { kind: "normal" };

  let selected = 0;
  let message: string | null = null;
  let messageExpiresAt = 0;
  let stopped = false;

  process.stdout.write(ENTER_ALT_SCREEN + HIDE_CURSOR + CLEAR_SCREEN);

  const cleanup = (): void => {
    if (stopped) return;
    stopped = true;
    // Remove all data listeners BEFORE pausing — pause doesn't immediately
    // drain queued events, so a second Enter pressed in quick succession was
    // re-firing the submit handler and double-running create. Wiping our
    // listener stops further dispatches even if events are still queued.
    process.stdin.removeAllListeners("data");
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    process.stdout.write(SHOW_CURSOR + EXIT_ALT_SCREEN);
  };

  // Resolves the outer Promise — call this for normal exits (q, SIGINT)
  // so callers awaiting runDashboard can continue. Hard exits via
  // process.exit(0) are still used for paths that should fully terminate
  // the cwt process (Enter-to-attach, post-create / post-remove relaunch).
  let resolved = false;
  const finishCleanly = (): void => {
    if (resolved) return;
    resolved = true;
    cleanup();
    resolveDashboard();
  };

  process.on("SIGINT", () => {
    finishCleanly();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    finishCleanly();
    process.exit(0);
  });
  process.on("exit", cleanup);

  process.stdin.setRawMode?.(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");

  let { rows, newRequests, newDecisions, lastDefaults } = initialSnapshot;
  // Seed the queue with the pre-existing pending decisions we loaded above.
  for (const req of initialPendingDecisions) {
    pendingDecisionQueue.push(req);
  }
  // Empty state is fine — render an empty table with hints. Otherwise
  // removing the last worktree would dump the user back to the shell with
  // no way to press 'n' for a new one without re-launching cwt dashboard.

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

  // `force` ignores the dismissed set — used by 'p' / 'd' so the user can
  // re-open something they ESC'd. Non-force is the auto-pop path: pops the
  // first non-dismissed item.
  const enterPermissionMode = (force = false): void => {
    if (pendingQueue.length === 0) return;
    if (mode.kind !== "normal") return;
    const req = force
      ? pendingQueue[0]
      : pendingQueue.find((r) => !dismissedPermissionIds.has(r.request_id));
    if (!req) return;
    mode = { kind: "permission", req };
  };

  const enterDecisionMode = (force = false): void => {
    if (pendingDecisionQueue.length === 0) return;
    if (mode.kind !== "normal") return;
    const req = force
      ? pendingDecisionQueue[0]
      : pendingDecisionQueue.find((r) => !dismissedDecisionIds.has(r.request_id));
    if (!req) return;
    mode = { kind: "decision", req, buffer: "" };
  };

  const redraw = (): void => {
    // Before rendering, see if there's a pending modal-eligible item and
    // auto-pop the relevant modal. This makes EVERY transition back to
    // normal mode (close plan view, exit message input, ESC out of bash,
    // etc.) re-check the queues — without this the modal would only
    // pop on the original arrival tick and could be missed.
    if (mode.kind === "normal") {
      if (pendingDecisionQueue.length > 0) {
        enterDecisionMode();
      }
      if (mode.kind === "normal" && pendingQueue.length > 0) {
        enterPermissionMode();
      }
    }
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
        pendingDecisionCount: pendingDecisionQueue.length,
      });
    if (mode.kind === "permission") {
      out += renderPermissionModal(mode.req, cols, termRows);
    } else if (mode.kind === "decision") {
      out += renderDecisionInput(mode.req, mode.buffer, cols, termRows);
    } else if (mode.kind === "message") {
      out += renderMessageInput(mode.targetWorktree, mode.buffer, cols, termRows);
    } else if (mode.kind === "new_worktree") {
      const defaults = inferNewDefaults(rows, lastDefaults);
      const branchPrefix = inferBranchPrefix(rows, lastDefaults);
      out += renderNewWorktreeInput(mode.buffer, defaults, branchPrefix, cols, termRows);
    } else if (mode.kind === "remove_confirm") {
      out += renderRemoveConfirm(mode.entry, cols, termRows);
    } else if (mode.kind === "bash_input") {
      out += renderBashInput(mode.entry, mode.buffer, cols, termRows);
    } else if (mode.kind === "view_plan") {
      // Plan view replaces the whole screen, not a modal overlay
      out =
        renderPlanView(
          mode.entry,
          mode.planPath,
          mode.lines,
          mode.scrollOffset,
          cols,
          termRows,
        );
    } else if (mode.kind === "view_diff_files") {
      out = renderDiffFiles(
        mode.entry,
        mode.files,
        mode.selected,
        mode.scrollOffset,
        cols,
        termRows,
      );
    }
    process.stdout.write(out);
  };

  // If there are pre-existing pending decisions, pop the first one's modal
  // so the user immediately sees what claude is waiting on — not just an
  // unhighlighted "waiting" row in the table.
  if (pendingDecisionQueue.length > 0) {
    flash(
      `${pendingDecisionQueue.length} pending decision${pendingDecisionQueue.length === 1 ? "" : "s"} from before dashboard started`,
    );
    enterDecisionMode();
  }

  redraw();

  const debugLog = process.env.CWT_DEBUG
    ? (msg: string) => {
        const fs = require("node:fs");
        const path = require("node:path");
        try {
          fs.appendFileSync(
            path.join(process.env.HOME ?? "", ".cwt", "dashboard-debug.log"),
            `${new Date().toISOString()} ${msg}\n`,
            "utf8",
          );
        } catch {
          // ignore
        }
      }
    : () => {};

  // Heartbeat: write a one-line snapshot of every worktree's
  // decision-requests.jsonl size + tracked offset every 30 seconds when
  // CWT_DEBUG is set. Lets us see whether the file is growing without
  // the tailer noticing.
  let tickCount = 0;
  const heartbeatLog = (): void => {
    if (!process.env.CWT_DEBUG) return;
    const fs = require("node:fs");
    const parts: string[] = [];
    for (const row of rows) {
      const file = join(
        statusDirForWorktree(row.entry.name),
        "decision-requests.jsonl",
      );
      const size = fs.existsSync(file) ? fs.statSync(file).size : -1;
      const off = tailer.offsets.get(`${row.entry.name}::decision-requests.jsonl`) ?? -1;
      parts.push(`${row.entry.name.slice(0, 24)}=${size}/${off}`);
    }
    debugLog(
      `heartbeat tick=${tickCount} mode=${mode.kind} q=${pendingDecisionQueue.length} ${parts.join(" ")}`,
    );
  };

  debugLog(
    `dashboard started: ${rows.length} worktrees, ${pendingDecisionQueue.length} pending decisions at startup`,
  );

  const tick = setInterval(async () => {
    tickCount++;
    // Heartbeat every 40 ticks (~30s) so we can verify ticks ARE firing
    // and observe the file size vs tracked offset over time.
    if (tickCount % 40 === 1) heartbeatLog();
    const result = await snapshot(tailer);
    rows = result.rows;
    lastDefaults = result.lastDefaults;
    if (selected >= rows.length) selected = Math.max(0, rows.length - 1);

    if (result.newRequests.length > 0) {
      debugLog(
        `tick: +${result.newRequests.length} permission(s) ${JSON.stringify(result.newRequests.map((r) => r.request_id))}, mode=${mode.kind}`,
      );
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
    if (result.newDecisions.length > 0) {
      debugLog(
        `tick: +${result.newDecisions.length} decision(s) ${JSON.stringify(result.newDecisions.map((r) => r.request_id))}, mode=${mode.kind}`,
      );
      for (const req of result.newDecisions) {
        pendingDecisionQueue.push(req);
      }
      if (mode.kind === "normal") {
        flash(`Decision needed from ${result.newDecisions[0]!.worktree}`);
        enterDecisionMode();
        debugLog(`tick: auto-popped decision modal for ${result.newDecisions[0]!.request_id}`);
      } else {
        debugLog(`tick: NOT auto-popping (mode=${mode.kind}); queue is now ${pendingDecisionQueue.length}`);
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

    // Decision input
    if (mode.kind === "decision") {
      if (chunk === "\r" || chunk === "\n") {
        const text = mode.buffer.trim();
        const req = mode.req;
        if (!text) {
          flash("Empty answer — type something or press ESC");
          redraw();
          return;
        }
        void (async () => {
          try {
            await appendDecisionAnswer(req.worktree, req.request_id, text);
            tailer.resolved.add(req.request_id);
            pendingDecisionQueue.shift();
            flash(`✓ sent "${text}" to ${req.worktree}`);
            mode = { kind: "normal" };
            if (pendingDecisionQueue.length > 0) enterDecisionMode();
          } catch (e) {
            flash(`Error: ${(e as Error).message}`);
            mode = { kind: "normal" };
          }
          redraw();
        })();
        return;
      } else if (chunk === "\x1b") {
        // ESC dismisses without answering. The request stays in the queue
        // and claude is still blocked — but we mark it dismissed so the
        // auto-pop path won't keep re-showing it. Press 'd' to force-open
        // the same one again.
        dismissedDecisionIds.add(mode.req.request_id);
        mode = { kind: "normal" };
        flash("Dismissed (press 'd' to re-open)");
        redraw();
      } else if (chunk === "\x7f" || chunk === "\b") {
        mode = { ...mode, buffer: mode.buffer.slice(0, -1) };
        redraw();
      } else if (chunk === "\x03") {
        clearInterval(tick);
        finishCleanly();
        return;
      } else {
        const printable = extractPaste(chunk);
        if (printable) {
          mode = { ...mode, buffer: mode.buffer + printable };
          redraw();
        }
      }
      return;
    }

    // Diff file list — select a file to view its diff in less
    if (mode.kind === "view_diff_files") {
      const cols = process.stdout.columns ?? 120;
      const termRows = process.stdout.rows ?? 30;
      const visibleRows = Math.max(5, termRows - 5);
      if (chunk === "q" || chunk === "\x1b") {
        mode = { kind: "normal" };
        redraw();
      } else if (chunk === "j" || chunk === "\x1b[B") {
        const next = Math.min(mode.files.length - 1, mode.selected + 1);
        let scroll = mode.scrollOffset;
        if (next >= scroll + visibleRows) scroll = next - visibleRows + 1;
        mode = { ...mode, selected: next, scrollOffset: scroll };
        redraw();
      } else if (chunk === "k" || chunk === "\x1b[A") {
        const next = Math.max(0, mode.selected - 1);
        let scroll = mode.scrollOffset;
        if (next < scroll) scroll = next;
        mode = { ...mode, selected: next, scrollOffset: scroll };
        redraw();
      } else if (chunk === "g") {
        mode = { ...mode, selected: 0, scrollOffset: 0 };
        redraw();
      } else if (chunk === "G") {
        const last = mode.files.length - 1;
        mode = {
          ...mode,
          selected: last,
          scrollOffset: Math.max(0, last - visibleRows + 1),
        };
        redraw();
      } else if (chunk === "\r" || chunk === "\n") {
        // Open this file's diff in less. Use host-side git (the worktree's
        // .git is on the host filesystem) so we don't need docker exec.
        const file = mode.files[mode.selected];
        if (!file) return;
        const entry = mode.entry;
        // Capture state so we can restore the file list on return from less
        const restoreMode = mode;
        clearInterval(tick);
        cleanup();
        process.stdout.write(
          kleur.dim(`→ git diff main..HEAD -- ${file.path}\n  q in less to return\n\n`),
        );
        const { spawnSync } = require("node:child_process");
        // Use a shell so we can pipe to less. The host has both git and less.
        spawnSync(
          "sh",
          [
            "-c",
            `git -C ${JSON.stringify(entry.worktreePath)} diff --color=always main..HEAD -- ${JSON.stringify(file.path)} | less -R`,
          ],
          { stdio: "inherit" },
        );
        // Re-enter the dashboard (alt screen + raw mode) and restore the
        // file list mode at the same selection so the user sees where they
        // were.
        finishCleanly();
        void (async () => {
          await runDashboard();
          process.exit(0);
        })();
        // Note: we lose the `restoreMode` selection because runDashboard
        // starts fresh. Acceptable for a first cut — re-press g to come
        // back here.
        void restoreMode;
        return;
      } else if (chunk === "\x03") {
        clearInterval(tick);
        finishCleanly();
        return;
      }
      void cols;
      return;
    }

    // Plan view
    if (mode.kind === "view_plan") {
      const cols = process.stdout.columns ?? 120;
      const termRows = process.stdout.rows ?? 30;
      const visibleRows = Math.max(5, termRows - 5);
      // Clamp on the wrapped line count, not the raw count, so scrolling
      // doesn't run off the end on long-lined plans.
      const wrappedTotal = wrapPlanLines(mode.lines, cols).total;
      const maxOffset = Math.max(0, wrappedTotal - visibleRows);
      if (chunk === "q" || chunk === "\x1b" || chunk === "\x03") {
        mode = { kind: "normal" };
        redraw();
      } else if (chunk === "j" || chunk === "\x1b[B") {
        mode = {
          ...mode,
          scrollOffset: Math.min(maxOffset, mode.scrollOffset + 1),
        };
        redraw();
      } else if (chunk === "k" || chunk === "\x1b[A") {
        mode = { ...mode, scrollOffset: Math.max(0, mode.scrollOffset - 1) };
        redraw();
      } else if (chunk === " " || chunk === "\x1b[6~") {
        // page down
        mode = {
          ...mode,
          scrollOffset: Math.min(maxOffset, mode.scrollOffset + visibleRows),
        };
        redraw();
      } else if (chunk === "b" || chunk === "\x1b[5~") {
        // page up
        mode = {
          ...mode,
          scrollOffset: Math.max(0, mode.scrollOffset - visibleRows),
        };
        redraw();
      } else if (chunk === "g") {
        mode = { ...mode, scrollOffset: 0 };
        redraw();
      } else if (chunk === "G") {
        mode = { ...mode, scrollOffset: maxOffset };
        redraw();
      }
      // suppress cols/termRows unused warnings
      void cols;
      return;
    }

    // Bash input — runs a one-shot command in the selected worktree's container
    if (mode.kind === "bash_input") {
      if (chunk === "\r" || chunk === "\n") {
        const cmd = mode.buffer.trim();
        const entry = mode.entry;
        if (!cmd) {
          mode = { kind: "normal" };
          flash("Cancelled (empty command)");
          redraw();
          return;
        }
        clearInterval(tick);
        cleanup();
        process.stdout.write(
          kleur.dim(`→ ${entry.name} $ `) + cmd + "\n\n",
        );
        const composeFile = join(entry.worktreePath, ".cwt", "docker-compose.yml");
        const service = entry.serviceName ?? "app";
        const { spawnSync } = require("node:child_process");
        const result = spawnSync(
          "docker",
          [
            "compose",
            "-p",
            entry.composeProject,
            "-f",
            composeFile,
            "exec",
            service,
            "bash",
            "-ic",
            cmd,
          ],
          { stdio: "inherit" },
        );
        process.stdout.write(
          "\n" +
            (result.status === 0
              ? kleur.green(`✓ exit 0`)
              : kleur.red(`✗ exit ${result.status ?? "?"}`)) +
            kleur.dim(`  press ENTER to return to dashboard...`),
        );
        // Wait for any keypress before relaunching dashboard
        process.stdin.setRawMode?.(true);
        process.stdin.resume();
        process.stdin.once("data", () => {
          process.stdin.setRawMode?.(false);
          process.stdin.pause();
          process.stdout.write("\n");
          finishCleanly();
          void runDashboard().then(() => process.exit(0));
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
        finishCleanly();
        return;
      } else {
        const printable = extractPaste(chunk);
        if (printable) {
          mode = { ...mode, buffer: mode.buffer + printable };
          redraw();
        }
      }
      return;
    }

    // Remove confirm
    if (mode.kind === "remove_confirm") {
      if (chunk === "y" || chunk === "Y") {
        const entry = mode.entry;
        clearInterval(tick);
        cleanup();
        process.stdout.write(
          "\n" +
            kleur.bold().red("→ removing worktree\n") +
            kleur.dim(`  name:   ${entry.name}\n`) +
            kleur.dim(`  branch: ${entry.branch}\n\n`),
        );
        void runRemoveFlow(entry.name);
        return;
      } else if (chunk === "n" || chunk === "N" || chunk === "\x1b") {
        mode = { kind: "normal" };
        flash("Cancelled");
        redraw();
      } else if (chunk === "\x03") {
        clearInterval(tick);
        cleanup();
        process.exit(0);
      }
      return;
    }

    // New worktree input
    if (mode.kind === "new_worktree") {
      if (chunk === "\r" || chunk === "\n") {
        const raw = mode.buffer.trim();
        if (!raw) {
          mode = { kind: "normal" };
          flash("Cancelled (empty input)");
          redraw();
          return;
        }
        const defaults = inferNewDefaults(rows, lastDefaults);
        if (!defaults) {
          flash("No defaults available — use `cwt new` from the host CLI");
          mode = { kind: "normal" };
          redraw();
          return;
        }
        // Exit TUI cleanly so Linear lookup + create() logs stream to the
        // user's terminal (docker build is long; the TUI can't render it).
        clearInterval(tick);
        cleanup();
        const branchPrefix = inferBranchPrefix(rows, lastDefaults);
        // Run async creation flow (Linear lookup + worktree.create).
        void runCreateFlow(raw, defaults, branchPrefix);
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
      } else {
        const printable = extractPaste(chunk);
        if (printable) {
          mode = { ...mode, buffer: mode.buffer + printable };
          redraw();
        }
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
      } else {
        const printable = extractPaste(chunk);
        if (printable) {
          mode = { ...mode, buffer: mode.buffer + printable };
          redraw();
        }
      }
      return;
    }

    // Normal mode
    if (chunk === "\x03" || chunk === "q") {
      clearInterval(tick);
      finishCleanly();
      return;
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
      // tmux exited (or user detached). Re-enter the dashboard so they
      // land back on the table instead of being dumped to the shell.
      // The outer Promise gets resolved here; the recursive runDashboard
      // takes over interactive control until its own quit.
      finishCleanly();
      void runDashboard().then(() => process.exit(0));
      return;
    } else if (chunk === "m") {
      const target = rows[selected];
      if (!target) return;
      mode = { kind: "message", targetWorktree: target.entry.name, buffer: "" };
      redraw();
    } else if (chunk === "n") {
      mode = { kind: "new_worktree", buffer: "" };
      redraw();
    } else if (chunk === "x" || chunk === "X") {
      // open remove confirm — destructive, requires y in modal
      const target = rows[selected];
      if (!target) return;
      mode = { kind: "remove_confirm", entry: target.entry };
      redraw();
    } else if (chunk === "b") {
      // bash command in selected worktree's container
      const target = rows[selected];
      if (!target) return;
      mode = { kind: "bash_input", entry: target.entry, buffer: "" };
      redraw();
    } else if (chunk === "g") {
      // Open the per-file diff navigator — list of changed files, ENTER to
      // view individual file diffs in less.
      const target = rows[selected];
      if (!target) return;
      void (async () => {
        const files = await listDiffFiles(target.entry);
        if (files.length === 0) {
          flash(`No changes between main and HEAD for ${target.entry.name}`);
          redraw();
          return;
        }
        mode = {
          kind: "view_diff_files",
          entry: target.entry,
          files,
          selected: 0,
          scrollOffset: 0,
        };
        redraw();
      })();
    } else if (chunk === "v") {
      // view plan for selected worktree
      const target = rows[selected];
      if (!target) return;
      void (async () => {
        const planPath = await findPlanForWorktree(target.entry);
        if (!planPath) {
          flash(`No plan found yet for ${target.entry.name}`);
          redraw();
          return;
        }
        const fs = await import("node:fs/promises");
        try {
          const content = await fs.readFile(planPath, "utf8");
          mode = {
            kind: "view_plan",
            entry: target.entry,
            planPath,
            lines: content.split("\n"),
            scrollOffset: 0,
          };
          redraw();
        } catch (e) {
          flash(`Failed to read plan: ${(e as Error).message}`);
          redraw();
        }
      })();
    } else if (chunk === "p") {
      // Force-open the next permission modal (ignores dismissed set).
      if (pendingQueue.length === 0) {
        flash("No pending permission requests");
      } else {
        // Clear dismissed so this one re-opens
        if (pendingQueue[0]) dismissedPermissionIds.delete(pendingQueue[0].request_id);
        enterPermissionMode(true);
      }
      redraw();
    } else if (chunk === "d") {
      // Force-open the next decision modal (ignores dismissed set).
      if (pendingDecisionQueue.length === 0) {
        flash("No pending decisions");
      } else {
        if (pendingDecisionQueue[0])
          dismissedDecisionIds.delete(pendingDecisionQueue[0].request_id);
        enterDecisionMode(true);
      }
      redraw();
    }
  };

  process.stdin.on("data", onKey);
  });
}
