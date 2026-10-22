# Agent instructions

## Agent skills

### Issue tracker

Issues live in the development repository on the issue tracker. The tracker document names the product and the API base. A snapshot clone from GitHub has no issue tracker. See [the issue tracker document](docs/agents/issue-tracker.md).

### Triage labels

`ready-for-agent` means that an agent can take the issue. `needs-approval` means that the owner approves before a worker starts. See [the label table](docs/agents/issue-tracker.md#labels).

### Domain docs

One glossary for the repository. See [the glossary](GLOSSARY.md).

The kit has no `.okf/` bundle. The tag `kit-legacy/20261021` keeps the old frozen record.

## Local session files

Terms: the coordinator is the agent session that talks to the owner; a worker is an agent session started for one task; a pane is the terminal window of a session; a worktree is a second checkout of the repository; the main checkout is the clone that holds `.git`.

The directory `.local/` of the main checkout holds the files of agent sessions. `.gitignore` lists it. An agent never commits it. An agent moves or deletes nothing in it, except on the owner's word `archive` and in the `.agentwork/` conversion. A removed worktree loses its ignored files, so session files live in the main checkout, not in a worktree.

A coordinator session has one mode. The coordinator infers the mode from the first request and states it in its first report. The owner corrects it.

- Operational: running the tools, a release, a host change or a question. The files go to `.local/ops/<YYYYMMDD-slug>/`. A change to the repository uses a worktree outside the repository on a `topic/ops-<slug>` branch.
- Development: a ticket, a feature or a fix to the project itself. The session works on a `topic/<slug>` branch in a worktree outside the repository. The files go to `.local/<branch-slug>/`, for example `.local/topic-example/`. `<branch-slug>` is the branch name with `/` replaced by `-`.

A change of mode means a handoff to a fresh coordinator.

Each session folder starts with `NOTES.md`: the mode, the integration branch, the start date and the goal. The coordinator appends the pane names, the path of each worktree and the handoff text later. Each pane writes to `<session folder>/<pane-name>/`, and the task file names that absolute path.

Promotion is never automatic. On the owner's word `promote <file>`, a worker copies the file to a tracked path on the topic branch. The worker rewrites the copy for public readers. The review checks the copy. On the owner's word `archive`, a worker moves the folders that the owner names to `.local/archive/`. Older session files may sit in other `.local/` folders; leave them.

A repository that keeps session files in `.agentwork/` gets them moved to `.local/agentwork-legacy/`; the coordinator role gives the steps.

The integration branch is the value of `git config kit.integration`. Unless the clone sets it, the integration branch is `main`. The full rule is in [the coordinator role](packages/tenantext/skills/herdr/roles/coordinator.md).
