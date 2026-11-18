#!/usr/bin/env python3
"""The Agent Toolkit for AWS rows of install.sh: the pinned clone, the Pi entries and the Claude Code plugins.

Usage: kit_aws.py <action> --kit <root> [--profile <dir>] [--with <modules>] [--claude] [--adopt]

The AWS rows are the components of config/manifest.json with a `git` source. They share one clone of the
upstream repository at the pinned commit, in a folder that the kit owns:
`~/.local/share/tenant-pi/git/<host>/<path of the URL without .git>`.

Actions:
  check   refuse a selection that breaks a `requires` relation of an AWS row; write nothing
  plan    print what a run does for the AWS rows; write nothing, run no git and no claude command
  clone   make the clone or move it to the pin; refuse a link in its path, a clone with local changes, untracked
          files, hidden files or a local git config key that the kit does not write, a clone of another URL, and
          a HEAD that differs from the pin after the checkout
  mcp     write or remove the kit entry `aws-mcp` in mcp-adapter.json (mcp) or mcp.json (mcp-codemode)
  claude  with the yes only (--claude): the folder marketplace, the plugins of the chosen rows, the kit server
          `aws-mcp` of Claude Code, and the skill link of aws-emulator; turn off the kit parts of the rows that are off
  claude-installed  exit 0 when the Claude Code record of the kit names a part, else 1

Ownership: the kit removes or replaces only a part that a kit record names, and only while the part still equals
the record. The profile record kit-aws.json holds each `aws-mcp` entry that the kit wrote, by file name. The record
~/.local/share/tenant-pi/kit-aws-claude.json holds the Claude Code plugins (id and scope), the kit server, the
deniedMcpServers entries and the emulator skill link that the kit made. A part that differs from its record, or that
has no record, is the user's: it stays, with one line, unless --adopt makes it the kit's. A Claude Code plugin in
another scope than the recorded one is the user's too. A Pi skills entry is the kit's when it names a folder of the
kit clone. A Claude Code marketplace is used when its source is the clone folder.

Order of the writes: a record names a new part (as pending) before the kit writes the part, and keeps a part until
its removal is confirmed. So a run that stops halfway leaves no kit part without a record; the next run repairs the
record from the files. The deniedMcpServers entries and the kit server of a Claude Code plugin stay until the
removal of that plugin, or its move to the pin, is confirmed.

Git: each git command runs with the options of GIT_CONFIG and the environment of git_env(): no hook, no fsmonitor,
only the https protocol, no credential helper, no submodule recursion, no automatic gc, no ignore or attributes file
of the user, no system or global git config, no inherited GIT_* variable, no replace objects, and a clone without a
template.
A refusal prints one line on standard error and exits 2. A failed git or claude command exits 1.
"""
import sys

sys.dont_write_bytecode = True

import argparse  # noqa: E402
import configparser  # noqa: E402
import json  # noqa: E402
import os  # noqa: E402
from pathlib import Path  # noqa: E402
import re  # noqa: E402
import shutil  # noqa: E402
import subprocess  # noqa: E402
import tempfile  # noqa: E402

# The skills folder of a plugin row; aws-emulator names one skill folder of aws-core instead.
PLUGIN_SKILLS = re.compile(r"plugins/([a-z0-9-]+)/skills")
# The proxy form of the Pi entry of the pinned repository: uvx mcp-proxy-for-aws-cli==<version>.
PROXY = re.compile(r"mcp-proxy-for-aws-cli==\d+\.\d+\.\d+")
SERVER = "aws-mcp"
KIT_DESCRIPTION = "AWS MCP Server of the Agent Toolkit for AWS: AWS documentation, Regions and AWS API calls (tenant-pi kit entry)"
UV_LINE = "aws-core: no uvx on PATH; the aws-mcp server starts with uvx. Install uv: https://docs.astral.sh/uv/"
# The kit launcher of the proxy: unsigned unless AWS_MCP_PROXY_PROFILES names a profile (kit_aws_proxy.py).
LAUNCHER = Path(__file__).resolve().parent / "kit_aws_proxy.py"
KIT_DATA = ".local/share/tenant-pi"
PROFILE_RECORD = "kit-aws.json"
CLAUDE_RECORD = "kit-aws-claude.json"
# The options of each git command of the installer. A hook path of os.devnull runs no hook.
# The ignore and attributes files of the user do not apply either: the clean check sees each untracked file.
GIT_CONFIG = ("core.hooksPath=" + os.devnull, "core.fsmonitor=false", "protocol.allow=never", "protocol.https.allow=always",
              "credential.helper=", "submodule.recurse=false", "fetch.recurseSubmodules=false", "gc.auto=0",
              "maintenance.auto=false", "core.excludesFile=" + os.devnull, "core.attributesFile=" + os.devnull)
# The keys of the local git config that `git clone` writes. Another key (a hook path, a filter, an include, a
# work tree) can run code or move the checkout, so the kit refuses the clone.
LOCAL_KEYS = re.compile(r"core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode"
                        r"|symlinks)|remote\.origin\.(url|fetch)|branch\.\S+\.(remote|merge)")
# The trees of the clone that agents read: the plugins and the marketplace file. An ignored file there refuses the
# clone, except the caches that Python and Finder write.
EXPOSED = ("plugins", ".claude-plugin")
# The reads of ~/.claude/settings.json for one edit: another writer can change the file between a read and the write.
SETTINGS_TRIES = 3
# put() without an expected content: replace the file whatever it holds.
ANY = object()


class Refusal(Exception):
    """One line for standard error; exit 2."""


class Changed(Exception):
    """The file changed after the kit read it; the kit did not write it."""


def read_record(path):
    """A kit record: a JSON object, or {} when the file is absent."""
    path = Path(path)
    if path.is_symlink():
        raise Refusal(f"refusing a symlink {path}")
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
    except (OSError, ValueError):
        raise Refusal(f"{path} is not valid JSON; move it away and run again") from None
    if not isinstance(data, dict):
        raise Refusal(f"{path} is not a JSON object; move it away and run again")
    return data


def write_record(path, data):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise Refusal(f"refusing a symlink {path}")
    put(path, data)


def components(manifest):
    """The AWS rows: the components with a git source, in manifest order."""
    return {cid: one for cid, one in manifest["components"].items() if one["source"]["kind"] == "git"}


def source(rows):
    """The one git source of the rows; validate.py refuses two commits for one URL."""
    found = {(one["source"]["url"], one["source"]["commit"]) for one in rows.values()}
    if len(found) != 1:
        raise Refusal("the AWS rows must name one git URL and one commit")
    url, commit = found.pop()
    return url, commit


def clone_root(home):
    """The kit-owned root of the clones."""
    return Path(home) / KIT_DATA / "git"


def clone_dir(home, url):
    host, _, path = url.removeprefix("https://").partition("/")
    return clone_root(home) / host / path.removesuffix(".git")


def plugin_of(component):
    """The plugin name of a plugin row, else None (aws-emulator)."""
    skills = component["resources"]["skills"]
    found = PLUGIN_SKILLS.fullmatch(skills[0]) if len(skills) == 1 else None
    return found.group(1) if found else None


def selection(text, rows):
    names = [] if text in (None, "", "none") else text.split(",")
    return [one for one in names if one in rows]


def check(rows, selected):
    for cid in selected:
        for need in rows[cid]["requires"]:
            if need in rows and need not in selected:
                raise Refusal(f"{cid} needs {need}; add {need} to the modules")


# ---------------------------------------------------------------------------
# The clone. The inventory reads it without git.
# ---------------------------------------------------------------------------

def head_of(clone):
    """The commit of HEAD from the files of the clone, or None. No git command runs."""
    git = Path(clone) / ".git"
    try:
        head = (git / "HEAD").read_text().strip()
    except OSError:
        return None
    if re.fullmatch(r"[0-9a-f]{40}", head):
        return head
    ref = head.removeprefix("ref: ").strip()
    try:
        return (git / ref).read_text().strip()
    except OSError:
        pass
    try:
        for line in (git / "packed-refs").read_text().splitlines():
            parts = line.split()
            if len(parts) == 2 and parts[1] == ref:
                return parts[0]
    except OSError:
        pass
    return None


def origin_of(clone):
    parser = configparser.ConfigParser(strict=False, interpolation=None)
    try:
        parser.read(Path(clone) / ".git/config")
        return parser.get('remote "origin"', "url", fallback=None)
    except (configparser.Error, OSError):
        return None


def linked_part(home, clone):
    """The first symlink from the kit-owned root down to the clone and its .git, else None."""
    root = clone_root(home)
    parts = Path(clone).relative_to(root).parts
    paths = [root] + [root.joinpath(*parts[:index]) for index in range(1, len(parts) + 1)] + [Path(clone) / ".git"]
    return next((path for path in paths if path.is_symlink()), None)


def confined(home, clone):
    """True when the resolved clone path is the clone path below the resolved kit-owned root."""
    root = clone_root(home)
    return Path(clone).resolve() == root.resolve() / Path(clone).relative_to(root)


def clone_state(clone, url, commit, home=None):
    """absent, pinned, moved (another commit of the same URL), linked (a link in its path) or foreign."""
    clone = Path(clone)
    if home is not None and (linked_part(home, clone) is not None or not confined(home, clone)):
        return "linked"
    if not clone.exists() and not clone.is_symlink():
        return "absent"
    if clone.is_symlink() or not (clone / ".git").is_dir() or origin_of(clone) != url:
        return "foreign"
    return "pinned" if head_of(clone) == commit else "moved"


def git_env(env=None):
    """The environment of the git commands: no inherited GIT_* variable or SSH_ASKPASS, no system or global
    config, no terminal prompt, no replace objects, no system attributes."""
    found = {key: value for key, value in (os.environ if env is None else env).items()
             if not key.startswith("GIT_") and key != "SSH_ASKPASS"}
    found.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_TERMINAL_PROMPT="0",
                 GIT_NO_REPLACE_OBJECTS="1", GIT_ATTR_NOSYSTEM="1")
    return found


def git_command(*args):
    return ["git", *[part for one in GIT_CONFIG for part in ("-c", one)], *args]


def git(run, *args, cwd=None, check=True):
    done = run(git_command(*args), cwd=cwd, capture_output=True, text=True, env=git_env())
    if check and done.returncode:
        name = next((one for one in args if not one.startswith("-") and not os.path.isabs(one)), args[0])
        raise RuntimeError("git " + name + " exited " + str(done.returncode) + ": " + (done.stderr or "").strip()[:300])
    return done if not check else done.stdout.strip()


def tolerated(path):
    """An ignored file that the clean check accepts: a Python bytecode cache or a Finder file."""
    parts = path.split("/")
    return "__pycache__" in parts or parts[-1] == ".DS_Store"


def check_clean(run, clone, action):
    """Refuse a clone that differs from its HEAD: a local git config key that the kit does not write, a tracked
    change, an untracked file, a file that git hides from status, or an ignored file in EXPOSED."""
    where = str(clone)
    keys = [one for one in git(run, "-C", where, "config", "--local", "--name-only", "--list").splitlines() if one]
    bad = [one for one in keys if not LOCAL_KEYS.fullmatch(one)]
    if bad:
        raise Refusal(f"{clone}: the local git config has {bad[0]}, which the kit does not write; the kit does not {action} it")
    changes = git(run, "--no-optional-locks", "-C", where, "status", "--porcelain", "--untracked-files=all",
                  "--ignore-submodules=none")
    if changes:
        raise Refusal(f"{clone} has local changes or untracked files ({changes.splitlines()[0].strip()});"
                      f" the kit does not {action} it")
    hidden = [one for one in git(run, "-C", where, "ls-files", "-v").splitlines() if one and not one.startswith("H ")]
    if hidden:
        raise Refusal(f"{clone} has a file that git hides from status ({hidden[0]}); the kit does not {action} it")
    ignored = [one for one in git(run, "-C", where, "ls-files", "-z", "--others", "--ignored", "--exclude-standard",
                                  "--", *EXPOSED).split("\0") if one and not tolerated(one)]
    if ignored:
        raise Refusal(f"{clone} has an ignored file in a tree that agents read ({ignored[0]}); the kit does not {action} it")


def ensure_clone(home, url, commit, run=subprocess.run):
    """Make the clone at the pin, or move it there. Returns a line for the report."""
    root = clone_root(home)
    clone = clone_dir(home, url)

    def confine():
        link = linked_part(home, clone)
        if link is not None:
            raise Refusal(f"{link} is a symlink; the kit clone and each folder from {root} down to it must be plain folders")
        if not confined(home, clone):
            raise Refusal(f"{clone} resolves outside {root}; the kit refuses it")

    confine()
    state = clone_state(clone, url, commit)
    if state == "foreign":
        raise Refusal(f"{clone} exists and is not a clone of {url}; move it away and run again")
    if state == "pinned":
        check_clean(run, clone, "change")
        verify(run, clone, commit)
        return f"aws: clone {clone} is at the pin {commit[:7]}"
    if state == "moved":
        check_clean(run, clone, "move")
        fetch(run, clone, commit)
        git(run, "-C", str(clone), "checkout", "--quiet", "--detach", commit)
        verify(run, clone, commit)
        check_clean(run, clone, "use")
        return f"aws: clone {clone} moved to the pin {commit[:7]}"
    clone.parent.mkdir(parents=True, exist_ok=True)
    confine()
    work = Path(tempfile.mkdtemp(prefix="." + clone.name + "-", dir=clone.parent))
    try:
        git(run, "clone", "--quiet", "--template=", "--no-checkout", url, str(work / "clone"))
        fetch(run, work / "clone", commit)
        git(run, "-C", str(work / "clone"), "checkout", "--quiet", "--detach", commit)
        verify(run, work / "clone", commit)
        check_clean(run, work / "clone", "use")
        os.rename(work / "clone", clone)
    finally:
        # Only the folder that this call made; a moved clone has left it.
        shutil.rmtree(work, ignore_errors=True)
    return f"aws: cloned {url} at the pin {commit[:7]} into {clone}"


def fetch(run, clone, commit):
    if git(run, "-C", str(clone), "cat-file", "-e", commit + "^{commit}", check=False).returncode:
        git(run, "-C", str(clone), "fetch", "--quiet", "origin", commit)


def verify(run, clone, commit):
    head = git(run, "-C", str(clone), "rev-parse", "HEAD")
    if head != commit:
        raise Refusal(f"{clone}: HEAD is {head[:12]}, not the pin {commit[:12]}; the kit refuses it")


# ---------------------------------------------------------------------------
# Pi: the skills entries of settings.json and the aws-mcp entry.
# ---------------------------------------------------------------------------

def expected_skills(clone, component):
    return [str(Path(clone) / item) for item in component["resources"]["skills"]]


def user_skills(entries, clone, component):
    """Skills entries of the user for the same folders of another clone: kept unless the user adopts them."""
    tails = ["/" + item for item in component["resources"]["skills"]]
    own = set(expected_skills(clone, component))
    return [one for one in entries if isinstance(one, str) and one not in own and one[:1] not in ("!", "+", "-")
            and any(one.rstrip("/").endswith(tail) for tail in tails)]


def skill_folders(clone, component):
    """The skill folders of a row in the clone: the folder itself when it holds SKILL.md, else its subfolders that do."""
    found = []
    for one in expected_skills(clone, component):
        path = Path(one)
        if (path / "SKILL.md").is_file():
            found.append(path)
        elif path.is_dir():
            found += sorted(sub for sub in path.iterdir() if (sub / "SKILL.md").is_file())
    return found


def project_links(profile, folders):
    """{project: the skill folders that a symbolic link in <profile>/projects-memory/<project>/skills reaches}.

    The hermes extension loads such a store only in its repository, so these links scope the skills of a row."""
    found = {}
    real = [(folder, folder.resolve()) for folder in folders]
    for store in sorted((Path(profile) / "projects-memory").glob("*/skills")):
        try:
            links = [one for one in sorted(store.iterdir()) if one.is_symlink()]
        except OSError:
            continue
        for link in links:
            try:
                target = link.resolve()
            except (OSError, RuntimeError):
                # A link loop does not count.
                continue
            for folder, path in real:
                # Only a link to the skill folder itself counts: not a file in it, not a missing sub-path.
                if target == path and path.is_dir():
                    found.setdefault(store.parent.name, set()).add(folder)
    return found


def pi_skills(settings, clone, rows, selected, adopt, profile):
    """Change settings['skills'] for the selection; return the report lines. Only the kit entries are removed.

    A selected row whose skill folders have links in the hermes project stores of the profile stays project-scoped:
    the kit adds no global entry for it and removes its own entry."""
    entries = settings.get("skills")
    if entries is not None and not isinstance(entries, list):
        # The kit wrote no entry into a value that is not a list; only a selected row needs the list.
        if selected:
            raise Refusal("settings skills must be a list")
        return []
    entries = list(entries or [])
    lines = []
    for cid, component in rows.items():
        wanted = expected_skills(clone, component)
        if cid in selected:
            folders = skill_folders(clone, component)
            linked = project_links(profile, folders)
            if linked:
                for one in wanted:
                    if one in entries:
                        entries[:] = [entry for entry in entries if entry != one]
                        lines.append(f"{cid}: project scope: removes the skills entry {one}")
                lines.append(f"kept: {cid}: project scope: the skills load only in {', '.join(sorted(linked))}"
                             f" (links in {Path(profile) / 'projects-memory'}/<project>/skills); no global entry")
                for project in sorted(linked):
                    missing = [one.name for one in folders if one not in linked[project]]
                    if missing:
                        lines.append(f"{cid}: project {project} has no link for {', '.join(missing)}; add one in"
                                     f" {Path(profile) / 'projects-memory' / project / 'skills'}")
                continue
            theirs = user_skills(entries, clone, component)
            if theirs and not adopt:
                lines += [f"kept: {cid}: your skills entry {one}; --adopt-aws moves it to the kit clone" for one in theirs]
                continue
            for one in theirs:
                entries.remove(one)
                lines.append(f"{cid}: adopts the skills entry {one}")
            for one in wanted:
                if one not in entries:
                    entries.append(one)
                    lines.append(f"{cid}: skills entry {one}")
        else:
            for one in wanted:
                if one in entries:
                    entries[:] = [entry for entry in entries if entry != one]
                    lines.append(f"{cid}: off: removes the skills entry {one}")
    if entries or "skills" in settings:
        settings["skills"] = entries
    return lines


def upstream_entry(clone):
    """The aws-mcp entry of the pinned repository for agents other than Claude Code (plugins/aws-core/mcp.json)."""
    path = Path(clone) / "plugins/aws-core/mcp.json"
    try:
        entry = json.loads(path.read_text())["mcpServers"][SERVER]
    except (OSError, ValueError, KeyError, TypeError):
        raise Refusal(f"{path} has no {SERVER} entry") from None
    args = entry.get("args") if isinstance(entry, dict) else None
    if entry.get("command") != "uvx" or not isinstance(args, list) or not args or not all(
            isinstance(one, str) for one in args) or not PROXY.fullmatch(args[0]):
        raise Refusal(f"{path}: the {SERVER} entry is not the form uvx mcp-proxy-for-aws-cli==<version>")
    return entry


def kit_entry(clone, native):
    """The kit entry: the kit launcher with the arguments of the pinned entry (kit_aws_proxy.py)."""
    entry = upstream_entry(clone)
    found = {"command": "python3", "args": [str(LAUNCHER), *entry["args"]], "description": KIT_DESCRIPTION}
    return found if native else {**found, "lifecycle": "lazy"}


def mcp_files(profile):
    return {"mcp": Path(profile) / "mcp-adapter.json", "mcp-codemode": Path(profile) / "mcp.json"}


def mcp_records(profile):
    """(recorded, pending) of the profile record: {file name: entry} of the aws-mcp entries that the kit wrote, and
    {file name: entry} of the entries that a run was about to write (the record names them before the file)."""
    data = read_record(Path(profile) / PROFILE_RECORD)
    return tuple(data.get(key) if isinstance(data.get(key), dict) else {} for key in ("mcp", "pending"))


def recorded_mcp(profile):
    """{file name: entry} of the aws-mcp entries that the kit wrote into the MCP files of the profile."""
    return mcp_records(profile)[0]


def mcp_owned(record, path, entry):
    """True when the entry is the one that the kit wrote into this file: it equals the record."""
    return entry is not None and record.get(Path(path).name) == entry


def read_servers(path):
    if path.is_symlink():
        raise Refusal("refusing a symlink " + path.name)
    try:
        data = json.loads(path.read_text()) if path.exists() else {}
    except ValueError:
        raise Refusal(path.name + " is not valid JSON") from None
    servers = data.setdefault("mcpServers", {}) if isinstance(data, dict) else None
    if not isinstance(servers, dict):
        raise Refusal(path.name + " has no mcpServers object")
    return data, servers


def mcp_plan(profile, clone, modules, adopt, commit=None):
    """[(path, action, entry, report line)] of the aws-mcp step, without a write. action: write, remove, record
    (the entry stays and the record takes it) or None.

    With `commit`, a clone at another commit gives no entry: the run reads the entry after the clone step."""
    files = mcp_files(profile)
    record, pending = mcp_records(profile)
    target = "mcp-codemode" if "mcp-codemode" in modules else "mcp" if "mcp" in modules else None
    core = "aws-core" in modules
    if core and target is None:
        return [(None, None, None, "aws-core: no mcp or mcp-codemode in this run, so no aws-mcp entry")]
    steps = []
    for key, path in files.items():
        wanted = core and key == target
        if not wanted and not path.is_file():
            continue
        try:
            _, servers = read_servers(path)
        except (Refusal, OSError):
            if wanted:
                raise
            # A file that the kit cannot read holds no entry that the kit can take out.
            continue
        old = servers.get(SERVER)
        mine = mcp_owned(record, path, old) or mcp_owned(pending, path, old)
        if wanted:
            if not (Path(clone) / "plugins/aws-core/mcp.json").is_file() or commit and head_of(clone) != commit:
                steps.append((path, None, None, f"aws-core: MCP entry {SERVER} in {path}, from the pinned clone"))
                continue
            entry = kit_entry(clone, key == "mcp-codemode")
            if old == entry and mine:
                steps.append((path, None, None, f"aws-core: MCP entry {SERVER} unchanged"))
            elif old is None or mine:
                steps.append((path, "write", entry, f"aws-core: MCP entry {SERVER} in {path} ({entry['args'][1]})"))
            elif not adopt:
                steps.append((path, None, None, f"kept: {path} has your own {SERVER} entry; --adopt-aws replaces it"
                                                " with the kit entry"))
            elif old == entry:
                steps.append((path, "record", entry, f"aws-core: adopts your {SERVER} entry in {path}"))
            else:
                steps.append((path, "write", entry, f"aws-core: adopts and replaces your {SERVER} entry in {path}"))
        elif mine:
            steps.append((path, "remove", None, f"aws-core: off: removes the kit entry {SERVER} from {path}"))
        elif old is not None and path.name in record:
            steps.append((path, None, None, f"kept: the {SERVER} entry in {path} changed after the kit wrote it;"
                                            " it is yours now and stays"))
    return steps


def backup(path):
    fd, name = tempfile.mkstemp(prefix=path.name + ".backup-", dir=path.parent)
    os.close(fd)
    shutil.copy2(path, name)
    print("backup: " + name)


def content(path):
    """The bytes of a file, or None when it is absent."""
    try:
        return path.read_bytes()
    except FileNotFoundError:
        return None


def put(path, data, expect=ANY, indent=2):
    """Replace the file with the JSON of `data`. With `expect` (the bytes of the read, None for no file), the replace
    happens only while the file still holds them; else Changed and no write."""
    fd, name = tempfile.mkstemp(prefix="." + path.name + "-", dir=path.parent)
    with os.fdopen(fd, "w") as stream:
        stream.write(json.dumps(data, indent=indent) + "\n")
    os.chmod(name, 0o600)
    if expect is not ANY and content(path) != expect:
        os.unlink(name)
        raise Changed(str(path))
    os.replace(name, path)


def mcp_apply(profile, clone, modules, adopt):
    """The aws-mcp step. The record names a new entry as pending before its file holds it, and keeps a removed entry
    until its file no longer holds it. A run that stops halfway leaves no kit entry without a record."""
    profile = Path(profile)
    record_path = profile / PROFILE_RECORD
    record = read_record(record_path)
    owned, pending = (dict(one) for one in mcp_records(profile))
    saved = [json.dumps([owned, pending], sort_keys=True)]

    def save():
        text = json.dumps([owned, pending], sort_keys=True)
        if text != saved[0]:
            record["mcp"] = owned
            if pending:
                record["pending"] = pending
            else:
                record.pop("pending", None)
            write_record(record_path, record)
            saved[0] = text

    for path, action, entry, line in mcp_plan(profile, clone, modules, adopt):
        print(line)
        if action == "record":
            owned[path.name] = entry
            save()
        if action not in ("write", "remove"):
            continue
        data, servers = read_servers(path)
        if action == "write":
            pending[path.name] = entry
            save()
        if path.exists():
            backup(path)
        if action == "remove":
            del servers[SERVER]
        else:
            servers[SERVER] = entry
        put(path, data)
        if action == "remove":
            owned.pop(path.name, None)
        else:
            owned[path.name] = pending.pop(path.name)
        save()
    # The record follows the files: a pending entry that its file holds is the kit's, and a recorded entry that its
    # file no longer holds as the kit wrote it is the user's now.
    for name in sorted(set(owned) | set(pending)):
        path = profile / name
        try:
            current = read_servers(path)[1].get(SERVER) if path.is_file() else None
        except (Refusal, OSError):
            current = None
        if name in pending and pending.pop(name) == current:
            owned[name] = current
        if name in owned and owned[name] != current:
            del owned[name]
    save()
    if "aws-core" in modules and not shutil.which("uvx"):
        print(UV_LINE)


# ---------------------------------------------------------------------------
# Claude Code: the folder marketplace and the plugins, only after the yes.
# ---------------------------------------------------------------------------

def marketplace_name(clone):
    try:
        return json.loads((Path(clone) / ".claude-plugin/marketplace.json").read_text())["name"]
    except (OSError, ValueError, KeyError, TypeError):
        return "agent-toolkit-for-aws"


def claude_json(run, *args):
    done = run(["claude", *args, "--json"], capture_output=True, text=True)
    if done.returncode:
        raise RuntimeError("claude " + " ".join(args) + " --json exited " + str(done.returncode))
    try:
        found = json.loads(done.stdout)
    except ValueError:
        raise RuntimeError("cannot parse claude " + " ".join(args) + " --json") from None
    if not isinstance(found, list):
        raise RuntimeError("claude " + " ".join(args) + " --json is not a list")
    return [one for one in found if isinstance(one, dict)]


def installed_shas(home):
    """{plugin id: {scope: gitCommitSha}} of the Claude Code plugin records: {} without the file, None when the file
    cannot be read."""
    path = Path(home) / ".claude/plugins/installed_plugins.json"
    if not path.exists():
        return {}
    try:
        plugins = json.loads(path.read_text())["plugins"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    found = {}
    for key, value in plugins.items() if isinstance(plugins, dict) else ():
        for one in value if isinstance(value, list) else ():
            if isinstance(one, dict):
                found.setdefault(key, {})[one.get("scope") or "user"] = one.get("gitCommitSha")
    return found


def owned_plugins(record):
    """{plugin id: {"scope": scope}} of the Claude Code record; the record holds this object after the call."""
    owned = record.get("plugins") if isinstance(record.get("plugins"), dict) else {}
    for plugin_id, one in list(owned.items()):
        if not isinstance(one, dict) or not isinstance(one.get("scope"), str):
            del owned[plugin_id]
    record["plugins"] = owned
    return owned


def kit_plugins_left(home, record):
    """The names of the plugins of the record that Claude Code still has in the recorded scope, or None when
    installed_plugins.json cannot be read."""
    found = installed_shas(home)
    if found is None:
        return None
    owned = record.get("plugins") if isinstance(record.get("plugins"), dict) else {}
    return sorted({plugin_id.split("@")[0] for plugin_id, one in owned.items()
                   if isinstance(one, dict) and one.get("scope") in found.get(plugin_id, {})})


def known_marketplace(home, name):
    """The source path of the marketplace `name` in the records of Claude Code, else None."""
    try:
        data = json.loads((Path(home) / ".claude/plugins/known_marketplaces.json").read_text())
        found = data[name]["source"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return found.get("path") if isinstance(found, dict) and found.get("source") == "directory" else found


def emulator_link(home, clone):
    return Path(home) / ".claude/skills/aws-emulator", Path(clone) / "plugins/aws-core/skills/aws-emulator"


def claude_record_path(home):
    return Path(home) / KIT_DATA / CLAUDE_RECORD


def read_claude_record(home):
    """The Claude Code record of the kit, or {} when it cannot be read: the reader then owns no part."""
    try:
        return read_record(claude_record_path(home))
    except Refusal:
        return {}


def plugin_entry(clone, plugin):
    """The stdio aws-mcp entry of a Claude Code plugin in the pinned clone (plugins/<plugin>/.mcp.json), else None."""
    path = Path(clone) / "plugins" / plugin / ".mcp.json"
    try:
        data = json.loads(path.read_text()) if path.is_file() else {}
    except (OSError, ValueError):
        raise Refusal(f"{path} is not valid JSON") from None
    entry = data.get("mcpServers", {}).get(SERVER) if isinstance(data, dict) and isinstance(data.get("mcpServers"), dict) else None
    args = entry.get("args") if isinstance(entry, dict) else None
    if not isinstance(entry, dict) or not isinstance(entry.get("command"), str) or not isinstance(args, list) or not all(
            isinstance(one, str) for one in args):
        return None
    return entry


def denied_entries(clone, plugins):
    """The deniedMcpServers entries that turn off the aws-mcp server of each plugin: its exact command and arguments."""
    found = []
    for plugin in plugins:
        entry = plugin_entry(clone, plugin)
        if entry is not None:
            found.append({"serverCommand": [entry["command"], *entry["args"]]})
    return found


def claude_server(clone):
    """The user-scope server aws-mcp of the kit in Claude Code: the kit launcher, as in Pi."""
    entry = kit_entry(clone, True)
    return {"type": "stdio", "command": entry["command"], "args": entry["args"]}


def user_server(home):
    """The user-scope server aws-mcp of Claude Code (~/.claude.json), else None."""
    try:
        data = json.loads((Path(home) / ".claude.json").read_text())
        found = data["mcpServers"][SERVER]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return found


def claude_apply(home, clone, rows, selected, commit, adopt, run=subprocess.run):
    """Return False when a claude command or a check failed. Each change prints one line.

    Each step saves the record: the intent before a change, the result after it. A step that fails or raises leaves
    the record as it was saved last, with no write after the failure."""
    name = marketplace_name(clone)
    record_path = claude_record_path(home)
    record = read_record(record_path)
    saved = [json.dumps(record, sort_keys=True)]
    failed = []

    def save():
        text = json.dumps(record, sort_keys=True)
        if text != saved[0]:
            write_record(record_path, record)
            saved[0] = text

    def call(*args):
        done = run(["claude", *args], capture_output=True, text=True)
        if done.returncode:
            failed.append(args)
            print("claude-aws: claude " + " ".join(args[:3]) + " exited " + str(done.returncode), file=sys.stderr)
        return done.returncode == 0

    if claude_market(run, home, clone, rows, selected, name, adopt, call):
        claude_plugins(run, home, clone, rows, selected, commit, name, adopt, call, record, failed, save)
    else:
        # No plugin step: the deny entries and the kit server stay while a plugin of the record is still installed.
        left = kit_plugins_left(home, record)
        if not claude_mcp(home, clone, left or [], record, adopt, call, save, remove=left is not None):
            failed.append(("aws-mcp",))
    claude_link(home, clone, selected, record, adopt, save)
    save()
    return not failed


def claude_market(run, home, clone, rows, selected, name, adopt, call):
    """True when the marketplace `name` is the kit clone after this step, so the plugin step can run."""
    markets = {one.get("name"): one for one in claude_json(run, "plugin", "marketplace", "list")}
    market = markets.get(name)
    if market is not None and market.get("path") != str(clone):
        if not adopt:
            print(f"kept: the Claude Code marketplace {name} of the user ({market.get('path') or market.get('source')});"
                  " --adopt-aws moves it to the kit clone")
            return False
        if not (call("plugin", "marketplace", "remove", name) and call("plugin", "marketplace", "add", str(clone))):
            return False
        print(f"claude-aws: adopts the marketplace {name}: {clone}")
    elif market is None:
        # No marketplace: no kit plugin to turn off, and aws-emulator alone needs none.
        if not any(cid in selected and plugin_of(rows[cid]) for cid in rows):
            return False
        if not call("plugin", "marketplace", "add", str(clone)):
            return False
        print(f"claude-aws: marketplace {name}: {clone}")
    return True


def claude_plugins(run, home, clone, rows, selected, commit, name, adopt, call, record, failed, save):
    """The plugins of the rows. The kit uninstalls or updates only a plugin that its record names, in the recorded
    scope. The deny entries and the kit server stay until each plugin step is confirmed."""
    listed = [one for one in claude_json(run, "plugin", "list") if isinstance(one.get("id"), str)]
    plugins = {one["id"]: one for one in listed}
    scopes = {}
    for one in listed:
        scopes.setdefault(one["id"], set()).add(one.get("scope") or "user")
    owned = owned_plugins(record)
    for plugin_id, one in list(owned.items()):
        if plugin_id not in scopes:
            # Uninstalled outside the kit: the record forgets it.
            del owned[plugin_id]
        elif one["scope"] not in scopes[plugin_id]:
            print(f"kept: the Claude Code plugin {plugin_id} is in the scope {', '.join(sorted(scopes[plugin_id]))}, not"
                  f" in the scope {one['scope']} of the kit record; it is yours now and stays")
            del owned[plugin_id]
    shas = installed_shas(home) or {}
    start = len(failed)
    plan = {}
    for cid, component in rows.items():
        plugin = plugin_of(component)
        if plugin is None:
            continue
        kit_id = plugin + "@" + name
        others = [one for one in plugins if one.split("@")[0] == plugin and one != kit_id]
        if cid not in selected:
            plan[cid] = (kit_id, "off", others)
        elif others and not adopt:
            print(f"kept: the Claude Code plugin {', '.join(others)} of the user; --adopt-aws moves it to {kit_id}")
            plan[cid] = (kit_id, "kept", others)
        elif kit_id in plugins and kit_id not in owned and not adopt:
            print(f"kept: the Claude Code plugin {kit_id} is not one that the kit installed; --adopt-aws makes it"
                  " the kit's and moves it to the pin")
            plan[cid] = (kit_id, "kept", others)
        else:
            plan[cid] = (kit_id, "on", others)
    # The aws-mcp server of each kit plugin is off before the plugin comes in, and the kit server replaces it. This
    # step only adds: the entries of the plugins that go off stay until their removal is confirmed.
    on = [cid for cid, (_, action, _) in plan.items() if action == "on"]
    names = [plugin_of(rows[cid]) for cid in on]
    added = claude_mcp(home, clone, names, record, adopt, call, save, remove=False)
    if not added:
        for cid in on:
            if plugin_entry(clone, plugin_of(rows[cid])) is not None:
                print(f"claude-aws: the aws-mcp step failed, so the kit does not install or update {plan[cid][0]}",
                      file=sys.stderr)
                failed.append(("aws-mcp",))
                plan[cid] = (plan[cid][0], "kept", plan[cid][2])
    updated = None
    managed = []
    removing = []
    for cid, (kit_id, action, others) in plan.items():
        if action == "off":
            if kit_id in owned:
                removing.append(kit_id)
                if call("plugin", "uninstall", kit_id, "--scope", owned[kit_id]["scope"]):
                    print(f"claude-aws: off: uninstalled {kit_id}")
            elif kit_id in plugins:
                print(f"kept: the Claude Code plugin {kit_id} is not one that the kit installed; it stays")
            continue
        if action != "on":
            continue
        for other in others:
            if call("plugin", "uninstall", other, "--scope", plugins[other].get("scope") or "user"):
                print(f"claude-aws: adopts {other}: uninstalled, {kit_id} replaces it")
        if kit_id not in plugins:
            # The record names the plugin before the install, so a run that stops halfway does not forget it.
            owned[kit_id] = {"scope": "user"}
            save()
            if call("plugin", "install", kit_id, "--scope", "user"):
                managed.append(kit_id)
                print(f"claude-aws: installed {kit_id}")
            continue
        if kit_id not in owned:
            owned[kit_id] = {"scope": "user" if "user" in scopes[kit_id] else sorted(scopes[kit_id])[0]}
            save()
            print(f"claude-aws: adopts {kit_id}")
        managed.append(kit_id)
        if shas.get(kit_id, {}).get(owned[kit_id]["scope"]) != commit:
            if updated is None:
                updated = call("plugin", "marketplace", "update", name)
            if updated and call("plugin", "update", kit_id, "--scope", owned[kit_id]["scope"]):
                print(f"claude-aws: updated {kit_id} to the pin {commit[:7]}")
    # Each plugin that the kit manages is at the pin in its scope after the run, and each plugin that it turns off
    # is gone from its scope, else the run fails.
    after = installed_shas(home)
    if after is None:
        failed.append(("installed_plugins.json",))
        print("claude-aws: cannot read ~/.claude/plugins/installed_plugins.json; the kit keeps its records, its"
              " deniedMcpServers entries and its server", file=sys.stderr)
        return
    for kit_id in managed:
        found = after.get(kit_id, {})
        scope = owned[kit_id]["scope"]
        if scope not in found:
            failed.append((kit_id,))
            print(f"claude-aws: {kit_id} is not installed after the run", file=sys.stderr)
        elif found[scope] != commit:
            failed.append((kit_id,))
            print(f"claude-aws: {kit_id} records commit {str(found[scope])[:7]}, not the kit pin {commit[:7]}",
                  file=sys.stderr)
    for kit_id in removing:
        if owned[kit_id]["scope"] in after.get(kit_id, {}):
            failed.append((kit_id,))
            print(f"claude-aws: {kit_id} is still installed; its deniedMcpServers entry and the kit server stay",
                  file=sys.stderr)
    # The record follows the confirmed state: a plugin that is gone from its scope leaves the record.
    for plugin_id in list(owned):
        if owned[plugin_id]["scope"] not in after.get(plugin_id, {}):
            del owned[plugin_id]
    save()
    # The kit takes out a deny entry or its server only when each plugin step is confirmed. After a failed uninstall
    # or a failed pin move, the old entries stay: the plugin that is still installed would start its own server.
    if added:
        left = sorted({plugin_id.split("@")[0] for plugin_id in owned} | set(names))
        if not claude_mcp(home, clone, left, record, adopt, call, save, remove=len(failed) == start):
            failed.append(("aws-mcp",))


def json_indent(raw):
    """The indent of a JSON file: a tab or a number of spaces; 2 for a file with no indented line."""
    found = re.search(rb"\n([ \t]+)\S", raw or b"")
    if not found:
        return 2
    space = found.group(1).decode()
    return "\t" if space.startswith("\t") else len(space)


def set_denied(record, denied, created):
    """The deny entries of the kit in the record, and the parts of the settings file that the kit created for them
    ("file", "key"); an empty value leaves the record."""
    for key, value in (("denied", denied), ("created", sorted(set(created)) if denied else [])):
        if value:
            record[key] = value
        else:
            record.pop(key, None)


def claude_denied(path, expected, record, save, remove):
    """The deniedMcpServers entries of the kit in ~/.claude/settings.json: add `expected`, and with `remove` take out
    a recorded entry that is not expected. Returns False when a step failed.

    The kit replaces the file only while it holds the bytes of the read. After a change by another writer, it reads
    the file again and applies its edit to the new content, at most SETTINGS_TRIES times. The record names an added
    entry before the write, and keeps a removed entry until the write is done. The kit takes out the key, or the
    file, when it created them and they are empty again."""
    recorded = record.get("denied") if isinstance(record.get("denied"), list) else []
    created = record.get("created") if isinstance(record.get("created"), list) else []
    if not expected and not recorded:
        return True
    if path.is_symlink():
        print(f"claude-aws: {path} is a symlink; the kit does not write it", file=sys.stderr)
        return False
    for _ in range(SETTINGS_TRIES):
        try:
            raw = content(path)
            data = json.loads(raw) if raw is not None else {}
        except (OSError, ValueError):
            print(f"claude-aws: {path} is not valid JSON; the kit does not write it", file=sys.stderr)
            return False
        listed = data.get("deniedMcpServers", []) if isinstance(data, dict) else None
        if not isinstance(listed, list):
            print(f"claude-aws: {path}: deniedMcpServers is not a list; the kit does not write it", file=sys.stderr)
            return False
        # An entry is the kit's while it equals a recorded one. An equal entry of the user that the kit did not
        # record stays and does not become the kit's.
        mine = [one for one in recorded if one in listed]
        drop = [one for one in mine if remove and one not in expected]
        entries = [one for one in listed if one not in drop]
        added = [one for one in expected if one not in entries]
        entries += added
        kept = [one for one in mine if one not in drop]
        if entries == listed:
            set_denied(record, kept, created)
            return True
        made = created + (["file"] if raw is None else []) + (["key"] if "deniedMcpServers" not in data else [])
        set_denied(record, mine + added, made)
        save()
        new = {**data, "deniedMcpServers": entries}
        if not entries and "key" in made:
            del new["deniedMcpServers"]
        if raw is not None:
            backup(path)
        try:
            if not new and "file" in made:
                if content(path) != raw:
                    raise Changed(str(path))
                path.unlink()
            else:
                path.parent.mkdir(parents=True, exist_ok=True)
                put(path, new, expect=raw, indent=json_indent(raw))
        except Changed:
            continue
        for one in added:
            print(f"claude-aws: deniedMcpServers entry in {path}: each server with the command of the plugin server"
                  f" stays off ({one['serverCommand'][-1]})")
        if drop:
            print(f"claude-aws: off: removes a kit deniedMcpServers entry from {path}")
        set_denied(record, kept + added, made)
        save()
        return True
    print(f"claude-aws: {path} changed after each of {SETTINGS_TRIES} reads; the kit does not write it", file=sys.stderr)
    return False


def same_server(current, wanted):
    """True when the server `current` runs the command and the arguments of `wanted`."""
    return isinstance(current, dict) and isinstance(wanted, dict) and all(
        current.get(key) == wanted.get(key) for key in ("command", "args"))


def claude_mcp(home, clone, plugins, record, adopt, call, save=lambda: None, remove=True):
    """For the kit plugins `plugins`: a deniedMcpServers entry in ~/.claude/settings.json for the aws-mcp server of
    each of them, and the user-scope server aws-mcp with the kit launcher, as in Pi. With `remove`, the kit takes out
    an entry or the server that it no longer needs, only while it equals the record; without it, the step only adds.
    Returns False when a step failed."""
    expected = denied_entries(clone, plugins)
    want = bool(expected)
    if not claude_denied(Path(home) / ".claude/settings.json", expected, record, save, remove):
        return False
    ok = True
    current = user_server(home)
    if current is None:
        record.pop("pending_server", None)
    # The kit server is the kit's while it equals the record, or after a stop between the add and the record, while
    # it runs the command of the pending record.
    mine = current is not None and (current == record.get("server") or same_server(current, record.get("pending_server")))
    entry = claude_server(clone) if want else None
    if want and current == entry and mine:
        record["server"] = current
        record.pop("pending_server", None)
    elif want and (current is None or mine or adopt):
        # The record names the kit server before Claude Code has it.
        record["pending_server"] = entry
        save()
        if current is not None and not call("mcp", "remove", "--scope", "user", SERVER):
            return False
        if call("mcp", "add-json", "--scope", "user", SERVER, json.dumps(entry)):
            record["server"] = user_server(home) or entry
            record.pop("pending_server", None)
            print(f"claude-aws: user-scope MCP server {SERVER}: the kit launcher ({entry['args'][1]})")
        else:
            ok = False
        save()
    elif want:
        print(f"kept: Claude Code has your own user-scope {SERVER} server; --adopt-aws replaces it with the kit server")
    elif not remove:
        pass
    elif mine:
        if call("mcp", "remove", "--scope", "user", SERVER):
            record.pop("server", None)
            record.pop("pending_server", None)
            save()
            print(f"claude-aws: off: removes the kit user-scope MCP server {SERVER}")
        else:
            ok = False
    else:
        record.pop("server", None)
        record.pop("pending_server", None)
    return ok


def claude_link(home, clone, selected, record, adopt, save=lambda: None):
    """aws-emulator: the plugin aws-core carries the skill; without it, a skill link of the kit."""
    link, target = emulator_link(home, clone)
    want = "aws-emulator" in selected and "aws-core" not in selected
    expected = {"path": str(link), "target": str(target)}
    exact = link.is_symlink() and os.readlink(link) == str(target)
    mine = exact and record.get("link") == expected
    if want and mine:
        return
    if want and (link.exists() or link.is_symlink()):
        if exact and adopt:
            record["link"] = expected
            print(f"claude-aws: adopts the link {link}")
        else:
            print(f"kept: {link} is not a link of the kit" + ("; --adopt-aws makes it the kit's" if exact else ""))
    elif want:
        # The record names the link before it exists.
        record["link"] = expected
        save()
        link.parent.mkdir(parents=True, exist_ok=True)
        link.symlink_to(target)
        print(f"claude-aws: link {link}")
    elif mine:
        link.unlink()
        record.pop("link", None)
        print(f"claude-aws: off: removes the link {link}")
    else:
        record.pop("link", None)


def claude_installed(home):
    """True when the Claude Code record of the kit names a part: the claude step has something to keep or remove."""
    record = read_claude_record(home)
    return any(record.get(key) for key in ("plugins", "server", "pending_server", "denied", "link"))


# ---------------------------------------------------------------------------
# The plan.
# ---------------------------------------------------------------------------

def plan_lines(home, profile, rows, modules, claude, adopt, skills=True):
    url, commit = source(rows)
    clone = clone_dir(home, url)
    selected = selection(",".join(modules), rows)
    lines = []
    state = clone_state(clone, url, commit, home)
    if selected:
        text = {"absent": "absent; the run clones it", "pinned": "at the pin; the run checks that it is clean",
                "moved": f"at {str(head_of(clone))[:7]}; the run moves it to the pin",
                "linked": "a link in its path; the run refuses it",
                "foreign": "not a clone of this URL; the run refuses it"}[state]
        lines.append(f"aws: clone {url} at {commit[:7]} in {clone} ({text})")
        if not shutil.which("git"):
            raise Refusal("the AWS rows need git on PATH")
    settings_path = Path(profile) / "settings.json"
    try:
        settings = json.loads(settings_path.read_text()) if settings_path.is_file() else {}
    except ValueError:
        raise Refusal(f"{settings_path} is not valid JSON") from None
    if skills:
        lines += pi_skills(settings if isinstance(settings, dict) else {}, clone, rows, selected, adopt,
                           profile)
    lines += [line for _, _, _, line in mcp_plan(profile, clone, modules, adopt, commit)]
    if "aws-core" in selected and not shutil.which("uvx"):
        lines.append(UV_LINE)
    if (Path(home) / ".claude").is_dir() and shutil.which("claude"):
        plugins = [plugin_of(rows[cid]) or cid for cid in selected]
        if claude:
            lines.append("Claude Code AWS plugins: " + (", ".join(plugins) or "none") + " (chosen; the run removes the"
                         " kit parts of the rows that are off)")
            if "aws-core" in selected:
                lines.append(f"Claude Code: the kit server {SERVER} (the kit launcher, unsigned by default) and a"
                             " deniedMcpServers entry that turns off the server of the plugin aws-core, and also each"
                             " server of yours with the same command")
        elif selected:
            lines.append("Claude Code AWS plugins: " + ", ".join(plugins)
                         + " (not chosen; --claude-aws or a yes in a terminal is the yes)")
        elif claude_installed(home):
            lines.append("Claude Code AWS plugins: the kit parts stay; --claude-aws removes those of the rows that are off")
    return lines


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("action", choices=("check", "plan", "clone", "mcp", "claude", "claude-installed"))
    parser.add_argument("--kit", required=True)
    parser.add_argument("--profile")
    parser.add_argument("--with", dest="modules", default="none")
    parser.add_argument("--claude", action="store_true", help="the yes to the Claude Code AWS plugins")
    parser.add_argument("--adopt", action="store_true", help="move an AWS entry of the user to the kit pin")
    args = parser.parse_args(argv)
    try:
        home = os.environ.get("HOME", "")
        if not os.path.isabs(home):
            raise Refusal("HOME must be set to an absolute path")
        manifest = json.loads((Path(args.kit) / "config/manifest.json").read_text())
        rows = components(manifest)
        modules = [] if args.modules in ("", "none") else args.modules.split(",")
        selected = selection(args.modules, rows)
        url, commit = source(rows)
        clone = clone_dir(home, url)
        if args.action == "check":
            check(rows, selected)
        elif args.action == "plan":
            for line in plan_lines(home, args.profile, rows, modules, args.claude, args.adopt):
                print(line)
        elif args.action == "clone":
            print(ensure_clone(home, url, commit))
        elif args.action == "mcp":
            mcp_apply(Path(args.profile), clone, modules, args.adopt)
        elif args.action == "claude":
            if not args.claude:
                raise Refusal("the claude action needs the yes (--claude)")
            return 0 if claude_apply(home, clone, rows, selected, commit, args.adopt) else 1
        elif args.action == "claude-installed":
            return 0 if claude_installed(home) else 1
    except Refusal as error:
        print("kit_aws: " + str(error), file=sys.stderr)
        return 2
    except (RuntimeError, OSError) as error:
        print("kit_aws: " + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
