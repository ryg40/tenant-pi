"""Pure preparation of a new Pi agent directory.

No file is opened or written. The manifest check only tests that each in-tree package directory exists.
"""
import copy
import hashlib
import json
import shlex

# Only the pure grammar of the runtime check is used here; this module starts no process.
from scripts.check_runtime import STATUSES, TOOLS, in_range, parse_range, parse_version, pi_status
from scripts.memory_modules import MEMORY, render_memory
from scripts.model_routes import BASE_NAME, KEY_NAME, render
from scripts.validate import ENV, OWNER_RESOURCES, ROLE_NAMES, ROOT, fail, fields, manifest, npm_name, overlay
from scripts.workflow_modules import render_mcp, workflow_record

OUTPUTS = ("settings.json", ".tenant-pi/choices.json")
# The gap that only the exclusive directory creation of the writer closes.
TARGET_GAP = "target_absence_unverified"
# Plan gap of a runtime requirement: (key of the `check-runtime` report, gap code for each measured status).
RUNTIME_GAPS = {
    "node_runtime_unverified": ("node", {"mismatch": "node_runtime_mismatch", "missing": "node_runtime_missing",
                                         "unparsed": "node_runtime_unparsed"}),
    "core_runtime_unverified": ("pi", {"mismatch": "core_runtime_mismatch", "missing": "core_runtime_missing",
                                       "unparsed": "core_runtime_unparsed",
                                       "untested_in_range": "core_runtime_untested_in_range"}),
}
# The mark of the global Pi install line for each Pi status of the report; no report is `None`.
PI_INSTALL = {None: "installed_version_unknown", "unparsed": "installed_version_unknown", "missing": "needed",
              "match": "not_needed", "untested_in_range": "not_needed", "mismatch": "replaces_installed"}
# With these marks the line is not a default step, so it leaves the setup lines.
PI_INSTALL_NOT_DEFAULT = ("not_needed", "replaces_installed")
# One `pi` command serves every profile of the user; a global install changes it for all of them.
GLOBAL_INSTALL_WARNING = "global_install_replaces_pi_for_all_profiles"
UNTESTED_PI_FACT = "The installed Pi is accepted by the range rule. The kit tests ran on the tested version only."
# Common names of provider key variables and of the variables that redirect or authorize a provider.
# The list is not complete: Pi can read a name that is not here.
PROVIDER_KEY_NAMES = ("ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "AZURE_OPENAI_API_KEY",
                      "DEEPSEEK_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "GROQ_API_KEY", "MISTRAL_API_KEY",
                      "OPENAI_API_KEY", "OPENAI_BASE_URL", "OPENROUTER_API_KEY", "XAI_API_KEY", "ZAI_API_KEY")
PROVIDER_KEY_WARNING = "provider_key_in_launching_environment"
PROVIDER_KEY_FACT = ("Pi reads a provider key from the environment of the launching shell, including in a profile with "
                     "no login. A model reply can come from a provider that you did not choose.")
PROVIDER_KEY_REMEDY = "Name the model on the launch line: --model '<provider>/<model>'"


def _package_source(source):
    if source["kind"] == "npm":
        return "npm:" + source["spec"]
    if source["kind"] == "git" and source["subdir"] == "":
        return "git:" + source["url"] + "@" + source["commit"]
    if source["kind"] == "tree":
        # Pi takes a local package as a plain path; the package directory is inside this kit.
        return str(ROOT / source["path"])
    fail("unsupported_package_source", "manifest.components.source")


def source_pin(source):
    """Public pin text of a manifest source; `None` for a blocked module without a source."""
    if source is None:
        return None
    kind = source.get("kind") if type(source) is dict else None
    if kind == "npm" and type(source.get("spec")) is str:
        return "npm:" + source["spec"]
    if kind == "git" and all(type(source.get(key)) is str for key in ("url", "commit", "subdir")):
        return "git:" + source["url"] + "@" + source["commit"] + ("#" + source["subdir"] if source["subdir"] else "")
    if kind == "tree" and type(source.get("path")) is str:
        return "tree:" + source["path"]  # Kit-relative; the host path of the kit stays out of the record.
    if kind == "builtin":
        return "builtin"
    return "unsupported"


def _pi_install_line(spec):
    return "npm install --global -- " + shlex.quote(spec)


def _package_identity(source):
    if source["kind"] == "npm":
        return ("npm", npm_name(source["spec"]))
    if source["kind"] == "tree":
        return ("tree", source["path"])
    return ("git", source["url"])


def prepare(manifest_data, overlay_data, *, registry=None, required_roles=(), credential_names=frozenset(),
            mcp_definitions=None):
    """Build an offline plan from explicit capability evidence, never host state.

    `mcp_definitions` is the loaded `inputs.mcpFile` document; the CLI supplies it and the
    writer replays it from the private choices record. It is required exactly when `mcp` is enabled.
    """
    components = manifest(manifest_data)
    overlay(overlay_data, components)
    enabled = set(overlay_data["selection"]["enable"])
    if type(required_roles) not in (tuple, list) or any(type(r) is not str or r not in ROLE_NAMES for r in required_roles) or len(set(required_roles)) != len(required_roles):
        fail("required_roles", "required_roles")
    declared_names = {name for cid in enabled for name in components[cid]["env"]}
    if type(credential_names) not in (set, frozenset) or any(type(n) is not str or not ENV.fullmatch(n) for n in credential_names) or not credential_names <= declared_names:
        fail("credential_names", "credential_names")
    if overlay_data["inputs"]["modelsFile"] is not None:
        fail("unsupported_models_file", "overlay.inputs.modelsFile")
    if mcp_definitions is not None and "mcp" not in enabled:
        fail("mcp_definitions_without_module", "mcp.file")
    if "mcp" in enabled and mcp_definitions is None:
        fail("mcp_definitions_required", "mcp.file")
    if overlay_data["consent"]["telemetry"]:
        fail("telemetry_activation_unavailable", "overlay.consent.telemetry")

    roles = overlay_data["roles"]
    if roles.get("interactive") is not None and "model-routing" not in enabled:
        fail("model_routing_required", "overlay.roles.interactive")
    if "modelRoutes" not in overlay_data and (overlay_data["env"] or overlay_data["endpoints"]):
        fail("integration_configuration_unavailable", "overlay.env_or_endpoints")
    if "modelRoutes" not in overlay_data:
        for role in roles.values():
            if role is not None and (role["provider"] == "litellm-codex" or
                                     (role["provider"] == "openai-codex-2" and "codex-accounts" not in enabled)):
                fail("reserved_provider", "overlay.roles")
    choices_exist = ("modelRoutes" in overlay_data and
                     (any(r is not None for r in roles.values()) or overlay_data["modelRoutes"]["cycle"]))
    if choices_exist and registry is None:
        fail("registry_required", "registry")
    if registry is not None and type(registry) is not dict:
        fail("mock_registry", "registry")
    if "modelRoutes" not in overlay_data and registry is not None:
        fail("registry_without_routes", "registry")
    route = (render(overlay_data, registry if registry is not None else {}, required_roles=required_roles,
                    credential_names=credential_names) if "modelRoutes" in overlay_data else None)
    memory = render_memory(overlay_data, components) if enabled & set(MEMORY) else None
    mcp = render_mcp(mcp_definitions, components) if "mcp" in enabled else None
    memory_model_roles = {"memory"} if memory and any(
        record.get("backgroundModelCalls") for record in memory["activation"].values()) else set()
    if route is None and required_roles:
        # Legacy overlays retain their role metadata, but missing roles cannot become defaults.
        role_status = {name: "selected" if roles.get(name) is not None else
                       "required_missing" if name in required_roles else "unset" for name in ROLE_NAMES}
    else:
        role_status = route["roleStatus"] if route else {name: "selected" if roles.get(name) else "unset" for name in ROLE_NAMES}
    target = overlay_data["target"]["agentDir"]
    settings = {"defaultProjectTrust": "ask", "enableInstallTelemetry": False,
                "enableAnalytics": False, "packages": []}
    if route:
        settings.update(route["settings"])
    elif roles.get("interactive") is not None:
        interactive = roles["interactive"]
        settings.update(defaultProvider=interactive["provider"], defaultModel=interactive["model"],
                        defaultThinkingLevel=interactive["thinking"])

    # Fixed in the pure plan: no file is opened and no process starts here. `readiness` replaces
    # these three with the facts that the caller has.
    gaps = [{"code": TARGET_GAP, "subject": target},
            {"code": "node_runtime_unverified", "subject": manifest_data["runtime"]["nodeRange"]},
            {"code": "core_runtime_unverified", "subject": components["core"]["source"]["spec"]}]
    setup = [_pi_install_line(components["core"]["source"]["spec"])]
    identities = set()
    pending_packages = []
    tree_packages = {}
    for cid in sorted(enabled - {"core", "model-routing"}):
        component = components[cid]
        source = component["source"]
        if source is None:
            fail("unsupported_package_source", "manifest.components.source")
        identity = _package_identity(source)
        package = _package_source(source)
        resources = copy.deepcopy(component["resources"])
        if memory is not None and cid in MEMORY and source["kind"] == "tree":
            continue  # The vendored memory package: declared below in the memory render order, with its gaps.
        if source["kind"] == "tree":
            # Components of one in-tree package share one declaration; each adds only its own filter.
            entry = tree_packages.get(identity)
            if entry is None:
                entry = tree_packages[identity] = {"source": package, **{key: [] for key in resources}}
                settings["packages"].append(entry)
            for key, items in resources.items():
                entry[key].extend(item for item in items if item not in entry[key])
            gaps.append({"code": "package_runtime_unverified", "subject": cid})
            gaps.extend({"code": gap["code"], "subject": cid} for gap in component.get("gaps", []))
            continue
        if identity in identities:
            fail("duplicate_package_identity", "overlay.selection.enable")
        identities.add(identity)
        if memory is not None and cid in MEMORY:
            continue  # Declared below in the memory render order, after Tenantext.
        elif mcp is not None and cid == "mcp":
            continue  # Declared below after the memory packages.
        else:
            pending_packages.append({"component": cid, "source": package, "resources": resources})
            gaps.append({"code": "optional_activation_unavailable", "subject": cid})

    for role in sorted(roles):
        if roles[role] is None:
            continue
        gaps.append({"code": "model_catalog_unverified", "subject": role})
        gaps.append({"code": "provider_auth_unverified", "subject": role})
        if role != "interactive" and role not in memory_model_roles:
            gaps.append({"code": "role_activation_unavailable", "subject": role})
    if route:
        selected = {(r["provider"], r["model"]) for r in roles.values() if r is not None}
        for choice in overlay_data["modelRoutes"]["cycle"]:
            if (choice["provider"], choice["model"]) not in selected:
                subject = "cycle:" + choice["provider"] + "/" + choice["model"]
                gaps.append({"code": "model_catalog_unverified", "subject": subject})
                gaps.append({"code": "provider_auth_unverified", "subject": subject})
        for name in route["requiredRoles"]:
            if role_status[name] == "required_missing":
                gaps.append({"code": "required_role_missing", "subject": name})
        for name in route["credentialNames"]:
            gaps.append({"code": "credential_value_not_checked" if name in credential_names else "credential_missing",
                         "subject": name})
        if any(item.get("method") == "pi_login_blocked" for item in route["setup"]):
            gaps.append({"code": "pi_login_blocked", "subject": "litellm-codex"})
        if overlay_data["modelRoutes"]["gateway"] is not None:
            gaps.append({"code": "gateway_upstream_unverified", "subject": "codex-accounts"})
    else:
        for name in sorted(required_roles):
            if role_status[name] == "required_missing":
                gaps.append({"code": "required_role_missing", "subject": name})
        for name in sorted(declared_names):
            gaps.append({"code": "credential_value_not_checked" if name in credential_names else "credential_missing",
                         "subject": name})
    # `env -u` removes an inherited session directory, so Pi keeps the sessions under the target
    # (docs/launcher.md, "The session directory").
    launch = "env -u PI_CODING_AGENT_SESSION_DIR PI_CODING_AGENT_DIR=" + shlex.quote(target) + " pi --no-approve"
    files = {"settings.json": {"mode": "0600", "content": settings}}
    if memory is not None:
        settings["packages"].extend(memory["packages"])
        settings.update(memory["settings"])
        gaps.extend(memory["gaps"])
        for name, content in memory["files"].items():
            files[name] = {"mode": "0600", "content": content}
        for item in memory["setup"]:
            launch = item["instruction"] + " " + launch
    if mcp is not None:
        settings["packages"].extend(mcp["packages"])
        settings.update(mcp["settings"])
        gaps.extend(mcp["gaps"])
        for name, content in mcp["files"].items():
            files[name] = {"mode": "0600", "content": content}
        for item in mcp["setup"]:
            launch = item["instruction"] + " " + launch
    # Owner packages come last, in overlay order: a plain path stays a string, a filtered entry
    # keeps only the keys the overlay gives. The kit does not open, install or load these paths.
    for item in overlay_data.get("ownerPackages", []):
        settings["packages"].append(copy.deepcopy(item))
        gaps.append({"code": "owner_package_unqualified", "subject": item if type(item) is str else item["source"]})
    # Owner skill and prompt directories go into the Pi `skills` and `prompts` arrays, after any kit
    # entry, in overlay order. An empty list renders no key. The kit does not open these directories.
    for kind in OWNER_RESOURCES:
        for path in overlay_data.get("ownerResources", {}).get(kind, []):
            settings.setdefault(kind, []).append(path)
            gaps.append({"code": "owner_resource_unqualified", "subject": kind + ":" + path})
    # The npm memory modules. The vendored OpenViking package is a path inside the kit: Pi installs
    # nothing for it, and it lists no host module as a dependency.
    npm_memory = any(components[cid]["source"]["kind"] == "npm" for cid in enabled & set(MEMORY))
    if npm_memory or mcp is not None:
        # Pi reconciles declared packages with `pi update --extensions` (packages.md).
        setup.append("PI_CODING_AGENT_DIR=" + shlex.quote(target) + " pi update --extensions")
    if npm_memory:
        # The peer override corrects host-provided `dependencies` in the installed memory manifests;
        # the adapter lists none, so the mcp module alone needs no override.
        setup.append("PI_CODING_AGENT_DIR=" + shlex.quote(target) + " node scripts/patch_extension_peers.mjs")
    if "openviking" in enabled:
        # The one dependency of the vendored package is not in the tree (manifest gap `install_step_required`).
        setup.append("npm --prefix " + shlex.quote(_package_source(components["openviking"]["source"])) + " ci --ignore-scripts")
    if route and overlay_data["modelRoutes"]["gateway"] is not None:
        base = next(item["instruction"] for item in route["setup"] if item["kind"] == "process_environment")
        launch = base + " " + launch
    # The evidence is private and inert. The writer uses it to rebuild the full plan.
    choices = {"overlay": copy.deepcopy(overlay_data), "manifest": copy.deepcopy(manifest_data),
               "registry": copy.deepcopy(registry),
               "registryDigest": hashlib.sha256(json.dumps(registry, sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest(),
               "requiredRoles": sorted(required_roles),
               "credentialNames": sorted(credential_names), "routes": route,
               "roleStatus": role_status, "pendingPackages": pending_packages,
               "memory": {"activation": memory["activation"], "setup": memory["setup"]} if memory else None,
               "workflow": workflow_record(components, mcp, "promptr" in enabled), "mcpDefinitions": copy.deepcopy(mcp_definitions)}
    files[".tenant-pi/choices.json"] = {"mode": "0600", "content": choices}
    return {"schemaVersion": 1, "targetAgentDir": target, "files": files,
            "commands": {"launch": launch, "setup": setup}, "readinessGaps": gaps}


def runtime_report(data, runtime):
    """Validate one `check-runtime` report against a validated `manifest.runtime`, and return it.

    The report is evidence that the caller supplies: no process starts here, so the kit cannot
    tell a current report from an old one. It refuses a report of another pin or range, and a
    status that does not agree with the two versions of its entry.
    """
    fields(data, [key for key, _, _ in TOOLS], [], "runtime_report")
    for key, _, field in TOOLS:
        at = "runtime_report." + key
        entry = data[key]
        fields(entry, ("installed", "required", "status", "tested", "acceptedRange") if key == "pi" else
               ("installed", "required", "status"), [], at)
        if type(entry["required"]) is not str or entry["required"] != runtime[field]:
            fail("runtime_report_required", at + ".required")
        if key == "pi":
            for name, value in (("tested", runtime["piVersion"]), ("acceptedRange", runtime["piAcceptedRange"])):
                if type(entry[name]) is not str or entry[name] != value:
                    fail("runtime_report_required", at + "." + name)
        status, installed = entry["status"], entry["installed"]
        if type(status) is not str or status not in STATUSES or (key != "pi" and status == "untested_in_range"):
            fail("runtime_report_status", at + ".status")
        version_statuses = ("match", "untested_in_range", "mismatch")
        if installed is None:
            if status in version_statuses:
                fail("runtime_report_installed", at + ".installed")
            continue
        found = parse_version(installed.encode("ascii")) if type(installed) is str and installed.isascii() else None
        # The text is the version token itself: no name, no `v`, no space, no second line.
        if status not in version_statuses or found is None or found[0] != installed:
            fail("runtime_report_installed", at + ".installed")
        expected = (pi_status(found, runtime, parse_range(runtime["piAcceptedRange"],
                                                        "manifest.runtime.piAcceptedRange")) if key == "pi" else
                    "match" if in_range(found[1], parse_range(runtime[field], "manifest.runtime." + field), found[2])
                    else "mismatch")
        if expected != status:
            fail("runtime_report_status", at + ".status")
    return data


def readiness(plan, *, report=None, generated=False):
    """The readiness gaps of a plan after the facts that the caller has. The plan does not change.

    `generated` is true only after the writer created the target; that creation proved its absence.
    `report` is a validated `check-runtime` report, or None. A `match` removes the runtime gap.
    Another status replaces it with a gap that names the installed and the required version.
    `runtimeReady` is always false: the kit has no live trial of a profile. The gap list holds
    the measured facts.
    """
    gaps = []
    for gap in plan["readinessGaps"]:
        if gap["code"] == TARGET_GAP and generated:
            continue
        if report is not None and gap["code"] in RUNTIME_GAPS:
            key, codes = RUNTIME_GAPS[gap["code"]]
            entry = report[key]
            if entry["status"] == "match":
                continue
            gap = {"code": codes[entry["status"]], "subject": gap["subject"],
                   "installed": entry["installed"], "required": entry["required"]}
            if entry["status"] == "untested_in_range":
                gap.update(tested=entry["tested"], acceptedRange=entry["acceptedRange"], fact=UNTESTED_PI_FACT)
        gaps.append(gap)
    return {"readinessGaps": gaps, "runtimeReady": False}


def _version_order(token):
    """Sort key of one version token: the numbers, then a prerelease before its release."""
    found = parse_version(token.encode("ascii")) if type(token) is str and token.isascii() else None
    return None if found is None else (found[1], not found[2])


def setup_commands(plan, report=None):
    """The setup lines of a plan and the mark of the global Pi install line. The plan does not change.

    `report` is a validated `check-runtime` report, or None. A tested or accepted Pi needs no install.
    With a `mismatch` the line replaces the installed Pi, so it is not a default step: these cases
    remove it from the setup lines. `piInstall` always shows the line with its mark and the warning.
    """
    manifest_data = plan["files"][".tenant-pi/choices.json"]["content"]["manifest"]
    command = _pi_install_line(manifest_data["components"]["core"]["source"]["spec"])
    required = manifest_data["runtime"]["piVersion"]
    entry = report["pi"] if report is not None else {"status": None, "installed": None}
    status, change = PI_INSTALL[entry["status"]], None
    if status == "replaces_installed":
        have, want = _version_order(entry["installed"]), _version_order(required)
        # `downgrade`: the line replaces a newer Pi with the older pin.
        change = ("unordered" if have is None or want is None or have == want else
                  "downgrade" if have > want else "upgrade")
    lines = [line for line in plan["commands"]["setup"] if line != command or status not in PI_INSTALL_NOT_DEFAULT]
    return {"setup": lines,
            "piInstall": {"command": command, "status": status, "installed": entry["installed"], "required": required,
                          "change": change, "warning": GLOBAL_INSTALL_WARNING}}


def provider_key_warning(names):
    """The warning for the known provider key variables among `names`, or None when none is there.

    `names` holds the names of the variables that are set where the plan runs. The caller gives names only:
    no value reaches this function, and the warning holds none.
    """
    found = [name for name in PROVIDER_KEY_NAMES if name in names]
    if not found:
        return None
    return {"code": PROVIDER_KEY_WARNING, "variables": found, "fact": PROVIDER_KEY_FACT, "remedy": PROVIDER_KEY_REMEDY}
