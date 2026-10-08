"""Pure, read-only checklist of the components of the kit manifest.

Inputs are the validated components of the manifest and, for the marks, an already-loaded
overlay. The module reads no file, environment, or host state, and it writes nothing. Each
diagnostic is a static `rule: field` string; an input value never enters it.
"""
import shlex
from pathlib import PurePosixPath

from scripts.memory_modules import MEMORY
from scripts.profile_plan import DECLARED_NPM, PEER_OVERRIDE_NPM, _package_source
from scripts.validate import RESOURCE_KINDS, SELECTABLE, fail, id_list, npm_name

# The one place of the recommended set. A test proves that each ID is in the manifest and that
# the set holds each ID that one of its members requires.
RECOMMENDED = ("core", "model-routing", "tenantext", "codex-accounts", "slopscore", "context-meter", "ops-footer",
               "copilot-usage", "anthropic-usage", "doctor", "resources", "coordinator-skills", "knowledge-skills",
               "slopscore-pr", "wiki", "hermes")
# The overlay validator refuses a selection without these IDs.
LOCKED = ("core",)
FORMATS = ("json", "text")
# Path segments that name a container of a package, not one extension.
GENERIC = ("extensions", "skills", "src")
# The memory module whose captures are writes to a server (`validate_memory`).
REMOTE_WRITES = ("openviking",)
# The component that needs the fixed input slot (`mcp_input_required` of the overlay validator).
INPUT_SLOTS = {"mcp": "inputs.mcpFile"}
# Gaps that `render_memory` adds for an npm memory module and that name a step or a build on the host.
MEMORY_PLAN_GAPS = {"hermes": ("peer_override_required", "native_addon_unverified"),
                    "wiki": ("peer_override_required",)}
# The setup lines of `prepare`, without the directory of one profile and with the kit-relative package path.
# `{source}` is the source string of the package in `settings.json`: the plan installs each declared npm source.
PACKAGE_STEP = "pi install {source}"
PEER_STEP = "node scripts/patch_extension_peers.mjs"
INSTALL_STEP = "npm --prefix {path} ci --ignore-scripts"
ANSWER = ("Answer `ok` to keep the marks, or name the numbers to switch on and the numbers to switch off. "
          "A locked component stays on.")
SCOPE = "Reads only the manifest and, with --overlay, the selection of that overlay. Writes nothing and enables nothing."


def _package(source):
    """The name of the package of one manifest source: the npm name, or the last directory of a tree path."""
    if source is None:
        return None
    if source["kind"] == "npm":
        return npm_name(source["spec"])
    return PurePosixPath(source["path"]).name if source["kind"] == "tree" else None


def names(cid, component):
    """`(extensions, skills)`: the names that a reader knows, in manifest order.

    A skill has the name of its directory. An extension has the name of its directory, or of its
    file when the file is not `index`. A path that names only a container of the package (a bare
    `index.ts`, `src/index.ts`, `extensions`) gives the name of the package.
    """
    resources = component["resources"]
    extensions = []
    for item in resources["extensions"]:
        path = PurePosixPath(item)
        name = path.parent.name if path.stem == "index" and path.suffix else path.stem if path.suffix else path.name
        extensions.append(name if name and name not in GENERIC else _package(component["source"]) or cid)
    return extensions, [PurePosixPath(item).name for item in resources["skills"]]


def prerequisites(cid, component):
    """Plain codes of what one component needs before `validate` accepts it or before a start.

    `overlay:<key>` is a key of the overlay. `env:<NAME>` is a variable name of the manifest key
    `env`. `gap:<code>` is a readiness gap that names a step or a tool of the host. `setup:<line>`
    is a setup line that the plan prints for the component, without the directory of the profile.
    """
    source = component["source"]
    kind = source["kind"] if source is not None else None
    npm_memory = cid in MEMORY and kind == "npm"
    found = []
    if cid in MEMORY:
        found.append("overlay:consent.memoryCapture")
        if cid in REMOTE_WRITES:
            found.append("overlay:consent.remoteMemoryWrites")
        found.append("overlay:memory." + cid)
    if cid in INPUT_SLOTS:
        found.append("overlay:" + INPUT_SLOTS[cid])
    found.extend("env:" + name for name in component["env"])
    found.extend("gap:" + gap["code"] for gap in component.get("gaps", []) if gap["code"].endswith("_required"))
    if npm_memory:
        found.extend("gap:" + code for code in MEMORY_PLAN_GAPS.get(cid, ()))
    if npm_memory or cid in INPUT_SLOTS or cid in DECLARED_NPM:
        found.append("setup:" + PACKAGE_STEP.format(source=shlex.quote(_package_source(source))))
    if npm_memory or cid in PEER_OVERRIDE_NPM:
        found.append("setup:" + PEER_STEP)
    if cid in MEMORY and kind == "tree":
        found.append("setup:" + INSTALL_STEP.format(path=source["path"]))
    return found


def overlay_enabled(data, components):
    """The `selection.enable` IDs of one loaded overlay. No other rule of the overlay is checked."""
    selection = data.get("selection") if type(data) is dict else None
    if type(selection) is not dict or "enable" not in selection:
        fail("required_fields", "overlay.selection")
    id_list(selection["enable"], "overlay.selection.enable")
    if any(cid not in components for cid in selection["enable"]):
        fail("undeclared_component", "overlay.selection")
    return selection["enable"]


def report(components, enabled=None):
    """The checklist as data: one entry for each component, in manifest order.

    `enabled` is the `selection.enable` list of an overlay. Without it the marks are the recommended set.
    """
    marked = set(RECOMMENDED if enabled is None else enabled) | set(LOCKED)
    rows = []
    for number, (cid, component) in enumerate(components.items(), 1):
        extensions, skills = names(cid, component)
        rows.append({"number": number, "id": cid,
                     "kind": component["source"]["kind"] if component["source"] is not None else None,
                     "status": component["status"], "extensions": extensions, "skills": skills,
                     "requires": list(component["requires"]), "prerequisites": prerequisites(cid, component),
                     "recommended": cid in RECOMMENDED, "marked": cid in marked, "locked": cid in LOCKED})
    return {"count": len(rows), "marks": "recommended" if enabled is None else "overlay", "components": rows,
            "scope": SCOPE}


def _note(codes):
    """A short note of one prerequisite list: the keys, names and gap codes, then the count of setup lines."""
    parts = [code.split(":", 1)[1] for code in codes if not code.startswith("setup:")]
    lines = sum(code.startswith("setup:") for code in codes)
    if lines:
        parts.append(f"{lines} setup line" + ("s" if lines > 1 else ""))
    return ", ".join(parts)


def text(checklist):
    """The checklist for a person: one line for each component, then one line that says how to answer.

    `core` is locked and each other component requires it, so a line names only the other required IDs.
    """
    width = len(str(checklist["count"]))
    lines = []
    for row in checklist["components"]:
        parts = [f"{row['number']:>{width}} [{'x' if row['marked'] else ' '}] {row['id']}"
                 + (" (locked)" if row["locked"] else "")]
        for label, items in (("extension", row["extensions"]), ("skill", row["skills"])):
            if items:
                parts.append(label + ("s" if len(items) > 1 else "") + ": " + ", ".join(items))
        parts.append(row["status"])
        needed = [cid for cid in row["requires"] if cid not in LOCKED]
        if needed:
            parts.append("requires: " + ", ".join(needed))
        if row["prerequisites"]:
            parts.append("needs: " + _note(row["prerequisites"]))
        lines.append(" | ".join(parts))
    return "\n".join([*lines, ANSWER]) + "\n"


def parse_select(value, components):
    """The chosen IDs of one `--select` value: IDs or checklist numbers, separated by commas."""
    order = list(components)
    chosen = []
    for item in value.split(","):
        item = item.strip()
        if item.isascii() and item.isdigit():
            # The number is the position in the manifest, from 1.
            if len(item) > 6 or not 1 <= int(item) <= len(order):
                fail("undeclared_component", "components.select")
            item = order[int(item) - 1]
        elif item not in components:
            fail("undeclared_component", "components.select")
        if item not in chosen:
            chosen.append(item)
    return chosen


def selection(components, chosen):
    """The `selection` object of an overlay for the chosen IDs, with each ID that one of them requires."""
    enabled, pending = [], [*LOCKED, *chosen]
    while pending:
        cid = pending.pop(0)
        if cid in enabled:
            continue
        if components[cid]["status"] not in SELECTABLE:
            fail("blocked_component", "components.select")
        enabled.append(cid)
        pending.extend(components[cid]["requires"])
    # The order of the Compose plan: `core`, then the other IDs by name.
    enable = [*LOCKED, *sorted(set(enabled) - set(LOCKED))]
    needs = {cid: prerequisites(cid, components[cid]) for cid in enable}
    return {"selection": {"enable": enable, "disable": sorted(set(components) - set(enable))},
            "added": sorted(set(enable) - set(LOCKED) - set(chosen)),
            "prerequisites": {cid: codes for cid, codes in needs.items() if codes},
            "scope": "Prints the selection only. Writes no file. The overlay also needs each `overlay:` key of the prerequisites."}
