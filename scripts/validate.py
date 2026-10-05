#!/usr/bin/env python3
"""Offline, read-only validation of tenant-pi v1 source and local-choice JSON.

Run directly, this checks structure only: it follows symlinks and sets no input size limit.
Use `scripts/tenant_pi.py validate` for the bounded, no-follow input loader.
"""
import argparse
import json
import re
import sys
import unicodedata
from pathlib import Path
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT))

ID = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*\Z")
ENV = re.compile(r"[A-Z][A-Z0-9_]*\Z")
HEX = re.compile(r"[0-9a-f]{40}\Z")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?\Z")
# An npm spec is a package name, optionally followed by one exact version. A tag, a range,
# `latest`, and every other form are rejected. Without a version the package follows the
# registry at install time; `pi update` moves it.
NPM = re.compile(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*(?:@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)?\Z")


def npm_parts(spec):
    """`(name, version)` of an npm spec; `version` is `None` when the spec has no version."""
    cut = spec.rfind("@")
    if cut <= 0:  # no version, or a scoped name alone
        return spec, None
    return spec[:cut], spec[cut + 1:]


def npm_name(spec):
    return npm_parts(spec)[0]
REF = re.compile(r"\$\{[A-Z][A-Z0-9_]*\}\Z")
ROLE_NAMES = ("interactive", "review", "worker", "research", "memory")
MEMORY = frozenset(("hermes", "wiki", "openviking"))
# Selectable states. `unverified` has no test in this repository yet; its `gaps` enter every plan.
SELECTABLE = ("tested", "unverified")
PACKAGES = "packages"
# In-tree optional modules: component ID -> (package directory, resource kind, resource path).
# One component per extension and per skill; the package directory is the Pi package root.
TREE_COMPONENTS = {
    "tenantext": ("packages/tenantext", "extensions", "extensions/tenantext/index.ts"),
    "codex-accounts": ("packages/tenantext", "extensions", "extensions/codex-accounts/index.ts"),
    "slopscore": ("packages/tenantext", "extensions", "extensions/slopscore/index.ts"),
    "context-meter": ("packages/tenantext", "extensions", "extensions/context-meter/index.ts"),
    "ops-footer": ("packages/tenantext", "extensions", "extensions/ops-footer/index.ts"),
    "copilot-usage": ("packages/tenantext", "extensions", "extensions/copilot-usage/index.ts"),
    "anthropic-usage": ("packages/tenantext", "extensions", "extensions/anthropic-usage/index.ts"),
    "doctor": ("packages/tenantext", "extensions", "extensions/doctor/index.ts"),
    "resources": ("packages/tenantext", "extensions", "extensions/resources/index.ts"),
    "herdr": ("packages/tenantext", "skills", "skills/herdr"),
    "slopscore-pr": ("packages/tenantext", "skills", "skills/slopscore-pr"),
    "tracker-site": ("packages/tenantext", "skills", "skills/tracker-site"),
    "promptr": ("packages/promptr", "extensions", "index.ts"),
    "promptr-generate-task-prompt": ("packages/promptr", "skills", "skills/promptr-generate-task-prompt"),
    "promptr-handoff": ("packages/promptr", "skills", "skills/promptr-handoff"),
    "promptr-openknowledge-project-pages": ("packages/promptr", "skills", "skills/openknowledge-project-pages"),
    "promptr-watch-herdr-agents": ("packages/promptr", "skills", "skills/watch-herdr-agents"),
}


def _tree_resources(kind, item):
    return {key: [item] if key == kind else [] for key in ("extensions", "skills", "prompts", "themes")}


# Reviewed anchors are independent of editable manifest claims. Pins are intentionally
# repeated here so an altered manifest cannot bless an unrelated upstream source.
REVIEWED_SOURCES = {
    "core": {"kind": "npm", "spec": "@earendil-works/pi-coding-agent@1.0.3"},
    "model-routing": {"kind": "builtin"},
    **{cid: {"kind": "tree", "path": path} for cid, (path, _, _) in TREE_COMPONENTS.items()},
    "mcp": {"kind": "npm", "spec": "pi-mcp-adapter"},
    "hermes": {"kind": "npm", "spec": "pi-hermes-memory"},
    "wiki": {"kind": "npm", "spec": "@zosmaai/pi-llm-wiki"},
    "openviking": None,
}
# File/key claims are only for native Pi settings documented at this version.
REVIEWED_CLAIMS = {
    "core": {("settings.json", "/defaultProjectTrust"),
             ("settings.json", "/enableInstallTelemetry"), ("settings.json", "/enableAnalytics")},
    "model-routing": {("settings.json", "/defaultProvider"), ("settings.json", "/defaultModel"),
                      ("settings.json", "/defaultThinkingLevel"), ("settings.json", "/enabledModels"),
                      ("settings.json", "/modelThinkingLevels")},
    # A tree component owns one filter entry of the shared package declaration, never the whole entry.
    **{cid: {("settings.json", "package:" + path + ":" + item)} for cid, (path, _, item) in TREE_COMPONENTS.items()},
    # An empty pointer claims the whole named file (RFC 6901 root); Hermes owns its config file.
    "hermes": {("settings.json", "package:pi-hermes-memory"), ("hermes-memory-config.json", "")},
    "wiki": {("settings.json", "package:@zosmaai/pi-llm-wiki"), ("settings.json", "/llm-wiki")},
    # The adapter owns its whole config file and the `extensions` list that disables `builtin:mcp`.
    "mcp": {("settings.json", "package:pi-mcp-adapter"), ("settings.json", "/extensions"), ("mcp-adapter.json", "")},
}
REVIEWED_RESOURCES = {
    "core": {"extensions": [], "skills": [], "prompts": [], "themes": []},
    "model-routing": {"extensions": [], "skills": [], "prompts": [], "themes": []},
    **{cid: _tree_resources(kind, item) for cid, (_, kind, item) in TREE_COMPONENTS.items()},
    "hermes": {"extensions": ["src/index.ts"], "skills": [], "prompts": [], "themes": []},
    # The wiki package also declares skills, prompts, and an MCP server; only the extension loads.
    "wiki": {"extensions": ["extensions"], "skills": [], "prompts": [], "themes": []},
    "mcp": {"extensions": ["index.ts"], "skills": [], "prompts": [], "themes": []},
}
# The gateway keys of `overlay.endpoints` and `overlay.env` moved with the component split.
MOVED_KEYS = {"tenantext": "codex-accounts"}
GAP_CODE = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*\Z")
INPUT_FILES = {"modelsFile": "inputs/models.json", "mcpFile": "inputs/mcp-adapter.json"}
# Resource kinds an owner package entry may filter; `themes` stays outside the overlay contract.
OWNER_FILTERS = ("extensions", "skills", "prompts")
# The whole pointer grammar of `overlay.unmanaged`: no wildcard, no escape, no empty segment.
POINTER = re.compile(r"/[A-Za-z0-9_.:@-]+(?:/[A-Za-z0-9_.:@-]+)*\Z")
REASON_MAX = 200
# Item bound of `overlay.unmanaged`: `plan`, `generate` and `compare` echo the whole list.
UNMANAGED_MAX = 200
# Resource kinds of `overlay.ownerResources`, in render order, and the bounds of one list.
OWNER_RESOURCES = ("skills", "prompts")
MAX_OWNER_RESOURCES = 64
MAX_OWNER_RESOURCE_PATH = 1024
# The fake `target.agentDir` of the tracked example. The structure rules accept it; the CLI refuses it.
SAMPLE_TARGET = "/home/EXAMPLE_USER/new-agent"


class Invalid(ValueError):
    """Rule and field path only: input values never enter diagnostics.

    `line` and `column` are the place of a JSON syntax error, counted from 1; else both are None.
    """

    def __init__(self, message, line=None, column=None):
        super().__init__(message)
        self.line, self.column = line, column


def fail(rule, field, line=None, column=None):
    raise Invalid(f"{rule}: {field}", line, column)


def place(exc):
    """The `line` and `column` of a JSON syntax error as a mapping, else an empty one; never input text."""
    return {} if exc.line is None else {"line": exc.line, "column": exc.column}


def pairs_unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            fail("duplicate_key", "JSON object")
        result[key] = value
    return result


def parse(data, field, number=None):
    """Parse the bytes of one JSON input with the duplicate-key and number rules.

    Each cause of a failure has its own rule. `number` names the field of the number rule
    (default: `field`).
    """
    number = field if number is None else number
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs_unique,
                          parse_constant=lambda _: fail("number", number))
    except Invalid:
        raise
    except UnicodeError:
        fail("input_encoding", field)
    except json.JSONDecodeError as exc:
        # The parser message can include a fragment of the private input; the place is two integers.
        fail("invalid_json", field, exc.lineno, exc.colno)
    except RecursionError:
        fail("input_too_deep", field)
    except ValueError:
        # An integer with more digits than the Python conversion limit.
        fail("number", number)


def load(path):
    try:
        data = Path(path).read_bytes()
    except FileNotFoundError:
        fail("input_missing", "file")
    except OSError:
        fail("input_unreadable", "file")
    return parse(data, "file", "JSON")


def fields(value, required, optional, at):
    if not isinstance(value, dict):
        fail("object", at)
    if value.keys() - (set(required) | set(optional)):
        fail("unknown_fields", at)
    if set(required) - value.keys():
        fail("required_fields", at)


def text(value, at):
    if not isinstance(value, str) or not value or any(ord(c) < 32 or ord(c) == 127 for c in value):
        fail("text", at)
    if any(c in value for c in ("$", "`")) or "{{" in value or "}}" in value:
        fail("shell_or_template", at)
    return value


def identifier(value, at):
    if not isinstance(value, str) or not ID.fullmatch(value):
        fail("component_id", at)


def path_segment(segment, *, quotes=False):
    allowed = r"[A-Za-z0-9_. '\"-]+" if quotes else r"[A-Za-z0-9_. -]+"
    return bool(segment and segment not in (".", "..") and re.fullmatch(allowed, segment))


def relative(value, at):
    text(value, at)
    if not isinstance(value, str) or value.startswith("/") or not all(path_segment(p) for p in value.split("/")):
        fail("relative_path", at)


def absolute(value, at):
    text(value, at)
    if not isinstance(value, str) or not value.startswith("/") or not all(path_segment(p, quotes=True) for p in value[1:].split("/")):
        fail("absolute_path", at)


def url(value, at):
    if not isinstance(value, str):
        fail("credential_free_https_url", at)
    try:
        p = urlsplit(value)
        # Restrict URL bytes before any later command could interpret them as shell text.
        # Decoding twice also rejects encoded percent signs that hide another escape.
        decoded = unquote(unquote(value))
        if (not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::443)?(?:/[A-Za-z0-9._~/-]*)?", value)
                or not re.fullmatch(r"https://[A-Za-z0-9.-]+(?::443)?(?:/[A-Za-z0-9._~/-]*)?", decoded)
                or p.scheme != "https" or not p.hostname or p.username is not None or p.password is not None
                or p.query or p.fragment or p.port not in (None, 443) or "@" in p.netloc):
            fail("credential_free_https_url", at)
    except ValueError:
        fail("credential_free_https_url", at)


def source(value, at):
    fields(value, ("kind",), ("spec", "url", "commit", "subdir", "pathKey", "path"), at)
    kind = value["kind"]
    forms = {"npm": ("kind", "spec"), "git": ("kind", "url", "commit", "subdir"),
             "local": ("kind", "pathKey"), "builtin": ("kind",), "tree": ("kind", "path")}
    if not isinstance(kind, str) or kind not in forms or set(value) != set(forms[kind]):
        fail("source_form", at)
    if kind == "npm" and (not isinstance(value["spec"], str) or not NPM.fullmatch(value["spec"])):
        fail("exact_npm_pin", at + ".spec")
    if kind == "git":
        url(value["url"], at + ".url")
        if not isinstance(value["commit"], str) or not HEX.fullmatch(value["commit"]):
            fail("full_commit", at + ".commit")
        if value["subdir"] != "":
            relative(value["subdir"], at + ".subdir")
    if kind == "local":
        identifier(value["pathKey"], at + ".pathKey")
    if kind == "tree":
        tree_path(value["path"], at + ".path")


def tree_path(value, at):
    """A package directory of this kit: relative, no `..`, below `packages/`, present, no link out."""
    relative(value, at)  # Rejects an absolute path and every `.` or `..` segment.
    parts = value.split("/")
    if parts[0] != PACKAGES or len(parts) < 2:
        fail("tree_outside_packages", at)
    base = (ROOT / PACKAGES).resolve()
    target = (ROOT / value).resolve()
    if base not in target.parents:
        fail("tree_outside_packages", at)
    if not target.is_dir():
        fail("tree_path_missing", at)


def id_list(value, at):
    if not isinstance(value, list):
        fail("array", at)
    for item in value:
        identifier(item, at)
    if len(set(value)) != len(value):
        fail("duplicate_id", at)


def manifest(data):
    fields(data, ("schemaVersion", "runtime", "components"), (), "manifest")
    if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1:
        fail("schema_version", "manifest.schemaVersion")
    runtime = data["runtime"]
    fields(runtime, ("piVersion", "nodeRange", "pythonRange"), (), "manifest.runtime")
    if not isinstance(runtime["piVersion"], str) or not VERSION.fullmatch(runtime["piVersion"]):
        fail("exact_version", "manifest.runtime.piVersion")
    if runtime["nodeRange"] != ">=22.22.0 <23" or runtime["pythonRange"] != ">=3.11":
        fail("runtime_range", "manifest.runtime")
    components = data["components"]
    if not isinstance(components, dict) or "core" not in components:
        fail("core_required", "manifest.components")
    if runtime["piVersion"] != npm_parts(REVIEWED_SOURCES["core"]["spec"])[1]:
        fail("core_runtime_pin", "manifest.runtime.piVersion")
    if set(components) != set(REVIEWED_SOURCES):
        fail("reviewed_components", "manifest.components")
    claims = []
    path_keys = set()
    for cid, component in components.items():
        identifier(cid, "manifest.components ID")
        at = "manifest.components.item"
        fields(component, ("source", "status", "reason", "requires", "owner", "license", "resources", "env", "configOwnership"), ("gaps",), at)
        ownership = component["configOwnership"]
        fields(ownership, ("claims", "status", "boundary"), (), at + ".configOwnership")
        text(ownership["boundary"], at + ".configOwnership.boundary")
        if ownership["status"] not in ("reviewed", "blocked") or type(ownership["status"]) is not str:
            fail("ownership_status", at + ".configOwnership.status")
        if type(ownership["claims"]) is not list:
            fail("array", at + ".configOwnership.claims")
        if ownership["status"] == "blocked" and ownership["claims"]:
            fail("unreviewed_claim", at + ".configOwnership.claims")
        if ownership["status"] == "reviewed" and (component["status"] not in SELECTABLE or cid not in REVIEWED_CLAIMS):
            fail("unreviewed_claim", at + ".configOwnership.status")
        for claim in ownership["claims"]:
            fields(claim, ("file", "key"), (), at + ".configOwnership.claims")
            for field in ("file", "key"):
                if type(claim[field]) is not str:
                    fail("ownership_claim_type", at + ".configOwnership.claims." + field)
            if (claim["file"], claim["key"]) not in REVIEWED_CLAIMS.get(cid, set()):
                fail("unreviewed_claim", at + ".configOwnership.claims")
            claims.append((claim["file"], claim["key"]))
        if ownership["status"] == "reviewed" and set((c["file"], c["key"]) for c in ownership["claims"]) != REVIEWED_CLAIMS[cid]:
            fail("missing_claim", at + ".configOwnership.claims")
        if not isinstance(component["env"], list):
            fail("array", at + ".env")
        for name in component["env"]:
            if not isinstance(name, str) or not ENV.fullmatch(name):
                fail("env_name", at + ".env")
        if len(set(component["env"])) != len(component["env"]):
            fail("duplicate_env", at + ".env")
        if not isinstance(component["status"], str) or component["status"] not in SELECTABLE + ("blocked",):
            fail("status", at + ".status")
        if component["status"] == "blocked":
            text(component["reason"], at + ".reason")
        elif component["reason"] is not None:
            fail("status_reason", at + ".reason")
        if component["status"] in SELECTABLE and ownership["status"] != "reviewed":
            fail("ownership_blocked", at + ".configOwnership.status")
        gaps = component.get("gaps", [])
        if type(gaps) is not list:
            fail("array", at + ".gaps")
        for gap in gaps:
            fields(gap, ("code", "fact"), (), at + ".gaps")
            if type(gap["code"]) is not str or not GAP_CODE.fullmatch(gap["code"]):
                fail("gap_code", at + ".gaps.code")
            text(gap["fact"], at + ".gaps.fact")
        if len({gap["code"] for gap in gaps}) != len(gaps):
            fail("duplicate_gap", at + ".gaps")
        # `tested` needs a test in this repository and no open gap; `unverified` must name its gaps.
        if (component["status"] == "tested") == bool(gaps) and component["status"] != "blocked":
            fail("status_gaps", at + ".gaps")
        if cid in TREE_COMPONENTS and (component["status"] == "tested" or not gaps):
            fail("status_gaps", at + ".status")
        if component["source"] is None:
            if component["status"] != "blocked":
                fail("missing_pin", at + ".source")
        else:
            source(component["source"], at + ".source")
            if component["source"]["kind"] == "local":
                if component["status"] != "blocked":
                    fail("local_only", at + ".source")
                key = component["source"]["pathKey"]
                if key in path_keys:
                    fail("duplicate_path_owner", at + ".source.pathKey")
                path_keys.add(key)
            elif component["source"] != REVIEWED_SOURCES[cid]:
                fail("reviewed_source", at + ".source")
        id_list(component["requires"], at + ".requires")
        if not isinstance(component["owner"], str) or not ID.fullmatch(component["owner"]):
            fail("owner", at + ".owner")
        text(component["license"], at + ".license")
        resources = component["resources"]
        fields(resources, ("extensions", "skills", "prompts", "themes"), (), at + ".resources")
        for key, items in resources.items():
            if not isinstance(items, list):
                fail("array", at + ".resources." + key)
            for item in items:
                relative(item, at + ".resources." + key)
            if len(set(items)) != len(items):
                fail("duplicate_resource", at + ".resources." + key)
        if cid in REVIEWED_RESOURCES and resources != REVIEWED_RESOURCES[cid]:
            fail("reviewed_resources", at + ".resources")
    if components["core"]["requires"] or components["core"]["source"] != REVIEWED_SOURCES["core"]:
        fail("core_source", "manifest.components.core")
    for i, (file, key) in enumerate(claims):
        for other_file, other_key in claims[:i]:
            if file == other_file and (key == other_key or key == "" or other_key == "" or
                    (key.startswith("/") and other_key.startswith("/") and
                     (key.startswith(other_key + "/") or other_key.startswith(key + "/")))):
                fail("ownership_conflict", "manifest.components.configOwnership.claims")
    visiting, done = set(), set()

    def visit(cid):
        if cid in visiting:
            fail("dependency_cycle", "manifest.components.requires")
        if cid in done:
            return
        visiting.add(cid)
        for dep in components[cid]["requires"]:
            if dep not in components:
                fail("undeclared_dependency", "manifest.components.requires")
            visit(dep)
        visiting.remove(cid)
        done.add(cid)

    for cid in components:
        visit(cid)
    return components


def package_filter(value, at):
    """One filter entry: a relative POSIX path, or a Pi `!pattern` exclusion; never a `..` segment."""
    if not isinstance(value, str):
        fail("package_filter", at)
    exclusion = value.startswith("!")
    allowed = r"[A-Za-z0-9_. *?-]+" if exclusion else r"[A-Za-z0-9_. -]+"
    # Pi reads a leading `+` or `-` as a force-include or force-exclude directive, not as a path.
    if value[:1] in ("+", "-"):
        fail("package_filter", at)
    for segment in (value[1:] if exclusion else value).split("/"):
        if segment in (".", "..") or not re.fullmatch(allowed, segment) or segment != segment.strip(" "):
            fail("package_filter", at)


def owner_packages(data, components):
    """Optional `overlay.ownerPackages`: repo-owned local package paths. No path is opened or resolved."""
    items = data["ownerPackages"]
    if not isinstance(items, list):
        fail("array", "overlay.ownerPackages")
    # Every package directory the kit can declare itself, enabled or not.
    declared = {str(ROOT / component["source"]["path"]) for component in components.values()
                if component["source"] is not None and component["source"]["kind"] == "tree"}
    seen = set()
    for item in items:
        at = "overlay.ownerPackages.item"
        if not isinstance(item, str):
            fields(item, ("source",), OWNER_FILTERS, at)
            for key in OWNER_FILTERS:
                if key not in item:
                    continue
                if not isinstance(item[key], list) or len(set(map(repr, item[key]))) != len(item[key]):
                    fail("package_filter", at + "." + key)
                for entry in item[key]:
                    package_filter(entry, at + "." + key)
        source = item if isinstance(item, str) else item["source"]
        absolute(source, at + ".source")
        if source in seen:
            fail("duplicate_source", at + ".source")
        seen.add(source)
        if source in declared:
            fail("duplicate_package", at + ".source")


def unmanaged(items):
    """Optional `overlay.unmanaged`: accepted `settings.json` differences. No pointer is resolved."""
    if not isinstance(items, list):
        fail("array", "overlay.unmanaged")
    if len(items) > UNMANAGED_MAX:
        fail("unmanaged_count", "overlay.unmanaged")
    seen = set()
    for item in items:
        at = "overlay.unmanaged.item"
        fields(item, ("key", "reason"), (), at)
        key, reason = item["key"], item["reason"]
        if not isinstance(key, str) or not POINTER.fullmatch(key):
            fail("pointer", at + ".key")
        if not isinstance(reason, str) or not reason.strip():
            fail("reason_required", at + ".reason")
        if len(reason) > REASON_MAX:
            fail("reason_length", at + ".reason")
        # Category Cc: the C0 range, DEL and the C1 range. The reason is echoed by `plan` and `compare`.
        if any(unicodedata.category(c) == "Cc" for c in reason):
            fail("reason_control_character", at + ".reason")
        if key in seen:
            fail("duplicate_pointer", at + ".key")
        seen.add(key)


def owner_resources(data):
    """Optional `overlay.ownerResources`: owner skill and prompt directories. No path is opened or resolved."""
    value = data["ownerResources"]
    fields(value, (), OWNER_RESOURCES, "overlay.ownerResources")
    target = data["target"]["agentDir"]
    kit = str(ROOT / PACKAGES)
    for kind in OWNER_RESOURCES:
        if kind not in value:
            continue
        at = "overlay.ownerResources." + kind
        items = value[kind]
        if not isinstance(items, list):
            fail("array", at)
        if len(items) > MAX_OWNER_RESOURCES:
            fail("resource_count", at)
        seen = set()
        for item in items:
            # Pi trims an entry before it resolves the path: `/ ` is `/` and `/a/ ` is `/a/`.
            if isinstance(item, str) and (item != item.strip() or any(
                    segment and not segment.strip() for segment in item.split("/"))):
                fail("resource_whitespace", at)
            # Pi reads a leading `!`, `+` or `-` as a filter directive, not as a path.
            if isinstance(item, str) and item[:1] in ("!", "+", "-"):
                fail("resource_directive", at)
            absolute(item, at)
            if len(item) > MAX_OWNER_RESOURCE_PATH:
                fail("resource_path_length", at)
            # The profile directory is host-only; Pi discovers its `skills/` and `prompts/` on its own.
            if item == target or item.startswith(target + "/"):
                fail("inside_target", at)
            # The package directories of the kit load through `selection` only. An entry in, at or
            # above `packages/` of the kit would load a component that is disabled or blocked.
            if (item + "/").startswith(kit + "/") or (kit + "/").startswith(item + "/"):
                fail("kit_package", at)
            if item in seen:
                fail("duplicate_resource", at)
            seen.add(item)


def overlay(data, components):
    fields(data, ("schemaVersion", "target", "selection", "paths", "roles", "endpoints", "env", "inputs", "consent"), ("modelRoutes", "memory", "ownerPackages", "unmanaged", "ownerResources"), "overlay")
    if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1:
        fail("schema_version", "overlay.schemaVersion")
    fields(data["target"], ("agentDir",), (), "overlay.target")
    absolute(data["target"]["agentDir"], "overlay.target.agentDir")
    fields(data["selection"], ("enable", "disable"), (), "overlay.selection")
    enable, disable = (data["selection"][k] for k in ("enable", "disable"))
    id_list(enable, "overlay.selection.enable")
    id_list(disable, "overlay.selection.disable")
    if "core" in disable or "core" not in enable or set(enable) & set(disable):
        fail("selection_conflict", "overlay.selection")
    for cid in enable + disable:
        if cid not in components:
            fail("undeclared_component", "overlay.selection")
    for cid in enable:
        if components[cid]["status"] not in SELECTABLE:
            fail("blocked_component", "overlay.selection.enable")
        if not set(components[cid]["requires"]) <= set(enable):
            fail("missing_dependency", "overlay.selection.enable")
    paths = data["paths"]
    if not isinstance(paths, dict):
        fail("object", "overlay.paths")
    for key, value in paths.items():
        identifier(key, "overlay.paths ID")
        absolute(value, "overlay.paths")
    allowed_paths = {components[cid]["source"]["pathKey"] for cid in enable
                     if components[cid]["source"] is not None and components[cid]["source"]["kind"] == "local"}
    if not set(paths) <= allowed_paths:
        fail("undeclared_path", "overlay.paths")
    for cid in enable:
        src = components[cid]["source"]
        if src and src["kind"] == "local" and src["pathKey"] not in paths:
            fail("missing_local_path", "overlay.paths")
    if "ownerPackages" in data:
        owner_packages(data, components)
    if "unmanaged" in data:
        unmanaged(data["unmanaged"])
    if "ownerResources" in data:
        owner_resources(data)
    roles = data["roles"]
    fields(roles, (), ROLE_NAMES, "overlay.roles")
    for name, role in roles.items():
        if role is None:
            continue
        at = "overlay.roles.entry"
        fields(role, ("provider", "model", "thinking"), ("route",) if "modelRoutes" in data else (), at)
        for key in ("provider", "model"):
            text(role[key], at + "." + key)
            if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/:-]*", role[key]):
                fail("role_id", at + "." + key)
        if type(role["thinking"]) is not str or role["thinking"] not in ("off", "minimal", "low", "medium", "high", "xhigh", "max"):
            fail("thinking", at + ".thinking")
    endpoints = data["endpoints"]
    if not isinstance(endpoints, dict):
        fail("object", "overlay.endpoints")
    for section in ("endpoints", "env"):
        for old, new in MOVED_KEYS.items():
            if isinstance(data[section], dict) and old in data[section]:
                fail("moved_key", "overlay." + section + "." + old + " is now overlay." + section + "." + new)
    for key, value in endpoints.items():
        identifier(key, "overlay.endpoints ID")
        if key not in enable or key == "core":
            fail("unselected_endpoint", "overlay.endpoints")
        url(value, "overlay.endpoints")
    env = data["env"]
    if not isinstance(env, dict):
        fail("object", "overlay.env")
    for key, value in env.items():
        identifier(key, "overlay.env ID")
        if key not in enable or key == "core":
            fail("unselected_env", "overlay.env")
        if not isinstance(value, str) or not REF.fullmatch(value):
            fail("env_reference", "overlay.env")
        if value[2:-1] not in components[key]["env"]:
            fail("undeclared_env", "overlay.env")
    if "modelRoutes" in data:
        from scripts.model_routes import validate_choices
        validate_choices(data)
    inputs = data["inputs"]
    fields(inputs, ("modelsFile", "mcpFile"), (), "overlay.inputs")
    for key, value in inputs.items():
        if value is not None:
            relative(value, "overlay.inputs." + key)
            if value != INPUT_FILES[key]:
                fail("input_allowlist", "overlay.inputs." + key)
    if inputs["mcpFile"] is not None and "mcp" not in enable:
        fail("unselected_input", "overlay.inputs.mcpFile")
    if inputs["mcpFile"] is None and "mcp" in enable:
        fail("mcp_input_required", "overlay.inputs.mcpFile")
    fields(data["consent"], ("memoryCapture", "remoteMemoryWrites", "telemetry"), (), "overlay.consent")
    if any(type(v) is not bool for v in data["consent"].values()):
        fail("boolean", "overlay.consent")
    if (data["consent"]["memoryCapture"] or data["consent"]["remoteMemoryWrites"]) and not (set(enable) & MEMORY):
        fail("memory_disabled", "overlay.consent")
    if data["consent"]["remoteMemoryWrites"] and "openviking" not in enable:
        fail("remote_memory_disabled", "overlay.consent.remoteMemoryWrites")
    if "memory" in data or set(enable) & MEMORY:
        from scripts.memory_modules import validate_memory
        validate_memory(data, components)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=ROOT / "config/manifest.json")
    parser.add_argument("--overlay", type=Path, required=True)
    args = parser.parse_args()
    try:
        overlay(load(args.overlay), manifest(load(args.manifest)))
    except Invalid as exc:
        parser.exit(2, str(exc) + "".join(f" {key}={value}" for key, value in place(exc).items()) + "\n")
    print("valid: structural contract only; no package or runtime qualification")


if __name__ == "__main__":
    # Route validation imports this module by package name; keep one Invalid class.
    sys.modules["scripts.validate"] = sys.modules[__name__]
    main()
