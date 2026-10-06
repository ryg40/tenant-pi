# Workflow modules: MCP adapter and Promptr

Status: offline implementation, not a qualified runtime. `scripts/workflow_modules.py` is a pure module: no file, environment, subprocess, or network access. Validation, planning, and generation open no MCP server, spawn no process, and touch no keyring. The tests prove this with a blocked-socket, blocked-subprocess, file-open-audited fixture in a disposable HOME. The MCP module targets `pi-mcp-adapter`, not the native Pi MCP. The kit has no `pi-subagents` component. The source facts below apply to adapter version 3.2.0.

One module can be enabled: `mcp` (`pi-mcp-adapter`, declared without a version; the source facts below were read at 3.2.0). `promptr` is `unverified` and has a named readiness matrix. No overlay block exists for either module; the MCP definitions come from the fixed input slot.

## MCP: activation

| Overlay state | Result |
| --- | --- |
| `mcp` not in `selection.enable` | Nothing is emitted: no package, no `extensions` entry, no `mcp-adapter.json`, no launch prefix. An `inputs.mcpFile` slot fails with `unselected_input`. |
| `mcp` enabled, `inputs.mcpFile` null | `mcp_input_required`. Nothing is generated. |
| `mcp` enabled, slot set, file absent or not a regular file | `input_missing: mcp.file` or `input_not_regular: mcp.file` before any read. The CLI opens the slot through the same no-follow, 1 MiB, real-ancestor loader as the overlay. |
| `mcp` enabled, slot set, file valid | The package declaration, `-builtin:mcp`, the adapter file, the launch prefix, and the readiness gaps below. |

The slot is `inputs/mcp-adapter.json` under an explicit `--local-dir` (default: the kit's `.local/`). The directory must be an absolute path. The file content is validated in full before generation; a single rejected field stops the whole plan.

## MCP: the definitions file

```json
{
  "mcpServers": {
    "local": {"url": "http://127.0.0.1:8080/mcp", "lifecycle": "lazy"},
    "remote": {"url": "https://mcp.example.invalid/mcp", "headers": {"Authorization": "${EXAMPLE_MCP_TOKEN}"}},
    "tool": {"command": "/opt/tools/example-mcp", "args": ["--stdio"], "env": {"EXAMPLE_BIN": "${EXAMPLE_BIN}"}},
    "old": {"url": "https://old.example.invalid/mcp", "disabled": true}
  }
}
```

Top level: `mcpServers` (required) and `$schema` (ignored). Server names match `[A-Za-z0-9_-]{1,64}`; two names that differ only by case fail `duplicate_server`, and a repeated key fails `duplicate_key` at load. Each entry has exactly one transport.

| Field | Accepted form | Rule on failure |
| --- | --- | --- |
| `url` | `https://host[:port]/path`, or `http://` only for `localhost` or a non-global IPv4 literal (loopback, RFC 1918, shared, link-local). No user info, query, fragment, `${}`, or percent-encoded shell syntax. | `mcp_url`, `plain_http_url` |
| `headers` | Names `[A-Za-z0-9-]`; every value exactly one `${NAME}` reference. Put `Bearer <token>` into the variable. | `header_name`, `literal_credential`, `credential_command` for a `!command` value |
| `httpTransport`, `caFile` | `streamable-http` or `sse`; absolute path | `http_transport`, `absolute_path` |
| `command` | Absolute path. No PATH lookup and no `npx`, so no install at connect time. | `absolute_path` |
| `args` | Plain strings without `$`, backticks, `{{`, or control characters; no argument that names a token, secret, password, API key, bearer, authorization, credential, or cookie. | `shell_or_template`, `credential_argument` |
| `env` | Names `[A-Z][A-Z0-9_]*`; every value exactly one `${NAME}` reference. | `env_name`, `env_reference`, `credential_command` |
| `cwd`, `inheritEnv` | Absolute path; boolean | `absolute_path`, `boolean` |
| `disabled` | Boolean. Only literal `true` disables at this pin (`isServerDisabled`). A disabled entry is copied verbatim. | `boolean` |
| `lifecycle` | `lazy` (default), `lazy-keep-alive`, `keep-alive`, `eager` | `lifecycle` |
| `idleTimeout`, `requestTimeoutMs` | Non-negative minutes; positive milliseconds | `integer` |
| `directTools`, `exposeResources` | Booleans only; the list and `"search"` forms are not accepted | `boolean` |
| `toolPrefix`, `includeTools`, `excludeTools` | Enumeration; lists of tool names without duplicates | `tool_prefix`, `tool_name`, `duplicate_tool` |

The kit rejects these keys outright, whatever the value:

- `auth`, `bearerToken`, `bearerTokenEnv`, `bearerTokenStore`, `oauth`, `requestHeadersCommand`, `literalEnv`: `credential_field`.
- `type`, `enabled`, `timeout`, `exposure`, `toolExposure`: `native_mcp_field`. These keys belong to the native Pi `mcp.json` schema.
- `socket`: `unsupported_transport`.
- Top-level `imports`, `claudePlugins`, `settings`, `mcp-servers`, `autoEnableCodemode`: `ambient_import_field`.
- Any other key: `unknown_fields`.

The kit never resolves a `${NAME}` reference, never reads the environment, and never checks that a command or URL exists.

Not verified: the Pi 0.99.1 behaviour described below with the kit pin in `config/manifest.json`, key `runtime.piVersion`.

## MCP: what the pinned source does

Source: `pi-mcp-adapter@3.2.0`, `config.ts`, `types.ts`, `init.ts`, `utils.ts`, `agent-dir.ts`, `mcp-auth.ts`; observed with Pi 0.99.1: `dist/extensions/mcp/config.js`, `dist/core/package-manager.js`, `docs/mcp.md`.

| Behaviour | Source fact | Kit handling |
| --- | --- | --- |
| Own config file | The adapter reads `<agent dir>/mcp-adapter.json`; it never reads `mcp.json` or `.pi/mcp.json`. The agent dir is `PI_CODING_AGENT_DIR` or `~/.pi/agent`. | The kit writes the whole file as an extra profile output, mode `0600`, with the validated `mcpServers` copied field by field and a fixed `settings` block: `hostConfigDiscovery: "off"`, `projectServers: "ask"`, `allowInstall: false`. |
| Ambient sources | Without exclusive mode the adapter merges, in rising precedence: host-discovered files of Cursor, Claude Code, Claude Desktop, Codex, OpenCode, Windsurf, VS Code (only with `hostConfigDiscovery: "on"`), `~/.config/mcp/mcp.json`, `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`, the agent-dir file, ancestor `.mcp.json` and `.pi/mcp-adapter.json` (only with `ancestorConfigRoots`), `<cwd>/.mcp.json`, `<cwd>/.pi/mcp-adapter.json`, plus MCP servers declared by installed Pi packages and `agentPluginPaths`. Merge is per server name and per field; the later source wins. | `PI_MCP_CONFIG_MODE=exclusive` in the launched process (`isExclusiveConfigMode`) limits the sources to the agent-dir file. The kit puts that assignment on the launch line and records `configMode: "exclusive"`. The `imports` and `claudePlugins` keys of that file would still load in exclusive mode, so the kit rejects them. |
| Native built-in | Observed with Pi 0.99.1: Pi loads `builtin:mcp` by default. It reads `<agent dir>/mcp.json` always and `<cwd>/.pi/mcp.json` only for a trusted project, connects every enabled server at session start, and stores OAuth tokens in `<agent dir>/mcp-auth.json`. | The kit writes `"extensions": ["-builtin:mcp"]` into `settings.json`, so exactly one MCP path exists by construction. A generated candidate has no `mcp.json`. |
| Connection timing | `init.ts` connects only `eager` and `keep-alive` servers at session start, in parallel; `lazy` and `lazy-keep-alive` connect on first use. Disabled servers never connect. | Validation and generation start nothing. Each non-disabled server adds `server_connection_unverified`; a startup lifecycle adds `startup_connection`. |
| Credentials | Values in `env`, `headers`, `bearerToken`, and `oauth.clientSecret` that start with `!` run a command. `${NAME}` references resolve from the process environment; an unset variable becomes an empty string. Bearer and OAuth tokens go to the OS keyring through `@napi-rs/keyring`, or to `mcp-oauth-encrypted/` with `oauthCredentialStore: "encrypted-file"` and `PI_MCP_ADAPTER_OAUTH_FILE_KEY`. | Only `${NAME}` references pass. Every referenced name adds `env_reference_not_checked`. The keyring is HOME-shared and OS-scoped, not candidate-scoped: `credential_store_shared` names it, and the kit never describes the agent directory as an isolated credential store. |
| State on disk | `mcp-cache.json`, `mcp-npx-cache.json`, `mcp-onboarding.json`, `mcp-project-approvals.json`, `agent-plugin-data/` under the agent dir; large tool output spills to `$TMPDIR/pi-mcp-output-*`. | Candidate-scoped except the temporary directory. Not generated; the writer creates none of them. |
| Peer range | `peerDependencies` names `@earendil-works/pi-ai` `^0.84.1` to `^0.87.0` (optional); host modules are not under `dependencies`. `engines.node >= 20`. | `peer_range_unverified`. No peer override line is added for this module alone. |
| Package manifest | `pi.extensions: ["./index.ts"]`, MIT, raw TypeScript. | Resource filter `extensions: ["index.ts"]`, all other lists empty. |

### Pin review 3.1.0 to 3.2.0

`config.ts`, `types.ts`, `agent-dir.ts`, `utils.ts`, `dependencies`, and `peerDependencies` are byte-identical between the two versions. 3.2.0 adds a `host-managed` export for embedders. It moves the default OAuth callback to `http://127.0.0.1:<port>/callback`. It fixes four faults:

- a false "project servers blocked" warning;
- direct tools vanishing after another session wrote the shared cache;
- the `mcp__<server>` tool not returning after a failed connection;
- `mcpScript` under Bun.

The versions 3.3.0 and 4.0.0 exist; neither was reviewed. The manifest declares `pi-mcp-adapter` without a version, so an install takes the current registry version. The rules in this document were read at 3.2.0 and are not re-verified for a later version.

### Scopes that can still affect a launch

| Scope | Effect | Guard |
| --- | --- | --- |
| A trusted project's `.pi/settings.json` with `+builtin:mcp` | Re-enables the native path; `<cwd>/.pi/mcp.json` then loads and connects at start. Not verified at runtime. | Launch with `--no-approve` as the kit prints; trust is a launch-time choice outside the kit. |
| A process without `PI_MCP_CONFIG_MODE=exclusive` | The adapter merges every ambient source listed above. | Use the exact launch line; a standalone assignment in another shell does not carry. |
| `--mcp-config <path>` on the Pi command line | Replaces the agent-dir file. | Not printed by the kit. |
| `${NAME}` values, `!` commands entered later by hand, `/mcp-auth`, `/mcp-adapter setup` | Reach the process environment, run programs, or write the shared keyring. | Out of the kit's view; the gaps stay in every plan. |
| `$TMPDIR` | Receives spilled tool output. | Not candidate-scoped. |

Observed with Pi 0.99.1: `docs/mcp.md` says that an installed extension that registers `/mcp`, such as `pi-mcp-adapter`, replaces the built-in MCP support. So the adapter can win over a project `+builtin:mcp` entry, and the first row can be wrong. Not verified at runtime: no Pi start ran with the adapter.

## Promptr: unverified with a readiness matrix

Source: the in-tree package `packages/promptr` (`tree` source): `package.json`, `index.ts`, `scripts/install.mjs`, `README.md`, `src/extension/index.mts`.

The table separates historical package loads on Pi 1.0.2 and Pi 1.0.3 from build and test results with the 1.0.4 dependencies. No package load on Pi 1.0.4 is verified. The component `promptr` and its four skill components are `unverified`. `met` applies only to the stated version. `open` means that the fact is a gap of the component.

| Prerequisite | Fact | Status |
| --- | --- | --- |
| `local_package_load` | Observed with Pi 1.0.2 and Pi 1.0.3: Pi loads the built `packages/promptr` as a local path package from a generated profile. The 16 commands of the extension register, and Pi lists the four skills. | met |
| `pi_line_build_and_tests` | `package.json` pins `@earendil-works/pi-tui` and `@earendil-works/pi-coding-agent` at 1.0.4. The build, the 756 tests, the typecheck and `npm run smoke` pass with those dependencies. `npm run smoke:installed` did not run on 1.0.4. | met |
| `build_step_required` | `packages/promptr/index.ts` re-exports `dist/src/extension/index.mjs`; `dist/` is ignored and absent in the tree. Run `npm ci --ignore-scripts` and `npm run build` in `packages/promptr` before the first start. `scripts/publish_check.py` ignores `dist/`. | open |
| `host_module_dependency` | `dependencies` pins `@earendil-works/pi-tui@1.0.4`, because the companion process (`promptr-companion-spike`) runs outside Pi and needs it. Pi 1.0.2 and Pi 1.0.3 print one warning at each start: host packages belong under `peerDependencies`. Those releases load a second copy from `packages/promptr/node_modules` for the built files. The package pins now align at 1.0.4, but Pi's caret dependency permits a later copy. Not verified on Pi 1.0.4: the warning and interactive key handling, including the kitty key protocol. | open |
| `private_renderer_adapters` | The sidebar uses private Pi renderer adapters. Observed with Pi 1.0.2: the sidebar displays. Not verified: a session with a model. | open |
| `automatic_dispatch_path_unverified` | `requestHandoff` is called with `automatic: true`; queue sends are manual, the handoff switch is unverified. | open |

The `pi-tui` 1.0.4 defaults keep `Home` and `Ctrl+A` for line start, and `End` and `Ctrl+E` for line end. `Ctrl+Home` and `Ctrl+End` scroll the transcript to its top and bottom. Promptr documents `Home` and `End` for notebook lines and binds them directly for tracking navigation. It binds `Ctrl+E` to queue the composer and refuses that key in tracking dialogs. It has no explicit `Ctrl+A`, `Ctrl+Home` or `Ctrl+End` binding. These source checks do not prove interactive key handling.

The matrix is recorded in every plan under `workflow.promptr`, whether or not Promptr is selected; `enabled` shows the selection. A plan that enables `promptr` names each open prerequisite and `kit_test_missing` under `readinessGaps`. A skill component needs `promptr` in `enable`. A fresh state is: no `<agent dir>/promptr/`, no project `.promptr/`, no tracker binding. The kit copies no queue, notebook, tracker credential, or handoff record and prints no command that sends a queued prompt.

No test in this repository repeats a package load in a generated profile, so `kit_test_missing` stays.

Not verified: a session with a model, a queue send, a handoff, a tracker read, the OpenKnowledge calls, the Herdr companion in a pane, and the four skills in use.

The `promptr` component uses the `tree` source at `packages/promptr`; its four skills are separate components.

## Herdr skill: an optional component

The Herdr skill is the selectable component `herdr` (`packages/tenantext`, `skills/herdr`, `unverified`). It loads from a generated profile only when the overlay enables it. The user-level install with `packages/tenantext/skills/herdr/install.sh` stays possible (install skill, Stage 8). Herdr-hosted and browser-hosted launch stay optional and unqualified in this release. A wider filter is a manifest and validator change with its own review.

## Coordinator skills: an optional component

The component `coordinator-skills` (`packages/tenantext`, `unverified`) ships more than one skill: one directory for each below `skills/coordinator-skills/`. `config/manifest.json` names them, and [the component README](../packages/tenantext/skills/coordinator-skills/README.md) lists them. It is the only component with more than one filter entry. It claims one filter entry for each skill. A generated profile loads the skills only when the overlay enables the component. The user-level install with `packages/tenantext/skills/coordinator-skills/install.sh` links each skill into the Claude Code and the Pi skill directory of the user. The offline test `tests/test_skill_invariants.py` reads each shipped skill text.

## Generated outputs

| Output | Present when | Content |
| --- | --- | --- |
| `settings.json` `packages` | promptr | The path of `packages/promptr` with `extensions: ["index.ts"]` and one `skills` entry per enabled skill component. |
| `settings.json` `packages` | mcp | `npm:pi-mcp-adapter` with `extensions: ["index.ts"]`. Declared after the in-tree packages and the memory packages. |
| `settings.json` `extensions` | mcp | `["-builtin:mcp"]`. |
| `mcp-adapter.json` | mcp | Validated `mcpServers` in name order, and the fixed `settings` block. |
| `.tenant-pi/choices.json` `workflow` | always | `promptr` matrix with `enabled`, `status` and a status per prerequisite; `mcp` record: `enabled`, `path`, `builtinMcp`, `configMode`, and per server `transport`, `disabled`, `lifecycle`, `startupConnection`. |
| `.tenant-pi/choices.json` `mcpDefinitions` | always | The validated input document, or `null`. Private, mode `0600`; the writer and the comparison rebuild the plan from it. |
| `.tenant-pi/state.json` `outputs` | mcp | Lists the adapter file. |
| Launch line | mcp | `PI_MCP_CONFIG_MODE=exclusive` precedes every other assignment. |
| Setup lines | mcp | `pi update --extensions`. The peer override line appears only with a memory module. |

The module adds these readiness gaps:

- `package_runtime_unverified`, `peer_range_unverified`, `credential_store_shared` for the module.
- `server_connection_unverified` per non-disabled server.
- `startup_connection` per `eager` or `keep-alive` server.
- `env_reference_not_checked` per referenced variable.

`compare` reads the adapter file as a declared file. It reads `disabled`, `lifecycle`, the transport kind, and the `settings` values by value. It reads every definition as a marker and unknown keys by name.

## Test coverage

`tests/test_workflow_modules.py` covers:

- Every accepted URL and field form.
- Every rejection rule with a secret canary. The rules include credential fields, `!` commands, literal headers, credential-bearing arguments, and relative commands. They also include native fields, ambient top-level keys, case-variant duplicates, and duplicate JSON keys.
- The binding between selection and the input slot.
- The default plan with the matrix and no MCP path.
- A plan that enables `promptr` and one skill: the package declaration, the `enabled` flag and the gaps.
- Rendering with a disabled entry preserved verbatim, the `extensions` entry, the launch prefix, and the gaps.
- Module order and prefixes beside Tenantext and the wiki.
- Guarded publication with tamper rejection for the file, the settings entry, the recorded definitions, and the record.
- Redacted comparison with hostile shapes.
- A CLI validate-plan-generate-compare run in a disposable HOME with blocked sockets and subprocesses. Twelve ambient MCP files (user, agent, project, and host-tool scopes) hold canaries. The file-open audit shows only the declared slot. No `mcp-cache.json` or `mcp.json` appears in the candidate.

The claim that a launch reads no ambient MCP file has two proof scopes. For the kit, the test proves it: the kit's Python opens none of the twelve ambient files. For the adapter, source reading only proves it: no test runs the adapter under `PI_MCP_CONFIG_MODE=exclusive`.

Not run: any Pi start with the adapter, any connection to a server, `/mcp-auth`, and the keyring on a headless host. Also not run: the 3.2.0 fixes against a live session. Not verified: adapter behaviour under a `pi-ai` peer outside its declared range. Those stay `unverified` in every plan.
