# Wizard adapter seam

The wizard of this kit can start the setup of another kit.
An adapter gives the catalog, the questions, the scan and the plan of one kit.
The seam is the contract between the wizard and an adapter. This document is the contract of seam version 1.
The code of the seam is `scripts/wizard_adapter.py`. The default adapter is `tenant-pi`, in `scripts/wizard_adapter_tenant_pi.py`.
For the use of the wizard, read [the wizard guide](guides/wizard.md).

## What the wizard keeps

The wizard does these steps for every adapter. An adapter cannot change them.

- The terminal: the checklist with arrows or numbers, the paged plan, and `/back`, `/clear` and `/cancel`.
- The answer checks: the wizard refuses control characters and known secret forms before a validator runs.
- The terminal text: the wizard removes escape sequences from the `show` text and the `ask` labels of the adapter. It shows each other control character as `?`.
- The results check: the wizard refuses a results text with a control character other than a line break, or with a known secret form.
- The refusals of the target, the private directory and each input path.
- The digest of the plan, the `SAVE <digest>` approval, the rechecks before save and the private save.
- The fixed files `overlay.json`, `handoff.json` and `INSTALLER_KIT_RESULTS.md` with modes `0600` and `0700`.

## The version rule

`SEAM_VERSION` is `1`. An adapter declares the version in its `seam_version` attribute.
The wizard refuses any other value with this error:

```text
seam_version_unsupported: wizard.adapter.seam_version (this wizard supports 1)
```

A change that an existing adapter cannot follow gets a new version number.
A new optional method with a default in the base class keeps the version.
A kit pins a tenant-pi release tag. Move the pin and the adapter file together.

## Select an adapter

`--adapter` takes `tenant-pi` (the default) or the absolute path of a Python file that ends in `.py`.

```sh
python3 scripts/tenant_pi.py wizard --adapter "$HOME/other-kit/wizard_adapter.py" \
  --account "$(id -un)" --home "$HOME" --target "$HOME/new-profile" --private-dir "$HOME/new-private-choices"
```

The wizard reads the adapter file like the other inputs:

1. It refuses a path under `~/.pi/agent` or under a wiki vault. The file does not run then.
2. It reads one regular file of at most 1 MiB and does not follow a final link.
3. It records the file identity and content, and checks them again before save. A changed file stops the save with `input_changed: wizard.approval`.
4. It runs the file once. The file defines `ADAPTER`, an instance of a subclass of `Adapter`.

A refused `--adapter` value gives one of these errors. Each names the rule:

```text
unknown_adapter: wizard.adapter (an adapter ID is one of: tenant-pi)
adapter_path_relative: wizard.adapter (the path of an adapter file is absolute)
adapter_file: wizard.adapter (an adapter file ends in .py)
adapter_interface: wizard.adapter.ADAPTER (the file defines ADAPTER, an instance of an Adapter subclass)
```

Warning: the adapter file is code. It runs with the rights of your account. Review it like the kit itself.

The options `--manifest`, `--overlay`, `--local-dir` and `--registry` belong to an adapter that names them in `options`.
The tenant-pi adapter names all four. For another adapter the wizard refuses each of them with `adapter_option`.
An adapter file supports the destinations `local` and `remote`. The `compose` route stays with the tenant-pi adapter.

## The interface

A kit subclasses `Adapter` from `scripts.wizard_adapter`. It sets `id` and defines four methods.
The other members have defaults.

| Member | Required | Contract |
| --- | --- | --- |
| `id` | yes | Lowercase words with hyphens, for example `example-kit`. An adapter file cannot use the ID `tenant-pi`. |
| `seam_version` | no | The base class sets `SEAM_VERSION`. |
| `scope` | no | One line that the wizard shows before the user confirms the scan. |
| `options` | no | The wizard options that the adapter reads from `context.args`. The default is none. |
| `destinations` | no | `("local", "remote")` by default. |
| `catalog(context)` | yes | The catalog rows of the kit. |
| `questions(state, ask, show)` | yes | Asks the questions of the kit through `ask` and shows text through `show`. |
| `scan(identity, context)` | yes | A local scan of the confirmed account. |
| `plan(state, scan)` | yes | The plan data. |
| `start(context)` | no | The state of one run. The default is a `SeamState` from the checked catalog rows. |
| `validate_catalog(rows)` | no | The default runs the seam check. The tenant-pi adapter also runs the full tenant-pi manifest check. |
| `evidence(data, state)` | no | Checks offline scan evidence of `--evidence`. The default runs the seam scan check. |
| `files(plan)` | no | Extra private files of the handoff. The default is none. |
| `results(plan, state, directory, kit)` | no | The text of `INSTALLER_KIT_RESULTS.md`. The default is a short stopped record. |

`context` holds the run: `identity`, `args`, `kit` (the wizard kit path), `adapter_path`, `private_dir`, `state` and `load`.
`context.load(path, field)` reads one JSON input with the rules of the adapter file above.
The wizard checks each loaded file again before save.

An adapter is trusted code. The catalog check has these limits:

- With the default `start`, `SeamState` runs the seam check of the rows. An override of `validate_catalog` can add checks, but the seam check still runs.
- An adapter that overrides `start` returns its own state. The wizard then runs only the checks that this `start` runs. The `start` of the tenant-pi adapter runs the full tenant-pi manifest check and the seam check.
- The wizard does not check catalog rows for known secret forms. The checklist and `--format json` show the rows. A row that the plan holds gets the secret check of the plan.

### Catalog rows

`catalog` returns a list of 1 to 256 objects with these fields:

| Field | Type | Rule |
| --- | --- | --- |
| `id` | text | Unique. Lowercase words with hyphens. |
| `title` | text | At most 80 characters. |
| `group` | text | `core` or `optional`. |
| `subgroup` | text or null | Optional field. At most 40 characters. The checklist shows `Optional features / <subgroup>`. |
| `locked` | boolean | `true` for each core row, `false` for each optional row. |
| `requires` | list of IDs | Each ID is a row of the catalog. A core row requires only core rows. No cycle. |
| `details` | list of text | At most 64 lines of at most 400 characters. The `d` key shows them. |
| `blocked` | text or null | The reason. A core row is never blocked. A blocked row is never selected. |
| `defaultSelected` | boolean | The first selection. Core rows are always selected. |

Text has no control character, no `$`, no backtick and no `{{`. The rows are JSON data only.
`validate_catalog` refuses a row that breaks a rule, with a rule name such as `duplicate_id` or `dependency_cycle`.
The manifest of another kit does not have to pass the tenant-pi component pins of `scripts/validate.py`.

### The state

The default state is a `SeamState`. The adapter reads these members:

- `identity`: the confirmed destination, account, home, target, clone and SSH target.
- `selected`: the selected row IDs in catalog order, with each required row.
- `added`: the rows that a selection added as a dependency.
- `answers`: the answers by key.
- `scan`: the scan or the offline evidence.
- `private_dir`: the new private directory of the handoff.
- `rows()`: the checklist rows with the detected state and the proposed action.

`toggle(id)` changes the selection. It refuses a blocked row and keeps a core row.
Each change clears the approval.

### Questions

`ask(key, label, default="", validate=None)` asks one question and returns the answer text.

1. The earlier answer of `key` is the default. A blank answer takes the default.
2. `/back` returns to the checklist and keeps all answers. `/clear` gives a blank answer. `/cancel` stops without a write.
3. The wizard refuses control characters and known secret forms in the answer, and control characters in the default (`wizard.default`). It removes escape sequences from the label.
4. `validate(value)` runs. A refusal shows the rule and returns to the checklist. The earlier answers stay.
5. The wizard stores the answer in `state.answers[key]`.

The seam exports one helper for each question type:

| Helper | Type | Result |
| --- | --- | --- |
| `choice(ask, key, label, choices, default=None)` | A selection from fixed choices | The chosen text. |
| `text_if(ask, condition, key, label, default="", validate=None)` | A text that the wizard asks only when `condition` holds | The text, or `None` when the wizard does not ask. |
| `ask(key, label, default, validator)` | A validated value | The text. |
| `consent(ask, key, label)` | A consent | `True` only for `yes` typed in full. The default is no. |

The validators are factories. Each takes an optional field name `at` for the error.

- `absolute_path()`: an absolute path. Each part holds letters, digits, `_`, `.`, `-`, spaces, `'` or `"`. The rule `absolute_path` refuses a `.` or `..` part and other characters. The rule `shell_or_template` refuses `$`, a backtick, `{{` and `}}`.
- `url()`: an HTTP or HTTPS URL without credentials and without a query. The rules are `url` and `credential_free_url`.
- `env_name()`: an environment variable name, never a value.
- `integer(low, high)`: a decimal integer from `low` to `high`.
- `json_shape(shape)`: JSON text of one shape. A shape is `str`, `int`, `float`, `bool`, `[shape]` or `{"key": shape}` with closed keys.
- `optional(validator)`: a blank answer passes; another answer goes to the validator.

### Scan

`scan(identity, context)` returns the shared fields and an optional `extra` object:

```json
{
  "schemaVersion": 1,
  "identity": {"destination": "local", "account": "user", "home": "/home/user", "target": "/home/user/new-profile",
               "clone": "/home/user/tenant-pi", "sshTarget": null},
  "runtime": {},
  "components": {"runtime": "missing", "profile": "missing"},
  "targetAbsent": true,
  "extra": {"cards": [{"name": "card-a", "vramGiB": 24}], "hostRamGiB": 64}
}
```

- `components` has each catalog ID. A state is `compatible`, `present`, `missing`, `incompatible` or `unknown`.
- `runtime` is an object of the kit. The tenant-pi adapter puts the `check-runtime` report there.
- `extra` has a free shape: JSON data only, no secret, at most 64 levels deep and 1 MiB.
- `scan_fields(identity, components, runtime, extra)` builds the shared fields. It refuses another account or home owner.
- `probe(argv)` runs one bounded command without a shell, with an empty temporary home and no inherited credential. It returns `None` when the command fails to start or stop in time.

The wizard runs the scan again before save. A changed result stops the save with `facts_changed`.
A remote destination has no local probe. Supply offline evidence of the same shape with `--evidence`.

### Plan

`plan(state, scan)` returns a JSON object. The object has an `overlayAfter` object: the saved choices of the kit.
It has no `digest`, `adapter` or `seamVersion` key. Its JSON text is at most 4 MiB.
The wizard adds `digest`: the SHA-256 of the plan as JSON with sorted keys, no spaces and ASCII text.
The wizard shows the plan and asks for `SAVE <digest>`.

## The handoff

The wizard saves a new private directory with these files:

| File | Content |
| --- | --- |
| `overlay.json` | `overlayAfter` of the plan. |
| `handoff.json` | The plan with `digest`, and the fields `adapter` (the adapter ID) and `seamVersion`. |
| `INSTALLER_KIT_RESULTS.md` | The text of `results`. The wizard refuses a control character other than a line break (`control_character: wizard.results`) and a known secret form (`secret_like: wizard.results`). |
| Extra files of `files(plan)` | Each name is `<name>.json` or `inputs/<name>.json`. The content is JSON data without a secret. |

The digest does not cover `adapter` and `seamVersion`. The wizard shows both before the SAVE prompt.
To check the digest of `handoff.json`, remove `digest`, `adapter` and `seamVersion`, then compute the SHA-256 again.
The tenant-pi plan is the same as before the seam. A test compares it with a saved fixture.
The fixture holds the kit root as `/KIT_ROOT`, so the test gives the same result in each checkout path.
Regenerate the fixture after a reviewed manifest or plan change: see [the pin move guide](guides/pin-move-release.md#move-pins-and-measured-facts), step 4.

## What a kit must not do

- Install, write a file, send a network request or a model request in an adapter method.
- Read `~/.pi/agent`, an authentication file or the contents of a vault.
- Put a secret value in a row, a question default, a scan or a plan. Ask for variable names only.
- Write to standard output. Standard output holds the one JSON result of the wizard. Use `show` for text.
- Change the digest, the SAVE flow or the fixed file names.
- Import a module of this kit other than `scripts.wizard_adapter`. Only the seam has a version.

## Example

The test adapter [tests/fixtures/wizard_adapter_example.py](../tests/fixtures/wizard_adapter_example.py) shows each part.
It has two core rows, two optional rows with one requirement, one blocked row, each question type,
an added scan field `extra.cards` from a fake probe, and a plan with a refusal text for a target below a minimum.
A short adapter has this form:

```python
from scripts import wizard_adapter as seam

class OtherKit(seam.Adapter):
    id = "other-kit"
    seam_version = seam.SEAM_VERSION

    def catalog(self, context):
        return [{"id": "server", "title": "Server", "group": "core", "locked": True, "requires": [],
                 "details": [], "blocked": None, "defaultSelected": True}]

    def questions(self, state, ask, show):
        seam.choice(ask, "quant", "Quant", ("q4", "q8"))

    def scan(self, identity, context):
        return seam.scan_fields(identity, {"server": "missing"}, extra={"hostRamGiB": 64})

    def plan(self, state, scan):
        return {"overlayAfter": {"selection": state.selected, "quant": state.answers["quant"]}, "evidence": scan}

ADAPTER = OtherKit()
```
