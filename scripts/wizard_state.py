"""Pure checklist state and reviewed handoff plans. Selection never grants execution."""
import copy
import hashlib
import json
import shlex

from scripts import components
from scripts.profile_plan import prepare, readiness, runtime_report, setup_commands
from scripts.validate import absolute, fail, fields, manifest, overlay as validate_overlay
from scripts.wizard_adapter import STATES, Approval


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def fresh(target, known):
    return {"schemaVersion": 1, "target": {"agentDir": target},
            "selection": components.selection(known, ["core"])["selection"],
            "paths": {}, "roles": {}, "endpoints": {}, "env": {},
            "inputs": {"modelsFile": None, "mcpFile": None},
            "consent": {"memoryCapture": False, "remoteMemoryWrites": False, "telemetry": False}}


def evidence(data, identity, manifest_data):
    fields(data, ("schemaVersion", "identity", "runtime", "components", "targetAbsent"), (), "wizard.evidence")
    if type(data["schemaVersion"]) is not int or data["schemaVersion"] != 1 or data["identity"] != identity:
        fail("identity_mismatch", "wizard.evidence")
    runtime_report(data["runtime"], manifest_data["runtime"])
    if type(data["targetAbsent"]) is not bool:
        fail("boolean", "wizard.evidence.targetAbsent")
    if type(data["components"]) is not dict or set(data["components"]) != set(manifest_data["components"]):
        fail("component_set", "wizard.evidence.components")
    for value in data["components"].values():
        if type(value) is not str or value not in STATES:
            fail("scan_status", "wizard.evidence.components")
    return copy.deepcopy(data)


class State(Approval):
    """The tenant-pi checklist state. Its rows have the display fields of the seam rows."""

    def __init__(self, manifest_data, identity, data=None, scan=None):
        self.manifest = copy.deepcopy(manifest_data)
        self.known = manifest(manifest_data)
        self.identity = copy.deepcopy(identity)
        self.overlay = copy.deepcopy(data) if data is not None else fresh(identity["target"], self.known)
        validate_overlay(self.overlay, self.known)
        if self.overlay["target"]["agentDir"] != identity["target"]:
            fail("target_mismatch", "wizard.overlay")
        self.original = copy.deepcopy(self.overlay)
        self.selected = list(components.overlay_enabled(self.overlay, self.known))
        self.scan = evidence(scan, identity, manifest_data) if scan is not None else None
        self.answers = {}
        self.models = None
        self.mcp = None
        self.registry = None
        self.approval = None
        self.added = []
        self.private_dir = None

    def toggle(self, cid):
        self.approval = None
        if cid in components.LOCKED:
            return "Core is required and locked."
        chosen = [item for item in self.selected if item != cid] if cid in self.selected else [*self.selected, cid]
        result = components.selection(self.known, chosen)
        if cid in self.selected and cid in result["selection"]["enable"]:
            return "Required by a selected component; clear its dependents first."
        self.selected = result["selection"]["enable"]
        self.added = sorted((set(self.added) | set(result["added"])) & set(self.selected))
        return "Dependencies added: " + ", ".join(result["added"]) if result["added"] else "Selection changed; nothing executes."

    def rows(self):
        rows = components.report(self.known, self.selected)["components"]
        for row in rows:
            cid = row["id"]
            row["title"] = cid
            row["details"] = [*row["extensions"], *row["skills"], *row["prerequisites"]]
            row["group"] = "Core features" if row["locked"] else "Optional features"
            detected = self.scan["components"][cid] if self.scan else "unknown"
            row["detected"] = detected
            row["verification"] = "not_verified"
            row["action"] = ("blocked" if row["status"] == "blocked" or detected == "incompatible" else
                             "reuse" if detected in ("compatible", "present") else
                             "install" if detected == "missing" else "configure")
            row["missingInformation"] = row["prerequisites"] if row["marked"] else []
        return sorted(rows, key=lambda row: not row["locked"])

    def configured(self):
        value = copy.deepcopy(self.overlay)
        value["selection"] = components.selection(self.known, self.selected)["selection"]
        enabled = set(self.selected)
        if "model-routing" not in enabled and value["roles"].get("interactive") is not None:
            value["roles"]["interactive"] = None
        if "mcp" not in enabled:
            value["inputs"]["mcpFile"] = None
        if "memory" in value:
            for cid in ("hermes", "wiki", "openviking", "agentcore"):
                if cid not in enabled and cid in value["memory"]:
                    value["memory"][cid] = None
        if not enabled & {"hermes", "wiki", "openviking", "agentcore"}:
            value["consent"]["memoryCapture"] = False
        if not enabled & {"openviking", "agentcore"}:
            value["consent"]["remoteMemoryWrites"] = False
        if "wiki" not in enabled:
            value["consent"].pop("embeddingTextTransfer", None)
        return value

    def review(self, private_dir):
        absolute(private_dir, "wizard.private_dir")
        overlay = self.configured()
        plan = prepare(self.manifest, overlay, registry=self.registry,
                       mcp_definitions=self.mcp if "mcp" in self.selected else None, models_definitions=self.models)
        blocked = []
        if not self.scan:
            blocked.append("target_scan_required")
        elif not self.scan["targetAbsent"]:
            blocked.append("target_exists")
        report = self.scan["runtime"] if self.scan else None
        setup = setup_commands(plan, report)["setup"]
        pi = report["pi"]["status"] if report else "unparsed"
        if pi not in ("missing", "match", "untested_in_range"):
            blocked.append("pi_requires_review_no_replacement")
            setup = [line for line in setup if not line.startswith("npm install --global")]
        for tool in ("node", "python"):
            if not report or report[tool]["status"] != "match":
                blocked.append(tool + "_bootstrap_requires_separate_plan")
        if self.scan:
            for cid in self.selected:
                source = self.known[cid]["source"]
                if cid != "core" and source and source["kind"] == "npm" and self.scan["components"][cid] in ("compatible", "present"):
                    package = shlex.quote(components._package_source(source))
                    setup = [line for line in setup if not line.endswith(" pi install " + package)]
                    blocked.append("reused_resource_location_requires_review:" + cid)
                if self.scan["components"][cid] == "incompatible":
                    blocked.append("incompatible_resource_requires_review:" + cid)
        prefix = self.answers.get("piPrefix")
        if pi == "missing":
            if not prefix:
                blocked.append("pi_prefix_required")
                setup = [line for line in setup if not line.startswith("npm install --global")]
            else:
                absolute(prefix, "wizard.piPrefix")
                setup = [line.replace("npm install --global -- ", "npm install --global --prefix " + shlex.quote(prefix) + " -- ") for line in setup]
        cli = "python3 " + shlex.quote(self.identity["clone"] + "/scripts/tenant_pi.py")
        command = (cli + " generate --overlay " + shlex.quote(private_dir + "/overlay.json") +
                   " --local-dir " + shlex.quote(private_dir) + " --target " + shlex.quote(self.identity["target"]))
        if self.registry is not None:
            command += " --registry " + shlex.quote(private_dir + "/registry.json")
        if self.answers.get("launcher"):
            absolute(self.answers["launcher"], "wizard.launcher")
            command += " --launcher " + shlex.quote(self.answers["launcher"])
        files = ["overlay.json", "handoff.json", "INSTALLER_KIT_RESULTS.md"]
        if self.models is not None:
            files.append("inputs/models.json")
        if self.mcp is not None and "mcp" in self.selected:
            files.append("inputs/mcp-adapter.json")
        if self.registry is not None:
            files.append("registry.json")
        result = {"schemaVersion": 1, "identity": self.identity, "evidence": self.scan,
                  "selection": overlay["selection"], "dependenciesAdded": self.added,
                  "overlayBefore": self.original, "overlayAfter": overlay,
                  "answers": self.answers, "models": self.models, "mcp": self.mcp if "mcp" in self.selected else None, "registry": self.registry,
                  "save": {"directory": private_dir, "files": files, "directoryMode": "0700", "fileMode": "0600"},
                  "candidateFiles": plan["files"], "ordinaryCommandsDisplayOnly": [command, *setup],
                  "commandsRunnable": False, "downloads": [line for line in setup if " install " in line or " ci " in line],
                  "privilegedActions": [], "blocked": blocked,
                  "readiness": readiness(plan, report=report), "execution": "guided_agent_only",
                  "permission": "save_only_not_installation", "checks": {"modelListing": "not_run", "inference": "not_run"},
                  "handoffRules": ["Recheck account, target absence, runtime and input digests before each changing stage.",
                                   "Review this exact plan again with the target account before installation.",
                                   "New accounts and system dependencies need a separate privileged plan and approval.",
                                   "Run ordinary commands as the target account, never via sudo.",
                                   "Keep accepted untested Pi; never replace, downgrade or uninstall from selection.",
                                   "Record completed stages; stop on failure, do not promise rollback.",
                                   "Use results at completion or stop, then POST_INSTALL.md."]}
        if self.identity["destination"] == "remote":
            result["blocked"].append("remote_replan_on_target_required")
            result["ordinaryCommandsDisplayOnly"] = []
            result["candidateFiles"] = {}
            result["handoffRules"].insert(0, "Run wizard on the remote account with these choices; local paths are not remote evidence.")
        if any(self.known[cid]["source"] and self.known[cid]["source"].get("path") in ("packages/tenantext", "packages/promptr") for cid in self.selected):
            result["blocked"].append("in_tree_dependencies_require_guided_review")
        if self.answers.get("herdrSkillScope") == "shared":
            result["blocked"].append("shared_skill_requires_separate_plan")
        result["digest"] = digest(result)
        return result
