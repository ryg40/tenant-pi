# Changelog

## Unreleased

### Added

- The optional Compare mirror in `mirror/`: a persistent, read-only Compare page over a root of session records, with `sync.sh` to copy records from other computers. No install step installs or starts it.
- Mirror: the documented container command sets `HUMAN_REVIEW_ALLOWED_HOSTS` for the published port, so the browser no longer gets `403`. The theme files use file names from a fixed table, not from the request path.

### Fixed

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
