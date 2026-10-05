# Copilot usage

`extensions/copilot-usage/` meters GitHub Copilot quota in the operations footer. It works without settings on any machine that already uses Copilot.

Example quota chip: `Copilot premium 83%`. The footer places it after any Codex account chips.

## Request

`GET https://api.<domain>/copilot_internal/user` with `Authorization: token <GitHub OAuth token>`. The domain is `github.com` unless the credential names a GitHub Enterprise domain. Copilot editors call the same endpoint. The request is read-only, times out after 10 seconds, and follows no redirects.

| Response field | Meter |
| --- | --- |
| `quota_snapshots.premium_interactions` | `premium` window (paid plans) |
| `quota_snapshots.chat`, `.completions` | `chat` and `compl` windows when they are limited (free plan) |
| `limited_user_quotas` against `monthly_quotas` | Older free-plan shape, same windows |
| `quota_reset_date_utc`, `quota_reset_date` | Reset time for every window |
| `copilot_plan`, `access_type_sku` | Plan label in the report (`free` for a `free_limited_copilot` SKU) |

Buckets with `unlimited: true` or `has_quota: false` are dropped. A plan with nothing limited shows no Copilot group.

## When the meter turns on

In `auto` mode (the default) the meter probes nothing until Pi has a Copilot provider configured. Any one of these counts:

| Signal | Where |
| --- | --- |
| Pi login | A `github-copilot` entry in Pi's `auth.json` (`/login github-copilot`) |
| Pi variable | `COPILOT_GITHUB_TOKEN`, the variable Pi's `github-copilot` provider reads |
| Pi settings | `defaultProvider: "github-copilot"`, or an `enabledModels` entry that starts with `github-copilot/` |

A general GitHub token never counts: every GitHub account carries free-tier Copilot, so `GH_TOKEN`, `GITHUB_TOKEN`, or a `gh` login alone would show a meter for a Copilot that is not in use. Those tokens serve only as fallback credentials once a provider is configured. `mode: on` skips the check.

## Credential sources

| Order | Source id | Where |
| --- | --- | --- |
| 1 | `pi` | Pi's `github-copilot` OAuth login in `auth.json`. Pi keeps the GitHub token in `refresh`; the meter uses that token, never the Copilot session token |
| 2 | `env` | `COPILOT_GITHUB_TOKEN`, then `GH_TOKEN`, then `GITHUB_TOKEN`. `GH_HOST` sets the domain |
| 3 | `editor` | `$XDG_CONFIG_HOME/github-copilot/` or `~/.config/github-copilot/` `apps.json` and `hosts.json` (`%LOCALAPPDATA%` on Windows) |
| 4 | `copilot-cli` | `$COPILOT_HOME/config.json` or `~/.copilot/config.json`, token-named keys only |
| 5 | `gh` | `gh auth token --hostname <domain>`, from `PATH`, `/opt/homebrew/bin`, `/usr/local/bin`, or `/usr/bin` |

Only strings shaped like GitHub tokens (`gho_`, `ghu_`, `ghp_`, `github_pat_`) count. The meter tries each candidate in order. HTTP 401, 403, or 404 moves to the next one. A network failure stops the walk, because the next token fails the same way. The winning source is reused until it fails.

## States

| State | Footer |
| --- | --- |
| A source is accepted | `Copilot premium 83%` chip after the Codex accounts |
| No Copilot provider configured in Pi (`mode: auto`), or `mode: off` | Nothing, and no request |
| Provider configured (or `mode: on`), but no source is found or every source is refused | `Copilot ✗ error` |
| Premium at 25% or less / 10% or less | Amber `⚠` / red `✗` chip with its reset time |

## Refresh

The footer asks for a refresh on its health poll. The meter answers at most once per `pollSeconds` (default 300). When the active model's provider is `github-copilot`, a settled turn refreshes after 60 seconds, because premium requests are spent per request.

## Settings

Optional file: `~/.pi/agent/copilot-usage/settings.json` (or under `PI_CODING_AGENT_DIR`).

```json
{ "mode": "auto", "sources": ["pi", "env", "editor", "copilot-cli", "gh"], "domain": "github.com", "pollSeconds": 300 }
```

| Key | Values |
| --- | --- |
| `mode` | `auto` (default: only with a Copilot provider in Pi), `on` (probe every source), `off`. `TENANTEXT_COPILOT_USAGE` overrides it |
| `sources` | Any subset, in any order of preference; unknown ids are ignored |
| `domain` | A GitHub Enterprise domain such as `acme.ghe.com` |
| `pollSeconds` | 60 to 3600 |

`/tenantext-doctor fix` writes this file with the working source first.

## Privacy

Tokens stay inside the Authorization header. The bus snapshot, the footer, `/copilot-usage`, and the doctor name the source id and the file or variable name, never the value. The login name and organization list in the response are not read.
