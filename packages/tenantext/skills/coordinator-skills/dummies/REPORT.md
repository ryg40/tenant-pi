# The dummies report

A coordinator session teaches a junior developer, ends its work with an outcome block, and logs to the project page `DUMMIES`. `D` is the absolute `scripts` directory beside this file.

## 1. State check

Run `python3 D/state.py` first, unless you ran it in this turn. When its output starts with `dummies: off`, stop: use no part of this file.

## 2. Coordinator sessions only

You are a coordinator session when the user talks to you directly and no start prompt gives you a task role. The `role:` part of the state check gives the Herdr role when the pane has one. A task session (a worker, a reviewer, a researcher, a scout, or a session with a result format of its own) stops here: its role sets its result form.

## 3. The report

A turn is one reply to the user. End its last message with one report: a harness can shorten text between tool calls. In Claude Code and Pi, use three box-drawing tables in one fenced block with no language tag:

```
REPORT 2  Key stored, profile updated, workers started

┌───────────┬────────────────────────────────────────────────────────┐
│   Field   │                         Detail                         │
├───────────┼────────────────────────────────────────────────────────┤
│ Goal      │ Store the key and start the agreed plan.               │
├───────────┼────────────────────────────────────────────────────────┤
│ Open      │ Pi needs a new shell to read the key.                  │
├───────────┼────────────────────────────────────────────────────────┤
│ Next      │ I collect the worker results.                          │
├───────────┼────────────────────────────────────────────────────────┤
│ Important │ THE SERVICE NOW HAS 8 SLOTS.                           │
│           │ CLIENTS WAIT UNTIL THE CACHE COPY ENDS.                │
└───────────┴────────────────────────────────────────────────────────┘

What was done:
┌───┬───────────┬────────────────────────────────────────────────────┐
│ # │   Action  │                Resource and result                 │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 1 │ Saved     │ The service key with credsync                      │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 2 │ Edited    │ The profile in three copies                        │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 3 │ Started   │ The service and two workers                        │
└───┴───────────┴────────────────────────────────────────────────────┘

What's next:
┌───┬─────────┬──────────────────────────────────────────────────────┐
│ # │  Owner  │                      Next step                       │
├───┼─────────┼──────────────────────────────────────────────────────┤
│ 1 │ Agent   │ Collect the worker results.                          │
├───┼─────────┼──────────────────────────────────────────────────────┤
│ 2 │ Agent   │ Run checks after both workers finish.                │
└───┴─────────┴──────────────────────────────────────────────────────┘
```

- `REPORT <n>`: the number of the report in this session, then the result in 8 words or less.
- Summary order: `Goal`, `Open`, `Next`, `Important`. `Goal`: what you tried to do or to learn. `Open`: what is not done or not proven, and who must act, or `None.` Put user blockers first within `Open`. `Next`: the immediate next action, matching the first row of `What's next`. `Important`: the most important item for a human reader.
- `What was done`: one numbered row for each completed action. Use past tense in `Action`, up to 9 letters, then the resource and its verified result. Keep attempted work and failed checks explicit; never present planned work as completed.
- `What's next`: 1 to 3 likely next steps in order, with an owner and any condition or approval needed. These are proposals, not authorization. When none remain, use one row: `1`, `None`, `No further steps.`
- Teach a junior developer: short full sentences in Simplified English, with each article and each verb. An action row is a verb and its object. Give a new term its meaning.
- Keep the headers, borders and row separators shown. Center headers; left-align cell text with one space of padding. Wrap inside cells; leave the label, number, action and owner empty on continuation lines.
- All three tables have the same width: target 70 columns, maximum 78, or less to fit the pane. Narrow the detail columns first. Preserve full resource names; split a long path across lines without adding characters.
- Limits: 12 content words per line, 2 lines per label or row, 100 words excluding labels, headers, borders and step numbers. `What was done` has 4 rows or less. Narrow panes may use more lines, not more words.
- One empty line separates the title and the tables. Keep `What was done:` above the second table and `What's next:` above the third.
- Exactly one item of the report is in CAPITAL LETTERS: the `Important` text.

## 4. Grouping

Before a report, apply this test to the turns since your last report. Give no report in this turn when all three are true:

1. The turns are steps of the same process.
2. The turns taught nothing new: a junior developer learns nothing from them that the last report did not say.
3. Your approach did not leave the goal and the plan that you gave at the start.

The next report then covers the series, and its `REPORT` line gives the count of the turns.

Report in the same turn after a failure, a surprise, a change of the plan or of the goal, a decision or a correction of the user, a result that the user must act on, and at the end of the work.

## 5. The end of the work

When the work is complete, read `LOG.md` beside this file before your last message. The work is complete each time a task of the user is done and you give your final answer for it. First add the entry of this session to the page `DUMMIES`, as `LOG.md` says. Then end your last message with the outcome block of `LOG.md`; it replaces the report of that turn. Without `okknow`, the outcome block works; `LOG.md` says what to tell the user.
