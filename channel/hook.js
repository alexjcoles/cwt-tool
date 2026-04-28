#!/usr/bin/env node
// cwt activity hook — Claude Code invokes this for PostToolUse events.
// Reads the hook payload from stdin (JSON), appends a single JSONL line to
// $CWT_STATUS_DIR/activity.jsonl, exits 0.
//
// Stdout/stderr are passed through to Claude Code's transcript on errors —
// we keep both quiet on the happy path.

import fs from "node:fs";
import path from "node:path";

const STATUS_DIR = process.env.CWT_STATUS_DIR ?? "/var/cwt/default";
const WORKTREE = process.env.CWT_WORKTREE_NAME ?? "default";
const ACTIVITY_FILE = path.join(STATUS_DIR, "activity.jsonl");

function summarize(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== "object") return null;
  const i = toolInput;
  switch (toolName) {
    case "Bash":
      return typeof i.command === "string"
        ? i.command.slice(0, 200)
        : null;
    case "Read":
    case "Edit":
    case "Write":
    case "NotebookEdit":
      return typeof i.file_path === "string" ? i.file_path : null;
    case "Glob":
      return typeof i.pattern === "string" ? i.pattern : null;
    case "Grep":
      return typeof i.pattern === "string" ? i.pattern : null;
    case "WebFetch":
    case "WebSearch":
      return typeof i.url === "string"
        ? i.url
        : typeof i.query === "string"
        ? i.query
        : null;
    default:
      return null;
  }
}

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  raw += chunk;
});
process.stdin.on("end", () => {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    // Not JSON — skip silently rather than spamming the transcript.
    process.exit(0);
  }

  const entry = {
    ts: new Date().toISOString(),
    worktree: WORKTREE,
    tool: payload.tool_name ?? "unknown",
    target: summarize(payload.tool_name, payload.tool_input),
    session: payload.session_id ?? null,
  };

  try {
    fs.mkdirSync(STATUS_DIR, { recursive: true });
    fs.appendFileSync(ACTIVITY_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    // Don't fail the tool call if we can't log. Print to stderr for diagnosis.
    process.stderr.write(
      `cwt hook: failed to append activity log: ${err.message}\n`,
    );
  }
  process.exit(0);
});
