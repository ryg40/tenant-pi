# The results file of an install

Status: offline implementation. The `results` action of `scripts/tenant_pi.py` writes one local Markdown file at the end of an install: `INSTALLER_KIT_RESULTS.md`. The logic is in `scripts/install_results.py`. No install, login, network request or process start exists in it.

## Purpose

At the end of an install the facts are in more than one place: the text of the installing agent, `install-log.md`, the overlay, and the records of each candidate. The results file puts them in one place for the user:

- what the install did, and where it stopped;
- which account the install used, whether the install created it, and how to open a shell of it;
- how to start Pi with the launcher, and what a `pi` command without the launcher does;
- where each part is, and how the parts work together;
- which components are on and off, and how to add a component that is off.

The sentences of the file are fixed text of the kit. The action fills in the facts. So the file does not depend on the wording of the installing agent, and the same input gives the same bytes.

## Command

```sh
python3 scripts/tenant_pi.py results --overlay /home/EXAMPLE_USER/.config/tenant-pi/overlay.json --facts /home/EXAMPLE_USER/.config/tenant-pi/results-facts.json --target /home/EXAMPLE_USER/.pi/profiles/main
python3 scripts/tenant_pi.py results --overlay /home/EXAMPLE_USER/.config/tenant-pi/overlay.json --facts /home/EXAMPLE_USER/.config/tenant-pi/results-facts.json --target /home/EXAMPLE_USER/.pi/profiles/main --out-dir /home/EXAMPLE_USER
python3 scripts/tenant_pi.py results --overlay /home/EXAMPLE_USER/.config/tenant-pi/overlay.json --facts /home/EXAMPLE_USER/.config/tenant-pi/results-facts.json --target /home/EXAMPLE_USER/.pi/profiles/main --target /home/EXAMPLE_USER/.pi/profiles/second --out-dir /home/EXAMPLE_USER --replace
```

| Option | Rule |
| --- | --- |
| `--facts <file>` | Required. The JSON file of the installing agent. See [the facts file](#the-facts-file). |
| `--overlay <file>` | The absolute path of the overlay. It must be valid, as for `validate`. Leave the option out only when the install stopped before it had an overlay. Each component is then off in the file. |
| `--target <dir>` | The absolute path of one candidate directory. Repeat the option for more candidates, 16 maximum. The file lists them in the given order. |
| `--out-dir <dir>` | The absolute path of an existing directory that the caller owns. The action writes `<dir>/INSTALLER_KIT_RESULTS.md`. Without the option, the action prints the text and writes nothing. |
| `--replace` | Replace an existing `INSTALLER_KIT_RESULTS.md` of `--out-dir`. Without the option, an existing file stops the action with `target_exists`. |
| `--manifest <file>` | The reviewed kit manifest. The default is `config/manifest.json` of the clone. |

The file name is fixed. A later candidate does not add to the file: run the action again with each `--target` and with `--replace`. The action then renders the complete file again.

With `--out-dir`, the output is one JSON object:

```json
{"complete":true,"fileCreated":true,"mode":"0600","path":"/home/EXAMPLE_USER/INSTALLER_KIT_RESULTS.md","replaced":false,"warnings":[]}
```

An error is one JSON object on standard error with exit code 2, as for each other action. It holds a rule and a field path and never a value of an input.

## What the action reads

| Source | What the action takes from it |
| --- | --- |
| The Git metadata of the clone | The kit commit, as `generate` records it. `unknown` when the clone has no Git metadata. |
| `config/manifest.json` | The component IDs in manifest order, and the names of the extensions and skills of each component. |
| The `--overlay` file | The IDs of `selection.enable`, the keys of `consent` with their values, the true and false switches of the `memory` block, `memory.wiki.wikiHome` when it is set, and the names of the roles that are set. No provider, no model, no endpoint and no credential name is taken. |
| `<target>/.tenant-pi/state.json` | The state of the candidate, the Pi pin and the generation time, each in the closed form that `list` uses. |
| `<target>/settings.json` | The names of the declared npm packages. |
| `<target>/npm/node_modules/<name>/package.json` | One status call for each declared npm package: present or absent. The file is not opened. |
| Each launcher path of the facts file | One status call: present or absent. The file is not opened. |
| The `--facts` file | Each fact that only the installing agent knows. |

The action reads no `auth.json`, no `models.json`, no session and no memory store. It reads `HOME` and `WIKI_HOME` for the vault rule of [the write](#the-write); it reads no other environment value. It does not run `pi`, `node` or `npm`.

A component is on when `selection.enable` names it. Each other component of the manifest is off, also when `selection.disable` does not name it.

The state of a candidate is one of five words:

| State | Meaning |
| --- | --- |
| `complete` | The state record says that the generation is complete. |
| `incomplete` | The state record says that the generation is not complete. |
| `unmanaged` | The directory has no state record. |
| `invalid` | The state record or `settings.json` does not load, or the record has another shape. |
| `absent` | The directory does not exist. |

A candidate file that does not load is a state and not a stop: the file is also for an install that failed.

The kit records no launcher path in a candidate. The launcher of each candidate comes from `places.launchers` of the facts file.

## The facts file

The installing agent writes one JSON file with the facts that the kit cannot read. The schema is closed: an unknown key stops the action with `unknown_fields`, and a missing key stops it with `required_fields`. Only the keys of `places` are optional.

```json
{
  "schemaVersion": 1,
  "date": "2030-01-01",
  "installingAgent": "EXAMPLE_AGENT",
  "status": "complete",
  "lastStage": "Stage 9: first launch and checks",
  "nextStep": null,
  "account": {
    "name": "EXAMPLE_USER",
    "createdByInstall": true,
    "openShell": "sudo -iu EXAMPLE_USER"
  },
  "places": {
    "clone": "/home/EXAMPLE_USER/tenant-pi",
    "privateDirectory": "/home/EXAMPLE_USER/.config/tenant-pi",
    "node": "24.0.0",
    "pi": "1.1.0",
    "launchers": [
      {"target": "/home/EXAMPLE_USER/.pi/profiles/main", "path": "/home/EXAMPLE_USER/.config/tenant-pi/launch-main.sh"}
    ]
  },
  "stages": [
    {"stage": "Stage 0: inventory", "state": "done", "note": null},
    {"stage": "Stage 4a: Herdr and the question tool", "state": "not_applicable", "note": "Not selected."},
    {"stage": "Stage 9: first launch and checks", "state": "done", "note": null}
  ],
  "checks": [
    {"name": "Check 1: the login", "state": "not_run", "note": "The user logs in."},
    {"name": "Check 3: the model reply", "state": "not_run", "note": null},
    {"name": "Check 4: the comparison with the baseline", "state": "passed", "note": null}
  ],
  "wikiVault": {"path": null, "existedBefore": false, "kept": false},
  "notes": ["The account has no password."]
}
```

| Key | Rule |
| --- | --- |
| `schemaVersion` | `1`. |
| `date` | The date of the install, `YYYY-MM-DD`, a real calendar date. The action reads no clock. |
| `installingAgent` | A free text: the name of the agent or of the person that did the install. |
| `status` | `complete` or `stopped`. |
| `lastStage` | A free text: the last stage that the install reached. |
| `nextStep` | A free text or `null`. Required as a text when `status` is `stopped`. |
| `account.name` | The account name: a letter or `_`, then letters, digits, `_`, `.` or `-`, 64 characters maximum. |
| `account.createdByInstall` | A boolean. |
| `account.openShell` | A free text: the command that opens a shell of the account. |
| `places.clone` | An absolute path. Default: the clone that runs the action. |
| `places.privateDirectory` | An absolute path. Default: the directory of the `--overlay` file. |
| `places.node`, `places.pi` | A free text each: a path or a version. |
| `places.launchers` | A list of `target` and `path`, each an absolute path. Each `target` is one of the `--target` directories, one time at most. |
| `stages` | A list of `stage` (a free text, unique), `state` and `note` (a free text or `null`). The states: `done`, `not_run`, `not_applicable`, `failed`, `blocked`. |
| `checks` | A list of `name` (a free text, unique), `state` and `note`. The states: `passed`, `failed`, `not_run`, `not_verified`. |
| `wikiVault.path` | The absolute path of the LLM Wiki vault, or `null` when there is none. |
| `wikiVault.existedBefore`, `wikiVault.kept` | Booleans. `kept` is `true` only when `existedBefore` is `true`. Both are `false` when `path` is `null`. |
| `notes` | A list of free texts. |

A list holds 64 items at most.

### Free text

A free text is one line of 200 characters at most. These values stop the action:

| Rule | Value |
| --- | --- |
| `text` | Not a string, empty, a space at an edge, a control character, or a backtick. |
| `line_break` | A line break. |
| `text_too_long` | More than 200 characters. |
| `secret_like` | The form of a secret: a private key header, a credential word such as "password" or "token" with a value of 16 characters or more, a token with a known prefix (for example `sk-`, `ghp_`, `npm_`, `hf_`, `AKIA`, `AIza`), or a signed web token. |

A value with the form of a secret is refused, not redacted: the installing agent corrects the facts file. The check is a list of patterns. It is not complete: a secret of another form passes, and the path fields get no such check. Thus the installing agent must not write a credential value in the facts file. The name of a credential variable is not a secret form. The redaction of `compare` does not fit here: it echoes a value only in a closed form, and a note has no closed form.

Limit: the check finds a form, not a meaning. A secret in another form passes. Do not write a credential value into the facts file.

## The file

The file starts with a frontmatter block. Then it has one title and nine sections, always in this order.

Frontmatter fields: `title`, `date`, `kitCommit`, `installingAgent`, `status`, `lastStage`, `account`, `accountCreatedByInstall`, `clone`, `privateDirectory`, `overlay`, `candidates` (for each: `directory`, `state`, `launcher`), `pi` and `node` when the facts file gives them, `componentsOn` and `componentsOff`.

| Section | Content |
| --- | --- |
| What the install did | Complete or stopped, the last stage, the next step, a table of the stages with their states, and the notes. |
| The account | The name, whether the install created the account, and the command that opens a shell of it. |
| How to start Pi | The launcher of each candidate, and a `Warning:` line: a `pi` command without the launcher opens the live directory `~/.pi/agent`. |
| Where each part is | A table: the clone, the private directory, the overlay, each candidate with its launcher and its npm packages, Node, Pi, the memory stores, the LLM Wiki vault, and the live agent directory. |
| How the parts work together | The overlay as the input of `generate`, the in-tree packages that the profile loads from the clone, `PI_CODING_AGENT_DIR` of the launcher, Pi and Node from the `PATH` of the shell, and what is separate for each candidate. |
| The components | The components that are on and off with the names of their extensions and skills, the consent keys, the memory choices and the role names. |
| How to add a component that is off | The loop with the real paths: the `components` action as a list and with `--select` for the new selection, the edit of the overlay, `validate`, `plan`, `generate` into a new candidate, the setup lines (one `pi install` line for each declared npm package, then the peer override line), a new login, the new launcher. Then the consent key and the `memory` block of a memory module. |
| The checks | A table of the checks with their states, and the checks that are not run. |
| The next document | `POST_INSTALL.md` of the clone and `install-log.md` of the private directory. |

The states of the stages and of the checks come from the installing agent. The action does not measure them and does not run a check.

The file is local. It holds the real paths and the account name of the machine. The kit adds no credential value from the overlay. Do not write a credential value in the facts file: the kit cannot prove that the facts hold none. Do not commit the file and do not publish it. The `.gitignore` template of the private directory ignores `INSTALLER_KIT_RESULTS.md` and `results-facts.json`.

## The write

- The action applies each refusal before the write: the location of `--out-dir`, the manifest, the overlay, the facts file and the `--target` list.
- `--out-dir` is refused inside the kit clone (`under_kit`), inside a personal vault of the wiki extension (`under_wiki_vault`) and inside a `--target` directory (`under_target`). The path counts as written and with its links resolved. Private state stays outside the clone, the kit writes nothing below a vault, and a candidate holds no file that the kit did not declare.
- The vault places are `<HOME>/.llm-wiki`, `<WIKI_HOME>/.llm-wiki` when the variable is set, and `<wikiHome>/.llm-wiki` when the `--overlay` file has `memory.wiki.wikiHome`. With `--out-dir`, `HOME` must be set and must be an absolute path; else the action stops with `home_required: results.home` or `absolute_path: results.home`.
- A `--target` that is a vault or is under one is refused with `under_wiki_vault: results.target`, before the action opens a file of the target: the kit opens no file of a vault. The path counts as written and with its links resolved. Limit: without `--out-dir`, a `HOME` that is not set or is not an absolute path names no vault. The rule then covers the vault of `WIKI_HOME` and the vault of the overlay only. The [memory modules document](memory-modules.md#what-the-kit-does-for-an-existing-vault) gives the rule.
- The action uses the ancestor walk and the exclusive file creation of the guarded writer (`scripts/profile_write.py`), as the launcher file does. A directory of the path that is a link stops the action. The file gets mode `0600`.
- With `--replace` and an existing file, the action writes the new text to `INSTALLER_KIT_RESULTS.md.new` in the same directory and renames it over the file in one step. Only a regular file is replaced: a link or a directory at the name gives `target_not_regular`. A left `.new` file gives `temporary_exists`.
- The action writes nothing else.

## Limits

- The file is as correct as the facts file. The kit cannot prove a stage state, a check state, the account or a version.
- The file does not say which candidate is in use. It lists each candidate that `--target` names.
- The names of the extensions and skills come from the paths of the manifest. A package that names only its entry file gets the name of the package.
- The steps of the section "How to add a component that is off" are text. The action runs none of them.

## Tests

`tests/test_install_results.py` covers: the closed facts schema at each level; each closed value; a free text with a line break, a control character, a backtick or more than 200 characters; a secret form in each free text, which reaches neither the file nor a diagnostic; the component rows and the npm names; each candidate state; the same text on two runs, and for an overlay with its keys in the reverse order; the frontmatter fields; the nine headings in order; a complete install with one candidate; a stop at an early stage without an overlay, and a stop with an overlay; an account that the install created and one that existed; two candidates; a vault that existed before; the new file with mode `0600`; the refusal to replace without `--replace`, and the replacement with it; a link, a directory and a left temporary file at the name; a temporary file of another process, which stays; and CLI runs in a disposable HOME with blocked sockets and subprocesses: the same bytes on two runs, no write outside `--out-dir`, no process start, no open of `auth.json` or `models.json`, the refusal of a directory inside the clone, the refusal of a directory below a vault, with the vault of `wikiHome` of the overlay, and the refusal of a `--target` below a vault with no open below it.
