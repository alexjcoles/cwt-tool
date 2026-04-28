#!/bin/bash
# PreToolUse hook for Write/Edit — when a deferral comment (TODO:: [DEFERRED])
# is being introduced, ensure the full 5-line header is present:
#   # TODO:: [DEFERRED] <what>
#   # Reason: <why>
#   # Scope: <1-5>
#   # Java ref: <path or N/A>
#   # See: <Linear issue ID>
#
# Catches partial deferrals at write-time so they don't slip through to PR review.
# Cheaper than relying on cwt-agent-view to flag them post-hoc.
set -e

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name')

case "$TOOL_NAME" in
  Write)
    NEW=$(echo "$INPUT" | jq -r '.tool_input.content // ""')
    ;;
  Edit)
    # Edit's payload uses new_string. Pull both old and new — we only validate
    # additions, not removals or unchanged context.
    OLD=$(echo "$INPUT" | jq -r '.tool_input.old_string // ""')
    NEW=$(echo "$INPUT" | jq -r '.tool_input.new_string // ""')
    ;;
  *)
    exit 0
    ;;
esac

# Fast exit when there's no deferral being introduced
if ! echo "$NEW" | grep -q "TODO:: \[DEFERRED\]"; then
  exit 0
fi

# Each deferral marker must be followed (within the next 4 lines) by all four
# header fields. Scan line-by-line.
MISSING=""
while IFS= read -r line_with_num; do
  # awk gives us "<line-num>:<line-text>"; we just need the index
  num=$(echo "$line_with_num" | cut -d: -f1)
  end=$((num + 4))
  block=$(echo "$NEW" | sed -n "${num},${end}p")
  echo "$block" | grep -qE "^[[:space:]]*#[[:space:]]*Reason:"   || MISSING="${MISSING}- Reason: (line ${num})\n"
  echo "$block" | grep -qE "^[[:space:]]*#[[:space:]]*Scope:"    || MISSING="${MISSING}- Scope: (line ${num})\n"
  echo "$block" | grep -qE "^[[:space:]]*#[[:space:]]*Java ref:" || MISSING="${MISSING}- Java ref: (line ${num})\n"
  echo "$block" | grep -qE "^[[:space:]]*#[[:space:]]*See:"      || MISSING="${MISSING}- See: (line ${num})\n"
done < <(echo "$NEW" | grep -n "TODO:: \[DEFERRED\]")

if [[ -n "$MISSING" ]]; then
  printf "Deferral comment is missing required header fields:\n%b\nThe full format is:\n  # TODO:: [DEFERRED] <what needs to be implemented>\n  # Reason: <why deferred>\n  # Scope: <1-5>\n  # Java ref: <path or 'N/A'>\n  # See: <future Linear issue ID>\nSee CLAUDE.md → Feature Implementations.\n" "$MISSING" >&2
  exit 2
fi

exit 0
