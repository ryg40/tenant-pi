"""Linux-first, new-target-only publication of an in-memory profile plan."""
import json
import os
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timezone

from scripts.kit_commit import UNKNOWN, commit
from scripts.memory_modules import HERMES_CONFIG
from scripts.profile_plan import OUTPUTS, source_pin
from scripts.workflow_modules import MCP_CONFIG
from scripts.validate import Invalid, absolute, fail, relative

STATE = ".tenant-pi/state.json"  # Writer-owned; not a planner output.
OPTIONAL_OUTPUTS = (HERMES_CONFIG, MCP_CONFIG)  # Whole extra profile files an optional module may own.
_DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
GENERATED_AT = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z\Z")
_FILE_FLAGS = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC


@dataclass(frozen=True)
class WriteResult:
    target_agent_dir: str
    complete: bool
    warnings: tuple[str, ...] = ()


class WriteError(ValueError):
    """Static rule/field diagnostic; candidate_created records partial output."""

    def __init__(self, rule, field, *, candidate_created=False):
        super().__init__(f"{rule}: {field}")
        self.rule = rule
        self.field = field
        self.candidate_created = candidate_created


def _shape(obj, keys, field):
    if type(obj) is not dict:
        fail("object", field)
    if set(obj) != set(keys) or any(type(k) is not str for k in obj):
        fail("fields", field)


def _plain(obj, field):
    """Accept only finite, non-recursive JSON values with string, unique object keys."""
    seen = set()

    def visit(value):
        if type(value) in (str, int, bool) or value is None:
            return
        if type(value) is float:
            if not (-float("inf") < value < float("inf")):
                fail("json_number", field)
            return
        if type(value) not in (dict, list):
            fail("json_type", field)
        if id(value) in seen:
            fail("json_cycle", field)
        seen.add(id(value))
        if type(value) is dict:
            for key, item in value.items():
                if type(key) is not str:
                    fail("json_key", field)
                visit(item)
        else:
            for item in value:
                visit(item)
        seen.remove(id(value))

    visit(obj)


def _validated_bytes(plan, target):
    _plain(plan, "plan")
    _shape(plan, ("schemaVersion", "targetAgentDir", "files", "commands", "readinessGaps"), "plan")
    if type(plan["schemaVersion"]) is not int or plan["schemaVersion"] != 1:
        fail("schema_version", "plan.schemaVersion")
    absolute(target, "target")
    if target != plan["targetAgentDir"]:
        fail("target_mismatch", "plan.targetAgentDir")
    if type(plan["files"]) is not dict or not set(OUTPUTS) <= set(plan["files"]) <= set(OUTPUTS + OPTIONAL_OUTPUTS):
        fail("fields", "plan.files")
    names = [*OUTPUTS, *(name for name in OPTIONAL_OUTPUTS if name in plan["files"])]
    for name in names:
        relative(name, "plan.files.path")
        _shape(plan["files"][name], ("mode", "content"), "plan.files.entry")
        if plan["files"][name]["mode"] != "0600" or type(plan["files"][name]["mode"]) is not str:
            fail("file_mode", "plan.files.entry.mode")
    choices = plan["files"][".tenant-pi/choices.json"]["content"]
    _shape(choices, ("overlay", "manifest", "registry", "registryDigest", "requiredRoles", "credentialNames",
                     "routes", "roleStatus", "pendingPackages", "memory", "workflow", "mcpDefinitions"),
           "plan.files.choices.content")
    # A digest detects accidental edits to the declared registry, not fabricated evidence.
    import hashlib
    digest = hashlib.sha256(json.dumps(choices["registry"], sort_keys=True, separators=(",", ":"), ensure_ascii=True).encode("ascii")).hexdigest()
    if choices["registryDigest"] != digest:
        fail("registry_digest", "plan.files.choices.content.registryDigest")
    from scripts.profile_plan import prepare
    # Rebuild from anchored manifest and validated private evidence, never caller-rendered
    # settings, setup commands, route claims, or readiness flags.
    expected = prepare(choices["manifest"], choices["overlay"], registry=choices["registry"],
                       required_roles=choices["requiredRoles"],
                       credential_names=frozenset(choices["credentialNames"]),
                       mcp_definitions=choices["mcpDefinitions"])
    if (type(choices["credentialNames"]) is not list or
            len(choices["credentialNames"]) != len(set(choices["credentialNames"])) or
            choices["credentialNames"] != sorted(choices["credentialNames"])):
        fail("metadata_credentials", "plan.files.choices.content.credentialNames")
    if plan != expected or json.dumps(plan, sort_keys=True, ensure_ascii=True) != json.dumps(expected, sort_keys=True, ensure_ascii=True):
        fail("plan_mismatch", "plan")
    return {name: (json.dumps(plan["files"][name]["content"], sort_keys=True, ensure_ascii=True,
                              allow_nan=False, separators=(",", ":")) + "\n").encode("ascii") for name in names}


def _check_dir(fd, *, parent=False):
    info = os.fstat(fd)
    uid = os.geteuid()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid not in (0, uid):
        raise WriteError("unsafe_owner", "target.parents")
    if info.st_mode & 0o022 and not (info.st_mode & stat.S_ISVTX and info.st_uid in (0, uid)):
        raise WriteError("unsafe_permissions", "target.parents")
    if parent and info.st_uid != uid:
        raise WriteError("unsafe_parent_owner", "target.parent")


def _ancestors(target):
    segments = target[1:].split("/")
    fd = os.open("/", _DIR_FLAGS)
    try:
        _check_dir(fd)
        for part in segments[:-1]:
            child = os.open(part, _DIR_FLAGS, dir_fd=fd)
            try:
                _check_dir(child)
            except BaseException:
                os.close(child)
                raise
            os.close(fd)
            fd = child
        _check_dir(fd, parent=True)
        try:
            os.stat(segments[-1], dir_fd=fd, follow_symlinks=False)
        except FileNotFoundError:
            pass
        else:
            raise WriteError("target_exists", "target")
        return fd, segments[-1]
    except BaseException:
        os.close(fd)
        raise


def _create_file(fd, name, data, mode=0o600):
    file_fd = os.open(name, _FILE_FLAGS, mode, dir_fd=fd)
    try:
        info = os.fstat(file_fd)
        if not stat.S_ISREG(info.st_mode) or stat.S_IMODE(info.st_mode) != mode or info.st_uid != os.geteuid():
            raise WriteError("file_privacy", "target.files", candidate_created=True)
        with os.fdopen(file_fd, "wb", closefd=False) as output:
            written = output.write(data)
            if written != len(data):
                raise WriteError("short_write", "target.files", candidate_created=True)
            output.flush()
        os.fsync(file_fd)
    finally:
        os.close(file_fd)


def _provenance(choices, names):
    """Minimal non-secret generation record: kit schema, pins, selection, declared outputs.

    It is a record only, never authority to overwrite any installed file.
    """
    manifest, enabled = choices["manifest"], sorted(choices["overlay"]["selection"]["enable"])
    return {"kitSchemaVersion": manifest["schemaVersion"], "piVersion": manifest["runtime"]["piVersion"],
            "nodeRange": manifest["runtime"]["nodeRange"], "enabled": enabled,
            "pins": {cid: source_pin(manifest["components"][cid]["source"]) for cid in enabled},
            "outputs": [*names, STATE]}


def utc_now():
    """The default clock of `write`; a test injects a fixed one."""
    return datetime.now(timezone.utc)


def _generated_at(clock):
    """The generation time as `YYYY-MM-DDTHH:MM:SSZ`, from one call of the injected clock."""
    try:
        now = clock()
    except Exception:
        raise WriteError("clock", "state.generatedAt") from None
    try:
        if not isinstance(now, datetime) or now.utcoffset() is None:
            raise ValueError
        value = now.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, OverflowError):
        raise WriteError("clock", "state.generatedAt") from None
    if not GENERATED_AT.fullmatch(value):
        raise WriteError("clock", "state.generatedAt")
    return value


def _state(status, provenance):
    return (json.dumps({"schemaVersion": 1, "status": status, "provenance": provenance},
                       sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")


def write(plan, target_agent_dir, *, clock=utc_now, kit_commit=UNKNOWN):
    """Publish a new plan at an explicitly selected target, or raise WriteError.

    `clock` returns an aware datetime; `kit_commit` is a 40-hex commit or `"unknown"`.
    Both go into the provenance record; every refusal fires before the first write.
    """
    try:
        data = _validated_bytes(plan, target_agent_dir)
        provenance = _provenance(plan["files"][".tenant-pi/choices.json"]["content"], list(data))
    except (Invalid, ValueError, TypeError, RecursionError) as exc:
        if isinstance(exc, Invalid):
            raise WriteError("invalid_plan", str(exc)) from None
        raise WriteError("invalid_plan", "plan") from None
    if commit(kit_commit) is None:
        raise WriteError("kit_commit", "state.kitCommit")
    provenance = {**provenance, "generatedAt": _generated_at(clock), "kitCommit": kit_commit}
    try:
        parent_fd, leaf = _ancestors(target_agent_dir)
    except WriteError:
        raise
    except OSError:
        raise WriteError("unsafe_path", "target.parents") from None
    created = False
    published = False
    target_fd = meta_fd = None
    failure = None
    warnings = []
    try:
        # Exclusive directory creation is the ownership boundary. Never adopt it.
        os.mkdir(leaf, 0o700, dir_fd=parent_fd)
        created = True
        target_fd = os.open(leaf, _DIR_FLAGS, dir_fd=parent_fd)
        info = os.fstat(target_fd)
        if (info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700
                or not stat.S_ISDIR(info.st_mode)):
            raise WriteError("dir_privacy", "target")
        os.fsync(parent_fd)
        os.mkdir(".tenant-pi", 0o700, dir_fd=target_fd)
        meta_fd = os.open(".tenant-pi", _DIR_FLAGS, dir_fd=target_fd)
        meta = os.fstat(meta_fd)
        if meta.st_uid != os.geteuid() or stat.S_IMODE(meta.st_mode) != 0o700:
            raise WriteError("dir_privacy", "target.metadata")
        _create_file(meta_fd, "state.json", _state("incomplete", provenance))
        _create_file(target_fd, "settings.json", data["settings.json"])
        for name in OPTIONAL_OUTPUTS:
            if name in data:
                _create_file(target_fd, name, data[name])
        _create_file(meta_fd, "choices.json", data[".tenant-pi/choices.json"])
        os.fsync(target_fd)
        os.fsync(meta_fd)
        _create_file(meta_fd, "state.next", _state("complete", provenance))
        os.fsync(meta_fd)
        # Rename replaces a directory entry, not its target if it became a link.
        current = os.stat("state.json", dir_fd=meta_fd, follow_symlinks=False)
        if not stat.S_ISREG(current.st_mode) or current.st_uid != os.geteuid():
            raise WriteError("state_changed", "target.metadata")
        named_meta = os.stat(".tenant-pi", dir_fd=target_fd, follow_symlinks=False)
        if not stat.S_ISDIR(named_meta.st_mode) or (named_meta.st_dev, named_meta.st_ino) != (meta.st_dev, meta.st_ino):
            raise WriteError("metadata_changed", "target.metadata")
        named = os.stat(leaf, dir_fd=parent_fd, follow_symlinks=False)
        if not stat.S_ISDIR(named.st_mode) or (named.st_dev, named.st_ino) != (info.st_dev, info.st_ino):
            raise WriteError("target_changed", "target")
        os.replace("state.next", "state.json", src_dir_fd=meta_fd, dst_dir_fd=meta_fd)
        published = True
    except WriteError as exc:
        failure = WriteError(exc.rule, exc.field, candidate_created=created)
    except OSError:
        failure = WriteError("write_failed" if created else "target_unavailable", "target", candidate_created=created)
    finally:
        # Close each owned descriptor once. A failure after publication is a warning,
        # not an incomplete candidate; before publication preserve the primary error.
        for fd in (meta_fd, target_fd, parent_fd):
            if fd is None:
                continue
            try:
                os.close(fd)
            except OSError:
                if published:
                    warnings.append("cleanup_failed: target.descriptors")
                elif failure is None:
                    failure = WriteError("cleanup_failed", "target.descriptors", candidate_created=created)
    if failure is not None:
        raise failure from None
    return WriteResult(target_agent_dir, True, tuple(warnings))
