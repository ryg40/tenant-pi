# Compare

Compare shows 2 or 3 options of one change side by side. You pick one, comment and rate the session.
The agent prepares the options. Compare keeps every session, so you can step through earlier sessions later.

Compare needs no Pi chat and no server that you start: `walkr-compare` starts the background Walkr server.
By default the server and the sessions are on the computer of the agent. In [remote mode](#remote-mode), they are on another computer that you reach over SSH.
Compare is the one mode of Walkr. Core, Double, Coinflip, Trainer and the shared GUI are retired since 2026-11-23; the release tag `portable/20261122-548259a` is the last release with their code.
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

There is one page for all sessions. Its list is the history of the Compare sessions: see [The session list](#the-session-list).
The private URL belongs to one server run. A page that is open shows a new session without a new URL.

| Part | Content |
| --- | --- |
| Bar | The foot logo and the theme-coloured `walkr` wordmark, Sessions, the session type, title and state, Newer, Older, Workflow, Renderer, View, Show all and Theme |
| Session list | Every saved session of every type, the newest first: type, title, time and state. A Compare row also shows your pick and the stars, New until you open it, and Round 2 or higher for a later round. |
| Round line | Above the brief of a linked session: "Round 2. Earlier round:" and the title of the earlier session, and a "Next round:" line for each later round, oldest first. A title selects that session. See [Next rounds](#next-rounds). |
| Stage | The options in their original order. Side by side adds Fold left, Fold right and Solo to each option head. |
| Folded rail | A narrow button in the option's place, with its label and pick mark. Select it to open that option again. |
| Show all | Opens all folded options. This control appears in the bar only when Side by side has a folded option. |
| Decision panel | In the side column on the right of the options, or below them in the stacked layout. One card for each option with a small preview of its content, one for No option fits, the Next round cards after your first selection when the agent sent suggestions, the note, Submit (done) and Next round. See [The decision panel](#the-decision-panel). |
| Rating | A fold below the decision panel. Its summary shows Rate this session and Not rated or the saved stars; open it for the stars, the rating note and Save rating. See [Rate a session](#rate-a-session). |

- Sessions opens and closes the list. A closed list gives its width to the area below the bar. There the stage has the full width, or shares it with the side column when the area is at least 1244 px wide.
- In a window wider than 900 px, the bar stays at the top. When the area below the bar is at least 1244 px wide, the decision panel and the rating fold stand in a side column of 380 px on the right of the options. This is a window of at least 1268 px with a closed session list, or 1548 px with an open one. The options and the side column fill the height below Brief and answers. The side column scrolls on its own; the page does not scroll.
- In a narrower area, the side column stands below the options: the stacked layout. Each option column then keeps at least 280 px of content height. When the window is too short for the columns and the side column together, the area below the bar scrolls; a taller window does not scroll. A window of 900 px or less also stacks the option columns, keeps no minimum height for a column body, and scrolls the whole page, the bar too.
- The row of the note and the two buttons stays at the bottom of the side column (in the stacked layout, of the area below the bar) while the panel is in view. The note grows to at most 30 % of the window height, also when you drag its corner, so this row never covers all the cards; a longer note scrolls inside the field.
- Workflow shows only the sessions of one workflow in the list, for example `logo-options`, or `All workflows`.
- View changes the display: Side by side, or One option (with one tab for each option).
- Fold left and Fold right close one column into a rail with its label facing that direction. Open columns share the free width.
- Solo opens the chosen option and folds its neighbours in place. Show all restores equal columns.
- Folding changes only the layout. Frames, zoom, comments, your pick and rating stay. A newly selected session starts unfolded.
- On a narrow screen, options stack vertically only when none is folded. With folds, the rails and open options share one row.
- A text session has a folded box with the original text above the options. Open it to compare. Current shows each version as clean text.
  The browser saves the view for each type.
- Newer and Older step through the list.
- Brief, answers and original shows the request, your answers before the start, the original text and the outcome of the agent.

### The A2UI renderer (preview)

Choose **Renderer → A2UI** to preview the whole session. Choose **Current** to go back. Both show the same live session and use the same draft. Switching sends nothing. Current remains the default until the owner approves the replacement.

The control remembers your choice in `walkr-compare:renderer`. To force one renderer, use `#<session-id>;renderer=a2ui` or `#<session-id>;renderer=current` at the end of the private page address. The fragment stays in your browser.

A2UI marks words added or changed against the original. It shows the full text in either case. When the comparison exceeds its work limit, a notice explains why there are no marks. Neither renderer runs Markdown as HTML.

### Formats

| Option format | Display |
| --- | --- |
| `html` | A sandboxed frame. It runs no script and loads nothing from a network. Inline styles, inline SVG and `data:` images show. Each frame has a zoom control. |
| `text` | Plain text |
| `markdown` | Plain text. Markdown source shows as it is, never as live HTML. |

Zoom changes only the display. The levels are 25%, 33%, 50%, 67%, 75% and 100%.

## The session list

The list shows the saved Compare sessions of the Compare root, the newest first. A session is one saved record.

- A session keeps pick, comment, submit and rating.
- With no session, the page shows how to start one.
- The page reads only the Compare root. A record that it cannot read, for example of a newer schema, gives one row with its error code; the page changes no record.
- A saved record of a retired mode (the Core state file, the Double archive, a Trainer dataset) stays on disk untouched. No Walkr code reads it, so it gives no row and no error.

The page shows each time in the local time of your browser, as `YYYY-MM-DD HH:MM`. The list sorts by the creation time of the session.

## Pick, comment and submit

1. Select the card of one option in the decision panel, or Pick this option under the option. The two stay in step. Pick this option again clears the pick.
2. Write a comment under each option when you have one. Comments are optional. A comment has at most 8000 characters; while a longer comment stands in a field, both buttons stay disabled.
3. When no option fits, select No option fits and write a note that says what is missing.
4. After your first selection, the panel shows the Next round cards when the agent sent suggestions. See [Next rounds](#next-rounds).
5. Select one of the two buttons. The first submitted result is final. There is no edit after it.
   - Submit (done) ends the comparison with this result.
   - Next round sends the result and asks the agent for one more round.

Submit (done) stays disabled until you have a pick, or No option fits with a note.
Next round stays disabled until you have a pick, or No option fits with a note, a comment or a selected suggestion: a round from your feedback needs some feedback.
The line below each button says what is missing.
Nothing goes to the server before you select one of the buttons.

After you select one of the two buttons, one status line below the result text shows whether the agent has your result:

| The session has | The line |
| --- | --- |
| No receipt and no outcome | "Waiting for the agent to read your result." |
| A receipt (`receivedAt`) | "The agent received your result at `YYYY-MM-DD HH:MM`." in the local time of your browser |
| An outcome and no receipt | No line. The outcome of the agent shows in the result text, so the agent has the result. This is the case of an older session or an agent with an older command. |

The agent sends the receipt when its `wait` reads the result, or with `received` after a `view`. The line changes at the next read of the page (every 2 seconds), with no reload. The options and their frames stay.
The line stands outside the A2UI surface and has `role="status"`, so a screen reader announces the change.

### Next rounds

The agent can add 1 to 4 suggestions for one more round to a session, for example "Shorter versions of B" or "Mix A and C".

- Next round asks for one more round. The selected Next round card says what the round starts from: From my comments and note (the default), or one suggestion. Submit (done) sends no next round, also when a suggestion card is selected.
- A session without suggestions shows no Next round cards. Its Next round button asks for a round from your comments and note.
- The result saves `result.nextRound`: `@feedback` for a round from your pick, your comments and your note, or the `roundId` of the chosen suggestion. The agent then starts a new session at once, without the start questions. It links the new session to this one with `previous`.
- The pick of an earlier round is not applied. The agent applies only the pick of the last round, the round that you submit with Submit (done).
- A linked session shows its round number and a link to the earlier session. The earlier session shows a link to each later round, oldest first.
- The page finds the later rounds in the session list: each Compare row with `previousSessionId` of this session. So a new later round shows at the next poll of the page, also under an open earlier session. The session view has no field for the later rounds.
- A chain has at most 20 rounds. Round 20 is the last round: its panel has only Submit (done), and a session of round 20 takes no `nextRounds` and no `nextRound`.

## The decision panel

The decision panel is one [A2UI](https://a2ui.org/) v1.0 surface. A2UI (Agent-to-User Interface, Apache-2.0) describes a user interface as JSON data, and the page draws it with its own components.
The page builds the messages of the panel itself (`decisionMessages()` in `src/compare.js`). No agent sends a surface to this page.

| Part | Content |
| --- | --- |
| Your decision | The heading. A submitted session shows the result text here: the pick, the next round, the note and the outcome of the agent. A feedback round shows as "Next round: from your comments and note." A result that is too large for one A2UI call (the 64 KB limit below) shows as plain text in the same place. The receipt line follows below the surface: see [Pick, comment and submit](#pick-comment-and-submit). |
| Pick one option | One card for each option: the label, the option `summary` below it, a Recommended mark on the option of `recommended`, and a preview of the option content at the foot of the card. The last card is No option fits, with no preview. |
| Next round cards | Only with `nextRounds`, and only after your first selection in Pick one option (an option or No option fits). They stay when you change the pick. The first card is From my comments and note, the default: "The agent prepares a new round from your pick, your comments and your note." It has no preview. Then one card for each suggestion: its `label`, its `summary` below it, and its `preview` at the foot of the card when the agent sent one. The cards are a second radio group, bound to `/next`. A session of round 20 shows no Next round cards. |
| Note | The note, at most 8000 characters. It keeps its text and focus when the page reads the session again every 2 seconds. |
| Submit (done) | Sends `{ actionId, pick, comments, note? }` with no `nextRound`, also when a suggestion card is selected. `pick` is an `optionId`, or `null` for No option fits. It needs a pick, or No option fits with a note. |
| Next round | Sends `{ actionId, pick, comments, note?, nextRound }`. `nextRound` is the `roundId` of the selected suggestion, or `@feedback` for From my comments and note and in a session without suggestions. It needs a pick, or No option fits with a note, a column comment or a selected suggestion. A session of round 20 has no Next round button. |

Both buttons name the session of the panel, and the page sends nothing for another session than the selected one.

- Each set of cards is one radio group. The arrow keys move the pick. Tab enters the group at the picked card and leaves it with the next Tab.
- The page draws the panel again when the Next round cards show. The new draw keeps the pick, the Next round card, the note with its caret, and the focus on the card that you just selected. When the first Next round card is out of view, the side column (in the stacked layout, the area below the bar) scrolls one time, by the smallest amount that shows that card above the note and the buttons. A read of the page never scrolls it. The previews of the cards load once more at this draw; a later poll does not draw them again.
- A click anywhere on a card picks it, also a click on its preview. The picked card has a coloured border and background.
- In the side column, each card has its own row. In the stacked layout, the cards of one set share a row when each card can be at least 170 px wide; on a narrower row they wrap to more rows.
- A preview is a small, cut render of the content, in a box of a fixed height. A `text` or `markdown` content shows as plain text, as in the option columns: the first 8 lines without blank lines, at most 600 characters, with a fade at the bottom. An `html` content shows in a sandboxed frame at a third of its size; see the frame policy under [HTTP interface](#http-interface). A preview takes no click, no focus and no place in the accessibility tree: a screen reader reads the label and the description of the card. The poll of the page every 2 seconds does not draw the previews again, so a frame does not load again.
- While a request waits for its confirmation, the cards, the note, the buttons, the column comments and Pick this option take no change. So the visible pick, Next round card, note and comments are always the ones of the request, and a retry sends the same request, with the same meaning of the button. After a reload of the page, the panel and the columns show the pick, the suggestion, the note and the comments of a waiting submit of the selected session again. An answer that proves no save unlocks them, and they keep their text.
- An open panel that is too large for one A2UI call (the 64 KB limit below) is built again without the previews. When it is still too large, it shows without the summaries on the option cards and the Next round cards too. The labels, the pickers, the note and the buttons stay. The option columns still show each option summary. An HTML preview goes by the path of its frame, so it adds only that path to the size.

### The A2UI module

`src/a2ui.js` and `src/a2ui.css` are a small A2UI renderer with no external dependency. The page and the tests load the same file.

```js
import { checkA2uiMessages, createA2uiHost } from "./a2ui.js";
checkA2uiMessages(messages);   // { ok: true, messages, surfaces } or { ok: false, error }
const host = createA2uiHost(document, { onAction, onChange });
host.element;                  // Put it in the page.
host.apply(messages);          // { ok, errors }: one boundary for each surface
host.close();
```

- It takes the message kinds `createSurface`, `updateComponents`, `updateDataModel` and `deleteSurface`, and the components of the basic catalog.
- A Button with `action.event` gives the A2UI `action` message to `onAction`. The module sends nothing to a server.
- A control acts only for the current draw of its surface. After a new draw, a delete or a failed draw of the surface, an old Button sends no action and an old field writes nothing.
- `onChange({ surfaceId, path, value })` follows each write of an input to the data model.
- `updateDataModel` refreshes the bound values in place. `createSurface` and `updateComponents` draw the surface again.
- `@checks` take the functions `required`, `length`, `and`, `or` and `not`, and a `@path` binding. A failed check disables a Button and shows its `message`. `required` counts a text of spaces as empty. `length` measures a text; a list or an object fails it.
- The conditions and the messages of `@checks` take their share of the budget of the pass. A rule that the budget cannot finish fails as a whole, also inside `not` or `or`. A click on a Button checks again with a budget of its own.
- The draw uses `createElement` and `textContent` only, and classes for the layout. The page policy stays `script-src 'self'; style-src 'self'`. Only the frames of `walkr_optionDetails` and `WalkrFrame` load a document.

Limits of the module (`A2UI_LIMITS` and `A2UI_DRAW`):

| Limit | Value |
| --- | --- |
| One call | 8 messages, 64 KB of JSON, 200 components, 4 new surfaces, a JSON depth of 32 |
| One surface | 200 components; a tree from `root` that expands to at most 2000 drawn components |
| One draw pass | 2000 component instances, 64 K text characters and 10000 condition steps of `@checks` (a key of a bound object counts as one step). A pass that runs out stops with one line: "Surface too large". |
| One template | 200 items |
| A data model write | An array index from 0 to the array length, at most 999. No path step `__proto__`, `constructor` or `prototype`. |

- The check refuses a key `__proto__` anywhere in a message, an unknown component or property, and a media URL other than `https:` or `http:`. A media item draws only as a link. The check never throws: a value that it cannot read is refused too.
- A `formatString` text is read in one pass. Each character of the template and of each inserted value takes one character of the text budget.
- Each surface has its own boundary. A refused or broken surface shows an error line, and the other surfaces of the call go on.
- Not supported: `regex` and the other check functions (a pattern can stall the page), function call actions, `@accessibility`, `@catalogId` and other catalogs.

### Extensions

The session uses these properties beyond the A2UI v1.0 basic catalog. The check accepts them; other renderers can ignore them.

| Extension | Where | Content |
| --- | --- | --- |
| `walkr_optionDetails` | `@metadata.extensions` of a ChoicePicker | A list of `{ value, description?, recommended?, preview? }`. `value` names one option of the picker. `description` is a text or a binding; it shows below the label, and the filter reads it. `recommended: true` shows the Recommended mark. `preview` is `{ "text": "..." }`, a nonempty literal text that the sender has cut already, or `{ "frame": "/path" }`, a path of the origin of the page: no scheme, no host, no query, at most 2048 characters. A text draws with `textContent`. A frame draws as an `iframe` with `sandbox=""` (no scripts, an opaque origin, no forms, no popups), `tabindex="-1"`, `loading="lazy"` and no scroll bar, at a third of its size. The preview box is `inert` and `aria-hidden`, so a click goes to the option and a screen reader skips it. A chip (`displayStyle: "chips"`) shows no preview. The filter does not read the preview. |
| `walkr_readOnly` | `@metadata.extensions` of a TextField, ChoicePicker or star Slider | `true`, `false` or a `{"@path"}` binding. While it is true, a TextField is read-only and the options of a ChoicePicker are disabled; the value does not change. The panel binds it to `/locked`. |
| `walkr_maxLength` | `@metadata.extensions` of a TextField | A whole number from 1 to 65536: the most characters that the user can enter. The note of the panel has 8000, the limit of the store. The check refuses it on a TextField of the variant `number`, because a browser does not apply the limit to a number field. |
| `walkr_hideLabel` | `@metadata.extensions` of a TextField | `true`. The input keeps its accessible name from `label` and shows no label text. A literal `label` must have nonblank text. |
| `walkr_fold` | `@metadata.extensions` of a Column | A nonblank summary of at most 256 UTF-16 units, or a path binding. Draws `details` with a `summary`. A model update keeps the fold open or closed. |
| `walkr_marks` | `@metadata.extensions` of a Text | Up to 200 sorted, non-overlapping `[start,end]` pairs in literal text. Each range includes the start and excludes the end, in UTF-16 units. Each mark uses one draw instance. |
| `walkr_activeTab` | `@metadata.extensions` of Tabs | A path binding to the zero-based tab index. Selecting a tab writes its index. An absent or invalid index shows the first tab. |
| `walkr_stars` | `@metadata.extensions` of a Slider | `true`. Requires a literal label of 1 to 256 UTF-16 units with some nonblank text, a value binding, min 1, max 10 and 9 steps. Shows ten half-stars as one radio group. Arrow keys stop at the ends. Supports `walkr_readOnly`. |
| `WalkrFrame` | Custom component | `frame` must be the literal option path `/_walkr/compare/o/<64 lowercase hex>/<session-id>/<option-id>`. `label` is a nonblank title of at most 256 UTF-16 units. Draws an iframe with an empty sandbox. No external URL, query or fragment. |
| Text `variant` `h1` to `h5` | Text | A heading. The v1.0 catalog has only `caption` and `body`; the first A2UI prototype of the kit draws the heading variants too. |

The preview builds separate surfaces for the round links, folds, tabs, panes, comments and rating. Long option and source texts use contiguous runs of at most 8000 UTF-16 units in separate calls. No run is a summary. Word matching stops at 64000 total UTF-16 units, one million alignment cells or 200 marks. The decision cards still use short previews. An unchanged poll keeps the reading surfaces and their frames in place.

The option of the v1.0 catalog has only `label` and `value`, with no other key. So the details stand in `@metadata.extensions`, the place of the specification for vendor data. The v1.0 catalog has no property to freeze an input or to limit its entry either, so `walkr_readOnly` and `walkr_maxLength` stand there too.
`filterable` is part of the v1.0 ChoicePicker: it adds a filter field that hides the options without the filter words, and a "No option matches" line. A hidden option keeps its pick. The Compare panel does not set it: it has at most four cards.

The agent gets the pick, the comments, the note and the next round. It then does what you asked for at the start, and saves a short outcome.
A pick does not authorize a deployment, a sent mail or a posted ticket comment.

## Rate a session

Open the fold Rate this session below the decision panel. Its summary shows Not rated or the saved rating, for example "3.5 of 5 stars".
Select a star or a half star, write an optional rating note, and select Save rating.
The fold is closed at the start and for each newly selected session. It stays open while you rate and when the page reads the session again.
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
walkr-compare create -                                       # the JSON request on standard input
walkr-compare open [<session-id>]
walkr-compare list
walkr-compare view <session-id>
walkr-compare wait <session-id> [--timeout <seconds>]
walkr-compare received <session-id>
walkr-compare outcome <session-id> /absolute/outcome.json     # { actionId, summary }
walkr-compare outcome <session-id> -                          # the JSON request on standard input
walkr-compare --here <command> ...                           # run on this computer; ignore the key remote
walkr-compare close                                          # optional Sheprd link only
```

`walkr compare ...` runs the same commands.
`create` prints `{ sessionId, replay, status, url }`, and `sheprd` only when the [Sheprd link](#sheprd-link-optional) is on. `open` prints the page URL of this server run.
`walkr-compare open <session-id>` exits 2 when the session is unknown or the ID is not valid, with the cause on standard error. In [remote mode](#remote-mode), a call that did not reach the remote host or did not get its answer exits 3. Every other failure exits 1. `walkr compare open <session-id>` through the `walkr` command exits 1 for these causes too.
`wait` polls each 500 ms until the result or the timeout (default 240 seconds, maximum 3600). It prints `{ status: "ready", sessionId, receivedAt, result, rating }` or `{ status: "timeout" }`.
Before it prints a result, `wait` sends the receipt, so the page shows "The agent received your result". The receipt is saved one time: a later `wait` prints the same `receivedAt`. On a timeout it sends nothing.
When the receipt fails, for example on an older server, after a network fault, or with an answer that has no ISO time, `wait` still prints the result and exits 0. The JSON then has `"received": false` instead of `receivedAt`, and the cause goes to standard error. The result is never lost because of the receipt.
`received` sends only the receipt and prints `{ sessionId, receivedAt }`. Use it after you read a result with `view`. `view` sends no receipt: a look is not a receipt.
An open session refuses the receipt with `INVALID_TRANSITION`, so `received` then exits 1.
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
  "recommended": "b",
  "nextRounds": [
    { "roundId": "cheaper-b", "label": "Refine B for cost", "summary": "B with one alarm less",
      "preview": { "format": "text", "content": "Queue: order-dlq\nAlarm: queue depth over 10\nNo alarm on message age" } },
    { "roundId": "mix-a-b", "label": "Mix A and B" }
  ],
  "previous": { "sessionId": "20261122T090000Z-0123456789ab", "roundId": "mix-a-c" },
  "options": [
    { "optionId": "a", "label": "A: queue only", "summary": "+1 resource", "format": "html", "content": "<!doctype html>..." },
    { "optionId": "b", "label": "B: queue and alarm", "summary": "+2 resources", "format": "html", "content": "<!doctype html>..." }
  ]
}
```

`clarifications`, `repo`, `source`, `recommended`, `nextRounds`, `previous` and `summary` are optional. Unknown fields are refused.
`recommended` is the `optionId` of the option that the agent recommends. The decision panel marks that option. Another value is refused with `INVALID_REQUEST`.
`nextRounds` holds the suggestions of the agent for one more round: `{ roundId, label, summary?, preview? }`. The decision panel shows them as the Next round cards.
`preview` is an optional sketch of what the round will compare: `{ format, content }`, with the formats and checks of an option content and at most 16 KB (16384 bytes) of content. A larger or empty content, another format or an unknown key gives `INVALID_REQUEST`. The card of the suggestion shows the sketch small and cut.
`previous` links the session to an earlier round: `{ sessionId, roundId? }`. `sessionId` must name a session of this root with a submitted result. `roundId`, when present, must be a `roundId` of the `nextRounds` of that session; a round after `nextRound: "@feedback"` has no `roundId`. The store saves `round`: the round of the earlier session plus 1. A failed rule gives `INVALID_REQUEST` and writes nothing.

Limits: 2 or 3 options, 1 MiB for each option content, 16 KB for the content of each next round `preview`, 8 MiB for each request, at most 12 clarifications, 1 to 4 `nextRounds`, at most 20 rounds in one chain. A session of round 20 takes no `nextRounds`, and its submit takes no `nextRound`.
`workflow` uses 1 to 64 lowercase letters, digits or hyphens. `optionId` and `roundId` use 1 to 64 letters, digits, dots, underscores or hyphens, so no `roundId` is the reserved `@feedback`. Each `roundId` is unique in its list.
A `label` has at most 200 characters, a `summary` at most 2000, for an option and for a next round.
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
A `sheprd` that fails or does not end within 5 seconds never fails the Walkr command. The command then goes on as without the link.
Not verified: Sheprd accepts only loopback URLs and refuses addresses from `HUMAN_REVIEW_ALLOWED_HOSTS`.

`walkr-compare close` runs `sheprd walkr disconnect` and nothing else. It starts no server and prints `{ "sheprd": "disconnected" }`, `{ "sheprd": "failed" }` or `{ "sheprd": null }` when the link is off.
This requests a disconnect; Walkr does not check what happens to the page.
Not verified: Sheprd keeps the page open for a rating after disconnect.
Not verified: the page closes when the owner selects Close in Sheprd, or after 2 hours idle.
While the Compare page keeps making requests, it keeps the Walkr server alive past the default 45 idle minutes.

## Remote mode

Use remote mode when the agents run on one computer and you open the pages on another computer, for example your desktop computer.
The sessions are then stored on that other computer only.

Remote mode uses the key `remote` of the artifacts config file: `~/.config/tenant-artifacts/config.json`, or `$XDG_CONFIG_HOME/tenant-artifacts/config.json` when `XDG_CONFIG_HOME` is an absolute path.
`artifacts setup --remote HOST` writes the key, and `artifacts setup --local` removes it.
So one key moves the artifacts and the Compare sessions to the same host (see the artifacts README, "A remote store over SSH").
A missing file or a missing key means this computer. A file that cannot be read or is not a JSON object, or a value that is not a plain SSH destination, stops the command with exit 1.
This rule also holds on a computer without remote mode: such a file stops each command without `--here`, also a command that ran on this computer before. Fix the file, or run `walkr-compare --here <command>`.

With the key, `create`, `open`, `list`, `view`, `wait`, `received` and `outcome` run on HOST as `walkr-compare --here <command>`, through one `ssh` call each:

1. This computer checks the words of the command. A wrong word gets the same refusal as without remote mode.
2. For `create` and `outcome`, this computer reads the request file of the absolute path. The bytes go on the standard input of `walkr-compare --here create -` (or `outcome <session-id> -`). The request never goes into the command line.
3. `ssh` runs with `BatchMode=yes`, `ConnectTimeout=10`, `-T`, `-a` and `-x`, so HOST needs a key login without a prompt. Each word is quoted for the shell of HOST, so a word such as `$(id)` stays text.
4. HOST runs the `walkr-compare` of its `PATH`, else `~/.local/bin/walkr-compare`. The Walkr server of HOST stores the session.
5. The standard output, the standard error and the exit code of HOST pass through unchanged.

This computer then starts no Walkr server, sends no HTTP request, writes no session and makes no Sheprd link.
HOST makes no Sheprd link either: the remote shell unsets `HERDR_ENV`, so the [Sheprd link](#sheprd-link-optional) is off there.
`close`, `--help` and `--version` always run on this computer. `walkr compare ...` behaves the same as `walkr-compare ...`.
`--here` must be the first word after the program name, for example `walkr-compare --here list`. HOST always gets `--here`, so HOST never forwards the call again.

The page address of `create` and `open` is the address that HOST prints. A loopback address such as `http://127.0.0.1:<port>/...` works on HOST only.
For such an address, one line on standard error says that the address is valid on HOST only. When HOST has a [public origin](#a-public-origin-behind-a-reverse-proxy), the line of `create` says that `localUrl` is valid on HOST only and that `url` is the public address. Standard output stays as HOST wrote it, so the JSON of `create` stays valid.

`wait` holds one `ssh` connection for the whole wait. The limit of the `ssh` call is the `--timeout` of the wait plus 60 seconds. Each other command has a limit of 60 seconds.
When `ssh` ends but a child of it keeps the output open, the command waits 2 seconds more, then uses the output that arrived and the exit code of `ssh`. So a call never takes longer than its limit plus 2 seconds.

Exit 3 means: `ssh` did not get or lost the connection (exit 255), the call reached its limit, a signal ended `ssh`, the `ssh` program did not run, or HOST has no `walkr-compare`.
Exit 3 never falls back to this computer. The message names HOST, says that nothing was written on this computer, and names `walkr-compare --here`.
After exit 3, run `wait` again: it is safe to repeat. A `create` or an `outcome` may have reached HOST. Retry it with the exact same file and action ID: that is safe.

HOST needs this version of Walkr or a newer one. An older `walkr-compare` reads `--here` as a command and exits 1 with "Invalid Compare arguments.".
This computer checks the words first, so it can tell this case apart. It then adds one line that says that HOST needs a newer `walkr-compare`.

For tests only, not a setting: `ARTIFACTS_SSH_COMMAND` replaces the program `ssh`, as in the artifacts CLI. It is a command line in shell words, and `walkr-compare` prints one warning line when it is set.

## Data contract

One record for each session: `<root>/sessions/<session-id>/session.json`.
The record is JSON with `schema: "walkr-compare-session"`, `version: 1`, and a `checksum` of the rest of the record.

| Field | Content |
| --- | --- |
| `sessionId`, `createdAt`, `updatedAt`, `revision` | Session identity, ISO times, and a counter that increases with each commit |
| `status` | `open` or `submitted` |
| `workflow`, `title`, `brief`, `clarifications`, `repo`, `source`, `recommended`, `nextRounds`, `previous` | As supplied in the create request. A next round with a preview keeps `preview: { format, content }`. A record without `recommended`, `nextRounds`, `previous` or a preview reads as before; the schema version stays 1. |
| `round` | Only with `previous`: the round of the earlier session plus 1. A session without it reads as round 1. A session list row and a row of `api/history` have `round` only when it is greater than 1, and `previousSessionId` (the `previous.sessionId`) only when the session has `previous`. The view has no `next` field: the page derives the links to the later rounds from these rows. |
| `options` | `{ optionId, label, summary?, format, content, contentSha256 }` in submitted order. Content is stored exactly. |
| `seenAt` | The time of your first look at the session in the page. Without it, the list shows New. |
| `receivedAt` | The time of the server when the agent first confirmed that it read the submitted result (`wait` or `received`). It is saved one time. A record without it reads as before; the schema version stays 1. The session list has no field for it. |
| `result` | `{ pick, comments, note?, nextRound?, submittedAt }` with its action ID. `pick` is an `optionId` or `null`. `nextRound` is `@feedback` (one more round from the pick, the comments and the note) or the `roundId` of the chosen suggestion; without it the comparison ends. `null` needs a note or a comment, or a `nextRound` that is a `roundId`. |
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

## A public origin behind a reverse proxy

The key `walkrPublicOrigin` of the artifacts config file names one public origin of the Compare page, for example `https://walkr.example.org`.
A reverse proxy on another computer receives the browser and sends the request through an SSH forward to the loopback port of the artifacts server, with the `Host` of the browser unchanged.
`artifacts setup --walkr-public-origin ORIGIN` writes the key; the value rule, the routes of the artifacts server and the proxy contract are in the artifacts README, "A public origin for the Walkr page".
The proxy has the entry guard (a private-network rule and a login). Walkr adds no entry secret.

`create` on the computer of the server, with the key: `url` is `<public origin>/walkr#<session-id>`. It holds no secret: `/walkr` redirects to the page, and the browser keeps the fragment, so the page selects the session.
`localUrl` is the address of today, on this computer. Without the key, the output is as before and has no `localUrl`.
`open` prints the address of today in each case. The [Sheprd link](#sheprd-link-optional) gets the address of today.

The Walkr server reads the key at its start. A value that does not fit the rule writes one line to `errors.log`, and the server then behaves as with no key.
A request with the public host (the name, and the port only when the key names one) and a loopback peer has these rules:

- It reaches only the Compare and Feedback routes and the theme files. `/health` answers 403.
- The agent token is never valid. `api/capabilities`, `api/page`, `POST api/sessions`, `received` and `outcome` answer 401 also with the right agent token, and a view gives no page path.
- A page write (Compare: `seen`, `submit`, `rate`; Feedback: `seen`, `expand`, `respond`, `rate`) needs an `Origin` header equal to the public origin. A write with no `Origin` or another origin gets 403.
- The policy of an HTML option names the public origin with `https` in `frame-ancestors`.

A request that comes to the Walkr port directly with the public host gets the same rules.
A page of the public origin shows all sessions, as the local page does.

## HTTP interface

All Compare routes sit under `/_walkr/compare/` and refuse query strings. The Host must be loopback or an exact `HUMAN_REVIEW_ALLOWED_HOSTS` entry. A loopback connection peer may send a loopback Host (`127.0.0.1`, `localhost`, `[::1]`) with any port for the Compare and Feedback routes and the theme files `/theme.css` and `/theme.js`, so a local front such as the artifacts server or a Sheprd tunnel can pass the page with its own Host. The health check `/health` still needs the port of the Walkr server in the Host. Feedback uses `/_walkr/feedback/`. A request that only this any-port rule admits has one more rule for the page writes `seen`, `submit` and `rate`: after the credential check, an `Origin` header that is present must be an HTTP origin with the host name and the port of the Host (compared in lower case, with a numeric port), or the write gets 403. A write without `Origin` passes. A request that the own port or an allowed host admits has no Origin check. A request with the host of the public origin has the rules of [A public origin behind a reverse proxy](#a-public-origin-behind-a-reverse-proxy). With the old variable `HUMAN_REVIEW_HOSTED=1`, each Compare route answers 403 `HOSTED_UNSUPPORTED`: hosted mode is retired.

| Route | Credential | Purpose |
| --- | --- | --- |
| `GET api/capabilities` | Agent | `{ compare: 1, rootId }` |
| `GET api/page` | Agent | The private page path of this server run |
| `POST api/sessions` | Agent | Create a session; returns the page path with the session ID as the fragment |
| `GET api/sessions` | Agent or page | The session list, oldest first |
| `GET api/sessions/<id>` | Agent or page | One record |
| `GET api/history` | Agent or page | `{ rows }`: one row for each Compare session, newest first. A row has `ref` (the session ID), `type` (`compare`), `title`, `time` and the fields of the session list. A record that cannot be read gives a row with `error` and `state`. |
| `POST api/sessions/<id>/seen` | Page only | `{}`; saves the first look |
| `POST api/sessions/<id>/submit` | Page only | `{ actionId, pick, comments?, note?, nextRound? }`. `nextRound` is `@feedback`, or a `roundId` of the `nextRounds` of the session; leave it out to end the comparison. A session of round 20 refuses each `nextRound`. |
| `POST api/sessions/<id>/rate` | Page only | `{ actionId, rating, note? }`; `rating` is a whole number from 1 to 10 |
| `POST api/sessions/<id>/received` | Agent | `{}`; saves `receivedAt` one time and returns `{ receivedAt, replay }`. A later call returns the same time. An open session gets 409 `INVALID_TRANSITION`; the page credential gets 403. |
| `POST api/sessions/<id>/outcome` | Agent | `{ actionId, summary }`; only after a submitted result, once |
| `GET g/<capability>` | None (capability URL) | The page |
| `GET a/<capability>` (WebSocket) | None (capability URL) | The A2UI v1.0 socket of open sessions for the local panel (submit only) |
| `GET o/<capability>/<id>/<optionId>` | None (capability URL) | The document of one HTML option, for its frame and the frame of its preview |
| `GET o/<capability>/<id>/next/<roundId>` | None (capability URL) | The document of the HTML `preview` of one next round, for the frame of its preview |

The agent credential cannot submit, rate or mark a session as seen.
It can confirm that it received a submitted result (`received`) and save its outcome. The page credential cannot send these two writes.
The agent relays the page URL to you, so it can reach the page credential.
This split guards against mistakes, not against a hostile or steered agent. Option content is untrusted and can try to steer the agent.

An HTML option and the HTML preview of a next round get the policy `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox`.
The preview frame of the decision panel has the same empty `sandbox` attribute as the option frame, so a preview has no right that an option frame does not have.
The frame has an opaque origin, runs no script, sends no form and cannot read the page or another option.
The policy also has `frame-ancestors 'self'` and the origin of the request, so only the Compare page of this server frames an option. The named origin is for Servo 0.8 (Sheprd pages), which compares `'self'` with the opaque origin of the option.

### The A2UI socket

`GET /_walkr/compare/a/<capability>` upgrades to an RFC 6455 WebSocket (`Sec-WebSocket-Version: 13`, no extension, no subprotocol) so a local panel can draw the decision surface of each open Compare session and send the owner's submit.

- **What it shows**: on connect, one A2UI v1.0 `createSurface` per open session of the root, newest first. Each surface uses the session ID as its `surfaceId` (at most 64 characters) and the content of `decisionMessages()` with its size fallback plus one `Text` component bound to `/status` for error messages. While at least one socket is open, one shared poll reads open sessions once a second; a new open session gets `createSurface` within 2 seconds, and a session that closes (a submit on the page or another socket, or a removal) gets `deleteSurface` within 2 seconds. After `deleteSurface`, a surface ID needs a new `createSurface` before any update.
- **Local only**: the upgrade listener admits only a loopback `Host` with this server's port and a loopback peer. A local front `Host` of another port, a host in `HUMAN_REVIEW_ALLOWED_HOSTS`, `walkrPublicOrigin`, `HUMAN_REVIEW_HOSTED=1`, the read-only mirror, any query or fragment, and any `Origin` header are refused with a plain HTTP error response and never reach the request handlers.
- **Capability**: `<capability>` is the secret of the private page path `g/<capability>` of this server run, compared in constant time. A wrong capability gets the same 404 as a wrong page path. The socket has submit rights only (never create, `received`, `outcome`, `seen` or `rate`); the agent token is not a socket credential.
- **Limits**: at most 4 open sockets (a fifth upgrade gets 503), a 10-second handshake timeout, a 1 MiB send queue per socket (a slower client is closed with 1008), at most 8 live surfaces per connection, at most 4 new surfaces, 8 messages and 64 KB of UTF-8 per server frame (each checked with `checkA2uiMessages()` before sending), and masked client text frames with `FIN` only of at most 16 KiB (over 16 KiB closes with 1009 before reading the payload; binary, continuation, fragmented and unmasked frames close with 1003/1002). Open sockets count as server use and keep the server alive past the 45-minute idle exit; server shutdown closes each socket with 1001.
- **Error path**: a `submit` action runs through the same server submit function as `POST api/sessions/<id>/submit`, with no comments and with `context.sessionId` equal to the surface ID. An accepted submit or an `already-submitted` store reply sends `deleteSurface` for that surface on the same socket. A refused submit, an unsupported action name or a malformed action targeting a live surface sends one `updateDataModel` with the error text at `/status` and keeps the surface so the user can retry. An unknown surface ID or a malformed frame with no live surface closes the socket with 1008.

## Settings of the server

| Variable | Effect |
| --- | --- |
| `HUMAN_REVIEW_COMPARE_ROOT` | The root of the Compare sessions. The default is `~/.local/.walkr/compare`. |
| `HUMAN_REVIEW_STATE_DIR` | The state directory. The default is `~/.human-review`. It holds the server record `server.json` and the private error log `errors.log`. |
| `HUMAN_REVIEW_PORT` | A fixed port for the server. The default is a free port. |
| `HUMAN_REVIEW_BIND` | The address that the server listens on. The default is `127.0.0.1`. `0.0.0.0` listens on every interface. |
| `HUMAN_REVIEW_ALLOWED_HOSTS` | Extra `Host` header values that the server accepts, as a comma-separated list of exact `name:port` values. The default is none. Such a host reaches the Compare and Feedback routes and the theme files, not `/health`. |
| `HUMAN_REVIEW_IDLE_MS` | The idle time before the server stops. The default is 45 minutes. A `/health` check does not count as use. An open page keeps the server running: it reads every two seconds. |
| `HUMAN_REVIEW_SWEEP_MS` | How often the server checks the idle time and its files. The default is 60 seconds. Tests use a short value. |

A server error answers with `Request failed. Reference: WR-<code>`. The code identifies an entry in `errors.log` in the state directory.

## Tests

`test/compare.test.js` uses real authenticated HTTP servers, disposable roots, jsdom for the page module, and the spawned command with its background server.
`test/a2ui.test.js` covers the A2UI module: the refusals of the check, the draw budget (also for `@checks`), one boundary for each surface, the controls of a replaced or deleted surface, the arrow keys and the filter of the picker, and the preview of a card.
`test/compare-mirror.test.js` covers the GET-only mirror and the copy script.
`test/retired-routes.test.js` proves that the write routes of the retired modes answer 404 and create no file.
`test/server-lifetime.test.js` covers the idle stop and the replacement of a server of an older protocol.
`test/compare.test.js` covers the exact option bytes, one final result, a restart, a changed record, the rating limits and replacement, the New mark,
refused create requests, the frame policy, hosted refusal, and the page with its list, selectors, pick, the two buttons, the Next round cards, rating and steps.

## Limits

- The agent can reach the page credential through the URL that it relays.
- One page credential reads and rates every session of the root. There is no per-session page.
- One server process owns a root. Two servers on the same root are not supported; the record check refuses outside changes but is not a lock.
- A result is final after Submit. There is no edit and no second round in the same session. A new round is still a new session, now linked to the earlier one through `previous`.
- Rendering of a template or a diagram is the work of the agent. Walkr does not parse CloudFormation and does not check that a diagram matches its template.
- The background server stops after the idle time of `HUMAN_REVIEW_IDLE_MS` (default 45 minutes) when no page is open. A `/health` check does not count as use. The server also stops when its state directory or its `server-entry.js` file is deleted. The page URL then changes.
- In remote mode, the page address of a loopback server works on the remote host only. A public address for the LAN is not part of this version.
- The server listens on `127.0.0.1` only. To open the page from another computer, start the server with `HUMAN_REVIEW_BIND=0.0.0.0` and `HUMAN_REVIEW_PORT`, and name the address in `HUMAN_REVIEW_ALLOWED_HOSTS`, for example `desk.example:4802`. `walkr-compare` then prints the URL with that address. The named address serves the shared Compare and Feedback page and its files. The health check requires a loopback Host with the port of the server and a loopback connection peer. The traffic is plain HTTP, and only the secret in the URL protects the page.
- To read the sessions of more than one computer on one persistent page, use the optional [mirror](../mirror/README.md). It is read-only, and no install step starts it.
- `walkr-compare` stops a server of an older Walkr version that still runs for the same state directory, then start a new one. A record without a protocol counts as older. It stops it only when its `/health` answer has the pid of `server.json`. When the stop fails, the command says so; stop the server by hand, then run the command again. It never stops a server of a newer Walkr version: the command fails and starts no server. Use that newer version, or set another `HUMAN_REVIEW_STATE_DIR`.
- Not verified: accessibility with assistive technology, and option quality from a real model.
