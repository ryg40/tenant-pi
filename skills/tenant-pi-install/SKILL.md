---
name: tenant-pi-install
description: Guide an agent through installing a separate Pi profile with the tenant-pi kit on a user's machine. The stages are core Pi, a private overlay, optional Tenantext model routes, consent-gated memory modules, the MCP adapter module, Herdr with the question tool, and first launch. Use when a user asks to set up, install, migrate, or rebuild a Pi profile from this kit. Use also when a user asks to add one of its optional modules, or to add Codex, llama-swap or vLLM as a provider of the profile. Adapts each stage to the user's environment through questions; runs only the kit's deterministic commands.
---

# Install a Pi profile with the tenant-pi kit

`<pin>` is `runtime.piVersion` in `config/manifest.json`. Read that field for the current value.

`runtime.piAcceptedRange` is the accepted Pi range. `runtime.piVersion` is the tested version.
A newer accepted Pi version works by the range rule. The kit tests ran on the tested version only.
With `untested_in_range`, keep the installed Pi and record `core_runtime_untested_in_range` as a readiness gap.
The Pi install line stays a plain command with `not_needed`, not `replaces_installed`.

This is guidance, not a script. Each stage names a goal, what to look at, the questions to ask, the commands the kit already provides, and the check that proves the stage is done. Adapt the order to what exists on the machine. Do not invent commands that the kit or Pi do not document.

Rules that hold at every stage:

- Ask before you change something the user owns: a directory, a shell file, a credential, a service. Use your question tool (`AskUserQuestion` in Claude Code, or a plain question in another agent). Offer two to four concrete options; put the recommended one first.
- Never write, print, or paste a secret value. Refer to credentials by environment variable name. The kit has no field for a secret and rejects `$`, backticks, and `{{`.
- Never touch the user's existing agent directory (`~/.pi/agent` or the current `PI_CODING_AGENT_DIR`). The kit generates into a new, absent directory only.
- Every check below is offline unless it says "live". Say which checks you ran, which you skipped, and why.
- If a stage cannot be completed, say so, keep the earlier stages intact, and stop at a state the user can resume from.

## Stage 0: know where you are

Goal: learn the machine before proposing anything.

Look at, without changing:

```sh
uname -sm; node --version 2>/dev/null; npm --version 2>/dev/null; python3 --version 2>/dev/null; git --version 2>/dev/null
command -v pi && PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version
env | grep '^PI_CODING_AGENT_' || echo "no PI_CODING_AGENT_ variable"
for d in "$HOME/.pi/agent" "${PI_CODING_AGENT_DIR:-}"; do
  [ -n "$d" ] || continue
  if [ -e "$d" ] || [ -L "$d" ]; then echo "live agent directory present: $d"; else echo "live agent directory absent: $d"; fi
done
test "${HERDR_ENV:-}" = 1 && echo "inside Herdr"
```

The `for` loop prints one line for `~/.pi/agent`, and one more line for the directory in `PI_CODING_AGENT_DIR` when the variable is set. Each line says `present` or `absent`. No line is not `absent`: when a line is missing from the output, run the loop again.

Requirements the kit pins: Linux first, Node `>=24.0.0 <25`, Python `>=3.11`, Pi inside `runtime.piAcceptedRange`. The install command uses the tested `<pin>`. macOS, Windows, browser-hosted Pi, and Herdr-hosted Pi are unqualified; say so if you see them, then continue only with the user's agreement.

Ask when unclear:

- "Which Node do you want Pi to use?" if several Node installs exist (nvm, system, Homebrew). The same Node must install Pi and build native addons later.
- "Do you already run Pi here?" If yes, the new profile must live beside it, never inside it.

Done when you can state the OS, Node, Python, Pi presence and version, and for each live agent directory the word `present` or `absent` from its line.

## Stage 1: get the kit

Goal: a clean checkout of tenant-pi and passing offline checks.

```sh
git clone <kit repository URL> tenant-pi && cd tenant-pi
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
```

Ask: "Which remote do you want to clone from?" only if the user has more than one. The kit repository must not be the target agent directory.

Done when the unit tests and the publish check pass. If they fail, stop: the checkout is not the reviewed kit.

## Stage 2: install core Pi

Goal: a tested or accepted Pi on the chosen Node.

After the overlay exists, `python3 scripts/tenant_pi.py plan --overlay <file>` prints the same line in `commands.piInstall`, key `command`.

The kit prints the reviewed command; it never runs it. The rule is the rule of Stage 3 of `INSTALL.md`: read the `pi` status of `python3 scripts/tenant_pi.py check-runtime`.

With `match` or `untested_in_range`, skip the Pi install.

Status `missing`: first see whether the user can write the global npm prefix:

```sh
p="$(npm config get prefix)"; test -w "$p/lib/node_modules" && test -w "$p/bin" && echo writable || echo "not writable"
```

It prints `writable` when the user can write `lib/node_modules` and `bin` of the prefix, and `not writable` otherwise. A directory that does not exist gives `not writable`. The user `root` gets `writable`.

The test writes nothing into the npm prefix. `npm config get prefix` writes one debug log file into the npm cache directory of the user (default `~/.npm/_logs`), and makes that directory when it is absent.

If it prints `writable`, show the global command, then ask before running:

```sh
# Run from the kit root.
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global -- @earendil-works/pi-coding-agent@"${pin:?}"
```

Ask: "Install Pi globally with this Node, or do you manage global npm packages another way?" Options: run the command as shown (recommended); user runs it; use the prefix form.

The user can refuse the global command and use the prefix form below in its place.

If it prints `not writable` (for example a user without root on a Node that root owns), the global command fails. Show the prefix form, then ask before running its install command:

```sh
# Run from the kit root.
pin="$(python3 -c 'import json; print(json.load(open("config/manifest.json"))["runtime"]["piVersion"])')" && \
  npm install --global --prefix "$HOME/.npm-global" -- @earendil-works/pi-coding-agent@"${pin:?}"
export PATH="$HOME/.npm-global/bin:$PATH"
```

The directory `"$HOME/.npm-global"` is the example; the user can name another directory that the user owns (`--prefix <dir>`). The `export` line changes the current shell only. The kit never edits a shell startup file. The `PATH` line is the user's step. Record the prefix and its `PATH` line as an adaptation.

Status `mismatch` (outside the accepted range) or `unparsed`: do not guess. With `unparsed`, run `PI_CODING_AGENT_DIR="$(mktemp -d)" pi --version` and read its output first. Ask. Three options:

- Stop.
- Keep the existing Pi, and record the version mismatch as a gap.
- Install the pin with the prefix form above, under a prefix that the user names. The existing Pi stays in its place. Record the prefix and its `PATH` line as an adaptation.

The global install command is not the default for a `mismatch`: it replaces the installed Pi for every profile of the user, and it is a downgrade when the installed Pi is newer. With `--runtime-report`, the plan marks the command under `commands.piInstall` as `replaces_installed`.

Warning: `npm config set prefix` changes the npm configuration of the user for every later global install. Use `--prefix` on the single install command instead.

Warning: a global install replaces the `pi` command that every profile of the user runs.

The command fixes the version of the Pi package, not all versions of its dependencies. `docs/check-runtime.md` (section "What the install command fixes") has the fact.

Run `python3 scripts/tenant_pi.py check-runtime` after the install.
Done when it reports `match` or `untested_in_range` for `pi`. Record the gap for an untested version.

## Stage 3: choose the target and write the private overlay

Goal: a private JSON overlay outside the repository that names the target, and an absent target directory.

Ask first: "Where should the new profile live?" It must be an absolute path whose parent exists and is owned by the user; the last segment must not exist. Recommend a directory beside `~/.pi/agent`, not inside it, for example `~/.pi/profiles/<name>`. If the parent does not exist, show `mkdir -p ~/.pi/profiles` and ask before running it.

Create the private directory with the `init-private` action, and give it the target with `--target`. Show, then ask before running:

```sh
mkdir -p "$HOME/.config"
python3 scripts/tenant_pi.py init-private --dir "$HOME/.config/tenant-pi" --target "$HOME/.pi/profiles/<name>"
```

- Both paths are absolute and expanded. Write `"$HOME/..."` in double quotes: the shell then expands it. The kit refuses `~`.
- The action creates the directory with mode 700 and, with mode 600, `overlay.json`, `registry.json`, `install-log.md`, `accepted-drift.md` and `.gitignore`, plus an empty `inputs/` directory. The new `overlay.json` has the path of `--target` as `target.agentDir`.
- The action does not create the target and runs no Git command. It refuses a target that is `~/.pi/agent` or is under it, that is inside the private directory, or that is inside the clone. `docs/private-directory.md` has the refusals.
- A core-only profile then needs no edit and no editor: go to `validate` below.
- Keep the private directory outside the clone. `.local/` inside the clone is ignored by Git but is not a security control.

An `init-private` run without `--target`, and a copy of `config/config.example.json` by hand, have the sample target `/home/EXAMPLE_USER/new-agent`. `validate`, `plan` and `generate` refuse it with `sample_target: overlay.target.agentDir`. Then the user changes the target by hand:

- Tell the user the one key and the one value: "In `overlay.json`, change the value of `target.agentDir` from `/home/EXAMPLE_USER/new-agent` to `<target>`. Change nothing else."
- Give the expanded path, not `~`.
- Do not give the user a JSON fragment to paste. A pasted fragment can make the file invalid.

After each edit by hand, check the syntax before `validate`:

```sh
python3 -m json.tool "$HOME/.config/tenant-pi/overlay.json" >/dev/null && echo "JSON valid"
```

The command prints `JSON valid`, or the line and the column of the first syntax error. With `>/dev/null` it does not print the file.

Ask, one at a time, and write the other answers into the overlay:

1. The target: `--target` sets `target.agentDir`. Change it by hand only as described above.
2. "Core only, or with model routes?" Core only means `selection.enable: ["core"]`. Model routes add `model-routing` and a `roles.interactive` choice.
3. "Native provider or the Tenantext gateway?" See Stage 5 before answering; the gateway needs `codex-accounts` enabled and a `modelRoutes` block.
4. "Memory modules?" See Stage 6. Default is none.

5. "MCP servers through the adapter?" See Stage 6a. Default is none.
6. "Which in-tree extensions and skills?" Default is none. Each one is a component of its own; `docs/packages.md` has the table.
   - Extensions of `packages/tenantext`: `tenantext`, `codex-accounts`, `slopscore`, `context-meter`, `ops-footer`, `copilot-usage`, `anthropic-usage`, `doctor`, `resources`. Skills: `herdr`, `coordinator-skills` (more than one skill; `packages/tenantext/skills/coordinator-skills/README.md` lists them), `knowledge-skills` (four skills; `packages/tenantext/skills/knowledge-skills/README.md` lists them), `slopscore-pr`.
   - Move each chosen ID from `selection.disable` to `selection.enable`. Enable each ID in `requires` too: `ops-footer` needs `context-meter`.
   - These components are `unverified`. Tell the user: no test in the kit loads these components with the kit pin. The plan shows each gap under `readinessGaps`.
   - The profile points at the package directory of this clone by its absolute path. Tell the user not to move or delete the clone.

`promptr` and its four skills (`promptr-generate-task-prompt`, `promptr-handoff`, `promptr-openknowledge-project-pages`, `promptr-watch-herdr-agents`) are `unverified`. `promptr` needs `npm ci --ignore-scripts` and `npm run build` in `packages/promptr` before the first start; each skill needs `promptr`. Tell the user: no session with a model is verified, and Pi prints one warning about `pi-tui` at each start.

`questions` is the Pi question extension from npm, at an exact version. It is `unverified` and off by default; Stage 8 asks for it.

`tracker-site` is `unverified` and selectable. It needs Python 3.11 or later and Git on `PATH`. `check-runtime` checks `python3` but does not check Git. `openviking` is a memory module; see the memory step.

Validate after each edit:

```sh
python3 scripts/tenant_pi.py validate --overlay "$HOME/.config/tenant-pi/overlay.json"
```

The error form is `rule: field`, never a value. `docs/candidate-compare.md` lists the common corrections.

When the kit cannot use the overlay file, the rule names the cause, for example `input_missing: overlay.file` for a file that does not exist. Stage 5 of `INSTALL.md` has the table of these rules. A JSON syntax error has two more keys, `line` and `column`:

```json
{"candidate_created": false, "column": 3, "error": "invalid_json: overlay.file", "line": 6}
```

Tell the user the line and the column. The parser refuses the character at that place; the cause is often at the end of the line before, for example a missing comma. The output holds no file content, and you need no script to find the place.

Done when `validate` prints `"valid": true`.

## Stage 4: plan, review, generate

Goal: the profile files exist and nothing else changed.

Save the runtime versions first, in the shell that will launch Pi. `plan` and `generate` start no process, so the gaps show the measured state only with this report:

```sh
python3 scripts/tenant_pi.py check-runtime > "$HOME/.config/tenant-pi/runtime.json"
```

Exit code 1 is a finding here, not a failure: the file holds the report. Make the report again after each change of Node or Pi. The kit cannot tell an old report from a current one.

```sh
python3 scripts/tenant_pi.py plan --overlay "$HOME/.config/tenant-pi/overlay.json" --runtime-report "$HOME/.config/tenant-pi/runtime.json" [--registry "$HOME/.config/tenant-pi/registry.json"] [--require-role review]
```

Read the plan with the user: the file list, `readinessGaps`, and the display-only `setupDisplayOnly` and `launchDisplayOnly` lines. Every gap is a fact to carry into later stages, not an error.

- A `match` in the report removes the runtime gap of that tool. An `untested_in_range`, `mismatch`, `missing` or `unparsed` gives a gap with that word in place of `unverified`, for example `core_runtime_mismatch` with the installed and the required version. Stage 6 of `INSTALL.md` has the gap codes.
- `commands.piInstall` marks the global Pi install command. Read its `status` before you show the command. With `not_needed`, skip the install. With `replaces_installed`, the command is not in `setupDisplayOnly`: the three options of Stage 2 apply, and you never run the command as a default step.

Ask: "Generate now into `<target>`?" Then:

```sh
python3 scripts/tenant_pi.py generate --overlay "$HOME/.config/tenant-pi/overlay.json" --target '<target>' [same options]
```

Done when the output says `"filesComplete": true` and the target holds `settings.json` and `.tenant-pi/`. The target also holds `hermes-memory-config.json` with Hermes, and `mcp-adapter.json` with the MCP module. All files have mode `0600` under `0700` directories. `runtimeReady` is always `false`: the kit has no live trial of a profile. `readinessGaps` is empty only when `--runtime-report` gave `match` for Node and Pi and the profile has no other gap; Stage 6 of `INSTALL.md` has the gap codes. An empty list is not a launch check.

If generation fails after creating the directory, the output says `candidate_created: true`. Show the user the directory, do not delete it, and ask how to proceed.

## Stage 5: model routes and authentication (live, optional)

Goal: the interactive model answers.

Native route: the provider's own `/login` inside Pi, after launch. The kit writes no auth file. Ask which provider and model; the model ID goes into `roles.interactive` as separate `provider` and `model` strings. With `modelRoutes`, supply a `--registry` file shaped `{provider: {model: [thinking levels]}}` that the user confirms; it is evidence, not a catalog.

Tenantext gateway: enable `codex-accounts`, set `modelRoutes.gateway` to `{"auth": "env"}`, `endpoints.codex-accounts` to the gateway URL ending in `/v1`, and `env.codex-accounts` to `${TENANTEXT_LITELLM_API_KEY}`. The old key `tenantext` fails with `moved_key`. The user provides `TENANTEXT_LITELLM_API_KEY` to the Pi process themselves. `auth: "login"` is blocked at this pin; do not offer it as a working path.

Ask: "How will the key reach the Pi process?" Options: exported in the shell that launches Pi (recommended); a launcher script the user writes; a secret store the user already uses. Never propose editing a shell startup file yourself.

Done when the user has launched Pi (Stage 9) and the fixed prompt of Stage 9 check 3 gets the expected reply. Record which provider was tried and the result; never record the key.

## Stage 5a: direct providers (Codex, llama-swap, vLLM; live, optional)

Goal: each provider that the user wants is in the profile and answers. No gateway is needed.

`docs/guides/providers.md` is the one source for the commands, the `models.json` examples, the metadata fields and the verification. Read it before this stage. Ask the questions below, then follow the guide. Do not write a command or a field from memory.

Ask: "Which providers do you want in this profile?" Options, more than one allowed: Codex; llama-swap; vLLM; none now. Assume none.

Codex:

- Ask: "Which Codex provider?" Options: `openai-codex` (recommended when a Tenantext component of the profile names it); `openai` with "Sign in with ChatGPT". The guide has the difference.
- The user runs `/login` inside Pi after the launch. You never log in for the user, and you copy no `auth.json`.
- Ask: "Which Codex model?" Read the choices from `pi --list-models` or `/model` after the login. Do not promise a model before the list shows it.
- The Codex login and the gateway key of Stage 5 are separate credentials. Say so when the profile has both.
- Offer a second Codex account only when `codex-accounts` is enabled. That component needs the gateway settings and the key `TENANTEXT_LITELLM_API_KEY`.

llama-swap and vLLM, the same questions for each:

1. Ask: "What is the base address of the server?" A free answer. Offer no address and no port.
2. Ask: "Which model do you want in Pi?" The answer is the exact `id` of `GET /v1/models`. With vLLM, it is the served model name, not the repository name or the path of the download.
3. Ask: "Does the server need a key?" Options: no key (a placeholder goes into the file); a key in an environment variable. With a key, ask for the variable name. Never ask for the value.
4. Ask: "Which model metadata do you have from the server?" Set `contextWindow`, `maxTokens`, `reasoning` or `input` only from the server or its configuration. Leave each other field out, and tell the user the Pi default that then applies. Never guess a value.

Rules for the registration:

- The file is `<target>/models.json`. The kit does not write it, and `inputs.modelsFile` stays `null`. Write it after Stage 4, with the user's yes.
- If `<target>/models.json` exists, add the provider and keep each other provider. Show the change before you write it.
- Keep the master copy in the private directory. Tell the user that each new candidate of Stage 10 needs the copy step and the Codex login again.
- Do not use `/login llama.cpp` or `/llama` for llama-swap.
- A direct provider accepts local HTTP, a LAN address and each port. This does not change the gateway rule of Stage 5: HTTPS, port 443, an address that ends in `/v1`. Warn that plain HTTP has no encryption.
- The real address, model and variable name stay in the private directory and in the profile. Never write them into the clone.

Verification, each step with the user's yes: the model is in `pi --list-models` for the target; the model replies to the fixed prompt of Stage 9 check 3 with `--model '<provider>/<model>'`; the earlier providers are still in the list. The guide has the exact lines.

Done when both steps passed for each chosen provider. If a step did not run, record "not run" and say that the provider is unverified. Never record the key.

## Stage 6: memory modules (consent first)

Goal: Hermes, LLM Wiki or OpenViking enabled only with informed consent, or left disabled.

Before any overlay change, tell the user what each module does at this pin, from `docs/memory-modules.md`:

- Hermes indexes every session into a SQLite store under the profile and keeps memory files there. With `backgroundReview: true` it also makes model calls on its own: review every 10 turns or 15 tool calls, correction detection, flush on compaction and shutdown, consolidation. That costs tokens on the `roles.memory` model.
- LLM Wiki keeps a vault under HOME (`~/.llm-wiki/`), not under the profile. With `ambientPersonalVault: true` it creates that vault on first start and injects recall in every directory.
- OpenViking sends each turn of each session to an OpenViking server and adds memories from that server to each prompt. It needs a server that the user set up, with the endpoint and the key in `OPENVIKING_*` variables or `~/.openviking/ovcli.conf`. The kit writes no endpoint and no key. With `captureToolResults: true` the output of each tool call goes to the server too.

Ask, in this order:

1. "Enable memory at all?" Default no. If no, stop here; the overlay keeps `consent.memoryCapture: false`.
2. "Which module?" Hermes, wiki, OpenViking, or more than one.
3. For Hermes: "Background model calls on or off?" Off is the recommended first state. On needs `roles.memory` and, for a `llama.cpp` or gateway model, a `childExtensionPaths` entry (`builtin:llama.cpp`, or the absolute path of the Tenantext `codex-accounts` extension inside the installed package). Ask for the transport: `direct` (recommended) or `subprocess`.
4. For the wiki: "Ambient personal vault on or off?" Off is recommended. `wikiHome` is only allowed with ambient on.
5. For OpenViking: "Do you agree that session content goes to your OpenViking server?" If no, leave the module disabled. If yes, ask "Capture tool results on or off?" and set `captureToolResults`. `recallContextTimeoutMs` is optional. Do not ask for the endpoint or the key, and do not read `~/.openviking/`.

Then set `consent.memoryCapture: true`, add the `memory` block, enable the modules, and re-run `validate`. `remoteMemoryWrites` is `true` only with OpenViking and the agreement of step 5; else it stays `false`.

Done when the plan shows the module's package declaration and the gaps `peer_override_required`, `native_addon_unverified` (Hermes), `shared_home_state` or `project_settings_override` (wiki), `install_step_required`, `server_required` and `capture_cost_unmeasured` (OpenViking), and the user has acknowledged them. For OpenViking, the user runs `npm ci --ignore-scripts` in `packages/openviking-pi` of the clone before the first start.

## Stage 6a: MCP adapter module (optional)

Goal: explicit MCP server definitions through `pi-mcp-adapter`, with the native Pi MCP disabled, or no MCP at all.

Tell the user what the module does at this pin, from `docs/workflow-modules.md`. The kit writes one config file `mcp-adapter.json` in the profile and `-builtin:mcp` in the settings. The kit puts `PI_MCP_CONFIG_MODE=exclusive` on the launch line, so that the adapter merges no user-level, project, or host-tool MCP file. Credentials reach servers only as `${NAME}` references that the user exports to the Pi process. OAuth and bearer stores use the OS keyring, which every profile shares.

Ask, in this order:

1. "Which servers, and are they HTTP or stdio?" Write each as an entry in `<local-dir>/inputs/mcp-adapter.json`. An entry has `url` (HTTPS, or HTTP only to localhost or a private IPv4 address) or an absolute `command` with `args`. Keep `disabled: true` for a parked server.
2. "Does a server need a token or a key?" Put it as a header or env value in the form `${NAME}`. Let the user export `NAME` themselves. Never write the value.
3. "Connect at start or on first use?" Default `lazy`. `keep-alive` or `eager` adds the `startup_connection` gap.

Then enable `mcp`, set `inputs.mcpFile` to `inputs/mcp-adapter.json`, and re-run `validate` with `--local-dir <absolute dir>` on every command. The error form names the rule and the field, never a value; `docs/workflow-modules.md` lists the rules.

Done when the plan shows the adapter package, `extensions: ["-builtin:mcp"]`, and the `mcp-adapter.json` output. The plan also shows the gaps `peer_range_unverified`, `credential_store_shared`, and one `server_connection_unverified` per server. The user has acknowledged the gaps.

## Stage 7: install declared packages and the peer override

Goal: Pi has the packages the profile declares, without startup warnings.

Only when the profile declares packages (in-tree components, Hermes, wiki, MCP adapter, the question extension). Record the baseline of the live agent directory first (Stage 9): `pi update --extensions` is the first Pi command that names the target. Show, then ask before running:

```sh
PI_CODING_AGENT_DIR='<target>' pi update --extensions
PI_CODING_AGENT_DIR='<target>' node scripts/patch_extension_peers.mjs
```

The first reconciles declared packages (`packages.md`); it needs network access for the npm packages. The MCP adapter, Hermes and the wiki are declared without a version, so this step installs the current registry version of each; tell the user which versions it installed, and that the kit reviewed 3.2.0, 0.9.9 and 0.12.4. The question extension is declared at the exact version 2.11.0. An in-tree package is a local path and needs no download; not verified: whether `pi update --extensions` installs its Node dependencies. If a load fails on a missing module, show `npm ci --ignore-scripts` in the package directory and ask before running it. The second corrects host-provided `dependencies` in the installed manifests; see `docs/host-peer-overrides.md`.

Ask: "Reapply the override automatically after updates?" Options: the `npmCommand` wrapper (recommended, no root; follow the doc, but replace `~/.pi/agent` with `<target>` in every path, and ask before each write); the systemd path unit (needs root, the user installs it); manual reruns.

Hermes needs `better-sqlite3` built for the Node that runs Pi. If the build fails, the package README gives an `npm rebuild better-sqlite3` fallback inside the profile's npm directory; ask before running it.

Done when `PI_CODING_AGENT_DIR='<target>' pi list` shows the declared sources and a launch prints no peer warning.

## Stage 8: Herdr and the question tool (optional)

Goal: agent fan-out through Herdr and structured questions in Pi, each approved by the user.

The kit declares no separate agent orchestration module at this pin. Three parts have separate results: the Herdr application (a host tool that the kit does not install), the Herdr skill, and the Pi question extension. `docs/herdr-setup.md` has the facts. `INSTALL.md`, Stage 4a, has the same steps with the full tables.

Order: ask question 1 before Stage 2 when the user names a container. For Herdr, a remote host or the question tool, ask questions 1 to 3 before Stage 3. Questions 6 and 7 are overlay choices; write them in Stage 3, and Stage 4 generates them.

Use your question tool. In Claude Code that is `AskUserQuestion`; install no Pi extension into Claude Code. With no question tool, and in a headless session, ask in plain text with numbered options. No step waits for the Pi question extension.

1. Ask: "Install on this machine, on a remote Linux host over SSH, or in a container on this machine?" For a container, go to Stage 8a and skip questions 2 to 7. For remote, the user gives the SSH target. Use the SSH configuration and the agent of the user. Never ask for a password or a private key, never copy a credential, never turn off host key verification. A remote install is unqualified; say so.
2. Ask: "An existing Linux account, or a new one?" A new account and each missing system prerequisite go into one list of privileged actions, one command for each item. The user approves or refuses each item. Do not give the account administrator rights. Every ordinary step then runs as the target account.
3. Confirm the identity and the paths before any write:

   ```sh
   id -un; printf '%s\n' "$HOME"; uname -sm
   ssh '<ssh target>' 'id -un; printf "%s\n" "$HOME"; uname -sm'
   ```

   For a remote host, `python3 scripts/tenant_pi.py remote-plan --ssh-target '<ssh target>' --remote-user '<account>' --remote-home '<remote home>'` prints the SSH command lines of the remote stages and runs none. Show each line; a line with `"changes": true` needs a yes.

   Show the account, the home, the clone, the private directory, the profile and `~/.config/herdr/`. Stop when the account or the home is not the one that the user named.
4. Detect Herdr, read-only:

   ```sh
   command -v herdr && herdr --version
   python3 scripts/tenant_pi.py check-herdr
   ```

   With `present`, record the version and install nothing. Do not run `herdr update`, do not change the channel, and do not stop a server or a session. An upgrade needs its own approval.
5. With `missing`: the kit has no install code for Herdr. The reviewed source is the open-source project `herdrdev/herdr` on GitHub (Apache-2.0), stable release 0.9.3. Use no other URL or command. The preferred form is the pinned asset for Linux x86_64:

   ```sh
   cd "$(mktemp -d)" &&
   curl -fsSLO https://github.com/herdrdev/herdr/releases/download/v0.9.3/herdr-linux-x86_64 &&
   echo '18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7  herdr-linux-x86_64' | sha256sum -c - &&
   mkdir -p ~/.local/bin &&
   install -m 755 herdr-linux-x86_64 ~/.local/bin/herdr
   ```

   It writes a new temporary directory and `~/.local/bin/herdr`, and it stops when the digest does not match. Another release needs its own reviewed digest. The alternative form is the official script `https://herdr.dev/install.sh`: it installs the latest release into `~/.local/bin` and verifies the checksum. The user saves the script to a file and reads it before it runs; do not send the download directly into a shell. The macOS assets are `herdr-macos-aarch64` and `herdr-macos-x86_64`; this guide gives no digest for them. Not verified: an install with these commands on a clean account.

   Show the command and its paths, ask, run it as the target account without `sudo`, then run the check again. `~/.local/bin` can be missing from `PATH` in a non-login shell or in an SSH command. The check then reports `missing` after a correct install. The user adds the directory to `PATH` for that shell (`export PATH="$HOME/.local/bin:$PATH"`); the kit never edits a shell startup file. A missing terminal or session prerequisite is a blocker, not a success.
6. Ask: "Where do you want the Herdr skill?" Options: the profile (recommended): enable the `herdr` component (Stage 3, question 6), and the generated profile loads `packages/tenantext/skills/herdr`. The shared install: `packages/tenantext/skills/herdr/install.sh` copies the skill to `~/.agents/skills/herdr` and links it into `~/.pi/agent/skills` and `~/.claude/skills`. Those are user-level locations shared by every profile. It is a separate approval: show what exists at each path first. The approval text says that `install.sh` replaces the installed skill copy with `rsync --delete`. It also says that `install.sh` overwrites an existing `spawn_agent.md` in `~/.claude/commands` and `~/.pi/agent/prompts`.
7. Ask: "Structured questions in Pi?" A yes enables the `questions` component (Stage 3). Stage 7 installs the package into the profile. It is `unverified`; a loaded extension does not prove a working question dialog. The kit does not write the guidance file of the extension; do not replace an existing one.

- Do not install the third-party `@ogulcancelik/pi-herdr` package.
- Herdr-hosted Pi is unqualified for this kit; say so.
- When a part fails, name the actions that are complete and the actions that are not.

Done when `check-herdr` shows `present` or the user accepted `missing` as an open item, and the answers to questions 6 and 7 are in the overlay.

## Stage 8a: the Compose seat (only with the answer "container")

Goal: the five files of a Compose seat in the private directory, a built image, and a login over SSH.

The guided path supports the gateway route only, through the component `codex-accounts` ([modules guide](../../docs/guides/modules.md)). For a provider with a native login, write the private directory files by hand. Use the two env templates and the notes on the private directory in [the seat README](../../deploy/compose/README.md). Use the overlay rules of Stage 3. The `overlay` and `registry` keys of the plan in [INSTALL.md, Stage 4c](../../INSTALL.md#stage-4c-the-compose-seat), part 2, show the shape of these two files. The seat README permits an empty gateway key for a native login. Not verified: a native login in the seat.

A Compose seat is a container, started by Compose, that holds one generated Pi profile for one user and is reached over SSH. It is unqualified; say so. `INSTALL.md`, Stage 4c, has the same steps with the full tables. `deploy/compose/README.md` has the facts. This machine needs Git, Python 3.11 or later, the clone, and Docker with Compose or Podman with a Compose provider.

Ask the eight questions in this order, the recommended answer first:

1. "Which account name does the seat use?" Recommended: `pi`. Not `root`, not an account of the base image.
2. "Which UID and GID does the account have?" Recommended: the output of `id -u` and `id -g`.
3. "Which SSH public key file opens the seat?" Recommended: a `.pub` file of `~/.ssh`. Never ask for a private key.
4. "Which port of this machine receives the SSH connections?" Recommended: `2222`. The seat listens on `127.0.0.1` only.
5. "Do you want a projects directory in the seat?" Recommended: no. A yes needs the absolute path of an existing directory.
6. "Which gateway URL and which key variable name?" Recommended name: `TENANTEXT_LITELLM_API_KEY`. The URL is HTTPS and ends in `/v1`. Ask for the name of the variable, never for the key value. The overlay accepts only the name `TENANTEXT_LITELLM_API_KEY` for the key and `TENANTEXT_LITELLM_BASE_URL` for the URL: the manifest declares only these for `codex-accounts`. Another name stops with `undeclared_env: overlay.env`.
7. "Which components do you want?" Recommended: none more. The action adds `core`, `model-routing`, `codex-accounts` and each required component.
8. "Which model for the interactive role?" Ask for the provider, the model and the thinking level as three separate values. Recommended: `litellm-codex`, `codex-auto/astra`, `high`. The other options are `codex-auto/sol` and `codex-auto/luna`: the gateway registers only these three models under `litellm-codex`. The action refuses another model with `unsupported_gateway_model`. The action writes the answer into `registry.json`, the list of the models and the thinking levels that the user confirms; `validate`, `plan` and `generate` refuse a role model that the file does not hold.

Print the plan. This command writes nothing and runs nothing:

```sh
python3 scripts/tenant_pi.py compose-plan --account pi --uid "$(id -u)" --gid "$(id -g)" \
  --public-key "$HOME/.ssh/id_ed25519.pub" --ssh-port 2222 --gateway-url '<gateway url>' \
  --private-dir "$HOME/.config/tenant-pi" --model codex-auto/astra [--provider litellm-codex] [--thinking high] \
  [--projects-dir '<projects dir>'] [--enable <component id>]
```

- Show `overlay`, `registry`, `seatEnv`, `composeEnv`, `authorizedKeys`, `commands` and each entry of `warnings`.
- The private directory must exist, outside the clone, with mode 700. Ask before you create it.
- Ask: "Write these five files into the private directory?" On yes, run the same command with `--write`. It creates `overlay.json`, `seat.env`, `compose.env`, `authorized_keys` and `registry.json` with mode 600. It refuses when one of them exists; do not delete a file to make it pass.
- The user pastes the key value between the single quotes of the key line in `compose.env`, in their own editor. Never read, print or copy that file after this step. Do not run `docker compose config`, `docker inspect` or `podman inspect`: they print the key value.
- With Podman, the user sets `SEAT_USERNS` in `seat.env` to the value of the comment line above it.
- Show the `build` line and the `up` line of `commands` for the runtime of the user, and run each on yes. Each Compose line carries `KIT_COMMIT` and `--env-file`. Never add `-v` to `down`: it removes the profile and the sessions.
- The seat replaces Stages 2, 3, 4 and 7 of this skill: the image build installs Pi and the packages, `compose-plan` writes the overlay, and the entrypoint generates the profile at the first start. The key in `compose.env` replaces Stage 5. The login line of the plan, `ssh -p <port> <account>@127.0.0.1`, replaces the launch of Stage 9. The login opens the tmux session `seat`; `pi-profile` starts Pi there.

Done when the action wrote the five files, the user confirmed the key line, and the user saw the login or accepted it as an open item. Record a login that did not run as "not run".

## Stage 9: first launch and checks (live)

Goal: the profile starts, answers, and stayed inside its directory.

Before the first Pi command that names the target, record the baseline of the live agent directory. Show, then ask before running:

```sh
python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out "$HOME/.config/tenant-pi/live-baseline.json"
```

The action lists the directory and reads the name, kind, size and modification time of each entry. It opens no file and does not change the directory. The one write is the new baseline file, mode 600, in the private directory; `--out` takes any absolute path outside the clone and outside the directory. It never replaces a baseline: an existing file stops it with `target_exists: baseline.out`. Run it also when the directory is absent. When Stage 0 printed `PI_CODING_AGENT_DIR`, record a second baseline for that directory: `--dir "$PI_CODING_AGENT_DIR"` and `--out "$HOME/.config/tenant-pi/live-baseline-env.json"`. When Stage 0 printed `PI_CODING_AGENT_SESSION_DIR`, record one more: `--dir "$PI_CODING_AGENT_SESSION_DIR"` and `--out "$HOME/.config/tenant-pi/session-dir-baseline.json"`. Ask: "Does a Pi run in your live profile now?" A Pi in the live profile also changes the directory; ask the user to close it, or record that it runs. `docs/directory-baseline.md` has the details.

If the action stops with `not_directory: baseline.dir`, the directory or a directory above it is a symbolic link. Run `realpath "$HOME/.pi/agent"`, give that path as `--dir` to `baseline` and to `check-baseline`, and record both paths.

Use the exact `launchDisplayOnly` line from the plan; it carries `env -u PI_CODING_AGENT_SESSION_DIR` (an inherited session directory must not move the sessions out of the target), `PI_CODING_AGENT_DIR`, `--no-approve`, and any `TENANTEXT_LITELLM_BASE_URL` or `WIKI_HOME` assignment for the same process. Ask the user to run it in their terminal, or run it yourself only if they say so.

Checks, in order:

1. `pi --version` inside the launch environment prints `<pin>` or an accepted version. Record the untested-version gap when needed.
2. Startup shows no extension warning. A peer warning means Stage 7 is incomplete.
3. The chosen model replies to the fixed prompt, and the reply holds the expected number. With a gateway, an auth error means the key did not reach the process.
   - The fixed prompt is `What is 17 plus 26? Reply with the number only.` The expected reply is the number `43`. The prompt text does not hold that number. Use the prompt as it is, and do not give the user the expected reply before the check.
   - Two results, recorded as two lines: "Model replied" and "Reply matched", each yes, no or not run. Passed only when both are yes.
   - Preferred form: print mode. With `-p`, Pi sends one prompt, writes the final reply of the model to standard output, and exits; the output holds no user line. After the login, add `-p` and the prompt to the `launchDisplayOnly` line: `env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=/home/EXAMPLE_USER/.pi/profiles/main pi --no-approve -p 'What is 17 plus 26? Reply with the number only.'; echo "exit status: $?"`
   - Text that holds `43` and `exit status: 0`: replied yes, matched yes. Text without `43` and `exit status: 0`: replied yes, matched no. An error text, no text, or another exit status: replied no.
   - Other form: a pasted screen. A Pi screen has no labels. Its lines come in this order: the user line, then thinking text when the model shows it, then the model line. Separate the user line from the model line. The user line must be the fixed prompt. "Reply matched" is yes only when `43` is in the model line. A `43` in the user line or in the thinking text is not a reply.
   - Pi reads a provider key from the environment of the launching shell, including in a profile with no login. Not verified: which variable names Pi reads for each provider. Use the name that the Pi documentation gives. Add `--model '<provider>/<model>'` before `-p` to get the reply from one named model.
4. `ls -la '<target>'` shows only the generated files plus what Pi itself wrote. Pi writes `auth.json`, `sessions/`, `npm/`, its git package checkouts, and with the MCP module `mcp-cache.json`. No `mcp.json` exists in the target. The live agent directory did not change: `python3 scripts/tenant_pi.py check-baseline --dir "$HOME/.pi/agent" --baseline "$HOME/.config/tenant-pi/live-baseline.json"` prints `"result":"unchanged"`.
   - `unchanged`: passed. `no_baseline`: not run, never passed. Record check 4 as passed only when `recordedAt` is before the first Pi command that names the target. With a later baseline, record check 4 as not run: that comparison proves nothing about the launch.
   - `changed`: the output names the direct entries that differ. Find out whether a Pi ran in the live profile after `recordedAt`, from the user or from you. Read your own commands first: each command that you ran, and each command that you gave the user to run. Then ask the user. A `pi` command without `PI_CODING_AGENT_DIR` counts as a Pi in the live profile, also `pi --version`, and also when the installing agent ran it.
   - If no Pi ran there, the check failed: stop and report the names. If one ran, the check is not verified: record the names, the answer and your own command, never "passed". For a proof, the user closes that Pi, you record a second baseline in a new file, launch again, and compare with the second baseline.
   - Observed with Pi 1.0.2 and a `settings.json` in the directory: a `pi --version` without `PI_CODING_AGENT_DIR` gives `changed` with empty name lists and `"directoryModified":true`. Not verified: other Pi versions.
   - Run the same comparison for each other baseline that you recorded, with its own `--dir` and `--baseline`.
5. With Hermes: `'<target>'/pi-hermes-memory/` exists after the first session; with the wiki and ambient off, `~/.llm-wiki` was not created.
6. With the MCP module: `/mcp-adapter status` inside Pi lists only the servers from the input file. A `lazy` server shows as not connected until first use.
7. With `herdr` or `questions`: five separate results, each recorded on its own line. `python3 scripts/tenant_pi.py check-herdr` gives the Herdr command. `python3 scripts/tenant_pi.py inventory --dir '<target>'` gives `coordination.herdrSkill` and `coordination.questionExtension`. The question dialog and a temporary Herdr session are live checks that the user approves first; without them, record "not run". A present command and a readable skill file do not prove a session or a question dialog. `docs/herdr-setup.md` has the steps and the values.

Record each check as passed, failed, or not run. Check 4 has one more value, not verified. Do not describe a failed or skipped live check as working.

## Stage 10: keep it current

Goal: updates without editing the live profile.

A new kit release never updates a profile in place. Regenerate into a new target from the same overlay (change only `target.agentDir`), then:

```sh
python3 scripts/tenant_pi.py compare --left '<old target>' --right '<new target>'
```

Read `changes`, `unsupported`, and `drift` with the user. User edits made inside Pi (`/model`, settings changes) show as drift; carry the ones to keep into the overlay first, per the table in `docs/candidate-compare.md`. Switching is the launch line with the other path. The kit copies no auth, sessions, or memory between candidates; say so before the user switches.

For a Compose seat: pull the clone, then run the `build` line and the `up` line of Stage 8a again. The entrypoint generates a candidate beside the profile of the seat and prints the next steps.

## What this skill does not do

It does not install operating-system packages, edit shell startup files, store credentials, run a service, or migrate an existing agent directory. It does not connect an MCP server or enable Promptr, OpenViking, or agent orchestration packages. Those need either a later kit release or the user's own hands.
