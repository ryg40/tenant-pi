"""Read-only probe of the LLM Wiki personal vault: `lstat` calls only.

The wiki extension keeps the personal vault at `<root>/.llm-wiki/`. The root is `WIKI_HOME`
when that variable is set and not empty, else the home directory. The probe opens no file and
no directory, lists nothing, and writes nothing. Only the last name of a path is not followed.
"""
import os
import stat

VAULT = ".llm-wiki"
KINDS = ("absent", "directory", "symlink", "other", "unreadable")
# `vault_exists`: the personal vault is there. `no_vault`: no vault at either root.
# `second_vault`: `WIKI_HOME` names a root with no vault while the home directory has one.
RESULTS = ("vault_exists", "no_vault", "second_vault")


def path(root):
    """The vault directory of one root, as text."""
    return root.rstrip("/") + "/" + VAULT


def _status(name):
    """The `lstat` result of one path, None when it is absent, or False when the system refuses the call."""
    try:
        return os.lstat(name)
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError:
        return False


def _kind(info):
    if info is None:
        return "absent"
    if info is False:
        return "unreadable"
    return "directory" if stat.S_ISDIR(info.st_mode) else "symlink" if stat.S_ISLNK(info.st_mode) else "other"


def vault(root):
    """The facts of the vault of one root. A vault that is a symbolic link counts as present."""
    place = path(root)
    info = _status(place)
    kind = _kind(info)
    found = {"root": root, "vault": place, "kind": kind, "exists": kind in ("directory", "symlink"),
             "config": False, "doubled": False, "embeddings": {"exists": False, "size": None}, "ownedByUser": None}
    if not found["exists"]:
        return found
    found["ownedByUser"] = info.st_uid == os.geteuid()
    found["config"] = bool(_status(place + "/config.json"))
    # The doubled layout: at a session start the extension moves each inner entry one level up.
    found["doubled"] = bool(_status(place + "/" + VAULT + "/config.json"))
    store = _status(place + "/meta/embeddings.json")
    if store:
        found["embeddings"] = {"exists": True, "size": store.st_size if stat.S_ISREG(store.st_mode) else None}
    return found


def report(home, wiki_home=None):
    """The vault of the home directory, the vault of `WIKI_HOME` when set, and the one that the extension uses."""
    found = {"home": vault(home), "wikiHome": vault(wiki_home) if wiki_home else None}
    found["personalVault"] = "wikiHome" if wiki_home else "home"
    if found[found["personalVault"]]["exists"]:
        found["result"] = "vault_exists"
    else:
        found["result"] = "second_vault" if found["home"]["exists"] else "no_vault"
    return found
