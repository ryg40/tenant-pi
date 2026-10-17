"""The tenant-pi adapter of the wizard seam: the kit manifest, the Pi profile questions, scan and plan."""
import json
from pathlib import Path

from scripts import components, install_results, models_input
from scripts.validate import absolute, fail
from scripts.wizard_adapter import SEAM_VERSION, Adapter, secret_free
from scripts.wizard_state import State, evidence


class TenantPi(Adapter):
    id = "tenant-pi"
    seam_version = SEAM_VERSION
    options = ("manifest", "overlay", "local_dir", "registry")
    destinations = ("local", "remote", "compose")
    scope = ("Scan scope: fixed version probes, known kit resource directories and target absence. "
             "No live profile or vault contents.")

    def start(self, context):
        args, cli, load = context.args, context.cli, context.load
        manifest_data = load(args.manifest or str(cli.ROOT / "config/manifest.json"), "manifest.file")
        if args.overlay:
            cli._outside_pi_agent(args.overlay, "wizard.overlay")
            cli._outside_wiki_vault(args.overlay, "wizard.overlay", None)
        overlay = load(args.overlay, "overlay.file") if args.overlay else None
        # State runs the full tenant-pi manifest and overlay validation.
        state = State(manifest_data, context.identity, overlay)
        state.private_dir = context.private_dir
        # Reject known live configuration paths before loading any referenced input.
        if args.overlay:
            cli._outside_pi_agent(args.overlay, "wizard.overlay")
            cli._outside_wiki_vault(args.overlay, "wizard.overlay", state.overlay)
        local_dir = args.local_dir or (str(Path(args.overlay).parent) if args.overlay else None)
        for key, attribute in (("modelsFile", "models"), ("mcpFile", "mcp")):
            slot = state.overlay["inputs"].get(key)
            if slot is not None:
                expected = "inputs/models.json" if key == "modelsFile" else "inputs/mcp-adapter.json"
                if slot != expected or not local_dir:
                    fail("input_allowlist", "wizard.inputs")
                input_path = local_dir + "/" + slot
                cli._outside_pi_agent(input_path, "wizard.inputs")
                cli._outside_wiki_vault(input_path, "wizard.inputs", state.overlay)
                loaded = load(input_path, "wizard." + attribute)
                if attribute == "models":
                    models_input.validate(loaded)
                else:
                    from scripts.workflow_modules import validate_mcp
                    validate_mcp(loaded)
                secret_free(loaded, "wizard.input")
                setattr(state, attribute, loaded)
        if args.registry:
            cli._outside_pi_agent(args.registry, "wizard.registry")
            cli._outside_wiki_vault(args.registry, "wizard.registry", state.overlay)
            state.registry = load(args.registry, "registry.file")
        self.validate_catalog(self._rows(state))
        return state

    def _rows(self, state):
        rows = []
        for row in components.report(state.known, state.selected)["components"]:
            item = state.known[row["id"]]
            rows.append({"id": row["id"], "title": row["id"], "group": "core" if row["locked"] else "optional",
                         "locked": row["locked"], "requires": row["requires"],
                         "details": [*row["extensions"], *row["skills"], *row["prerequisites"]],
                         "blocked": item["reason"] if item["status"] == "blocked" else None,
                         "defaultSelected": row["marked"]})
        return rows

    def catalog(self, context):
        return self._rows(context.state)

    def evidence(self, data, state):
        return evidence(data, state.identity, state.manifest)

    def scan(self, identity, context):
        from scripts.wizard_scan import scan
        return scan(identity, context.state.manifest)

    def questions(self, state, ask, show):
        show("Only non-secret values. No model listing or inference occurs. /back retains all answers.")
        if state.scan and state.scan["runtime"]["pi"]["status"] == "missing":
            prefix = ask("piPrefix", "User-owned Pi installation prefix", state.identity["home"] + "/.npm-global")
            absolute(prefix, "wizard.piPrefix")
        launcher = ask("launcher", "Optional new launcher path; blank means none")
        if launcher:
            absolute(launcher, "wizard.launcher")
        enabled = set(state.selected)
        if "model-routing" in enabled:
            show("Existing gateway routes require offline --registry evidence; no credentials or discovery are imported.")
            if "modelRoutes" not in state.overlay:
                old = state.overlay["roles"].get("interactive") or {}
                provider = ask("provider", "Native provider ID, or direct provider ID (llama-swap/vllm)", old.get("provider", ""))
                model = ask("model", "Served model ID (manual entry; metadata is not guessed)", old.get("model", ""))
                state.overlay["roles"]["interactive"] = {"provider": provider, "model": model, "thinking": old.get("thinking", "off")}
                saved_provider = (state.models or {}).get("providers", {}).get(provider, {})
                url = ask("endpoint", "Direct OpenAI-compatible base URL; /clear for native provider", saved_provider.get("baseUrl", ""),
                          validate=lambda value: models_input.endpoint(value) if value else None)
                if url:
                    def key_name(value):
                        from scripts.validate import ENV
                        if value and not ENV.fullmatch(value):
                            fail("env_name", "wizard.keyVar")
                    saved_key = saved_provider.get("apiKey", "none")
                    key = ask("keyVar", "Authentication VARIABLE NAME only; /clear means no authentication",
                              saved_key.lstrip("$").strip("{}") if saved_key != "none" else "", validate=key_name)
                    saved_model = next((item for item in saved_provider.get("models", []) if item["id"] == model), {})
                    saved_metadata = {key: value for key, value in saved_model.items() if key != "id"}
                    metadata = ask("metadata", "Optional model metadata JSON from server documentation; blank uses Pi defaults",
                                   json.dumps(saved_metadata) if saved_metadata else "")
                    details = json.loads(metadata) if metadata else {}
                    if type(details) is not dict or not set(details) <= {"name", "contextWindow", "maxTokens", "reasoning", "input"}:
                        fail("metadata_fields", "wizard.models")
                    state.models = models_input.merge(state.models, provider, url, model, key or None, details)
                    state.overlay["inputs"]["modelsFile"] = models_input.SLOT
        memory_ids = enabled & {"hermes", "wiki", "openviking", "agentcore"}
        if memory_ids:
            show("Memory stores session text. Ambient wiki recall sends vault text to the selected model provider.")
            consent = ask("memoryConsent", "Permit the selected memory stores? Type yes or no", "yes" if state.overlay["consent"]["memoryCapture"] else "no")
            state.overlay["consent"]["memoryCapture"] = consent == "yes"
            memory = state.overlay.setdefault("memory", {"schemaVersion": 1, "hermes": None, "wiki": None, "openviking": None})
            for cid in sorted(memory_ids):
                defaults = {"hermes": {"backgroundReview": False}, "wiki": {"ambientPersonalVault": False, "backgroundTasks": False},
                            "openviking": {"captureToolResults": False}, "agentcore": {}}
                show(cid + ": background work stays off unless explicitly configured with a memory role and consent.")
                text = ask("memory." + cid, cid + " settings JSON (see docs/memory-modules.md)", json.dumps(memory.get(cid) or defaults[cid]))
                choice = json.loads(text)
                if type(choice) is not dict:
                    fail("object", "wizard.memory")
                if choice.get("backgroundReview") or choice.get("backgroundTasks"):
                    show("Background work sends session text to the memory model and can incur recurring model costs.")
                    if ask("backgroundConsent." + cid, "Permit background model work for " + cid + "? yes/no", "no") != "yes":
                        fail("background_consent_required", "wizard.memory")
                memory[cid] = choice
            if memory_ids & {"openviking", "agentcore"}:
                state.overlay["consent"]["remoteMemoryWrites"] = ask("remoteConsent", "Permit remote memory text transfer? yes/no", "no") == "yes"
            if "wiki" in memory_ids:
                show("Before launch: check-wiki-vault and baseline checks. Preserve existing and nested vaults; never create or reset them here.")
        if "mcp" in enabled:
            from scripts.workflow_modules import validate_mcp
            value = ask("mcp", "MCP definitions JSON; environment references only", json.dumps(state.mcp) if state.mcp else "",
                        validate=lambda text: validate_mcp(json.loads(text)))
            state.mcp = json.loads(value)
            state.overlay["inputs"]["mcpFile"] = "inputs/mcp-adapter.json"
        for cid in sorted(enabled):
            required = state.known[cid]["env"]
            if required:
                show(cid + " requires variable names: " + ", ".join(required) + ". Supply values only outside this wizard.")
        if "herdr" in enabled:
            state.answers["herdrSkillScope"] = ask("herdrSkillScope", "Herdr skill scope: profile or shared (shared needs a separate plan)", "profile")
            show("Herdr application and a temporary working session are separate checks; no shared skill is copied.")
        ask("modelListing", "Allow a future separately reviewed model-list check? yes/no (this wizard sends none)", "no")
        ask("inference", "Allow a future separately reviewed inference check? yes/no (may transfer text and incur cost)", "no")

    def plan(self, state, scan):
        # The reviewed plan of wizard_state without its digest: the wizard adds the same digest again.
        plan = state.review(state.private_dir)
        del plan["digest"]
        return plan

    def files(self, plan):
        return {name: plan[attribute] for attribute, name in
                (("models", "inputs/models.json"), ("mcp", "inputs/mcp-adapter.json"), ("registry", "registry.json"))
                if plan[attribute] is not None}

    def results(self, plan, state, directory, kit):
        data = {"schemaVersion": 1, "date": "2000-01-01", "installingAgent": "tenant-pi wizard",
                "status": "stopped", "lastStage": "reviewed private handoff", "nextStep": "Review with the guided agent; no install approval is stored",
                "account": {"name": plan["identity"]["account"], "createdByInstall": False, "openShell": "Use the existing target account"},
                "places": {"clone": kit, "privateDirectory": directory},
                "stages": [{"stage": "installation", "state": "not_run", "note": None}],
                "checks": [{"name": name, "state": "not_run", "note": None} for name in ("model listing", "inference", "live profile", "vault baseline")],
                "wikiVault": {"path": None, "existedBefore": False, "kept": False},
                "notes": ["No profile or vault file was opened. Saved evidence does not prove remote facts.",
                          "Review POST_INSTALL.md after installation. No package rollback is promised."]}
        from datetime import datetime, timezone
        data["date"] = datetime.now(timezone.utc).date().isoformat()
        install_results.facts(data, [])
        return install_results.render(commit="unknown", kit_root=kit, overlay_path=directory + "/overlay.json",
                                      overlay=plan["overlayAfter"], known=state.known, facts=data, candidates=[])


ADAPTER = TenantPi()
