#!/bin/bash
# PreToolUse hook for Bash — when the command is `git commit -m "..."`,
# require the message to contain a Linear issue ID line (e.g. AMPHTT-123).
# CLAUDE.md mandates this trailer for compliance traceability.
#
# Limitations:
#   - Only catches `-m "..."` form. `git commit` opening an editor isn't
#     interceptable from a pre-tool hook.
#   - The check is presence-only; downstream the commit-msg hook in the
#     repo can do format-level validation.
set -e

INPUT=$(cat)
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // ""')

# Bail unless this looks like a git commit with -m
if ! echo "$COMMAND" | grep -qE '^[[:space:]]*git[[:space:]]+(-[Cc][[:space:]]+\S+[[:space:]]+)?commit\b'; then
  exit 0
fi
if ! echo "$COMMAND" | grep -qE '\-m[[:space:]]'; then
  # No -m means an editor commit; skip
  exit 0
fi

# Extract the message body. Handle:
#   git commit -m "..."
#   git commit -m '...'
#   git commit -m "$(cat <<EOF ... EOF)"  — heredoc
#
# For heredocs we extract between the EOF markers; for quoted forms we take
# everything between the matching quotes.
MSG=""
if echo "$COMMAND" | grep -q "<<'EOF'\|<<EOF"; then
  MSG=$(echo "$COMMAND" | awk "/<<'?EOF'?/{flag=1; next} /^EOF$/{flag=0} flag")
elif echo "$COMMAND" | grep -qE '\-m[[:space:]]+"'; then
  MSG=$(echo "$COMMAND" | sed -nE 's/.*-m[[:space:]]+"([^"]*)".*/\1/p')
elif echo "$COMMAND" | grep -qE "\-m[[:space:]]+'"; then
  MSG=$(echo "$COMMAND" | sed -nE "s/.*-m[[:space:]]+'([^']*)'.*/\1/p")
fi

if [[ -z "$MSG" ]]; then
  # Couldn't extract — let it through rather than block on parse failure
  exit 0
fi

# Look for a standalone Linear ID line. Prefix matches Amphora's convention
# (AMPHTT-NNN, ENG-NNN, etc.). Adjust the regex if your team uses different
# project keys.
if echo "$MSG" | grep -qE '^[A-Z]+-[0-9]+$'; then
  exit 0
fi

# Also accept it inline on a trailer-style line
if echo "$MSG" | grep -qE '^(Refs?|Closes?|Linear): +[A-Z]+-[0-9]+'; then
  exit 0
fi

cat <<MSG_END >&2
Commit message is missing a Linear issue ID trailer.
Add a line with the issue ID just above the Co-Authored-By trailer, e.g.:

    feat(oidc): disambiguate multi-email matches

    Body explaining why.

    AMPHTT-959
    Co-Authored-By: ...

Required by CLAUDE.md → Commit Messages → Referencing Linear.
MSG_END
exit 2
