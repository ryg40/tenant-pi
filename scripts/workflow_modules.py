"""Pure workflow-module contract: MCP adapter definitions and the Promptr readiness matrix.

No file, environment, subprocess, or network access. Every diagnostic is a static
`rule: field` string; definition values never enter it. The facts below name the
reviewed sources: `pi-mcp-adapter` 3.2.0, the version reviewed, declared without a version (`config.ts`, `types.ts`, `init.ts`, `utils.ts`),
Pi 0.99.1 (`dist/extensions/mcp/config.js`, `dist/core/package-manager.js`), and the in-tree
Promptr package `packages/promptr`.
"""
import copy
import re
from ipaddress import ip_address
from urllib.parse import unquote, urlsplit

from scripts.validate import ENV, REF, absolute, fail, fields, text

WORKFLOW = ("promptr", "mcp")
MCP_CONFIG = "mcp-adapter.json"  # `<agent dir>/mcp-adapter.json`, the adapter's own file.
MCP_PACKAGE = "pi-mcp-adapter"
# `PI_MCP_CONFIG_MODE=exclusive` (adapter `config.ts` isExclusiveConfigMode): only the agent-dir
# file loads; shared, project, ancestor, host-discovered, package, and plugin sources are skipped.
MCP_MODE_NAME = "PI_MCP_CONFIG_MODE"
MCP_MODE_VALUE = "exclusive"
# Pi 0.99.1 `package-manager.js`: a `-builtin:<name>` entry in the user `extensions` setting
# disables that built-in unless a trusted project setting re-enables it.
BUILTIN_MCP_OFF = "-builtin:mcp"
SERVER_NAME = re.compile(r"[A-Za-z0-9_-]{1,64}\Z")
HEADER_NAME = re.compile(r"[A-Za-z0-9-]{1,64}\Z")
TOOL_NAME = re.compile(r"[A-Za-z0-9_.-]{1,128}\Z")
URL_FORM = re.compile(r"(https?)://[A-Za-z0-9.-]+(?::[0-9]{1,5})?(?:/[A-Za-z0-9._~/-]*)?\Z")
# Adapter `types.ts`: `lifecycle` is the only connection switch; `init.ts` connects only
# `eager` and `keep-alive` servers at session start.
LIFECYCLES = ("lazy", "lazy-keep-alive", "keep-alive", "eager")
STARTUP_LIFECYCLES = ("keep-alive", "eager")
TOOL_PREFIXES = ("server", "none", "short", "mcp")
HTTP_TRANSPORTS = ("streamable-http", "sse")
COMMON = ("disabled", "lifecycle", "idleTimeout", "requestTimeoutMs", "directTools", "toolPrefix",
          "includeTools", "excludeTools", "exposeResources")
STDIO = ("command", "args", "env", "cwd", "inheritEnv")
HTTP = ("url", "headers", "httpTransport", "caFile")
# Adapter fields that carry or fetch a credential; the kit has no form for them.
CREDENTIAL_FIELDS = frozenset(("auth", "bearerToken", "bearerTokenEnv", "bearerTokenStore", "oauth",
                               "requestHeadersCommand", "literalEnv"))
# Pi 0.99.1 native `mcp.json` fields the adapter ignores; the kit emits one MCP path only.
NATIVE_FIELDS = frozenset(("type", "enabled", "timeout", "exposure", "toolExposure"))
# Top-level adapter keys that pull definitions from other files or tools.
AMBIENT_FIELDS = frozenset(("imports", "claudePlugins", "settings", "mcp-servers", "autoEnableCodemode"))
UNSUPPORTED_TRANSPORT = frozenset(("socket",))
CREDENTIAL_ARG = re.compile(r"(?i)token|secret|passw|api[-_]?key|bearer|authorization|credential|cookie")
# Written into the generated file; honoured because the exclusive source has kind `user`.
ADAPTER_SETTINGS = {"hostConfigDiscovery": "off", "projectServers": "ask", "allowInstall": False}
# Readiness matrix of the in-tree Promptr package; each entry is a fact of `packages/promptr`.
# `met`: observed with Pi 1.0.2, not the kit pin 1.0.3. `open`: a named gap of the component.
PROMPTR_PREREQUISITES = (
    {"code": "local_package_load", "subject": "promptr", "status": "met",
     "fact": "Pi 1.0.2 loads the built packages/promptr as a local path package from a generated profile; its 16 commands register."},
    {"code": "pi_line_build_and_tests", "subject": "promptr", "status": "met",
     "fact": "The package pins pi-tui and pi-coding-agent 1.0.2; the build, its tests and its two smoke scripts pass on that line. The kit pins Pi 1.0.3; no build or test of the package ran on that line."},
    {"code": "build_step_required", "subject": "promptr", "status": "open",
     "fact": "packages/promptr/index.ts re-exports dist/src/extension/index.mjs; dist/ is ignored and absent in the tree, so `npm ci` and `npm run build` must run first."},
    {"code": "host_module_dependency", "subject": "@earendil-works/pi-tui@1.0.2", "status": "open",
     "fact": "packages/promptr/package.json lists the host module under dependencies because the companion process needs it; Pi 1.0.2 prints one warning at each start. For the built files Pi loads a second copy of pi-tui from packages/promptr/node_modules. The kit pins Pi 1.0.3 with pi-tui ^1.0.3, so the two copies differ: pi-tui 1.0.3 changed the default keys of Home and End. The effect on key handling is not verified."},
    {"code": "private_renderer_adapters", "subject": "promptr", "status": "open",
     "fact": "The sidebar uses private Pi renderer adapters; a start on Pi 1.0.2 shows the sidebar, and no session with a model ran."},
    {"code": "automatic_dispatch_path_unverified", "subject": "promptr", "status": "open",
     "fact": "packages/promptr/src/extension/index.mts calls requestHandoff with automatic: true; the kit has not verified its switch."},
)


def mcp_url(value, at):
    """Credential-free HTTP(S) URL. Plain HTTP only for localhost or a non-global IP literal."""
    if type(value) is not str or not URL_FORM.fullmatch(value) or not URL_FORM.fullmatch(unquote(unquote(value))):
        fail("mcp_url", at)
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        fail("mcp_url", at)
    if (parts.username is not None or parts.password is not None or parts.query or parts.fragment
            or "@" in parts.netloc or not parts.hostname or (port is not None and not 1 <= port <= 65535)):
        fail("mcp_url", at)
    if parts.scheme == "http" and parts.hostname != "localhost":
        try:
            address = ip_address(parts.hostname)
        except ValueError:
            fail("plain_http_url", at)
        if address.is_global:
            fail("plain_http_url", at)


def _reference_map(value, at, name_pattern, name_rule, literal_rule):
    """Env or header map: names by pattern, values as `${NAME}` references only."""
    if type(value) is not dict:
        fail("object", at)
    for key, item in value.items():
        if type(key) is not str or not name_pattern.fullmatch(key):
            fail(name_rule, at)
        if type(item) is not str:
            fail(literal_rule, at)
        if item.startswith("!"):
            fail("credential_command", at)  # `!command` runs a program for the value (adapter utils.ts).
        if not REF.fullmatch(item):
            fail(literal_rule, at)


def _server(entry, at):
    if type(entry) is not dict:
        fail("object", at)
    if entry.keys() & CREDENTIAL_FIELDS:
        fail("credential_field", at)
    if entry.keys() & NATIVE_FIELDS:
        fail("native_mcp_field", at)
    if entry.keys() & UNSUPPORTED_TRANSPORT:
        fail("unsupported_transport", at)
    fields(entry, (), COMMON + STDIO + HTTP, at)
    has_command, has_url = "command" in entry, "url" in entry
    if has_command == has_url:
        fail("transport_required" if not has_command else "transport_conflict", at)
    if has_url and entry.keys() & set(STDIO) or has_command and entry.keys() & set(HTTP):
        fail("transport_fields", at)
    if "disabled" in entry and type(entry["disabled"]) is not bool:
        fail("boolean", at + ".disabled")
    if "lifecycle" in entry and (type(entry["lifecycle"]) is not str or entry["lifecycle"] not in LIFECYCLES):
        fail("lifecycle", at + ".lifecycle")
    if "idleTimeout" in entry and (type(entry["idleTimeout"]) is not int or not 0 <= entry["idleTimeout"] <= 10 ** 6):
        fail("integer", at + ".idleTimeout")
    if "requestTimeoutMs" in entry and (type(entry["requestTimeoutMs"]) is not int or not 1 <= entry["requestTimeoutMs"] <= 10 ** 9):
        fail("integer", at + ".requestTimeoutMs")
    for key in ("directTools", "exposeResources", "inheritEnv"):
        if key in entry and type(entry[key]) is not bool:
            fail("boolean", at + "." + key)
    if "toolPrefix" in entry and (type(entry["toolPrefix"]) is not str or entry["toolPrefix"] not in TOOL_PREFIXES):
        fail("tool_prefix", at + ".toolPrefix")
    for key in ("includeTools", "excludeTools"):
        if key in entry:
            if type(entry[key]) is not list or any(type(t) is not str or not TOOL_NAME.fullmatch(t) for t in entry[key]):
                fail("tool_name", at + "." + key)
            if len(set(entry[key])) != len(entry[key]):
                fail("duplicate_tool", at + "." + key)
    if has_command:
        absolute(entry["command"], at + ".command")  # No PATH lookup, no `npx` install at connect time.
        if "args" in entry:
            if type(entry["args"]) is not list:
                fail("array", at + ".args")
            for item in entry["args"]:
                text(item, at + ".args")
                if CREDENTIAL_ARG.search(item):
                    fail("credential_argument", at + ".args")
        if "env" in entry:
            _reference_map(entry["env"], at + ".env", ENV, "env_name", "env_reference")
        if "cwd" in entry:
            absolute(entry["cwd"], at + ".cwd")
    else:
        mcp_url(entry["url"], at + ".url")
        if "headers" in entry:
            _reference_map(entry["headers"], at + ".headers", HEADER_NAME, "header_name", "literal_credential")
        if "httpTransport" in entry and (type(entry["httpTransport"]) is not str or entry["httpTransport"] not in HTTP_TRANSPORTS):
            fail("http_transport", at + ".httpTransport")
        if "caFile" in entry:
            absolute(entry["caFile"], at + ".caFile")


def validate_mcp(data):
    """Validate the whole `inputs.mcpFile` document. Returns the server names in file order."""
    if type(data) is not dict:
        fail("object", "mcp.file")
    if data.keys() & AMBIENT_FIELDS:
        fail("ambient_import_field", "mcp.file")
    fields(data, ("mcpServers",), ("$schema",), "mcp.file")
    if "$schema" in data and type(data["$schema"]) is not str:
        fail("text", "mcp.file.$schema")
    servers = data["mcpServers"]
    if type(servers) is not dict:
        fail("object", "mcp.mcpServers")
    seen = set()
    for name, entry in servers.items():
        if type(name) is not str or not SERVER_NAME.fullmatch(name):
            fail("server_name", "mcp.mcpServers")
        # The adapter merges by exact name; tool names derive from it. Case variants are one identity here.
        if name.casefold() in seen:
            fail("duplicate_server", "mcp.mcpServers")
        seen.add(name.casefold())
        _server(entry, "mcp.mcpServers.entry")
    return list(servers)


def render_mcp(definitions, components):
    """JSON-compatible contributions of the enabled MCP adapter module.

    `packages` are Pi package declarations, `settings` are settings.json keys, `files` are
    whole extra profile files, `setup` are process-local launch facts, `gaps` are readiness
    gaps, and `activation` is the public record kept with the plan.
    """
    names = validate_mcp(definitions)
    source = components["mcp"]["source"]
    servers, records, gaps = {}, {}, []
    gaps.append({"code": "package_runtime_unverified", "subject": "mcp"})
    # package.json peerDependencies: `@earendil-works/pi-ai` ^0.84.1 || ... || ^0.87.0 (optional) at the reviewed 3.2.0; Pi is 1.0.3.
    gaps.append({"code": "peer_range_unverified", "subject": "mcp"})
    # `/mcp-auth` and bearer stores use the OS keyring (`@napi-rs/keyring`), which HOME shares.
    gaps.append({"code": "credential_store_shared", "subject": "mcp"})
    for name in sorted(names):
        entry = copy.deepcopy(definitions["mcpServers"][name])
        servers[name] = entry
        disabled = entry.get("disabled", False)
        lifecycle = entry.get("lifecycle", "lazy")
        records[name] = {"transport": "stdio" if "command" in entry else "http", "disabled": disabled,
                         "lifecycle": lifecycle, "startupConnection": not disabled and lifecycle in STARTUP_LIFECYCLES}
        if disabled:
            continue
        gaps.append({"code": "server_connection_unverified", "subject": "mcp:" + name})
        if records[name]["startupConnection"]:
            gaps.append({"code": "startup_connection", "subject": "mcp:" + name})
        for value in (*entry.get("env", {}).values(), *entry.get("headers", {}).values()):
            # An unset variable becomes an empty string at connect time (adapter utils.ts); never checked here.
            gaps.append({"code": "env_reference_not_checked", "subject": value[2:-1]})
    content = {"mcpServers": servers, "settings": dict(ADAPTER_SETTINGS)}
    activation = {"enabled": True, "path": "adapter", "builtinMcp": "disabled", "configMode": MCP_MODE_VALUE,
                  "servers": records}
    return {"packages": [{"source": "npm:" + source["spec"], **copy.deepcopy(components["mcp"]["resources"])}],
            "settings": {"extensions": [BUILTIN_MCP_OFF]}, "files": {MCP_CONFIG: content},
            "setup": [{"kind": "process_environment", "name": MCP_MODE_NAME,
                       "instruction": MCP_MODE_NAME + "=" + MCP_MODE_VALUE}],
            "gaps": gaps, "activation": activation}


def workflow_record(components, mcp, promptr_enabled=False):
    """Per-module readiness matrix recorded with every plan, enabled or not."""
    promptr = components["promptr"]
    return {"promptr": {"enabled": promptr_enabled, "status": promptr["status"],
                        "prerequisites": [{"code": p["code"], "subject": p["subject"], "status": p["status"]}
                                          for p in PROMPTR_PREREQUISITES]},
            "mcp": mcp["activation"] if mcp else {"enabled": False, "status": components["mcp"]["status"]}}
