# Module guide

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

Each component of `config/manifest.json` is one optional module. Core Pi is always on. Every other component is optional and independent: enable it, or leave it in `selection.disable`.

The manifest is the state of this release. It is not a claim that a module works on a clean client.

## Status labels

The manifest has three statuses. This guide maps them to four labels. The same labels are in [INSTALL.md](../../INSTALL.md#labels-for-a-prerequisite).

| Label | Meaning | From |
| --- | --- | --- |
| `blocked` | The kit refuses to enable the module. `validate` stops with `blocked_component: overlay.selection.enable`. | Manifest status `blocked`. Also a refused choice, for example the gateway with `auth: "login"` (`pi_login_blocked`). |
| `skipped` | The user did not enable the module. Nothing is generated for it. | The module is in `selection.disable`. This is the state of every module except `core` in the sample overlay. |
| `unverified` | The kit validates, plans and generates the module offline. No accepted live trial proves that Pi loads it and that it works. | Manifest status `tested` or `unverified`, when the module is enabled. |
| `ready` | The module passed an accepted live trial on the qualified platform. | No module has this label in this release. |

The manifest status `tested` means: the pin and the structure passed an offline review. It does not mean a clean-client trial. The manifest status `unverified` means: the module is in the tree and selectable, and the plan lists its `gaps` as readiness gaps. So both map to `unverified`.

Not verified: loading all selectable Tenantext components with the kit pin. The labels stay `unverified`.

## Components

Each entry of `components` in `config/manifest.json` holds the source and its pin, the `requires` IDs, the `env` names, the status, the gaps and the resources of one component. The folder of an in-tree component is the `source.path` of its entry under `packages/`, with the docs of the package. `python3 scripts/tenant_pi.py components` prints each component with its prerequisites. [The privacy guide](privacy.md) names the credentials and the requests of the components that send data.

Observed with Pi 1.1.0: the first launch downloaded `fd` and `ripgrep` into `<target>/bin/`.

Rule from the Pi 1.1.0 source: Pi checks each tool in `<target>/bin/` first, then on the `PATH`. It checks `fd` locally and `fd` or `fdfind` on the `PATH`. For `ripgrep`, it checks `rg` in both places. At the start of an interactive session, Pi downloads only a missing tool. If both tools are available, Pi downloads neither. With both on the `PATH`, Pi creates no `bin/` in a new profile. The download needs network access. Without network access, Pi warns that the download failed and continues. With offline mode enabled, Pi warns and skips the download.

"Source reading" means a fact read in the source code of the package, not seen at run time.

Facts that hold for every component:

- `validate` and `plan` show each gap of an enabled module under `readinessGaps`. Read them before `generate`.
- An in-tree (`tree`) module points at the package directory of the clone by its absolute path. Keep the clone in place.
- `requires` IDs must be enabled too. `ops-footer` needs `context-meter`.
- `herdr-relay` is optional and disabled by default. No component requires it. Selecting it requires `herdr`; otherwise validation reports `missing_dependency`.
- The folder of each in-tree module can be absent, for example the relay directory or `packages/openviking-pi`, while the module stays disabled. Enabling a module with an absent folder reports `tree_resource_missing`. A folder that is only partly absent fails validation.
- A module that the user leaves disabled contributes no file, no key and no launch-line assignment.

To print the numbered reference, run:

```sh
python3 scripts/tenant_pi.py components --format text
```

The action reads the manifest and writes nothing. With `--select` it prints the `selection` object for the IDs or the numbers that you choose. See [the CLI contract](../generator.md#components-the-checklist-of-the-components).

The recommended set is not a fresh selection. A fresh selection has core only and retains loaded overlay choices. The marks are a proposal: the action enables nothing. The marked `copilot-usage`, `anthropic-usage` and `doctor` read login files, environment tokens and the `gh` login of the account. When a login exists, they send its token to the usage endpoint of the provider (source reading). The install flow of [INSTALL.md](../../INSTALL.md#stage-5-the-private-overlay) prints this list and waits for the answer of the user.

Source documents: [in-tree packages](../packages.md), [memory modules](../memory-modules.md), [workflow modules](../workflow-modules.md), [model routes](providers.md#pure-model-route-contract).

## The Tenantext path

The Tenantext path is the in-tree components of `packages/tenantext`, with or without the gateway route.

Requirements:

| Item | Requirement | Source |
| --- | --- | --- |
| Pi | `<pin>`. No test starts a Pi session with the component on the kit pin. Each component keeps the gap `pi_line_unqualified`. | `config/manifest.json`, `packages/tenantext/README.md` |
| Node | `>=24.0.0 <25` | `packages/tenantext/package.json` `engines` |
| Source | `packages/tenantext` in the kit clone | [in-tree packages](../packages.md) |
| Dependencies | `npm ci --ignore-scripts` in `packages/tenantext`, by hand (INSTALL.md, package dependencies) | [INSTALL.md](../../INSTALL.md#stage-4-package-dependencies) |
| Gateway | `codex-accounts` enabled, `modelRoutes.gateway` `{"auth": "env"}`, the `/v1` URL and the `${TENANTEXT_LITELLM_API_KEY}` reference | [model routes](providers.md#pure-model-route-contract) |

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

- **Memory** (`hermes`, `wiki`): three parts together enable a module: the ID in `selection.enable`, `consent.memoryCapture: true`, and a `memory` block. Consent alone enables nothing. A fresh selection leaves both modules unchecked. Selection and storage/recall consent are separate decisions. Both store text of the sessions on this machine. Before `wiki` goes on, run `python3 scripts/tenant_pi.py check-wiki-vault`: the profile uses an existing vault as it is. Read [memory modules](../memory-modules.md) first. Hermes with `backgroundReview: true` makes model calls on its own; the install flow writes `false`.
- **MCP** (`mcp`): the server list goes into `inputs/mcp-adapter.json` of the private directory. Every `validate`, `plan` and `generate` then needs `--local-dir "$HOME/.config/tenant-pi"`. The kit disables the native Pi MCP with `-builtin:mcp`. Read [workflow modules](../workflow-modules.md) first. For the AWS MCP server and the AWS skills, see [Agent Toolkit for AWS](aws-agent-toolkit.md).
- **Owner packages and directories**: `ownerPackages` adds a Pi package that you maintain. `ownerResources` adds a skills or prompts directory. See [owner packages](../owner-extensions.md#owner-package-paths-in-the-overlay) and [owner resources](../owner-extensions.md#owner-skill-and-prompt-directories-in-the-overlay). Each entry adds a permanent `owner_package_unqualified` or `owner_resource_unqualified` gap.
- **Agent fan-out**: no subagents module exists. Use the `herdr` component or the Herdr skill installer. Pi inside Herdr is not qualified. The Herdr application is a host tool that the kit does not install. Read [Herdr and the question tool](../herdr-setup.md) first.
- **Questions** (`questions`): the Pi extension with the `ask_user_question` tool. It needs an interactive session. Without it, a skill asks in plain text. It is not an extension for Claude Code.

## Herdr and the question tool

The `herdr` component holds the Herdr skill. The Herdr application is a separate host tool. Check the command before you enable the component:

```sh
python3 scripts/tenant_pi.py check-herdr
```

The output names `present` with the version, `missing` or `unparsed`. The action installs nothing and starts no Herdr session. With `missing`, install Herdr from the source that you reviewed, then run the action again. Do not upgrade a present Herdr as a part of this setup.

The `questions` component adds the Pi question extension to one profile. The plan then prints two more setup lines: `pi install` with the source of the extension, and the peer override. Run them in [INSTALL.md](../../INSTALL.md#stage-7-declared-npm-packages).

After `generate`, `inventory --dir` shows two more results under `coordination`: whether the Herdr skill file is readable, and whether the question extension is declared or installed. A working session and a working question dialog are separate live checks.

Both components are `unverified`. [Herdr and the question tool](../herdr-setup.md) lists what no test proves.

## Change a selection

1. Edit `selection.enable` and `selection.disable` in the overlay. `python3 scripts/tenant_pi.py components --select <ids>` prints the complete `selection` object, with each required component.
2. Run `validate`. The command shows the first rule that fails, for example `missing_dependency: overlay.selection.enable`.
3. Run `plan` and read the new gaps.
4. Generate into a new target. See [the candidate update guide](../../POST_INSTALL.md#the-one-rule-each-change-is-a-new-candidate).
