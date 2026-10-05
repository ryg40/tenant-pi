"""Pure, redacted comparison of two explicitly selected Pi profile directories.

Inputs are the already-loaded JSON objects of the declared kit files of each side
(`None` for an absent file). The module reads no file, environment, or host state. It
shows change markers for private values and echoes only reviewed public values.
"""
import json
import re

from scripts.memory_modules import HERMES_CONFIG, MEMORY, MODULE_FIELDS
from scripts.profile_plan import prepare, source_pin
from scripts.validate import HEX, ID, OWNER_RESOURCES, REVIEWED_SOURCES, ROLE_NAMES, Invalid, fail, npm_name, npm_parts, unmanaged
from scripts.workflow_modules import LIFECYCLES, MCP_CONFIG, SERVER_NAME

FILES = ("settings.json", ".tenant-pi/choices.json", ".tenant-pi/state.json", HERMES_CONFIG, MCP_CONFIG)
REQUIRED_FILES = FILES[:3]  # The Hermes and adapter files exist only when their modules are enabled.
OPTIONAL_FILES = FILES[3:]
CHOICES_KEYS = ("overlay", "manifest", "registry", "registryDigest", "requiredRoles",
                "credentialNames", "routes", "roleStatus", "pendingPackages", "memory", "workflow", "mcpDefinitions")
THINKING = ("off", "minimal", "low", "medium", "high", "xhigh", "max")
# Every value policy names a closed public form. Anything else is a marker or unsupported.
ENUMS = {
    "trust": ("ask", "always", "never"), "thinking": THINKING, "route": ("native", "gateway"),
    "auth": ("env", "login"), "status": ("tested", "blocked"), "state": ("complete", "incomplete"),
    "roleStatus": ("selected", "unset", "required_missing"), "const": ("listed", "disabled"),
    "transport": ("direct", "subprocess"), "overflow": ("auto-consolidate", "reject", "fifo-evict"),
    "lifecycle": LIFECYCLES, "discovery": ("off", "prompt", "on"), "projectServers": ("ask", "allow"),
    "const_transport": ("stdio", "http"),
}
BUILTIN_ENTRY = re.compile(r"[+!-]?builtin:[a-z][a-z0-9.-]*\Z")
SAFE_NAME = re.compile(r"[A-Za-z0-9_.:@-]{1,64}\Z")
# Closed public sets. They repeat reviewed kit data on purpose: a recorded manifest or
# provenance value is echoed only when it names something the kit itself declares.
RANGES = (">=22.22.0 <23", ">=3.11")
PLAIN_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")  # no free-text prerelease tag
DECLARED_ENV = frozenset(("TENANTEXT_LITELLM_BASE_URL", "TENANTEXT_LITELLM_API_KEY"))
REVIEWED_NPM = frozenset(npm_name(s["spec"]) for s in REVIEWED_SOURCES.values() if s and s["kind"] == "npm")
REVIEWED_GIT = {(s["url"], s["subdir"]) for s in REVIEWED_SOURCES.values() if s and s["kind"] == "git"}
REVIEWED_TREE = frozenset(s["path"] for s in REVIEWED_SOURCES.values() if s and s["kind"] == "tree")
# The overlay `memory` fields: a switch and a closed name by value, a path as a marker.
# `paths` is a positional list of private entries: one marker per index.
MEMORY_POLICIES = {"backgroundReview": "bool", "reviewTransport": "transport", "childExtensionPaths": "paths",
                   "ambientPersonalVault": "bool", "backgroundTasks": "bool", "wikiHome": "marker"}
MISSING = object()
# Provenance fields that differ between any two generations: listed under `markers`, never under `changes`.
MARKERS = frozenset((".tenant-pi/state.json", "/provenance/" + key) for key in ("generatedAt", "kitCommit"))


def _pin_public(value):
    """A pin is echoed only for a reviewed package name or repository; the version may differ."""
    if value is None or value == "builtin":
        return True
    if type(value) is not str:
        return False
    if value.startswith("npm:"):
        name, version = npm_parts(value[4:])
        return name in REVIEWED_NPM and (version is None or bool(PLAIN_VERSION.fullmatch(version)))
    if value.startswith("git:"):
        body, _, subdir = value[4:].partition("#")
        location, at, commit = body.rpartition("@")
        return bool(at and HEX.fullmatch(commit)) and (location, subdir) in REVIEWED_GIT
    if value.startswith("tree:"):
        return value[5:] in REVIEWED_TREE
    return False


def _public(value, policy):
    """Whether a value may be echoed under its policy."""
    if policy == "marker":
        return False
    if policy == "bool":
        return type(value) is bool
    if policy == "int":
        return type(value) is int and 0 <= value < 10 ** 6
    if policy in ENUMS:
        return type(value) is str and value in ENUMS[policy]
    if policy == "version":
        return type(value) is str and bool(PLAIN_VERSION.fullmatch(value))
    if policy == "range":
        return type(value) is str and value in RANGES
    if policy == "pin":
        return _pin_public(value)
    if policy == "ids":
        return type(value) is list and all(type(v) is str and ID.fullmatch(v) for v in value)
    if policy == "roles":
        return type(value) is list and all(type(v) is str and v in ROLE_NAMES for v in value)
    if policy == "envNames":
        return type(value) is list and all(type(v) is str and v in DECLARED_ENV for v in value)
    if policy == "outputs":
        return type(value) is list and all(type(v) is str and v in FILES for v in value)
    if policy == "builtins":
        return type(value) is list and all(type(v) is str and BUILTIN_ENTRY.fullmatch(v) for v in value)
    fail("value_policy", policy)


class _Side:
    def __init__(self, name):
        self.name = name
        self.fields = {}
        self.unsupported = []
        self.accepted = {}  # Pointer -> reason, from a valid `overlay.unmanaged` record of this side.

    def put(self, file, pointer, value, policy):
        self.fields[(file, pointer)] = (value, policy)

    def skip(self, file, pointer, status="unsupported_field"):
        self.unsupported.append({"file": file, "field": pointer, "side": self.name, "status": status})

    def segment(self, file, pointer, key):
        """Return a pointer segment for a key, or `None` after reporting an unsafe name."""
        if type(key) is str and SAFE_NAME.fullmatch(key):
            return pointer + "/" + key
        self.skip(file, pointer + "/<redacted>", "unsupported_field_name")
        return None

    def object(self, file, pointer, value):
        if type(value) is dict:
            return value
        self.skip(file, pointer, "missing_section" if value is MISSING else "unsupported_shape")
        return None

    def known(self, file, pointer, value, allowed):
        """Report unknown object keys without descending into them."""
        for key in sorted(value, key=str):
            if key not in allowed and (at := self.segment(file, pointer, key)) is not None:
                self.skip(file, at)

    def choice(self, file, pointer, value):
        """Provider/model choice fields: identity markers, thinking and route by enum."""
        if (item := self.object(file, pointer, value)) is None:
            return
        for key, policy in (("provider", "marker"), ("model", "marker"), ("thinking", "thinking"), ("route", "route")):
            if key in item:
                self.put(file, pointer + "/" + key, item[key], policy)
        self.known(file, pointer, item, ("provider", "model", "thinking", "route"))

    def id_map(self, file, pointer, value, policy):
        """Object keyed by component or role identifiers."""
        if (item := self.object(file, pointer, value)) is None:
            return
        for key in sorted(item, key=str):
            if type(key) is str and ID.fullmatch(key):
                self.put(file, pointer + "/" + key, item[key], policy)
            else:
                self.skip(file, pointer + "/<redacted>", "unsupported_field_name")

    def path_list(self, file, pointer, value):
        """List of private path entries: one marker per index, never a value."""
        if type(value) is not list or not all(type(item) is str for item in value):
            self.skip(file, pointer, "unsupported_shape")
            return
        for index, item in enumerate(value):
            self.put(file, pointer + "/" + str(index), item, "marker")

    def id_set(self, file, pointer, value):
        """Identifier list compared as presence, so entries appear as added or removed."""
        if type(value) is not list:
            self.skip(file, pointer, "missing_section" if value is MISSING else "unsupported_shape")
            return
        for item in value:
            if type(item) is str and ID.fullmatch(item):
                self.put(file, pointer + "/" + item, "listed", "const")
            else:
                self.skip(file, pointer + "/<redacted>", "unsupported_field_name")


def _settings(side, data):
    file = "settings.json"
    if type(data) is not dict:
        fail("object", side.name + ".settings.json")
    policies = {"defaultProjectTrust": "trust", "enableInstallTelemetry": "bool", "enableAnalytics": "bool",
                "defaultProvider": "marker", "defaultModel": "marker", "defaultThinkingLevel": "thinking",
                "enabledModels": "marker", "modelThinkingLevels": "marker", "extensions": "builtins"}
    for key, policy in policies.items():
        if key in data:
            side.put(file, "/" + key, data[key], policy)
    if "packages" in data:
        packages = data["packages"]
        if type(packages) is not list or not all(type(p) in (dict, str) for p in packages):
            side.skip(file, "/packages", "unsupported_shape")
        else:
            for index, package in enumerate(packages):
                pointer = "/packages/" + str(index)
                if type(package) is str:  # Pi's plain form: the source alone, no resource filter.
                    side.put(file, pointer + "/source", package, "pin")
                    continue
                side.put(file, pointer + "/source", package.get("source", MISSING), "pin")
                side.put(file, pointer + "/resources", {k: v for k, v in package.items() if k != "source"}, "marker")
    for kind in OWNER_RESOURCES:
        if kind in data:
            side.path_list(file, "/" + kind, data[kind])
    if "llm-wiki" in data and (wiki := side.object(file, "/llm-wiki", data["llm-wiki"])) is not None:
        for key, policy in (("ambientPersonalVault", "bool"), ("trajectories", "bool"), ("taskThinkingLevel", "thinking")):
            if key in wiki:
                side.put(file, "/llm-wiki/" + key, wiki[key], policy)
        if "taskModel" in wiki:
            side.put(file, "/llm-wiki/taskModel", wiki["taskModel"], "marker")
        side.known(file, "/llm-wiki", wiki, ("ambientPersonalVault", "trajectories", "taskThinkingLevel", "taskModel"))
    side.known(file, "", data, (*policies, "packages", *OWNER_RESOURCES, "llm-wiki"))


def _hermes(side, data):
    """Hermes config file: switches and enumerations by value, model and paths as markers."""
    file = HERMES_CONFIG
    if (config := side.object(file, "", data)) is None:
        return
    policies = {"reviewEnabled": "bool", "correctionDetection": "bool", "flushOnCompact": "bool",
                "flushOnShutdown": "bool", "autoConsolidate": "bool", "memoryOverflowStrategy": "overflow",
                "reviewTransport": "transport", "llmThinkingOverride": "thinking",
                "llmModelOverride": "marker", "childExtensionPaths": "marker"}
    for key, policy in policies.items():
        if key in config:
            side.put(file, "/" + key, config[key], policy)
    side.known(file, "", config, tuple(policies))


def _mcp(side, data):
    """Adapter config file: server identities by name, switches by value, definitions as markers."""
    file = MCP_CONFIG
    if (config := side.object(file, "", data)) is None:
        return
    if (servers := side.object(file, "/mcpServers", config.get("mcpServers", MISSING))) is not None:
        for name in sorted(servers, key=str):
            if type(name) is not str or not SERVER_NAME.fullmatch(name):
                side.skip(file, "/mcpServers/<redacted>", "unsupported_field_name")
                continue
            at = "/mcpServers/" + name
            if (entry := side.object(file, at, servers[name])) is None:
                continue
            side.put(file, at + "/disabled", entry.get("disabled", MISSING), "bool")
            side.put(file, at + "/lifecycle", entry.get("lifecycle", MISSING), "lifecycle")
            side.put(file, at + "/transport", "stdio" if "command" in entry else "http" if "url" in entry else MISSING, "const_transport")
            side.put(file, at + "/definition", {k: v for k, v in entry.items() if k not in ("disabled", "lifecycle")}, "marker")
    if (settings := side.object(file, "/settings", config.get("settings", MISSING))) is not None:
        for key, policy in (("hostConfigDiscovery", "discovery"), ("projectServers", "projectServers"), ("allowInstall", "bool")):
            side.put(file, "/settings/" + key, settings.get(key, MISSING), policy)
        side.known(file, "/settings", settings, ("hostConfigDiscovery", "projectServers", "allowInstall"))
    side.known(file, "", config, ("mcpServers", "settings"))


def _overlay(side, file, data):
    pointer = "/overlay"
    if (overlay := side.object(file, pointer, data)) is None:
        return
    side.put(file, pointer + "/schemaVersion", overlay.get("schemaVersion", MISSING), "int")
    if (target := side.object(file, pointer + "/target", overlay.get("target", MISSING))) is not None:
        side.put(file, pointer + "/target/agentDir", target.get("agentDir", MISSING), "marker")
        side.known(file, pointer + "/target", target, ("agentDir",))
    if (selection := side.object(file, pointer + "/selection", overlay.get("selection", MISSING))) is not None:
        for key in ("enable", "disable"):
            side.id_set(file, pointer + "/selection/" + key, selection.get(key, MISSING))
        side.known(file, pointer + "/selection", selection, ("enable", "disable"))
    for key in ("paths", "endpoints", "env"):
        side.id_map(file, pointer + "/" + key, overlay.get(key, MISSING), "marker")
    if (roles := side.object(file, pointer + "/roles", overlay.get("roles", MISSING))) is not None:
        for name in ROLE_NAMES:
            if name in roles:
                if roles[name] is None:
                    side.put(file, pointer + "/roles/" + name, "disabled", "const")
                else:
                    side.choice(file, pointer + "/roles/" + name, roles[name])
        side.known(file, pointer + "/roles", roles, ROLE_NAMES)
    if (inputs := side.object(file, pointer + "/inputs", overlay.get("inputs", MISSING))) is not None:
        for key in ("modelsFile", "mcpFile"):
            side.put(file, pointer + "/inputs/" + key, inputs.get(key, MISSING), "marker")
        side.known(file, pointer + "/inputs", inputs, ("modelsFile", "mcpFile"))
    if (consent := side.object(file, pointer + "/consent", overlay.get("consent", MISSING))) is not None:
        for key in ("memoryCapture", "remoteMemoryWrites", "telemetry"):
            side.put(file, pointer + "/consent/" + key, consent.get(key, MISSING), "bool")
        side.known(file, pointer + "/consent", consent, ("memoryCapture", "remoteMemoryWrites", "telemetry"))
    if "ownerPackages" in overlay:
        owner = overlay["ownerPackages"]
        if type(owner) is not list or not all(type(p) in (dict, str) for p in owner):
            side.skip(file, pointer + "/ownerPackages", "unsupported_shape")
        else:
            for index, package in enumerate(owner):
                # A local path is private: the entry is a marker, with or without a filter.
                side.put(file, pointer + "/ownerPackages/" + str(index), package, "marker")
    if "unmanaged" in overlay:
        items = overlay["unmanaged"]
        try:
            # The record may be hand-edited: a reason is echoed only after the overlay rules pass again.
            unmanaged(items)
        except Invalid:
            side.skip(file, pointer + "/unmanaged", "unsupported_shape")
        else:
            for index, item in enumerate(items):
                side.put(file, pointer + "/unmanaged/" + str(index), item, "marker")
                side.accepted[item["key"]] = item["reason"]
    if "ownerResources" in overlay and (owned := side.object(file, pointer + "/ownerResources", overlay["ownerResources"])) is not None:
        for kind in OWNER_RESOURCES:
            if kind in owned:
                # A local directory path is private: each entry is a marker.
                side.path_list(file, pointer + "/ownerResources/" + kind, owned[kind])
        side.known(file, pointer + "/ownerResources", owned, OWNER_RESOURCES)
    if "memory" in overlay and (block := side.object(file, pointer + "/memory", overlay["memory"])) is not None:
        side.put(file, pointer + "/memory/schemaVersion", block.get("schemaVersion", MISSING), "int")
        for cid in MEMORY:
            at = pointer + "/memory/" + cid
            if cid not in block:
                continue
            names = (*MODULE_FIELDS[cid][0], *MODULE_FIELDS[cid][1])
            if block[cid] is None:
                side.put(file, at, "disabled", "const")
            elif not names:
                side.skip(file, at, "unsupported_shape")  # A blocked module accepts `null` only.
            elif (choice := side.object(file, at, block[cid])) is not None:
                for key in names:
                    if key not in choice:
                        continue
                    if MEMORY_POLICIES[key] == "paths":
                        side.path_list(file, at + "/" + key, choice[key])
                    else:
                        side.put(file, at + "/" + key, choice[key], MEMORY_POLICIES[key])
                side.known(file, at, choice, names)
        side.known(file, pointer + "/memory", block, ("schemaVersion", *MEMORY))
    if "modelRoutes" in overlay:
        routes = side.object(file, pointer + "/modelRoutes", overlay["modelRoutes"])
        if routes is not None:
            side.put(file, pointer + "/modelRoutes/schemaVersion", routes.get("schemaVersion", MISSING), "int")
            cycle = routes.get("cycle", MISSING)
            if type(cycle) is list:
                for index, item in enumerate(cycle):
                    side.choice(file, pointer + "/modelRoutes/cycle/" + str(index), item)
            else:
                side.skip(file, pointer + "/modelRoutes/cycle", "missing_section" if cycle is MISSING else "unsupported_shape")
            gateway = routes.get("gateway", MISSING)
            if gateway is None:
                side.put(file, pointer + "/modelRoutes/gateway", "disabled", "const")
            elif (item := side.object(file, pointer + "/modelRoutes/gateway", gateway)) is not None:
                side.put(file, pointer + "/modelRoutes/gateway/auth", item.get("auth", MISSING), "auth")
                side.known(file, pointer + "/modelRoutes/gateway", item, ("auth",))
            side.known(file, pointer + "/modelRoutes", routes, ("schemaVersion", "cycle", "gateway"))
    side.known(file, pointer, overlay, ("schemaVersion", "target", "selection", "paths", "roles",
                                        "endpoints", "env", "inputs", "consent", "modelRoutes", "ownerPackages", "unmanaged", "ownerResources",
                                        "memory"))


def _manifest(side, file, data):
    pointer = "/manifest"
    if (manifest := side.object(file, pointer, data)) is None:
        return
    side.put(file, pointer + "/schemaVersion", manifest.get("schemaVersion", MISSING), "int")
    if (runtime := side.object(file, pointer + "/runtime", manifest.get("runtime", MISSING))) is not None:
        side.put(file, pointer + "/runtime/piVersion", runtime.get("piVersion", MISSING), "version")
        for key in ("nodeRange", "pythonRange"):
            side.put(file, pointer + "/runtime/" + key, runtime.get(key, MISSING), "range")
        side.known(file, pointer + "/runtime", runtime, ("piVersion", "nodeRange", "pythonRange"))
    if (components := side.object(file, pointer + "/components", manifest.get("components", MISSING))) is not None:
        for cid in sorted(components, key=str):
            if type(cid) is not str or not ID.fullmatch(cid):
                side.skip(file, pointer + "/components/<redacted>", "unsupported_field_name")
                continue
            at = pointer + "/components/" + cid
            if (component := side.object(file, at, components[cid])) is None:
                continue
            side.put(file, at + "/source", source_pin(component.get("source")) if "source" in component else MISSING, "pin")
            side.put(file, at + "/status", component.get("status", MISSING), "status")
            side.put(file, at + "/metadata", {k: v for k, v in component.items() if k not in ("source", "status")}, "marker")
    side.known(file, pointer, manifest, ("schemaVersion", "runtime", "components"))


def _choices(side, data):
    file = ".tenant-pi/choices.json"
    if (choices := side.object(file, "", data)) is None:
        return
    _overlay(side, file, choices.get("overlay", MISSING))
    _manifest(side, file, choices.get("manifest", MISSING))
    side.put(file, "/registry", choices.get("registry", MISSING), "marker")
    side.put(file, "/registryDigest", choices.get("registryDigest", MISSING), "marker")
    side.put(file, "/requiredRoles", choices.get("requiredRoles", MISSING), "roles")
    side.put(file, "/credentialNames", choices.get("credentialNames", MISSING), "envNames")
    side.put(file, "/routes", choices.get("routes", MISSING), "marker")
    side.put(file, "/memory", choices.get("memory", MISSING), "marker")
    side.put(file, "/workflow", choices.get("workflow", MISSING), "marker")
    side.put(file, "/mcpDefinitions", choices.get("mcpDefinitions", MISSING), "marker")
    side.id_map(file, "/roleStatus", choices.get("roleStatus", MISSING), "roleStatus")
    pending = choices.get("pendingPackages", MISSING)
    if type(pending) is list and all(type(p) is dict for p in pending):
        for package in pending:
            cid = package.get("component")
            if type(cid) is str and ID.fullmatch(cid):
                side.put(file, "/pendingPackages/" + cid, package.get("source", MISSING), "pin")
            else:
                side.skip(file, "/pendingPackages/<redacted>", "unsupported_field_name")
    else:
        side.skip(file, "/pendingPackages", "missing_section" if pending is MISSING else "unsupported_shape")
    side.known(file, "", choices, CHOICES_KEYS)


def _state(side, data):
    file = ".tenant-pi/state.json"
    if (state := side.object(file, "", data)) is None:
        return
    side.put(file, "/status", state.get("status", MISSING), "state")
    if "provenance" in state and (record := side.object(file, "/provenance", state["provenance"])) is not None:
        side.put(file, "/provenance/kitSchemaVersion", record.get("kitSchemaVersion", MISSING), "int")
        side.put(file, "/provenance/piVersion", record.get("piVersion", MISSING), "version")
        side.put(file, "/provenance/nodeRange", record.get("nodeRange", MISSING), "range")
        side.put(file, "/provenance/enabled", record.get("enabled", MISSING), "ids")
        side.id_map(file, "/provenance/pins", record.get("pins", MISSING), "pin")
        side.put(file, "/provenance/outputs", record.get("outputs", MISSING), "outputs")
        for key in ("generatedAt", "kitCommit"):
            side.put(file, "/provenance/" + key, record.get(key, MISSING), "marker")
        side.known(file, "/provenance", record, ("kitSchemaVersion", "piVersion", "nodeRange", "enabled", "pins", "outputs",
                                                 "generatedAt", "kitCommit"))
    side.known(file, "", state, ("schemaVersion", "status", "provenance"))


def _schema_gate(name, files):
    """Stop on any version other than 1 before interpreting private content."""
    state = files[".tenant-pi/state.json"]
    if state is not None and (type(state) is not dict or type(state.get("schemaVersion")) is not int or state["schemaVersion"] != 1):
        fail("unsupported_schema_version", name + ".state.schemaVersion")
    choices = files[".tenant-pi/choices.json"]
    if choices is None:
        return
    if type(choices) is not dict:
        fail("object", name + ".choices")
    for key in ("overlay", "manifest"):
        section = choices.get(key)
        if type(section) is not dict or type(section.get("schemaVersion")) is not int or section["schemaVersion"] != 1:
            fail("unsupported_schema_version", name + ".choices." + key + ".schemaVersion")


def _drift(files):
    """Owner edits: declared settings fields that differ from what the recorded choices produce."""
    choices = files[".tenant-pi/choices.json"]
    try:
        names = choices["credentialNames"]
        expected = prepare(choices["manifest"], choices["overlay"], registry=choices["registry"],
                           required_roles=choices["requiredRoles"],
                           credential_names=frozenset(names) if type(names) is list else names,
                           mcp_definitions=choices["mcpDefinitions"])
    except Invalid as exc:
        return {"status": "not_computable", "rule": str(exc)}
    except (KeyError, TypeError, ValueError, RecursionError):
        return {"status": "not_computable", "rule": "metadata_shape: choices"}
    settings = files["settings.json"]
    rendered = expected["files"]["settings.json"]["content"]
    edited = sorted(key for key in set(settings) | set(rendered)
                    if type(key) is str and SAFE_NAME.fullmatch(key) and _dump(settings.get(key, MISSING)) != _dump(rendered.get(key, MISSING)))
    unsafe = any(type(key) is not str or not SAFE_NAME.fullmatch(key) for key in settings)
    edited_fields = ["/" + key for key in edited]
    for name in OPTIONAL_FILES:
        actual = files.get(name)
        rendered_file = expected["files"].get(name, {}).get("content")
        if actual is None and rendered_file is None:
            continue
        if type(actual) is not dict or rendered_file is None:
            edited_fields.append(name + ":" + ("/<missing>" if actual is None else "/<unexpected>" if rendered_file is None else "/<redacted>"))
        else:
            edited_fields.extend(name + ":/" + key for key in sorted(set(actual) | set(rendered_file))
                                 if type(key) is str and SAFE_NAME.fullmatch(key) and _dump(actual.get(key, MISSING)) != _dump(rendered_file.get(key, MISSING)))
            unsafe = unsafe or any(type(key) is not str or not SAFE_NAME.fullmatch(key) for key in actual)
    edited = edited_fields
    metadata = "changed" if _dump(expected["files"][".tenant-pi/choices.json"]["content"]) != _dump(choices) else "unchanged"
    status = "owner_edits" if edited or unsafe else "none"
    return {"status": status, "fields": edited + (["/<redacted>"] if unsafe else []),
            "metadata": metadata}


def _dump(value):
    if value is MISSING:
        return None
    try:
        return json.dumps(value, sort_keys=True, ensure_ascii=True, allow_nan=False)
    except (TypeError, ValueError, RecursionError):
        return "\x00unserializable"


def describe(name, files):
    """Flatten one side into policy-tagged fields plus a public side summary."""
    if type(files) is not dict or not set(REQUIRED_FILES) <= set(files) <= set(FILES):
        fail("files", name)
    files = {**dict.fromkeys(FILES), **files}
    if files["settings.json"] is None:
        fail("settings_missing", name)
    _schema_gate(name, files)
    side = _Side(name)
    _settings(side, files["settings.json"])
    choices, state = files[".tenant-pi/choices.json"], files[".tenant-pi/state.json"]
    if choices is not None:
        _choices(side, choices)
    if state is not None:
        _state(side, state)
    if files[HERMES_CONFIG] is not None:
        _hermes(side, files[HERMES_CONFIG])
    if files[MCP_CONFIG] is not None:
        _mcp(side, files[MCP_CONFIG])
    if choices is None and state is None:
        kind = "settings_only"
    elif choices is None or state is None:
        kind = "incomplete_metadata"
    else:
        kind = "candidate"
    status = state.get("status") if type(state) is dict else None
    summary = {"kind": kind, "state": status if _public(status, "state") else None,
               "drift": _drift(files) if kind == "candidate" else None}
    return side, summary


def _display(value, policy):
    if value is MISSING:
        return None
    return {"value": value} if _public(value, policy) else {"status": "unsupported_value"}


def compare(left_files, right_files):
    """Deterministic redacted report of two sides. Never echoes private or unsupported values."""
    left, left_summary = describe("left", left_files)
    right, right_summary = describe("right", right_files)
    changes, unchanged, accepted, markers = [], [], [], []
    # An accepted pointer is an exact field path of `settings.json`. The right side's reason wins.
    reasons = {("settings.json", pointer): reason for pointer, reason in {**left.accepted, **right.accepted}.items()}
    for key in sorted(set(left.fields) | set(right.fields)):
        file, pointer = key
        lv, lp = left.fields.get(key, (MISSING, None))
        rv, rp = right.fields.get(key, (MISSING, None))
        policy = lp or rp
        if lv is MISSING and rv is MISSING:
            continue
        if lv is MISSING:
            change = "added"
        elif rv is MISSING:
            change = "removed"
        elif _dump(lv) == _dump(rv) and lp == rp:
            unchanged.append({"file": file, "field": pointer})
            continue
        else:
            change = "changed"
        if key in MARKERS:
            markers.append({"file": file, "field": pointer, "change": change})
            continue
        if key in reasons:
            # No value: an accepted difference is a marker, also for a field with a public form.
            accepted.append({"file": file, "field": pointer, "change": change, "reason": reasons[key]})
            continue
        entry = {"file": file, "field": pointer, "change": change}
        if policy != "marker":
            if lv is not MISSING:
                entry["left"] = _display(lv, lp)
            if rv is not MISSING:
                entry["right"] = _display(rv, rp)
        changes.append(entry)
    unsupported = []
    for item in sorted(left.unsupported + right.unsupported, key=lambda u: (u["file"], u["field"], u["side"], u["status"])):
        if (item["file"], item["field"]) in reasons:
            accepted.append({**item, "reason": reasons[(item["file"], item["field"])]})
        else:
            unsupported.append(item)
    accepted.sort(key=lambda a: (a["file"], a["field"], a.get("change", ""), a.get("side", ""), a.get("status", "")))
    return {
        "scope": {"filesRead": list(FILES),
                  "note": "Declared kit files only. Private values show as markers; auth, sessions, memory, queues, and caches are never read."},
        "left": left_summary, "right": right_summary,
        "changes": changes, "unchanged": unchanged, "unsupported": unsupported, "accepted": accepted, "markers": markers,
        "summary": {"added": sum(c["change"] == "added" for c in changes),
                    "removed": sum(c["change"] == "removed" for c in changes),
                    "changed": sum(c["change"] == "changed" for c in changes),
                    "unchanged": len(unchanged), "unsupported": len(unsupported), "accepted": len(accepted),
                    "markers": len(markers)},
        "manualSwitch": "Switching profiles is a manual PI_CODING_AGENT_DIR launch choice. The kit moves no auth, session, memory, queue, or keychain data and guarantees no rollback.",
    }
