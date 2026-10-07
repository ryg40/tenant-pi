#!/usr/bin/env python3
"""Check the explicit foundation publish set; never traverse private inputs."""
import hashlib
import os
import re
import subprocess
import sys
from pathlib import Path

from validate import ROOT, Invalid, load, manifest, overlay, fail
from examples import render

# Exact paths, not extensions or a recursive glob. Update only after source review.
PUBLISH = (
    ".gitea/workflows/pi-update.yml",
    ".gitea/workflows/checks.yml",
    ".github/workflows/checks.yml",
    "scripts/ci_update.py",
    "tests/test_ci_workflows.py",
    "docs/ci.md",
    ".gitignore", ".env.example", "README.md", "LICENSE", "packages/promptr/LICENSE",
    "packages/openviking-pi/LICENSE",
    "packages/tenantext/extensions/doctor/wiki.ts",
    "packages/tenantext/test/doctor-wiki.test.ts",
    "packages/promptr/src/herdr/adapter.mts",
    "packages/promptr/src/herdr/role-handoff.mts",
    "packages/promptr/src/state/run-receipts.mts",
    "packages/promptr/docs/herdr-handoff.md",
    "packages/promptr/test/herdr/handoff.test.mjs",
    "packages/promptr/test/herdr/fixtures/agent-get.json",
    "packages/promptr/test/herdr/fixtures/agent-list.json",
    "packages/promptr/test/herdr/fixtures/agent-prompt-wait.json",
    "packages/promptr/test/herdr/fixtures/agent-wait.json",
    "INSTALL.md", "EXPLAINER.md", "config/manifest.json",
    "config/config.example.json", "scripts/validate.py", "scripts/examples.py",
    "scripts/publish_check.py", "scripts/capture.py", "scripts/install.py",
    "tests/test_contract.py", "tests/test_profile_plan.py",
    "docs/profile-plan.md", "scripts/profile_plan.py", "scripts/profile_write.py",
    "tests/test_profile_write.py", "docs/profile-write.md", "scripts/tenant_pi.py",
    "tests/test_cli.py", "docs/generator.md", "scripts/model_routes.py",
    "tests/test_model_routes.py", "docs/model-routes.md", "scripts/patch_extension_peers.mjs",
    "scripts/pi_npm_wrapper.sh", "extensions/peer-override-reminder.ts",
    "tests/test_peer_overrides.py", "docs/host-peer-overrides.md", "scripts/candidate_compare.py",
    "tests/test_candidate_compare.py", "docs/candidate-compare.md", "scripts/memory_modules.py",
    "tests/test_memory_modules.py", "docs/memory-modules.md", "skills/tenant-pi-install/SKILL.md",
    "scripts/publish_portable.py", "tests/test_publish_portable.py", "docs/publishing.md",
    "scripts/workflow_modules.py", "tests/test_workflow_modules.py", "docs/workflow-modules.md",
    "scripts/scan.sh", ".gitleaks.toml", "scripts/host-values.deny", "scripts/host-values.allow",
    "scripts/host-values.regex", "scripts/host-values.allow-lines", "scripts/install-hooks.sh", "scripts/git-hooks/dispatch",
    "scripts/git-hooks/pre-commit", "scripts/git-hooks/pre-merge-commit",
    "scripts/git-hooks/pre-push", "tests/test_scan.sh", "tests/test_publish_rules.py",
    "docs/secret-handling.md", "docs/packages.md", "docs/resources.md",
    "docs/profile-lifecycle.md",
    "scripts/profile_inventory.py", "tests/test_profile_inventory.py", "docs/profile-inventory.md",
    "scripts/check_runtime.py", "tests/test_check_runtime.py", "docs/check-runtime.md",
    "tests/test_owner_packages.py", "docs/owner-packages.md",
    "tests/test_unmanaged.py", "docs/accepted-drift.md",
    "tests/test_owner_resources.py", "docs/owner-resources.md",
    "scripts/private_init.py", "tests/test_private_init.py", "docs/private-directory.md",
    "scripts/carry.py", "tests/test_carry.py", "docs/carry.md",
    "config/private/registry.json", "config/private/install-log.md", "config/private/accepted-drift.md",
    "config/private/gitignore",
    "scripts/launcher.py", "tests/test_launcher.py", "docs/launcher.md",
    "scripts/candidate_list.py", "tests/test_candidate_list.py", "docs/candidate-list.md",
    "scripts/pi_update.py",
    "tests/test_pi_update.py",
    "docs/pi-update.md",
    "scripts/kit_commit.py", "tests/test_kit_commit.py",
    "scripts/baseline.py", "tests/test_baseline.py", "docs/directory-baseline.md",
    "scripts/doc_check.py", "tests/test_doc_check.py", "docs/guides/setup.md", "docs/guides/modules.md",
    "docs/guides/troubleshooting.md", "docs/guides/privacy.md", "docs/guides/candidate-update.md",
    "docs/guides/release-checklist.md", "docs/guides/pin-move-release.md",
    "AGENTS.md", "GLOSSARY.md", "docs/agents/issue-tracker.md",
    "tests/test_skill_invariants.py", "tests/test_knowledge_skills.py",
)
# Package directory rules: (directory, technical excludes relative to that directory).
# Private-copy exclusions belong in the optional list, not in published source text.
PUBLISH_DIRS = (
    ("packages/tenantext", ("node_modules/", "extensions/doctor/wiki.ts", "test/doctor-wiki.test.ts")),
    # The license is explicit in PUBLISH, so the directory rule must not add it again.
    ("packages/promptr", ("node_modules/", "dist/", "LICENSE",
        "src/herdr/adapter.mts", "src/herdr/role-handoff.mts", "src/state/run-receipts.mts",
        "docs/herdr-handoff.md", "test/herdr/handoff.test.mjs",
        "test/herdr/fixtures/agent-get.json", "test/herdr/fixtures/agent-list.json",
        "test/herdr/fixtures/agent-prompt-wait.json", "test/herdr/fixtures/agent-wait.json")),
    # A vendored copy. Its `shared/` directory is committed source, not build output.
    ("packages/openviking-pi", ("node_modules/", "LICENSE")),
)
# Optional list of repository-relative files or directory prefixes ending in "/".
# The list excludes itself. A portable copy has neither the list nor its excluded files.
DEV_ONLY_REL = "scripts/dev-only-files.txt"
PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----"),
    re.compile(r"(?i)(?:api[_-]?key|bearer|token|password)\s*[:=]\s*['\"]?[A-Za-z0-9_./+-]{20,}"),
)
# Reviewed lines that match PATTERNS but hold no secret: (path, exact line text without the
# line end). A match is dropped only when the line of that file is exactly this text.
# The exception is the exact line text, not a line number: each copy of the text in that
# file is dropped. Add an entry only after review; a changed line is a new finding.
# This file is in the publish set too, so each text is split where PATTERNS would match.
PATTERN_ALLOW = (
    # A reference to the environment variable name, not a value (Tenantext codex-accounts).
    ("packages/tenantext/extensions/codex-accounts/routing.ts",
     '\t\treturn { baseUrl: url.toString().replace(/\\/$/, ""), apiKey: '
     'env.TENANTEXT_LITELLM_API_KEY ? "$TENANTEXT_LITELLM_API_KEY" : undefined };'),
    # A canary fixture of the Tenantext tracker publish test, not a token.
    ("packages/tenantext/tracker/tests/test_publish.py", 'BEARER = ' '"CANARY-BEARER-TOKEN-51d0"'),
    # A property that says whether a key is set, and a variable name; no value (vendored OpenViking extension).
    ("packages/openviking-pi/shared/credentials.mjs", '    hasApiKey: ' 'connection.hasApiKey,'),
    ("packages/openviking-pi/shared/plugin-config.mjs", '    hasApiKey: ' 'connection.hasApiKey,'),
    ("packages/openviking-pi/tests/config.test.mjs", '    OPENVIKING_API_KEY: ' 'process.env.OPENVIKING_API_KEY,'),
)

# Public reader rules: content that a reader of your published copy must not get
# (docs/publishing.md, "Public reader rules"). One (rule name, regular expression) pair for
# each class that a pattern can find. This file is in the publish set too, so each
# expression is written in a form that does not match its own source text, and no comment
# of this file gives an example of a match.
PUBLIC_RULES = (
    # A reference to an entry of a private tracker: the word for an issue or a ticket, then a
    # number; a planning map with a number; a decision with a letter code.
    ("tracker-reference", re.compile(
        r"(?i)\b(?:(?:issue|ticket)s?[ \t]+#?[0-9]+|map[ \t]+[0-9]{1,3}\b(?![.,]?[0-9])|decision[ \t]+[A-Z][0-9]+)\b")),
    # A path of the home directory of the administrator or of a stack layout of one host.
    ("machine-path", re.compile(r"(?<![A-Za-z0-9_.~-])/(?:root|opt/" r"stacks)(?:/|\b)")),
    # A record of work on one host: the phrase for the one reference machine; a record word and a
    # date in one line; a date and a phrase for one host in one line, in each order.
    ("host-record", re.compile(
        r"(?i)\b(?:reference[ \t]+host\b"
        r"|(?:observ(?:ed|ation)|verified|seen|decision|decided|approved|accepted)\b[^\n]{0,60}?\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b"
        r"|20[0-9]{2}-[0-9]{2}-[0-9]{2}\b[^\n]{0,80}?\b(?:this|live|lab|test)[ \t]+(?:host|vm)\b"
        r"|(?:this|live|lab|test)[ \t]+(?:host|vm)\b[^\n]{0,80}?\b20[0-9]{2}-[0-9]{2}-[0-9]{2}\b)")),
)
# Path prefixes that the public reader rules do not check yet. The whole publish set is
# checked when this tuple is empty. `--public` always reports on the whole publish set.
PUBLIC_PENDING = ()
# The lists of scripts/scan.sh (docs/secret-handling.md), relative to the repository root.
DENY_REL, LOCAL_DENY_REL = "scripts/host-values.deny", ".local/host-values.deny"
ALLOW_REL, ALLOW_LINES_REL = "scripts/host-values.allow", "scripts/host-values.allow-lines"


def _list_lines(path):
    """The entries of one list file: stripped lines, without comments and empty lines."""
    try:
        text = Path(path).read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return []
    return [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]


def local_deny_file(root=ROOT):
    """The path of the local deny list, as scripts/scan.sh finds it, or None.

    `SCAN_LOCAL_DENY` names the file. Else it is `.local/host-values.deny` of the checkout,
    or of the main checkout for a linked worktree. A clone of the portable mirror has none.
    """
    named = os.environ.get("SCAN_LOCAL_DENY")
    if named:
        return Path(named) if Path(named).is_file() else None
    own = Path(root) / LOCAL_DENY_REL
    if own.is_file():
        return own
    common = subprocess.run(["git", "rev-parse", "--git-common-dir"], cwd=root, text=True, capture_output=True)
    if common.returncode == 0 and common.stdout.strip():
        git_dir = (Path(root) / common.stdout.strip()).resolve()
        if git_dir.name == ".git" and (git_dir.parent / LOCAL_DENY_REL).is_file():
            return git_dir.parent / LOCAL_DENY_REL
    return None


def deny_rules(root=ROOT):
    """(rule id, literal pattern) for each line of the tracked and of the local deny list.

    The rule ids are the ids of scripts/scan.sh: `host-value-<n>` and `host-value-local-<n>`.
    """
    rules = [(f"host-value-{n}", pattern) for n, pattern in enumerate(_list_lines(Path(root) / DENY_REL), 1)]
    local = local_deny_file(root)
    if local is not None:
        rules += [(f"host-value-local-{n}", pattern) for n, pattern in enumerate(_list_lines(local), 1)]
    return rules


def accepted_lines(root=ROOT):
    """The (path, sha256 of the exact line text) pairs of scripts/host-values.allow-lines."""
    pairs = set()
    for line in _list_lines(Path(root) / ALLOW_LINES_REL):
        path, _, digest = line.partition("\t")
        pairs.add((path, digest))
    return pairs


def public_findings(names, root=ROOT, deny=None, allow=None, accepted=None):
    """Sorted (path, line number, rule id) for each public reader finding in the files `names`.

    A finding is a match of `PUBLIC_RULES`, or a deny-list pattern (a literal, any case). As in
    scripts/scan.sh: a deny-list pattern that is only inside an exact URL of the allow list is
    dropped, a deny list is not searched for its own patterns, and a line whose path and hash
    are in the accepted lines gives no finding. A finding never holds text of the file.
    """
    deny = deny_rules(root) if deny is None else deny
    allow = _list_lines(Path(root) / ALLOW_REL) if allow is None else allow
    accepted = accepted_lines(root) if accepted is None else accepted
    lowered = [(rule, pattern.lower()) for rule, pattern in deny]
    found = []
    for name in names:
        text = (Path(root) / name).read_bytes().decode("utf-8", "replace")
        for number, line in enumerate(text.split("\n"), 1):
            rules = [rule for rule, pattern in PUBLIC_RULES if pattern.search(line)]
            if lowered and name not in (DENY_REL, LOCAL_DENY_REL):
                outside = line
                for url in allow:
                    outside = outside.replace(url, "\x01")
                outside = outside.lower()
                rules += [rule for rule, pattern in lowered if pattern in outside]
            if rules and (name, hashlib.sha256(line.encode("utf-8", "surrogatepass")).hexdigest()) not in accepted:
                found += [(name, number, rule) for rule in rules]
    return sorted(found)


def private_excludes(root=None, ref=None):
    """Read optional exclusions from the checkout or the exact snapshot source commit."""
    root = ROOT if root is None else Path(root)
    if ref is None:
        path = root / DEV_ONLY_REL
        if not path.exists() and not path.is_symlink():
            return ()
        if path.is_symlink() or not path.is_file():
            fail("private_exclude_list", DEV_ONLY_REL)
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError):
            fail("private_exclude_unreadable", DEV_ONLY_REL)
    else:
        exists = subprocess.run(["git", "ls-tree", ref, "--", DEV_ONLY_REL], cwd=root,
                                text=True, capture_output=True, check=True).stdout
        if not exists:
            return ()
        if not exists.startswith(("100644 blob ", "100755 blob ")):
            fail("private_exclude_list", DEV_ONLY_REL)
        try:
            text = subprocess.run(["git", "show", f"{ref}:{DEV_ONLY_REL}"], cwd=root,
                                  text=True, capture_output=True, check=True).stdout
        except (OSError, UnicodeError, subprocess.CalledProcessError):
            fail("private_exclude_unreadable", DEV_ONLY_REL)
    entries = [line.strip() for line in text.splitlines() if line.strip() and not line.strip().startswith("#")]
    for entry in entries:
        if any(c.isspace() for c in entry) or "#" in entry:
            fail("private_exclude_text", DEV_ONLY_REL)
        parts = entry.removesuffix("/").split("/")
        if any(part in ("", ".", "..") for part in parts) or "\\" in entry or any(ord(c) < 32 for c in entry):
            fail("private_exclude_path", DEV_ONLY_REL)
    return tuple(entries)


def validate_private_excludes(entries, tracked):
    """Require each exclusion to cover tracked files; catch stale or mistyped exclusions."""
    for entry in entries:
        if not entry.endswith("/") and any(name.startswith(entry + "/") for name in tracked):
            fail("private_exclude_directory", DEV_ONLY_REL)
        if not excluded_files(tracked, (entry,)):
            fail("private_exclude_unused", DEV_ONLY_REL)


def excluded_files(names, entries):
    """Match exact paths or directory prefixes, never a sibling with a similar name."""
    return {name for name in names if any(name.startswith(item) if item.endswith("/") else name == item
                                         for item in entries)}


def rule_files(tracked, rules=None):
    """Split the paths that the directory rules name into (published, excluded) sets."""
    published, excluded = set(), set()
    for directory, excludes in PUBLISH_DIRS if rules is None else rules:
        prefix = directory.rstrip("/") + "/"
        for name in tracked:
            if not name.startswith(prefix):
                continue
            rest = name[len(prefix):]
            if any(rest.startswith(item) if item.endswith("/") else rest == item for item in excludes):
                excluded.add(name)
            else:
                published.add(name)
    return published, excluded


def publish_files(tracked, rules=None, *, root=None, ref=None):
    """Explicit files and package rule files, minus optional private-copy exclusions."""
    entries = private_excludes(root, ref)
    if excluded_files(PUBLISH, entries):
        fail("private_excludes_explicit", DEV_ONLY_REL)
    validate_private_excludes(entries, tracked)
    published = rule_files(tracked, rules)[0]
    return PUBLISH + tuple(sorted(published - excluded_files(published, (*entries, DEV_ONLY_REL))))


def tracked_files(root=ROOT, ref=None):
    """Tracked paths of the checkout at `root` (of `ref` when given), or None without Git."""
    top = subprocess.run(["git", "rev-parse", "--show-toplevel"], cwd=root, text=True, capture_output=True)
    if top.returncode != 0 or Path(top.stdout.strip()).resolve() != Path(root).resolve():
        return None
    command = ["git", "ls-tree", "-r", "-z", "--name-only", ref] if ref else ["git", "ls-files", "-z"]
    result = subprocess.run(command, cwd=root, text=True, capture_output=True)
    if result.returncode != 0:
        return None
    return {name for name in result.stdout.split("\0") if name}


# Build output of an in-tree package. Never tracked, never published; `npm run build` makes it in a clone.
BUILD_DIRS = ("packages/promptr/dist",)


def node_modules_guard(tracked):
    """Fail on a tracked path under a `node_modules` directory: the inventory skips those directories."""
    for name in sorted(tracked):
        if "node_modules" in name.split("/"):
            fail("tracked_in_node_modules", name)


def build_output_guard(tracked):
    """Fail on a tracked path under a build output directory: the inventory skips those directories."""
    for name in sorted(tracked):
        if any(name.startswith(item + "/") for item in BUILD_DIRS):
            fail("tracked_build_output", name)


def check():
    # Installed dependencies (`node_modules`) are skipped at any depth, like `__pycache__`.
    # A build output directory of BUILD_DIRS is skipped too: a profile with that package needs it in the clone.
    actual = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*")
              if p.is_file() and not {".local", ".git", "__pycache__", "node_modules"} & set(p.relative_to(ROOT).parts)}
    actual = {name for name in actual if not any(name.startswith(item + "/") for item in BUILD_DIRS)}
    tracked = tracked_files()
    node_modules_guard(tracked or ())
    build_output_guard(tracked or ())
    # Without Git metadata (an unpacked portable snapshot), every file counts as tracked.
    published, excluded = rule_files(actual if tracked is None else tracked)
    entries = private_excludes()
    if excluded_files(PUBLISH, entries):
        fail("private_excludes_explicit", DEV_ONLY_REL)
    validate_private_excludes(entries, actual if tracked is None else tracked)
    private = excluded_files(actual if tracked is None else tracked, (*entries, DEV_ONLY_REL))
    published -= private
    files = [ROOT / name for name in PUBLISH + tuple(sorted(published))]
    if len(set(files)) != len(files):
        fail("publish_duplicates", "publish set")
    for file in files:
        if file.is_symlink() or not file.is_file() or not file.resolve().is_relative_to(ROOT):
            fail("publish_path", file.relative_to(ROOT).as_posix())
        # A file of a directory rule can be binary; an explicit file is text.
        content = file.read_bytes().decode("utf-8", "replace" if file.relative_to(ROOT).as_posix() in published else "strict")
        allowed = {line for path, line in PATTERN_ALLOW if path == file.relative_to(ROOT).as_posix()}
        if file.name == ".env.example":
            names = {name for component in manifest(load(ROOT / "config/manifest.json")).values() for name in component["env"]}
            for line in content.splitlines():
                if line and not line.startswith("#") and ("=" not in line or line.split("=", 1)[0] not in names or line.split("=", 1)[1]):
                    fail("env_example_value", file.relative_to(ROOT).as_posix())
        elif any(pattern.search("\n".join("" if line in allowed else line for line in content.split("\n")))
                 for pattern in PATTERNS):
            fail("publish_secret_pattern", file.relative_to(ROOT).as_posix())
    # The public reader rules. `--public` prints each finding.
    checked = [name for name in (file.relative_to(ROOT).as_posix() for file in files) if not name.startswith(PUBLIC_PENDING)]
    for name, _, _ in public_findings(checked):
        fail("publish_public_reader", name)
    # A candidate release must account for every non-private tracked file.
    # Without Git metadata, compare against a reviewed explicit repository inventory.
    # Accept reviewed private-copy files when present; no exclusion list is needed in a snapshot.
    reviewed = set(PUBLISH) | published | excluded | private
    if actual != reviewed:
        # One path for each line after the finding line: a file that no list names, then a
        # reviewed file that the checkout does not hold (with the prefix `missing: `).
        fail("unreviewed_file", "\n".join(["repository inventory", *sorted(actual - reviewed),
                                           *(f"missing: {name}" for name in sorted(reviewed - actual))]))
    data = load(ROOT / "config/manifest.json")
    components = manifest(data)
    overlay(load(ROOT / "config/config.example.json"), components)
    for path, expected in render(data).items():
        if path.read_text(encoding="utf-8") != expected:
            fail("example_mismatch", path.relative_to(ROOT).as_posix())
    return [file.relative_to(ROOT).as_posix() for file in files]


def public_report(hashes=False):
    """Print each public reader finding of the whole publish set; return the exit code.

    A line is `<rule id>: <path>:<line>`. It holds no text of the file and no deny-list
    pattern. With `hashes`, a line is `<path><TAB><sha256>`, the form of an accepted line.
    """
    tracked = tracked_files()
    if tracked is None:
        tracked = {p.relative_to(ROOT).as_posix() for p in ROOT.rglob("*") if p.is_file()}
    names = [name for name in publish_files(tracked) if (ROOT / name).is_file()]
    findings = public_findings(names)
    if hashes:
        lines = {}
        for name in sorted({name for name, _, _ in findings}):
            lines[name] = (ROOT / name).read_bytes().decode("utf-8", "replace").split("\n")
        for name, number in sorted({(name, number) for name, number, _ in findings}):
            print(f"{name}\t{hashlib.sha256(lines[name][number - 1].encode('utf-8', 'surrogatepass')).hexdigest()}")
    else:
        for name, number, rule in findings:
            print(f"{rule}: {name}:{number}")
    local = "with" if local_deny_file() is not None else "without"
    if findings:
        print(f"public reader check failed: {len(findings)} findings in {len({name for name, _, _ in findings})} of "
              f"{len(names)} files, {local} a local deny list", file=sys.stderr if hashes else sys.stdout)
        return 1
    print(f"public reader check valid: {len(names)} files, {len(PUBLIC_RULES)} rules, {local} a local deny list")
    return 0


if __name__ == "__main__":
    if sys.argv[1:] in (["--public"], ["--public", "--hashes"]):
        raise SystemExit(public_report(hashes=len(sys.argv) == 3))
    if sys.argv[1:]:
        raise SystemExit("usage: publish_check.py [--public [--hashes]]")
    try:
        names = check()
    except (Invalid, UnicodeError) as exc:
        raise SystemExit(str(exc) if isinstance(exc, Invalid) else "publish_text: publish set") from None
    print(f"publish set valid: {len(names)} files, {len(PUBLISH)} explicit (not a release approval)")
