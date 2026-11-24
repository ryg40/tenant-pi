# Changelog

## Unreleased

### Removed

- Retirement, 2026-11-23: Core (the page editor, its commands `walkr <target>`, `poll`, `status`, `connect`, `disconnect` and `claim-wake`, the Pi wake integration, hosted mode with its `Dockerfile` and its home page), the Core items and the Approach menu of the Compare page (step 1 of "one Walkr page"), Double, the Double session shell, the shared GUI, Coinflip, Trainer, the mode guides, the four Pi extensions, and the skills and prompts `walkr-core`, `walkr-double`, `walkr-coinflip` and `walkr-trainer` left the package. Walkr keeps Compare: `walkr-compare`, the Compare page with its decision panel, rating, session list and themes, the mirror and the Sheprd link. The release tag `portable/20261122-548259a` is the last release with the old code and its guides. Each entry below that names a retired part describes code that is in that release only.
- The server answers 404 for each retired route and writes nothing for it. The server protocol is 10, so a `walkr-compare` command replaces a running server of the old code. The retired command names print one line with the tag and exit with code 2. Setup removes its own unchanged skills and prompts of the retired modes; the installer removes its own links of the retired commands.
- The page lists Compare sessions only. `GET api/history` answers `{ rows }` with Compare rows, and `GET api/history/<ref>` is gone. A saved record of a retired mode stays on disk untouched and is not read. The mirror reads only `sessions/`; `sync.sh` copies only Compare sessions.
- The package has no runtime dependency: `marked` left, and `css-tree` is a development dependency of the tests. The installers run no npm step.

### Added

- Compare: a local-only A2UI v1.0 WebSocket route `GET /_walkr/compare/a/<capability>` (RFC 6455, no runtime dependency) that streams open-session decision surfaces keyed by session ID with a `/status` error text, accepts `submit` actions through the same server submit function as the page, refuses `Origin` headers, queries/fragments, hosted runs, the mirror, non-local hosts and agent-only operations, bounds connections (4), send queues (1 MiB), handshakes (10 s) and client frames (16 KiB), keeps the server alive while connected, and closes sockets with 1001 on shutdown. See `docs/compare.md`, "The A2UI socket".
- Compare: a public origin. The key `walkrPublicOrigin` of the artifacts config file (`artifacts setup --walkr-public-origin https://NAME`) names one `https` origin of a reverse proxy, which reaches the artifacts server through an SSH forward with the `Host` of the browser unchanged. A request with that host and a loopback peer reaches only the Compare routes and the theme files. The agent token is never valid for it, and a page write needs an `Origin` equal to the public origin. The policy of an HTML option names the public origin. With the key, `create` prints `url` as `<public origin>/walkr#<session-id>` with no secret, and the address of today as `localUrl`. Without the key, each check and the output stay as before. The protocol stays 10. See `docs/compare.md`, "A public origin behind a reverse proxy".
- Compare: remote mode. When the key `remote` of the artifacts config file names a host (`artifacts setup --remote HOST`), `create`, `open`, `list`, `view`, `wait`, `received` and `outcome` run on that host as `walkr-compare --here <command>`, through one `ssh` call each. The sessions are then stored on that host only, and this computer starts no server and writes no session. The `ssh` call uses the options, the quoting and the test seam `ARTIFACTS_SSH_COMMAND` of the artifacts CLI. The output and the exit code of the host pass through. `create` and `outcome` send the request file on standard input. Exit 3 means that the call did not reach the host or lost its answer; nothing falls back to this computer. `--here` as the first word runs a command on this computer. `close`, `--help` and `--version` stay on this computer. For a loopback page address, one line on standard error says that the address is valid on the host only. A call takes at most its limit (60 s; for `wait`, its timeout plus 60 s) plus 2 s for the output after `ssh` ends. The host needs this version or a newer one: for the refusal of an older `walkr-compare`, the command adds a line that says so. See `docs/compare.md`, "Remote mode".
- Compare: `create -` and `outcome <session-id> -` read the JSON request from standard input.
- Compare has an optional A2UI session renderer. The Renderer control keeps the session and draft; Current stays the default.
- The Compare page shows the links Artifacts, Walkr and Memory in its bar when it comes through the local web app of the kit (the artifacts server). They are the three sections of that web app. On the own port of the Walkr server the page has no such links.
- One Walkr page, step 1 (`docs/one-page.md`): the Compare page has an Approach menu with Compare, Core, Double, Coinflip and Trainer. A choice shows the panel of that approach; Double, Coinflip and Trainer say "not yet moved" and name the command of their old page. The Core approach shows the Core reviews that the agent opened with `walkr-core <target>`: an HTML or Markdown file or a `localhost` URL, in a frame with an opaque origin (`sandbox="allow-scripts"`). The page opens no target of its own. A click or a text selection in the frame starts a comment; Add comment, Remove, an overall note and Send to agent make a normal Core batch, which `walkr-core poll` collects. The Core routes sit under `/_walkr/compare/` (`c/<grant>/<key>/`, `api/core`, `api/core/<key>`, `.../comment`, `.../remove`, `.../send`), take the page token for each write, refuse a foreign `Origin` on each write, and answer only a loopback peer with a loopback Host; an `HUMAN_REVIEW_ALLOWED_HOSTS` host and hosted mode get no Core approach. The frame address is a grant of one item that ends after 30 minutes, never the page secret. A frame serves only the registered document and its page files (styles, scripts, images, fonts; no hidden part, no symlink out, checked at each read), and its policy lets it load only from its grant or the registered app origin. A localhost fetch reaches only the registered origin, also at a redirect and at `walkr-core` open. A Send of the one page holds only the selected item; a second Send before the poll keeps both overall notes. A Core row of the session list opens as a live item when the agent registered its target in this server run; the history row has `coreKey`. `walkr-core <target>` also prints the address of the item in the one page. A file target is bound to the identity of its folder at registration, and a page file goes out only while its document is valid. A comment `actionId` belongs to one content; after 409 `ACTION_CONFLICT` the next Add of the same draft uses a new ID. A late answer clears only the draft that went out, and a write error goes away on the matching success. The frame loads again with a renewed grant and after a new registration of its target, and a `localhost` frame loads again after any ack, also of a note-only batch. The old Core editor page gets no reload for a note-only ack. A preview that the server refuses (the file is gone or its folder changed) says so and asks for a new `walkr-core <target>`. A module script of a file target does not run in the frame (no CORS). The Core editor (direct edits, delete, move, pasted images) stays on the old Core page.
- Compare: the receipt of the agent. The new agent write `POST api/sessions/<id>/received` (body `{}`, agent credential only) saves `receivedAt` one time for a submitted result; a later call answers with the same time, and an open session gets 409 `INVALID_TRANSITION`. `walkr-compare wait` sends it before it prints a result and prints `receivedAt`. When the receipt fails, `wait` still prints the result, with `"received": false` and the cause on standard error. The new command `walkr-compare received <session-id>` sends only the receipt, for a result that the agent read with `view`; `view` sends none. Below the result text, the page shows "Waiting for the agent to read your result." and, within one poll, "The agent received your result at ...", in a line with `role="status"` outside the A2UI surface; the option frames stay. A session with an outcome and no receipt shows no line. The skill tells the agent to run `wait` in the background in Claude Code and to confirm the result in the chat first, with one line that starts with "Received your result:". The record version stays 1. See `docs/compare.md`, "Pick, comment and submit".
- Compare: two buttons in the decision panel. Submit (done) sends the result and ends the comparison. Next round sends the result and asks for one more round. The Next round cards show only after the first selection in Pick one option, and they stay when the pick changes; the page draws the panel again at that moment and keeps the pick, the note with its caret, and the focus. The first card is From my comments and note, the default; then one card for each suggestion. The card No more rounds is gone. A session without suggestions shows no Next round cards, and its Next round button asks for a round from the comments and the note. A session of round 20 has Submit (done) only. The submit field `nextRound` takes the reserved value `@feedback`: one more round from the pick, the comments and the note, valid in each session below round 20, also without `nextRounds`. A session of round 20 refuses each `nextRound`. No option fits needs a note or a column comment, or a `nextRound` that names a suggestion; Submit (done) in the page still needs the note. `previous.roundId` refuses `@feedback`: a feedback round names no `roundId`. The result text says "Next round: from your comments and note." The text preview of a card now starts after the leading blank text, so a long indent does not use up the cut. The record version stays 1. See `docs/compare.md`, "Pick, comment and submit" and "Next rounds".
- Compare: previews in the cards of the decision panel. Each option card shows a small, cut render of its content at the foot of the card: the first lines of a `text` or `markdown` option as plain text, or an `html` option at a third of its size in a sandboxed frame with the rights of the option frame. A `nextRounds` item of the create request takes an optional `preview: { format, content }` (at most 16 KB of content), and its Next round card shows it the same way; the server serves an HTML preview at `o/<capability>/<id>/next/<roundId>` with the policy of an option. A preview takes no click, no focus and no place in the accessibility tree; a click on it picks the card. The extension `walkr_optionDetails` takes `preview: { text }` or `preview: { frame }`. A panel over the 64 KB limit of one A2UI call shows without the previews first, then also without the card summaries. The record version stays 1. See `docs/compare.md`, "The decision panel".
- Compare: next rounds. The create request takes optional `nextRounds`: 1 to 4 suggestions of the agent `{ roundId, label, summary? }` for one more round. The decision panel shows them as a second picker, Next round, below the option cards. The submit request takes an optional `nextRound`, and the result saves it. With a chosen round the agent starts a new session at once, with `previous: { sessionId, roundId? }`; the store checks that the earlier session has its result and saves `round`, at most 20 in one chain. A row of the session list has `previousSessionId`, and the page finds the later rounds in the rows. The page shows the round line with a link to the earlier session, a link to each later round, and a Round chip in the session list. A session of round 20 takes no `nextRounds`. A panel over the 64 KB limit of one A2UI call shows without the card summaries. The record version stays 1. See `docs/compare.md`, "Next rounds".
- Compare: the decision panel is one A2UI v1.0 surface, drawn by the new module `src/a2ui.js` with `src/a2ui.css` (a check of the messages and a renderer with no dependency). The picker shows one card for each option with its `summary` and a Recommended mark, and a card for No option fits; the arrow keys move the pick, and a pick in a column and in the panel stay in step. Submit sends the same request as before. The create request takes an optional `recommended`: the `optionId` of one option of the request. The record version stays 1. While a request waits for its confirmation, the picker and the note take no change, and the note takes at most 8000 characters. A submitted result that is too large for one A2UI call shows as plain text. See `docs/compare.md`, "The decision panel".
- History page: the Compare page of the background server is now the Walkr history page. It lists the sessions of every type, newest first: Core, Double, Coinflip, Trainer and Compare. The `Type` selector filters by type, and Compare workflows stay selectable under Compare. Compare sessions keep pick, comment, submit and rating; the other types show read-only, with the command that opens the session live. Core pages without a comment, an edit or a batch are not listed. A type with no session shows how to start it. The reader writes nothing; a broken or missing record gives an error row.
- Mirror: the history mirror shows the same page at `/` from a root with one folder for each computer (`hosts/<host>/core/state.json`, `hosts/<host>/double/`, `hosts/<host>/trainer/`). Each row names its computer when the root holds more than one. `sync.sh DEST_ROOT NAME=HOME...` copies the Compare sessions, the Core state file, the Double archive and the Trainer datasets of each computer. It never copies `server.json`, `server.lock`, `pristine/`, the shared GUI record or review copies. The old form `sync.sh DEST_ROOT SOURCE_COMPARE_ROOT...` still works.
- `Dockerfile` in the package: the review server of hosted mode, on the pinned Node 24 Alpine image.
- `HUMAN_REVIEW_TRUSTED_PROXIES`: in hosted mode, a listed proxy IP address with a loopback `Host` reaches the Core routes, so the hosted server works behind Caddy again. A value that is not an IP address stops the start in every mode; outside hosted mode a valid list has no effect.

### Changed

- Compare: an artifacts config file that cannot be read or is not a JSON object now stops each `walkr-compare` command without `--here` (exit 1, the message names `--here`), also on a computer without remote mode. Before, the command ran on this computer.
- The artifacts server (`walkr_front.py`) runs `walkr-compare --here open`: its Walkr page shows the Walkr server of its own computer, also with the key `remote`.
- Compare: the bar of the page is the band of the theme. In Torch Light and Torch Dark the bar is navy, as the top bar of the artifacts pages and of the shared GUI: the wordmark is white with a yellow `r`, the session type and the count of new sessions are yellow marks, and Sessions, Newer, Older and Show all are band buttons. A theme with no band of its own keeps its bar colors.
- Compare: the border of each field (the selects of the bar, the comment fields, the note of the decision panel, the rating note, the zoom buttons and the tabs of One option) is `--strong-border`, with a contrast of 3 to 1 or more in the Torch themes. Before, it was the pale `--hair` (1.3 to 1 in Torch Light). The hint text of an empty field has the faint text color of the theme, not the pale gray of the browser.
- Compare: the fold Brief and answers shows its focus ring. Before, the fold cut the ring off.
- Compare: the decision panel stands in a side column of 380 px (`--cmp-side-width` in `src/compare.css`) on the right of the option columns, when the area below the bar is at least 1244 px wide. One container query measures that area, so an open session list counts. The columns and the side column fill the height below Brief and answers; the side column scrolls on its own, and the page does not scroll. The row of the note, Submit (done) and Next round is a sticky foot: it stays in view while the panel is in view. The note grows to at most 30 % of the window height (`max-height: 30vh`), also by a drag of its corner, so the foot never covers all the cards. At the first show of the Next round cards, the side column scrolls one time by the smallest amount that shows the first Next round card above that foot; a read of the page never scrolls it. The rating moves below the panel into the fold Rate this session: closed at the start and for each newly selected session, with Not rated or the saved stars in its summary. See `docs/compare.md`, "The page" and "Rate a session".
- Compare: in a narrower area (the stacked layout), the side column stands below the option columns, and each column keeps at least 280 px of content height (`--cmp-body-min` in `src/compare.css`). On a window wider than 900 px that is too short for the columns and the side column together, the area below the bar scrolls, and the bar stays in place; a taller window does not scroll, as before. A window of 900 px or less stacks the option columns too, keeps no minimum height for a column body, and scrolls the whole page with the bar, as before. See `docs/compare.md`, "The page".
- Compare: a loopback connection peer with a loopback Host of any port reaches the Compare routes and the theme files `/theme.css` and `/theme.js`, so a local front can pass the page. Other routes still need the port of the server in the Host, and hosted mode is unchanged. On a request that only this any-port rule admits, a `seen`, `submit` or `rate` write with an `Origin` that is not the HTTP origin of the Host (host name and port, compared in lower case) gets 403; a write without `Origin` passes. Requests through the own port or an allowed host have no Origin check. The program `walkr-compare open <session-id>` exits 2 for an unknown or invalid session ID; `walkr compare open` still exits 1.
- Double and Coinflip: when `HUMAN_REVIEW_DOUBLE_ARCHIVE_DIR` is unset, the archive is `~/.local/.walkr/double`, beside the Compare and Trainer roots. A set value always wins. The background server of Core and Compare still runs Double only with an explicit value, so it never owns the default archive. Its history page only reads the records there.
- The mode page `/_walkr/modes/core` shows the Core guidance: the launch name `walkr-core` and how the agent opens a page. Before, it showed the fallback text of a mode that is not available. The history page shows the same text for an empty Core list.
- History page: each time in the list and in the views shows in the local time of the browser, as `YYYY-MM-DD HH:MM`. The live commands quote each value from a record for the shell. The page reads a Double, Coinflip or Trainer record again only when its file changed. When a writer replaces a record during the read, the page reads it one more time, so a healthy record gives no "Not readable" row; a record that fails twice gives the error row.
- Mirror: `sync.sh` puts `--` before the source and the destination of each rsync call. In the `NAME=HOME` form a computer without a Compare directory yet gives a note, not a failure; a computer that does not answer still fails the run. The old form still fails for a Compare root that is gone.

- The page headers show a foot logo before the text Walkr: Core, the mode pages, the hosted home, Double, the shared GUI, Trainer and Compare. The foot replaces the dot before the brand. It is inline SVG in the colour of the brand text, so the page policies stay the same.
- The optional Compare mirror in `mirror/`: a persistent, read-only Compare page over a root of session records, with `sync.sh` to copy records from other computers. No install step installs or starts it.
- Mirror: the documented container command sets `HUMAN_REVIEW_ALLOWED_HOSTS` for the published port, so the browser no longer gets `403`. The theme files use file names from a fixed table, not from the request path.

### Fixed

- Compare: the policy of an HTML option also names the origin of its page. Sheprd pages (Servo 0.8) blocked every option frame, because Servo compares `'self'` with the opaque origin of the sandboxed option.
- Mirror: `sync.sh` uses only the `rsync` options that the `rsync` of macOS also has. The script sets the modes and the owner after the copy with `find`, `chmod` and `chown`.
- Core and Compare: a `/health` check no longer counts as use, so a background server with only health-check traffic stops after the idle time. The background server also stops when its state directory or its `server-entry.js` file is deleted. `HUMAN_REVIEW_SWEEP_MS` sets the check interval for tests.
- Core and Compare: the command stops a server of an older protocol (or of no protocol) for the same state directory before it starts a new one. Before, the old server kept the server lock, so the start failed and the old server kept running. The command never stops a server of a newer protocol: it fails with a message to use the newer Walkr version or another `HUMAN_REVIEW_STATE_DIR`. A server that ended before the stop signal counts as stopped.
- Tests: the Compare command test stops its background server even when the state directory is removed first.
- Setup: valid plain skill descriptions with embedded colons or hashes no longer block installation. Ambiguous YAML and skill name collisions still refuse before writes.
- Core: the review proxy validates every outbound target and uses numeric loopback addresses. Redirects cannot leave loopback.
- Core: a failed file-watch save no longer stops the server or clears unsaved feedback. The watcher retries the save.
- Core: the file watcher catches source changes during startup. Unchanged content with injected review tags no longer causes a false reload.
- Core: unexpected request errors return generic messages with reference codes instead of exception details. The bounded, owner-only `errors.log` records their causes and file-watcher save failures.
- Core: local pages retain raw and zlib deflate decoding and reverse-order encoding chains, with the decoded size limit intact.
- Core: removing injected review tags also removes tags exposed by the first removal pass.
- Double: static resources use registered file paths, not request-derived filenames.
- Tests: wake leases use a controlled clock, and the navigation fixture no longer reflects request paths into HTML.
- Tests: Compare clicks wait for receipt handling instead of a fixed delay. A held retry receipt checks that the exact pending request stays until confirmation.

### Added

- Compare, a fifth mode with the command `walkr-compare` and the skill `walkr-compare`. The agent prepares 2 or 3 options of one change. You see them side by side in one private page, pick one, comment and submit. See the [Compare guide](docs/compare.md).
- Two workflows of the `walkr-compare` skill. `walkr compare cfn options` shows options of a CloudFormation change, and `walkr compare cfn + architecture diagram` adds a diagram to each option. `walkr simplify ticket` shows three versions of a short text, each as clean text in its own box, with the original text folded above them. The agent asks with its question tool before it starts.
- The Compare page is one view of every session. It has no mode menu. The session list is in time order, the newest first, and a session shows New until you open it. The Type selector filters the list, and the View selector changes the display: Side by side or One option.
- Compare: Fold left and Fold right turn an option into a narrow rail. Solo folds the other options; Show all opens them again. Folding keeps the frames, zoom, comments, pick and rating. A newly selected session starts unfolded.
- Compare: the `walkr` wordmark appears before Sessions in the top bar and uses the theme colors.
- A star rating for each Compare session: five stars with half stars, saved as a whole number from 1 to 10. You can rate at each time, and the agent reads earlier ratings before a new session.
- `walkr-compare` starts the background Walkr server when none runs, as `walkr-core` does. Sessions are saved under `~/.local/.walkr/compare` or `HUMAN_REVIEW_COMPARE_ROOT`.
- `HUMAN_REVIEW_ALLOWED_HOSTS`: a list of exact `name:port` values that the server accepts in the `Host` header. With `HUMAN_REVIEW_BIND=0.0.0.0` you can open the Compare page from another computer. Every other route refuses such a host. The default accepts `127.0.0.1` and `localhost` only, as before.
- An optional Sheprd link, off by default. Sheprd is a separate tool that receives Walkr page URLs; the kit neither installs nor requires it. The link needs `WALKR_SHEPRD_CONNECT=1`, a Herdr pane and `sheprd` on the `PATH`. With it, `walkr-compare create`, `walkr-compare open` and `walkr-core FILE` request a page display. `walkr-compare close` sends a disconnect request. See the [Compare guide](docs/compare.md#sheprd-link-optional).

## 0.9.3 (2026-11-10)

Found in the first trial with a real browser (Helium) and a real Pi chat.

### Added

- Zoom for each candidate display in Double and Coinflip: −, the level, + and Full page, from 25% to 100%. Zoom changes only the display.
- The themes Torch Light and Torch Dark. Torch Light is the default theme.
- When the shared GUI connection stops without a command, the chat shows a message with the reason (`lastStop`).

### Changed

- Shared GUI: the page has a new structure. One thin top bar shows the mode of the session on screen, its title, one state chip, the connection, Saved sessions, Reload, Mode guides and the theme. The stage with the candidates takes the rest of the window. The prompt is a composer under the stage: one line under a session, and a start card in the middle of the stage when no session is on screen.
- Shared GUI: the mode choice of the next brief (Double, Coinflip, Training) is in the composer only. The top bar shows the mode of the session on screen as a chip. The links to the mode guides moved to the Mode guides menu, and each guide opens in a new tab.
- Shared GUI: a saved session shows its brief as the title, not "Start Double". New review opens the start card from a finished session. With no active session, the page opens on the start card.
- Shared GUI: the connection is one dot with Connected or Disconnected. The chat id and the session file show on demand.
- Coinflip: the two Choose buttons are wide buttons under the candidates, with the note field between them. The status text, Stop, Submit winner and Saved choices share one bar above the candidates.
- Double: the right column is more compact. A kept component shows a green mark and a discarded component a red mark at rest. Next Round and Done share one line. The marks use the new theme tokens `--keep` and `--discard`.
- Training in the shared GUI: the status, the dataset and End share one bar. The framed Trainer page starts with the progress and the task, and lists the groups as rows.
- Trainer: an ended session shows its groups read-only. Select a group to see its saved ranking.
- Theme tokens for the top band of the shared GUI (`--band` and its text colors) and for the stage (`--stage`). Torch Light uses the navy band.

### Fixed

- Double: the delete popup is no longer cut off when the pane is shorter than the popup. The zoom stage does not clip its content.
- Coinflip: the candidates no longer cover the note, Stop, Retry and the recovery button. The panel scrolls.
- Coinflip: a candidate that centers itself with viewport units shows in the visible stage. Each candidate has a visible Choose button.
- Shared GUI: the recovery button of the start box sent a Double request for a Coinflip review and left the page stuck. It shows for Double only, and a missing session releases a saved request.
- Shared GUI: the mode bar and the header show the active mode and the connection state, not "Double" and "Loading…".
- Pi delivery: a chat entry larger than 256 KiB (a system prompt of a real Pi profile) no longer makes every receipt fail. The packet limit stays 256 KiB.
- Pi delivery: one-shot Double no longer sends a packet larger than the 256 KiB limit. The packet stays in the archive, and the chat reports `failed_delivery`.
- Pi connection: the server keeps a connection for 20 seconds without a renewal, not 5.
- Pi workflow text: after an owner Retry, the agent makes a new request for the new attempt, and it reports a refused attach as a failure.
- Pi workflow text: the first Double pair marks each major region as its own component.
- Training in the shared GUI: the framed page shows no second mode bar.
- Core: a click on the empty area of a page no longer selects the page root.

## 0.9.2 (2026-10-26)

- Windows is not supported. CI runs on Linux and macOS only.

## 0.9.1 (2026-10-26)

CI fixes:

- Linux (Node 20 and 22): a Double chat test no longer stalls, so the runner no longer cancels the tests after it.
- macOS: temp paths resolve through `/private/var`.
- Windows: canonical Windows paths and LF line ends work.
- Windows: Double, Coinflip, the shared GUI and Trainer refuse with one clear error, because they need Linux or macOS. The refusal covers the commands, the servers, the Pi clients and the stores. Core review and setup stay supported.

## 0.9.0 (2026-10-26)

This is the first public release of Walkr.
Walkr is a fork of [Human Review](https://github.com/petergyang/human-review) 0.8.2 by Peter Yang, from upstream commit `f9a5581`.

### Added over Human Review 0.8.2

- Four modes, each with its own command and agent skill:
  - Core (`walkr-core`, also `walkr`): the review of one HTML or Markdown file or one `localhost` page.
  - Double (`walkr-double`): two candidates of one page side by side. Keep or delete regions over rounds, then choose a final page.
  - Coinflip (`walkr-coinflip`): two candidates of one component. Pick a winner round by round.
  - Trainer (`walkr-trainer`): rank prepared items in groups of three to build a preference dataset.
- The shared GUI: one browser view that starts Double, Coinflip and Training from a brief and connects one Pi chat.
- Steering: the prompt box sends a new instruction to an active Double or Coinflip review.
- A mode bar on the review pages, and a theme picker with five new themes beside the original light and dark.
- Batch ids for Core: each Send has a stable `batch_id`. `walkr-core poll --ack <batch_id>` acknowledges one exact batch.
- An opt-in Pi wake-up for Core (`integrations/pi/core-wake.ts`): it wakes the chat that started a review when a Send waits.
- The selection reticle in Core: a green glowing mark on the selected block, separate from the gray hover line.
- Five agent skills, installed with `walkr-core setup`: `walkr`, `walkr-core`, `walkr-double`, `walkr-coinflip`, `walkr-trainer`.
- An installer, `install.sh`, with `--dry-run` and `--uninstall`. See [INSTALL.md](INSTALL.md).

### Changed

- The command is `walkr`. The `human-review` command is not installed.
- The `/human-review` skill is replaced by the five Walkr skills. Setup moves a known old copy to a backup.
- The `HUMAN_REVIEW_*` environment variables, the `x-human-review-token` header and the `~/.human-review` state directory stay for compatibility.

### Not in this release

- Hosted mode. The code has a dormant hosted mode (`HUMAN_REVIEW_HOSTED`). This release does not support it.
- Hosted Double, Coinflip and Trainer.

### Known limits

- Removal of injected tags matches `data-eh-sdk` or `data-eh-route` anywhere inside a `script` or `base` start tag. An application tag with that text in an attribute value is removed on save.
- The browser tests use jsdom, not a real browser. Real browser layout, accessibility and visual contrast are not verified by the tests.
- The Pi tests use an offline model provider. They prove delivery and saving, not the quality of real model output.
- One server writes to one archive or one Trainer root at a time.
