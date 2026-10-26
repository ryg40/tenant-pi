# The end of the work, and the log page DUMMIES

`D` is the absolute `scripts` directory beside this file.

## The outcome report

When the work is complete, end your last message with one outcome report. It replaces the report of that turn. Claude Code and Pi use the compact form of `REPORT.md` section 3, in compact report syntax 2 of `REPORT.md` section 6. Give the `added:` line of the page entry above it. With `log: off` in the output of `state.py`, there is no page entry and no `added:` line; the outcome report stays.

```markdown
**OUTCOME** The plan is settled; live changes wait for approval

- **[1]** Done: The two routes of the service had one shared timeout.
- **[2]** Done: The owner chose eight slots in the question tool.
- **[3]** Needs approval: The new service profile is ready, but it is not live.
- **[4]** Unverified: The health check of the new profile did not run. https://status.example.org/service/health
- **[5]** Done: The session entry is on the page DUMMIES.

**Warning:** Clients wait while the cache copy runs after the change.

**Next:**
- **[a]** Owner decides: Approve the new profile, or ask for changes.
- **[b]** Agent, after the owner approves the new profile: Change the profile and run the health check.

Tell the users of the service about the wait before the change.
```

- `OUTCOME`: the result at the end of the session, in 12 words or less. It is also the `--summary` text of the page entry.
- Items: include the subjects of the session with their final states. Restart item numbers at `1` and independent next-action labels at `a`, as `REPORT.md` says. Neither sequence has a count cap.
- Each item names its real resources (a repository, an endpoint, an external tool, a URL) and the most important fact about them.
- `**Warning:**`, `**Next:**`, the prose after the block and the URL rules are as in the report. Use no table at the end of the work.

## The log page

The page `DUMMIES` is the human session log of a project: one entry for each session, the newest first. It is the page `projects/<project>/DUMMIES` of OpenKnowledge. The script `page.py` reads and writes it through the `okknow` command only. `<project>` is the name of the repository directory; `--project <slug>` names another project. Outside a Git repository, `--project <slug>` is necessary.

The page keeps its own schema: the four labels and the Markdown tables below. Compact report syntax 2 is the chat contract only. It does not apply to the page, and a program that reads a report never reads the page.

## Add the entry of this session

Skip this section when the output of `state.py` shows `log: off`. The user sets the switch with `python3 D/state.py log on|off`.

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

- The entry is the outcome report in the schema of the page. The four label lines are necessary, in this order and form: `Important`, `Open`, `Next`, `Goal`. Write them for a junior developer, as in the report. The page has no line limit: a sentence can be longer than in the chat.
- Map the outcome report to the labels. `Important`: the main warning or the most important item, in CAPITAL LETTERS. `Open`: the items that are not `Done` and not `Retired`, each with its state word, and the later actions of `**Next:**`. `Next`: the recommended next action, or `None.` and its reason. `Goal`: the goal at the start of the session. `#### Done`: the `Done` items, compressed to five rows.
- Write each subject in words. Report numbers and action labels are local to one report, so a label alone in the page names nothing.
- Keep a source change, a push, a build and a deployment apart. Name the commit identifiers, the endpoints and the checks with their results.
- Write no credential. Name the place of a secret, not its value.
- The script refuses a line that has the form of a credential, but this is a first guard only: you write no credential, also in a form that the script does not find.
- A routine session needs only the four labels. Add the two tables for work of more than one step. A heading in the body has four `#`.
- An older entry can have the labels of the old form: `Goal`, `Executed`, `Relevance`, `Effects` and `Next`. It stays as it is, and `check` accepts it.
- The first task of a session that ends gets its entry with the command above. In a long session, each later task that ends gets a new entry: the same command with `--again`.

| Exit | Meaning | What to do |
| --- | --- | --- |
| 0 | A line `added: ...` | Give the user that line. |
| 0 | The line `log: off, no entry` | The user turned the page log off. Give no `added:` line. |
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
