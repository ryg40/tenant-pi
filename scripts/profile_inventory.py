"""Pure, names-only inventory of one explicitly selected Pi profile directory.

Inputs are the already-loaded `settings.json` object, the already-listed direct entries of
the resource directories, and the already-checked presence of the state marker. The module
reads no file, environment, or host state. From the settings it uses the `packages` key
only, and from a package entry only the source string and the names of its filter keys.
"""
import re

from scripts.validate import NPM, Invalid, absolute, fail

RESOURCE_DIRS = ("extensions", "skills", "prompts")
KINDS = ("file", "dir", "symlink", "other")
MAX_SOURCE = 1024
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


def inventory(directory, settings, listings, managed):
    """The deterministic report of one profile directory.

    `settings` is the loaded `settings.json` (`None` when absent). `listings` maps each name
    of `RESOURCE_DIRS` to a list of `(name, kind)` pairs; an absent directory is an empty list.
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
    report["summary"] = {name: len(report[name]) for name in ("packages", *RESOURCE_DIRS)}
    return report
