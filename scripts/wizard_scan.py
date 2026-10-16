"""Bounded version-only local scan. No profile, credential or vault file is opened."""
import os
import pwd
import select
import shutil
import signal
import subprocess
import tempfile
import time
from pathlib import Path

from scripts.check_runtime import check, check_herdr
from scripts.validate import fail


def local_identity(identity):
    if identity["destination"] != "local":
        fail("remote_scan_required", "wizard.identity")
    if pwd.getpwuid(os.geteuid()).pw_name != identity["account"]:
        fail("account_mismatch", "wizard.identity")
    if os.stat(identity["home"]).st_uid != os.geteuid():
        fail("home_owner_mismatch", "wizard.identity")


def bounded_run(argv, **kwargs):
    """Cap both output pipes and kill the whole probe group on timeout or excess output."""
    # The caller replaces HOME and removes inherited credentials and Node injection options.
    process = subprocess.Popen(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, env=kwargs["env"], start_new_session=True,
                               cwd=kwargs["env"]["HOME"])
    output = {process.stdout: bytearray(), process.stderr: bytearray()}
    pending = list(output)
    deadline = time.monotonic() + 5
    try:
        while pending:
            if time.monotonic() >= deadline:
                raise subprocess.TimeoutExpired(argv, 5)
            ready, _, _ = select.select(pending, [], [], min(0.1, deadline - time.monotonic()))
            for pipe in ready:
                chunk = os.read(pipe.fileno(), 513)
                output[pipe].extend(chunk)
                if len(output[pipe]) > 512:
                    raise OSError("probe_output_limit")
                if not chunk:
                    pending.remove(pipe)
        process.wait(timeout=max(0.01, deadline - time.monotonic()))
        return subprocess.CompletedProcess(argv, process.returncode, bytes(output[process.stdout]), bytes(output[process.stderr]))
    finally:
        # Kill descendants too, including a child that closed its output pipes early.
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        process.wait()
        process.stdout.close()
        process.stderr.close()


def scan(identity, manifest_data):
    local_identity(identity)
    path = os.environ.get("PATH", os.defpath)
    # No full environ copy: credential values never enter a probe environment.
    with tempfile.TemporaryDirectory(prefix="tenant-pi-wizard-scan-") as empty:
        env = {"PATH": path, "HOME": empty, "LANG": "C", "PI_CODING_AGENT_DIR": empty,
               "PI_CODING_AGENT_SESSION_DIR": empty}
        def run(argv, **kwargs):
            try:
                return bounded_run(argv, **kwargs)
            except PermissionError:
                # A failed probe is unknown, not evidence of absence.
                return subprocess.CompletedProcess(argv, 1, b"", b"")
        runtime = check(manifest_data["runtime"], run=run, environ=env,
                        which=lambda command: shutil.which(command, path=path))
        herdr = check_herdr(run=run, environ=env, which=lambda command: shutil.which(command, path=path))
    translate = {"match": "compatible", "untested_in_range": "compatible", "missing": "missing",
                 "unparsed": "unknown", "mismatch": "incompatible", "present": "present"}
    found = {}
    for cid, item in manifest_data["components"].items():
        source = item["source"]
        if cid == "core":
            found[cid] = translate[runtime["pi"]["status"]]
        elif cid == "herdr":
            found[cid] = translate[herdr["herdr"]["status"]]
        elif source and source["kind"] == "builtin":
            found[cid] = translate[runtime["pi"]["status"]]
        elif source and source["kind"] == "tree":
            # Presence of kit resources does not prove that a profile loads them.
            found[cid] = "present" if Path(identity["clone"], source["path"]).is_dir() else "missing"
        else:
            found[cid] = "unknown"
    return {"schemaVersion": 1, "identity": identity, "runtime": runtime, "components": found,
            "targetAbsent": not os.path.lexists(identity["target"])}
