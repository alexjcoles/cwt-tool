---
name: cwt-plan-minor
description: Plan a minor implementation for a Linear issue inside a cwt worktree — fetches issue, traces Java if relevant, writes a plan file directly, and stops for user approval. Reports progress through cwt-channel so the host can observe.
disable-model-invocation: false
argument-hint: <issue-id>
allowed-tools: Read, Glob, Grep, Bash(git:*), Bash(grep:*), Bash(rg:*)
---

# /cwt-plan-minor — Minor Implementation Plan (cwt mode)

You are inside a cwt-managed worktree. A user is observing your phase + summary on the host via `cwt status`. Report state changes through the `cwt-channel` MCP tools (`report_status`, `note`) so they don't have to attach to your tmux session to know what you're doing.

The output is a plan file. **Do not begin implementation in this skill** — implementation happens in `/cwt-execute` after the user approves your plan.

## Step 0: Open the channel

Call `report_status` with state `planning` and a summary like "Reading AMPHTT-NNN and assembling context". Set `current_file` to the issue ID for now (the host's table needs *something*).

## Step 1: Fetch the issue

- Parse the issue ID from `$ARGUMENTS`. If empty, call `report_status` with state `blocked`, summary "No issue ID supplied to /cwt-plan-minor", and stop.
- Fetch the issue via `mcp__claude_ai_Linear__get_issue`.

If the Linear MCP tool is unavailable: `report_status('blocked', 'Linear MCP unavailable — cannot fetch issue')` and stop. Do not reconstruct the issue from milestone breakdowns or local docs — silent reconstruction produces plans that look right but miss constraints only the ticket carries.

## Step 2: Verify the issue targets the Rails repo

cwt currently only supports issues that target the Rails app at the worktree root. Issues that touch gem repos (`gems/tantivy_rb`, `gems/lopdf_rb`) need their own gem-side branches to be created separately, and multiple cwt worktrees creating overlapping gem branches in the same shared gem clone would step on each other. That's not solved yet.

Check the issue for any of these signals:

- Milestone is "Tantivy Code Review Remediation"
- Description references `gems/tantivy_rb/`, `gems/lopdf_rb/`, or other gem-internal paths
- Issue title or scope is primarily about Rust code in a gem
- Milestone is "PDF Native Library" with Rust-side work

If any signal is present, this is a gem-targeted issue. **Stop here**: call `report_status('blocked', 'Gem-targeted issue (<gem>) not yet supported by cwt — needs to be planned outside a worktree')` and exit. Do not try to plan it as a Rails change.

For everything else, proceed as a Rails-only plan. The plan file lives in the Rails repo, every deliverable touches Rails code, and no other repos are involved.

## Step 3: Load context (parallel reads)

Read in one batch:
- `docs/templates/minor-plan.md`
- `docs/linear-context.md`
- `CLAUDE.md` (full file — Plan Directions, Java Alignment, Feature Implementations sections in particular)
- **If the issue touches the UI** (views, forms, pages, wizards, layouts, navigation, components — anything that ends up rendered in a browser), also read `docs/ui/norman-y/STYLE_GUIDE.md`. The repo uses Tailwind utility classes plus a custom `.ps-*` namespace defined in `app/assets/tailwind/application.css`. Every `.ps-*` class you reference in an ERB template MUST exist in that stylesheet — there are no separate component CSS files. New classes are added to `application.css` as part of the same commit that introduces them in the view.

`note` any project-specific constraints you find that aren't already obvious from the issue (e.g. "Java alignment is required even when N/A").

## Step 4: Java reference handling

Look at the issue's `## Java reference` section.

- **"N/A — no Java equivalent"**: Java Alignment section will be `N/A — no Java equivalent` with the issue's reason. Skip step 4.
- **File paths listed**: launch the flow tracer subagent. Read `.claude/skills/cwt-plan-minor/java-flow-tracer-prompt.md` (if present in this worktree) or fall back to the project's `.claude/skills/plan-minor/java-flow-tracer-prompt.md`. Replace `{ENTRY_POINTS}` with the listed paths. Launch via the Agent tool, `subagent_type: "Explore"`, `description: "Trace Java flow for AMPHTT-NNN"`. Run in parallel with step 3 if not already done.
- **Sparse reference (description only)**: invoke the `java-explore` skill via the Skill tool to find files. If it surfaces concrete entry points and the feature involves state mutations or workflows, then run the flow tracer with those entry points.

Hold the tracer's "Summary: all behaviours" table — it populates the plan's Java Alignment table.

## Step 5: Search for existing deferrals

```bash
rg "TODO:: \\[DEFERRED\\]" -A 6 | rg -B 1 "AMPHTT-NNN"   # the current issue ID
```

Search the Rails worktree. Each existing deferral that names this issue must be addressed in the plan — either implemented as a deliverable, or explicitly re-pointed.

## Step 6: Verify branch state

You're in a worktree, so the branch is already created and checked out (`cwt new` did this). Confirm:

```bash
git branch --show-current        # should match alexc/amphtt-NNN-{slug}
git status --short                # should be clean apart from cwt-generated .mcp.json/.claude/
```

If the branch name doesn't match the Linear issue's `gitBranchName`, that's a setup bug — `report_status('blocked', 'Branch name mismatch')` and stop.

## Step 7: Determine plan file path

Plan files live in the Rails worktree under `docs/plans/<milestone-slug>/amphtt-NNN-<slug>.md`. Use the milestone from the issue. If the issue has no milestone, use `docs/plans/isolated/`.

Store the path as `PLAN_PATH` for the next step.

## Step 8: Write the plan

`report_status('working', 'Drafting plan', PLAN_PATH)`.

Write the plan directly to `PLAN_PATH` using the Write tool. Follow `docs/templates/minor-plan.md` structurally — every required section MUST be present. The PreToolUse `validate-plan.sh` hook (configured in the project's `.claude/settings.local.json`, if active) will block the write if a section is missing.

Required sections (compliance failure if any are omitted):

- `## Context` — `**Linear issue**: AMPHTT-NNN`, `**Repository**: ...`, `**Branch**: ...`
- `## Deliverables` — numbered, concrete, verifiable
- `## Design Decisions` — numbered, each with **Why** and **Alternative rejected**
- `## Migration` — full DDL if applicable; omit the section heading entirely if none
- `## Java Alignment` — always present. Comparison table if Java equivalent exists; `N/A — no Java equivalent` with reason otherwise.
- At least one implementation-specific section: `## Changes`, `## UI Layout`, `## Request Flow`, `## Files`, `## Test Coverage`, or `## Service Design`
- `## Commit Structure` — conventional-commit messages with file/concern lists, each ending with a Linear-ID trailer line
- `## Amendments` — heading present, body empty (filled during execute / review-pr)

Use ASCII diagrams for spatial things (UI, request flow), tables for before/after and Java-vs-Rails comparison. Show, don't just tell.

**For UI deliverables**: list every new `.ps-*` class you intend to introduce alongside the view it appears in, and mark them as needing definitions in `app/assets/tailwind/application.css`. Prefer reusing existing classes (grep `app/assets/tailwind/application.css` for the namespace, e.g. `\.ps-admin-`, `\.ps-form__`, `\.ps-table__`) — invent new ones only when nothing fits.

## Step 9: Update plans README

Add an entry to `docs/plans/README.md` under the appropriate milestone heading (creating the heading if needed, in alphabetical order):

```markdown
| [amphtt-NNN-slug.md](milestone-dir/amphtt-NNN-slug.md) | AMPHTT-NNN |
```

An unlisted plan is invisible. Do not skip.

## Step 10: Self-review against checklist

Re-read your plan file. Walk the required-sections checklist. Verify:

- All headings present
- Each section has substantive content (not just a heading)
- Java Alignment has a real table or an explicit `N/A — no Java equivalent` with reason
- Commit messages follow conventional-commit format with `AMPHTT-NNN` trailer
- Deliverables are specific enough that "done" is unambiguous

If any check fails, fix the plan and re-read.

## Step 11: Hand off to the user via the dashboard

`report_status('waiting', 'Plan written; awaiting user approval', PLAN_PATH)`.

Then call `await_decision` so the dashboard surfaces the prompt as a modal instead of forcing the user to attach to your tmux session:

```
await_decision(
  question="Plan written at <PLAN_PATH>.\n" +
           "<count> deliverables · Java alignment: <Yes / N/A> · <count> deferrals resolved.\n\n" +
           "Reply 'approved' to proceed to /cwt-execute, or describe what to change.",
  options=["approved"]
)
```

The call blocks until the user answers in the dashboard. The returned text is their response.

Branch on the answer. Accept any of "approved", "approve", "yes", "y", "ok", "go", "lgtm", "ship it" (case-insensitive, trimmed) as approval — users type the obvious thing. Anything else is treated as feedback.

- If approval: `report_status('working', 'Plan approved; chaining into /cwt-execute')` and **invoke `cwt-execute` automatically** via the Skill tool — the user has already approved, no second gate needed:

  ```
  Skill(skill="cwt-execute")
  ```

  The execute skill takes over from here: implementation, then auto-chains into agent-view → push → PR. This skill returns when execute returns.

- If it's a revision request: read the response carefully, edit the plan file in place to address it, then call `await_decision` again with the same question. Loop until approved.

- If it's something else entirely (e.g. user wants to abandon): acknowledge and stop. Do not delete the plan file — leave it for them to inspect.
