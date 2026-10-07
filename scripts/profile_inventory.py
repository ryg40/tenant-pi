"""Pure, names-only inventory of one explicitly selected Pi profile directory.

Inputs are the already-loaded `settings.json` object, the already-listed direct entries of
the resource directories, and the already-checked presence of the state marker. The module
reads no file, environment, or host state. From the settings it uses the `packages` key
only, and from a package entry only the source string and the names of its filter keys.

The `coordination` block gives separate results for the Herdr skill and the question extension.
For it the module also reads whether a `skills` filter names the Herdr skill. The caller checks
the two files that `coordination_files` names and gives the two answers back.
"""
import re

from scripts.validate import NPM, Invalid, absolute, fail, npm_name

RESOURCE_DIRS = ("extensions", "skills", "prompts")
KINDS = ("file", "dir", "symlink", "other")
MAX_SOURCE = 1024
# The filter entry of the bundled Herdr skill, and the file that proves a readable skill directory.
HERDR_SKILL = "skills/herdr"
HERDR_SKILL_FILE = HERDR_SKILL + "/SKILL.md"
# The npm name of the question extension, and its manifest below the npm directory of a profile.
QUESTION_PACKAGE = "@juicesharp/rpiv-ask-user-question"
QUESTION_PACKAGE_FILE = "npm/node_modules/" + QUESTION_PACKAGE + "/package.json"
# Results that no file of a profile can prove. Each has its own check outside this action.
NOT_MEASURED = {"herdrCli": "not_checked", "herdrSession": "not_run", "questionUi": "unverified"}
# A source string is echoed only in one of three closed forms; every other string is
# `unsupported_value`. The forms have no query, fragment, parameter, whitespace or control
# character. The one login is the exact `git@`; the one other `@` is a 40-hex commit pin.
_HOST = r"[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?"
_PATH = r"[A-Za-z0-9._~/-]+(?:@[0-9a-f]{40})?"
REPOSITORY = (
    # A URL: the colon after the host is a numeric port only.
    re.compile(r"(?:git:)?(?:https|ssh)://(?:git@)?" + _HOST + r"(?::[0-9]{1,5})?/" + _PATH + r"\Z"),
    # The `git:` shorthand: `host/path`, or the scp style `host:path`.
    re.compile(r"git:(?:git@)?" + _HOST + r"[:/]" + _PATH + r"\Z"),
)


def _source_public(source):
    if not source or len(source) > MAX_SOURCE:
        return False
    if source.startswith("/"):
        try:
            absolute(source, "inventory.source")
        except Invalid:
            return False
        return True
    if source.startswith("npm:"):
        return bool(NPM.fullmatch(source[4:]))
    return any(form.fullmatch(source) for form in REPOSITORY)


def _package(entry):
    """One `packages` entry: the source string and, for the object form, the filter key names."""
    if type(entry) is str:
        source, filters = entry, None
    elif type(entry) is dict and type(entry.get("source")) is str:
        source, filters = entry["source"], sorted(key for key in entry if key != "source")
    else:
        return {"status": "unsupported_shape"}
    shown = {"source": source} if _source_public(source) else {"status": "unsupported_value"}
    return shown if filters is None else {**shown, "filters": filters}


def coordination_files(directory, settings):
    """The two files whose presence the caller checks, each an absolute path or None.

    `herdrSkill` is the `SKILL.md` of the Herdr skill below a local package that a `skills` filter
    selects. `questionExtension` is the installed manifest of the question extension below
    `<directory>/npm`. None means that `settings.json` does not declare the part.
    """
    found = {"herdrSkill": None, "questionExtension": None}
    packages = settings.get("packages", []) if type(settings) is dict else []
    for entry in packages if type(packages) is list else []:
        source = entry if type(entry) is str else entry.get("source") if type(entry) is dict else None
        if type(source) is not str or not _source_public(source):
            continue
        skills = entry.get("skills") if type(entry) is dict else None
        if source.startswith("/") and type(skills) is list and HERDR_SKILL in skills and found["herdrSkill"] is None:
            found["herdrSkill"] = source.rstrip("/") + "/" + HERDR_SKILL_FILE
        if source.startswith("npm:") and npm_name(source[4:]) == QUESTION_PACKAGE:
            found["questionExtension"] = directory.rstrip("/") + "/" + QUESTION_PACKAGE_FILE
    return found


def _coordination(directory, settings, present):
    """Separate results of the coordination parts; a declared part is not a working part."""
    files = coordination_files(directory, settings)
    if type(present) is not dict or set(present) != set(files) or any(type(value) is not bool for value in present.values()):
        fail("coordination_facts", "inventory.coordination")
    if any(present[key] and files[key] is None for key in files):
        fail("coordination_facts", "inventory.coordination")
    return {"herdrSkill": "not_declared" if files["herdrSkill"] is None else
            "readable" if present["herdrSkill"] else "not_readable",
            "questionExtension": "not_declared" if files["questionExtension"] is None else
            "installed" if present["questionExtension"] else "declared",
            **NOT_MEASURED}


def _entries(listing, field):
    if type(listing) is not list:
        fail("array", field)
    for item in listing:
        if (type(item) is not tuple or len(item) != 2 or type(item[0]) is not str or not item[0]
                or item[1] not in KINDS):
            fail("entry", field)
    if len({name for name, _ in listing}) != len(listing):
        fail("duplicate_entry", field)
    return [{"name": name, "kind": kind} for name, kind in sorted(listing)]


def inventory(directory, settings, listings, managed, present=None):
    """The deterministic report of one profile directory.

    `settings` is the loaded `settings.json` (`None` when absent). `listings` maps each name
    of `RESOURCE_DIRS` to a list of `(name, kind)` pairs; an absent directory is an empty list.
    `present` maps each key of `coordination_files` to whether the caller found that file; without
    it no file counts as found.
    """
    if settings is None:
        fail("settings_missing", "inventory.dir")
    if type(settings) is not dict:
        fail("object", "inventory.dir.settings.json")
    if type(managed) is not bool:
        fail("boolean", "inventory.managed")
    if type(listings) is not dict or set(listings) != set(RESOURCE_DIRS):
        fail("resource_directories", "inventory.listings")
    packages = settings.get("packages", [])
    if type(packages) is not list:
        fail("array", "inventory.dir.settings.json.packages")
    report = {"dir": directory, "managed": managed, "packages": [_package(entry) for entry in packages]}
    for name in RESOURCE_DIRS:
        report[name] = _entries(listings[name], "inventory.dir." + name)
    report["coordination"] = _coordination(directory, settings,
                                           {"herdrSkill": False, "questionExtension": False} if present is None else present)
    report["summary"] = {name: len(report[name]) for name in ("packages", *RESOURCE_DIRS)}
    return report
