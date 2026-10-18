"""Wizard orchestration: read, scan, review, then explicitly save a private handoff only.

The adapter of `--adapter` gives the catalog, questions, scan and plan of one kit (scripts/wizard_adapter.py).
The terminal, the answer checks, the digest, the SAVE approval and the private save stay here for every adapter.
"""
import copy
import json
import os
import re
import stat

from scripts import wizard_adapter
from scripts.profile_write import WriteError, check_location, create_new_file, open_new_parent, DIR_FLAGS
from scripts.validate import Invalid, absolute, fail
from scripts.wizard_adapter import FILE_NAME, FIXED_FILES, OPTIONS, SEAM_VERSION, json_value, secret_free
from scripts.wizard_state import digest
from scripts.remote_plan import remote_plan, USER


def arguments(subs, root):
    cmd = subs.add_parser("wizard", help="scan-driven checklist; saves only an approved private handoff, never installs")
    cmd.add_argument("--adapter", default="tenant-pi",
                     help="adapter ID (tenant-pi) or absolute path of the adapter file of another kit")
    cmd.add_argument("--manifest", help="kit manifest of the tenant-pi adapter (default: config/manifest.json)")
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


# A terminal escape sequence: CSI, OSC (ended by BEL or ST) or another sequence of two characters.
ESCAPE = re.compile(r"\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|.?)", re.S)


def _safe(value):
    # This is a known-form check, not a promise to recognize every possible secret.
    return secret_free(value, "wizard.input")


def _control(char, lines=False):
    return (ord(char) < 32 and not (lines and char == "\n")) or 127 <= ord(char) < 160


def _printable(value, lines=False):
    """Adapter text for the terminal: escape sequences removed, each other control character as `?`."""
    return "".join("?" if _control(char, lines) else char for char in ESCAPE.sub("", str(value)))


def _results(adapter, plan, state, directory, kit):
    """The INSTALLER_KIT_RESULTS.md text of the adapter, with the checks of an answer. Line breaks stay."""
    value = adapter.results(plan, state, directory, kit)
    if type(value) is not str:
        fail("adapter_results", "wizard.results")
    if any(_control(char, lines=True) for char in value):
        fail("control_character", "wizard.results")
    secret_free(value, "wizard.results")
    return value.encode("utf-8")


def _fingerprint(path, load, field):
    data = load(path, field, raw=True)
    info = os.lstat(path)
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, digest(data.hex()))


def _save(directory, files):
    """Exclusive new directory, fixed names, private files. No existing overlay is replaced."""
    parent = child = inputs = None
    created = False
    try:
        parent, leaf = open_new_parent(directory)
        os.mkdir(leaf, 0o700, dir_fd=parent)
        created = True
        child = os.open(leaf, DIR_FLAGS, dir_fd=parent)
        info = os.fstat(child)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise WriteError("dir_privacy", "wizard.private_dir", candidate_created=True)
        os.mkdir("inputs", 0o700, dir_fd=child)
        inputs = os.open("inputs", DIR_FLAGS, dir_fd=child)
        for name, data in files.items():
            create_new_file((inputs if name.startswith("inputs/") else child, name.split("/")[-1]), data, 0o600, "wizard.private_dir")
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


def _asker(state, terminal):
    """The `ask` of every adapter: it clears approval, refuses controls and secret forms, then validates."""
    def ask(key, label, default="", validate=None):
        state.approval = None
        shown = state.answers.get(key, default)
        # The terminal prints the default; an answer could not hold its controls either.
        if any(_control(char) for char in str(shown)):
            fail("control_character", "wizard.default")
        value = terminal.ask(_printable(label), shown)
        # Never retain terminal controls or known secret forms in a draft answer.
        if any(_control(char) for char in value):
            fail("control_character", "wizard.answer")
        _safe(value)
        if validate is not None:
            validate(value)
        state.answers[key] = value
        return value
    return ask


def _questions(state, terminal, adapter=None):
    if adapter is None:
        from scripts.wizard_adapter_tenant_pi import ADAPTER as adapter
    adapter.questions(state, _asker(state, terminal), lambda value: terminal.show(_printable(value, lines=True)))


def _plan(adapter, state):
    """The plan data of the adapter with the digest of the wizard. Adapter and seam version stay outside it."""
    plan = adapter.plan(state, state.scan)
    json_value(plan, "wizard.plan", 4 << 20)
    if type(plan) is not dict or type(plan.get("overlayAfter")) is not dict or {"digest", "adapter", "seamVersion"} & plan.keys():
        fail("plan_shape", "wizard.plan")
    plan = copy.deepcopy(plan)
    plan["digest"] = digest(plan)
    return plan


def _scanned(adapter, state, data):
    return wizard_adapter.check_scan(data, state.identity, [row["id"] for row in state.rows()])


def _files(adapter, plan):
    files = adapter.files(plan)
    if type(files) is not dict:
        fail("adapter_files", "wizard.files")
    for name, value in files.items():
        if type(name) is not str or not FILE_NAME.fullmatch(name) or name in FIXED_FILES:
            fail("adapter_file_name", "wizard.files")
        json_value(value, "wizard.files")
        _safe(value)
    return files


def run(args, cli, terminal=None):
    from scripts.wizard_terminal import Back, Cancelled, Terminal
    terminal = terminal or Terminal()
    if not USER.fullmatch(args.account):
        fail("account", "wizard.account")
    for key in ("home", "target", "private_dir"):
        absolute(getattr(args, key), "wizard." + key)
    # Only explicit inputs load. No installed settings, auth, or vault contents are read.
    tracked = {}
    def load(path, field, raw=False):
        cli._outside_pi_agent(path, field)
        cli._outside_wiki_vault(path, field, None)
        before = _fingerprint(path, cli._load_input, field)
        value = cli._load_input(path, field, raw=raw)
        after = _fingerprint(path, cli._load_input, field)
        if before != after:
            fail("input_changed", field)
        tracked[(path, field)] = after
        return value
    adapter = wizard_adapter.load_adapter(args.adapter, load)
    if args.destination not in adapter.destinations:
        fail("adapter_destination", "wizard.destination")
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
    for name in OPTIONS:
        if getattr(args, name) is not None and name not in adapter.options:
            fail("adapter_option", "wizard." + name)
    context = wizard_adapter.Context(args, cli, identity, load, None if args.adapter in wizard_adapter.BUILTIN else args.adapter)
    state = adapter.start(context)
    context.state = state
    _safe(state.overlay)
    cli._outside_kit(args.private_dir, "wizard.private_dir")
    cli._outside_pi_agent(args.private_dir, "wizard.private_dir")
    cli._outside_wiki_vault(args.private_dir, "wizard.private_dir", state.overlay)
    check_location(args.private_dir, (("under_target", args.target),), "init-private.dir")
    if args.destination == "local":
        cli._outside_kit(args.target, "wizard.target")
        cli._outside_pi_agent(args.target, "wizard.target")
        cli._outside_wiki_vault(args.target, "wizard.target", state.overlay)
    if args.evidence:
        cli._outside_pi_agent(args.evidence, "wizard.evidence")
        cli._outside_wiki_vault(args.evidence, "wizard.evidence", state.overlay)
        state.scan = adapter.evidence(load(args.evidence, "wizard.evidence"), state)
    if args.format == "json":
        return {"status": "data_only", "identity": identity, "components": state.rows(), "remoteHandoff": remote,
                "writes": False, "scan": state.scan, "note": "No scan or approval is inferred from absent input."}
    try:
        terminal.show(json.dumps(identity, indent=2))
        terminal.show(adapter.scope)
        if terminal.ask("Confirm target/account and scan scope: type scan (or evidence for supplied offline facts)") != ("evidence" if args.evidence else "scan"):
            raise Cancelled()
        if not args.evidence:
            if args.destination == "remote":
                return {"status": "resumable_stop", "reason": "remote_evidence_required", "remoteHandoff": remote,
                        "note": "No SSH connection made. Run the wizard on the target account or supply target-bound offline evidence."}
            state.scan = _scanned(adapter, state, adapter.scan(identity, context))
        while True:
            try:
                terminal.checklist(state)
                _questions(state, terminal, adapter)
                plan = _plan(adapter, state)
                if args.destination == "local":
                    cli._outside_wiki_vault(args.private_dir, "wizard.private_dir", plan["overlayAfter"])
                    cli._outside_wiki_vault(args.target, "wizard.target", plan["overlayAfter"])
                _safe(plan)
                terminal.page(json.dumps(plan, sort_keys=True, indent=2, ensure_ascii=True).splitlines())
                terminal.show("Adapter: " + adapter.id + ", seam version " + str(SEAM_VERSION) + ".")
                terminal.show("This saves a NEW private handoff only. Existing overlays stay unchanged. Installation needs separate approval.")
                if not state.approve(plan, terminal.ask("Type SAVE " + plan["digest"] + " to save; /back revises")):
                    raise Cancelled()
                for (path, field), expected in tracked.items():
                    if _fingerprint(path, cli._load_input, field) != expected:
                        fail("input_changed", "wizard.approval")
                if not args.evidence:
                    current = _scanned(adapter, state, adapter.scan(identity, context))
                    if current != state.scan:
                        fail("facts_changed", "wizard.approval")
                elif args.destination == "local":
                    if os.path.lexists(args.target) == state.scan["targetAbsent"]:
                        fail("target_changed", "wizard.approval")
                state.check_approval(_plan(adapter, state))
                def encode(value):
                    return (json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n").encode("ascii")
                handoff = {**plan, "adapter": adapter.id, "seamVersion": SEAM_VERSION}
                files = {"overlay.json": encode(plan["overlayAfter"]), "handoff.json": encode(handoff),
                         "INSTALLER_KIT_RESULTS.md": _results(adapter, plan, state, args.private_dir, str(cli.ROOT))}
                for name, value in _files(adapter, plan).items():
                    files[name] = encode(value)
                _save(args.private_dir, files)
                return {"status": "saved_handoff", "directory": args.private_dir, "digest": plan["digest"],
                        "installed": False, "results": args.private_dir + "/INSTALLER_KIT_RESULTS.md"}
            except Back:
                state.approval = None
            except (Invalid, json.JSONDecodeError) as exc:
                state.approval = None
                if isinstance(exc, Invalid) and str(exc).startswith(("input_changed", "facts_changed", "target_changed", "approval_invalidated")):
                    raise
                terminal.show(_printable(exc) if isinstance(exc, Invalid) else "Invalid JSON; no input text is logged.")
    except (Cancelled, Back, KeyboardInterrupt, EOFError, BrokenPipeError, OSError):
        return {"status": "cancelled", "installed": False}
