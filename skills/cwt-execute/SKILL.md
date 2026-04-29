---
name: cwt-execute
description: Implement an approved plan inside a cwt worktree. Reads the plan file from the current branch, works through deliverables in commit-sized chunks, runs tests after each, and reports phase changes to the host via cwt-channel.
disable-model-invocation: false
argument-hint: (no args — finds the plan from the current branch)
allowed-tools: Read, Edit, Write, Glob, Grep, Bash
---

# /cwt-execute — Implement an Approved Plan

You are implementing an approved plan inside a cwt-managed worktree. The plan is the source of truth for what to do; deviating from it requires either a plan amendment or stopping for the user.

This skill assumes `/cwt-plan-minor` has already run and the user has approved the plan. If the user hasn't approved yet, stop and tell them.

## Step 0: Open the channel

`report_status('working', 'Resuming work — finding the approved plan')`.

## Step 1: Locate the plan

The plan file path is encoded in the branch name. Branch format: `alexc/amphtt-NNN-<slug>`.

```bash
BRANCH=$(git branch --show-current)
ISSUE_ID=$(echo "$BRANCH" | grep -oE '[a-z]+-[0-9]+' | head -1 | tr a-z A-Z)
```

Find the plan:

```bash
fd "amphtt-${ISSUE_ID#AMPHTT-}-.*\\.md$" docs/plans/ | head -1
# or if fd is unavailable:
find docs/plans -name "amphtt-${ISSUE_ID#AMPHTT-}-*.md" | head -1
```

If no plan file is found: `report_status('blocked', 'No plan file found for this branch — run /cwt-plan-minor first')` and stop.

If multiple match (shouldn't happen with proper naming): pick the one whose milestone matches the issue's milestone, and `note` the ambiguity.

Read the entire plan file. Pay attention to:
- `## Deliverables` — your work list
- `## Commit Structure` — how to break the work into commits
- `## Java Alignment` — what behaviours to preserve
- `## Migration` — DDL to write (if present)
- `## Amendments` — anything added since the plan was first approved

## Step 2: Pre-execution sanity check

Before touching code, verify the environment:

```bash
git status --short                # working tree should be clean (cwt-generated files aside)
bin/run-tests.sh --core 2>&1 | tail -5    # baseline: tests must pass before you start
```

If the baseline tests fail: `report_status('blocked', 'Baseline tests failing before any changes — investigate before continuing')` and stop. Do not begin implementation on top of a red baseline.

## Step 3: Resolve existing deferrals first

The plan should already list any `TODO:: [DEFERRED]` comments that reference this issue. Address them as part of your first commit (so the deferral resolution is traceable).

For each deferral:
- If now unblocked: implement the deferred behaviour and remove the comment.
- If still blocked: update the `# See:` line to the correct future issue and update the `# Reason:` line. Never leave a deferral pointing at the current (about-to-close) issue.

## Step 4: Work through deliverables, commit by commit

For each commit in `## Commit Structure`:

1. `report_status('working', '<commit summary>', <primary file path>)`.
2. Implement the changes for that commit. Stay within the commit's scope — don't drag in changes the plan attributes to a later commit. If you discover something that makes the commit ordering wrong, `note` it and stop for the user; don't silently re-order.
3. Run the relevant tests:
   - For model/service changes: `bin/rails test test/models/... test/services/...`
   - For controller changes: `bin/rails test test/controllers/...`
   - For broad changes: `bin/run-tests.sh --core`
4. If tests pass: stage the planned files (`git add <files>` — never `git add -A`) and create the commit. Use the plan's commit message verbatim, with the `AMPHTT-NNN` trailer:

   ```
   <type>(<scope>): <description from plan>

   <body>

   AMPHTT-NNN
   Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
   ```

5. If tests fail: `report_status('blocked', '<test name> failing: <one-line cause>')`, save your work in progress with `git stash` if needed, and stop. Do NOT push through red tests by relaxing assertions or skipping tests.

## Step 5: Plan deviations (amendments, not silent rewrites)

If during implementation you discover the plan is wrong (a design decision that doesn't survive contact with the code, a missed dependency, a surprise in the existing implementation):

1. `report_status('blocked', 'Plan needs amendment: <one-line>')`.
2. Append an entry to the plan's `## Amendments` section using the format from `docs/templates/minor-plan.md`:

   ```markdown
   ### YYYY-MM-DD — <short title>

   **Trigger**: <what made you change course>
   **Original approach**: <what the plan said>
   **What changed**: <what you're doing instead>
   **Why**: <why the original was insufficient>
   **Impact**: <what else this affects, or "None">
   ```

3. Stop and wait for the user to acknowledge the amendment. Don't push through significant deviations without their input.

Tiny mechanical adjustments (renaming a local variable, fixing a typo in a comment) don't need amendments — only design/structure deviations.

## Step 6: Resolve any newly-introduced deferrals

If your implementation introduced new `TODO:: [DEFERRED]` comments (something the plan deferred), confirm each one has the full required header:

```text
# TODO:: [DEFERRED] <what>
# Reason: <why>
# Scope: <1-5>
# Java ref: <path or N/A>
# See: <future Linear issue ID>
```

Missing fields will be flagged at review time. Better to fill them now while the context is fresh.

## Step 7: Final state check

After the last commit:

```bash
git log --oneline main..HEAD             # commits should match plan's Commit Structure
git status --short                        # should be clean
bin/run-tests.sh --core 2>&1 | tail -5    # all tests green
bin/rubocop 2>&1 | tail -3                # rubocop clean
```

`report_status('waiting', 'Implementation complete; awaiting agent-view trigger')` and `note` the commit count and any new files added.

Then call `await_decision` so the dashboard surfaces the prompt:

```
await_decision(
  question="Implementation complete.\n" +
           "Commits: <count> · Files changed: <count> · Core tests: pass\n" +
           "Deferrals resolved: <count> · introduced: <count>\n\n" +
           "Reply 'go' to run /cwt-agent-view (automated peer review), " +
           "or describe what to revisit before that.",
  options=["go"]
)
```

Branch on the answer:

- "go" (case-insensitive): `report_status('done', 'Implementation complete; ready for agent-view')` and stop. The user runs `/cwt-agent-view` next.
- Revision request: address it (additional commits, fixes), then call `await_decision` again.

**Do NOT push** in this skill. Push happens after `/cwt-agent-view` has run and the user has separately approved.
