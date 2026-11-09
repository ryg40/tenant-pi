#!/usr/bin/env python3
"""Print the scoring progress of a skill-doctor run and the next unscored transcript.

Usage: next_unscored.py REPORT_DIR [TRANSCRIPT ...]

The collector writes each sampled transcript to REPORT_DIR/transcripts/<harness>-<id>.md,
and the first line of the transcript is "# Session <id>". A line of REPORT_DIR/scores.jsonl
scores a transcript when its "session_id" is that <id> (or the file name without ".md").
With TRANSCRIPT paths (the batch of one scorer), the script counts and names only those
transcripts; each path must be a file in REPORT_DIR/transcripts.

Output: "scored N of M", one "note:" line for each session ID (of the named transcripts,
with a list) with more than one line (the first line counts), then "next: <transcript path>" or "ALL SCORED".
Exit code 0 on that output; exit code 1 with one "error:" line when REPORT_DIR has no
transcripts folder, a TRANSCRIPT is not a file in it, scores.jsonl is not UTF-8, or a line
of scores.jsonl is not a JSON object with a "session_id" string.
"""
import json
import sys
from pathlib import Path

HEADING = "# Session "


def fail(message: str) -> None:
    print(f"error: {message}", file=sys.stderr)
    sys.exit(1)


def transcript_ids(path: Path) -> set:
    """The IDs that name this transcript: the heading ID and the file name."""
    ids = {path.stem}
    with path.open(encoding="utf-8", errors="replace") as handle:
        first = handle.readline().strip()
    if first.startswith(HEADING) and first[len(HEADING):].strip():
        ids.add(first[len(HEADING):].strip())
    return ids


def read_scored(scores: Path) -> list:
    """Session IDs of scores.jsonl in file order; stop on the first malformed line."""
    if not scores.exists():
        return []
    try:
        text = scores.read_text(encoding="utf-8")
    except UnicodeDecodeError as exc:
        fail(f"{scores} is not UTF-8 (byte {exc.start})")
    scored = []
    for number, line in enumerate(text.splitlines(), start=1):
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError as exc:
            fail(f"{scores} line {number} is not valid JSON ({exc.msg})")
        if not isinstance(record, dict) or not isinstance(record.get("session_id"), str) or not record["session_id"]:
            fail(f'{scores} line {number} has no "session_id" string')
        scored.append(record["session_id"])
    return scored


def main(argv=None) -> None:
    argv = sys.argv[1:] if argv is None else argv
    if not argv:
        fail("usage: next_unscored.py REPORT_DIR [TRANSCRIPT ...]")
    root = Path(argv[0]).expanduser()
    folder = root / "transcripts"
    if not folder.is_dir():
        fail(f"{folder} is not a folder; name the REPORT_DIR of the collector run")
    if argv[1:]:
        transcripts = []
        for name in argv[1:]:
            path = Path(name).expanduser()
            if path.resolve().parent != folder.resolve() or not path.is_file():
                fail(f"{name} is not a file in {folder}")
            transcripts.append(path)
        transcripts = sorted(set(transcripts))
    else:
        transcripts = sorted(folder.glob("*.md"))
    scored = read_scored(root / "scores.jsonl")
    seen = set(scored)

    ids = {t: transcript_ids(t) for t in transcripts}
    todo = [t for t in transcripts if not (ids[t] & seen)]
    print(f"scored {len(transcripts) - len(todo)} of {len(transcripts)}")
    named = set().union(*ids.values()) if argv[1:] else seen
    duplicates = sorted({sid for sid in seen & named if scored.count(sid) > 1})
    for sid in duplicates:
        print(f"note: session {sid} has {scored.count(sid)} lines; the first line counts")
    if todo:
        print(f"next: {todo[0]}")
    else:
        print("ALL SCORED")


if __name__ == "__main__":
    main()
