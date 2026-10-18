#!/usr/bin/env python3
"""Snapshot the reviewed publish set from HEAD onto the `portable` branch and push it.

You can keep private notes in your source copy and publish only reviewed files.
This command takes the publish set from committed HEAD (never the working tree),
chains it onto the previous snapshot (or starts a new history with `--new-root`),
tags it, and pushes it to your chosen remote. It writes draft release notes to a
new system temporary file, or to the path given by `--notes`.

The snapshot commit and the tag carry a neutral identity and no signature, so that the
Git identity and the signing key of the publishing host do not leave with a snapshot.
"""
import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(ROOT / "scripts"))

from check import stamp_path  # noqa: E402
from publish_check import check, publish_files, tracked_files  # noqa: E402

DEFAULT_NAME = "tenant-pi portable"
DEFAULT_EMAIL = "portable@tenant-pi.invalid"
NAME_VARIABLE = "TENANT_PI_PUBLISH_NAME"
EMAIL_VARIABLE = "TENANT_PI_PUBLISH_EMAIL"
# A signature would carry the key identity of the host.
NO_SIGNATURE = ("-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "tag.forceSignAnnotated=false")


def git(*args, root=ROOT, env=None, check_call=True, input=None):
    result = subprocess.run(["git", *args], cwd=root, env=env, text=True, capture_output=True, input=input)
    if check_call and result.returncode != 0:
        raise SystemExit(f"git {' '.join(args)}: {result.stderr.strip()}")
    return result.stdout.strip()


def resolve_identity(name=None, email=None, environ=None):
    """(name, e-mail) of the snapshot commit and the tag: option, then variable, then default."""
    environ = os.environ if environ is None else environ
    name = environ.get(NAME_VARIABLE, DEFAULT_NAME) if name is None else name
    email = environ.get(EMAIL_VARIABLE, DEFAULT_EMAIL) if email is None else email
    if not name.strip():
        raise SystemExit(f"empty identity name: set --identity-name or {NAME_VARIABLE}, or unset both")
    if not email.strip():
        raise SystemExit(f"empty identity e-mail: set --identity-email or {EMAIL_VARIABLE}, or unset both")
    return name.strip(), email.strip()


def identity_env(identity):
    """The host environment with `identity` as author and committer (the tagger is the committer).

    `TZ=UTC` keeps the time zone offset of the host out of the commit date and the tag date.
    """
    name, email = identity
    return dict(os.environ, GIT_AUTHOR_NAME=name, GIT_AUTHOR_EMAIL=email,
                GIT_COMMITTER_NAME=name, GIT_COMMITTER_EMAIL=email, TZ="UTC")


def check_snapshot_branch(root, branch):
    """Reserve snapshot updates for the portable namespace, never a checked-out branch."""
    git("check-ref-format", f"refs/heads/{branch}", root=root)
    if not (branch == "portable" or branch.startswith(("portable-", "portable/"))):
        raise SystemExit("snapshot branch must be named portable, portable-* or portable/*")
    worktrees = git("worktree", "list", "--porcelain", "-z", root=root).split("\0")
    if f"branch refs/heads/{branch}" in worktrees:
        raise SystemExit("snapshot branch is checked out in a worktree")


def snapshot(root, paths, source_ref, branch, *, message, identity=None, new_root=False, tag=None):
    """Write a commit on `branch` whose tree is exactly `paths` as they are in `source_ref`.

    Returns (commit, tree, changed). Uses a temporary index; the working tree is untouched.
    With `tag`, the branch and annotated tag refs update in one transaction, or neither updates.
    The commit carries `identity` (default: `resolve_identity()`) and no signature.
    With `new_root` the commit has no parent, also when its tree equals the previous snapshot:
    `branch` starts a new history, and no earlier snapshot is an ancestor of it.
    """
    identity = resolve_identity() if identity is None else identity
    check_snapshot_branch(root, branch)
    if tag is not None:
        git("check-ref-format", f"refs/tags/{tag}", root=root)
    with tempfile.TemporaryDirectory(prefix="tenant-pi-portable-") as temp:
        env = dict(os.environ, GIT_INDEX_FILE=str(Path(temp) / "index"))
        git("read-tree", "--empty", root=root, env=env)
        for path in sorted(paths):
            entry = git("ls-tree", source_ref, "--", path, root=root)
            if not entry:
                raise SystemExit(f"missing in {source_ref}: {path}")
            mode, kind, blob = entry.split("\t", 1)[0].split()
            if kind != "blob" or mode not in ("100644", "100755"):
                raise SystemExit(f"not a regular file in {source_ref}: {path}")
            git("update-index", "--add", "--cacheinfo", f"{mode},{blob},{path}", root=root, env=env)
        tree = git("write-tree", root=root, env=env)
    parent = git("rev-parse", "--verify", "--quiet", f"refs/heads/{branch}^{{commit}}", root=root, check_call=False)
    if parent and not new_root and git("rev-parse", f"{parent}^{{tree}}", root=root) == tree:
        return parent, tree, False
    args = ["commit-tree", tree, "-m", message] + (["-p", parent] if parent and not new_root else [])
    commit = git(*NO_SIGNATURE, *args, root=root, env=identity_env(identity))
    # Create objects first, then publish both refs atomically with an expected old branch value.
    tag_update = ""
    if tag is not None:
        tagger = git("var", "GIT_COMMITTER_IDENT", root=root, env=identity_env(identity))
        tag_object = git("mktag", root=root,
                         input=f"object {commit}\ntype commit\ntag {tag}\ntagger {tagger}\n\n{message}\n")
        tag_update = f"create refs/tags/{tag} {tag_object}\n"
    branch_update = (f"update refs/heads/{branch} {commit} {parent}\n" if parent
                     else f"create refs/heads/{branch} {commit}\n")
    check_snapshot_branch(root, branch)
    git("update-ref", "--stdin", root=root, input="start\n" + branch_update + tag_update + "prepare\ncommit\n")
    return commit, tree, True


def push_command(remote, branch, remote_branch, tags=(), *, force=False):
    """Arguments of the push: the branch ref and each tag ref of this snapshot by name, no other ref.

    The portable push rule permits explicit refs only, so the command has no option that follows tags.
    `tags` holds the `portable/*` tags that point at the snapshot commit. After a build with
    `--no-push` the next run makes no new tag, and the tag of the earlier build is in this list.
    """
    command = ["push", remote, f"refs/heads/{branch}:refs/heads/{remote_branch}"]
    command.extend(f"refs/tags/{tag}:refs/tags/{tag}" for tag in tags)
    if force:
        command.append("--force-with-lease")
    return command


SNAPSHOT_TAG = re.compile(r"portable/[0-9]{8}-[0-9a-f]{7}")


def snapshot_tags(root, commit):
    """Tags of the form `portable/<yyyymmdd>-<source sha>` that point at `commit`, sorted.

    A tag with another name on the same commit is not a snapshot tag, and the push does not send it.
    """
    names = git("tag", "--points-at", commit, "--list", "portable/*", root=root).split()
    return sorted(name for name in names if SNAPSHOT_TAG.fullmatch(name))


def publish_tracked(root, ref):
    """Tracked paths of `ref`; stop when Git gives none, because a directory rule needs them."""
    tracked = tracked_files(root, ref)
    if tracked is None:
        raise SystemExit("publish_tracked: git metadata required")
    return tracked


def stamp_record(root):
    """Read the evidence lines without turning an unrun gate into a passed gate."""
    tree = git("rev-parse", "HEAD^{tree}", root=root)
    try:
        stamp = json.loads(stamp_path(root, tree).read_text(encoding="utf-8"))
        return [f"tree: {tree}", f"when: {stamp['when']}",
                f"client: {json.dumps(stamp['client'], sort_keys=True)}",
                f"skipped: {stamp['skipped']}", "resultLines:", *stamp["resultLines"]]
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit("matching stamp could not be read") from error


def release_tags(root):
    """Newest annotated snapshot tags first; old tags without a class are full releases."""
    names = git("for-each-ref", "--sort=-refname", "--sort=-taggerdate",
                "--format=%(refname:short)", "refs/tags/portable/", root=root).splitlines()
    records = []
    for name in names:
        message = git("for-each-ref", "--format=%(contents)", f"refs/tags/{name}", root=root)
        source = re.search(r"^Portable snapshot of ([0-9a-f]{7,40})\b", message, re.MULTILINE)
        if not source:
            continue
        classes = re.findall(r"^class:[ \t]*(.*?)[ \t]*$", message, re.MULTILINE)
        if classes and classes not in (["patch"], ["full"]):
            raise SystemExit(f"invalid release class in tag {name}")
        records.append((name, classes[0] if classes else "full", source.group(1)))
    return records


def release_notes(root, tag, source, commit, release_class, tags, record, scan):
    """Render the known evidence and leave all other checks for the maintainer."""
    runtime = json.loads(git("show", f"{source}:config/manifest.json", root=root))["runtime"]
    previous = tags[0] if tags else None
    last_full = next((name for name, kind, _ in tags if kind == "full"), "<no full tag recorded>")
    revisions = f"{previous[2]}..{source}" if previous else source
    changes = git("log", revisions, "--merges", "--format=%s", root=root).splitlines()
    lines = [f"# Portable release: {release_class}", "", f"- Tag: {tag}",
             f"- Source commit: {source}", f"- Snapshot commit: {commit}",
             f"- Kind of release: {release_class} release",
             f"- Pi pin (runtime.piVersion): {runtime['piVersion']}"]
    if release_class == "full":
        lines += [f"- Accepted range (runtime.piAcceptedRange): {runtime['piAcceptedRange']}",
                  "- Qualification: <full qualification, or fast track: gate 6 not run, approved by the maintainer>"]
    lines += ["", "## Gates", "", "1. The check set (stamp record)",
              *[f"   - {line}" for line in record], "5. Scanner",
              *[f"   - Snapshot range: {line}" for line in scan]]
    if release_class == "patch":
        lines += [f"Gates 6-8: unchanged from {last_full}"]
    else:
        lines += ["   - scan.sh all: <passed, failed, blocked or not run> - <result line with the level>",
                  "6. Clean Linux core trial: <passed, failed, blocked or not run> - <result line>",
                  "7. Optional live services (one line for each, no total result)",
                  "   - <module, route or service>: <passed, failed, blocked or not run> - <result line>",
                  "8. Compose seat (no total result): config <passed, failed or not run>, "
                  "build <passed, failed or not run>, table check <passed, failed or not run>"]
    lines += ["", f"## Changes since {previous[0] if previous else '<first snapshot>'}", "",
              *[f"- {change}" for change in changes]]
    if release_class == "full":
        lines += ["", "Platforms that are not qualified: "
                  "<full URL of docs/guides/release-checklist.md at the tag>#platforms-that-are-not-qualified"]
    lines += ["", "## Known defects", "", "<none recorded>"]
    if release_class == "full":
        lines += ["", "## Open gaps", "", "- <gap, or none known>"]
    return "\n".join(lines) + "\n"


def push_snapshot(root, command):
    """Keep the hook's evidence, including stderr and a refused push."""
    result = subprocess.run(["git", *command], cwd=root, text=True, capture_output=True)
    lines = [line for line in (result.stdout + "\n" + result.stderr).splitlines()
             if re.fullmatch(r"pre-push: result (?:pass|fail); range .+; level .+", line)]
    for line in lines:
        print(line, flush=True)
    if not lines:
        lines = ["not recorded (no pre-push result line)"]
    return result, lines


def check_set(root):
    """Reuse a matching full-run stamp, or require a successful full check set."""
    command = [sys.executable, "scripts/check.py"]
    env = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")
    status = subprocess.run([*command, "--stamp-status"], cwd=root, env=env,
                            text=True, capture_output=True)
    if status.returncode == 0:
        lines = stamp_record(root)
        print("stamp: matches", flush=True)
        print("\n".join(lines), flush=True)
        return lines
    print("stamp: missing or stale; running the full check set", flush=True)
    result = subprocess.run(command, cwd=root, env=env, text=True, capture_output=True)
    print(result.stdout, end="", flush=True)
    if result.stderr:
        print(result.stderr, end="", file=sys.stderr)
    if result.returncode != 0 or result.stdout.splitlines()[-1:] != ["check: passed"]:
        raise SystemExit("check set failed; no snapshot built")
    return stamp_record(root)


def check_pages(root):
    """Compare public pages without writing them, independently of a check-set stamp."""
    for builder, page in (("architecture_build.py", "docs/architecture.html"),
                          ("explainer_build.py", "EXPLAINER.html")):
        result = subprocess.run([sys.executable, f"scripts/{builder}", "--check"], cwd=root,
                                env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
                                text=True, capture_output=True)
        if result.returncode:
            reason = "stale" if result.returncode == 1 else "check failed"
            detail = result.stderr.splitlines()
            suffix = f"; {detail[0]}" if detail else ""
            raise SystemExit(f"page {reason}: {page}{suffix}")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--remote", default="github", help="git remote that receives the portable branch")
    parser.add_argument("--remote-branch", default="main", help="branch name on the remote")
    parser.add_argument("--branch", default="portable", help="local snapshot branch: portable, portable-* or portable/*")
    parser.add_argument("--no-push", action="store_true", help="build and tag only")
    parser.add_argument("--class", dest="release_class", choices=("patch", "full"), default="patch",
                        help="release class (default: patch)")
    parser.add_argument("--notes", type=Path, help="notes output path (default: a new system temporary file)")
    parser.add_argument("--force", action="store_true",
                        help="replace the remote branch, including an existing snapshot chain; uses --force-with-lease")
    parser.add_argument("--new-root", action="store_true",
                        help="start a new history: the snapshot commit has no parent; needs --no-push")
    parser.add_argument("--identity-name", default=None,
                        help=f"name on the snapshot commit and the tag (default: {NAME_VARIABLE} or '{DEFAULT_NAME}')")
    parser.add_argument("--identity-email", default=None,
                        help=f"e-mail on the snapshot commit and the tag (default: {EMAIL_VARIABLE} or '{DEFAULT_EMAIL}')")
    args = parser.parse_args(argv)
    identity = resolve_identity(args.identity_name, args.identity_email)
    if args.new_root and not args.no_push:
        raise SystemExit("--new-root needs --no-push: the push of a new history is a separate, manual step")

    if args.notes is not None:
        notes_path = args.notes.absolute()
        if any(path.is_relative_to(ROOT.resolve()) for path in (notes_path, notes_path.resolve())):
            raise SystemExit("--notes must be outside the checkout")

    if git("status", "--porcelain", "--untracked-files=all"):
        raise SystemExit("working tree not clean: commit or stash first; the snapshot comes from HEAD only")
    head = git("rev-parse", "HEAD")
    short = head[:7]
    check_pages(ROOT)
    record = check_set(ROOT)
    tags_before = release_tags(ROOT)
    names = check()
    print(f"check ok: publish set ({len(names)} files)")
    date = datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%d")
    message = (f"Portable snapshot of {short} ({date})\n\nclass: {args.release_class}\n\n"
               f"Exactly the reviewed publish set from scripts/publish_check.py at\n"
               f"source commit {head}. Only reviewed files are included.\n")
    previous = git("rev-parse", "--verify", "--quiet", f"refs/heads/{args.branch}^{{commit}}", check_call=False)
    tag = f"portable/{date.replace('-', '')}-{short}"
    commit, tree, changed = snapshot(ROOT, publish_files(publish_tracked(ROOT, head), root=ROOT, ref=head),
                                     head, args.branch, message=message, identity=identity,
                                     new_root=args.new_root, tag=tag)
    if args.new_root and previous:
        print(f"new root: {args.branch} was {previous}; earlier local tags and other refs stay unchanged")
    if changed:
        print(f"portable commit {commit[:7]} (tree {tree[:7]}), tag {tag}")
    else:
        print(f"no change: portable branch already holds tree {tree[:7]} (commit {commit[:7]})")
    tags = snapshot_tags(ROOT, commit)
    if not changed:
        existing = next((entry for entry in tags_before if entry[0] in tags), None)
        if existing is None:
            raise SystemExit("unchanged snapshot has no release tag; no notes or push")
        tag, release_class, source = existing
        differences = []
        if release_class != args.release_class:
            differences.append("class")
        if git("rev-parse", source, root=ROOT) != head:
            differences.append("source")
        if differences:
            raise SystemExit(f"unchanged snapshot has a different {' and '.join(differences)}; no notes or push")
        tags_before = [entry for entry in tags_before if entry[0] != tag]
    # Render before the push so missing source metadata cannot cause a publication without notes.
    notes = release_notes(ROOT, tag, head, commit, args.release_class, tags_before, record,
                          ["not run (no push)"])
    if args.notes is None:
        descriptor, path = tempfile.mkstemp(prefix="tenant-pi-release-", suffix=".md")
        os.close(descriptor)
        args.notes = Path(path)
    args.notes.write_text(notes, encoding="utf-8")
    if not args.no_push:
        push = push_command(args.remote, args.branch, args.remote_branch, tags, force=args.force)
        result, scan = push_snapshot(ROOT, push)
        args.notes.write_text(release_notes(ROOT, tag, head, commit, args.release_class, tags_before, record, scan),
                              encoding="utf-8")
        print(f"notes: {args.notes}", flush=True)
        if result.returncode:
            detail = "\n".join(part.strip() for part in (result.stdout, result.stderr) if part.strip())
            raise SystemExit(f"push failed: {detail}")
        print(f"pushed {args.branch} to {args.remote}/{args.remote_branch}" + "".join(f", tag {tag}" for tag in tags))
    else:
        print(f"notes: {args.notes}", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
