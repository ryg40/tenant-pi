# Feedback

Walkr Feedback renders smaller chunks of work in the same private Walkr page as [Compare](compare.md):

- a single **component** preview (HTML, text, or Markdown) with a feedback comment box and `Accept` / `Another round` buttons;
- a **series of decisions** arranged in a deterministic **tree layout** (`parentId` and `branchLabel`, with already-settled branches shown compactly);
- a **grill-me session** where Option 1 (recommended) renders immediately with a thorough explanation and a small sandboxed HTML concept overview, and clicking **Expand** asks the waiting runner worker to populate Options 2 and 3 with the same rich explanation and HTML concept overview on demand without clearing browser drafts.

Feedback starts the same background Walkr server as Compare (server protocol 11). Sessions appear in the unified session list beside Compare sessions and share the theme switcher (`Torch Light`, `Torch Dark`, `Lavender Light`, `Lavender Dark`), sandboxing, ratings, remote mode, and artifacts server pass.

## Three item kinds

Each Feedback session holds 1 to 12 deterministic items (`items`). Every item has a `kind`, a `status` (`open`, `settled`, or `skipped`), an `actions` preset, and optional tree links (`parentId`, `branchLabel`).

| Kind | Purpose | Visual content | Owner controls |
| --- | --- | --- | --- |
| `component` | Review a single UI chunk, diagram, or code/copy snippet | `preview` (`html`, `text`, or `markdown`) and optional `explanation` | Comment box + `Accept` / `Another round` (or `Accept` only) |
| `decision` | Choose one direction among 2 or 3 options (optionally linked in a tree) | Per-option `summary`, `explanation`, and small `overview` (`html`, `text`, or `markdown`) | Radio choices + Custom option + `Expand` button (when options have `expandable: true`) + comment box + contextual action buttons |
| `grill` | Grill-me question where Option 1 starts expanded with a robust explanation and small HTML concept overview | Same as `decision`, designed for lazy expansion of Options 2 and 3 | Same as `decision` |

### Action presets

Every open item declares an explicit `actions` preset (default `accept-revise` for `component`, `submit-revise` for `decision` and `grill`):

| Preset | Buttons |
| --- | --- |
| `accept-revise` | `Accept`, `Another round` |
| `submit-revise` | `Submit`, `Another round` |
| `accept-only` | `Accept` |
| `submit-only` | `Submit` |

Validation rules are enforced identically in the browser UI and in the store:

- For `component`: `Accept` works with or without a comment; `Another round` requires a non-empty comment explaining what to change.
- For `decision` and `grill`: `Accept` or `Submit` requires picking an option, or choosing Custom with a non-empty comment; `Another round` requires either a pick or a comment.
- The first saved response for an item is final.

## Tree layout and hybrid submission

When any item specifies `parentId` (or `layout` is `"tree"`), the page renders items as an indented decision tree with optional `branchLabel` connectors. Already-decided parent nodes (`status: "settled"` with `settledAnswer`) render as compact read-only chips so the owner sees the decision trail without scrolling past settled options.

Submission works in hybrid mode:

- **Expand** always fires immediately to the server, waking the waiting runner worker while keeping every typed comment and radio selection intact in `localStorage`.
- **Single-item chunks** submit directly when you click `Accept`, `Submit`, or `Another round`.
- **Multi-item trees and grills** save drafts per session in `localStorage`. You can submit one item at a time (each item's own buttons), or fill out multiple items and click **Submit all ready** in the sticky batch dock along with an optional overall session note.

## Lazy on-demand Expand flow

1. The runner worker creates a session with Option 1 already expanded (`explanation` + small HTML `overview`) and Options 2 and 3 marked `"expandable": true` with concise `summary` lines.
2. The runner worker starts `walkr-feedback wait <session-id> --timeout 240 --after-revision 0`.
3. If the owner wants more detail on Options 2 and 3 before deciding, they click **Expand options 2 & 3** (or **Expand this option** on a single option).
4. The page sends `POST /_walkr/feedback/api/sessions/<id>/expand`. The waiting runner worker wakes immediately with `{ "status": "expand", "expand": [{ "itemId": "...", "optionIds": ["opt-2", "opt-3"] }] }`.
5. The runner worker generates the rich explanations and small HTML concept overviews from the coordinator's brief and runs `walkr-feedback patch <session-id> <patch.json>`.
6. Within one poll cycle (2 seconds), the page updates live with the newly expanded explanations and sandboxed HTML concept overviews while keeping the owner's radio selection and typed comment drafts intact.

## Coordinator and runner worker split

Walkr Feedback is designed to offload session rendering and wait/expand polling to a fast, capable runner worker:

- The **coordinator** supplies a detailed brief specifying the exact items, decision tree links, button presets, option facts, and visual overview guidance.
- The **runner worker** renders the small sandboxed HTML overviews, creates the session, hands the URL back to the coordinator, handles any **Expand** requests autonomously via `patch`, and returns structured owner responses when the owner clicks `Accept`, `Submit`, or `Another round`.

The default runner uses `claude2` with `claude-opus-5-5` at thinking `medium`. This needs the `claude2` launcher on `PATH` and a signed-in second Claude account with access to that model. If either is unavailable, give the same brief to your configured worker. Alternatives include `agy` with `neon` or `pi` with `astra`, both at thinking `medium`, when configured.

## Commands

`walkr-feedback` and `walkr feedback` run the same commands:

```sh
walkr-feedback create /absolute/request.json
walkr-feedback open [session-id]
walkr-feedback list
walkr-feedback view <session-id>
walkr-feedback wait <session-id> [--timeout <seconds>] [--after-revision <n>]
walkr-feedback patch <session-id> /absolute/patch.json
walkr-feedback received <session-id>
walkr-feedback outcome <session-id> /absolute/outcome.json
walkr-feedback close
```

- Pass `-` in place of a file path on `create`, `patch`, or `outcome` to read JSON from standard input.
- `wait` returns immediately with `"status": "expand"` when an Expand request is pending, or `"status": "ready"` (after sending the receipt so the page shows "The agent received your response at ...") when `lastResponseRevision > afterRevision`, or `"status": "timeout"` after the timeout elapses (default 240 s, max 3600 s).
- `HUMAN_REVIEW_FEEDBACK_ROOT` overrides the session storage directory (default `~/.local/.walkr/feedback`).

### Example create request

```json
{
  "actionId": "fb-banner-1",
  "workflow": "component-review",
  "title": "Status banner component",
  "brief": "Check spacing and hierarchy of the compact alert banner before wiring it into the header.",
  "layout": "single",
  "items": [
    {
      "itemId": "banner",
      "kind": "component",
      "title": "Compact warning banner",
      "summary": "Single-row warning with inline retry button",
      "actions": "accept-revise",
      "preview": {
        "format": "html",
        "content": "<!doctype html><html><body style=\"font-family:system-ui;margin:16px;background:#fff;color:#111\"><div style=\"padding:10px 14px;border:1px solid #d97706;border-radius:8px;background:#fffbeb\">Sync paused: retry when online.</div></body></html>"
      }
    }
  ]
}
```

## Security and sandboxing

- Every HTML `preview` and option `overview` renders in a sandboxed iframe (`sandbox=""`) served under `/_walkr/feedback/o/<capability>/<session-id>/<item-id>/<preview|option-id>` with `default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'; sandbox` and a strict `frame-ancestors` policy. No script runs and no network request leaves the frame.
- Browser writes (`seen`, `expand`, `respond`, `rate`) require the page token and are refused for the local agent token. Agent writes (`create`, `patch`, `received`, `outcome`) require the local agent token and are refused for the page token and for public-origin requests.
- Behind the local artifacts server or a configured `walkrPublicOrigin`, page writes enforce the same `Origin` check as Compare.
- Remote mode (`artifacts setup --remote HOST`) forwards `create`, `open`, `list`, `view`, `wait`, `patch`, `received`, and `outcome` over SSH using `walkr-feedback --here`, matching Compare's exit-code and retry contract.
