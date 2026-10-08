"""The local results file of one install: `INSTALLER_KIT_RESULTS.md`.

`facts` validates the facts file of the installing agent. `components`, `npm_names` and
`candidate` turn already-loaded kit data into the rows of the file. `render` gives the text:
fixed sentences of the kit with the facts filled in, so the same input gives the same bytes.
These functions are pure: they read no file, environment, clock or host state.

`write` creates the file with mode 0600 in an existing directory, through the ancestor walk
and the file creation of the guarded writer. It replaces an existing file only on request.
The module starts no process. The kit adds no credential value from the overlay: the overlay
gives names only. A free text of the facts file that has a known form of a secret is refused.
That check is a list of patterns: it does not prove that the facts file holds no credential.
"""
import os
import re
import shlex
import stat
from dataclasses import dataclass
from datetime import date

from scripts.candidate_list import child
from scripts.components import names as resource_names
from scripts.memory_modules import MEMORY
from scripts.profile_write import WriteError, _ancestors, _create_file
from scripts.validate import NPM, ROLE_NAMES, absolute, fail, fields, npm_name

NAME = "INSTALLER_KIT_RESULTS.md"
# The name of the new text while it replaces an existing file.
TEMPORARY = NAME + ".new"
FIELD = "results.out_dir"
MODE = "0600"
MAX_PATH = 1024
# Length bound of each free text of the facts file, and item bound of each of its lists.
MAX_TEXT = 200
MAX_ITEMS = 64
MAX_TARGETS = 16
STATUSES = ("complete", "stopped")
STAGE_STATES = ("done", "not_run", "not_applicable", "failed", "blocked")
CHECK_STATES = ("passed", "failed", "not_run", "not_verified")
CANDIDATE_STATES = ("complete", "incomplete", "unmanaged", "invalid", "absent")
DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}\Z")
ACCOUNT = re.compile(r"[A-Za-z_][A-Za-z0-9_.-]{0,63}\Z")
# Forms of a secret in a free text: a private key header, a credential word with a value, a
# token with a known prefix, and a signed web token. A match is a refusal, not a redaction.
# The list is not complete: a secret of another form passes.
SECRET = (
    re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----"),
    re.compile(r"(?i)(?:api[_-]?key|bearer|token|password|passwd|secret)\s*[:=]?\s*['\"]?[A-Za-z0-9_.+=-]{16,}"),
    re.compile(r"\b(?:sk|pk|ghp|gho|ghs|github_pat|glpat|npm|hf|xox[abprs])[-_][A-Za-z0-9_-]{16,}"),
    re.compile(r"\b(?:AKIA[0-9A-Z]{16}|AIza[A-Za-z0-9_-]{35})"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
)
LIVE = "~/.pi/agent"
HEADINGS = ("What the install did", "The account", "How to start Pi", "Where each part is",
            "How the parts work together", "The components", "How to add a component that is off",
            "The checks", "The next document")
WORDS = {"not_run": "not run", "not_applicable": "not applicable", "not_verified": "not verified"}


@dataclass(frozen=True)
class ResultsFile:
    path: str
    replaced: bool
    warnings: tuple[str, ...] = ()


def _line(value, at):
    """One free text of the facts file: one short line, no backtick, no form of a secret."""
    if type(value) is not str or not value or value != value.strip() or "`" in value:
        fail("text", at)
    if any(ord(c) < 32 or 127 <= ord(c) < 160 or c in "  " for c in value):
        fail("line_break" if any(c in value for c in "\n\r\x85  ") else "text", at)
    if len(value) > MAX_TEXT:
        fail("text_too_long", at)
    if any(form.search(value) for form in SECRET):
        fail("secret_like", at)
    return value


def _optional_line(value, at):
    return None if value is None else _line(value, at)


def _rows(value, name, states, at):
    """A list of `{<name>, state, note}` rows; `note` is a free text or null."""
    if type(value) is not list:
        fail("array", at)
    if len(value) > MAX_ITEMS:
        fail("too_many_items", at)
    for row in value:
        fields(row, (name, "state", "note"), (), at)
        _line(row[name], at + "." + name)
        if type(row["state"]) is not str or row["state"] not in states:
            fail("state", at + ".state")
        _optional_line(row["note"], at + ".note")
    if len({row[name] for row in value}) != len(value):
        fail("duplicate_" + name, at)


def facts(data, targets):
    """Validate the loaded facts file against the `--target` list; return it unchanged.

    The schema is closed: an unknown key is `unknown_fields`, a missing key is
    `required_fields`. A diagnostic holds a rule and a field path, never a value.
    """
    fields(data, ("schemaVersion", "date", "installingAgent", "status", "lastStage", "nextStep", "account",
                  "places", "stages", "checks", "wikiVault", "notes"), (), "facts")
    if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1:
        fail("schema_version", "facts.schemaVersion")
    if type(data["date"]) is not str or not DATE.fullmatch(data["date"]):
        fail("date", "facts.date")
    try:
        date(*(int(part) for part in data["date"].split("-")))
    except ValueError:
        fail("date", "facts.date")
    _line(data["installingAgent"], "facts.installingAgent")
    if type(data["status"]) is not str or data["status"] not in STATUSES:
        fail("status", "facts.status")
    _line(data["lastStage"], "facts.lastStage")
    _optional_line(data["nextStep"], "facts.nextStep")
    if data["status"] == "stopped" and data["nextStep"] is None:
        fail("next_step_required", "facts.nextStep")
    account = data["account"]
    fields(account, ("name", "createdByInstall", "openShell"), (), "facts.account")
    if type(account["name"]) is not str or not ACCOUNT.fullmatch(account["name"]):
        fail("account_name", "facts.account.name")
    if type(account["createdByInstall"]) is not bool:
        fail("boolean", "facts.account.createdByInstall")
    _line(account["openShell"], "facts.account.openShell")
    places = data["places"]
    fields(places, (), ("clone", "privateDirectory", "node", "pi", "launchers"), "facts.places")
    for key in ("clone", "privateDirectory"):
        if key in places:
            absolute(places[key], "facts.places." + key)
    for key in ("node", "pi"):
        if key in places:
            _line(places[key], "facts.places." + key)
    launchers = places.get("launchers", [])
    if type(launchers) is not list:
        fail("array", "facts.places.launchers")
    for item in launchers:
        fields(item, ("target", "path"), (), "facts.places.launchers")
        absolute(item["target"], "facts.places.launchers.target")
        absolute(item["path"], "facts.places.launchers.path")
        if item["target"] not in targets:
            fail("launcher_target", "facts.places.launchers.target")
    if len({item["target"] for item in launchers}) != len(launchers):
        fail("duplicate_target", "facts.places.launchers")
    _rows(data["stages"], "stage", STAGE_STATES, "facts.stages")
    _rows(data["checks"], "name", CHECK_STATES, "facts.checks")
    vault = data["wikiVault"]
    fields(vault, ("path", "existedBefore", "kept"), (), "facts.wikiVault")
    if vault["path"] is not None:
        absolute(vault["path"], "facts.wikiVault.path")
    if type(vault["existedBefore"]) is not bool or type(vault["kept"]) is not bool:
        fail("boolean", "facts.wikiVault")
    # A vault that did not exist has no content to keep; no vault has neither fact.
    if vault["kept"] and not vault["existedBefore"] or vault["path"] is None and vault["existedBefore"]:
        fail("wiki_vault", "facts.wikiVault")
    notes = data["notes"]
    if type(notes) is not list:
        fail("array", "facts.notes")
    if len(notes) > MAX_ITEMS:
        fail("too_many_items", "facts.notes")
    for note in notes:
        _line(note, "facts.notes")
    return data


def target_list(targets):
    """Stop at a `--target` list with a bad path, a repeated path or too many paths."""
    for target in targets:
        absolute(target, "results.target")
        if len(target) > MAX_PATH:
            fail("path_too_long", "results.target")
    if len(set(targets)) != len(targets):
        fail("duplicate_target", "results.target")
    if len(targets) > MAX_TARGETS:
        fail("too_many_items", "results.target")
    return targets


def components(known, enabled):
    """(on, off) rows of the manifest components, in manifest order, with extension and skill names.

    `known` is the result of `validate.manifest`. A component that `selection.enable` does not
    name is off, also when `selection.disable` does not name it. The names are those of the
    `components` action: one function gives them to both.
    """
    on, off = [], []
    for cid, item in known.items():
        extensions, skills = resource_names(cid, item)
        row = {"id": cid, "extensions": extensions, "skills": skills}
        (on if cid in enabled else off).append(row)
    return on, off


def npm_names(settings):
    """The names of the npm packages that a loaded `settings.json` declares, in file order."""
    packages = settings.get("packages") if type(settings) is dict else None
    names = []
    for entry in packages if type(packages) is list else []:
        source = entry if type(entry) is str else entry.get("source") if type(entry) is dict else None
        if type(source) is str and source.startswith("npm:") and NPM.fullmatch(source[4:]):
            names.append(npm_name(source[4:]))
    return list(dict.fromkeys(names))


def candidate(directory, present, state, installed, error=False, launcher=None, launcher_present=None):
    """The row of one `--target` directory.

    `state` is the loaded `.tenant-pi/state.json` (None when absent), filtered through the row
    of the `list` action. `installed` maps each declared npm package name to whether the caller
    found its manifest below `<directory>/npm`. `error` says that a kit file did not load.
    """
    row = child("candidate", "dir", state=state)
    if not present:
        status = "absent"
    elif error or row["status"] == "invalid" or (row["status"] == "candidate" and row["filesComplete"] is None):
        status = "invalid"
    elif row["status"] == "unmanaged":
        status = "unmanaged"
    else:
        status = "complete" if row["filesComplete"] else "incomplete"
    return {"directory": directory, "state": status,
            **{key: row.get(key) if status in ("complete", "incomplete") else None
               for key in ("piVersion", "generatedAt")},
            "packages": [{"name": name, "installed": bool(found)} for name, found in installed.items()],
            "launcher": launcher, "launcherPresent": launcher_present}


def _quoted(value):
    """A YAML double-quoted scalar. The values are free of control characters."""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _cell(value):
    return value.replace("|", "\\|")


def _code(value):
    return "`" + value + "`"


def _word(state):
    return WORDS.get(state, state)


def _names(row):
    parts = [kind + " " + ", ".join(_code(name) for name in row[kind]) for kind in ("extensions", "skills") if row[kind]]
    return "; ".join(parts) if parts else "no extension and no skill of its own"


def _table(header, rows):
    return ["| " + " | ".join(header) + " |", "| " + " | ".join("---" for _ in header) + " |",
            *("| " + " | ".join(_cell(cell) for cell in row) + " |" for row in rows)]


def _block(*lines):
    return ["```sh", *lines, "```"]


def render(*, commit, kit_root, overlay_path, overlay, known, facts, candidates):
    """The text of the results file.

    `overlay` is a validated overlay and `known` the manifest components of `validate.manifest`.
    `facts` is a `facts` result and `candidates` a list of `candidate` rows. From the overlay the
    text takes component IDs, consent keys, the switches of the memory choices and role names:
    no endpoint, no model name and no credential value. An install that stopped before it had
    an overlay gives `overlay_path` and `overlay` as None; each component is then off.
    """
    places = facts["places"]
    clone = places.get("clone", kit_root)
    private = places.get("privateDirectory", None if overlay_path is None else overlay_path.rsplit("/", 1)[0] or "/")
    account = facts["account"]
    enabled = [] if overlay is None else overlay["selection"]["enable"]
    on, off = components(known, set(enabled))
    cli = "python3 " + shlex.quote(clone + "/scripts/tenant_pi.py")
    out = ["---", "title: " + _quoted("Results of the installer kit"), "date: " + _quoted(facts["date"]),
           "kitCommit: " + _quoted(commit), "installingAgent: " + _quoted(facts["installingAgent"]),
           "status: " + _quoted(facts["status"]), "lastStage: " + _quoted(facts["lastStage"]),
           "account: " + _quoted(account["name"]),
           "accountCreatedByInstall: " + ("true" if account["createdByInstall"] else "false"),
           "clone: " + _quoted(clone), "privateDirectory: " + ("null" if private is None else _quoted(private)),
           "overlay: " + ("null" if overlay_path is None else _quoted(overlay_path))]
    if candidates:
        out.append("candidates:")
        for item in candidates:
            out += ["  - directory: " + _quoted(item["directory"]), "    state: " + _quoted(item["state"]),
                    "    launcher: " + ("null" if item["launcher"] is None else _quoted(item["launcher"]))]
    else:
        out.append("candidates: []")
    out += [key + ": " + _quoted(places[key]) for key in ("pi", "node") if key in places]
    out += ["componentsOn: [" + ", ".join(_quoted(row["id"]) for row in on) + "]",
            "componentsOff: [" + ", ".join(_quoted(row["id"]) for row in off) + "]", "---", "",
            "# Results of the installer kit", "",
            "This file is local. It holds paths and the account name of this machine. The kit adds no credential value "
            "from the overlay. Do not write a credential value in the facts file.",
            "The kit made it from the overlay, the candidate directories and a facts file of the installing agent."
            if overlay is not None else
            "The kit made it from a facts file of the installing agent. The install has no overlay.",
            ""]

    out += ["## " + HEADINGS[0], ""]
    if facts["status"] == "complete":
        out.append("The install is complete. The last stage is: " + facts["lastStage"])
    else:
        out += ["The install stopped before the end. The last stage is: " + facts["lastStage"], "",
                "The next step is: " + facts["nextStep"]]
    out += ["", "- The date of the install: " + facts["date"], "- The installing agent: " + facts["installingAgent"],
            "- The kit commit: " + _code(commit), ""]
    if facts["stages"]:
        out += _table(("Stage", "State", "Note"),
                      [(row["stage"], _word(row["state"]), row["note"] or "") for row in facts["stages"]])
    else:
        out.append("The installing agent recorded no stage.")
    out += ["", "The states of the stages come from the installing agent. The kit did not measure them."]
    if facts["status"] == "complete" and facts["nextStep"] is not None:
        out += ["", "The next step is: " + facts["nextStep"]]
    if facts["notes"]:
        out += ["", "Notes of the installing agent:", "", *("- " + note for note in facts["notes"])]

    out += ["", "## " + HEADINGS[1], "", "The account of the install is " + _code(account["name"]) + "."]
    out.append("The install created this account." if account["createdByInstall"] else
               "This account existed before the install. The install did not create it.")
    out += ["This command opens a shell of the account:", "", *_block(account["openShell"])]

    out += ["", "## " + HEADINGS[2], ""]
    if not candidates:
        out += ["The kit got no candidate directory. No launcher is recorded.", ""]
    for item in candidates:
        if item["launcher"] is None:
            out += ["No launcher file is recorded for the candidate " + _code(item["directory"]) + ".",
                    "The `plan` action prints its launch line in `commands.launchDisplayOnly`.", ""]
            continue
        out += ["This launcher starts Pi with the candidate " + _code(item["directory"]) + ":", "",
                *_block(shlex.quote(item["launcher"])), ""]
        if not item["launcherPresent"]:
            out += ["Warning: The kit did not find this launcher file.", ""]
    out += ["Run a launcher in a shell of the account " + _code(account["name"]) + ".", "",
            "Warning: A `pi` command without the launcher opens the live directory " + _code(LIVE) +
            ". It does not open the generated profile."]

    rows = [("The clone", _code(clone), "The kit and the in-tree packages. Keep it."),
            ("The private directory", "Not recorded." if private is None else _code(private),
             "The overlay and the records of the install."),
            ("The overlay", "Not made." if overlay_path is None else _code(overlay_path),
             "The choices of the user. The input of `generate`.")]
    for item in candidates:
        detail = "State: " + item["state"] + "."
        if item["piVersion"] is not None:
            detail += " Pi pin: " + item["piVersion"] + "."
        if item["generatedAt"] is not None:
            detail += " Generated at " + item["generatedAt"] + "."
        rows.append(("A candidate directory", _code(item["directory"]), detail))
        if item["launcher"] is not None:
            rows.append(("The launcher of this candidate", _code(item["launcher"]),
                         "Present." if item["launcherPresent"] else "Not found."))
        packages = ", ".join(_code(package["name"]) + (" (installed)" if package["installed"] else " (not installed)")
                             for package in item["packages"])
        rows.append(("The npm packages of this candidate", _code(item["directory"] + "/npm/"),
                     packages or "The profile declares no npm package."))
    for key, label in (("node", "Node"), ("pi", "Pi")):
        rows.append((label, _code(places[key]) if key in places else "Not recorded.",
                     "It comes from the `PATH` of the shell."))
    stores = [cid for cid in MEMORY if cid in enabled]
    if "hermes" in stores:
        rows.append(("The memory store of `hermes`", "Each candidate directory",
                     "`MEMORY.md`, `USER.md`, `projects-memory/` and `pi-hermes-memory/`. Separate for each candidate."))
    vault = facts["wikiVault"]
    if "wiki" in stores and vault["path"] is None:
        home = overlay["memory"]["wiki"]
        rows.append(("The memory store of `wiki`",
                     _code(home["wikiHome"] + "/.llm-wiki/") if "wikiHome" in home else "`~/.llm-wiki/`",
                     "The personal vault. A project can have its own `.llm-wiki/` directory."))
    if "openviking" in stores:
        rows.append(("The memory store of `openviking`", "`~/.openviking/` and the OpenViking server",
                     "The local state is the same for each candidate of the account."))
    if not stores:
        rows.append(("The memory stores", "None", "No memory module is on."))
    if vault["path"] is not None:
        rows.append(("The LLM Wiki vault", _code(vault["path"]),
                     "The vault existed before the install. The kit kept its content." if vault["kept"] else
                     "The vault existed before the install. Its content was not kept." if vault["existedBefore"] else
                     "The vault did not exist before the install."))
    rows.append(("The live agent directory", _code(LIVE),
                 "The kit does not write to it. A `pi` command without the launcher uses it."))
    out += ["", "## " + HEADINGS[3], "", *_table(("Part", "Place", "Note"), rows)]

    out += ["", "## " + HEADINGS[4], "",
            "- The overlay holds the choices of the user. It is the input of the `generate` action.",
            "- The `generate` action writes a new candidate directory. It changes no directory that exists.",
            "- The profile loads the in-tree packages from the clone by path. Do not move the clone and do not delete it.",
            "- The launcher sets `PI_CODING_AGENT_DIR` to the candidate directory. Pi then uses that directory and not "
            + _code(LIVE) + ".",
            "- Pi and Node come from the `PATH` of the shell that runs the launcher.",
            "- Authentication and sessions are separate for each candidate. A new candidate needs a new login.",
            "- A memory store in a candidate directory is separate for each candidate. A memory store in the home "
            "directory is the same for each candidate of the account."]

    out += ["", "## " + HEADINGS[5], ""]
    if overlay is None:
        out += ["The install has no overlay. No component is selected.", ""]
    out += ["These components are on:", ""]
    out += ["- " + _code(row["id"]) + ": " + _names(row) for row in on] or ["- None."]
    out += ["", "These components are off:", ""]
    out += ["- " + _code(row["id"]) + ": " + _names(row) for row in off] or ["- None."]
    if overlay is not None:
        consent = overlay["consent"]
        out += ["", "The consent keys of the overlay:", "",
                *("- " + _code("consent." + key) + ": " + ("true" if consent[key] else "false") for key in sorted(consent))]
        out += ["", "The memory choices of the overlay:", ""]
        block = overlay.get("memory", {})
        for cid in MEMORY:
            choice = block.get(cid)
            if choice is None:
                out.append("- " + _code("memory." + cid) + ": not set")
                continue
            switches = ", ".join(_code(key) + " " + ("true" if value else "false")
                                 for key, value in sorted(choice.items()) if type(value) is bool)
            out.append("- " + _code("memory." + cid) + ": " + (switches or "set"))
        roles = [name for name in ROLE_NAMES if overlay["roles"].get(name) is not None]
        out += ["", "The model roles that are set: " + (", ".join(_code(name) for name in roles) if roles else "none") + "."]

    out += ["", "## " + HEADINGS[6], "",
            "The kit changes no profile in place. Each change is a new candidate."]
    if overlay is None:
        out += ["", "The install has no overlay. Complete the install first: see the next step in the first section."]
    else:
        quoted_overlay = shlex.quote(overlay_path)
        parent = (candidates[0]["directory"] if candidates else overlay["target"]["agentDir"]).rsplit("/", 1)[0]
        local = " --local-dir " + shlex.quote(private)
        out += ["`NEW_NAME` is a name that you select. `COMPONENT_ID` is the ID of the component that you add.", "",
                "1. See each component and its state:", "",
                *("   " + line for line in _block(cli + " components --overlay " + quoted_overlay + " --format text")),
                "2. Print the new selection. The command names each component that is on now, and then the new ID. "
                "The output also holds each ID that the new component requires. The command writes no file:", "",
                *("   " + line for line in _block(
                    cli + " components --select " + ",".join([*(row["id"] for row in on), "COMPONENT_ID"]))),
                "3. Edit the overlay " + _code(overlay_path) + ". Replace its `selection` object with the `selection` "
                "object of the output. Add each key that `prerequisites` names with `overlay:`. Set `target.agentDir` "
                "to a directory that does not exist, for example " + _code(parent + "/NEW_NAME") + ".",
                "4. Validate the overlay:", "",
                *("   " + line for line in _block(cli + " validate --overlay " + quoted_overlay + local)),
                "5. Make the plan. Read `readinessGaps` and `commands.setupDisplayOnly` in its output:", "",
                *("   " + line for line in _block(cli + " plan --overlay " + quoted_overlay + local)),
                "6. Generate the new candidate with its launcher:", "",
                *("   " + line for line in _block(
                    cli + " generate --overlay " + quoted_overlay + local + " --target " + shlex.quote(parent + "/NEW_NAME")
                    + " --launcher " + shlex.quote(private + "/launch-NEW_NAME.sh"))),
                "7. Run the setup lines of the plan in the clone directory " + _code(clone) + ". The plan has one "
                "`pi install` line for each npm package that the new candidate declares. The peer override line "
                "comes after them when a component needs it. Do not run the `npm install --global` line of Pi when "
                "Pi is installed: that line replaces Pi for each profile.",
                "8. Log in again. Start Pi with the new launcher and use `/login`. The new candidate has no login.",
                "9. Use the new launcher from this time on. Keep the old candidate until the new candidate works.",
                "",
                "If the first plan had more options, for example `--registry` or `--runtime-report`, give them again."]
    out += ["",
            "A memory module (" + ", ".join(_code(cid) for cid in MEMORY) + ") needs more than its ID:", "",
            "- Set the consent key `consent.memoryCapture` to `true`. For `openviking`, set "
            "`consent.remoteMemoryWrites` to `true` also.",
            "- Add the choices of the module to the `memory` block of the overlay.",
            "- The background model calls are off until you switch them on. To switch them on, set "
            "`memory.hermes.backgroundReview` or `memory.wiki.backgroundTasks` to `true`, and set the model role "
            "`roles.memory`.",
            "- The document " + _code(clone + "/docs/memory-modules.md") + " gives each field."]

    out += ["", "## " + HEADINGS[7], ""]
    if facts["checks"]:
        out += _table(("Check", "State", "Note"),
                      [(row["name"], _word(row["state"]), row["note"] or "") for row in facts["checks"]])
        missing = [row["name"] for row in facts["checks"] if row["state"] == "not_run"]
        out += ["", "These checks are not run: " + "; ".join(missing) if missing else "Each recorded check is run."]
    else:
        out.append("The installing agent recorded no check. The login and the model reply are not proved.")
    out += ["", "The states of the checks come from the installing agent. The kit ran no check for this file.",
            "A check that is not in the table is not run."]

    out += ["", "## " + HEADINGS[8], "",
            "- " + _code(clone + "/POST_INSTALL.md") + " tells you how to update and change the install.",
            "- " + _code(private + "/install-log.md") + " is the record of the commands of the install."
            if private is not None else "- The install has no private directory, and so no `install-log.md`.", ""]
    return "\n".join(out)


def check_location(out_dir):
    """Static refusal of a bad `--out-dir` form, before any filesystem access; the caller checks its location."""
    absolute(out_dir, FIELD)
    if len(out_dir) > MAX_PATH:
        fail("path_too_long", FIELD)


def write(out_dir, data, replace=False):
    """Create `<out_dir>/INSTALLER_KIT_RESULTS.md` with mode 0600, or raise WriteError.

    The directory exists and belongs to the caller. An existing file stops the write unless
    `replace` is set; it is then replaced in one step by a new file, and only a regular file is.
    """
    try:
        # The walk refuses each linked or unsafe directory of the path, and a left temporary file.
        parent_fd, _ = _ancestors(out_dir + "/" + TEMPORARY)
    except WriteError as exc:
        raise WriteError("temporary_exists" if exc.rule == "target_exists" else exc.rule,
                         FIELD + exc.field[len("target"):]) from None
    except FileNotFoundError:
        raise WriteError("out_dir_missing", FIELD) from None
    except OSError:
        raise WriteError("unsafe_path", FIELD + ".parents") from None
    created = temporary = replaced = False
    failure = None
    warnings = []
    try:
        try:
            found = os.stat(NAME, dir_fd=parent_fd, follow_symlinks=False)
        except FileNotFoundError:
            found = None
        if found is not None and not replace:
            raise FileExistsError
        if found is not None and not stat.S_ISREG(found.st_mode):
            raise WriteError("target_not_regular", FIELD)
        if found is None:
            # Exclusive creation: an entry that appears after the check is refused.
            _create_file(parent_fd, NAME, data)
            created = True
        else:
            try:
                _create_file(parent_fd, TEMPORARY, data)
            except FileExistsError:
                # The name appeared after the walk: the file is of another process, and it stays.
                raise
            except (WriteError, OSError):
                temporary = True
                raise
            temporary = True
            os.replace(TEMPORARY, NAME, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
            temporary, created, replaced = False, True, True
        os.fsync(parent_fd)
    except FileExistsError:
        failure = WriteError("target_exists", FIELD)
    except WriteError as exc:
        failure = WriteError(exc.rule, FIELD, candidate_created=created)
    except OSError:
        failure = WriteError("write_failed", FIELD, candidate_created=created)
    finally:
        if temporary:
            # The existing file stays; only the new text of this call is removed.
            try:
                os.unlink(TEMPORARY, dir_fd=parent_fd)
            except OSError:
                pass
        try:
            os.close(parent_fd)
        except OSError:
            warnings.append("cleanup_failed: results.descriptors")
    if failure is not None:
        raise failure from None
    return ResultsFile(out_dir + "/" + NAME, replaced, tuple(warnings))


def report(result):
    """The report of a written results file."""
    return {"path": result.path, "mode": MODE, "complete": True, "fileCreated": True, "replaced": result.replaced,
            "warnings": list(result.warnings)}
