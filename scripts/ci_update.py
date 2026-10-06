#!/usr/bin/env python3
"""Adapters for update jobs. Network writes occur only in the request action."""
import argparse
import base64
import json
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\Z")
NOTE_VERSION = re.compile(r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?\Z")
PACKAGE = "@earendil-works/pi-coding-agent@"


class Invalid(Exception):
    pass


def require(condition, code):
    if not condition:
        raise Invalid(code)


def version(value):
    require(isinstance(value, str) and VERSION.fullmatch(value), "update_version")
    return value


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path, value):
    Path(path).write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def run_stage(stage, arguments, directory, *, root=ROOT):
    """Never pass job tokens or provider keys to the update command or npm."""
    directory = Path(directory).resolve()
    directory.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ci-home-") as home:
        env = {"PATH": os.environ.get("PATH", os.defpath), "HOME": home,
               "TMPDIR": home, "LANG": "C.UTF-8", "PYTHONDONTWRITEBYTECODE": "1",
               "PI_OFFLINE": "1", "PI_SKIP_VERSION_CHECK": "1", "PI_TELEMETRY": "0"}
        with (directory / (stage + ".json")).open("wb") as out, (directory / (stage + ".log")).open("wb") as err:
            with subprocess.Popen([sys.executable, str(root / "scripts/pi_update.py"), stage, *arguments],
                                  cwd=root, env=env, stdin=subprocess.DEVNULL, stdout=out, stderr=err,
                                  start_new_session=True) as process:
                try:
                    return process.wait(timeout=3600)
                except subprocess.TimeoutExpired:
                    os.killpg(process.pid, signal.SIGKILL)
                    process.wait()
                    raise Invalid("update_timeout") from None


def detect(directory, *, root=ROOT):
    code = run_stage("detect", [], directory, root=root)
    require(code in (0, 10), "detect_failed")
    current = version(read_json(root / "config/manifest.json")["runtime"]["piVersion"])
    result = {"new": "false", "current": current, "version": current}
    if code == 10:
        data = read_json(Path(directory) / "detect.json")
        # A module-only update does not move the core pin.
        candidate = version(data["core"]["latest"])
        if candidate != current:
            result.update(new="true", version=candidate)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as stream:
            stream.write("".join(key + "=" + value + "\n" for key, value in result.items()))
    write_json(Path(directory) / "selection.json", result)
    return result


def notes_text(data):
    require(type(data.get("breaking")) is bool, "notes_shape")
    if isinstance(data.get("text"), str):
        return data["text"]
    entries = data.get("entries")
    require(isinstance(entries, list), "notes_shape")
    for entry in entries:
        require(isinstance(entry, dict) and isinstance(entry.get("text"), str), "notes_shape")
        label = entry.get("version")
        require(isinstance(label, str) and len(label) <= 80 and NOTE_VERSION.fullmatch(label), "update_version")
    return "\n\n".join("## " + entry["version"] + "\n\n" + entry["text"] for entry in entries)


def stage(action, directory, target, previous=None, *, root=ROOT):
    target = version(target)
    directory = Path(directory).resolve()
    receipt = directory / "receipt.json"
    if receipt.exists():
        receipt.unlink()
    arguments = (["--version", target] if action == "qualify" else ["--from", version(previous), "--to", target])
    # The update command refuses work directories inside the checkout.
    with tempfile.TemporaryDirectory(prefix="ci-update-work-") as work:
        arguments += ["--workdir", work]
        try:
            code = run_stage(action, arguments, directory, root=root)
        finally:
            for log in Path(work).glob("pi-update-*/logs/*.log"):
                if log.is_file() and not log.is_symlink():
                    destination = directory / "logs" / log.parent.parent.name / log.name
                    destination.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copyfile(log, destination)
    require(code == 0, action + "_failed")
    data = read_json(directory / (action + ".json"))
    if action == "notes":
        notes_text(data)
    write_json(directory / "receipt.json", {"action": action, "version": target, "passed": True})
    return {"action": action, "passed": True}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise Invalid("api_redirect")


class Api:
    def __init__(self, server, repository, token):
        parsed = urllib.parse.urlsplit(server)
        require(parsed.scheme == "https" and parsed.hostname and not parsed.username and not parsed.password
                and not parsed.query and not parsed.fragment, "api_url")
        require(re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repository or ""), "api_repository")
        require(bool(token), "api_token_missing")
        self.url = server.rstrip("/") + "/api/v1/repos/" + repository
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def __call__(self, method, path, body=None):
        data = None if body is None else json.dumps(body).encode()
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers={"Authorization": "token " + self.token,
                                                  "Content-Type": "application/json"})
        try:
            with self.opener.open(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            # Never echo the response, request URL, or a credential.
            code = "api_not_found" if exc.code == 404 else "api_failed"
            raise Invalid("api_conflict" if exc.code in (409, 422) else code) from None
        except urllib.error.URLError:
            raise Invalid("api_unavailable") from None


def open_request(api, branch):
    for page in range(1, 101):
        rows = api("GET", "/pulls?state=open&limit=50&page=" + str(page))
        require(isinstance(rows, list), "api_shape")
        for row in rows:
            if row.get("head", {}).get("ref") == branch:
                return row["number"]
        if not rows:
            return None
    raise Invalid("api_page_limit")


def preflight(directory, target, api):
    """Skip expensive stages for an existing request or a claimed version branch; GET only."""
    branch = "automation/pi-" + version(target)
    existing = open_request(api, branch)
    result = {"eligible": "false", "status": "existing"}
    if existing is not None:
        result["number"] = existing
    else:
        try:
            api("GET", "/branches/" + urllib.parse.quote(branch, safe=""))
        except Invalid as exc:
            if str(exc) != "api_not_found":
                raise
            result.update(eligible="true", status="available")
        else:
            result["status"] = "branch_claimed_review_required"
    Path(directory).mkdir(parents=True, exist_ok=True)
    write_json(Path(directory) / "preflight.json", result)
    output = os.environ.get("GITHUB_OUTPUT")
    if output:
        with open(output, "a", encoding="utf-8") as stream:
            stream.write("eligible=" + result["eligible"] + "\n")
    return result


def request(directory, target, previous, base, revision, api, *, root=ROOT):
    """Use atomic branch creation as a claim, not Gitea's version-dependent concurrency setting."""
    target, previous = version(target), version(previous)
    require(re.fullmatch(r"[0-9a-f]{40}", revision or ""), "source_revision")
    require(isinstance(base, str) and base and not base.startswith("-"), "source_branch")
    directory = Path(directory)
    for name in ("qualify", "notes"):
        receipt = read_json(directory / name / "receipt.json")
        require(receipt == {"action": name, "version": target, "passed": True}, "qualification_required")
    notes = read_json(directory / "notes/notes.json")
    text = notes_text(notes)
    require(len(text) <= 500000, "notes_size")
    branch = "automation/pi-" + target
    existing = open_request(api, branch)
    if existing is not None:
        return {"status": "existing", "number": existing}
    remote = api("GET", "/branches/" + urllib.parse.quote(base, safe=""))
    require(remote["commit"]["id"] == revision, "source_changed")
    files = []
    for path in ("config/manifest.json", "scripts/validate.py"):
        entry = api("GET", "/contents/" + path + "?ref=" + revision)
        content = base64.b64decode(entry["content"], validate=False).decode("utf-8")
        require(content == (root / path).read_text(encoding="utf-8"), "source_changed")
        if path.endswith(".json"):
            data = json.loads(content)
            require(data["runtime"]["piVersion"] == previous and
                    data["components"]["core"]["source"]["spec"] == PACKAGE + previous, "source_pin")
            data["runtime"]["piVersion"] = target
            data["components"]["core"]["source"]["spec"] = PACKAGE + target
            content = json.dumps(data, indent=2) + "\n"
        else:
            old = '"core": {"kind": "npm", "spec": "' + PACKAGE + previous + '"}'
            require(content.count(old) == 1, "source_anchor")
            content = content.replace(old, old.replace(PACKAGE + previous, PACKAGE + target))
        files.append({"operation": "update", "path": path, "sha": entry["sha"],
                      "content": base64.b64encode(content.encode()).decode()})
    # Exactly one concurrent caller can create this branch. A failed claim never proceeds to POST /pulls.
    try:
        api("POST", "/branches", {"new_branch_name": branch, "old_ref_name": revision})
    except Invalid as exc:
        if str(exc) != "api_conflict":
            raise
        existing = open_request(api, branch)
        if existing is not None:
            return {"status": "existing", "number": existing}
        raise Invalid("branch_claimed_review_required") from None
    api("POST", "/contents", {"branch": branch, "message": "ci: update Pi to " + target, "files": files})
    title = ("BREAKING: " if notes["breaking"] else "") + "Update Pi to " + target
    body = ("Breaking changes: " + ("YES" if notes["breaking"] else "no") + "\n\n" + text +
            "\n\nReview the pin-dependent test fixtures and run the offline checks before merge. "
            "This request does not approve or publish a release.\n")
    created = api("POST", "/pulls", {"head": branch, "base": base, "title": title, "body": body})
    return {"status": "created", "number": created["number"]}


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Invalid("update_arguments")


def main(argv=None):
    parser = Parser(description=__doc__)
    parser.add_argument("action", choices=("detect", "preflight", "qualify", "notes", "request"))
    parser.add_argument("--directory", required=True)
    try:
        args = parser.parse_args(argv)
        target, previous = os.environ.get("UPDATE_VERSION"), os.environ.get("UPDATE_FROM")
        if args.action == "detect":
            result = detect(args.directory)
        elif args.action in ("qualify", "notes"):
            result = stage(args.action, args.directory, target, previous)
        else:
            api = Api(os.environ.get("UPDATE_SERVER", ""), os.environ.get("UPDATE_REPOSITORY"),
                      os.environ.get("UPDATE_TOKEN"))
            if args.action == "preflight":
                result = preflight(args.directory, target, api)
            else:
                result = request(args.directory, target, previous, os.environ.get("UPDATE_BASE"),
                                 os.environ.get("UPDATE_REVISION"), api)
    except (Invalid, OSError, ValueError, KeyError, TypeError, subprocess.TimeoutExpired) as exc:
        print(json.dumps({"error": str(exc) if isinstance(exc, Invalid) else "update_adapter_failed"}, sort_keys=True))
        return 1
    print(json.dumps(result, sort_keys=True))
    return 1 if args.action == "preflight" and result["status"] == "branch_claimed_review_required" else 0


if __name__ == "__main__":
    sys.exit(main())
