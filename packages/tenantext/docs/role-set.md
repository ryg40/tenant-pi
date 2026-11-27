# Role set (`herdr-role-set`)

A role set gives each role of a Herdr space one harness, one model and one thinking level. The roles are the coordinator, the researcher (it also covers the scout), the worker and the reviewer. The helper `herdr-role-set` of the `herdr` skill starts the agents of a role set. The kit installer links it at `~/.local/bin/herdr-role-set`. This page is for people. The full rules for agents are in [`SPAWN.md`, section "Role set launch"](../skills/herdr/SPAWN.md#role-set-launch-herdr-role-set).

![The sidebar of the Herdr app with three example spaces. The space example-app has the buttons Set and Start and the line "Start: coordinator at 48K, hand off to claude/fable medium". The window Role models below shows four role cards: Coordinator claude/fable medium, Researcher / Scout claude/sonnet high, Worker agy/neon high, Reviewer codex/sol medium.](images/role-set-example-spaces.png)

The picture is from the Herdr app, with example spaces. The Herdr app is a separate project. The kit gives only the helper that the app runs, so this page describes the helper and not the app.

## The parts in the picture

- The row of a space has the buttons Set and Start. The Start button of the Herdr app runs `herdr-role-set` on the computer of the space.
- The window "Role models" shows one card for each role, with the model key and the thinking level. Its legend names Claude, Codex, agy, Copilot and Any.
- The line under the row tells what Start will do. It has the form of the `preview` field of `herdr-role-set --dry-run`, for example `Start: launch 2 empty terminals; coordinator at 48K, no handoff`.

## What Start does

Start runs `herdr-role-set --set '<json>'`. The JSON names the space and the model and thinking level of each role. The helper does two things:

1. It starts the agent of each role in the empty terminals of the role tabs. A terminal counts as empty only when it is live, runs a known shell and runs no agent. Terminals that already run an agent, or that are outside a role tab, stay as they are.
2. It sends the coordinator the handoff command when the coordinator holds more than 200000 tokens of context. The new coordinator then has the harness, model and thinking level of the set. The command also carries the choices of the researcher, worker and reviewer as one `roles=` argument; `handoff.py` writes them into the handoff file, and the new coordinator starts the panes of these roles with them. With unknown tokens, the helper sends no handoff. A coordinator choice on the `agy` harness hands off to a new `agy` coordinator. The helper sends no handoff command to a live coordinator that runs `agy`, because `agy` has no slash command; that coordinator can still run `handoff.py` itself. The reason line appears only with a known token count above the limit. The helper starts the handoff send in a background terminal of herdr-core and ends at once, so Start does not wait while the coordinator terminal holds a typed draft. A background terminal is needed because `hc exec` ends each process that the helper starts. The handoff line has `pending` and `result`: the terminal writes the outcome of the send to that file. When the background terminal does not start, the helper sends in the run itself. When the helper sends no handoff, it sends the live coordinator one line with the choices of the researcher, worker and reviewer instead, at its prompt. A second Start with the same choices for the same coordinator session sends that line no second time.

An `agy` pane also gets the first message of `spawn.py`, which names its role prompt file. Its launch line tells whether the message was sent.

## The model keys

| Provider | Keys | Thinking levels |
| --- | --- | --- |
| Claude | `claude/<alias>`, for example `claude/fable` | `low` to `max` |
| Codex | `codex/<name>`, for example `codex/sol` | `minimal` to `max` |
| agy | `agy/neon` | `low` to `max` |
| Copilot | `copilot/<id>`, from the Copilot models that Pi of the machine lists | `minimal` to `max` |

Each role takes only the keys of its list in `scripts/role_set.py` (`ROLE_MODELS`) and the Copilot keys of the machine. `herdr-role-set --models` prints the Copilot models of the machine. It starts no pane and writes no file. A machine gets these models after `/login` for GitHub Copilot in Pi with the kit profile.

## Set coordinator

The menu item "Set coordinator" of a tab runs `herdr-role-set --coordinator <space> <tab>`. It makes the tab the coordinator tab of its space:

- The newest terminal of the tab that runs an agent becomes the coordinator pane. It gets the label `skill.role=coordinator` and the coordinator record.
- Each other coordinator pane of the space loses that label and record.
- A terminal with a task role (worker, reviewer, researcher or scout) never changes. A plain shell never becomes the coordinator.
- With no agent in the tab, nothing changes. A second run also changes nothing.

## Where the choices are kept

The helper stores no role set. The Herdr app gives the choices of the space to the helper with each Start, in the `--set` JSON. The skill also stores no coordinator tab: the coordinator tab is the tab of the terminal with the coordinator role.

## Limits

- Delivery is best effort. The person presses Start and watches the terminals.
- The checks before each send lower the risk of acting on a busy or changed terminal, but they are no proof. For example, the helper cannot see a shell that waits in a builtin such as `read`, or a change after its last read.
- herdr-core checks no prompt readiness, no session identity and no `done` state when it delivers the text.
- Each send waits at most 90 seconds, and a whole run at most 10 minutes. After a timeout the outcome is unknown, and the helper never sends again. Look at the terminal before the next Start.
- A coordinator in the middle of a turn gets no handoff: wait for the end of the turn and press Start again.
- herdr-core holds a send for up to 60 seconds after the last key that a person types in the terminal.
