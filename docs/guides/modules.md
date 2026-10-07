# Module guide

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Each component of `config/manifest.json` is one row below. Core Pi is always on. Every other component is optional and independent: enable it, or leave it in `selection.disable`.

The table is the state of this release. It is not a claim that a module works on a clean client.

## Status labels

The manifest has three statuses. This guide maps them to four labels. The same labels are in [the setup guide](setup.md#labels-for-a-prerequisite).

| Label | Meaning | From |
| --- | --- | --- |
| `blocked` | The kit refuses to enable the module. `validate` stops with `blocked_component: overlay.selection.enable`. | Manifest status `blocked`. Also a refused choice, for example the gateway with `auth: "login"` (`pi_login_blocked`). |
| `skipped` | The user did not enable the module. Nothing is generated for it. | The module is in `selection.disable`. This is the default of every module except `core`. |
| `unverified` | The kit validates, plans and generates the module offline. No accepted live trial proves that Pi loads it and that it works. | Manifest status `tested` or `unverified`, when the module is enabled. |
| `ready` | The module passed an accepted live trial on the qualified platform. | No module has this label in this release. |

The manifest status `tested` means: the pin and the structure passed an offline review. It does not mean a clean-client trial. The manifest status `unverified` means: the module is in the tree and selectable, and the plan lists its `gaps` as readiness gaps. So both map to `unverified`.

Not verified: loading all selectable Tenantext components with the kit pin. The labels stay `unverified`.

## Components

Columns:

- **Required inputs**: the overlay fields and files the module needs, beyond `selection.enable`.
- **Maintained source (pin)**: the `source` of the manifest. `tree` is a package directory in this kit.
- **Credential method**: how a credential reaches the module. The kit never stores one.
- **State scope**: where the module or Pi keeps data at run time. "Profile" is the target directory. "HOME" is shared by every profile of the user.
- **Consent**: an explicit overlay switch that the module needs.
- **Status**: manifest status, then the label when enabled.

| Component | Required inputs | Maintained source (pin) | Credential method | State scope | Consent | Status |
| --- | --- | --- | --- | --- | --- | --- |
| `core` | `target.agentDir` | npm `@earendil-works/pi-coding-agent@<pin>` | Pi native `/login` after launch; Pi writes `auth.json` | Profile: `auth.json`, `sessions/`, `npm/` | none | `tested`, `unverified` |
| `model-routing` | `roles`, optional `modelRoutes`; `--registry` file when `modelRoutes` names a model | builtin Pi settings | Native provider `/login` | Profile: `settings.json` keys | none | `tested`, `unverified` |
| `tenantext` | none | tree `packages/tenantext` | none | Profile. Not verified: other paths. | none | `unverified`, `unverified` |
| `codex-accounts` | `modelRoutes.gateway` `{"auth": "env"}`, `endpoints.codex-accounts` (HTTPS URL that ends in `/v1`), `env.codex-accounts` `${TENANTEXT_LITELLM_API_KEY}` | tree `packages/tenantext` | `TENANTEXT_LITELLM_API_KEY` in the launching shell; `TENANTEXT_LITELLM_BASE_URL` on the launch line. `auth: "login"` is `blocked`. | Profile | none | `unverified`, `unverified` |
| `slopscore` | none | tree `packages/tenantext` | none | Not verified | none | `unverified`, `unverified` |
| `context-meter` | none | tree `packages/tenantext` | none | Profile | none | `unverified`, `unverified` |
| `ops-footer` | `context-meter` enabled | tree `packages/tenantext` | none | Profile; reads `~/.copilot` (source reading) | none | `unverified`, `unverified` |
| `copilot-usage` | none | tree `packages/tenantext` | Reads `GITHUB_TOKEN`, `GH_TOKEN`, `gh auth` and `~/.copilot` (source reading) | HOME, shared | none | `unverified`, `unverified` |
| `anthropic-usage` | none | tree `packages/tenantext` | Reads the Claude Code login file `~/.claude/.credentials.json` (or under `CLAUDE_CONFIG_DIR`) and the Pi `anthropic` OAuth login. Read-only: no refresh, no write (source reading). Sends one GET request to `api.anthropic.com` per poll, only with an active login. Not verified live | HOME, shared | none | `unverified`, `unverified` |
| `doctor` | none | tree `packages/tenantext` | Reads `TENANTEXT_LITELLM_BASE_URL` for one line. Sends one read-only GET request to the Copilot usage endpoint and one to the Anthropic usage endpoint, each only when a login for it exists (source reading). Not verified live | Profile; reads `~/.copilot` through the `copilot-usage` files and `~/.claude/.credentials.json` through the `anthropic-usage` files (source reading) | none | `unverified`, `unverified` |
| `resources` | none | tree `packages/tenantext` | none | Profile: `settings.json` toggles | none | `unverified`, `unverified` |
| `herdr` | the `herdr` tool on `PATH` | tree `packages/tenantext`, `skills/herdr` | none | Herdr state, outside the profile | none | `unverified`, `unverified` |
| `coordinator-skills` | On Pi: the `ask_user_question` tool of an extension that the kit does not install; without it the skill asks in plain text. For a search, a research ticket and a prototype ticket: the `herdr` skill. `wayfinder` needs `docs/agents/issue-tracker.md` and a Gitea tracker. The knowledge sources and the review tools that the skills name are host tools that the kit does not install | tree `packages/tenantext`, each skill directory below `skills/coordinator-skills/`; [the component README](../../packages/tenantext/skills/coordinator-skills/README.md) lists them | `GITEA_TOKEN` in the shell that starts the harness, for `to-spec`, `to-tickets` and `wayfinder`; the skills read it for the Gitea API and do not write it | The Gitea issue tracker, outside the profile | none | `unverified`, `unverified` |
| `knowledge-skills` | OpenKnowledge MCP server and `ok` CLI for tool-backed workflows; the kit installs neither | tree `packages/tenantext`, each skill directory below `skills/knowledge-skills/`; [the component README](../../packages/tenantext/skills/knowledge-skills/README.md) lists them | Configure external tools separately; no credential in the component | OpenKnowledge project and editor skill directories, outside the profile | none | `unverified`, `unverified` |
| `slopscore-pr` | host tools of the skill | tree `packages/tenantext`, `skills/slopscore-pr` | Not verified | Not verified | none | `unverified`, `unverified` |
| `tracker-site` | Python 3.11 or later and Git on `PATH`; `PYTHONPATH` set to `packages/tenantext`; no third-party Python package. `check-runtime` checks Python, not Git | tree `packages/tenantext` | Optional issue and publication credentials; see [configuration](../../packages/tenantext/skills/tracker-site/references/configuration.md) | Repository brief and separate tracker state directory | none | `unverified` |
| `promptr` | `npm ci --ignore-scripts` and `npm run build` in `packages/promptr` | tree `packages/promptr` | none | Profile: `promptr/`; project `.promptr/` | none | `unverified`, `unverified` |
| `promptr-generate-task-prompt` | `promptr` | tree `packages/promptr` | none | as `promptr` | none | `unverified`, `unverified` |
| `promptr-handoff` | `promptr` | tree `packages/promptr` | none | as `promptr` | none | `unverified`, `unverified` |
| `promptr-openknowledge-project-pages` | `promptr`, an OpenKnowledge service | tree `packages/promptr` | Not verified | as `promptr` | none | `unverified`, `unverified` |
| `promptr-watch-herdr-agents` | `promptr`, the `herdr` tool | tree `packages/promptr` | none | as `promptr` | none | `unverified`, `unverified` |
| `mcp` | `inputs.mcpFile` `"inputs/mcp-adapter.json"` and that file under `--local-dir` | npm `pi-mcp-adapter`, no version; reviewed at 3.2.0 | `${NAME}` references in headers and env, exported by the user. OAuth and bearer stores use the OS keyring. | Profile: `mcp-adapter.json`, caches. HOME: OS keyring. `$TMPDIR`: spilled output. | none | `tested`, `unverified` |
| `hermes` | `memory.hermes` block; `roles.memory` when `backgroundReview` is `true` | npm `pi-hermes-memory`, no version; reviewed at 0.9.9 | The parent session auth, or a child `pi -p` process | Profile: `pi-hermes-memory/`, memory files | `consent.memoryCapture: true` | `tested`, `unverified` |
| `wiki` | `memory.wiki` block | npm `@zosmaai/pi-llm-wiki`, no version; reviewed at 0.12.4 | none; the kit writes no key field | HOME: `~/.llm-wiki/`, or `<wikiHome>/.llm-wiki/` | `consent.memoryCapture: true` | `tested`, `unverified` |
| `openviking` | `memory.openviking` block; `npm ci --ignore-scripts` in `packages/openviking-pi`; an OpenViking server | tree `packages/openviking-pi`, a vendored copy | `OPENVIKING_*` variables, `~/.openviking/ovcli.conf` or `~/.openviking/ov.conf`, set up by the user; the kit writes no endpoint and no key | HOME: `~/.openviking/`. Server: the sessions and the memories | `consent.memoryCapture: true` and `consent.remoteMemoryWrites: true` | `unverified`, `unverified` |

"Source reading" means a fact read in the source code of the package, not seen at run time.

Facts that hold for every row:

- `validate` and `plan` show each gap of an enabled module under `readinessGaps`. Read them before `generate`.
- An in-tree (`tree`) module points at the package directory of the clone by its absolute path. Keep the clone in place.
- `requires` IDs must be enabled too. `ops-footer` needs `context-meter`. Each Promptr skill needs `promptr`.
- A module that the user leaves disabled contributes no file, no key and no launch-line assignment.

Source documents: [in-tree packages](../packages.md), [memory modules](../memory-modules.md), [workflow modules](../workflow-modules.md), [model routes](../model-routes.md).

## The Tenantext path

The Tenantext path is the in-tree components of `packages/tenantext`, with or without the gateway route.

Requirements:

| Item | Requirement | Source |
| --- | --- | --- |
| Pi | `<pin>`. No test starts a Pi session with the component on the kit pin. Each component keeps the gap `pi_line_unqualified`. | `config/manifest.json`, `packages/tenantext/README.md` |
| Node | `>=22.22.0 <23` | `packages/tenantext/package.json` `engines` |
| Source | `packages/tenantext` in the kit clone | [in-tree packages](../packages.md) |
| Dependencies | `npm ci --ignore-scripts` in `packages/tenantext`, by hand (setup Stage 6) | [setup guide](setup.md#in-tree-packages) |
| Gateway | `codex-accounts` enabled, `modelRoutes.gateway` `{"auth": "env"}`, the `/v1` URL and the `${TENANTEXT_LITELLM_API_KEY}` reference | [model routes](../model-routes.md) |

The native terminal interface stays. Pi loads each Tenantext component as a normal extension or skill through one `settings.packages` entry with a filter. The launch line is `pi --no-approve` with assignments in front. The kit installs no wrapper program, no other interface and no copy of the extensions.

An overlay fragment for the gateway route:

```json
{
  "selection": {"enable": ["core", "model-routing", "codex-accounts"]},
  "roles": {"interactive": {"provider": "litellm-codex", "model": "codex-auto/luna", "thinking": "high", "route": "gateway"}},
  "modelRoutes": {
    "schemaVersion": 1,
    "cycle": [{"provider": "litellm-codex", "model": "codex-auto/luna", "thinking": "high", "route": "gateway"}],
    "gateway": {"auth": "env"}
  },
  "endpoints": {"codex-accounts": "https://gateway.example.invalid/v1"},
  "env": {"codex-accounts": "${TENANTEXT_LITELLM_API_KEY}"}
}
```

This is a fragment, not a whole overlay. Move each enabled ID out of `selection.disable` too. The route also needs the registry file of the private directory, with one entry for each model that you confirm:

```json
{"litellm-codex": {"codex-auto/luna": ["high"]}}
```

Give the file with `--registry` to `validate`, `plan` and `generate`. Without the entry, `validate` stops with `unsupported_model_thinking: overlay.modelRoutes.choice`. The plan then lists the gaps `credential_missing`, `gateway_upstream_unverified` and `provider_auth_unverified`, beside the gaps of the component. The gateway aliases are `codex-auto/luna`, `codex-auto/sol` and `codex-auto/astra` of the provider `litellm-codex`. Not verified: a reply through a real gateway with a profile of this kit.

## Optional modules in short

- **Memory** (`hermes`, `wiki`): three parts together enable a module: the ID in `selection.enable`, `consent.memoryCapture: true`, and a `memory` block. Consent alone enables nothing. Read [memory modules](../memory-modules.md) first. Hermes with `backgroundReview: true` makes model calls on its own.
- **MCP** (`mcp`): the server list goes into `inputs/mcp-adapter.json` of the private directory. Every `validate`, `plan` and `generate` then needs `--local-dir "$HOME/.config/tenant-pi"`. The kit disables the native Pi MCP with `-builtin:mcp`. Read [workflow modules](../workflow-modules.md) first.
- **Owner packages and directories**: `ownerPackages` adds a Pi package that you maintain. `ownerResources` adds a skills or prompts directory. See [owner packages](../owner-packages.md) and [owner resources](../owner-resources.md). Each entry adds a permanent `owner_package_unqualified` or `owner_resource_unqualified` gap.
- **Agent fan-out**: no subagents module exists. Use the `herdr` component or the Herdr skill installer. Pi inside Herdr is not qualified.

## Change a selection

1. Edit `selection.enable` and `selection.disable` in the overlay.
2. Run `validate`. The command shows the first rule that fails, for example `missing_dependency: overlay.selection.enable`.
3. Run `plan` and read the new gaps.
4. Generate into a new target. See [the candidate update guide](candidate-update.md).
