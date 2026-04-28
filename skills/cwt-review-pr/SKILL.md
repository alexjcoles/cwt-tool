---
name: cwt-review-pr
description: Triage CI bot review feedback on the PR for this worktree's branch — fetch findings, triage fix/defer/leave with the user, implement approved changes, update plan amendments. Reports phase changes through cwt-channel.
disable-model-invocation: false
argument-hint: [PR number or URL]
allowed-tools: Read, Glob, Grep, Edit, Bash(gh:*), Bash(git:*)
---

# /cwt-review-pr — Triage and Resolve PR Review Feedback

You are triaging review feedback on the PR for this worktree's branch, deciding what to fix, and implementing the approved changes. The PR has already been pushed and at least one CI bot (`claude[bot]`, `coderabbitai[bot]`) has commented.

This skill assumes the implementation is already complete and `/cwt-agent-view` has run. Use this when CI surfaces things the local pass missed, or when a human reviewer leaves findings.

## Step 0: Open the channel

`report_status('working', 'Triaging PR review feedback')`.

## Step 1: Identify the PR

- Parse the PR number from `$ARGUMENTS`. Accepts a number (`100`), URL, or empty.
- If empty, find the open PR for the current branch:

  ```bash
  gh pr list --state open --head "$(git branch --show-current)" --json number --jq '.[0].number'
  ```

- If no PR is found: `report_status('blocked', 'No open PR for this branch — push first or pass a PR number')` and stop.

Store the PR number, repo owner/name, and branch for the rest of the skill.

## Step 2: Fetch all review feedback (parallel)

Reviews come from three different GitHub API endpoints. Fetch all in parallel:

1. **Issue comments** — top-level PR comments, used by `claude[bot]` for architectural review:

   ```bash
   gh api repos/{owner}/{repo}/issues/{PR}/comments \
     --jq '[.[] | select(.user.login | test("\\[bot\\]$")) | {reviewer: .user.login, body: .body, url: .html_url}]'
   ```

2. **Review comments** — inline diff comments, used by `coderabbitai[bot]` for file-level findings:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{PR}/comments \
     --jq '[.[] | select(.user.login | test("\\[bot\\]$")) | {reviewer: .user.login, body: .body, path: .path, line: .line, url: .html_url, comment_id: .id}]'
   ```

3. **PR reviews** — review-level summaries:

   ```bash
   gh api repos/{owner}/{repo}/pulls/{PR}/reviews \
     --jq '[.[] | select(.user.login | test("\\[bot\\]$")) | {reviewer: .user.login, state: .state, body: .body}]'
   ```

Plus PR metadata:

```bash
gh pr view {PR} --json title,headRefName,baseRefName
```

## Step 3: Parse and categorise findings

A finding is **actionable** if it:
- Identifies a specific code issue (bug, vulnerability, missing validation, incorrect behaviour)
- Suggests a concrete change (not just an observation or open question)
- Has severity of "warning" or higher

**Skip** (do not include as findings):
- Architectural review tables where every item is PASS or N/A
- Summary / walkthrough comments with no specific issues
- Purely informational or complimentary comments
- Comments from `linear[bot]` or other non-review bots
- Duplicate findings flagged by multiple reviewers — keep the most detailed version

For each kept finding, extract:

- **reviewer**: which bot or person raised it
- **severity**: critical / major / minor / info (from the comment body, or inferred)
- **file**: file path if it's an inline comment (`null` for general comments)
- **line**: line number if available
- **title**: one-line summary
- **description**: the full finding text
- **suggested_fix**: the proposed code change, if provided
- **url**: link to the comment
- **comment_id**: GitHub comment ID (only for inline review comments — needed for replies)

## Step 4: Triage each finding

Apply one of:

### FIX — implement the change

Choose FIX when:
- The finding is a real bug, security issue, or correctness problem
- The suggested fix is sound and doesn't introduce new problems
- The change is within the scope of the current PR
- The effort is proportionate (not a complete rewrite for a minor issue)

### DEFER — create a follow-up issue or annotate

Choose DEFER when:
- The finding is valid but out of scope for this PR
- Fixing it would require significant refactoring beyond the PR's purpose
- It depends on infrastructure not yet built
- It's a valid improvement but not blocking

### LEAVE — no action needed

Choose LEAVE when:
- The finding is a false positive (the reviewer misread the code)
- The concern is already handled elsewhere — say where
- The suggested fix would introduce worse problems than it solves
- The finding is style/preference, not correctness, and conflicts with project convention
- The behaviour is intentional and the reviewer didn't account for that

## Step 5: Present triage summary

Output the triage table:

```markdown
## PR Review Triage: #{PR} — {PR title}

| # | Action | Severity | Finding | Reviewer | Rationale |
|---|--------|----------|---------|----------|-----------|
| 1 | FIX    | major    | <title> | coderabbitai[bot] | <why fix> |
| 2 | LEAVE  | minor    | <title> | coderabbitai[bot] | <why leave> |
| 3 | DEFER  | major    | <title> | claude[bot]      | <why defer + scope> |

### Details

#### Finding 1: <title> — FIX
<full description>
<the proposed fix and any modifications you'd make>
<file(s) and line(s) affected>

#### Finding 2: <title> — LEAVE
<full description>
<why no action is needed — be specific>
```

For FIX items, include enough detail that the user can evaluate the proposed change. Show the code diff you intend to make if non-trivial.

For LEAVE items, the user needs enough context to agree or override.

For DEFER items, estimate scope (1-5) and suggest whether it warrants a new Linear issue or a `TODO:: [DEFERRED]` comment.

`report_status('waiting', 'Triage complete; <N> fix / <N> leave / <N> defer; awaiting user approval')`.

## Step 6: Get user approval

Ask: *"Proceed with the above triage? You can change any item (e.g. 'change 2 to FIX', 'defer 1 instead'). Reply 'approved' or describe changes."*

Wait for explicit approval. Do not proceed until the user confirms.

## Step 7: Implement approved fixes

`report_status('working', 'Implementing approved fixes')`.

For each FIX item, in order:

1. Read the affected file(s) — understand the code around the finding.
2. Make the change with the Edit tool, matching existing style.
3. If a relevant test exists, run it. If the change is to a script, syntax-check it.

Constraints:
- Fix ONLY what the finding describes — no drive-by refactoring.
- If the reviewer's suggested fix needs adjustment, explain what you changed and why.
- If the fix turns out to be more complex than expected, stop and ask the user before continuing.

After all FIX items, commit them as a batch:

```
fix: address PR #<NNN> review feedback

- <bullet per finding>

AMPHTT-NNN
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

## Step 8: Update plan amendments

Find the plan file (same approach as `/cwt-execute` step 1).

For each FIX you implemented, append an entry to the plan's `## Amendments` section:

```markdown
### YYYY-MM-DD — <short title>

**Trigger**: PR #<NNN> review feedback from <reviewer> — <one-line summary>.
**Original approach**: <what the plan/code originally did, with reference to the relevant section/commit>.
**What changed**: <the fix that was applied — show before/after if it helps>.
**Why**: <why the original was insufficient and why this fix is correct>.
**Impact**: <what else is affected, or "None">.
```

Use today's date. If the plan already has amendments, append after the last one. Commit the plan amendment alongside the fix commit (or as a follow-up commit if you're batching).

## Step 9: Handle DEFER items

For each DEFER:

- If the user approved creating a Linear issue: tell them to run the project's `/create-issue` skill (cwt does not currently auto-create issues).
- Otherwise: add a `TODO:: [DEFERRED]` comment at the relevant location with the full header (what / Reason / Scope / Java ref / See).

## Step 10: Draft replies (requires confirmation)

Read `docs/templates/pr-review-reply.md` (if present) for the project's reply format. Draft a reply for each finding using FIX/LEAVE/DEFER templates.

**Do not reply to**: architectural review summaries where everything passed, informational comments, walkthrough summaries.

Show all draft replies in one block:

```markdown
### Draft PR replies (will be posted after your approval)

**Reply to <reviewer> on <file>:<line>** (<FIX/LEAVE/DEFER>):
> <reply text>

**Reply to <reviewer> (general comment)** (<FIX/LEAVE/DEFER>):
> <reply text>
```

Wait for explicit approval. Then post:

- Inline review comments:

  ```bash
  gh api repos/{owner}/{repo}/pulls/{PR}/comments/{comment_id}/replies -f body="<reply>"
  ```

- Top-level issue comments:

  ```bash
  gh api repos/{owner}/{repo}/issues/{PR}/comments -f body="@<reviewer> <reply>"
  ```

If the user declines posting, skip this step — the code changes and plan amendments still stand.

## Step 11: Report

`report_status('done', '<N> findings triaged; <N> fixes applied; <N> deferrals')`.

Summarise in chat:
- Findings triaged (N fix / N leave / N defer)
- Files modified
- Plan amendments added
- Reminder: review changes locally, then `git push` to trigger another CI pass

**Do NOT push or merge.** The user pushes when ready, the CI pass runs again, and they decide whether to merge.
