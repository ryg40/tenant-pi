# The dummies report

A coordinator session teaches a junior developer, ends its work with an outcome report, and logs to the project page `DUMMIES`.

## 1. Coordinator sessions only

You are a coordinator session when the user talks to you directly and no start prompt gives you a task role. A task session (a start prompt that gives a task role such as worker, reviewer, researcher or scout, or a result format of its own) stops here at once: it runs no command and reads no other file of this skill. Its role sets its result form.

## 2. State check

A coordinator session runs the state check first, unless it ran it in this turn. The script is in the `scripts` directory of this skill, beside this file:

```sh
python3 <this skill directory>/scripts/state.py
```

When its output starts with `dummies: off`, stop: use no part of this file. The `role:` part of the output gives the Herdr role when the pane has one. A role of a task session also means stop.

## 3. The report

A turn is one reply to the user. End its last message with one report: a harness can shorten text between tool calls. Claude Code and Pi use the same compact form: plain Markdown lines with no table and no code fence. Each line follows section 6.

```markdown
**REPORT 3** The fix is merged; the tag check failed

- **[1]** Done: The footer fix is on main at commit 1a2b3c4.
- **[2]** Failed: The macOS check of the tag failed. https://git.example.org/team/project/actions/runs/812
- **[3]** Needs approval: The release entry of the tag waits for the owner.
- **[4]** Proposal: Remove the old worktree after the release.

**Warning:** The tag is public, and its macOS check failed.

**Next:**
- **[a]** Agent: Read the log of the failed check and find the cause.
- **[b]** Owner decides, after the macOS check passes: Make the release entry, or hold the release.

A new run of the check uses the same tag. Do not move the tag by hand.
```

- `REPORT <n>`: the number of the report in this session, then the result in 8 words or less.
- Items: include each subject the reader needs, normally about four. Each item uses one or two short sentences, 25 words or less. Put active subjects first. More than five items is valid.
- The state word of an item keeps completed work, failed checks, unverified results, proposals and pending approval apart. Never give planned work the state `Done`.

| State | Meaning |
| --- | --- |
| `Done` | Completed and checked. |
| `Failed` | A step or a check failed. |
| `Unverified` | Done, but not proven. |
| `Running` | In progress now. |
| `Blocked` | It waits for another item or for a fact. |
| `Proposal` | A suggestion. Nobody approved it. |
| `Needs approval` | Ready, but it waits for the owner. |
| `Retired` | Stopped or replaced. |

- `**Warning:**`: 0 to 2 lines for a risk, a failed check or an unverified limit that the reader must see. A warning does not replace the item of a failed check.
- `**Next:**` replaces the old `Open`. Its first action is the recommended next action. Add as many actions as needed for other unfinished or unverified work, in order. Each action has an independent lowercase label, its actor and its condition, when present. Name relevant subjects in words; action labels do not identify report items. Actions are proposals, not authorization.
- Actors: `Agent` acts. `Owner` acts, for example with a command that only the owner can run. `Owner decides` means that the owner must decide, and the action text gives the choices.
- `**Next:** None.` and a reason: no safe next action, or no work is left. The reason says which. Then no action line follows.
- After the block, write 1 to 3 short sentences of ordinary prose: only the steps and the pitfalls that the block does not say. Do not repeat the block.
- URLs: write each URL in full as plain text at the end of its line. Use no Markdown link, no shortened URL and no line break in a URL. A terminal can wrap a long URL, but its text stays the same.
- Teach a junior developer: short full sentences in Simplified English, with each article and each verb. Give a new term its meaning.

### Report numbers and action labels

1. Number the main items `1`, `2`, through `N`, in order. Restart at `1` in every report and outcome.
2. Label next actions independently `a`, `b`, through `z`, then `aa`, `ab`, through `az`, `ba`, through `zz`, then `aaa`. Continue as bijective base-26: carry `z` to `a` and increase the letter to its left; prepend `a` when all letters carry.
3. Restart next-action labels at `a` in every report and outcome. Neither sequence has a count cap.
4. A number identifies an item only within that report. A lowercase label identifies only a next action, never a numeric subject.
5. Resolve `explain item 2` or `continue action b` against the latest report unless the user names another report. Ask when the target is missing or ambiguous.
6. Write subjects in words across reports and handoffs. Labels are not session-stable subject identifiers.

## 4. Grouping

Before a report, apply this test to the turns since your last report. Give no report in this turn when all three are true:

1. The turns are steps of the same process.
2. The turns taught nothing new: a junior developer learns nothing from them that the last report did not say.
3. Your approach did not leave the goal and the plan that you gave at the start.

The next report then covers the series, and its `REPORT` line gives the count of the turns, for example `**REPORT 3 (4 turns)**`.

Report in the same turn after a failure, a surprise, a change of the plan or of the goal, a decision or a correction of the user, a result that the user must act on, and at the end of the work.

## 5. The end of the work

When the work is complete, read `LOG.md` beside this file before your last message. The work is complete each time a task of the user is done and you give your final answer for it. First add the entry of this session to the page `DUMMIES`, as `LOG.md` says. With no `okknow` command, the entry goes to a local file of the user, and the `added:` line names it. When the state check of section 2 shows `log: off`, add no entry and give no `added:` line. Then end your last message with the outcome report of `LOG.md`: the compact form of section 3 with an `OUTCOME` line. It replaces the report of that turn.

## 6. Compact report syntax 2

This is the chat contract of the report and outcome. `LOG.md` and report readers cite it by this name. The page `DUMMIES` keeps its own schema in `LOG.md`.

Compatibility: syntax 2 replaces syntax 1. Programs reject legacy uppercase-subject reports and mixed forms as ambiguous; they use no fallback. Historical chat and log pages stay unchanged. No action label is converted into an item number.

A program reads only the last assistant message of the session. It skips each line in a code fence and each line that starts with `>`: these are examples and quotes. A fence line starts with three or more backticks or three or more tildes, after at most three spaces. The fence closes at the next line that holds only the same character, at least as many times, after at most three spaces and before spaces only; with no such line, the fence runs to the end of the message. The program skips both fence lines and every line between them.

Each pattern matches one whole line without its line end. A program removes no space from a line: a block line that ends with a space matches no pattern, so the report is ambiguous. A condition holds no colon, because the first colon after the actor ends the condition.

```text
report   ^\*\*REPORT [1-9][0-9]*(?: \((?:[2-9]|[1-9][0-9]+) turns\))?\*\* \S(?:.*\S)?$
outcome  ^\*\*OUTCOME\*\* \S(?:.*\S)?$
item     ^- \*\*\[([1-9][0-9]*)\]\*\* (Done|Failed|Unverified|Running|Blocked|Proposal|Needs approval|Retired): \S(?:.*\S)?$
warning  ^\*\*Warning:\*\* \S(?:.*\S)?$
next     ^\*\*Next:\*\*$
action   ^- \*\*\[([a-z]+)\]\*\* (Agent|Owner decides|Owner)(?:, ([^:]+))?: (\S(?:.*\S)?)$
none     ^\*\*Next:\*\* None\. \S(?:.*\S)?$
```

- The block in order: one `report` or `outcome` line, the `item` lines, the `warning` lines, then one `next` line or one `none` line. Empty lines can separate these groups. An empty line holds nothing or spaces only.
- One or more `item` lines are required. One or more `action` lines follow the `next` line without an empty line between them.
- The block ends at the first empty line after the last `action` line or after the `none` line, or at the end of the message. The prose follows that empty line, and a program does not read it.
- The first `action` line is the recommendation. Its groups give the action label, actor, optional condition and action text, not a subject reference.
- Validate both sequences independently: item numbers start at `1` and increase by one; action labels follow section 3 from `a`.
- Missing: no `report` or `outcome` line, or no `next` or `none` line after it.
- Ambiguous: multiple report/outcome lines; an unknown or out-of-order block line; no items; `next` without an action directly below it; a duplicate, skipped, reordered or wrong-case label in either sequence. Legacy and mixed forms are ambiguous.
- There is no maximum count of items or actions. The warning count is a style rule only.
- Missing, ambiguous and `none` reports give no suggestion. A program never guesses a subject link from position, label or prose.

### Conservative next-prompt selection

Independent labels carry no subject linkage. The next-prompt reader therefore suppresses its draft for the whole report when any of these appears:

- An `Owner` or `Owner decides` action, even after an `Agent` action.
- A condition on any action.
- A `Needs approval`, `Retired`, `Proposal` or `Blocked` item anywhere in the block.
- Any warning line, or unsafe control, hidden or bidirectional characters anywhere in the block.

Otherwise only the first unconditional `Agent` action is eligible. `Done`, `Failed`, `Unverified` and `Running` are facts, not permission. The reader never promotes a later action when the first is ineligible. This rule intentionally hides safe actions beside unrelated approval or retired work rather than guessing their relation. Free text is not a machine-verifiable permission system. The draft says `Continue action <label>: <action text>` and remains subject to the normal safety and approval checks. Tab inserts only a draft; Enter submits it. The reader's length and editor/session guards can also suppress it.
