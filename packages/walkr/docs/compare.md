# Compare

Compare shows 2 or 3 options of one change side by side. You pick one, comment and rate the session.
The agent prepares the options. Compare keeps every session, so you can step through earlier sessions later.

Compare is local-only. It needs no Pi chat and no server that you start: `walkr-compare` starts the background Walkr server, as `walkr-core` does.
In this guide, "you" are the person who picks, and "the agent" is the coding agent that prepares the options.

## Two workflows

Each workflow is a request that you type to the agent. The `walkr-compare` skill holds the steps.

| You type | The agent shows | `workflow` |
| --- | --- | --- |
| `walkr compare cfn options` | 2 or 3 options of a CloudFormation change: summary, resource table, template difference | `cfn-options` |
| `walkr compare cfn + architecture diagram` | The same, with an architecture diagram at the top of each option | `cfn-architecture` |
| `walkr simplify ticket` | Three versions of a short text, such as a ticket update or an email, with the original folded above them | `text-revision` |

In Claude Code, type `/walkr compare cfn options`. In Pi, the `/walkr` prompt alias does the same.

The agent asks before it starts. It uses its question tool: `AskUserQuestion` in Claude Code, `ask_user_question` in Pi.
It asks what you want from the session, how the options must differ, and the limits of the change.
Your answers are saved with the session.

A code change with no visual output works for other code too. The agent then uses a `workflow` name of the form `<kind>-options`.

## The page

There is one page for all sessions. It has no mode menu.
The private URL belongs to one server run. A page that is open shows a new session without a new URL.

| Part | Content |
| --- | --- |
| Bar | The theme-coloured `walkr` wordmark, Sessions, the session type, title and state, Newer, Older, Type, View, Show all and the theme |
| Session list | Every saved session, the newest first: type, title, time, your pick and the stars. A session shows New until you open it. |
| Stage | The options in their original order. Side by side adds Fold left, Fold right and Solo to each option head. |
| Folded rail | A narrow button in the option's place, with its label and pick mark. Select it to open that option again. |
| Show all | Opens all folded options. This control appears in the bar only when Side by side has a folded option. |
| Decision line | Your pick, No option fits, the note, Submit result, and the rating |

- Sessions opens and closes the list. A closed list gives the stage the full width.
- Type shows only the sessions of one type in the list.
- View changes the display: Side by side, or One option (with one tab for each option).
- Fold left and Fold right close one column into a rail with its label facing that direction. Open columns share the free width.
- Solo opens the chosen option and folds its neighbours in place. Show all restores equal columns.
- Folding changes only the layout. Frames, zoom, comments, your pick and rating stay. A newly selected session starts unfolded.
- On a narrow screen, options stack vertically only when none is folded. With folds, the rails and open options share one row.
- A text session has a folded box with the original text above the options. Open it to compare. Each version shows as clean text.
  The browser saves the view for each type.
- Newer and Older step through the list.
- Brief, answers and original shows the request, your answers before the start, the original text and the outcome of the agent.

### Formats

| Option format | Display |
| --- | --- |
| `html` | A sandboxed frame. It runs no script and loads nothing from a network. Inline styles, inline SVG and `data:` images show. Each frame has a zoom control. |
| `text` | Plain text |
| `markdown` | Plain text. Markdown source shows as it is, never as live HTML. |

Zoom changes only the display. The levels are 25%, 33%, 50%, 67%, 75% and 100%.

## Pick, comment and submit

1. Select Pick this option under one option. Select it again to clear the pick.
2. Write a comment under each option when you have one. Comments are optional.
3. When no option fits, select No option fits and write a note that says what is missing.
4. Select Submit result. The first submitted result is final. There is no edit after Submit.

The agent gets the pick, the comments and the note. It then does what you asked for at the start, and saves a short outcome.
A pick does not authorize a deployment, a sent mail or a posted ticket comment.

## Rate a session

Select a star or a half star, write an optional rating note, and select Save rating.
You can rate at each time, also from the session list weeks later. A later rating replaces the shown one. Each rating stays in the record.

| Stars | Saved value |
| --- | --- |
| Half a star | 1 |
| 3.5 stars | 7 |
| 5 stars | 10 |

The record saves a whole number from 1 to 10: one point for each half star.
With the keyboard, the arrow keys change the rating by half a star.

The agent reads the ratings and notes of earlier sessions of the same type before a new session. A low rating with a note tells it what to avoid.

## Agent commands

Sheprd is a separate tool that receives Walkr page URLs; the kit neither installs nor requires it.

```sh
walkr-compare create /absolute/request.json
walkr-compare open [<session-id>]
walkr-compare list
walkr-compare view <session-id>
walkr-compare wait <session-id> [--timeout <seconds>]
walkr-compare outcome <session-id> /absolute/outcome.json     # { actionId, summary }
walkr-compare close                                          # optional Sheprd link only
```

`walkr compare ...` runs the same commands.
`create` prints `{ sessionId, replay, status, url }`, and `sheprd` only when the [Sheprd link](#sheprd-link-optional) is on. `open` prints the page URL of this server run.
`wait` polls each 500 ms until the result or the timeout (default 240 seconds, maximum 3600). It prints `{ status: "ready", result, rating }` or `{ status: "timeout" }`.
No command opens a browser.

### Create request

```json
{
  "actionId": "compare-dlq-1",
  "workflow": "cfn-options",
  "title": "Add a dead-letter queue to the order stack",
  "brief": "Compare ways to add a dead-letter queue.",
  "clarifications": [{ "question": "How must the options differ?", "answer": "By cost" }],
  "repo": { "name": "my-app", "revision": "3bc9b6c" },
  "source": { "label": "Current text", "format": "text", "content": "The original text of a text revision." },
  "options": [
    { "optionId": "a", "label": "A: queue only", "summary": "+1 resource", "format": "html", "content": "<!doctype html>..." },
    { "optionId": "b", "label": "B: queue and alarm", "summary": "+2 resources", "format": "html", "content": "<!doctype html>..." }
  ]
}
```

`clarifications`, `repo`, `source` and `summary` are optional. Unknown fields are refused.

Limits: 2 or 3 options, 1 MiB for each option content, 8 MiB for each request, at most 12 clarifications.
`workflow` uses 1 to 64 lowercase letters, digits or hyphens. `optionId` uses 1 to 64 letters, digits, dots, underscores or hyphens.
Two options with the same content are refused. The source is `text` or `markdown`.

## Sheprd link (optional)

The link asks Sheprd to show the Compare page. It is off by default.
Not verified: Sheprd shows the page in its Walkr section beside the agent's pane.
Without it, each command prints and does what this guide describes, and no `sheprd` process starts.

To turn it on, put `export WALKR_SHEPRD_CONNECT=1` in the shell or the profile that starts Pi or Claude Code.
The link works only when all three conditions hold:

1. `WALKR_SHEPRD_CONNECT` is exactly `1`.
2. The agent runs in a Herdr pane: `HERDR_ENV` is exactly `1`.
3. A `sheprd` file is on the `PATH`. Walkr skips a relative or empty `PATH` entry, because it depends on the current directory, which can be a checkout under review.

Not verified: the agent and Sheprd must run on the same computer.
Not verified: Sheprd's SSH shim answers `walkr connect` with exit 8.

With the link on, `create` and `open` run `sheprd walkr connect - --show` after they have the page URL.
The URL goes to `sheprd` on standard input, never as an argument, because it holds the page secret.
`create` adds `"sheprd": "connected"` or `"sheprd": "failed"` to its JSON. `open` prints only the URL.
`"connected"` means the command exited with code 0. Walkr reports `"failed"` for any other exit code.
Walkr does not check whether Sheprd shows the page.
`walkr-core FILE` also sends Sheprd the URL. Core opens no system browser when `sheprd walkr connect` exits with code 0.
A `sheprd` that fails or does not end within 5 seconds never fails the Walkr command. The command then goes on as without the link.
Not verified: Sheprd accepts only loopback URLs and refuses addresses from `HUMAN_REVIEW_ALLOWED_HOSTS`.

`walkr-compare close` runs `sheprd walkr disconnect` and nothing else. It starts no server and prints `{ "sheprd": "disconnected" }`, `{ "sheprd": "failed" }` or `{ "sheprd": null }` when the link is off.
This requests a disconnect; Walkr does not check what happens to the page.
Not verified: Sheprd keeps the page open for a rating after disconnect.
Not verified: the page closes when the owner selects Close in Sheprd, or after 2 hours idle.
While the Compare page keeps making requests, it keeps the Walkr server alive past the default 45 idle minutes.

## Data contract

One record for each session: `<root>/sessions/<session-id>/session.json`.
The record is JSON with `schema: "walkr-compare-session"`, `version: 1`, and a `checksum` of the rest of the record.

| Field | Content |
| --- | --- |
| `sessionId`, `createdAt`, `updatedAt`, `revision` | Session identity, ISO times, and a counter that increases with each commit |
| `status` | `open` or `submitted` |
| `workflow`, `title`, `brief`, `clarifications`, `repo`, `source` | As supplied in the create request |
| `options` | `{ optionId, label, summary?, format, content, contentSha256 }` in submitted order. Content is stored exactly. |
| `seenAt` | The time of your first look at the session in the page. Without it, the list shows New. |
| `result` | `{ pick, comments, note?, submittedAt }` with its action ID. `pick` is an `optionId` or `null`. |
| `outcome` | `{ summary, at }` from the agent, with its action ID |
| `ratings` | Every saved rating: `{ value, note?, at }` with its action ID. The last one is the shown rating. |

### Storage path rules

- Default root: `~/.local/.walkr/compare`. `HUMAN_REVIEW_COMPARE_ROOT` overrides it. Tests and trials use a disposable directory.
- The root must be a canonical absolute path. Missing root directories are created with mode 0700.
  The root must belong to the current user and must not be group or world writable.
- The root, its ancestors, the `sessions` directory and each session directory must not be symlinks.
  Directories need mode 0700. Records need mode 0600 and one hard link.
- Session IDs are `YYYYMMDDTHHMMSSZ-<12 hex>`, so the list order is the time order.
- Writes go to a temporary file in the session directory, then `fsync`, `rename`, and a directory `fsync`.
- Records are never deleted. A session directory without a record is an interrupted create; it is kept.

### Idempotency and recovery

- Each mutation carries an `actionId`. The same action and request returns the first result. The same action with another request returns `ACTION_CONFLICT`.
- A second Submit for a submitted session, from any action, returns `outcome: "already-submitted"` with the first result.
- `COMMIT_UNCERTAIN`, network loss, or an unreadable answer leave a request unresolved.
  The page keeps it in browser storage and offers a retry of the same request. Reload never sends it automatically.
- A server restart keeps every session. After a restart, `walkr-compare open` prints the new page URL.

## HTTP interface

All routes sit under `/_walkr/compare/` and refuse query strings. The Host must be loopback or an exact `HUMAN_REVIEW_ALLOWED_HOSTS` entry. Hosted mode refuses all of them.

| Route | Credential | Purpose |
| --- | --- | --- |
| `GET api/capabilities` | Agent | `{ compare: 1, rootId }` |
| `GET api/page` | Agent | The private page path of this server run |
| `POST api/sessions` | Agent | Create a session; returns the page path with the session ID as the fragment |
| `GET api/sessions` | Agent or page | The session list, oldest first |
| `GET api/sessions/<id>` | Agent or page | One record |
| `POST api/sessions/<id>/seen` | Page only | `{}`; saves the first look |
| `POST api/sessions/<id>/submit` | Page only | `{ actionId, pick, comments?, note? }` |
| `POST api/sessions/<id>/rate` | Page only | `{ actionId, rating, note? }`; `rating` is a whole number from 1 to 10 |
| `POST api/sessions/<id>/outcome` | Agent | `{ actionId, summary }`; only after a submitted result, once |
| `GET g/<capability>` | None (capability URL) | The page |
| `GET o/<capability>/<id>/<optionId>` | None (capability URL) | The document of one HTML option, for its frame |

The agent credential cannot submit, rate or mark a session as seen.
The agent relays the page URL to you, so it can reach the page credential.
This split guards against mistakes, not against a hostile or steered agent. Option content is untrusted and can try to steer the agent.

An HTML option gets the policy `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox`.
The frame has an opaque origin, runs no script, sends no form and cannot read the page or another option.

## Tests

`test/compare.test.js` uses real authenticated HTTP servers, disposable roots, jsdom for the page module, and the spawned command with its background server.
It covers the exact option bytes, one final result, a restart, a changed record, the rating limits and replacement, the New mark,
refused create requests, the frame policy, hosted refusal, and the page with its list, selectors, pick, rating and steps.

## Limits

- The agent can reach the page credential through the URL that it relays.
- One page credential reads and rates every session of the root. There is no per-session page.
- One server process owns a root. Two servers on the same root are not supported; the record check refuses outside changes but is not a lock.
- A result is final after Submit. There is no edit and no second round in the same session. A new round is a new session.
- Rendering of a template or a diagram is the work of the agent. Walkr does not parse CloudFormation and does not check that a diagram matches its template.
- The Core, Double, Coinflip and Trainer pages keep their mode bar. Their sessions are not in the Compare list and have no rating.
- The background server stops after the idle time of `HUMAN_REVIEW_IDLE_MS` (default 45 minutes) when no page is open. A `/health` check does not count as use. The server also stops when its state directory or its `server-entry.js` file is deleted. The page URL then changes.
- The server listens on `127.0.0.1` only. To open the page from another computer, start the server with `HUMAN_REVIEW_BIND=0.0.0.0` and `HUMAN_REVIEW_PORT`, and name the address in `HUMAN_REVIEW_ALLOWED_HOSTS`, for example `desk.example:4802`. `walkr-compare` then prints the URL with that address. The named address opens the Compare page only. Core and other non-Compare routes require a loopback Host and a loopback connection peer, including IPv6 and IPv4-mapped loopback. A remote peer with a forged loopback Host still reaches only the Compare routes and their theme files. The traffic is plain HTTP, and only the secret in the URL protects the page.
- To read the results of more than one computer on one persistent page, use the optional [Compare mirror](../mirror/README.md). It is read-only, and no install step starts it.
- `walkr-compare` and `walkr-core` stop a server of an older Walkr version that still runs for the same state directory, then start a new one. A record without a protocol counts as older. They stop it only when its `/health` answer has the pid of `server.json`. When the stop fails, the command says so; stop the server by hand, then run the command again. They never stop a server of a newer Walkr version: the command fails and starts no server. Use that newer version, or set another `HUMAN_REVIEW_STATE_DIR`.
- Not verified: accessibility with assistive technology, and option quality from a real model.
