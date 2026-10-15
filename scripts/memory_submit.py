#!/usr/bin/env python3
"""Submit owner-reviewed memory candidates. Dry run is the default; AWS CLI runs only with --send."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from urllib.parse import urlsplit

MAX_TEXT = 16000
BATCH_SIZE = 100
ROOT = Path(__file__).resolve().parents[1]


class SubmitError(ValueError):
    """A static diagnostic; never echo candidate content or an AWS error."""


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=True, separators=(",", ":")).encode()).hexdigest()


def request_identifier(source, part):
    return digest([source, part])


def parse_candidates(text, form):
    if form == "json":
        try:
            records = json.loads(text)
        except ValueError:
            raise SubmitError("invalid candidate JSON") from None
    else:
        # A section starts with exactly two metadata lines and a blank line.
        sections = re.split(r"(?m)^## [^\n]*\n", text.replace("\r\n", "\n"))
        if len(sections) < 2:
            raise SubmitError("Markdown needs a record under each ## heading")
        if any(line.strip() and not line.startswith("# ") for line in sections[0].splitlines()):
            raise SubmitError("Markdown preamble must be empty or a # title")
        records = []
        for section in sections[1:]:
            lines = section.split("\n", 3)
            if len(lines) != 4 or not lines[0].startswith("source: ") or not lines[1].startswith("namespace: ") or lines[2].strip():
                raise SubmitError("Markdown header needs source, namespace, then a blank line")
            records.append({"source": lines[0][8:].strip(), "namespace": lines[1][11:].strip(), "text": lines[3].strip()})
    if not isinstance(records, list) or not records:
        raise SubmitError("candidates must be a nonempty list")
    return records


def valid_namespace(value):
    return (isinstance(value, str) and value.startswith("/") and value.endswith("/")
            and not any(c.isspace() or not c.isprintable() or c in "{}" for c in value))


def split_text(text):
    """Keep paragraph text intact. A paragraph too large to fit needs owner editing."""
    if len(text) <= MAX_TEXT:
        return [text]
    parts = []
    remaining = text
    while len(remaining) > MAX_TEXT:
        cut = remaining.rfind("\n\n", 0, MAX_TEXT + 2)
        if cut <= 0:
            raise SubmitError("a paragraph exceeds 16000 characters; split it before submitting")
        parts.append(remaining[:cut])
        remaining = remaining[cut + 2:]
    if remaining:
        parts.append(remaining)
    return parts


def prepare_records(candidates, allowed):
    if not allowed or not all(valid_namespace(ns) for ns in allowed):
        raise SubmitError("namespace allow list needs concrete slash-delimited namespaces")
    records, sources = [], set()
    for candidate in candidates:
        if not isinstance(candidate, dict) or set(candidate) != {"source", "namespace", "text"}:
            raise SubmitError("each candidate needs only source, namespace and text")
        source, namespace, text = (candidate[k] for k in ("source", "namespace", "text"))
        try:
            uri = urlsplit(source) if isinstance(source, str) else None
            if (not uri or not uri.scheme or not (uri.netloc or uri.path) or uri.username or uri.password
                    or any(c.isspace() or not c.isprintable() for c in source)):
                raise ValueError()
        except ValueError:
            raise SubmitError("source must be a URI without credentials or whitespace") from None
        if source in sources:
            raise SubmitError("duplicate source URI")
        sources.add(source)
        if not valid_namespace(namespace) or namespace not in allowed:
            raise SubmitError("candidate namespace is not allowed")
        if not isinstance(text, str) or not text.strip():
            raise SubmitError("candidate text must be nonempty")
        parts = split_text(text.strip())
        for part, content in enumerate(parts, 1):
            records.append({"source": source, "part": part,
                            "partSource": f"{source}#part-{part}" if len(parts) > 1 else source,
                            "namespace": namespace, "text": content,
                            "requestIdentifier": request_identifier(source, part)})
    return records


def ledger_path(path):
    path = Path(os.path.abspath(path))
    # No Git call is needed: repository writes are allowed only below ignored .local/.
    if path.is_relative_to(ROOT) and not path.is_relative_to(ROOT / ".local"):
        raise SubmitError("ledger cannot be in the tracked repository tree")
    for item in (path, *path.parents):
        if item.is_symlink():
            raise SubmitError("ledger path cannot contain a symbolic link")
    if path.exists() and not stat.S_ISREG(path.stat().st_mode):
        raise SubmitError("ledger must be a regular file")
    return path


def load_ledger(path, memory_id, region):
    if not path.exists():
        return {"schemaVersion": 1, "memoryId": memory_id, "region": region, "records": {}, "pending": None}
    try:
        ledger = json.loads(path.read_text(encoding="utf-8"))
        if (ledger["schemaVersion"] != 1 or ledger["memoryId"] != memory_id or ledger["region"] != region
                or not isinstance(ledger["records"], dict) or "pending" not in ledger):
            raise ValueError()
        for key, record in ledger["records"].items():
            if (not isinstance(record, dict) or not isinstance(record["source"], str)
                    or type(record["part"]) is not int or record["part"] < 1
                    or key != request_identifier(record["source"], record["part"])
                    or not isinstance(record["memoryRecordId"], str) or not record["memoryRecordId"]
                    or not valid_namespace(record["namespace"])):
                raise ValueError()
        if ledger["pending"] is not None and (not isinstance(ledger["pending"], dict)
                or not isinstance(ledger["pending"].get("batches"), list) or not ledger["pending"]["batches"]):
            raise ValueError()
    except (ValueError, KeyError, TypeError):
        raise SubmitError("ledger is invalid or belongs to another memory resource or region") from None
    return ledger


def batches(records, ledger, update=False, timestamp=None):
    timestamp = timestamp or datetime.now(timezone.utc).isoformat()
    groups = {"batch-create-memory-records": [], "batch-update-memory-records": []}
    current = {record["requestIdentifier"] for record in records}
    sources = {record["source"] for record in records}
    if update and any(old["source"] in sources and key not in current for key, old in ledger["records"].items()):
        raise SubmitError("update reduces the part count; review old records separately before submitting")
    for record in records:
        old = ledger["records"].get(record["requestIdentifier"])
        if old and old["namespace"] != record["namespace"]:
            raise SubmitError("namespace changes need a separate owner review; use a new source URI")
        if old and not update:
            continue
        body = {"namespaces": [record["namespace"]], "content": {"text": record["text"]}, "timestamp": timestamp}
        operation = "batch-create-memory-records"
        if old:
            operation = "batch-update-memory-records"
            body.update(memoryRecordId=old["memoryRecordId"], sourceNamespaces=[old["namespace"]])
        else:
            body["requestIdentifier"] = record["requestIdentifier"]
        groups[operation].append((record, body))
    result = []
    for operation, items in groups.items():
        for start in range(0, len(items), BATCH_SIZE):
            group = items[start:start + BATCH_SIZE]
            payload = {"memoryId": ledger["memoryId"], "records": [body for _, body in group]}
            if operation == "batch-create-memory-records":
                payload["clientToken"] = digest(payload)
            result.append({"operation": operation, "payload": payload, "items": [record for record, _ in group]})
    return result


def pending_batches(ledger, records, update):
    """Refuse edited journal content rather than sending data outside the reviewed file."""
    pending = ledger["pending"]
    if pending.get("fingerprint") != digest([records, update]):
        raise SubmitError("pending batch needs the same candidates and update mode")
    reviewed = {record["requestIdentifier"]: record for record in records}
    seen = set()
    try:
        for batch in pending["batches"]:
            if not 1 <= len(batch["items"]) <= BATCH_SIZE:
                raise ValueError()
            for item in batch["items"]:
                key = item["requestIdentifier"]
                if key in seen or item != reviewed[key]:
                    raise ValueError()
                seen.add(key)
            timestamp = batch["payload"]["records"][0]["timestamp"]
            if not isinstance(timestamp, str):
                raise ValueError()
            keys = {item["requestIdentifier"] for item in batch["items"]}
            subset = {**ledger, "records": {key: value for key, value in ledger["records"].items() if key in keys}}
            expected = batches(batch["items"], subset, update, timestamp=timestamp)
            if expected != [batch]:
                raise ValueError()
    except (KeyError, IndexError, TypeError, ValueError):
        raise SubmitError("pending batch differs from reviewed candidates or ledger") from None
    return pending["batches"]


def preview(batch):
    return {"operation": batch["operation"], "count": len(batch["items"]),
            "namespaces": sorted({item["namespace"] for item in batch["items"]}),
            "records": [{"source": item["partSource"], "part": item["part"], "namespace": item["namespace"],
                         "requestIdentifier": item["requestIdentifier"], "size": len(item["text"]),
                         "preview": item["text"][:80]} for item in batch["items"]]}


def save_ledger(path, ledger):
    fd, name = tempfile.mkstemp(prefix=".memory-ledger-", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(ledger, stream, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def aws_call(batch, region, directory, run):
    fd, name = tempfile.mkstemp(prefix=".memory-request-", suffix=".json", dir=directory)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as stream:
            json.dump(batch["payload"], stream)
        response = run(["aws", "bedrock-agentcore", batch["operation"], "--cli-input-json", "file://" + name,
                        "--region", region, "--output", "json", "--no-cli-pager"],
                       capture_output=True, text=True, timeout=120, check=False)
        if response.returncode:
            raise SubmitError("AWS CLI failed; pending batch retained for an exact retry")
        result = json.loads(response.stdout)
        if not isinstance(result, dict) or not isinstance(result.get("successfulRecords"), list) or not isinstance(result.get("failedRecords"), list):
            raise ValueError()
        return result
    except (OSError, subprocess.TimeoutExpired, ValueError) as exc:
        if isinstance(exc, SubmitError):
            raise
        raise SubmitError("AWS CLI response unavailable or invalid; pending batch retained") from None
    finally:
        os.unlink(name)


def settle(batch, response, ledger):
    creating = batch["operation"] == "batch-create-memory-records"
    lookup = {(item["requestIdentifier"] if creating else body["memoryRecordId"]): item
              for item, body in zip(batch["items"], batch["payload"]["records"])}
    accepted = {}
    seen = set()
    for status, entries in (("SUCCEEDED", response["successfulRecords"]), ("FAILED", response["failedRecords"])):
        for entry in entries:
            if not isinstance(entry, dict):
                raise SubmitError("invalid AWS record response; pending batch retained")
            key = entry.get("requestIdentifier") if creating else entry.get("memoryRecordId")
            if key not in lookup or key in seen or entry.get("status") != status:
                raise SubmitError("unmatched AWS record response; pending batch retained")
            seen.add(key)
            if status == "SUCCEEDED":
                record_id = entry.get("memoryRecordId")
                if not isinstance(record_id, str) or not record_id:
                    raise SubmitError("missing AWS record id; pending batch retained")
                item = lookup[key]
                accepted[item["requestIdentifier"]] = {k: item[k] for k in ("source", "part", "partSource", "namespace")}
                accepted[item["requestIdentifier"]].update(memoryRecordId=record_id, textHash=digest(item["text"]))
    if seen != set(lookup):
        raise SubmitError("incomplete AWS batch response; pending batch retained")
    ledger["records"].update(accepted)
    ledger["pending"] = None
    return bool(response["failedRecords"])


def submit(records, path, memory_id, region, update, run):
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    lock = path.with_name(path.name + ".lock")
    try:
        fd = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        raise SubmitError("ledger is locked; confirm no sender runs before removing a stale lock") from None
    os.close(fd)
    try:
        ledger = load_ledger(path, memory_id, region)
        fingerprint = digest([records, update])
        pending = ledger["pending"]
        if pending is not None:
            work = pending_batches(ledger, records, update)
        else:
            work = batches(records, ledger, update)
        while work:
            # Persist the exact timestamp and clientToken before any AWS call.
            ledger["pending"] = {"fingerprint": fingerprint, "batches": work}
            save_ledger(path, ledger)
            response = aws_call(work[0], region, path.parent, run)
            failed = settle(work[0], response, ledger)
            work = work[1:]
            if work and not failed:
                ledger["pending"] = {"fingerprint": fingerprint, "batches": work}
            save_ledger(path, ledger)
            if failed:
                raise SubmitError("some records failed; successful record ids saved; rerun after reviewing the failure")
        return ledger
    finally:
        lock.unlink()


def main(argv=None, *, run=subprocess.run, out=None):
    out = out or sys.stdout
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("--memory-id", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--namespace-allow", action="append", required=True)
    parser.add_argument("--ledger", type=Path, default=Path(".local/memory-submit-ledger.json"))
    parser.add_argument("--update", action="store_true")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--send", action="store_true", help="Confirm owner review and send the selected candidates")
    args = parser.parse_args(argv)
    try:
        if not args.memory_id.strip() or not re.fullmatch(r"[a-z]{2}(?:-[a-z]+)+-\d+", args.region):
            raise SubmitError("memory id and AWS region are required")
        path = ledger_path(args.ledger)
        if path == args.candidate.resolve():
            raise SubmitError("ledger and candidate paths must differ")
        form = "json" if args.candidate.suffix.lower() == ".json" else "markdown"
        records = prepare_records(parse_candidates(args.candidate.read_text(encoding="utf-8"), form), args.namespace_allow)
        ledger = load_ledger(path, args.memory_id, args.region)
        # Preflight all records before creating a directory or a pending request.
        work = batches(records, ledger, args.update)
        if args.send:
            submit(records, path, args.memory_id, args.region, args.update, run)
            print(json.dumps({"status": "submitted", "candidateParts": len(records)}), file=out)
        else:
            if ledger["pending"] is not None:
                work = pending_batches(ledger, records, args.update)
            for batch in work:
                print(json.dumps(preview(batch), sort_keys=True), file=out)
            if not work:
                print(json.dumps({"count": 0, "status": "already submitted"}), file=out)
    except (SubmitError, OSError, UnicodeError) as exc:
        message = str(exc) if isinstance(exc, SubmitError) else "candidate or ledger file is unavailable"
        print("memory-submit: " + message, file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
