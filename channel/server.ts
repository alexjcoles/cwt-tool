#!/usr/bin/env node
// cwt-channel: Claude Code channel + MCP server. One per worktree.
//
// Spawned by Claude Code over stdio (registered in the worktree's .mcp.json).
// Exposes:
//   - tool `report_status(state, summary, current_file?)` — Claude reports phase
//   - tool `note(text)` — free-form context note
//   - channel capability so it's loadable via `--dangerously-load-development-channels`
//
// Persists to:
//   $CWT_STATUS_DIR/state.json         — latest state (overwritten)
//   $CWT_STATUS_DIR/state-history.jsonl — append-only history
//
// Permission relay (claude/channel/permission) lands in M3.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { mkdirSync, renameSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";

const STATUS_DIR = process.env.CWT_STATUS_DIR ?? "/var/cwt/default";
const WORKTREE_NAME = process.env.CWT_WORKTREE_NAME ?? "default";

mkdirSync(STATUS_DIR, { recursive: true });
const STATE_FILE = join(STATUS_DIR, "state.json");
const HISTORY_FILE = join(STATUS_DIR, "state-history.jsonl");

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

function appendHistory(entry: Record<string, unknown>): void {
  appendFileSync(
    HISTORY_FILE,
    JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n",
    "utf8",
  );
}

function persistState(state: CurrentState): void {
  writeAtomic(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

const server = new Server(
  { name: "cwt-channel", version: "0.1.0" },
  {
    capabilities: {
      experimental: { "claude/channel": {} },
      tools: {},
    },
    instructions:
      `You are working in cwt worktree "${WORKTREE_NAME}". When you change phase ` +
      "(start planning, begin coding, hit a blocker, finish), call the " +
      "`report_status` tool with a one-sentence summary so the cwt dashboard " +
      "reflects what you're doing. Use `note` for free-form context that " +
      "doesn't fit a state change. Both tools are local-only — they only " +
      "write to a file the host can read.",
  },
);

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
            description:
              "Optional path to the file you're focused on.",
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
    appendHistory({ kind: "status", ...next });
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
    appendHistory({ kind: "note", worktree: WORKTREE_NAME, text: a.text });
    return {
      content: [{ type: "text", text: "Note recorded." }],
    };
  }

  throw new Error(`Unknown tool: ${name}`);
});

await server.connect(new StdioServerTransport());
