# Updates and changes after a base install

This file is for a user who has a base install of this kit, or for an agent of that user. You do not read `INSTALL.md` again. Each section below has the commands of one task, the result to check, and one link for the details.

The real paths of this machine are in the results file, `<private dir>/INSTALLER_KIT_RESULTS.md`. That file names the clone, the overlay, each candidate and each launcher. `<private dir>` is usually `.config/tenant-pi` in your home directory. When no private directory exists, the results file is `INSTALLER_KIT_RESULTS.md` in your home directory.

Words used below:

- `<clone>`: the directory of this repository. Run each `python3 scripts/tenant_pi.py` command from `<clone>`.
- `<private dir>`: the directory outside the clone that holds the overlay, the launcher files and the install log, for example `/home/<name>/.config/tenant-pi`.
- `<overlay>`: the overlay file, `<private dir>/overlay.json`.
- `<parent>`: the directory that holds the candidates, for example `/home/<name>/.pi/profiles`.
- `<target>`: the absolute path of one candidate directory. `<old target>` is the candidate in use. `<new target>` is the next candidate, and `<name>` is its last part.

Write each path as an absolute path with the home directory written out, for example `/home/<name>/.pi/profiles`. The kit refuses `~`: a path such as `'~/.pi/profiles'` stops an action with `absolute_path`. A path with `"$HOME/..."` in double quotes is also correct in a command: the shell expands it.

The rules of the install stay in force. Write no secret into a file. Never write into `~/.pi/agent`. An agent asks before each command that changes the machine.

## Confirm the base install

1. Read `<private dir>/INSTALLER_KIT_RESULTS.md`. It must name one candidate or more with the state `complete`, each with its launcher.
2. List the candidates, and list what the candidate in use declares:

   ```sh
   python3 scripts/tenant_pi.py list --parent '<parent>'
   python3 scripts/tenant_pi.py inventory --dir '<old target>'
   ```

   `list` shows the candidate with `"status":"candidate"` and `"filesComplete":true`. `inventory` shows `"managed":true` and the package sources of the candidate. See [the candidate list](docs/candidate-list.md).
3. Compare the runtime with the kit, in the shell that launches Pi:

   ```sh
   python3 scripts/tenant_pi.py check-runtime > '<private dir>/runtime.json'; cat '<private dir>/runtime.json'
   ```

   `node` shows `match`, and `pi` shows `match` or `untested_in_range`. Exit code 1 is a finding, not a failure: the file holds the report.

If a step gives another result, stop. The base install is not complete: `INSTALL.md` is the document for that state.

## The one rule: each change is a new candidate

The kit changes no profile in place. A change is an edit of the overlay, then a new candidate directory with a new launcher. The old candidate stays as it is and is the fallback. Each task below names only what differs from this loop.

1. Edit `<overlay>`. Make the change of the task, and set `target.agentDir` to `<new target>`, a directory that does not exist.
2. Validate the overlay, then make the plan:

   ```sh
   python3 scripts/tenant_pi.py validate --overlay '<overlay>' --local-dir '<private dir>'
   python3 scripts/tenant_pi.py plan --overlay '<overlay>' --local-dir '<private dir>' --runtime-report '<private dir>/runtime.json' --launcher '<private dir>/launch-<name>.sh'
   ```

   `validate` prints `"valid":true`. Read `readinessGaps` and `commands.setupDisplayOnly` of the plan.
3. Generate the candidate:

   ```sh
   python3 scripts/tenant_pi.py generate --overlay '<overlay>' --local-dir '<private dir>' --runtime-report '<private dir>/runtime.json' --target '<new target>' --launcher '<private dir>/launch-<name>.sh'
   ```

   The result has `"filesComplete":true`, and `"complete":true` under `launcher`.
4. Record the baseline of the live agent directory: see "Record the baseline of a new candidate".
5. Run the setup lines of the plan: see "Install the declared npm packages of a new candidate".
6. Log in. Run `<private dir>/launch-<name>.sh`, use `/login`, select the model, and exit Pi. A new candidate has no login.
7. Check the candidate. Startup prints no extension error and no peer warning. Run the `check-baseline` line of "Record the baseline of a new candidate": it prints `"result":"unchanged"`. Then compare the two candidates:

   ```sh
   python3 scripts/tenant_pi.py compare --left '<old target>' --right '<new target>' > '<private dir>/report-<name>.json'
   ```

   `changes` of the report holds `/overlay/target/agentDir` and the fields of your change, and no other field.
8. Switch. Use `<private dir>/launch-<name>.sh` from this time on. To go back, run the launcher of the old candidate.

Give each other option of the first plan again, for example `--registry` or `--require-role`. `generate` refuses an existing target with `target_exists: target`, so an old candidate cannot change. Details: [the candidate update guide](docs/guides/candidate-update.md).

## Add or remove a component

1. See each component with its number and its mark. Then print the new selection: name each component that stays on and each new ID, and leave out an ID to remove it.

   ```sh
   python3 scripts/tenant_pi.py components --overlay '<overlay>' --format text
   python3 scripts/tenant_pi.py components --select core,<id>,<id>
   ```

   In the list, a line with `[x]` is on, `requires:` names the components that a line needs, and `needs:` names its prerequisites. The second command writes no file. Its `added` names each required component that the action added. Its `prerequisites` names what each component needs: an `overlay:` key, a `gap:` of the plan, a `setup:` line.
2. Replace the `selection` object of `<overlay>` with the `selection` object of the output. Add each `overlay:` key. Then do the loop.

To remove a memory module (`hermes`, `wiki` or `openviking`), also set `memory.<module>` to `null`. Else `validate` stops with `memory_module_disabled: overlay.memory.<module>`. When no memory module stays on, remove the `memory` block and set `consent.memoryCapture` to `false`. Else `validate` stops with `memory_disabled: overlay.consent`.

`validate` stops with `missing_dependency: overlay.selection.enable` when a required component is off. Details: [the module guide](docs/guides/modules.md#change-a-selection).

## Switch a memory module on

The modules are `hermes`, `wiki` and `openviking`. Each stores session text. Put the module into the selection, then set the consent key and the `memory` block in `<overlay>`:

```json
{
  "consent": {"memoryCapture": true, "remoteMemoryWrites": false, "telemetry": false},
  "memory": {"schemaVersion": 1, "hermes": {"backgroundReview": false},
             "wiki": {"ambientPersonalVault": true, "backgroundTasks": false}, "openviking": null}
}
```

- The `memory` block holds all three module keys. The key of a module that is off is `null`.
- `validate` stops with `memory_choices_required: overlay.memory` without the block, and with `required_fields: overlay.memory` when a module key is absent. With the block and the consent `false`, it stops with `memory_consent_required: overlay.consent.memoryCapture`.
- `openviking` also needs `consent.remoteMemoryWrites: true` and a server of your own.
- All candidates of one account share the LLM Wiki vault `~/.llm-wiki/` below the home directory. The Hermes store is below the profile, so a new candidate starts with an empty one.

Before `wiki` goes on, look for a vault of the account:

```sh
python3 scripts/tenant_pi.py check-wiki-vault
```

- `"result":"vault_exists"`: the candidate uses the vault as it is. The kit refuses a target, a launcher file, a results directory, a baseline file and a private directory that is the vault or is below it, with `under_wiki_vault`. Set `memory.wiki.wikiHome` to the value of `wikiHome.root` only when `personalVault` is `wikiHome`.
- `"result":"second_vault"`: set no `wikiHome`. The candidate uses the vault of the home directory.
- `"result":"no_vault"`: the extension makes the vault at the first start. When `wikiHome` of the output is `null`, set no `wikiHome`: the vault is `.llm-wiki` in the home directory. When it is not `null`, the shell has `WIKI_HOME`: set `memory.wiki.wikiHome` to the value of `wikiHome.root`. Without that key the launch line removes `WIKI_HOME`, and the vault starts in the home directory.
- `"doubled":true`: keep `wiki` off until you decide. The extension moves the inner vault one level up at the first start.
- `ambientPersonalVault`: with `true`, the extension makes a vault when none exists, and it adds text from the vault to each prompt in each directory. With `false`, a start writes nothing, no vault text goes into a prompt, and the wiki tools still use the vault. `wikiHome` needs `true`.
- Leave `memory.wiki.embedding` out, so that an existing store stays unchanged.

[INSTALL.md](INSTALL.md#the-llm-wiki-vault) has the table of each result. See also [the vault check](docs/memory-modules.md#the-vault-check).

The background model calls are off in this block: both modules capture and answer tool calls only.

Warning: the background calls cost tokens on the `roles.memory` model.

To switch them on, set `memory.hermes.backgroundReview` to `true` with `"reviewTransport": "direct"`, or `memory.wiki.backgroundTasks` to `true`, and set the role `roles.memory` to a provider, a model and a thinking level. Without the role, `validate` stops with `memory_role_required`.

Then do the loop. Details: [memory modules](docs/memory-modules.md).

## Install the declared npm packages of a new candidate

Only when the candidate declares an npm source: `hermes`, `wiki`, `mcp` or `questions`. `commands.setupDisplayOnly` of the plan has one `pi install` line for each declared source, and then the peer override line. Run the lines that name `<new target>`, from `<clone>`, in the order of the plan. With `hermes` and `wiki` they are:

```sh
PI_CODING_AGENT_DIR='<new target>' pi install npm:pi-hermes-memory
PI_CODING_AGENT_DIR='<new target>' pi install npm:@zosmaai/pi-llm-wiki
PI_CODING_AGENT_DIR='<new target>' node scripts/patch_extension_peers.mjs
```

- Use each source string as the plan prints it. With another string, Pi rewrites `settings.json`.
- Do not run the `npm install --global` line of the plan when Pi is installed. That line replaces Pi for each profile.

Done when `PI_CODING_AGENT_DIR='<new target>' pi list` prints a path line that starts with `<new target>/npm/node_modules/` below each declared source, and a second run of the override script prints nothing. Details: [host peer overrides](docs/host-peer-overrides.md).

## Update the npm packages of one candidate

Run both lines from `<clone>`. Details: [host peer overrides](docs/host-peer-overrides.md#reapply-it-automatically-after-each-extension-update).

```sh
PI_CODING_AGENT_DIR='<target>' pi update --extensions
PI_CODING_AGENT_DIR='<target>' node scripts/patch_extension_peers.mjs
```

- The first line moves only an installed source without a version (`hermes`, `wiki`, `mcp`) to the newest registry version. It is the one task that changes a candidate in place.
- A source with an exact version (`questions`) does not move. Its version changes with a new kit version and a new candidate.
- An update writes the upstream manifests again. Run the second line after each update. A second run of it prints nothing.
- With `wiki`: at `@zosmaai/pi-llm-wiki` 0.12.5 a start changes no existing file of a vault and adds only `meta/qmd/`. Not verified: a newer version. Record a new baseline of the vault before the update, and run the vault check after the next launch: see "Record the baseline of a new candidate". That check is the proof for the installed version.

## Keep an accepted difference

Some keys of `settings.json` have no overlay field, for example `npmCommand` of the peer override wrapper. List the pointer of the key in `unmanaged` of `<overlay>`, with a reason. Details: [accepted drift](docs/accepted-drift.md).

```json
{"unmanaged": [{"key": "/npmCommand", "reason": "Reviewed npm wrapper; kept on purpose."}]}
```

- The next `compare` reports that key under `accepted`, not under `changes` or `unsupported`.
- The kit writes no accepted value into a new candidate. Apply the value by hand to each new candidate after review. For `npmCommand`, copy the wrapper files into `<new target>/local-overrides/` and add the key to `<new target>/settings.json`.

## What a new candidate does not get

A candidate comes from the overlay, not from the old candidate. The kit copies nothing between candidates.

| Not in a new candidate | What to do |
| --- | --- |
| Authentication (`auth.json`) | Log in again with `/login` in the new candidate. |
| Sessions (`<target>/sessions`), and the memory stores of the profile, for example the Hermes store | They stay in the old candidate. |
| A model choice from `/model`, and each other edit inside Pi | Carry it into the overlay first: see the next section. |
| The installed npm packages | Run the setup lines again. |
| `models.json` of a direct provider | Copy your master copy into the new candidate: see "Add a provider or a model route". |

All candidates of one account share what is outside the candidate directories: the `pi` command, Node, the clone, the LLM Wiki vault `~/.llm-wiki/` below the home directory, and the keyring of the operating system. Going back to an old candidate is not a data rollback. Details: [candidate comparison](docs/candidate-compare.md#switching-profiles).

## Take over a choice that you made inside Pi

1. Compare, with the candidate that holds the choice on the right. Then print the overlay patches:

   ```sh
   python3 scripts/tenant_pi.py compare --left '<old target>' --right '<target>' > '<private dir>/report.json'
   python3 scripts/tenant_pi.py carry --report '<private dir>/report.json' --overlay '<overlay>' --right '<target>'
   ```

   `right.drift` of the report has `"status":"owner_edits"`, and `fields` lists each key of `settings.json` that changed after the generation. `carry` writes no file. `--right` is the exact `right.path` of the report.
2. Apply each patch of `patches` to `<overlay>` by hand.
3. Read `notCarried`. A consent change has the reason `consent_decision`: set it by hand after your own decision. A hand edit of `settings.json`, for example `/model`, has the reason `rendered_field`: put it into the overlay field of [the table](docs/candidate-compare.md#drift-owner-edits-inside-a-candidate).

For each difference, select one of three actions: carry it, accept it as drift, or drop it. Details: [carry](docs/carry.md).

## Record the baseline of a new candidate

The baseline proves, after the launch, that the live agent directory did not change. Run the first line before the first Pi command that names `<new target>`, with a new file name. Run the second line after the first launch of the new candidate.

```sh
python3 scripts/tenant_pi.py baseline --dir "$HOME/.pi/agent" --out '<private dir>/live-baseline-<name>.json'
python3 scripts/tenant_pi.py check-baseline --dir "$HOME/.pi/agent" --baseline '<private dir>/live-baseline-<name>.json'
```

- `baseline` prints `"complete":true` under `baseline`. It never replaces a baseline: an existing file stops it with `target_exists: baseline.out`.
- `check-baseline` prints `"result":"unchanged"`. With `changed`, find out whether a Pi ran in the live profile after `recordedAt`. A `pi` command without the launcher counts. Details: [the directory baseline](docs/directory-baseline.md#how-to-read-the-result).

With `wiki` on, also record the baseline of the vault at the same moment, and compare it after the first launch. `<vault>` is `<wikiHome>/.llm-wiki` when the overlay has `memory.wiki.wikiHome`, else the `.llm-wiki` directory in the home directory, written as an absolute path.

```sh
python3 scripts/tenant_pi.py baseline --dir '<vault>' --out '<private dir>/wiki-vault-baseline-<name>.json'
python3 scripts/tenant_pi.py check-baseline --dir '<vault>' --baseline '<private dir>/wiki-vault-baseline-<name>.json'
```

The second line prints `"result":"unchanged"`, or `changed` with only `"modified":["meta"]`: the first start makes the index directory `meta/qmd/` in an existing vault. Each other difference is a stop. [INSTALL.md](INSTALL.md#check-8-the-comparison-of-the-vault) has the table of the outputs.

## Remove a candidate that is not used

The kit has no remove action and deletes nothing. You remove a candidate by hand. Details: [the candidate update guide](docs/guides/candidate-update.md#step-5-switch-profiles).

1. List the candidates, look at the directory, and find each launcher that points at it:

   ```sh
   python3 scripts/tenant_pi.py list --parent '<parent>'
   ls -la '<old target>'
   grep -l -- '<old target> ' '<private dir>'/launch-*.sh
   ```

   Read the name and `generatedAt` of each candidate in the list.
Warning: a removal of the wrong directory deletes `auth.json`, the sessions and the memory of that candidate. Read the path two times before the removal.

2. Delete the directory and its launcher file yourself, when you use neither of them.

## Get a new version of the kit

Details: [the candidate update guide](docs/guides/candidate-update.md#step-1-get-the-new-inputs).

```sh
cd '<clone>' && git pull
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -q
PYTHONDONTWRITEBYTECODE=1 python3 scripts/publish_check.py
python3 scripts/tenant_pi.py check-runtime > '<private dir>/runtime.json'
```

- The two checks end with `OK` and with `publish set valid`. With another result, stop and keep the old candidate.
- The pull changes no file of a profile. A profile loads the in-tree packages from the clone by path, so an existing candidate loads the new package code at its next start.
- Then do the loop with one overlay edit: a new `target.agentDir`. When `changes` of the `compare` report holds only `/overlay/target/agentDir`, the new kit version gives the same profile, and you can keep the old candidate in use.

## Move to a new Pi version

`config/manifest.json` holds the tested version, `runtime.piVersion` (the pin), and the accepted range, `runtime.piAcceptedRange`. One `pi` command serves each profile of the user. Details: [Pi update checks](docs/pi-update.md).

- Read the `pi` entry of `check-runtime` after each change of Pi or Node, and make the runtime report again.
- `match`: the installed Pi is the pin. `untested_in_range`: the installed Pi is in the accepted range, and the kit tests did not run on it. Keep it, and record the gap `core_runtime_untested_in_range`.
- `mismatch`: the installed Pi is outside the range. The global install line of the plan replaces Pi for each profile. Run it only after your own decision.
- The pin moves only with a new kit version. Then get that version and do the loop.

## Add a provider or a model route

Details: [the provider guide](docs/guides/providers.md).

- A login to a provider that Pi includes: launch the candidate and use `/login`. The login stays in that candidate.
- A local provider (llama-swap, vLLM): the registration is `models.json` of the candidate. The kit does not write it, and `inputs.modelsFile` of the overlay stays `null`. After each generation, copy your master copy: `install -m 600 '<private dir>/models.json' '<new target>/models.json'`.
- A default model for each new candidate: enable `model-routing` and set `roles.interactive` in `<overlay>`. With `modelRoutes`, give `--registry` to `validate`, `plan` and `generate`. Then do the loop.

## Update a Compose seat

A Compose seat has its own update path: pull the clone, then `build` and `up -d` with the new `KIT_COMMIT`. The entrypoint generates a candidate beside the profile of the seat, and the `logs` line shows the next steps. Details: [the Compose seat guide](docs/guides/compose-seat.md#updates).

Warning: never run a line with `down -v` for an update. It removes the profile and the sessions.

## Write the results file again

After each change, render the complete file again. Add the new launcher to `places.launchers` of the facts file of the install first. Name each candidate that you keep:

```sh
python3 scripts/tenant_pi.py results --facts '<private dir>/results-facts.json' --overlay '<overlay>' --target '<old target>' --target '<new target>' --out-dir '<private dir>' --replace
```

The result has `"complete":true` and `"replaced":true`. Without `--replace`, an existing file stops the action with `target_exists: results.out_dir`. Record the change in `<private dir>/install-log.md` too. Details: [the results file](docs/install-results.md).
