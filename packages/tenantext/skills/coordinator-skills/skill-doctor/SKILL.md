---
name: "skill-doctor"
description: "Grades agent skills by scoring agent conversations for efficiency, code quality, procedure compliance, and verbosity, then drafts concrete skill edits and a shareable report. Use when the user wants their agent setup graded from real conversation history, or asks which of their installed skills are actually working."
---
# skill-doctor

Grade the user's agent setup by scoring recent local agent conversations, then propose concrete skill edits and render one shareable report page.

The report can cover conversations in the current repository, conversations in selected projects, or all local conversations. It can evaluate project skills alone or project and global skills together.

Everything runs locally. The collector also reads, read-only, the sessions on the user's own OpenViking server. Never upload transcripts, session files, or any excerpt of them anywhere. The only shareable artifact is the report the user chooses to post.

Let `SKILL_ROOT` be the directory containing this SKILL.md.

## Step 0: Start the run

### Verify the executing harness

Read `$SKILL_ROOT/references/supported-harnesses.md` and identify the harness executing this skill from the runtime context. If it is unsupported or cannot be identified confidently, follow the reference's stop behavior. Do not create a report directory or read conversation history.

### Ask which conversations to grade

First check whether the current directory is inside a git repository:

```bash
git rev-parse --show-toplevel
```

Use the harness's user-question tool when available.

When a current repository is available, ask **“Which conversations should I grade?”** with:

1. **Conversations in this repository** (recommended).
2. **All conversations**.
3. **Choose projects to analyze**.

When there is no current repository, ask the same question with:

1. **All conversations** (recommended).
2. **Choose projects to analyze**.

If the user chooses projects, ask for one or more project paths. Expand and validate every path as a git repository before continuing. The run produces one combined report across those projects.

### Ask which skills to evaluate

Then ask **“Which skills should I evaluate?”** with:

1. **Project skills + global skills** (recommended).
2. **Project skills only**.

For an all-conversations run, “Project skills” means skills from local git repositories inferred from the conversations' working directories. OpenViking stores no working directory, so the collector finds no project skills for the sessions from OpenViking. For a project skill assessment, name `--repo` or `--skills-dir`. Zero discovered skills does not prove that a project has none. After these answers, proceed immediately.

Never write artifacts into the user's repo. Create one fresh, collision-free scratch directory per run and use it as `REPORT_DIR` for every artifact:

```bash
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/skill-doctor-XXXXXXXX")"
```

## Step 1: Collect
Build the collector arguments from the startup answers:

- Current repository: `--repo "$REPO"`.
- Selected projects: repeat `--repo PATH` for every project.
- All conversations: `--all-conversations`.
- Project and global skills: add `--include-global-skills`.
- Project skills only: do not add `--include-global-skills`.

```bash
python3 "$SKILL_ROOT/scripts/collect_sessions.py" \
  --out "$REPORT_DIR" \
  <conversation-scope arguments> \
  <skill-scope arguments>
```

By default `--harness auto` scans every locally available supported source. Read `$SKILL_ROOT/references/supported-harnesses.md` for source identifiers, storage details, skill locations, and source-specific override flags.

With `--source auto` (the default), the collector reads the Claude Code and Pi sessions from the OpenViking server, and the sessions of the other harnesses from their local files. It takes the server, the key, the account and the user from the `OPENVIKING_*` variables, `ovcli.conf` and the `server` section of `ov.conf`, in the order that `$SKILL_ROOT/references/supported-harnesses.md` gives. When no server is configured or the server does not answer (a connection error, a timeout, HTTP 5xx, a health reply with `healthy: false`), it reads the local files of every harness and prints one `note:` line with the reason. Every other OpenViking failure, for example a refused credential or a missing account, ends the run with one `error:` line and exit code 1. The `sources` entries of `inventory.json` and the `session source` output line name the source of each harness.

Useful flags:

- `--source VALUE`: `auto`, `openviking` (OpenViking only; exit code 1 when the server cannot serve the sessions), or `local` (the local session files only).
- `--harness VALUE`: which local session sources to scan; use the reference's collector IDs.
- `--repo PATH`: include a project; repeatable.
- `--all-conversations`: do not filter conversations by project.
- `--include-global-skills`: also grade global skills.
- `--days N`: lookback window (default 45).
- `--max-sessions N`: cap on sampled sessions (default 12).
- `--skills-dir PATH`: nonstandard skill locations.
- `--include-subagents`: include child or sidechain sessions.

Read `$REPORT_DIR/inventory.json`. If `sessions_sampled` is 0 (the collector then exits with code 3), tell the user there is nothing recent to score in the selected conversation scope (suggest raising `--days` or choosing different projects) and stop. If `skills_found` is 0, continue: the report becomes a case for creating skills, and `skill_coverage` is 0.

## Step 2: Score each sampled transcript

Scoring is based on efficiency, code quality, procedure compliance, and verbosity for the sessions sampled. Process datasets of 50 transcripts or fewer in one scoring run. For datasets with more than 50 transcripts, use parallel batches (20 transcripts per batch recommended). Score batches in the current local agent process, or delegate only to local child agents that keep transcript contents on the user's machine. Start each delegated scorer (a pane or a child agent) with a working directory outside the scored repository, so that the next collector run does not sample the scoring sessions as sessions of that repository. Pass the following rubrics as context:

- `$SKILL_ROOT/scorers/efficiency.md`
- `$SKILL_ROOT/scorers/code-quality.md`
- `$SKILL_ROOT/scorers/procedure-compliance.md`
- `$SKILL_ROOT/scorers/verbosity.md`

Instructions: For each transcript in `$REPORT_DIR/transcripts/`, read it and judge it against all four rubrics. For each scorer record: label, numeric score (from the rubric's label table), and a 1 to 3 sentence reason citing specifics from the transcript. Apply the code-quality scorer only where the transcript shows code changes; otherwise record `insufficient_evidence` and exclude that result from the code-quality average and failed-conversation filter. A transcript without tool output (its header says `tool output: not available`) gives no evidence of errors; score what it shows and do not count missing output as zero errors.

Record each transcript as one JSON line in `$REPORT_DIR/scores.jsonl`, with the ID of the transcript's `# Session` heading as `session_id`:

```json
{"session_id": "<id>", "efficiency": {"label": "", "score": 0.0, "reason": ""}, "code_quality": {}, "procedure_compliance": {}, "verbosity": {}}
```

Append the line right after you judge its transcript, one line at a time. Keep earlier lines as they are, and write only in the `REPORT_DIR` that your task names.

After each line, run `python3 "$SKILL_ROOT/scripts/next_unscored.py" "$REPORT_DIR"`. It prints the count scored, a `note:` for a session ID with more than one line (the first line counts), and the next unscored transcript or `ALL SCORED`. A batch scorer adds the transcript paths of its batch after `"$REPORT_DIR"`, so that the script counts and names only those transcripts. On an `error:` line, fix only the line of `scores.jsonl` that it names.

A scorer is done when its check prints `ALL SCORED`. End the turn or report status only then. With batches, the agent that runs the skill then runs the check without a list, and Step 2 is complete when that check prints `ALL SCORED`.

## Step 3: Aggregate

- `raw_efficiency` = mean of efficiency scores across all scored sessions.
- `raw_code_quality` = mean of code-quality scores, excluding `insufficient_evidence`. If no session had enough evidence, set it to 0.5 and say so in the findings.
- `raw_procedure_compliance` = mean of procedure-compliance scores across all scored sessions.
- `raw_verbosity` = mean of verbosity scores across all scored sessions.
- Curve qualitative rubric means into letter-grade report scores with `curve(score) = 0.5 + 0.5 * score`.
- `efficiency = curve(raw_efficiency)`.
- `code_quality = curve(raw_code_quality)`.
- `procedure_compliance = curve(raw_procedure_compliance)`.
- `verbosity = curve(raw_verbosity)`.
- `skill_coverage` = fraction of sampled sessions where at least one installed skill was detected. If `skills_found` is 0, coverage is 0.
- `overall = 0.25 * efficiency + 0.25 * code_quality + 0.2 * procedure_compliance + 0.15 * verbosity + 0.15 * skill_coverage.`

Then, define `failed_conversations` from each conversation's raw, uncurved scorer results. A conversation fails when at least one applicable efficiency, code-quality, procedure-compliance, or verbosity score is below `0.5`. An `insufficient_evidence` result does not make a conversation fail. Use only `failed_conversations` as evidence for skill-improvement suggestions and draft skill edits.

Then derive the substance:

- `top_findings`: the 3 most impactful, specific patterns across sessions. These lead the report and the spoken summary. Make each summary concrete and concise, following the STE-100 standard.
- `suggestions`: concrete skill changes, if any. Each names a skill (existing or proposed-new) and a specific change: a trigger-description fix so it fires when it should, a missing step or check, a command to encode, a new skill to create. Suggestions must trace back to observed waste or defects in `failed_conversations`, not generic best practices: cite the failed session, scorer, and moment that motivated each one. An installed skill that never triggered in a failed conversation is usually a description problem and worth a suggestion of its own.

## Step 4: Draft skill edits

Follow `$SKILL_ROOT/references/skill-improvements.md` to propose improvements to project skills based only on `failed_conversations`.

1. Read the skill's current file (path is in `inventory.json`).
2. Write the full improved version to `$REPORT_DIR/proposed/<skill-name>/SKILL.md`, changing only what the evidence justifies. Improve the parts the sessions actually exercised: the trigger description that failed to fire, the missing preflight check, the step the agent had to figure out by trial and error.
3. Produce a unified diff between current and proposed (`diff -u <current> <proposed>`) and put it in the suggestion's `diff` field so it renders in the report.

For a proposed-new skill, write the complete new SKILL.md to the same `proposed/` directory and set `diff` to its full content as an addition.

Do not modify the user's real skill files in this step.

## Step 5: Write report.json and render
Write `$REPORT_DIR/report.json`. Store the curved `efficiency`, `code_quality`, `procedure_compliance`, and `verbosity` values, literal `skill_coverage`, and weighted `overall` in `scores`; do not store the raw rubric means there.

```json
{
  "title": "Agent Skill Report",
  "generated_at": "<ISO timestamp>",
  "harness": "<harness from inventory.json>",
  "handle": "<repo_name from inventory.json>",
  "stats": {
    "sessions_analyzed": 0, "sessions_scanned": 0,
    "skills_found": 0, "skills_used": 0, "window_days": 45
  },
  "scores": {
    "efficiency": 0.0,
    "code_quality": 0.0,
    "procedure_compliance": 0.0,
    "verbosity": 0.0,
    "skill_coverage": 0.0,
    "overall": 0.0
  },
  "top_findings": ["", "", ""],
  "suggestions": [
    {
      "skill": "",
      "change": "<one-sentence summary of the edit>",
      "evidence": "<which session(s) and what happened that motivates this>",
      "proposed_path": "<path under proposed/, if an edit was drafted>",
      "diff": "<unified diff, or full content for a new skill>"
    }
  ]
}
```

```bash
python3 "$SKILL_ROOT/scripts/render_report.py" "$REPORT_DIR/report.json" --open
```

This writes a single self-contained `$REPORT_DIR/report.html` and attempts to open it in the default browser. The scorecard, findings, and suggested skill edits appear on one page. Long diffs are collapsed behind a "show more" toggle, and a "share as png" button exports a 1200x675 share image locally. There is no separate card file to open or screenshot.

## Step 6: Output

Tell the user the grade and the three findings, in text.

Finish every response with this exact summary, substituting the absolute `REPORT_DIR` path:

- Your agent skill report: file://$REPORT_DIR/report.html

Want me to apply these suggestions to your skills?

## Run on a schedule

A scheduled job runs Step 1 with flags only. It sets the answers of Step 0 as flags:

```bash
REPORT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/skill-doctor-XXXXXXXX")"
python3 "$SKILL_ROOT/scripts/collect_sessions.py" --source openviking \
  --out "$REPORT_DIR" --repo "$REPO" --include-global-skills
```

The exit code tells the job the result: 0 means sampled sessions, 3 means no sampled session, 1 or 2 means an error. `--source openviking` reads the Claude Code and Pi sessions from OpenViking only and makes the job fail when the server does not answer; with `--source auto`, the job also reads the local files of the other harnesses, and of every harness when the server does not answer.

Step 2 to Step 5 need an agent run, for example a headless agent session that gets this skill and `REPORT_DIR`. This skill has no scheduler.
