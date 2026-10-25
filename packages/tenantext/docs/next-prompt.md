# Next-prompt suggestion

The `next-prompt` extension shows one suggestion in the empty Pi editor after a dummies report. The suggestion repeats the recommended next action of the final report. It is not a prediction of the intent of the user. The extension makes no model call, no network request, no user message and no session entry.

The extension is separate from the next-move chip of the context meter. That chip asks a decision server; see `nextMoveUrl` in [the context meter guide](context-meter.md).

## When the suggestion appears

All of these conditions must be true:

1. The session runs in the interactive terminal mode (`ctx.mode` is `tui`). Print, JSON and RPC modes get no suggestion.
2. The setting `enabled` is `true`.
3. Dummies is on for Pi: the dummies state file has `"pi": "on"`. The extension reads the state file of `skills/coordinator-skills/dummies/scripts/state.py` and never changes it. An absent, invalid or linked state file counts as off.
4. The session is a coordinator session. In a Herdr pane, the extension reads the pane name with `herdr agent get`, as `state.py` does. A name that ends in `-worker-<n>`, `-reviewer-<n>`, `-researcher-<n>` or `-scout-<n>` is a task session: it gets no suggestion. Outside Herdr, or with no role in the name, the start prompt of the session decides; a task session writes no dummies report, so the extension finds no suggestion.
5. The agent run settled (the Pi event `agent_settled`) and was not aborted. No work is active and no message is queued.
6. The editor is empty.
7. The final message of the current session branch is an assistant message that stopped normally, and it holds one valid report with one safe next action. See [The report syntax](#the-report-syntax).

The suggestion is faint text after the cursor. The keys:

| Key | Result |
| --- | --- |
| Tab | Puts the suggestion into the editor as a draft. Nothing is sent. |
| Enter | Unchanged. After Tab, Enter sends the draft as a normal message. |
| Each other key | Clears the suggestion and does its normal action. |

The suggestion clears when an agent run starts, when a session starts or changes, on tree navigation, on shutdown, and when the setting changes to off. It never replaces typed or queued text.

## If nothing shows

Check these conditions in order. These checks do not enable anything.

1. Check the package extension selection in the active Pi profile. It must load `extensions/next-prompt/index.ts`; any filters must permit it. See [One extension](../README.md#one-extension).
2. Check the DUMMIES state for Pi with `/skill:dummies status`. The Pi state must be on; the state of another harness does not count.
3. Check `Next-prompt suggestion` in `/tenantext settings`. Its `enabled` setting must be `true`.
4. Check the session role and mode. Only a coordinator in the interactive terminal (`tui`) qualifies.
5. Check that the run settled without an abort. Pi must be idle with no queued message.
6. Check that the editor is empty. Typed text prevents the suggestion.
7. Check the final branch message against [The report syntax](#the-report-syntax). It must be a normally stopped assistant message with one valid report.
8. Check the refusal conditions. Missing, ambiguous or `Next: None.` reports suppress the draft. So does any owner action, action condition, `Needs approval`, `Retired`, `Proposal` or `Blocked` item, or warning.
9. Check the complete draft length and characters. The 100-character cap includes `Continue action <label>: `. Unsafe control, hidden or bidirectional characters anywhere in the block suppress the draft.
10. Check the editor line and available width. A different empty-line shape or too little room after the cursor hides the suggestion without shortening it.

## The report syntax

The extension reads "Compact report syntax 2", section 6 of `skills/coordinator-skills/dummies/REPORT.md`. The one module that knows the syntax is `extensions/next-prompt/report.ts`.

- It reads only the text of the final assistant message. It skips lines in code fences and lines that start with `>`. It never reads tool output or an older message.
- A missing or ambiguous report gives no suggestion. So does `**Next:** None.`.
- Item numbers restart at `1`. Independent next-action labels restart at `a`, then continue after `z` as `aa`, `ab`, through `zz`, then `aaa`. Neither sequence has a count cap. A duplicate, skipped or reordered label makes the report ambiguous.
- Syntax 1 uppercase-subject reports and mixed forms are rejected, without a fallback. Historical pages are not migrated.
- Action labels identify actions, not numeric subjects. The parser never joins them by position, label or a guess about prose.
- Only the first action is a candidate. Any owner action, any action condition, any `Needs approval`, `Retired`, `Proposal` or `Blocked` item, or any warning suppresses the whole report's suggestion. The extension does not skip to a later action.
- This conservative rule also suppresses safe independent actions beside unrelated approval or retired work. Without explicit safe linkage, silence is safer than implied authorization.
- The accepted text is one line of at most 100 characters. A longer candidate, or unsafe control, hidden or bidirectional characters anywhere in the block, gives no suggestion. The extension never cuts a command, an identifier or a URL.

The accepted text has the form `Continue action <label>: <action text>`, for example `Continue action a: Read the log of the failed check.` The form is the function `acceptedText` in `report.ts`. The suggestion type exposes `action`, not a numeric item reference. Free text is not a permission system; normal safety and approval checks still apply after submission.

## Settings

The settings file is `<agent dir>/next-prompt/settings.json`. `/tenantext settings` has the row `Next-prompt suggestion`.

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` turns the suggestion off. The editor then stays the editor of Pi or of the other extensions. |

Proposal, for owner acceptance: the suggestion is available when dummies is on, and `enabled: false` is the explicit opt-out.

An invalid file shows a warning, and the defaults apply.

## The editor

The extension adds its editor only when it has a suggestion to show. It builds the editor from the factory that `ctx.ui.getEditorComponent()` returns, or from the Pi `CustomEditor` when no extension set one. It changes only the drawing of the empty line and the Tab key while a suggestion is on the screen. It never wraps its own factory. When the factory of another extension replaced or wrapped the own factory, the next suggestion wraps the factory on top again, and only that newest own layer acts. Pi removes extension editors on `/reload` and on a session change.

The faint text replaces the spaces after the cursor of the empty line. Before it draws, the extension checks that the line has the form of the Pi editor: spaces, the cursor, then spaces, with the same width after the change. When the check fails, or when the text is wider than the room after the cursor, no faint text shows. The line stays as the editor drew it, and Tab keeps its normal action. The extension never shortens the faint text.

## Compared with the manual next step

Without the extension, the owner reads the report and types the next prompt. The extension saves that typing only when the report's first action is an eligible Agent action; the suggestion repeats that action and adds nothing. It stays silent when any report action needs the owner or a condition, or when any subject needs approval or safe linkage is unavailable. A report that breaks the syntax gives nothing, and the owner types the prompt as before.

## Limits

- The suggestion repeats an action that the report states. It is as good as the report.
- A report that does not follow the syntax gives no suggestion. The extension does not repair it.
- Not verified: the suggestion with other editor extensions, and on a terminal without the faint attribute.
