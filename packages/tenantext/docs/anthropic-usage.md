# Anthropic usage

`extensions/anthropic-usage/` meters the Anthropic subscription quota in the operations footer. It needs no settings on a machine that has an active Claude Code login or an active Pi `anthropic` OAuth login.

The extension only reads. It never refreshes a token and never writes a credential file.

## Verification state

| Fact | State |
| --- | --- |
| The payload shape of the usage endpoint (`five_hour`, `seven_day`, `seven_day_opus`, `seven_day_sonnet`, each with `utilization` and `resets_at`) | Observed in a live response of the endpoint. Not verified again through this extension |
| Parsing, detection, the footer row, the report and the doctor check | Verified with fixture tests. The tests use an injected fetch and injected file readers |
| A live request from this extension inside Pi | Not verified |
| The extension loads in a generated profile of the kit | Not verified |
| The Pi `anthropic` OAuth login as a source | Not verified live. The tests use a fixture credential |
| The Claude Code login on macOS | Not verified. Claude Code can keep the login in the macOS keychain. Then the file does not exist and this source is absent |
| The set of `subscriptionType` values | Not verified. The allow-list holds `free`, `pro`, `max`, `team` and `enterprise` |

## Request

`GET https://api.anthropic.com/api/oauth/usage` with these headers:

| Header | Value |
| --- | --- |
| `Authorization` | `Bearer <OAuth access token>` |
| `anthropic-beta` | `oauth-2025-04-20` |
| `Accept` | `application/json` |

The request is read-only. It times out after 15 seconds. It follows no redirect. The extension does not read the body of an error response.

| Response field | Meter |
| --- | --- |
| `five_hour` | `5h` window |
| `seven_day` | `7d` window |
| `seven_day_opus` | `opus` window, when the field is not null |
| `seven_day_sonnet` | `sonnet` window, when the field is not null |
| `utilization` | The percent used, 0 to 100. The meter shows `100 - utilization`, limited to 0 to 100 |
| `resets_at` | The reset time. The extension converts it to a UTC time with milliseconds |

The extension ignores every other field of the response. A window that is null, or that has no numeric `utilization`, is dropped. A response with no known window is not a reading.

## Credential sources

| Order | Source id | Where |
| --- | --- | --- |
| 1 | `claude-code` | The Claude Code file `~/.claude/.credentials.json`, object `claudeAiOauth`. The extension reads `accessToken`, `expiresAt` (epoch milliseconds) and `subscriptionType`. `CLAUDE_CONFIG_DIR` replaces `~/.claude` when it is set |
| 2 | `pi` | The Pi stored credential for the provider `anthropic`, only when its type is `oauth` and it has `access` and `expires` |

A credential is active only when all of these are true:

- The token is a string of printable characters with no space.
- The expiry time is a number.
- The expiry time is later than the current time.

An API-key credential has no subscription quota. The extension treats it as absent. A token past its expiry is absent. The owner of the login refreshes it: Claude Code for the file, Pi for the Pi login.

The meter tries each active credential in order. HTTP 401 or 403 moves to the next one. Any other failure stops the walk.

## States

| State | Footer |
| --- | --- |
| A source gives a reading | A `Claude` row (short form `CL`) after the Codex accounts and before Copilot: `Claude [5h 72%] [7d 41%]` |
| No active credential, or `mode: off` | Nothing, and no request. An earlier reading is not reused |
| An active credential, but the request fails or the response has no known window (`mode: auto`), with an earlier good reading | The row stays with the last good reading and no error chip. The snapshot state is `unknown`. This lasts until a window of that reading resets, or until the reading is 24 hours old |
| The same failure with no earlier good reading, or after that limit | Nothing. `/anthropic-usage` shows the fixed error text |
| A failed request with `mode: on`, or no active credential with `mode: on` | `Claude ✗ error` |
| A window at 25% or less / 10% or less | Amber `⚠` / red `✗` chip with its reset time |

The plan comes from `subscriptionType` through the allow-list. It shows in `/anthropic-usage`, in the doctor line and in `/ops-footer report`. The footer row does not show the plan. The Pi login has no plan field, so that source reports no plan.

## Refresh

The footer asks for a refresh on its health poll. The meter answers at most once per `pollSeconds` (default 300). When the provider of the active model is `anthropic`, a settled turn refreshes after 60 seconds.

Events: the extension publishes `tenantext:anthropic:status`. It listens for `tenantext:anthropic:refresh`.

## Commands

| Command | Effect |
| --- | --- |
| `/anthropic-usage` or `/anthropic-usage report` | Probe the sources and show the windows, the plan and the source in use |
| `/anthropic-usage refresh` | Same, and update the footer |
| `/anthropic-usage help` | Show the command help |

`/tenantext-doctor` adds one `anthropic` line. It makes the same read-only request when an active credential exists.

## Settings

Optional file: `~/.pi/agent/anthropic-usage/settings.json` (or under `PI_CODING_AGENT_DIR`).

```json
{ "mode": "auto", "sources": ["claude-code", "pi"], "pollSeconds": 300 }
```

| Key | Values |
| --- | --- |
| `mode` | `auto` (default), `on` (also show an error chip), `off`. `TENANTEXT_ANTHROPIC_USAGE` overrides it |
| `sources` | Any subset. The order is fixed: `claude-code`, then `pi`. Unknown ids are ignored |
| `pollSeconds` | 60 to 3600 |

## Privacy

The token stays inside the Authorization header. The bus snapshot, the footer, `/anthropic-usage` and the doctor name the source id, never the value and never a file path. The snapshot holds only the state, a fixed error text, the source id, the plan, the window labels, the percents and the reset times. Error text is one of a fixed set of strings, for example `HTTP 401`.

The footer adapter accepts only the window labels `5h`, `7d`, `opus` and `sonnet`, the source ids `claude-code` and `pi`, and the five plan values. Any other value does not cross.

Warning: The extension reads a live OAuth access token from a file of another program. Keep `~/.claude/.credentials.json` at mode `0600`.
