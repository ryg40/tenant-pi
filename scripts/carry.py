"""Pure derivation of overlay patches from a `compare` report.

Inputs are already-loaded JSON: the report, the user's overlay, the kit manifest, and the
declared files of the right side. The module reads no file, environment, or host state, and
it writes nothing. A patch value comes only from the right side's recorded overlay copy in
`.tenant-pi/choices.json`, never from a rendered file and never from the report, which holds
no private value.
"""
import copy
import json
import re

from scripts.candidate_compare import CHOICES_KEYS, FILES
from scripts.memory_modules import MEMORY, MODULE_FIELDS
from scripts.validate import ID, OWNER_RESOURCES, REVIEWED_SOURCES, ROLE_NAMES, Invalid, fail, manifest, overlay

CHOICES = ".tenant-pi/choices.json"
# The fixed owner-owned table: the overlay keys whose changes `carry` turns into patches.
# `consent` stays outside: a consent change is a user decision, never a patch.
OWNED = ("roles", "modelRoutes", "selection", "endpoints", "env", "ownerPackages", "unmanaged", "memory",
         "ownerResources")
# Files that the kit renders from the overlay: a change there follows its overlay key.
RENDERED = frozenset(name for name in FILES if not name.startswith(".tenant-pi/"))
# The field form of a `compare` report: safe key names or the `<redacted>` placeholder.
FIELD = re.compile(r"(?:/(?:[A-Za-z0-9_.:@-]{1,64}|<redacted>))+\Z")
MAX_FIELD = 512
# The segment names that `compare` prints in a change field. `notCarried` echoes a segment only
# when it is one of these, a reviewed component ID, a role name, or a list index; every other
# segment of a hand-edited report prints as `<redacted>`.
KNOWN_SEGMENTS = frozenset((
    # settings.json
    "defaultProjectTrust", "enableInstallTelemetry", "enableAnalytics", "defaultProvider", "defaultModel",
    "defaultThinkingLevel", "enabledModels", "modelThinkingLevels", "extensions", "packages", "source",
    "resources", "skills", "prompts", "llm-wiki", "ambientPersonalVault", "trajectories", "taskThinkingLevel",
    "taskModel",
    # hermes-memory-config.json and mcp-adapter.json
    "reviewEnabled", "correctionDetection", "flushOnCompact", "flushOnShutdown", "autoConsolidate",
    "memoryOverflowStrategy", "reviewTransport", "llmThinkingOverride", "llmModelOverride", "childExtensionPaths",
    "mcpServers", "disabled", "lifecycle", "transport", "definition", "settings", "hostConfigDiscovery",
    "projectServers", "allowInstall",
    # .tenant-pi/choices.json: the overlay copy and the recorded manifest
    *CHOICES_KEYS, "schemaVersion", "target", "agentDir", "selection", "enable", "disable", "paths", "endpoints",
    "env", "roles", "provider", "model", "thinking", "route", "inputs", "modelsFile", "mcpFile", "consent",
    "memoryCapture", "remoteMemoryWrites", "telemetry", "ownerPackages", "unmanaged", "ownerResources",
    "modelRoutes", "cycle", "gateway", "auth", "runtime", "piVersion", "nodeRange", "pythonRange", "components",
    "status", "metadata",
    # the overlay `memory` block and `ownerResources` (docs/memory-modules.md, docs/owner-resources.md)
    *MEMORY, *(name for group in MODULE_FIELDS.values() for names in group for name in names), *OWNER_RESOURCES,
    # .tenant-pi/state.json
    "provenance", "kitSchemaVersion", "enabled", "pins", "outputs",
    "<redacted>", *ROLE_NAMES, *REVIEWED_SOURCES,
))
INDEX = re.compile(r"(?:0|[1-9][0-9]{0,5})\Z")
CHANGES = ("added", "removed", "changed")
MISSING = object()


def _shown(field):
    """The report field with every segment outside the kit's own names replaced by `<redacted>`."""
    return "".join("/" + (part if part in KNOWN_SEGMENTS or INDEX.fullmatch(part) else "<redacted>")
                   for part in field.split("/")[1:])


def report_entries(report, right_path):
    """The `changes` entries of a report about `right_path`; any other shape stops the action.

    The CLI calls this before it opens a file of `--right`.
    """
    if type(report) is not dict or type(report.get("changes")) is not list:
        fail("report_shape", "report")
    right = report.get("right")
    if type(right) is not dict or type(right.get("path")) is not str or right["path"] != right_path:
        fail("report_right_mismatch", "report.right.path")
    entries = []
    for entry in report["changes"]:
        # The report is a file on disk: a field is echoed only in the form `compare` prints.
        if (type(entry) is not dict or type(entry.get("file")) is not str or entry["file"] not in FILES
                or type(entry.get("field")) is not str or len(entry["field"]) > MAX_FIELD
                or not FIELD.fullmatch(entry["field"]) or entry.get("change") not in CHANGES):
            fail("report_shape", "report.changes")
        entries.append((entry["file"], entry["field"]))
    return entries


def _unit(field):
    """The overlay path that one report field belongs to, or `None` outside the table."""
    parts = field.split("/")[1:]
    if len(parts) < 2 or parts[0] != "overlay" or parts[1] not in OWNED:
        return None
    key, rest = parts[1], parts[2:]
    if key in ("ownerPackages", "unmanaged"):
        return (key,)  # A positional list: one unit.
    if not rest:
        return (key,) if key == "modelRoutes" else None
    if key == "memory":
        # One unit per field, so a field that the report does not name is in no patch.
        if rest[0] == "schemaVersion":
            return (key, rest[0])
        if rest[0] not in MEMORY:
            return None
        if len(rest) == 1:
            return (key, rest[0])  # The module itself: `null` on one side.
        return (key, rest[0], rest[1]) if rest[1] in (*MODULE_FIELDS[rest[0]][0], *MODULE_FIELDS[rest[0]][1]) else None
    if key == "ownerResources":
        return (key, rest[0]) if rest[0] in OWNER_RESOURCES else None  # A positional list per kind.
    if key == "roles":
        return (key, rest[0]) if rest[0] in ROLE_NAMES else None
    if key == "selection":
        return (key, rest[0]) if rest[0] in ("enable", "disable") else None
    if key == "modelRoutes":
        return (key, rest[0]) if rest[0] in ("schemaVersion", "cycle", "gateway") else None
    return (key, rest[0]) if ID.fullmatch(rest[0]) else None  # endpoints, env


def _get(document, path):
    for part in path:
        if type(document) is not dict or part not in document:
            return MISSING
        document = document[part]
    return document


def _dump(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":"))


def _right_overlay(right_files, components):
    """The validated overlay copy of the right side, or a static reason code."""
    choices = right_files.get(CHOICES) if type(right_files) is dict else None
    if choices is None:
        return None, "right_overlay_missing"
    data = choices.get("overlay") if type(choices) is dict else None
    try:
        # Every printed value passes the kit's overlay rules: an env value is a `${NAME}` reference,
        # an endpoint a credential-free HTTPS URL, a reason bounded text.
        overlay(copy.deepcopy(data), components)
    except (Invalid, KeyError, TypeError, ValueError, AttributeError, RecursionError):
        return None, "right_overlay_invalid"
    return data, None


def apply(document, patches):
    """Apply `carry` patches to a copy of an overlay. Patch paths never nest."""
    result = copy.deepcopy(document)
    for patch in patches:
        parts = patch["path"].split("/")[1:]
        parent = _get(result, parts[:-1])
        if patch["op"] == "remove":
            del parent[parts[-1]]
        else:
            parent[parts[-1]] = copy.deepcopy(patch["value"])
    return result


def carry(report, overlay_data, manifest_data, right_files, right_path):
    """Deterministic patch list and `notCarried` list. Prints nothing and writes nothing."""
    components = manifest(manifest_data)
    overlay(overlay_data, components)
    entries = report_entries(report, right_path)
    right, missing_reason = _right_overlay(right_files, components)
    # A memory module with a field entry in the report: the report shows a real change of that module.
    named = {unit[1] for file, field in entries
             if file == CHOICES and (unit := _unit(field)) is not None and len(unit) == 3 and unit[0] == "memory"}
    block = overlay_data.get("memory")
    if (right is not None and "memory" not in right and type(block) is dict
            and any(type(block[cid]) is dict and cid not in named for cid in MEMORY)):
        # The right copy has no block, and `--overlay` holds a module object that the report does not
        # touch: `/memory` must stay. An absent block reads as a block with every module `null`.
        right = {**right, "memory": {**dict.fromkeys(MEMORY), "schemaVersion": block["schemaVersion"]}}
    not_carried, sources = [], {}
    for file, field in entries:
        unit = _unit(field) if file == CHOICES else None
        if unit is None:
            if file in RENDERED:
                reason = "rendered_field"
            elif file == CHOICES and field.split("/")[1:3] == ["overlay", "consent"]:
                reason = "consent_decision"
            elif file == CHOICES and field.split("/")[1:3] in (["overlay", key] for key in OWNED):
                reason = "field_unmapped"
            else:
                reason = "not_owner_owned"
        elif right is None:
            reason = missing_reason
        else:
            # Lift the unit while its parent is absent on either side: the patch must apply as one step.
            while len(unit) > 1 and not (type(_get(overlay_data, unit[:-1])) is dict and type(_get(right, unit[:-1])) is dict):
                unit = unit[:-1]
            if not (unit[0] == "memory" and len(unit) == 2 and type(_get(overlay_data, unit)) is dict
                    and (type(_get(right, unit)) is dict or unit[1] not in named)):
                sources.setdefault(unit, []).append((file, field))
                continue
            # A module object of `--overlay` never carries as a whole: with an object on the right only
            # the named fields carry, and without a named field the report shows no change of the module.
            reason = "overlay_matches"
        not_carried.append({"file": file, "field": _shown(field), "reason": reason})
    patches = []
    for unit in sorted(sources):
        if any(unit[:size] in sources for size in range(1, len(unit))):
            continue  # An enclosing unit carries this one.
        left_value, right_value = _get(overlay_data, unit), _get(right, unit)
        path = "/" + "/".join(unit)
        if (left_value is MISSING and right_value is MISSING) or (
                left_value is not MISSING and right_value is not MISSING and _dump(left_value) == _dump(right_value)):
            for nested in sources:
                if nested[:len(unit)] == unit:
                    not_carried.extend({"file": file, "field": _shown(field), "reason": "overlay_matches"} for file, field in sources[nested])
        elif right_value is MISSING:
            patches.append({"op": "remove", "path": path})
        else:
            patches.append({"op": "replace" if left_value is not MISSING else "add", "path": path,
                            "value": copy.deepcopy(right_value)})
    try:
        overlay(apply(overlay_data, patches), components)
        check = {"status": "valid"}
    except Invalid as exc:
        # A static rule: a carried key can depend on a key outside the table, for example `inputs`.
        check = {"status": "invalid", "rule": str(exc)}
    not_carried.sort(key=lambda item: (item["file"], item["field"], item["reason"]))
    return {
        "patches": patches,
        "notCarried": not_carried,
        "patchedOverlay": check,
        "scope": {"ownerOwned": list(OWNED),
                  "note": "Prints only. Review the patches and apply them to the overlay by hand. Values come from the right side's recorded overlay copy."},
    }
