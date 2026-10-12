# The dummies report

A coordinator session teaches a junior developer, ends its work with an outcome block, and logs to the project page `DUMMIES`. `D` is the absolute `scripts` directory beside this file.

## 1. State check

Run `python3 D/state.py` first, unless you ran it in this turn. When its output starts with `dummies: off`, stop: use no part of this file.

## 2. Coordinator sessions only

You are a coordinator session when the user talks to you directly and no start prompt gives you a task role. The `role:` part of the state check gives the Herdr role when the pane has one. A task session (a worker, a reviewer, a researcher, a scout, or a session with a result format of its own) stops here: its role sets its result form.

## 3. The report

A turn is one reply to the user. End its last message with one report: a harness can shorten text between tool calls. Use a fenced block with no language tag or Markdown marks:

```
REPORT 2   Key stored, profile at 8 slots, workers run

Important  STRATA RESTARTS WITH 8 SLOTS; NO CLIENT HAS A CACHE
           UNTIL THE COPY ENDS IN ABOUT 5 MINUTES.

Open       Pi must restart its shell to read the new key.
Next       I collect the two worker results and run the checks.

Goal       Store the Strata key and start the settled plan.
Done       1 Save     STRATA_API_KEY with credsync
           2 Edit     the profile in three copies
           3 Start    Strata, the Pi provider, two workers
```

- `REPORT <n>`: the number of the report in this session, then the result in 8 words or less.
- `Important`: the most important item for a human reader. `Open`: what is not done or not proven, and who must act, or `None.` The item that waits for the user comes first. `Next`: your next step. `Goal`: what you tried to do or to learn. `Done`: one numbered row for each action: a verb of 7 letters or less in a column of 9 characters, then the tool, the file or the URL, and what it gave.
- Teach a junior developer: short full sentences in Simplified English, with each article and each verb. A `Done` row is a verb and its object. Give a new term its meaning.
- Limits: 12 words and 78 characters for each line, 2 lines for each label, 75 words for the report without the labels and the step numbers. `Done` has 4 rows or less, each with 1 line. The text starts in column 12, and the text of a `Done` row in column 23. A second line starts below the text of the first line.
- One empty line stands after the first line, after `Important` and after `Next`.
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
