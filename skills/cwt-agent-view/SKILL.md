---
name: cwt-agent-view
description: Automated peer-review pass on the current branch's diff before push. Spawns a fresh Agent subagent to read the diff with no context from the implementation conversation, surfaces findings, and loops fix → re-review until clean (capped at 3 iterations).
disable-model-invocation: false
argument-hint: (no args)
allowed-tools: Read, Edit, Bash, Glob, Grep, Agent
---

# /cwt-agent-view — Automated Peer Review

You are running an automated peer-review pass on the work just produced by `/cwt-execute`. The goal is to catch issues before push that a CI bot would catch later: plan deviations, missing tests, Java-alignment regressions, security smells, untracked deferrals, commit-structure drift.

The review is done by a **fresh Agent subagent** that has no context from the implementation conversation. That's the point — they read the diff cold, the same way a reviewer on the PR will.

You then triage the subagent's findings and address the ones that warrant fixing. Re-run the subagent. Loop until clean or until iteration cap.

## Step 0: Preconditions

Confirm:

```bash
git branch --show-current        # not main
git log --oneline main..HEAD     # at least one commit ahead of main
git status --short                # clean working tree
```

If the working tree is dirty, `report_status('blocked', 'Working tree has uncommitted changes — finish the last commit before running /cwt-agent-view')` and stop. The reviewer needs to see the same state that will be pushed.

If there are zero commits ahead of main, `report_status('blocked', 'No commits to review')` and stop.

`report_status('working', 'Running automated peer review pass 1')`.

## Step 1: Locate the plan

Same as `/cwt-execute` step 1. Find the plan file based on the branch name's issue ID. Read it fully — the reviewer needs to know what was supposed to happen.

If no plan exists, `report_status('blocked', 'No plan found — agent-view needs a plan to compare against')` and stop.

## Step 2: Build the review prompt

Construct a self-contained prompt for the subagent. It must include:

- The full plan text (so the reviewer knows the contract)
- A summary of the diff: `git diff --stat main..HEAD`, `git log --oneline main..HEAD`, and the actual diff (`git diff main..HEAD`). For large diffs, include the stat and log inline and tell the reviewer to read specific files via Read.
- The review criteria (below)
- The required output format (below)

### Review criteria the subagent must check

1. **Plan compliance**: every deliverable in the plan's `## Deliverables` section has corresponding code. Items missing from the diff are findings.
2. **Java alignment**: behaviours listed in the plan's `## Java Alignment` table that are marked `Yes` must be present in the diff. Behaviours marked `Missing` must be re-pointed (referenced from a follow-up issue) or implemented.
3. **Test coverage**: every new public method, controller action, or service entry-point has at least one test exercising it. Look for missing edge cases the plan called out.
4. **Conventions**: code matches existing Rails patterns in the project (naming, structure, error handling). Flag anything that diverges from neighboring code without justification.
5. **Security**: SQL injection, mass assignment, missing authz checks, secrets in code, unescaped user input rendered to HTML.
6. **Correctness**: obvious bugs (off-by-one, nil handling, race conditions), N+1 queries, infinite loops, blocking calls in request paths.
7. **Deferrals**: every `TODO:: [DEFERRED]` comment introduced in the diff has the full five-line header (what / Reason / Scope / Java ref / See). The plan's deferral resolutions are actually applied.
8. **Commit structure**: commits match the plan's `## Commit Structure`. Each commit subject follows conventional-commit format and ends with the `AMPHTT-NNN` trailer.

### Required output format

Tell the subagent to return findings as a JSON array, one object per finding:

```json
[
  {
    "severity": "critical|major|minor|info",
    "category": "plan|java|tests|conventions|security|correctness|deferrals|commits",
    "file": "<path or null for cross-cutting>",
    "line": <number or null>,
    "title": "<one-line summary>",
    "description": "<full explanation>",
    "suggested_fix": "<concrete change, if applicable>"
  }
]
```

If no findings: return `[]`. The subagent must NOT return prose; the JSON is what this skill parses.

## Step 3: Spawn the reviewer

Launch via the Agent tool:

- `subagent_type`: `"general-purpose"`
- `description`: `"Peer-review AMPHTT-NNN diff"`
- `prompt`: the assembled prompt from step 2

`note('Launched peer-review subagent (pass 1)')`.

Wait for the subagent. It returns the JSON array (possibly inside a markdown code block — extract it).

## Step 4: Triage findings

For each finding, assign one of:

- **FIX** — implement the change. Choose when: real correctness/security issue; missing deliverable; missing test for important path; deferral with broken header. Do NOT FIX style/preference items unless they're already enforced by the project's rubocop config.
- **DEFER** — valid but out of scope. Add a `TODO:: [DEFERRED]` comment at the location with proper header, or open a follow-up Linear issue if the user asks (don't do it automatically).
- **LEAVE** — false positive, already handled, or intentional (e.g. divergence the plan calls out). Document why so the human reviewer can sanity-check.

Build the triage table and present it in chat:

```markdown
## Peer review pass <N>: <count> findings

| # | Action | Severity | Title | File | Rationale |
|---|--------|----------|-------|------|-----------|
| 1 | FIX    | major    | ...   | ...  | ...       |
| 2 | LEAVE  | info     | ...   | —    | ...       |
```

## Step 5: Apply FIX items

For each FIX, in order:

1. `report_status('working', 'Addressing finding: <title>', <file>)`.
2. Read the affected file(s).
3. Make the change. Match the existing style; don't drive-by refactor.
4. If the change touches a tested path, run the relevant test file.
5. Stage and commit. Each batch of related fixes can share one commit:

   ```
   fix: address peer-review findings (pass <N>)

   - <bullet per finding>

   AMPHTT-NNN
   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```

If a FIX turns out to be more involved than the finding suggested (real refactor needed), stop and surface it. Don't sprawl the diff silently.

## Step 6: Apply DEFER items

For each DEFER, add a `TODO:: [DEFERRED]` comment at the relevant location with the full header. Stage it as part of the same review-pass commit.

If the user wants new Linear issues created instead of inline TODOs, they'll say so before approving the triage table — don't auto-create issues.

## Step 7: Re-review

Re-run from step 2 (rebuild the prompt with the updated diff and re-spawn the subagent). Increment the pass counter.

**Cap at 3 passes.** If pass 3 still has FIX-grade findings, stop:

```
report_status('blocked', 'Peer review still finds <N> FIX-grade items after 3 passes — needs human input')
```

Output the unresolved findings and stop. The human will decide whether to push despite, or take over.

## Step 8: Auto-push and open the PR

When a pass returns `[]` (or only LEAVE findings), the work is ready to ship. **Do not gate this step on the user** — clean review = auto-push + auto-open PR.

Run final checks:

```bash
bin/run-tests.sh --core 2>&1 | tail -5
bin/rubocop 2>&1 | tail -3
```

If either fails, do NOT push. `report_status('blocked', 'Final checks failed: <one-line>')` and stop. The user investigates.

If both clean, push:

```bash
git push -u origin <branch>
```

`report_status('working', 'Pushed; opening PR')`.

## Step 9: Open the PR

Use `gh pr create` with the plan as the source of truth for title and body.

**Title**: pull from the first non-`docs(plans)` commit in `git log --oneline main..HEAD`. That's the conventional-commit "headline" of the work — the plan's `## Commit Structure` defined it.

**Body**: assemble from the plan file. Required sections:

```markdown
## Summary

- <bullet per deliverable from plan's ## Deliverables, condensed to one line>

## Plan & Java alignment

- Plan: `<PLAN_PATH>`
- <One sentence on Java alignment: "Aligned with <Java class>" or "N/A — no Java equivalent" or "Intentional divergence: <reason>">

## Test plan

- [x] `bin/run-tests.sh --core` — <N> runs, 0 failures
- [x] `bin/rubocop` — <N> files, 0 offenses
- [x] `/cwt-agent-view` — clean after <N> pass(es) (<N> findings actioned, <N> left as annotated)
- [ ] Manual: <one line if any manual verification is appropriate, or "not exercised" with reason>
```

Trailer: `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

Run with a heredoc so newlines in the body survive:

```bash
gh pr create \
  --title "<title>" \
  --body "$(cat <<'EOF'
<body>
EOF
)"
```

Capture the URL from gh's output. `note` it.

## Step 10: Push a `temp/<issue-id>` ref if the diff includes UI changes

The user occasionally needs to spin up a separate dev instance against the work-in-progress branch to manually review UI behaviour. The PR branch keeps moving (more commits land during review), so they want a frozen-at-this-moment ref. Convention: `temp/amphtt-NNN` (lowercase) pointing at the same SHA as the PR branch right after push.

Detect UI changes in the diff:

```bash
git diff --name-only main..HEAD | grep -E '^(app/views/|app/components/|app/javascript/|app/assets/|config/tailwind|tailwind\.config|app/helpers/)' | head -1
```

If that prints anything, the diff touches UI.

```bash
ISSUE_LOWER=$(echo "AMPHTT-NNN" | tr A-Z a-z)
TEMP_BRANCH="temp/${ISSUE_LOWER}"
git push --force origin HEAD:"${TEMP_BRANCH}"
```

`--force` because the temp ref is intended to be overwritten on subsequent pushes — it always points at the *current* head of the PR branch, not a historical version.

## Step 11: Report

`report_status('done', 'PR opened at <url>; CI bots will run')`.

If a temp branch was pushed, `note` its URL too.

Tell the user (in the chat transcript): "PR ready for review. Run `/cwt-review-pr` once CI bots have commented."
