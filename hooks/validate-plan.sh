#!/bin/bash
# PreToolUse hook for Write — validates that plan files at docs/plans/<milestone>/*.md
# contain every required section. Ported from patentsafe-ai's existing hook;
# unchanged in behaviour. The cwt-plan-minor skill walks the same checklist
# pre-write, but this hook is the actual enforcement gate.
set -e

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path')
CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content')

# Only validate plan files in docs/plans/
if [[ "$FILE_PATH" != */docs/plans/*.md ]]; then
  exit 0
fi

# Skip README, templates, and non-plan files
BASENAME=$(basename "$FILE_PATH")
if [[ "$BASENAME" == "README.md" ]] || [[ "$FILE_PATH" == *"/templates/"* ]]; then
  exit 0
fi

if [[ "$FILE_PATH" == */docs/plans/major/* ]]; then
  PLAN_TYPE="major"
else
  PLAN_TYPE="minor"
fi

MISSING=""

if [[ "$PLAN_TYPE" == "minor" ]]; then
  echo "$CONTENT" | grep -q "^## Context"          || MISSING="${MISSING}- ## Context\n"
  echo "$CONTENT" | grep -q "^## Deliverables"      || MISSING="${MISSING}- ## Deliverables\n"
  echo "$CONTENT" | grep -q "^## Design Decisions"  || MISSING="${MISSING}- ## Design Decisions\n"
  echo "$CONTENT" | grep -q "^## Java Alignment"    || MISSING="${MISSING}- ## Java Alignment\n"
  echo "$CONTENT" | grep -q "^## Commit Structure"  || MISSING="${MISSING}- ## Commit Structure\n"
  echo "$CONTENT" | grep -q "^## Amendments"        || MISSING="${MISSING}- ## Amendments\n"
elif [[ "$PLAN_TYPE" == "major" ]]; then
  echo "$CONTENT" | grep -q "^## Context"             || MISSING="${MISSING}- ## Context\n"
  echo "$CONTENT" | grep -q "^## Current [Ss]tate"    || MISSING="${MISSING}- ## Current state\n"
  echo "$CONTENT" | grep -q "^## Issue [Ii]nventory"  || MISSING="${MISSING}- ## Issue inventory\n"
  echo "$CONTENT" | grep -q "^## Dependency [Gg]raph" || MISSING="${MISSING}- ## Dependency graph\n"
  echo "$CONTENT" | grep -q "^## Java [Cc]overage"    || MISSING="${MISSING}- ## Java coverage\n"
  echo "$CONTENT" | grep -q "^## Phase [Bb]reakdown"  || MISSING="${MISSING}- ## Phase breakdown\n"
  echo "$CONTENT" | grep -q "^## Amendments"          || MISSING="${MISSING}- ## Amendments\n"
fi

if [[ -n "$MISSING" ]]; then
  printf "Plan file is missing required sections:\n%b\nRe-read docs/templates/%s-plan.md and add the missing sections. Every section is required — use 'N/A' with a reason if not applicable.\n" "$MISSING" "$PLAN_TYPE" >&2
  exit 2
fi

exit 0
