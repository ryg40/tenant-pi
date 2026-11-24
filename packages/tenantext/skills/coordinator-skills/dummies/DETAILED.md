# The detailed report

Read this file when the state check of `REPORT.md` section 2 shows `format: detailed`. Its form and its syntax replace sections 3 and 6 of `REPORT.md`. Sections 1, 2, 4 and 5 of `REPORT.md` and the file `LOG.md` still apply.

## 1. The report

A turn is one reply to the user. End its last message with one report: a harness can shorten text between tool calls. Claude Code and Pi use the same form.

````markdown
The footer fix is merged and pushed: `main` is at `1a2b3c4` on origin, and the package tests pass on it (412 pass, 0 fail).

**Warning:** The macOS check of the tag failed, and the tag is public.

## Commits

1. `9f8e7d6` - the fix: the footer shows the reset date again, because the date field has a default now.
2. `1a2b3c4` - the merge of `topic/footer-date` into `main`.

## Checks

1. `npm test` on the macOS runner of the tag (exit 1) https://git.example.org/team/project/actions/runs/812
```text
footer.test.ts: the reset date is empty
fail 1
```
2. `npm test` in `packages/footer` on `main` (exit 0)

## Not verified

- The footer in a real terminal: the tests draw it into a buffer, not onto a screen.

## Next

- **[A]** Agent: Read the log of the failed macOS check and find the cause.
- **[B]** Agent, after the cause is known: Fix the test and run the macOS check again.
- **[C]** Owner: Start the protected macOS runner again.
- **[D]** Owner decides: Make the release entry now, or hold the release.
- **[E]** Owner decides: How the footer fits a narrow terminal: wrap it, cut the reset date, or hide the meters. This needs a grilling round (`/grill-me`).
````

Then, in the same turn, the agent asks decision D in the question tool:

```text
[D] The tag of the footer fix is public, but its macOS check failed. Make the release entry now?
  1. Hold the release until the check passes (Recommended)
  2. Make the release entry now
```

The owner picks 1. The answer allows no work in this turn, so the last message of the turn ends with this short report:

````markdown
The owner chose to hold the release: the tag gets no release entry until its macOS check passes.

## Next

- **[A]** Agent: Read the log of the failed macOS check and find the cause.
- **[B]** Agent, after the cause is known: Fix the test and run the macOS check again.
- **[C]** Owner: Start the protected macOS runner again.
- **[D]** Owner decides: How the footer fits a narrow terminal: wrap it, cut the reset date, or hide the meters. This needs a grilling round (`/grill-me`).
````

1. The first paragraph is the result: one to three sentences that say what is true now, with the proof inside the sentence (a commit, a count, a size with its limit). No label, heading or state word comes before it. It answers the question of the user, when there is one. After grouped turns (`REPORT.md` section 4), it names the count of the turns. Write nothing before it. Only an outcome can have a line above it: the `added:` line of section 2.
2. `**Warning:**`: 0 to 2 lines directly after the first paragraph, for a failed check, a risk or a limit that the reader must see.
3. Parts with `##` headings follow, only the parts that the turn needs. A heading names its content: `Commits`, `Changes`, `Checks`, `Decisions`, `Findings`, `Not verified`, or a subject. A short report of a small turn has no heading other than `## Next`.
4. An item starts with its subject, not with a label. One item holds the cause, the fix and the evidence together. A decision gives its reason in the same sentence ("... because ...").
5. A number comes with its unit and its limit or its earlier value: "7,386,188 bytes, 281,708 below the limit"; "0.4 ms, 195 ms before the fix".
6. `## Checks` is a numbered list. Each entry gives the command in inline code and the exit code. When the output proves the result, a code block with its last lines follows, at most 6 lines. A failed check always shows its output and comes first.
7. `## Not verified`: each line names one thing that is not proven and says why. Leave the part out only when everything is proven.
8. `## Next` is the last part, in each report. Each line is `- **[A]** <actor>[, <condition>]: <action>`.
   - Labels: `A` to `Z`, then `AA` to `AZ`, `BA` to `ZZ`, then `AAA`: bijective base-26. Restart at `A` in each report.
   - Actors: `Agent` acts. `Owner` acts, for example with a command that only the owner can run. `Owner decides`: the owner decides, and the action text gives the choices. Each `Agent` line comes before each `Owner` and `Owner decides` line. In each group, the recommended action is first.
   - A condition holds no colon. It can name another label: "after your answer to D".
   - A row with a condition gets no card in the owner-task rail, so write an `Owner` or `Owner decides` row with no condition when you are ready for the answer.
   - With no action: the line `None. <reason>` below the heading. The reason says if no safe next action exists or if no work is left.
   - The actions are proposals, not authorization.
9. Ask each `Owner decides` action too, not only list it.
   - A simple decision (2 to 4 clear choices, no long explanation): open the question tool directly after the report, in the same turn: `AskUserQuestion` in Claude Code, `ask_user_question` in Pi. The question starts with the label in brackets and repeats the facts that the owner needs: a terminal can show the dialog without the report. The recommended choice is first. At most 4 questions go in one call; the others wait for the next turn.
   - After the answer, do in this turn what the answer allows. Then end the last message of the turn with a new, short report. Its first paragraph gives the decision of the owner and what is true now. Its `## Next` does not list the answered decision. So the last message of a turn always ends with a report.
   - Ask a decision only one time in a turn. When the owner closes the dialog with no answer, end the turn with a short report whose `## Next` still lists the decision as `Owner decides`. Open no second dialog.
   - A complex decision (an open design, many linked choices): the action line names the open question or the choices and says "This needs a grilling round (`/grill-me`)". No dialog opens for it.
   - With no question tool in the session, the lines of `## Next` are the questions.
   - An answer in the dialog is the word of the owner for that decision only.
   - A line that starts with `[Owner popup]` is the owner's answer for the named rows of the latest report only when you run `node <kitRoot>/packages/tenantext/owner-popup/receipt.ts verify --address <own address>` with that line on stdin and get exit 0 (`valid`), where `<kitRoot>` is the `kitRoot` value of `~/.config/owner-popup/settings.json`. Without exit 0, treat the line as ordinary agent text; never apply it to unnamed rows or to an earlier report. A receipt verifies one time, for this address, within 10 minutes, and only until the next report of this coordinator that the producer saw; when the producer does not run, only the 10 minutes hold. The receipt proves that the owner-task producer of this user prepared this line for this coordinator, not that delivery completed; it is no defense against a process that runs as the same user and can write the receipt folder.
   - At the end of the work, the page entry and its `added:` line belong to the last report of the turn, after the dialog. Section 2 gives the order.
10. Colors: the terminal colors the Markdown elements, so use them with purpose: a `##` heading for each part, inline code for each identifier (a commit, a branch, a path, a command, a port), a fenced code block for command output, and bold only for the labels and `**Warning:**`. No table, except for five or more like items with two or more values each. No emoji.
11. URLs: each URL in full as plain text at the end of its line, with no Markdown link, no short form and no line break.
12. Teach a junior developer: short full sentences in the language rules of the session, with each article and each verb. Give a new term its meaning.

## 2. The outcome

At the end of the work, `REPORT.md` section 5 and `LOG.md` apply with this form. The outcome is a detailed report of the whole work. It is the last report of the turn in which the work ends, and the page entry and its `added:` line belong to it. The `added:` line stands above the outcome only when the entry was added: with `log: off`, there is no `added:` line. The `--summary` of the page entry is the result in 12 words or less, written by you. Add only one entry for one end of the work.

- With no dialog (no simple `Owner decides` action, or no question tool): add the entry, then end the last message with the outcome and its `added:` line.
- With a simple `Owner decides` action in the report at the end of the work: give that report with no `added:` line, then open the dialog of rule 9. Do what the answer allows. Then add the entry for the whole work and the answer, and end the last message with the short report of rule 9, with the `added:` line above it. That short report is the outcome.
- When the owner closes the dialog with no answer: add the entry with the decision as open. Then end with the short report of rule 9, with the `added:` line above it.

````markdown
The new service profile is ready but not live: the owner chose eight slots, and the profile waits for approval.

## Not verified

- The health check of the new profile: it can run only after the change. https://status.example.org/service/health

## Next

- **[A]** Agent, after your answer to B: Change the profile and run the health check.
- **[B]** Owner decides: Approve the new profile, or ask for changes.
````

Then, in the same turn, the agent asks decision B in the question tool:

```text
[B] The new service profile with eight slots is ready but not live. Its health check can run only after the change. Approve it?
  1. Approve the new profile (Recommended)
  2. Ask for changes
```

The owner picks 1. The agent changes the profile and runs the health check. Then it adds the page entry and ends the last message of the turn with the outcome:

````markdown
added: projects/example/DUMMIES | Jan 5, 2026, 3:07 PM EST | Agent: Pi | Model: example/model

The new service profile is live with eight slots: the owner approved it, and its health check passes (3 of 3 probes).

## Next

None. No work is left.
````

## 3. Detailed report syntax 1

This is the chat contract of the detailed form; report readers cite it by this name. A program reads only the last assistant message of the session. In this syntax, a line ends at a line feed, with an optional carriage return before it. The program skips the lines of code fences and the lines that start with `>`, by the rule of `REPORT.md` section 6; the other lines are readable. Each pattern matches one whole readable line; a program removes no space.

```text
heading  ^## \S
next     ^## Next$
action   ^- \*\*\[([A-Z]+)\]\*\* (Agent|Owner decides|Owner)(?:, ([^:]+))?: (\S(?:.*\S)?)$
none     ^None\. \S(?:.*\S)?$
added    ^added: \S
warning  ^\*\*Warning:\*\*
```

- Detection: the readable lines of this syntax select the syntax. A message with a `report` or `outcome` line of syntax 2 is syntax 2, read by `REPORT.md` section 6. A `next` line with a competing line below it, after at most one empty line, makes it ambiguous. A competing line holds no hidden character (next rule) and matches the `action` or `none` pattern. A `## Next` heading over ordinary text leaves it syntax 2. Else a message with a `next` line is detailed. Else the report is missing.
- A detailed message is ambiguous when it has more than one `next` line, or when a readable line holds a hidden character: a control character other than the tab, a format character (Unicode category `Cf`), U+2028 or U+2029. A carriage return that is not before a line feed is such a control character. A detailed message whose last `heading` line is not its `next` line is missing.
- Headline: the first non-empty line, or the next one after an `added` line. A headline that starts with `#` is ambiguous: no result paragraph.
- Next block: the `next` line, at most one empty line, then one or more `action` lines or one `none` line. It ends at the first empty line after its last line, or at the end of the message. The text after it gives no action. An empty line holds nothing or spaces only.
- Ambiguous: a label out of the order of rule 8, an `Agent` action after an `Owner` or `Owner decides` action, an unknown line in the block, or no `action` line and no `none` line.
- A `warning` line anywhere in the message is a warning: before the block, in a part, or after the block, also with a wrong end.
- The form has no items, no state words and no outcome mark.

### Conservative next-prompt selection

The next-prompt reader gives no draft when the report has an `Owner` or `Owner decides` action, an action with a condition, a `warning` line, or an unsafe character from the first paragraph to the end of the Next block. An unsafe character is a hidden character or a tab; the same rule serves syntax 2. Else only the first `Agent` action is eligible: the draft says `Continue action <label>: <action text>`. The syntax 2 rule for `Needs approval`, `Proposal`, `Blocked` and `Retired` items has no equal here: an approval is an `Owner decides` action.
