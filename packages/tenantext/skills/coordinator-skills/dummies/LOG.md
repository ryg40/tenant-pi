# The end of the work, and the log page DUMMIES

`D` is the absolute `scripts` directory beside this file.

## The outcome block

When the work is complete, end your last message with one outcome block. It replaces the report of that turn. Use the three box-drawing tables of `REPORT.md` in Claude Code and Pi, with the same labels in the same order.

```
OUTCOME  The plan is settled. Nothing is changed live.

┌───────────┬────────────────────────────────────────────────────────┐
│   Field   │                         Detail                         │
├───────────┼────────────────────────────────────────────────────────┤
│ Goal      │ Settle the service plan with the owner.                │
├───────────┼────────────────────────────────────────────────────────┤
│ Open      │ The owner must approve the plan.                       │
├───────────┼────────────────────────────────────────────────────────┤
│ Next      │ The owner reviews the plan.                            │
├───────────┼────────────────────────────────────────────────────────┤
│ Important │ THE PLAN IS READY; LIVE CHANGES STILL NEED APPROVAL.   │
└───────────┴────────────────────────────────────────────────────────┘

What was done:
┌───┬───────────┬────────────────────────────────────────────────────┐
│ # │   Action  │                Resource and result                 │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 1 │ Read      │ config.yaml                                        │
│   │           │ Two routes shared the same timeout.                │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 2 │ Checked   │ models.json                                        │
│   │           │ The provider had the expected context limit.       │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 3 │ Read      │ The service profile                                │
│   │           │ Four slots served concurrent requests.             │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 4 │ Decided   │ The question tool                                  │
│   │           │ The owner selected eight slots.                    │
├───┼───────────┼────────────────────────────────────────────────────┤
│ 5 │ Recorded  │ The project DUMMIES page                           │
│   │           │ The session entry held the plan.                   │
└───┴───────────┴────────────────────────────────────────────────────┘

What's next:
┌───┬─────────┬──────────────────────────────────────────────────────┐
│ # │  Owner  │                      Next step                       │
├───┼─────────┼──────────────────────────────────────────────────────┤
│ 1 │ Owner   │ Review the plan and approve or request changes.      │
├───┼─────────┼──────────────────────────────────────────────────────┤
│ 2 │ Agent   │ If approved, change the service profile.             │
├───┼─────────┼──────────────────────────────────────────────────────┤
│ 3 │ Agent   │ After the change, check the service health.          │
└───┴─────────┴──────────────────────────────────────────────────────┘
```

- `OUTCOME` is the result at the end of the session, in 12 words or less. It is also the `--summary` text of the page entry.
- `Important`, `Open` and `Next` have the meaning that they have in the report. `Goal` is the goal at the start of the session.
- `What was done` has the high-level completed actions in past tense. Compress them to exactly five rows. Each row names its real resources (a repository, an endpoint, an external tool, a URL) and the most important item that you found there.
- An action row has 2 lines or less. Break after the resource name or at a comma. Follow the report's padding, continuation and width rules.
- `What's next` follows the report's owner, condition and no-further-steps rules. Keep likely future work separate from completed actions.
- Limits: 12 content words per line, 3 lines per summary label, 180 words excluding labels, headers, borders and step numbers. Narrow panes may use more lines, not more words.
- One item of the block is in CAPITAL LETTERS: the `Important` text. The block is a fenced block with no language tag, as the report.

## The log page

The page `DUMMIES` is the human session log of a project: one entry for each session, the newest first. It is the page `projects/<project>/DUMMIES` of OpenKnowledge. The script `page.py` reads and writes it through the `okknow` command only. `<project>` is the name of the repository directory; `--project <slug>` names another project. Outside a Git repository, `--project <slug>` is necessary.

## Add the entry of this session

Write only the body. The script makes the entry heading, `### <Mon D, YYYY, H:MM AM|PM> <zone> | Agent: <agent> | Model: <model> | <summary>`, with the time in the zone of the page and the model of the session data. It adds the entry directly below the entries heading, reads the page back and proves that each older entry is unchanged.

````sh
python3 D/page.py add --summary "<the OUTCOME line: the result in 12 words or less>" <<'EOF'
**Important:** <ONE ITEM IN CAPITAL LETTERS>
**Open:** <what is not done or not proven, and who must act>
**Next:** <the next step>
**Goal:** <the goal of the session>

#### Done

| # | Step | Resource and result |
| --- | --- | --- |
| 1 | <verb> | <the resource and what it gave> |
| 2 | <verb> | <the resource and what it gave> |
| 3 | <verb> | <the resource and what it gave> |
| 4 | <verb> | <the resource and what it gave> |
| 5 | <verb> | <the resource and what it gave> |

#### State at completion

| Item | Result |
| --- | --- |
| Source | <branch, commit, pushed or not pushed> |
| Checks | <command and result> |
EOF
````

- The entry is the outcome block in the syntax of the page. Box-drawing borders belong only in the chat output; keep the Markdown labels and tables shown in the entry template. The stored label order remains `Important`, `Open`, `Next`, `Goal`. Map `What was done` to `#### Done`; summarize `What's next` in `**Next:**`. The four label lines are necessary, in this order and form. Write them for a junior developer, as in the report. The page has no line limit: a sentence can be longer than in the block.
- Keep a source change, a push, a build and a deployment apart. Name the commit identifiers, the endpoints and the checks with their results.
- Write no credential. Name the place of a secret, not its value.
- The script refuses a line that has the form of a credential, but this is a first guard only: you write no credential, also in a form that the script does not find.
- A routine session needs only the four labels. Add the two tables for work of more than one step. A heading in the body has four `#`.
- An older entry can have the labels of the old form: `Goal`, `Executed`, `Relevance`, `Effects` and `Next`. It stays as it is, and `check` accepts it.
- The first task of a session that ends gets its entry with the command above. In a long session, each later task that ends gets a new entry: the same command with `--again`.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | A line `added: ...` | Give the user that line. |
| 0 | The line ends with `new entries of other writers: <n>` | Another session added `<n>` entries between the read and the write of the script. Read the page. Change nothing. |
| 2 | The body or an argument is refused | Correct what the message names. Run the command again. When a line is refused as a credential and holds none, write it in other words. |
| 3 | The `okknow` command failed | Give the user the message. Do not write the page in another way. |
| 4 | No `okknow` command | Tell the user that no knowledge base is present. Write a log file only when the user names its path: then add `--file <path>` to each command. Never choose a path in a repository yourself: an untracked file can fail a check of the repository. |
| 5 | This session has an entry | Stop. Earlier entries stay as they are. For a correction, or for later work of the same session, add a new entry with `--again`. The summary of a correction starts with `Correction:`. |
| 7 | A new page needs a zone | Ask the user one time for the zone. Then run `python3 D/page.py init --zone "<label> (UTC+HH:MM)"`, for example `"UTC (UTC+00:00)"`. With no answer, use `--zone UTC`. Then run `add` again. |
| 8 | The page does not follow the contract | Run `python3 D/page.py check`. Give the user the findings. Do not repair the page without the user. |
| 9 | The write is not proven | Give the user the message. Read the page. Do not write again. |

`add` creates the page when it is absent. A new page takes the zone of another `DUMMIES` page of the knowledge base, and the `handoffs` page of the project gets one pointer line when that page exists. When the script cannot read the session data, add `--harness <pi|claude>`, `--model <identifier>` and `--session <id>`. Never guess the model behind an alias: with no identifier the script writes `unknown`. The session is different: with no session identifier, `add` stops with exit 2. When your harness has no identifier, make one new unique text for this session and give it as `--session <id>` in each `add` of the session.

## Log summary

When the user asks where the project stands:

```sh
python3 D/page.py recent
```

Give the log summary in eight lines or less: where things stand, what was done and when, and what is open. Say that the page gives the last checked state. Before you act on a fact that can change (a branch, a deployment, a service), check it at its source. Exit 6 means that the project has no `DUMMIES` page.
