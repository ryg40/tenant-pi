---
name: artifacts
description: Store an HTML or Markdown file on the artifact server of the user with the `artifacts` CLI and give the user the view link. Use when the user asks for a link to a report, a mockup, a handoff or another page, asks to list or open the stored artifacts, or types `/artifacts start`, `/artifacts off` or `/artifacts status`.
---

# artifacts

The `artifacts` CLI talks to the one artifact server that the user chose with `artifacts setup`. The token stays in the token file of the user; the CLI reads it by itself.

## Commands

| Command | What it does |
|---|---|
| `artifacts upload FILE [--title TEXT]` | Scans the file for secrets, uploads it and prints `slug:`, `view:` and `expires:`. Only `.html`, `.htm`, `.md` and `.markdown`, up to 10 MiB. |
| `artifacts list` | One line for each stored artifact: slug, title, expiry. |
| `artifacts open [SLUG]` | Prints the URL of the browse page or of one artifact. In a Herdr pane with Sheprd, Sheprd shows the page. |
| `artifacts doctor` | The origin, the server health and the state of the token file. The last line is `doctor: PASS` or `doctor: FAIL`. |
| `artifacts start` | Starts the local server of the configured clone on `127.0.0.1`, or finds the one that runs. The last line is the URL of the browse page. |
| `artifacts off` | Stops each local server of this user that runs the configured clone. `stop` is the same command. The last line gives the count. |
| `artifacts status` | `state:` (`running`, `stopped`, `remote`, `unreachable` or `unconfigured`), `health:` and `url:`. |

## The /artifacts command

`/artifacts start`, `/artifacts off` and `/artifacts status` run the CLI command of the same word: in Pi through the prompt `artifacts`, in Claude Code through this skill.

1. Run `artifacts <word>` with the word of the user: `start`, `off`, `stop` or `status`. With no word, run `artifacts status`.
2. Show the output lines to the user. After `start`, give the URL of the last line in your reply.

A local server needs `artifacts setup --clone PATH [--port N]` once. A refusal of `start` names its reason, for example "run npm ci in the clone": give that reason to the user and run no fix of your own.

## Upload a file

1. Write the page to a file with one of the four extensions. The file holds only content that the user may see on that server.
2. Run `artifacts upload FILE --title "<short title>"`. Exit 0 means the upload is done.
3. Give the `view:` link and the expiry date to the user, in your reply only.

The view link is confidential: each holder of the link can read the page. Put it only in your reply to the user, never in a commit, an issue, a log or a shared file.

To show a page, run `artifacts open SLUG` and give the user the printed URL. The CLI is the only way to show a page: start no local browser.

## Exit codes

- 4: no configuration. Ask the user to run `artifacts setup`.
- 5: the secret scanner found a secret or a policy finding. Remove it from the file, then upload again. Never upload around the scan.
- 3: the server did not answer, refused, or sent a redirect. Run `artifacts doctor` and report its lines.
- 2: a refused input, for example a wrong extension or an unreadable token file.
