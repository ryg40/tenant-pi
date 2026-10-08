"""Pure memory-module contract: explicit activation, consent, and rendered contributions.

No file, environment, subprocess, or network access. Every diagnostic is a static
`rule: field` string; overlay values never enter it.
"""
import copy
import ipaddress
import re
import shlex
from urllib.parse import parse_qsl, unquote, urlsplit

from scripts.validate import ENV, MEMORY as _MEMORY, ROOT, absolute, fail, fields, text

MEMORY = tuple(sorted(_MEMORY))  # One reviewed set; the validator anchors own it.
# The overlay fields of each module: the required names, then the optional names. The validator,
# `compare` and `carry` use this one table.
MODULE_FIELDS = {"hermes": (("backgroundReview",), ("reviewTransport", "childExtensionPaths")),
                 "wiki": (("ambientPersonalVault", "backgroundTasks"), ("wikiHome", "embedding")),
                 "openviking": (("captureToolResults",), ("recallContextTimeoutMs",))}
HERMES_CONFIG = "hermes-memory-config.json"
HERMES_PACKAGE = "pi-hermes-memory"
WIKI_PACKAGE = "@zosmaai/pi-llm-wiki"
# Upstream requires a nonempty bearer key even for a server that ignores authentication.
WIKI_NO_AUTH_KEY = "no-auth-required"
# Existing kit restriction; the 0.12.5 TaskConfig reader ignores taskThinkingLevel.
WIKI_THINKING = ("low", "medium", "high", "xhigh")
REVIEW_TRANSPORTS = ("direct", "subprocess")
# Pi 0.99.1 `-e builtin:<name>`; the resource loader reports unknown names at runtime.
BUILTIN = re.compile(r"builtin:[a-z][a-z0-9.-]*\Z")
# Providers whose child Pi process needs an explicit extension source under `--no-extensions`.
GATEWAY_PROVIDERS = frozenset(("litellm-codex", "openai-codex-2"))
LLAMA_PROVIDER = "llama.cpp"
# Hermes `config.ts` (reviewed at 0.9.9; the kit declares no version) background paths. Off means no model call originates from Hermes.
HERMES_OFF = {"reviewEnabled": False, "correctionDetection": False, "flushOnCompact": False,
              "flushOnShutdown": False, "memoryOverflowStrategy": "reject", "autoConsolidate": False}
# The vendored OpenViking extension (`packages/openviking-pi`) reads no file of the profile. Its
# `shared/config-schema.mjs` names one `OPENVIKING_*` variable for each setting; the environment
# is the first layer that it reads. Overlay field -> variable name.
OPENVIKING_ENV = {"captureToolResults": "OPENVIKING_CAPTURE_TOOL_RESULTS",
                  "recallContextTimeoutMs": "OPENVIKING_RECALL_CONTEXT_TIMEOUT_MS"}
# `config-schema.mjs`, `recallContextTimeoutMs`: an integer from 0 to 600000; 0 keeps the built-in default.
OPENVIKING_TIMEOUT_MAX = 600000
HERMES_ON = {"reviewEnabled": True, "correctionDetection": True, "flushOnCompact": True,
             "flushOnShutdown": True, "memoryOverflowStrategy": "auto-consolidate", "autoConsolidate": True}


def _memory_role(overlay, at):
    role = overlay["roles"].get("memory")
    if role is None:
        fail("memory_role_required", at)
    return role


def _child_provider_need(role):
    """Which explicit child extension source the memory role's provider needs, if any."""
    if role.get("route", "native") == "gateway" or role["provider"] in GATEWAY_PROVIDERS:
        return "package"
    if role["provider"] == LLAMA_PROVIDER:
        return "builtin:" + LLAMA_PROVIDER
    return None


def _hermes(overlay, choice):
    at = "overlay.memory.hermes"
    fields(choice, *MODULE_FIELDS["hermes"], at)
    if type(choice["backgroundReview"]) is not bool:
        fail("boolean", at + ".backgroundReview")
    if not choice["backgroundReview"]:
        if "reviewTransport" in choice or "childExtensionPaths" in choice:
            fail("unused_memory_field", at)
        return
    if "reviewTransport" not in choice or type(choice["reviewTransport"]) is not str or choice["reviewTransport"] not in REVIEW_TRANSPORTS:
        fail("review_transport", at + ".reviewTransport")
    paths = choice.get("childExtensionPaths", [])
    if type(paths) is not list:
        fail("array", at + ".childExtensionPaths")
    for item in paths:
        if type(item) is not str or not (BUILTIN.fullmatch(item) or item.startswith("/")):
            fail("child_extension_source", at + ".childExtensionPaths")
        if item.startswith("/"):
            absolute(item, at + ".childExtensionPaths")
    if len(set(paths)) != len(paths):
        fail("duplicate_child_extension", at + ".childExtensionPaths")
    role = _memory_role(overlay, at + ".backgroundReview")
    need = _child_provider_need(role)
    if need == "package" and not any(item.startswith("/") for item in paths):
        fail("missing_child_provider", at + ".childExtensionPaths")
    if need is not None and need.startswith("builtin:") and need not in paths:
        fail("missing_child_provider", at + ".childExtensionPaths")


def _embedding_url(value, at):
    if type(value) is not str:
        fail("embedding_url", at)
    try:
        # Reject parser-stripped controls and encoded credentials before publishing the URL.
        for candidate in (value, unquote(value), unquote(unquote(value))):
            parsed = urlsplit(candidate)
            if (any(c.isspace() or not c.isprintable() for c in candidate)
                    or any(c in candidate for c in '\\#<>"{}|^`')
                    or parsed.scheme not in ("http", "https") or not parsed.hostname
                    or parsed.username is not None or parsed.password is not None
                    or parsed.port == 0 or parsed.netloc.endswith(":")
                    or re.search(r"%(?![0-9a-fA-F]{2})", candidate)):
                fail("embedding_url", at)
            host = parsed.hostname
            if ":" in host:
                ipaddress.IPv6Address(host)
            elif (len(host) > 253 or not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?", label)
                                            for label in host.rstrip(".").split("."))):
                fail("embedding_url", at)
            if any(key.casefold() in {"key", "token", "api_key", "apikey", "secret", "password", "authorization"}
                   for key, _ in parse_qsl(parsed.query, keep_blank_values=True)):
                fail("embedding_url", at)
    except ValueError:
        fail("embedding_url", at)


def _embedding(choice, at):
    fields(choice, ("provider", "baseUrl", "model", "auth"), ("expectedDimensions",), at)
    if choice["provider"] != "openai-compatible" or type(choice["provider"]) is not str:
        fail("embedding_provider", at + ".provider")
    _embedding_url(choice["baseUrl"], at + ".baseUrl")
    model = text(choice["model"], at + ".model")
    if any(c.isspace() or not c.isprintable() for c in model):
        fail("embedding_model", at + ".model")
    auth = choice["auth"]
    fields(auth, (), ("envVar", "mode"), at + ".auth")
    if set(auth) == {"envVar"}:
        if type(auth["envVar"]) is not str or not ENV.fullmatch(auth["envVar"]):
            fail("env_name", at + ".auth.envVar")
    elif set(auth) != {"mode"} or auth["mode"] != "none":
        fail("embedding_auth", at + ".auth")
    if "expectedDimensions" in choice:
        value = choice["expectedDimensions"]
        if type(value) is not int or value <= 0:
            fail("embedding_dimensions", at + ".expectedDimensions")


def _wiki(overlay, choice):
    at = "overlay.memory.wiki"
    fields(choice, *MODULE_FIELDS["wiki"], at)
    for key in ("ambientPersonalVault", "backgroundTasks"):
        if type(choice[key]) is not bool:
            fail("boolean", at + "." + key)
    if "wikiHome" in choice:
        absolute(choice["wikiHome"], at + ".wikiHome")
        # pi-llm-wiki 0.12.4 `resolveProjectVaultRoot` treats WIKI_HOME as this project's vault,
        # so every ambient surface fires. A quiet wiki cannot have a relocated personal vault.
        if not choice["ambientPersonalVault"]:
            fail("wiki_home_is_ambient", at + ".wikiHome")
    if choice.get("embedding") is not None:
        _embedding(choice["embedding"], at + ".embedding")
    if choice["backgroundTasks"]:
        role = _memory_role(overlay, at + ".backgroundTasks")
        if role["thinking"] not in WIKI_THINKING:
            fail("unsupported_wiki_thinking", "overlay.roles.memory.thinking")


def _openviking(overlay, choice):
    at = "overlay.memory.openviking"
    fields(choice, *MODULE_FIELDS["openviking"], at)
    if type(choice["captureToolResults"]) is not bool:
        fail("boolean", at + ".captureToolResults")
    if "recallContextTimeoutMs" in choice:
        value = choice["recallContextTimeoutMs"]
        if type(value) is not int or not 0 <= value <= OPENVIKING_TIMEOUT_MAX:
            fail("timeout_ms", at + ".recallContextTimeoutMs")


def validate_memory(overlay, components):
    """Validate the optional `memory` block against selection and consent.

    The core overlay validator owns every other field and runs first.
    """
    enabled = set(overlay["selection"]["enable"])
    active = [cid for cid in MEMORY if cid in enabled]
    if "memory" not in overlay:
        if active:
            fail("memory_choices_required", "overlay.memory")
        return
    block = overlay["memory"]
    fields(block, ("schemaVersion", *MEMORY), (), "overlay.memory")
    if type(block["schemaVersion"]) is not int or block["schemaVersion"] != 1:
        fail("schema_version", "overlay.memory.schemaVersion")
    if active and not overlay["consent"]["memoryCapture"]:
        fail("memory_consent_required", "overlay.consent.memoryCapture")
    # Every capture of the OpenViking extension is a write to its server.
    if "openviking" in active and not overlay["consent"]["remoteMemoryWrites"]:
        fail("remote_memory_consent_required", "overlay.consent.remoteMemoryWrites")
    for cid in MEMORY:
        choice = block[cid]
        if choice is None:
            if cid in enabled:
                fail("memory_choices_required", "overlay.memory." + cid)
            continue
        if cid not in enabled:
            fail("memory_module_disabled", "overlay.memory." + cid)
        if cid == "hermes":
            _hermes(overlay, choice)
        elif cid == "wiki":
            _wiki(overlay, choice)
        else:
            _openviking(overlay, choice)


def _package(components, cid):
    source = components[cid]["source"]
    # Pi takes a local package as a plain path; a tree package directory is inside this kit.
    name = str(ROOT / source["path"]) if source["kind"] == "tree" else "npm:" + source["spec"]
    return {"source": name, **copy.deepcopy(components[cid]["resources"])}


def render_memory(overlay, components):
    """Return JSON-compatible contributions for the enabled memory modules.

    The caller runs the overlay validator first; it already includes `validate_memory`.
    `packages` are Pi package declarations, `settings` are settings.json keys, `files`
    are whole extra profile files, `setup` are process-local launch facts, `unset` are the
    names that the launch line removes, `gaps` are readiness gaps, and `activation` is the
    public truth table recorded with the plan.
    `ROOT` is used only as text, for the path of the in-tree package.
    """
    enabled = set(overlay["selection"]["enable"])
    result = {"packages": [], "settings": {}, "files": {}, "setup": [], "unset": [], "gaps": [], "activation": {}}
    block = overlay.get("memory", {})
    role = overlay["roles"].get("memory")
    for cid in MEMORY:
        if cid not in enabled:
            result["activation"][cid] = {"enabled": False}
            continue
        choice = block[cid]
        result["packages"].append(_package(components, cid))
        if cid == "openviking":
            # A tree package: its gaps are the manifest gaps, and it lists no host module as a dependency.
            result["gaps"].extend({"code": gap["code"], "subject": cid} for gap in components[cid].get("gaps", []))
            # `true` and `false` are words that `coerceKnobValue` of the extension accepts. Both
            # states are written, so a lower layer cannot turn the capture of tool results on.
            values = {"captureToolResults": "true" if choice["captureToolResults"] else "false"}
            if "recallContextTimeoutMs" in choice:
                values["recallContextTimeoutMs"] = str(choice["recallContextTimeoutMs"])
            for key, value in values.items():
                result["setup"].append({"kind": "process_environment", "name": OPENVIKING_ENV[key],
                                        "instruction": OPENVIKING_ENV[key] + "=" + value})
            # The pending queue, the recall ledger and the workspace registry live under `~/.openviking/`.
            result["gaps"].append({"code": "shared_home_state", "subject": cid})
            result["activation"][cid] = {"enabled": True, "localCapture": False, "backgroundModelCalls": False,
                                         "remoteWrites": True, "captureToolResults": choice["captureToolResults"]}
            continue
        result["gaps"].append({"code": "package_runtime_unverified", "subject": cid})
        result["gaps"].append({"code": "peer_override_required", "subject": cid})
        if cid == "hermes":
            config = dict(HERMES_ON if choice["backgroundReview"] else HERMES_OFF)
            record = {"enabled": True, "localCapture": True, "backgroundModelCalls": choice["backgroundReview"],
                      "remoteWrites": False}
            if choice["backgroundReview"]:
                config["reviewTransport"] = choice["reviewTransport"]
                config["llmModelOverride"] = role["provider"] + "/" + role["model"]
                config["llmThinkingOverride"] = role["thinking"]
                paths = list(choice.get("childExtensionPaths", []))
                if paths:
                    config["childExtensionPaths"] = paths
                    result["gaps"].append({"code": "child_provider_unverified", "subject": cid})
                record["reviewTransport"] = choice["reviewTransport"]
                record["childExtensionSources"] = len(paths)
            result["files"][HERMES_CONFIG] = config
            result["gaps"].append({"code": "native_addon_unverified", "subject": "better-sqlite3"})
            # Hermes backfills `<agent dir>/sessions` at start and honours PI_CODING_AGENT_SESSION_DIR.
            result["gaps"].append({"code": "session_backfill_scope_unverified", "subject": cid})
        else:
            settings = {"ambientPersonalVault": choice["ambientPersonalVault"], "trajectories": False}
            record = {"enabled": True, "localCapture": True, "ambientPersonalVault": choice["ambientPersonalVault"],
                      "backgroundModelCalls": choice["backgroundTasks"], "remoteWrites": False}
            if choice["backgroundTasks"]:
                settings["taskModel"] = {"provider": role["provider"], "id": role["model"]}
                settings["taskThinkingLevel"] = role["thinking"]
            embedding = choice.get("embedding")
            record["embeddings"] = {"enabled": embedding is not None, "writeTimeRequests": embedding is not None,
                                    "queryTimeRequests": embedding is not None, "backfill": "separate action"}
            if embedding is not None:
                settings.update(embeddingProvider=embedding["provider"], embeddingBaseUrl=embedding["baseUrl"],
                                embeddingModel=embedding["model"])
                auth = embedding["auth"]
                if "envVar" in auth:
                    settings["embeddingApiKeyEnv"] = auth["envVar"]
                else:
                    settings["embeddingApiKey"] = WIKI_NO_AUTH_KEY
                result["gaps"].append({"code": "embedding_endpoint_unverified", "subject": cid})
                if "expectedDimensions" in embedding:
                    record["embeddings"]["expectedDimensions"] = embedding["expectedDimensions"]
                    result["gaps"].append({"code": "embedding_dimensions_unverified", "subject": cid})
            result["settings"]["llm-wiki"] = settings
            # A trusted project `.pi/settings.json` section wins over these switches at launch.
            result["gaps"].append({"code": "project_settings_override", "subject": cid})
            if "wikiHome" in choice:
                result["setup"].append({"kind": "process_environment", "name": "WIKI_HOME",
                                        "instruction": "WIKI_HOME=" + shlex.quote(choice["wikiHome"])})
                record["personalVault"] = "wikiHome"
            else:
                # An inherited `WIKI_HOME` would start a second vault there; the overlay alone names the vault place.
                result["unset"].append("WIKI_HOME")
                result["gaps"].append({"code": "shared_home_state", "subject": cid})
                record["personalVault"] = "home"
        result["activation"][cid] = record
    return result
