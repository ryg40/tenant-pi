---
name: artifacts
description: Store an HTML or Markdown file in the local artifact store with the `artifacts` CLI and give the user the view link. Use when the user asks for a link to a report, a mockup, a handoff or another page, or asks to list, open or delete the stored artifacts.
---

# artifacts

The `artifacts` CLI stores a page in the artifact store of this computer and prints its view link. The local artifacts server shows the stored pages on its page `/artifacts`. Its root page `/` links to `/artifacts` and to the Walkr page `/walkr`. The user starts and stops the server with `/artifacts-server start`, `/artifacts-server off` and `/artifacts-server status`. When the user asks for this in words, run `artifacts start`, `artifacts off` or `artifacts status` yourself. `artifacts off` stops only this server and no Walkr review.

## Commands

| Command | What it does |
|---|---|
| `artifacts upload FILE [--title TEXT] [--repo NAME]` | Scans the file for secrets, stores it and prints `slug:`, `view:` and `expires:`. Only `.html`, `.htm`, `.md` and `.markdown`, UTF-8, up to 10 MiB. Without `--repo`, the repo is the repository of the working directory. |
| `artifacts upload FILE --replace SLUG` | Stores a new version under the slug of an earlier upload, so the link stays. The title and the repo stay unless `--title` or `--repo` gives a new one. |
| `artifacts list` | One line for each stored artifact, newest first: slug, title, expiry. |
| `artifacts open [SLUG]` | Prints the URL of the index page or of the viewer page of one artifact. In a Herdr pane with Sheprd, Sheprd shows the page. |
| `artifacts delete SLUG [SLUG ...]` | Deletes the named artifacts. Run it only on the word of the user. |
| `artifacts retention [DAYS \| none]` | Prints the retention, or sets it. With no setting, the server deletes nothing. |
| `artifacts doctor` | The store, the port, the server state, the retention and the scanner. The last line is `doctor: PASS` or `doctor: FAIL`. |

## Upload a file

1. Write the page to a file with one of the four extensions. Run the upload from the directory of the repository that the page is about, or give `--repo NAME`.
2. Run `artifacts upload FILE --title "<short title>"`. Exit 0 means the page is stored.
3. Give the `view:` link and the `expires:` value to the user, in your reply only.

In a Markdown file, a fenced code block with a language name (for example `python`, `sh` or `json`) gets syntax colors in the view; a block with a language that the view does not know stays plain text. For a report with code or commands, write Markdown with these blocks.

When you change a page that you uploaded in this session, upload it again with `--replace SLUG`. The user keeps the same link, and an open viewer page offers a reload.

The view link is a loopback link to the viewer page (`http://127.0.0.1:<port>/v/<slug>`). It works only on the computer of the server, or through a port forward to it. Each holder of the link on that computer can read the page, so put it only in your reply to the user, never in a commit, an issue, a log or a shared file.

With a remote store (`artifacts setup --remote HOST`), `upload`, `list`, `open` and `delete` work on the store of HOST over SSH, and `upload` prints one more line `on: HOST`. The view link is then valid on HOST, not on this computer: give the link and name HOST in the same reply. `artifacts --here <command>` uses the store of this computer for one call.

A line on standard error says when no server runs. The page is stored all the same; the user views it after `/artifacts-server start`.

To show a page, run `artifacts open SLUG` and give the user the printed URL. The CLI is the only way to show a page: start no local browser.

## Exit codes

- 5: the secret scanner found a secret or a policy finding, or it could not run. Remove the finding from the file, then upload again. Never upload around the scan.
- 3: the server did not start or did not answer, or the remote computer did not answer. The file is then not stored, unless the connection ended after the remote computer finished: `artifacts list` shows it. Run `artifacts doctor` and report its lines.
- 2: a refused input, for example a wrong extension, a file over 10 MiB, a bad or unknown slug, or a port that another program uses. Give the message to the user.
