#!/bin/bash
# PreToolUse hook for mcp__claude_ai_Linear__save_issue — every issue must have
# a "## Java reference" section (or "N/A — no Java equivalent" with reason).
# Ported from patentsafe-ai's existing hook; unchanged in behaviour.
set -e

INPUT=$(cat)
DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // ""')

# Skip status-only updates that don't carry a description
if [[ -z "$DESCRIPTION" ]] || [[ "$DESCRIPTION" == "null" ]]; then
  exit 0
fi

if ! echo "$DESCRIPTION" | grep -q "## Java reference"; then
  echo "Issue is missing the '## Java reference' section. Every issue must include this section. If no Java equivalent exists, write 'N/A — no Java equivalent' with a brief reason. See docs/templates/linear-issue.md for the full template." >&2
  exit 2
fi

exit 0
