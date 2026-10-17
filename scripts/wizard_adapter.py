"""The versioned adapter seam of the wizard: catalog rows, typed questions, a scan and plan data of one kit.

The wizard owns the terminal, the answer checks, the digest, the SAVE approval and the private save.
An adapter owns the rows, the questions, the probes and the plan of its kit. See docs/wizard-seam.md.
"""
import copy
import hashlib
import importlib
import importlib.machinery
import importlib.util
import json
import math
import os
import re
import shutil
import subprocess
import sys
import tempfile

from scripts import install_results, models_input
from scripts.validate import ENV, ID, Invalid, absolute, fail, fields, identifier, id_list, text

# The one version of the seam that this wizard supports. An adapter declares it as `seam_version`.
SEAM_VERSION = 1
# The adapters of this kit, by ID. Any other `--adapter` value is the absolute path of an adapter file.
BUILTIN = {"tenant-pi": "scripts.wizard_adapter_tenant_pi"}
# The detected state of one catalog row in a scan.
STATES = ("compatible", "present", "missing", "incompatible", "unknown")
GROUPS = ("core", "optional")
DESTINATIONS = ("local", "remote", "compose")
# The wizard options that only an adapter reads. The wizard refuses one that the adapter does not name.
OPTIONS = ("manifest", "overlay", "local_dir", "registry")
ROW_REQUIRED = ("id", "title", "group", "locked", "requires", "details", "blocked", "defaultSelected")
MAX_ROWS = 256
MAX_DETAILS = 64
MAX_DEPTH = 64
# Names of the extra private files of an adapter: `<name>.json` or `inputs/<name>.json`.
FILE_NAME = re.compile(r"(?:inputs/)?[a-z][a-z0-9-]{0,63}\.json\Z")
FIXED_FILES = ("overlay.json", "handoff.json")


def secret_free(value, at):
    """Refuse a value whose JSON text has a known secret form. This does not recognize every secret."""
    if any(pattern.search(json.dumps(value, ensure_ascii=True)) for pattern in install_results.SECRET):
        fail("secret_like", at)
    return value


def json_value(value, at, limit=1 << 20):
    """Refuse a value that is not plain JSON data, nests deeper than MAX_DEPTH or is larger than `limit`."""
    pending = [(value, 1)]
    while pending:
        item, depth = pending.pop()
        if depth > MAX_DEPTH:
            fail("json_too_deep", at)
        if type(item) is dict:
            if any(type(key) is not str for key in item):
                fail("json_only", at)
            pending.extend((child, depth + 1) for child in item.values())
        elif type(item) in (list, tuple):
            pending.extend((child, depth + 1) for child in item)
        elif not (item is None or type(item) in (str, bool, int) or (type(item) is float and math.isfinite(item))):
            fail("json_only", at)
    if len(json.dumps(value, ensure_ascii=True)) > limit:
        fail("json_too_large", at)
    return value


def _line(value, at, limit):
    text(value, at)
    if len(value) > limit or any(127 <= ord(char) < 160 for char in value):
        fail("text", at)


def validate_catalog(rows, at="wizard.catalog"):
    """Check catalog rows: unique IDs, known requires, locked core rows, no cycle. Returns a copy."""
    if type(rows) is not list or not 1 <= len(rows) <= MAX_ROWS:
        fail("catalog_rows", at)
    json_value(rows, at)
    for row in rows:
        fields(row, ROW_REQUIRED, ("subgroup",), at + ".row")
        identifier(row["id"], at + ".row.id")
        _line(row["title"], at + ".row.title", 80)
        if row["group"] not in GROUPS:
            fail("catalog_group", at + ".row.group")
        if row.get("subgroup") is not None:
            _line(row["subgroup"], at + ".row.subgroup", 40)
        for key in ("locked", "defaultSelected"):
            if type(row[key]) is not bool:
                fail("boolean", at + ".row." + key)
        # Core rows are locked; an optional row is never locked.
        if row["locked"] != (row["group"] == "core"):
            fail("core_locked", at + ".row.locked")
        id_list(row["requires"], at + ".row.requires")
        if type(row["details"]) is not list or len(row["details"]) > MAX_DETAILS:
            fail("catalog_details", at + ".row.details")
        for item in row["details"]:
            _line(item, at + ".row.details", 400)
        if row["blocked"] is not None:
            _line(row["blocked"], at + ".row.blocked", 200)
            if row["group"] == "core" or row["defaultSelected"]:
                fail("blocked_row", at + ".row.blocked")
    by_id = {row["id"]: row for row in rows}
    if len(by_id) != len(rows):
        fail("duplicate_id", at + ".row.id")
    if not any(row["group"] == "core" for row in rows):
        fail("core_required", at)
    for row in rows:
        for dep in row["requires"]:
            if dep not in by_id:
                fail("undeclared_dependency", at + ".row.requires")
            if row["group"] == "core" and by_id[dep]["group"] != "core":
                fail("core_requires_optional", at + ".row.requires")
    done, visiting = set(), set()
    for start in by_id:
        if start in done:
            continue
        stack = [(start, iter(by_id[start]["requires"]))]
        visiting.add(start)
        while stack:
            cid, deps = stack[-1]
            dep = next(deps, None)
            if dep is None:
                stack.pop()
                visiting.discard(cid)
                done.add(cid)
            elif dep in visiting:
                fail("dependency_cycle", at + ".row.requires")
            elif dep not in done:
                visiting.add(dep)
                stack.append((dep, iter(by_id[dep]["requires"])))
    return copy.deepcopy(rows)


def check_scan(data, identity, ids, at="wizard.scan"):
    """Check the shared scan fields and the free `extra` object. Returns a copy."""
    fields(data, ("schemaVersion", "identity", "runtime", "components", "targetAbsent"), ("extra",), at)
    if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1 or data["identity"] != identity:
        fail("identity_mismatch", at)
    if type(data["runtime"]) is not dict:
        fail("object", at + ".runtime")
    if type(data["targetAbsent"]) is not bool:
        fail("boolean", at + ".targetAbsent")
    if type(data["components"]) is not dict or set(data["components"]) != set(ids):
        fail("component_set", at + ".components")
    if any(type(value) is not str or value not in STATES for value in data["components"].values()):
        fail("scan_status", at + ".components")
    if "extra" in data and type(data["extra"]) is not dict:
        fail("object", at + ".extra")
    json_value(data, at)
    secret_free(data, at)
    return copy.deepcopy(data)


def scan_fields(identity, components, runtime=None, extra=None):
    """The shared fields of a local scan of the confirmed account; `extra` holds the fields of the kit."""
    from scripts.wizard_scan import local_identity
    local_identity(identity)
    data = {"schemaVersion": 1, "identity": copy.deepcopy(identity), "runtime": runtime or {},
            "components": components, "targetAbsent": not os.path.lexists(identity["target"])}
    if extra is not None:
        data["extra"] = extra
    return data


def probe(argv):
    """Run one bounded probe without a shell, with an empty temporary home and no inherited credential.

    Returns the completed process, or None when the probe failed to start, timed out or printed too much.
    A failed probe is unknown, not evidence of absence.
    """
    from scripts.wizard_scan import bounded_run
    path = os.environ.get("PATH", os.defpath)
    if shutil.which(argv[0], path=path) is None:
        return None
    with tempfile.TemporaryDirectory(prefix="tenant-pi-wizard-probe-") as empty:
        env = {"PATH": path, "HOME": empty, "LANG": "C"}
        try:
            return bounded_run([shutil.which(argv[0], path=path), *argv[1:]], env=env)
        except (OSError, subprocess.TimeoutExpired):
            return None


# Typed questions. Each helper asks through the `ask(key, label, default, validate)` of the wizard.
# The wizard refuses control characters and known secret forms before a validator runs.

def choice(ask, key, label, choices, default=None):
    """A selection from fixed choices. Returns the chosen text."""
    choices = tuple(choices)
    def check(value):
        if value not in choices:
            fail("choice", "wizard." + key)
    return ask(key, label + " (" + ", ".join(choices) + ")", choices[0] if default is None else default, check)


def text_if(ask, condition, key, label, default="", validate=None):
    """A text that is asked only when `condition` holds. Returns None when it is not asked.

    An earlier answer stays the default for a later run; the plan uses only the answers that it asked.
    """
    return ask(key, label, default, validate) if condition else None


def consent(ask, key, label):
    """A consent. Only `yes` typed in full permits; the default is no. Returns a boolean."""
    return ask(key, label + " Type yes to permit; any other answer means no", "no") == "yes"


def optional(check):
    """A validator that accepts a blank answer and checks any other answer."""
    return lambda value: check(value) if value else None


def absolute_path(at="wizard.answer"):
    """An absolute path. Each part holds letters, digits, `_`, `.`, `-`, spaces or quotes; never `.` or `..`."""
    return lambda value: absolute(value, at)


def url(at="wizard.answer"):
    """A credential-free HTTP or HTTPS URL without a query. The rules are `url` and `credential_free_url`."""
    def check(value):
        try:
            models_input.endpoint(value, at)
        except Invalid as exc:
            # The shared URL check names the rule of the embedding input; a kit answer gets a neutral name.
            if str(exc).startswith("embedding_url:"):
                fail("url", at)
            raise
    return check


def env_name(at="wizard.answer"):
    """An environment variable NAME. Never a value."""
    def check(value):
        if not ENV.fullmatch(value):
            fail("env_name", at)
    return check


def integer(low, high, at="wizard.answer"):
    """A decimal integer from `low` to `high`."""
    def check(value):
        if not re.fullmatch(r"-?[0-9]{1,12}", value) or not low <= int(value) <= high:
            fail("integer_range", at)
    return check


def json_shape(shape, at="wizard.answer"):
    """JSON text of one shape: `str`, `int`, `float`, `bool`, `[shape]` or `{"key": shape}` (closed keys)."""
    def check(value):
        try:
            data = json.loads(value)
        except json.JSONDecodeError:
            fail("json", at)
        _shape(data, shape, at)
    return check


def _shape(data, shape, at):
    if type(shape) is dict:
        fields(data, tuple(shape), (), at)
        for key, inner in shape.items():
            _shape(data[key], inner, at + "." + key)
    elif type(shape) is list:
        if type(data) is not list or len(data) > MAX_ROWS:
            fail("array", at)
        for item in data:
            _shape(item, shape[0], at)
    elif shape is float:
        if type(data) not in (int, float) or not math.isfinite(data):
            fail("number", at)
    elif shape is str:
        _line(data, at, 1000)
    elif type(data) is not shape:
        fail(shape.__name__, at)


class Context:
    """The run of one wizard: the confirmed identity, the options, the tracked input loader.

    `load(path, field, raw=False)` refuses a path under `~/.pi/agent` or a wiki vault, reads one bounded
    regular file without following its final link, and records it; the wizard checks it again before save.
    `state` is the state of the run after `start`. `cli` is the tenant-pi command module; a kit adapter
    does not need it.
    """

    def __init__(self, args, cli, identity, load, adapter_path=None):
        self.args = args
        self.cli = cli
        self.identity = copy.deepcopy(identity)
        self.load = load
        self.kit = str(cli.ROOT)
        self.adapter_path = adapter_path
        self.private_dir = args.private_dir
        self.state = None


class Approval:
    """The SAVE answer binds the digest of one plan. Any later change clears it."""
    approval = None

    def approve(self, plan, response):
        self.approval = plan["digest"] if response == "SAVE " + plan["digest"] else None
        return self.approval is not None

    def check_approval(self, plan):
        if self.approval != plan["digest"]:
            fail("approval_invalidated", "wizard.plan")


class SeamState(Approval):
    """The checklist state of an adapter: selection from catalog rows, answers, scan. Nothing executes."""

    def __init__(self, rows, identity, private_dir=None):
        self.catalog = validate_catalog(rows)
        self.by_id = {row["id"]: row for row in self.catalog}
        self.identity = copy.deepcopy(identity)
        self.private_dir = private_dir
        self.overlay = None
        self.scan = None
        self.answers = {}
        self.added = []
        self.approval = None
        self.selected = self._closure([row["id"] for row in self.catalog if row["defaultSelected"]])

    def _closure(self, chosen):
        enabled, pending = set(), [*(row["id"] for row in self.catalog if row["locked"]), *chosen]
        while pending:
            cid = pending.pop(0)
            if cid in enabled:
                continue
            if self.by_id[cid]["blocked"] is not None:
                fail("blocked_component", "wizard.select")
            enabled.add(cid)
            pending.extend(self.by_id[cid]["requires"])
        return [row["id"] for row in self.catalog if row["id"] in enabled]

    def toggle(self, cid):
        self.approval = None
        if cid not in self.by_id:
            fail("undeclared_component", "wizard.select")
        if self.by_id[cid]["locked"]:
            return "Core is required and locked."
        chosen = [item for item in self.selected if item != cid] if cid in self.selected else [*self.selected, cid]
        enabled = self._closure(chosen)
        if cid in self.selected and cid in enabled:
            return "Required by a selected component; clear its dependents first."
        added = [item for item in enabled if item not in chosen and not self.by_id[item]["locked"]]
        self.selected = enabled
        self.added = sorted((set(self.added) | set(added)) & set(enabled))
        return "Dependencies added: " + ", ".join(added) if added else "Selection changed; nothing executes."

    def rows(self):
        rows = []
        for number, row in enumerate(self.catalog, 1):
            detected = self.scan["components"][row["id"]] if self.scan else "unknown"
            group = "Core features" if row["group"] == "core" else "Optional features"
            rows.append({"number": number, "id": row["id"], "title": row["title"],
                         "group": group + (" / " + row["subgroup"] if row.get("subgroup") else ""),
                         "locked": row["locked"], "marked": row["id"] in self.selected,
                         "requires": list(row["requires"]), "blocked": row["blocked"],
                         "details": [*row["details"], *(["Blocked: " + row["blocked"]] if row["blocked"] else [])],
                         "status": "blocked" if row["blocked"] is not None else "available", "detected": detected,
                         "verification": "not_verified",
                         "action": ("blocked" if row["blocked"] is not None or detected == "incompatible" else
                                    "reuse" if detected in ("compatible", "present") else
                                    "install" if detected == "missing" else "configure")})
        return sorted(rows, key=lambda row: not row["locked"])


class Adapter:
    """The base of an adapter. A kit sets `id` and defines `catalog`, `questions`, `scan` and `plan`.

    The other methods have defaults that fit a kit without its own input files.
    """
    id = None
    seam_version = SEAM_VERSION
    # The wizard options of OPTIONS that this adapter reads from `context.args`.
    options = ()
    destinations = ("local", "remote")
    scope = "Scan scope: the probes of the kit adapter and target absence. No live profile or vault contents."

    def catalog(self, context):
        """The catalog rows of the kit: see validate_catalog for the fields."""
        raise NotImplementedError

    def validate_catalog(self, rows):
        return validate_catalog(rows)

    def start(self, context):
        """The state of one run. The default builds a SeamState from the checked catalog rows."""
        return SeamState(self.validate_catalog(self.catalog(context)), context.identity, context.private_dir)

    def questions(self, state, ask, show):
        """Ask the questions of the kit through `ask(key, label, default="", validate=None)` and `show(text)`."""
        raise NotImplementedError

    def scan(self, identity, context):
        """A local scan: the shared fields (see scan_fields) and the fields of the kit under `extra`."""
        raise NotImplementedError

    def evidence(self, data, state):
        """Check offline scan evidence (`--evidence`) for the rows of this state."""
        return check_scan(data, state.identity, [row["id"] for row in state.rows()], "wizard.evidence")

    def plan(self, state, scan):
        """The plan data: a JSON object with an `overlayAfter` object; the wizard adds the digest."""
        raise NotImplementedError

    def files(self, plan):
        """Extra private files of the handoff: `{name: JSON value}` with names that FILE_NAME allows."""
        return {}

    def results(self, plan, state, directory, kit):
        """The text of INSTALLER_KIT_RESULTS.md."""
        return "\n".join([
            "# Installer kit results", "",
            "Status: stopped. No installation ran. No check ran.", "",
            "- Adapter: `" + self.id + "`, seam version " + str(SEAM_VERSION) + ".",
            "- Plan digest: `" + plan["digest"] + "`.",
            "- Private directory: `" + directory + "`.",
            "- Wizard kit: `" + kit + "`.", "",
            "The directory holds `overlay.json`, `handoff.json`, this file and the extra files of the adapter.",
            "The SAVE answer approves these private files only. It does not approve an installation.",
            "Review the handoff with the guided agent of the kit before any change.", ""])


def check_adapter(adapter, builtin):
    """Refuse an object that is not an Adapter of the supported seam version."""
    if not isinstance(adapter, Adapter):
        fail("adapter_interface", "wizard.adapter.ADAPTER (the file defines ADAPTER, an instance of an Adapter subclass)")
    if type(adapter.seam_version) is not int or adapter.seam_version != SEAM_VERSION:
        fail("seam_version_unsupported", f"wizard.adapter.seam_version (this wizard supports {SEAM_VERSION})")
    if type(adapter.id) is not str or not ID.fullmatch(adapter.id) or (not builtin and adapter.id in BUILTIN):
        fail("adapter_id", "wizard.adapter.id")
    allowed = DESTINATIONS if builtin else ("local", "remote")
    if type(adapter.destinations) is not tuple or not set(adapter.destinations) <= set(allowed):
        fail("adapter_destinations", "wizard.adapter.destinations")
    if type(adapter.options) is not tuple or not set(adapter.options) <= set(OPTIONS):
        fail("adapter_options", "wizard.adapter.options")
    _line(adapter.scope, "wizard.adapter.scope", 400)
    return adapter


def load_adapter(spec, load):
    """The adapter of `--adapter`: a built-in ID, or the absolute path of a Python file that defines ADAPTER.

    `load` is the tracked loader of the wizard. It refuses a file under `~/.pi/agent` or a wiki vault.
    The file runs as code with the rights of this account: review it like the kit itself.
    """
    if spec in BUILTIN:
        return check_adapter(importlib.import_module(BUILTIN[spec]).ADAPTER, True)
    if not spec.startswith("/"):
        if "/" in spec or spec.endswith(".py"):
            fail("adapter_path_relative", "wizard.adapter (the path of an adapter file is absolute)")
        fail("unknown_adapter", "wizard.adapter (an adapter ID is one of: " + ", ".join(sorted(BUILTIN)) + ")")
    absolute(spec, "wizard.adapter")
    if not spec.endswith(".py"):
        fail("adapter_file", "wizard.adapter (an adapter file ends in .py)")
    source = load(spec, "wizard.adapter", raw=True)
    name = "tenant_pi_wizard_adapter_" + hashlib.sha256(spec.encode()).hexdigest()[:16]
    module = importlib.util.module_from_spec(importlib.machinery.ModuleSpec(name, None, origin=spec))
    module.__file__ = spec
    sys.modules[name] = module
    try:
        exec(compile(source, spec, "exec", dont_inherit=True), module.__dict__)
    except Exception as exc:
        sys.modules.pop(name, None)
        # The class name only: the text of an exception can hold input values.
        fail("adapter_load", "wizard.adapter (" + type(exc).__name__ + ")")
    return check_adapter(getattr(module, "ADAPTER", None), False)
