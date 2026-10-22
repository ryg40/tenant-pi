#!/usr/bin/env python3
"""Offline, read-only validation of the kit manifest, and the shared input rules of the kit scripts.

Run directly, this checks `config/manifest.json`, or the file of `--manifest`, and prints `valid`.
"""
import argparse
import errno
import json
import os
import re
import stat
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT))

ID = re.compile(r"[a-z][a-z0-9]*(?:-[a-z0-9]+)*\Z")
ENV = re.compile(r"[A-Z][A-Z0-9_]*\Z")
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?\Z")
# The shared range grammar uses stable bounds; omitted numbers are zero.
RANGE = re.compile(r">=(\d{1,9})\.(\d{1,9})(?:\.(\d{1,9}))?(?: <(\d{1,9})(?:\.(\d{1,9}))?(?:\.(\d{1,9}))?)?\Z")
# An npm spec is a package name, optionally followed by one exact version. A tag, a range,
# `latest`, and every other form are rejected. Without a version the package follows the
# registry at install time; `pi update` moves it.
NPM = re.compile(r"(?:@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*(?:@(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?)?\Z")
SCHEMA_VERSION = 2
# `unverified` has no test in this repository yet; its `gaps` name what no test proves.
STATUSES = ("tested", "unverified")
PACKAGES = "packages"
MANIFEST = "config/manifest.json"
RESOURCE_KINDS = ("extensions", "skills", "prompts", "themes")
GAP_CODE = re.compile(r"[a-z][a-z0-9]*(?:_[a-z0-9]+)*\Z")
# Character bound of each name in the `hint` of a refusal.
HINT_MAX = 200


def npm_parts(spec):
    """`(name, version)` of an npm spec; `version` is `None` when the spec has no version."""
    cut = spec.rfind("@")
    if cut <= 0:  # no version, or a scoped name alone
        return spec, None
    return spec[:cut], spec[cut + 1:]


def npm_name(spec):
    return npm_parts(spec)[0]


def _tree_components():
    """The in-tree modules of the kit manifest, in manifest order.

    Component ID -> (package directory, resource kind, resource paths). A component is in the
    table when its source kind is `tree`. The package directory is the Pi package root. A skill
    component with more than one skill directory names more than one resource path. An unreadable
    manifest gives an empty table and its cause (the exception class and message): `manifest()`
    then fails with `reviewed_components` and the cause.
    """
    try:
        components = json.loads((ROOT / MANIFEST).read_text(encoding="utf-8"))["components"]
        found = {}
        for cid, component in components.items():
            source = component["source"]
            if not isinstance(source, dict) or source.get("kind") != "tree":
                continue
            resources = component["resources"]
            kind = next((key for key in RESOURCE_KINDS if resources[key]), RESOURCE_KINDS[0])
            items = tuple(resources[kind])
            if not all(isinstance(one, str) for one in (cid, source["path"], *items)):
                raise TypeError("a component ID, a source path or a resource path is not text")
            found[cid] = (source["path"], kind, items)
        return found, None
    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
        return {}, f"{type(exc).__name__}: {exc}"


# The kit manifest is the one source of the tree components and of their resource paths.
# `manifest()` checks each resource path against the tree. The cause is None when the kit
# manifest is readable; it is about the kit file, never about the checked input.
TREE_COMPONENTS, TREE_COMPONENTS_CAUSE = _tree_components()


def tree_items(item):
    """The resource paths of one `TREE_COMPONENTS` entry, in manifest order."""
    return [item] if isinstance(item, str) else list(item)


# Reviewed anchors are independent of editable manifest entries: the source kind and the package
# of each component, so an altered manifest cannot bless an unrelated upstream source. The version
# of an npm source lives in the manifest only, so a pin move edits one file.
REVIEWED_SOURCES = {
    "core": {"kind": "npm", "name": "@earendil-works/pi-coding-agent"},
    "model-routing": {"kind": "builtin"},
    # A tree component has no upstream pin: its anchor is the tree of this kit. The `openviking`
    # memory module is one of them: `packages/openviking-pi` is a vendored copy.
    **{cid: {"kind": "tree", "path": path} for cid, (path, _, _) in TREE_COMPONENTS.items()},
    "mcp": {"kind": "npm", "name": "pi-mcp-adapter"},
    "hermes": {"kind": "npm", "name": "pi-hermes-memory"},
    "wiki": {"kind": "npm", "name": "@zosmaai/pi-llm-wiki"},
    "questions": {"kind": "npm", "name": "@juicesharp/rpiv-ask-user-question"},
}


def reviewed_source(cid, value):
    """True when a checked source has the reviewed kind and package of `cid`, at any version."""
    anchor = REVIEWED_SOURCES[cid]
    if anchor["kind"] == "npm":
        return value["kind"] == "npm" and npm_name(value["spec"]) == anchor["name"]
    return value == anchor


class Invalid(ValueError):
    """Rule and field path only: input values never enter the message.

    `line` and `column` are the place of a JSON syntax error, counted from 1; else both are None.
    `hint` is the text of `link_hint` when a link in the path caused the refusal; else None.
    """

    def __init__(self, message, line=None, column=None, hint=None):
        super().__init__(message)
        self.line, self.column, self.hint = line, column, hint


def fail(rule, field, line=None, column=None, *, hint=None):
    raise Invalid(f"{rule}: {field}", line, column, hint)


def place(exc):
    """The `line` and `column` of a JSON syntax error as a mapping, else an empty one; never input text."""
    return {} if exc.line is None else {"line": exc.line, "column": exc.column}


def hint_text(value):
    """`value` for a hint: each control or non-printable character becomes `?`, at most HINT_MAX characters."""
    value = "".join(c if c.isprintable() else "?" for c in value)
    return value if len(value) <= HINT_MAX else value[:HINT_MAX - 3] + "..."


def link_hint(path, error=None):
    """Name the first linked directory of `path`, its link target and the resolved path; else None.

    A no-follow walk refuses every linked directory, also `/tmp`, `/var` and `/etc` on macOS.
    Call this after the refusal: it reads link names only, never file content. With `error`,
    only the ENOTDIR and ELOOP of a no-follow open can come from a link. An agent reads the
    hint, so each name passes `hint_text`. A dangling link or a link loop has no resolved path.
    """
    if error is not None and getattr(error, "errno", None) not in (errno.ENOTDIR, errno.ELOOP):
        return None
    path = os.fspath(path)
    current = "/" if path.startswith("/") else ""
    try:
        for part in path.split("/"):
            if not part:
                continue
            current = os.path.join(current, part) if current else part
            if stat.S_ISLNK(os.lstat(current).st_mode):
                hint = f"{hint_text(current)} is a link to {hint_text(os.readlink(current))}"
                # The realpath of a loop still holds the link; the one of a dangling link does not exist.
                if not os.path.exists(os.path.realpath(current)):
                    return hint
                return f"{hint}; give the resolved path {hint_text(os.path.realpath(path))}"
    except (OSError, ValueError):
        pass
    return None


def hint_field(exc):
    """The `hint` of a refusal as a mapping for a JSON diagnostic, else an empty one."""
    return {"hint": exc.hint} if getattr(exc, "hint", None) else {}


def parse_range(value, field, *, bounded=False):
    """Return `(lower, upper)` as number triples; `upper` is None without a `<` bound.

    `bounded` requires the `<` bound.
    """
    found = RANGE.fullmatch(value) if isinstance(value, str) else None
    if not found:
        fail("runtime_range", field)
    parts = found.groups()
    lower = tuple(int(part or 0) for part in parts[:3])
    upper = tuple(int(part or 0) for part in parts[3:]) if parts[3] else None
    if bounded and upper is None:
        fail("range_without_upper_bound", field)
    if upper is not None and upper <= lower:
        fail("runtime_range", field)
    return lower, upper


def in_range(version, bounds, prerelease=False):
    """Use stable numeric bounds; exclude prereleases of either boundary version."""
    lower, upper = bounds
    if prerelease and version == lower:
        return False
    return version >= lower and (upper is None or version < upper)


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
        # The parser message can include a fragment of the input; the place is two integers.
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


def source(value, at):
    fields(value, ("kind",), ("spec", "path"), at)
    kind = value["kind"]
    forms = {"npm": ("kind", "spec"), "builtin": ("kind",), "tree": ("kind", "path")}
    if not isinstance(kind, str) or kind not in forms or set(value) != set(forms[kind]):
        fail("source_form", at)
    if kind == "npm" and (not isinstance(value["spec"], str) or not NPM.fullmatch(value["spec"])):
        fail("exact_npm_pin", at + ".spec")
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
    # An absent package directory is a kit without that package; `optional_tree_absent` decides.
    if (target.exists() or target.is_symlink()) and not target.is_dir():
        fail("tree_path_missing", at)


def id_list(value, at):
    if not isinstance(value, list):
        fail("array", at)
    for item in value:
        identifier(item, at)
    if len(set(value)) != len(value):
        fail("duplicate_id", at)


def optional_tree_absent(cid):
    """True when the kit holds no resource path of the tree component `cid`: its folder is absent.

    A kit can leave out the folder of each tree component. Only an entirely absent folder
    bypasses the resource presence check of `manifest()`.
    """
    if cid not in TREE_COMPONENTS:
        return False
    path, _, items = TREE_COMPONENTS[cid]
    return all(not (ROOT / path / item).exists() and not (ROOT / path / item).is_symlink()
               for item in tree_items(items))


def manifest(data):
    fields(data, ("schemaVersion", "runtime", "components"), (), "manifest")
    if type(data["schemaVersion"]) is not int or data["schemaVersion"] != SCHEMA_VERSION:
        fail("schema_version", "manifest.schemaVersion")
    runtime = data["runtime"]
    fields(runtime, ("piVersion", "piAcceptedRange", "nodeRange", "pythonRange"), (), "manifest.runtime")
    if not isinstance(runtime["piVersion"], str) or not VERSION.fullmatch(runtime["piVersion"]):
        fail("exact_version", "manifest.runtime.piVersion")
    if runtime["nodeRange"] != ">=24.0.0 <25" or runtime["pythonRange"] != ">=3.11":
        fail("runtime_range", "manifest.runtime")
    components = data["components"]
    if not isinstance(components, dict) or "core" not in components:
        fail("core_required", "manifest.components")
    # The tested version is the version of the core spec. A missing or other core source fails below.
    core = components["core"].get("source") if isinstance(components["core"], dict) else None
    if (isinstance(core, dict) and isinstance(core.get("spec"), str)
            and runtime["piVersion"] != npm_parts(core["spec"])[1]):
        fail("core_runtime_pin", "manifest.runtime.piVersion")
    bounds = parse_range(runtime["piAcceptedRange"], "manifest.runtime.piAcceptedRange", bounded=True)
    tested = runtime["piVersion"].split("-", 1)
    if not in_range(tuple(int(part) for part in tested[0].split(".")), bounds, len(tested) > 1):
        fail("tested_outside_range", "manifest.runtime.piAcceptedRange")
    if set(components) != set(REVIEWED_SOURCES):
        fail("reviewed_components", "manifest.components" if TREE_COMPONENTS_CAUSE is None else
             f"manifest.components (kit manifest {MANIFEST} not read: {TREE_COMPONENTS_CAUSE})")
    for cid, component in components.items():
        identifier(cid, "manifest.components ID")
        at = "manifest.components.item"
        fields(component, ("source", "status", "requires", "owner", "license", "resources", "env"), ("gaps",), at)
        if not isinstance(component["env"], list):
            fail("array", at + ".env")
        for name in component["env"]:
            if not isinstance(name, str) or not ENV.fullmatch(name):
                fail("env_name", at + ".env")
        if len(set(component["env"])) != len(component["env"]):
            fail("duplicate_env", at + ".env")
        if not isinstance(component["status"], str) or component["status"] not in STATUSES:
            fail("status", at + ".status")
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
        if (component["status"] == "tested") == bool(gaps):
            fail("status_gaps", at + ".gaps")
        if cid in TREE_COMPONENTS and component["status"] == "tested":
            fail("status_gaps", at + ".status")
        source(component["source"], at + ".source")
        if not reviewed_source(cid, component["source"]):
            fail("reviewed_source", at + ".source")
        id_list(component["requires"], at + ".requires")
        if not isinstance(component["owner"], str) or not ID.fullmatch(component["owner"]):
            fail("owner", at + ".owner")
        text(component["license"], at + ".license")
        resources = component["resources"]
        fields(resources, RESOURCE_KINDS, (), at + ".resources")
        for key, items in resources.items():
            if not isinstance(items, list):
                fail("array", at + ".resources." + key)
            for item in items:
                relative(item, at + ".resources." + key)
            if len(set(items)) != len(items):
                fail("duplicate_resource", at + ".resources." + key)
        if component["source"]["kind"] == "tree":
            # The manifest names the resource paths; the tree of the kit holds each of them.
            paths = [item for items in resources.values() for item in items]
            if not paths or (not optional_tree_absent(cid) and
                             not all((ROOT / component["source"]["path"] / item).exists() for item in paths)):
                fail("tree_resource_missing", at + ".resources")
    if components["core"]["requires"]:
        fail("core_source", "manifest.components.core")
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


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("--manifest", type=Path, default=ROOT / MANIFEST)
    args = parser.parse_args()
    try:
        manifest(load(args.manifest))
    except Invalid as exc:
        parser.exit(2, str(exc) + "".join(f" {key}={value}" for key, value in place(exc).items()) + "\n")
    print("valid: structural contract of the manifest only; no package or runtime qualification")


if __name__ == "__main__":
    main()
