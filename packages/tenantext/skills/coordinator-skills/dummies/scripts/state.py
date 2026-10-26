#!/usr/bin/env python3
"""Turn the dummies skill on or off for one harness, and print the state.

The state is one small file for each user, outside each repository:
`dummies-skill/state.json` in `XDG_CONFIG_HOME`, or in `~/.config`. It holds one
value for each harness, `claude` and `pi`. No file means off. A relative
`XDG_CONFIG_HOME` is not used. A state file that is a link is not used.

Usage: state.py [status|on|off] [--harness pi|claude] [--autostart]

    status   print one line: the state of this harness and of the other one, the
             autostart file, the Herdr role of the pane and the state file
    on       set the state of this harness to on. It changes no instruction file:
             it prints the autostart block that `on --autostart` adds
    on --autostart
             also add the marked block to the user instruction file of the
             harness, so that each new coordinator session reads REPORT.md
    off      set the state to off and remove each autostart block of the harness.
             After `on --autostart` and then `off`, the instruction file has the
             same bytes as before. `off` removes a file only when `on` created it

Exit codes: 0 done; 1 a fault of the script; 2 wrong arguments, or the harness
is not known; 3 the state file is not valid, not readable, not writable or a
link (the state then counts as off); 4 an instruction file cannot be changed.
`off` saves the state before it changes a file, so the state is off also after
code 4.
Python 3.11 standard library only.
"""
import argparse
import json
import os
import re
import sys

# A run of the script leaves no cache directory in the skill directory.
sys.dont_write_bytecode = True
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from dummies_lib import HARNESSES, Stop, detect_harness, herdr_agent, home, short, write_text  # noqa: E402

ROLES = ("coordinator", "researcher", "scout", "worker", "reviewer")
BEGIN = "<!-- dummies-autostart:begin -->"
END = "<!-- dummies-autostart:end -->"
# A marker is a complete line. A line of the user that quotes a marker is text of the user.
BEGIN_LINE, END_LINE = (re.compile(r"(?m)^%s[ \t]*(?P<eol>\r?\n|\Z)" % re.escape(mark)) for mark in (BEGIN, END))
# Pi loads the first of these files that is in its agent directory.
PI_CONTEXT_FILES = ("AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD")
# The file names that `on` can choose for a harness.
INSTRUCTION_NAMES = {"claude": ("CLAUDE.md",), "pi": PI_CONTEXT_FILES}
# The state file records two lists for each harness: the files that got a block, and the files that `on` created.
RECORDS = ("autostart", "created")
# The autostart block names this file, not the skill text: a harness loads the skill text only for the user.
REPORT_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "REPORT.md")


def state_path(env=None):
    env = os.environ if env is None else env
    base = env.get("XDG_CONFIG_HOME") or ""
    # A relative value is not valid: it names a place below the current directory.
    if not os.path.isabs(base):
        base = os.path.join(home(), ".config")
    return os.path.join(base, "dummies-skill", "state.json")


def refuse_link(path):
    """A state file that is a link names a file of another owner: it is not read and not written."""
    if os.path.islink(path):
        raise Stop(3, f"state file is a link: {short(path)}: the script does not read it and does not write it. "
                      "The state counts as off. Move the link away, then run on or off again.")


def load_state(path):
    """The content of the state file, or {} when it is absent. A file that is not valid stops with code 3."""
    refuse_link(path)
    try:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except OSError as error:
        raise Stop(3, f"state file not readable: {short(path)}: {type(error).__name__}. "
                      "The state counts as off.") from None
    except ValueError as error:
        raise Stop(3, not_valid(path, type(error).__name__)) from None
    if not isinstance(data, dict):
        raise Stop(3, not_valid(path, "the content is not an object"))
    for harness in HARNESSES:
        if data.get(harness, "off") not in ("on", "off"):
            raise Stop(3, not_valid(path, f"the value of {harness} is not on or off"))
    for key in RECORDS:
        files = data.get(key, {})
        if not isinstance(files, dict) or not all(
                isinstance(value, list) and all(isinstance(one, str) for one in value) for value in files.values()):
            raise Stop(3, not_valid(path, f"{key} is not a list of files for each harness"))
    return data


def not_valid(path, reason):
    return (f"state file not valid: {short(path)}: {reason}. The state counts as off. "
            "Move the file away, then run on or off again.")


def herdr_role(agent):
    """The role in a Herdr agent name of the form `<project>-<role>-<n>`, or None."""
    match = re.search(r"-(%s)-[0-9]+$" % "|".join(ROLES), str((agent or {}).get("name") or ""))
    return match.group(1) if match else None


def instruction_file(harness, env=None):
    """The user instruction file that the harness loads in each session."""
    env = os.environ if env is None else env
    if harness == "claude":
        return os.path.join(env.get("CLAUDE_CONFIG_DIR") or os.path.join(home(), ".claude"), "CLAUDE.md")
    directory = env.get("PI_CODING_AGENT_DIR") or os.path.join(home(), ".pi", "agent")
    for name in PI_CONTEXT_FILES:
        if os.path.isfile(os.path.join(directory, name)):
            return os.path.join(directory, name)
    return os.path.join(directory, "AGENTS.md")


def recorded_files(data, harness):
    """(files, ignored) of the `autostart` list of a harness.

    A recorded path is used only when `on` can choose it: an absolute path with a file name that the
    harness loads. Each other path is ignored: the state file is data, and it does not name a file to change.
    """
    files, ignored = [], []
    for one in dict.fromkeys(data.get("autostart", {}).get(harness, [])):
        usable = os.path.isabs(one) and os.path.basename(one) in INSTRUCTION_NAMES[harness]
        (files if usable else ignored).append(one)
    return files, ignored


def record(data, harness, files, created):
    """Put the two lists of a harness into the state. An empty list and an empty table are not kept."""
    real = {os.path.realpath(one) for one in files}
    for key, value in zip(RECORDS, (sorted(set(files)), sorted(one for one in set(created) if one in real))):
        table = dict(data.get(key, {}))
        table.pop(harness, None)
        if value:
            table[harness] = value
        if table:
            data[key] = table
        else:
            data.pop(key, None)


def block_lines(report_file=REPORT_FILE):
    """The three lines of the autostart block. They start the report form in a coordinator session."""
    return (BEGIN,
            f"dummies is on: a standing order of the user. Coordinator session: before your first reply, read the file "
            f"`{report_file}` and apply it. You are a coordinator session when the user talks to you directly and no "
            "start prompt gives you a task role. A task session ignores this block and reads no file of it.",
            END)


def read_file(path):
    """The text of a file with each line end as the file has it, or None when the file is absent."""
    try:
        with open(path, encoding="utf-8", newline="") as handle:
            return handle.read()
    except FileNotFoundError:
        return None
    except (OSError, UnicodeError) as error:
        raise Stop(4, f"instruction file not readable: {short(path)}: {type(error).__name__}") from None


def find_block(text, path):
    """(begin line, end line) of the autostart block as two matches, or None.

    One marker line without the other, the end line first, or a second block stops with code 4.
    """
    begins, ends = list(BEGIN_LINE.finditer(text)), list(END_LINE.finditer(text))
    if not begins and not ends:
        return None
    if len(begins) != 1 or len(ends) != 1 or ends[0].start() < begins[0].start():
        raise Stop(4, f"instruction file has a damaged dummies block: {short(path)}: correct it by hand")
    return begins[0], ends[0]


def has_block(path):
    text = read_file(path)
    return bool(text) and find_block(text, path) is not None


def add_block(path, lines):
    """Put the block at the end of the file, or replace the block that is there.

    Return `created` for a file that was absent, `added` for a new block in a file of the user, `replaced`
    for a changed block, and None when the file has the block already. The block takes the line end of the
    file. After the text of a file that has no last line end, the block has no last line end too: thus
    `remove_block` knows the end of the file as it was.
    """
    before = read_file(path)
    text = before or ""
    found = find_block(text, path) if text else None
    if found:
        begin, end = found
        end_of_line = begin.group("eol")
        changed = text[:begin.start()] + end_of_line.join(lines) + text[end.end() - len(end.group("eol")):]
    else:
        last = text.rfind("\n")
        end_of_line = "\r\n" if last > 0 and text[last - 1] == "\r" else "\n"
        new = end_of_line.join(lines)
        if not text:
            changed = new + end_of_line
        elif text.endswith("\n"):
            changed = text + end_of_line + new + end_of_line
        else:
            changed = text + end_of_line * 2 + new
    if changed == text:
        return None
    try:
        write_text(path, changed)
    except OSError as error:
        raise Stop(4, f"instruction file not writable: {short(path)}: {type(error).__name__}") from None
    return "created" if before is None else "replaced" if found else "added"


def remove_block(path, created=()):
    """Take the block out of the file, with the line ends that `add_block` put before it. True when the file changed.

    The text of the user keeps each byte. A file that holds nothing else is removed only when its real path
    is in `created`: these are the files that `on` created.
    """
    text = read_file(path)
    found = find_block(text, path) if text else None
    if not found:
        return False
    begin, end = found
    end_of_line = begin.group("eol")
    before, after = text[:begin.start()], text[end.end():]
    if end.group("eol"):
        # One empty line is between the text of the user and the block.
        if before.endswith(end_of_line) and before[:-len(end_of_line)][-1:] in ("", "\n"):
            before = before[:-len(end_of_line)]
    else:
        # The block ends the file with no line end: the file had none. The two line ends before the block go.
        for _ in range(2):
            if before.endswith(end_of_line):
                before = before[:-len(end_of_line)]
    changed = before + after
    try:
        real = os.path.realpath(path)
        if not changed.strip() and real in created:
            os.unlink(real)
        else:
            write_text(path, changed)
    except OSError as error:
        raise Stop(4, f"instruction file not writable: {short(path)}: {type(error).__name__}") from None
    return True


def autostart_files(data, harness, env=None):
    """Each file that can hold a block of the harness: the recorded files, then the file of this session."""
    files = recorded_files(data, harness)[0]
    current = instruction_file(harness, env)
    return files + [current] if current not in files else files


def ignored_text(ignored, harness):
    """The recorded paths that are not used, as one phrase, or an empty text."""
    return (f"ignored from the state file, not an instruction file of {harness}: "
            + ", ".join(short(one) for one in ignored)) if ignored else ""


def status_line(data, harness, path, agent, env=None):
    other = next(one for one in HARNESSES if one != harness)
    try:
        with_block = [one for one in autostart_files(data, harness, env) if has_block(one)]
        autostart = ", ".join(short(one) for one in with_block) or "none"
        if with_block and data.get(harness, "off") != "on":
            autostart += " (the state is off: run off to remove the block)"
    except Stop as stop:
        autostart = str(stop)
    ignored = ignored_text(recorded_files(data, harness)[1], harness)
    if ignored:
        autostart += f" ({ignored})"
    role = herdr_role(agent)
    if agent is None:
        role_text = "not known (no Herdr): your start prompt decides"
    elif role is None:
        role_text = "not known (the Herdr name has no role): your start prompt decides"
    elif role == "coordinator":
        role_text = "coordinator (Herdr)"
    else:
        role_text = f"{role} (Herdr): a task session does not use dummies"
    present = "" if os.path.isfile(path) else " (absent)"
    return (f"dummies: {data.get(harness, 'off')} for {harness} | {other}: {data.get(other, 'off')} | "
            f"autostart: {autostart} | role: {role_text} | state file: {short(path)}{present}")


def save(path, data):
    refuse_link(path)
    try:
        write_text(path, json.dumps(data, indent=2, sort_keys=True) + "\n", follow=False)
    except OSError as error:
        raise Stop(3, f"state file not writable: {short(path)}: {type(error).__name__}") from None


def run(word, named=None, autostart=False, env=None, out=print):
    env = os.environ if env is None else env
    agent = herdr_agent(env)
    harness = detect_harness(named, env, agent)
    if harness is None:
        raise Stop(2, "the harness is not known: add --harness pi or --harness claude")
    path = state_path(env)
    try:
        data = load_state(path)
    except Stop as stop:
        if word == "status":
            out(f"dummies: off for {harness} | {stop}")
        raise
    if word == "status":
        out(status_line(data, harness, path, agent, env))
        return
    was = data.get(harness, "off")
    files, ignored = recorded_files(data, harness)
    created = list(data.get("created", {}).get(harness, []))
    target = instruction_file(harness, env)
    if word == "on":
        lines = block_lines()
        data[harness] = "on"
        if autostart:
            change = add_block(target, lines)
            real = os.path.realpath(target)
            if change == "created":
                created.append(real)
            elif change == "added":
                # The file was there with no block: it is a file of the user now, also when `on` created it before.
                created = [one for one in created if one != real]
            record(data, harness, files + [target], created)
        save(path, data)
        out(f"dummies: on for {harness} (was {was}) | state file: {short(path)}")
        if autostart:
            out(f"autostart: {'added the block to' if change else 'the block is already in'} {short(target)}. "
                "Each new session of this harness reads it. off removes it.")
            if ignored:
                out(f"autostart: {ignored_text(ignored, harness)}. The state file does not name such a path now.")
            out("\n".join(lines))
        elif has_block(target):
            out(f"autostart: the block is in {short(target)}.")
        else:
            out("autostart: none. A new session uses dummies only after the user starts the skill by name.")
            out(f"To start it in each new coordinator session, run on --autostart. It adds these lines to "
                f"{short(target)}, and off removes them:")
            out("\n".join(lines))
        return
    # The state is saved first: a file that cannot be changed does not keep the skill on.
    data[harness] = "off"
    save(path, data)
    saved = json.dumps(data, sort_keys=True)
    removed, repair, kept = [], [], []
    for one in (files if target in files else files + [target]):
        try:
            if remove_block(one, created):
                removed.append(one)
        except Stop as stop:
            repair.append(str(stop))
            kept.append(one)
    # A file that needs a repair stays in the record: the next off removes its block.
    record(data, harness, kept, created)
    if json.dumps(data, sort_keys=True) != saved:
        save(path, data)
    out(f"dummies: off for {harness} (was {was}) | state file: {short(path)}")
    out("autostart: removed the block from " + ", ".join(short(one) for one in removed) + "." if removed
        else "autostart: no block to remove.")
    if ignored:
        out(f"autostart: {ignored_text(ignored, harness)}. The script changed no such path, and the state file "
            "does not name such a path now.")
    if repair:
        raise Stop(4, "the state is off, but an instruction file needs a repair by hand: " + "; ".join(repair)
                      + f". Take the lines from `{BEGIN}` to `{END}` out of the file. Then run off again.")


def main(argv=None):
    parser = argparse.ArgumentParser(prog="state.py", description="Turn the dummies skill on or off for one harness.")
    parser.add_argument("word", nargs="?", default="status", choices=("status", "on", "off"))
    parser.add_argument("--harness", choices=HARNESSES)
    parser.add_argument("--autostart", action="store_true",
                        help="with on: add the autostart block to the user instruction file of the harness")
    args = parser.parse_args(argv)
    if args.autostart and args.word != "on":
        parser.error("--autostart goes with on")
    for stream in (sys.stdout, sys.stderr):
        stream.reconfigure(encoding="utf-8", errors="replace")
    try:
        run(args.word, args.harness, args.autostart)
    except Stop as stop:
        print(f"state.py: {stop}", file=sys.stderr)
        return stop.code
    except Exception as error:  # A fault of the script: one line and a fixed code, no trace.
        print(f"state.py: fault of the script: {type(error).__name__}: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
