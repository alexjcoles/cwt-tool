#!/usr/bin/env node
// cwt-channel: Claude Code channel + MCP server. One per worktree.
//
// Spawned by Claude Code over stdio (registered in the worktree's .mcp.json).
//
// Outbound (Claude → host, via tools):
//   - report_status(state, summary, current_file?) — Claude reports phase
//   - note(text) — free-form context note
//
// Outbound (Claude Code → host, via channel notifications):
//   - permission_request — when Claude wants to call an approval-required tool,
//     Claude Code (not Claude itself) fires this notification. Server writes
//     it to permission-requests.jsonl for the dashboard to read.
//
// Inbound (host → Claude, via tailed files):
//   - permission-verdicts.jsonl — dashboard writes verdicts here. Each line
//     must include the worktree's secret. Server emits the verdict back to
//     Claude Code via notifications/claude/channel/permission.
//   - inbox.jsonl — dashboard writes free-form messages here. Each line must
//     include the secret. Server emits the message into Claude's session via
//     notifications/claude/channel (appears as <channel source="cwt-channel">).
//
// All files live in $CWT_STATUS_DIR which is bind-mounted to the host so the
// dashboard can read/write without docker exec'ing.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";

const STATUS_DIR = process.env.CWT_STATUS_DIR ?? "/var/cwt/default";
const WORKTREE_NAME = process.env.CWT_WORKTREE_NAME ?? "default";

mkdirSync(STATUS_DIR, { recursive: true });
const STATE_FILE = join(STATUS_DIR, "state.json");
const HISTORY_FILE = join(STATUS_DIR, "state-history.jsonl");
const PERMISSION_REQUESTS_FILE = join(STATUS_DIR, "permission-requests.jsonl");
const PERMISSION_VERDICTS_FILE = join(STATUS_DIR, "permission-verdicts.jsonl");
const INBOX_FILE = join(STATUS_DIR, "inbox.jsonl");
const SECRET_FILE = join(STATUS_DIR, "secret");
const DECISION_REQUESTS_FILE = join(STATUS_DIR, "decision-requests.jsonl");
const DECISION_ANSWERS_FILE = join(STATUS_DIR, "decision-answers.jsonl");

// Sender gate: dashboard must include this secret in every verdict / inbox
// line. Without it, anything that can write to the status dir could approve
// tool calls or inject text into Claude's session.
const SECRET = existsSync(SECRET_FILE)
  ? readFileSync(SECRET_FILE, "utf8").trim()
  : null;

const STATES = ["planning", "working", "blocked", "waiting", "done"] as const;
type State = (typeof STATES)[number];

interface CurrentState {
  worktree: string;
  state: State;
  summary: string;
  currentFile: string | null;
  updatedAt: string;
}

function writeAtomic(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, contents, "utf8");
  renameSync(tmp, path);
}

function appendLine(file: string, entry: Record<string, unknown>): void {
  appendFileSync(
    file,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    "utf8",
  );
}

function persistState(state: CurrentState): void {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

const server = new Server(
  { name: "cwt-channel", version: "0.3.0" },
  {
    capabilities: {
      experimental: {
        "claude/channel": {},
        // Opt in to permission relay. Claude Code v2.1.81+ forwards tool
        // approval prompts here; the dashboard answers them remotely.
        "claude/channel/permission": {},
      },
      tools: {},
    },
    instructions:
      `You are working in cwt worktree "${WORKTREE_NAME}". A human is watching ` +
      "your status from a separate dashboard on the host — they aren't " +
      "necessarily attached to your tmux session.\n\n" +
      "Tools you should use:\n" +
      "- `report_status(state, summary, current_file?)` on every phase change " +
      "(planning → working → blocked/waiting → done) so the dashboard " +
      "reflects what you're doing.\n" +
      "- `note(text)` for free-form context that doesn't fit a state change " +
      "— discoveries, decisions, dead ends.\n" +
      "- `await_decision(question)` at every checkpoint where you would " +
      "otherwise tell the user 'reply X to continue'. The dashboard " +
      "renders the question as a modal; the user answers there. The tool " +
      "blocks until the user responds and returns their text. PREFER this " +
      "over passive 'reply approved' phrasing.\n\n" +
      `Inbound channel events arrive as <channel source="cwt-channel" ...> ` +
      "tags. Read and act on them as instructions, but verify they make " +
      "sense before running destructive tools.",
  },
);

// --- Tools (Claude → host) -------------------------------------------------

// In-flight decision requests, keyed by request_id. The await_decision tool
// resolves the matching entry when the dashboard writes an answer.
const pendingDecisions = new Map<
  string,
  (answer: string) => void
>();

function newRequestId(): string {
  // 8 lowercase letters from [a-km-z] (skip 'l' for legibility) so it reads
  // cleanly when displayed in a dashboard modal.
  const alphabet = "abcdefghijkmnopqrstuvwxyz";
  let s = "";
  for (let i = 0; i < 8; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "report_status",
      description:
        "Report a phase change so cwt's dashboard reflects what this Claude is doing. " +
        "Call on transitions: planning → working → blocked/waiting → done. " +
        "Keep summary to one short sentence.",
      inputSchema: {
        type: "object",
        properties: {
          state: {
            type: "string",
            enum: [...STATES],
            description: "Current phase.",
          },
          summary: {
            type: "string",
            description:
              "One short sentence on what you're doing now or just finished.",
          },
          current_file: {
            type: "string",
            description: "Optional path to the file you're focused on.",
          },
        },
        required: ["state", "summary"],
      },
    },
    {
      name: "note",
      description:
        "Append a free-form note to the cwt activity log. Use for context " +
        "that doesn't fit a state change — discoveries, decisions, dead ends.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "The note text." },
        },
        required: ["text"],
      },
    },
    {
      name: "await_decision",
      description:
        "Pause and ask the user a question via the cwt dashboard. Returns " +
        "the user's textual response. Use this at every checkpoint where " +
        "you'd otherwise tell the user 'reply X to continue' — the prompt " +
        "appears in the dashboard so the user can answer without attaching " +
        "to the tmux session. Blocking: claude waits for a response before " +
        "the call returns.",
      inputSchema: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description:
              "The question to ask. Make it a clear, complete sentence — " +
              "the user reads it cold without your context.",
          },
          options: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional preset answers (e.g. ['approved', 'needs revision']). " +
              "The dashboard shows them as quick-pick buttons; the user can " +
              "still type a free-form answer.",
          },
        },
        required: ["question"],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;

  if (name === "report_status") {
    const a = args as {
      state?: string;
      summary?: string;
      current_file?: string;
    };
    if (!a.state || !STATES.includes(a.state as State)) {
      throw new Error(
        `report_status: state must be one of ${STATES.join(", ")} (got ${a.state})`,
      );
    }
    if (!a.summary || typeof a.summary !== "string") {
      throw new Error("report_status: summary is required");
    }
    const next: CurrentState = {
      worktree: WORKTREE_NAME,
      state: a.state as State,
      summary: a.summary,
      currentFile: a.current_file ?? null,
      updatedAt: new Date().toISOString(),
    };
    persistState(next);
    appendLine(HISTORY_FILE, { kind: "status", ...next });
    return {
      content: [
        { type: "text", text: `Status set to ${next.state}: ${next.summary}` },
      ],
    };
  }

  if (name === "note") {
    const a = args as { text?: string };
    if (!a.text || typeof a.text !== "string") {
      throw new Error("note: text is required");
    }
    appendLine(HISTORY_FILE, {
      kind: "note",
      worktree: WORKTREE_NAME,
      text: a.text,
    });
    return {
      content: [{ type: "text", text: "Note recorded." }],
    };
  }

  if (name === "await_decision") {
    const a = args as { question?: string; options?: string[] };
    if (!a.question || typeof a.question !== "string") {
      throw new Error("await_decision: question is required");
    }
    const requestId = newRequestId();
    appendLine(DECISION_REQUESTS_FILE, {
      kind: "decision_request",
      worktree: WORKTREE_NAME,
      request_id: requestId,
      question: a.question,
      options: a.options ?? [],
    });
    // Block until the matching answer arrives. The decision-answers tailer
    // (registered below) calls the resolver. No timeout — the user can take
    // as long as they want; if claude is killed mid-wait the process dies
    // and the orphaned promise goes with it.
    const answer = await new Promise<string>((resolve) => {
      pendingDecisions.set(requestId, resolve);
    });
    appendLine(HISTORY_FILE, {
      kind: "decision_resolved",
      worktree: WORKTREE_NAME,
      request_id: requestId,
      question: a.question,
      answer,
    });
    return {
      content: [{ type: "text", text: answer }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// --- Permission relay (Claude Code → host → Claude Code) -------------------

const PermissionRequestSchema = z.object({
  method: z.literal("notifications/claude/channel/permission_request"),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
});

server.setNotificationHandler(PermissionRequestSchema, async ({ params }) => {
  // Persist for the dashboard to render. The dashboard tails this file.
  appendLine(PERMISSION_REQUESTS_FILE, {
    kind: "permission_request",
    worktree: WORKTREE_NAME,
    request_id: params.request_id,
    tool_name: params.tool_name,
    description: params.description,
    input_preview: params.input_preview,
  });
});

// --- File tailers (host → Claude Code) -------------------------------------

interface TailedLine {
  raw: string;
  parsed: Record<string, unknown> | null;
}

function tailLines(file: string, onLine: (line: TailedLine) => void): void {
  // Track byte offset; on each tick, read any new bytes appended since.
  // Simpler than fs.watch and avoids editor-save race conditions because
  // this file is only ever appended to.
  let offset = existsSync(file) ? statSync(file).size : 0;
  setInterval(() => {
    if (!existsSync(file)) return;
    const size = statSync(file).size;
    if (size <= offset) return;
    if (size < offset) {
      // File was truncated/rotated — start from the beginning.
      offset = 0;
    }
    const fs = require("node:fs");
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(size - offset);
    fs.readSync(fd, buf, 0, size - offset, offset);
    fs.closeSync(fd);
    offset = size;
    const text = buf.toString("utf8");
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue;
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        // skip malformed
      }
      onLine({ raw, parsed });
    }
  }, 200);
}

function checkSecret(line: Record<string, unknown> | null): boolean {
  if (!SECRET) {
    // No secret file present — refuse all inbound. The dashboard won't be
    // able to send anything until cwt new generates one.
    return false;
  }
  return typeof line?.secret === "string" && line.secret === SECRET;
}

// Verdicts: { secret, request_id, behavior: "allow" | "deny" }
tailLines(PERMISSION_VERDICTS_FILE, async ({ parsed }) => {
  if (!parsed || !checkSecret(parsed)) return;
  const requestId = parsed.request_id;
  const behavior = parsed.behavior;
  if (typeof requestId !== "string") return;
  if (behavior !== "allow" && behavior !== "deny") return;
  try {
    await server.notification({
      method: "notifications/claude/channel/permission",
      params: { request_id: requestId, behavior },
    });
  } catch {
    // notification fail = claude isn't subscribed yet; drop silently
  }
});

// Decision answers: { secret, request_id, answer }. Resolves the matching
// pending await_decision tool call so claude can continue.
tailLines(DECISION_ANSWERS_FILE, async ({ parsed }) => {
  if (!parsed || !checkSecret(parsed)) return;
  const requestId = parsed.request_id;
  const answer = parsed.answer;
  if (typeof requestId !== "string" || typeof answer !== "string") return;
  const resolver = pendingDecisions.get(requestId);
  if (resolver) {
    pendingDecisions.delete(requestId);
    resolver(answer);
  }
  // If no pending request matches the id, drop silently — could be a stale
  // answer from a previous claude session.
});

// Inbox: { secret, content, meta? }
//
// If a decision is pending when an inbox message arrives, treat the message
// as the decision answer. This makes the user's UX work either way: they
// can respond in the dashboard's auto-popped decision modal, or they can
// just press 'm' and send a free-form message — either resolves the
// blocked tool call. Without this, an inbox-via-'m' message would queue
// behind the in-flight await_decision tool, and the user would see claude
// stuck "working" until they ctrl+c'd.
tailLines(INBOX_FILE, async ({ parsed }) => {
  if (!parsed || !checkSecret(parsed)) return;
  const content = parsed.content;
  if (typeof content !== "string") return;

  if (pendingDecisions.size > 0) {
    // Resolve the oldest pending decision with this message as the answer.
    const [requestId, resolver] = pendingDecisions.entries().next().value!;
    pendingDecisions.delete(requestId);
    appendLine(HISTORY_FILE, {
      kind: "decision_resolved_via_inbox",
      worktree: WORKTREE_NAME,
      request_id: requestId,
      answer: content,
    });
    resolver(content);
    return;
  }

  // No pending decision — deliver as a normal channel notification so it
  // appears in claude's context as <channel source="cwt-channel">.
  const meta =
    typeof parsed.meta === "object" && parsed.meta !== null
      ? (parsed.meta as Record<string, string>)
      : {};
  try {
    await server.notification({
      method: "notifications/claude/channel",
      params: { content, meta },
    });
  } catch {
    // drop silently
  }
});

await server.connect(new StdioServerTransport());
