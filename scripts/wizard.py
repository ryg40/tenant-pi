"""Wizard orchestration: read, scan, review, then explicitly save a private handoff only."""
import json
import os
import stat
from pathlib import Path

from scripts import install_results, models_input
from scripts.private_init import check_location
from scripts.profile_write import WriteError, _ancestors, _create_file, _DIR_FLAGS
from scripts.validate import Invalid, absolute, fail
from scripts.wizard_state import State, digest
from scripts.remote_plan import remote_plan, USER


def arguments(subs, root):
    cmd = subs.add_parser("wizard", help="scan-driven checklist; saves only an approved private handoff, never installs")
    cmd.add_argument("--manifest", default=str(root / "config/manifest.json"))
    cmd.add_argument("--destination", choices=("local", "remote", "compose"), default="local")
    cmd.add_argument("--account", required=True)
    cmd.add_argument("--home", required=True)
    cmd.add_argument("--target", required=True, help="new profile path on the chosen target")
    cmd.add_argument("--clone", help="kit path on the chosen target (required for remote)")
    cmd.add_argument("--ssh-target")
    cmd.add_argument("--private-dir", required=True, help="new private handoff directory on this machine; parent exists")
    cmd.add_argument("--overlay", help="explicit saved private overlay; never overwritten")
    cmd.add_argument("--local-dir", help="directory of the saved overlay inputs")
    cmd.add_argument("--registry", help="offline capability evidence for existing model routes")
    cmd.add_argument("--evidence", help="target-bound offline scan JSON; rechecked before save")
    cmd.add_argument("--format", choices=("interactive", "json"), default="interactive")


def _safe(value):
    # This is a known-form check, not a promise to recognize every possible secret.
    if any(pattern.search(json.dumps(value, ensure_ascii=True)) for pattern in install_results.SECRET):
        fail("secret_like", "wizard.input")
    return value


def _fingerprint(path, load, field):
    data = load(path, field, raw=True)
    info = os.lstat(path)
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, digest(data.hex()))


def _save(directory, files):
    """Exclusive new directory, fixed names, private files. No existing overlay is replaced."""
    parent = child = inputs = None
    created = False
    try:
        parent, leaf = _ancestors(directory)
        os.mkdir(leaf, 0o700, dir_fd=parent)
        created = True
        child = os.open(leaf, _DIR_FLAGS, dir_fd=parent)
        info = os.fstat(child)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise WriteError("dir_privacy", "wizard.private_dir", candidate_created=True)
        os.mkdir("inputs", 0o700, dir_fd=child)
        inputs = os.open("inputs", _DIR_FLAGS, dir_fd=child)
        for name, data in files.items():
            _create_file(inputs if name.startswith("inputs/") else child, name.split("/")[-1], data)
        os.fsync(inputs)
        os.fsync(child)
        named = os.stat(leaf, dir_fd=parent, follow_symlinks=False)
        if (info.st_ino, info.st_dev) != (named.st_ino, named.st_dev):
            raise WriteError("target_changed", "wizard.private_dir", candidate_created=True)
        os.fsync(parent)
    except WriteError as exc:
        raise WriteError(exc.rule, "wizard.private_dir", candidate_created=created) from None
    except OSError:
        raise WriteError("save_failed_partial" if created else "save_failed", "wizard.private_dir",
                         candidate_created=created) from None
    finally:
        for fd in (inputs, child, parent):
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass


def _questions(state, terminal):
    def ask(key, label, default="", validate=None):
        state.approval = None
        value = terminal.ask(label, state.answers.get(key, default))
        # Never retain terminal controls or known secret forms in a draft answer.
        if any(ord(char) < 32 or 127 <= ord(char) < 160 for char in value):
            fail("control_character", "wizard.answer")
        _safe(value)
        if validate is not None:
            validate(value)
        state.answers[key] = value
        return value
    terminal.show("Only non-secret values. No model listing or inference occurs. /back retains all answers.")
    if state.scan and state.scan["runtime"]["pi"]["status"] == "missing":
        prefix = ask("piPrefix", "User-owned Pi installation prefix", state.identity["home"] + "/.npm-global")
        absolute(prefix, "wizard.piPrefix")
    launcher = ask("launcher", "Optional new launcher path; blank means none")
    if launcher:
        absolute(launcher, "wizard.launcher")
    enabled = set(state.selected)
    if "model-routing" in enabled:
        terminal.show("Existing gateway routes require offline --registry evidence; no credentials or discovery are imported.")
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
        terminal.show("Memory stores session text. Ambient wiki recall sends vault text to the selected model provider.")
        consent = ask("memoryConsent", "Permit the selected memory stores? Type yes or no", "yes" if state.overlay["consent"]["memoryCapture"] else "no")
        state.overlay["consent"]["memoryCapture"] = consent == "yes"
        memory = state.overlay.setdefault("memory", {"schemaVersion": 1, "hermes": None, "wiki": None, "openviking": None})
        for cid in sorted(memory_ids):
            defaults = {"hermes": {"backgroundReview": False}, "wiki": {"ambientPersonalVault": False, "backgroundTasks": False},
                        "openviking": {"captureToolResults": False}, "agentcore": {}}
            terminal.show(cid + ": background work stays off unless explicitly configured with a memory role and consent.")
            text = ask("memory." + cid, cid + " settings JSON (see docs/memory-modules.md)", json.dumps(memory.get(cid) or defaults[cid]))
            choice = json.loads(text)
            if type(choice) is not dict:
                fail("object", "wizard.memory")
            if choice.get("backgroundReview") or choice.get("backgroundTasks"):
                terminal.show("Background work sends session text to the memory model and can incur recurring model costs.")
                if ask("backgroundConsent." + cid, "Permit background model work for " + cid + "? yes/no", "no") != "yes":
                    fail("background_consent_required", "wizard.memory")
            memory[cid] = choice
        if memory_ids & {"openviking", "agentcore"}:
            state.overlay["consent"]["remoteMemoryWrites"] = ask("remoteConsent", "Permit remote memory text transfer? yes/no", "no") == "yes"
        if "wiki" in memory_ids:
            terminal.show("Before launch: check-wiki-vault and baseline checks. Preserve existing and nested vaults; never create or reset them here.")
    if "mcp" in enabled:
        from scripts.workflow_modules import validate_mcp
        value = ask("mcp", "MCP definitions JSON; environment references only", json.dumps(state.mcp) if state.mcp else "",
                    validate=lambda text: validate_mcp(json.loads(text)))
        state.mcp = json.loads(value)
        state.overlay["inputs"]["mcpFile"] = "inputs/mcp-adapter.json"
    for cid in sorted(enabled):
        required = state.known[cid]["env"]
        if required:
            terminal.show(cid + " requires variable names: " + ", ".join(required) + ". Supply values only outside this wizard.")
    if "herdr" in enabled:
        state.answers["herdrSkillScope"] = ask("herdrSkillScope", "Herdr skill scope: profile or shared (shared needs a separate plan)", "profile")
        terminal.show("Herdr application and a temporary working session are separate checks; no shared skill is copied.")
    ask("modelListing", "Allow a future separately reviewed model-list check? yes/no (this wizard sends none)", "no")
    ask("inference", "Allow a future separately reviewed inference check? yes/no (may transfer text and incur cost)", "no")


def _result(plan, known, directory, kit):
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
                                  overlay=plan["overlayAfter"], known=known, facts=data, candidates=[])


def run(args, cli):
    from scripts.wizard_terminal import Back, Cancelled, Terminal
    from scripts.wizard_scan import scan
    terminal = Terminal()
    if not USER.fullmatch(args.account):
        fail("account", "wizard.account")
    for key in ("home", "target", "private_dir"):
        absolute(getattr(args, key), "wizard." + key)
    clone = args.clone or (str(cli.ROOT) if args.destination == "local" else None)
    if args.destination == "compose":
        return {"status": "handoff", "route": "compose-plan", "qualified": False,
                "note": "Use the separate Compose-seat guide; this wizard creates no seat."}
    absolute(clone, "wizard.clone")
    if args.destination == "local" and clone != str(cli.ROOT):
        fail("clone_mismatch", "wizard.clone")
    identity = {"destination": args.destination, "account": args.account, "home": args.home,
                "target": args.target, "clone": clone, "sshTarget": args.ssh_target}
    if args.destination == "remote":
        remote = remote_plan(args.ssh_target, args.account, args.home)
    else:
        remote = None
    # Only explicit private inputs load. No installed settings, auth, or vault contents are read.
    tracked = {}
    def load(path, field):
        before = _fingerprint(path, cli._load_input, field)
        value = cli._load_input(path, field)
        after = _fingerprint(path, cli._load_input, field)
        if before != after:
            fail("input_changed", field)
        tracked[(path, field)] = after
        return value
    manifest_data = load(args.manifest, "manifest.file")
    if args.overlay:
        cli._outside_pi_agent(args.overlay, "wizard.overlay")
        cli._outside_wiki_vault(args.overlay, "wizard.overlay")
    overlay = load(args.overlay, "overlay.file") if args.overlay else None
    state = State(manifest_data, identity, overlay)
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
            _safe(loaded)
            setattr(state, attribute, loaded)
    if args.registry:
        cli._outside_pi_agent(args.registry, "wizard.registry")
        cli._outside_wiki_vault(args.registry, "wizard.registry", state.overlay)
        state.registry = load(args.registry, "registry.file")
    _safe(state.overlay)
    cli._outside_kit(args.private_dir, "wizard.private_dir")
    cli._outside_pi_agent(args.private_dir, "wizard.private_dir")
    cli._outside_wiki_vault(args.private_dir, "wizard.private_dir", state.overlay)
    check_location(args.private_dir, (("under_target", args.target),))
    if args.destination == "local":
        cli._outside_kit(args.target, "wizard.target")
        cli._outside_pi_agent(args.target, "wizard.target")
        cli._outside_wiki_vault(args.target, "wizard.target", state.overlay)
    if args.evidence:
        cli._outside_pi_agent(args.evidence, "wizard.evidence")
        cli._outside_wiki_vault(args.evidence, "wizard.evidence", state.overlay)
        from scripts.wizard_state import evidence
        state.scan = evidence(load(args.evidence, "wizard.evidence"), identity, manifest_data)
    if args.format == "json":
        return {"status": "data_only", "identity": identity, "components": state.rows(), "remoteHandoff": remote,
                "writes": False, "scan": state.scan, "note": "No scan or approval is inferred from absent input."}
    try:
        terminal.show(json.dumps(identity, indent=2))
        terminal.show("Scan scope: fixed version probes, known kit resource directories and target absence. No live profile or vault contents.")
        if terminal.ask("Confirm target/account and scan scope: type scan (or evidence for supplied offline facts)") != ("evidence" if args.evidence else "scan"):
            raise Cancelled()
        if not args.evidence:
            if args.destination == "remote":
                return {"status": "resumable_stop", "reason": "remote_evidence_required", "remoteHandoff": remote,
                        "note": "No SSH connection made. Run the wizard on the target account or supply target-bound offline evidence."}
            state.scan = scan(identity, manifest_data)
        while True:
            try:
                terminal.checklist(state)
                _questions(state, terminal)
                plan = state.review(args.private_dir)
                if args.destination == "local":
                    cli._outside_wiki_vault(args.private_dir, "wizard.private_dir", plan["overlayAfter"])
                    cli._outside_wiki_vault(args.target, "wizard.target", plan["overlayAfter"])
                _safe(plan)
                terminal.page(json.dumps(plan, sort_keys=True, indent=2, ensure_ascii=True).splitlines())
                terminal.show("This saves a NEW private handoff only. Existing overlays stay unchanged. Installation needs separate approval.")
                if not state.approve(plan, terminal.ask("Type SAVE " + plan["digest"] + " to save; /back revises")):
                    raise Cancelled()
                for (path, field), expected in tracked.items():
                    if _fingerprint(path, cli._load_input, field) != expected:
                        fail("input_changed", "wizard.approval")
                if not args.evidence:
                    current = scan(identity, manifest_data)
                    if current != state.scan:
                        fail("facts_changed", "wizard.approval")
                elif args.destination == "local":
                    if os.path.lexists(args.target) == state.scan["targetAbsent"]:
                        fail("target_changed", "wizard.approval")
                state.check_approval(state.review(args.private_dir))
                def encode(value):
                    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("ascii")
                files = {"overlay.json": encode(plan["overlayAfter"]), "handoff.json": encode(plan),
                         "INSTALLER_KIT_RESULTS.md": _result(plan, state.known, args.private_dir, str(cli.ROOT)).encode("utf-8")}
                for attribute, name in (("models", "inputs/models.json"), ("mcp", "inputs/mcp-adapter.json"), ("registry", "registry.json")):
                    if plan[attribute] is not None:
                        files[name] = encode(plan[attribute])
                _save(args.private_dir, files)
                return {"status": "saved_handoff", "directory": args.private_dir, "digest": plan["digest"],
                        "installed": False, "results": args.private_dir + "/INSTALLER_KIT_RESULTS.md"}
            except Back:
                state.approval = None
            except (Invalid, json.JSONDecodeError) as exc:
                state.approval = None
                if isinstance(exc, Invalid) and str(exc).startswith(("input_changed", "facts_changed", "target_changed", "approval_invalidated")):
                    raise
                terminal.show(str(exc) if isinstance(exc, Invalid) else "Invalid JSON; no input text is logged.")
    except (Cancelled, Back, KeyboardInterrupt, EOFError, BrokenPipeError, OSError):
        return {"status": "cancelled", "installed": False}
