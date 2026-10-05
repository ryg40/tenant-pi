"""Pure memory-module contract: explicit activation, consent, and rendered contributions.

No file, environment, subprocess, or network access. Every diagnostic is a static
`rule: field` string; overlay values never enter it.
"""
import copy
import re
import shlex

from scripts.validate import MEMORY as _MEMORY, absolute, fail, fields

MEMORY = tuple(sorted(_MEMORY))  # One reviewed set; the validator anchors own it.
# The overlay fields of each module: the required names, then the optional names. The validator,
# `compare` and `carry` use this one table. `openviking` is blocked and accepts `null` only.
MODULE_FIELDS = {"hermes": (("backgroundReview",), ("reviewTransport", "childExtensionPaths")),
                 "wiki": (("ambientPersonalVault", "backgroundTasks"), ("wikiHome",)),
                 "openviking": ((), ())}
HERMES_CONFIG = "hermes-memory-config.json"
HERMES_PACKAGE = "pi-hermes-memory"
WIKI_PACKAGE = "@zosmaai/pi-llm-wiki"
# pi-llm-wiki `task-config.ts` (reviewed at 0.12.4; the kit declares no version) accepts only these four task thinking levels.
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
    if choice["backgroundTasks"]:
        role = _memory_role(overlay, at + ".backgroundTasks")
        if role["thinking"] not in WIKI_THINKING:
            fail("unsupported_wiki_thinking", "overlay.roles.memory.thinking")


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
            fail("memory_module_disabled", "overlay.memory." + cid)


def _package(components, cid):
    source = components[cid]["source"]
    return {"source": "npm:" + source["spec"], **copy.deepcopy(components[cid]["resources"])}


def render_memory(overlay, components):
    """Return JSON-compatible contributions for the enabled memory modules.

    The caller runs the overlay validator first; it already includes `validate_memory`.
    `packages` are Pi package declarations, `settings` are settings.json keys, `files`
    are whole extra profile files, `setup` are process-local launch facts, `gaps` are
    readiness gaps, and `activation` is the public truth table recorded with the plan.
    """
    enabled = set(overlay["selection"]["enable"])
    result = {"packages": [], "settings": {}, "files": {}, "setup": [], "gaps": [], "activation": {}}
    block = overlay.get("memory", {})
    role = overlay["roles"].get("memory")
    for cid in MEMORY:
        if cid not in enabled:
            result["activation"][cid] = {"enabled": False}
            continue
        choice = block[cid]
        result["packages"].append(_package(components, cid))
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
            result["settings"]["llm-wiki"] = settings
            # A trusted project `.pi/settings.json` section wins over these switches at launch.
            result["gaps"].append({"code": "project_settings_override", "subject": cid})
            if "wikiHome" in choice:
                result["setup"].append({"kind": "process_environment", "name": "WIKI_HOME",
                                        "instruction": "WIKI_HOME=" + shlex.quote(choice["wikiHome"])})
                record["personalVault"] = "wikiHome"
            else:
                result["gaps"].append({"code": "shared_home_state", "subject": cid})
                record["personalVault"] = "home"
        result["activation"][cid] = record
    return result
