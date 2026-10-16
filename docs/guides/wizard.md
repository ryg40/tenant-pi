# Scan-driven setup wizard

`wizard` is an additive terminal flow. It prepares a reviewed private handoff for the guided installing agent. It never installs software.

## Start

Python 3.11 or later and its standard library are sufficient. The Pi question extension is not required.
Confirm the destination, existing account, home, clone, new profile path and new private output directory first.
The private directory's parent must exist. Approve any bootstrap or parent creation separately.

```sh
python3 scripts/tenant_pi.py wizard --account "$(id -un)" --home "$HOME" \
  --target "$HOME/new-profile" --private-dir "$HOME/new-private-choices"
```

1. Confirm the displayed identity and scan scope with `scan`.
   The local scanner checks the current account, fixed versions, known kit resource directories and target absence.
2. Use arrows and Space to select components.
   Core features appear first and stay locked; optional features start unchecked.
3. Press `d` for complete component details, including bundled skills and prerequisites.
   Scrolling exposes every manifest component, including blocked choices.
4. Press `c` to answer the selected configuration questions.
   `/back` returns to the checklist and retains answers; `/clear` clears a field; `/cancel` stops without a persistent write.
5. Read the complete paged plan and the before/after overlay.
   The plan separates selection, detected state, proposed action and unverified runtime behavior.
6. Type the displayed `SAVE <digest>` only to save the new private handoff directory.
   This approves the listed private files, not installation, account creation, shared changes or privileged commands.

The UI uses standard error. Standard output contains one JSON result without terminal control codes.
With no terminal, numbers toggle components and `c`, `b`, `q` remain available. EOF never means yes.
`--format json` returns checklist data without scanning, prompting, writing or inferring approval.
Narrow windows keep short control labels. `d` recovers truncated details.

## Existing choices

Pass `--overlay` to load an explicit private overlay. Its selections, including memory choices, remain selected.
Pass `--local-dir` when its fixed inputs are elsewhere; the default is the overlay's parent.
Pass `--registry` for existing model-route capability evidence. This is not a runtime model catalog.
The wizard never reads installed settings, authentication or vault contents.

The original overlay is never replaced. The reviewed output is a new overlay in a new private directory.
Input byte hashes and file identities are checked before saving. Concurrent changes stop the save.
Local scans repeat before saving; changed facts invalidate approval. Saved approval is not reusable execution authority.
A digest detects changes, not forged evidence or an untrusted author.

The deterministic `components` command retains its legacy recommended marks for compatibility.
Those marks are not fresh wizard defaults. `validate`, `plan`, `generate` and `components` remain non-executors.

## Scans and handoff

Version probes use an empty temporary home, no inherited credential values, no shell, bounded output and a process-group timeout.
The wizard removes the temporary home after scanning. Present kit files do not prove profile activation.
Failed probes are unknown. Missing executables, incompatible versions and compatible versions remain distinct.
Accepted but untested Pi stays in place with its readiness gap and no Pi installation command.
An unknown or incompatible Pi never produces an automatic replacement command.

The saved directory contains `overlay.json`, `handoff.json`, `INSTALLER_KIT_RESULTS.md` and selected validated input files.
Directories use mode `0700`; files use `0600`. A failed save may leave partial private files and reports that fact.
No rollback or resumed installation is automatic.

The guided agent reads [INSTALL.md](../../INSTALL.md) and the handoff before any installation.
It rechecks identity, input hashes, target absence and versions, reviews the exact commands, then asks for execution approval.
Ordinary actions run as the target account. Account creation and system dependencies require a separate privileged plan and approval.
Record completed steps, stop on failure, and use `results` at completion or a resumable stop.
Continue with [POST_INSTALL.md](../../POST_INSTALL.md) after installation.

## Direct providers

The supported durable input is `inputs.modelsFile: "inputs/models.json"`.
Every `validate`, `plan` and `generate` call needs the same `--local-dir`.
The input has a closed subset of Pi's `models.json` format:

```json
{
  "providers": {
    "local-server": {
      "baseUrl": "http://127.0.0.1:8080/v1",
      "api": "openai-completions",
      "apiKey": "${LOCAL_MODEL_KEY}",
      "models": [{"id": "served-model"}]
    }
  }
}
```

`apiKey` accepts an environment-variable reference or the fixed dummy value `none` for a server without authentication.
Literal keys, credential commands, headers and unknown fields are rejected. No environment value is resolved.
Provider and model updates preserve other providers and other model entries in the supplied validated input.
The wizard does not import a live `models.json`. It copies no `auth.json`.

Optional metadata fields are `name`, `contextWindow`, `maxTokens`, `reasoning` and `input`.
Supply metadata from server documentation; the kit invents none. Omitted metadata uses Pi's defaults, not verified server capabilities.
Generation writes `models.json` privately into the new candidate and records the definitions for replay validation.
Comparison reports private values as change markers. Carry does not migrate authentication or arbitrary runtime registrations.
Keep the saved input for regeneration; candidate files are not the master copy.

## Remote and Compose routes

`--destination remote` requires `--ssh-target` and `--clone` for the remote kit path.
Without `--evidence`, the wizard stops with the existing display-only SSH handoff. It makes no connection.
Run the wizard as the target account on the remote host after separate connection approval.
Alternatively supply explicit target-bound offline evidence with `--evidence`; confirm it with `evidence` instead of `scan`.
Remote evidence supports a resumable private draft, not executable local-path commands or proof of a remote installation.
The guided agent must rerun and approve the plan on the remote host. SSH host-key and user authentication settings remain unchanged.

The evidence schema contains `schemaVersion: 1`, the exact displayed `identity`, a `check-runtime` report as `runtime`,
a `components` object with every manifest ID, and boolean `targetAbsent`.
Component states are `compatible`, `present`, `missing`, `incompatible` or `unknown`.
Offline evidence is caller-supplied, not an attestation. The wizard rechecks the evidence file, not the remote machine.

`--destination compose` returns the separate `compose-plan` route and its unqualified status.
It creates no Compose seat. See [the Compose guide](compose-seat.md).

## Limits

- No model listing, inference, account creation, service request, package install or privileged execution occurs here.
- Listing and inference questions record separate future intentions. Each later request still requires explicit approval.
- Background model work defaults off. Advanced memory settings use validated JSON, not a complete field-by-field form.
- Existing gateway routes use the saved overlay and registry. The wizard does not construct every optional service binding.
- Node/Python bootstrap and shared Herdr skills remain blocked handoffs requiring separate exact plans.
- Existing vault discovery and baseline checks remain guided steps through `check-wiki-vault`, `baseline` and `check-baseline`.
- Partial save recovery is manual. Results distinguish stopped installation and not-run checks; they do not claim runtime success.
- Automated PTY tests do not prove hands-on usability. Live local, remote and inference trials remain unverified.
