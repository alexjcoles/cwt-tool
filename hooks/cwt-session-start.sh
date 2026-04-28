#!/bin/bash
# SessionStart hook — print a context banner so Claude (and the human reading
# the transcript later) can see at a glance where this session is grounded:
# worktree name, branch, plan file (if present), and Linear issue ID.
#
# Output goes to stdout, which Claude Code injects into the session as a
# system message at start.
set -e

CWT_NAME="${CWT_WORKTREE_NAME:-unknown}"
BRANCH=$(git branch --show-current 2>/dev/null || echo "unknown")
HEAD_SHA=$(git rev-parse --short HEAD 2>/dev/null || echo "unknown")

# Issue ID derived from branch name (alexc/amphtt-NNN-slug → AMPHTT-NNN).
ISSUE_ID=""
if [[ -n "$BRANCH" ]]; then
  num=$(echo "$BRANCH" | grep -oE '[0-9]+' | head -1)
  prefix=$(echo "$BRANCH" | grep -oE '[a-z]+-[0-9]+' | head -1 | cut -d- -f1)
  if [[ -n "$prefix" && -n "$num" ]]; then
    upper=$(echo "$prefix" | tr a-z A-Z)
    ISSUE_ID="${upper}-${num}"
  fi
fi

PLAN_FILE=""
if [[ -n "$ISSUE_ID" ]]; then
  num="${ISSUE_ID##*-}"
  PLAN_FILE=$(find docs/plans -name "amphtt-${num}-*.md" 2>/dev/null | head -1)
fi

cat <<BANNER
[cwt session]
worktree: ${CWT_NAME}
branch:   ${BRANCH} (${HEAD_SHA})
issue:    ${ISSUE_ID:-not derivable from branch}
plan:     ${PLAN_FILE:-(none yet — run /cwt-plan-minor ${ISSUE_ID} to start)}

Channel tools: report_status(state, summary, current_file?), note(text)
States: planning | working | blocked | waiting | done

Skill flow: /cwt-plan-minor → /cwt-execute → /cwt-agent-view → push → /cwt-review-pr
BANNER
