"""The store and the configuration of tenant-artifacts. The CLI and the server share this module.

The store is one directory: `<store>/<slug>/` holds the uploaded bytes in `source` and the facts in `meta.json`.
Python 3 standard library only.
"""
import datetime
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import stat
import tempfile

SERVICE = 'tenant-artifacts'
DEFAULT_PORT = 6790
SLUG = re.compile(r'[A-Za-z0-9_-]{32}')
SOURCE = 'source'
META = 'meta.json'
MAX_BYTES = 10 * 1024 * 1024
RETENTION_MAX = 3650
# The key `remote`: a host name or an SSH alias, with one optional `user@` part. Each part starts with a letter or a
# digit (a user name also with `_`), so no value reads as an option, and no value holds a space or a shell character.
REMOTE = re.compile(r'(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,31}@)?[A-Za-z0-9][A-Za-z0-9._-]{0,252}')
REMOTE_RULE = ('remote is a plain SSH destination: a host name or alias, or user@host, of letters, digits, '
               '".", "_" and "-"; it starts with a letter or a digit; at most 32 characters for the user and 253 '
               'for the host')
# The config keys of the old remote and clone design: the CLI keeps them in the file and ignores them.
OLD_KEYS = ('origin', 'tokenFile', 'clone')
# A file of an artifact directory opens with no symlink at the last part of its path.
NOFOLLOW = os.O_RDONLY | getattr(os, 'O_NOFOLLOW', 0) | getattr(os, 'O_CLOEXEC', 0)


class ConfigError(Exception):
    """The configuration file cannot be read, or a value in it is not valid."""


def absolute_env(name):
    """An absolute path from the environment, or None: a relative value is ignored, as the XDG rule says."""
    value = os.environ.get(name) or ''
    return Path(value) if os.path.isabs(value) else None


def config_path():
    return (absolute_env('XDG_CONFIG_HOME') or Path.home() / '.config') / SERVICE / 'config.json'


def state_dir():
    return (absolute_env('XDG_STATE_HOME') or Path.home() / '.local/state') / SERVICE


def store_dir():
    return (absolute_env('XDG_DATA_HOME') or Path.home() / '.local/share') / SERVICE / 'store'


def load_config():
    """The configuration as a dict; {} when the file is absent."""
    path = config_path()
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as error:
        raise ConfigError(f'cannot read {path}: {type(error).__name__}') from None
    if not isinstance(data, dict):
        raise ConfigError(f'{path} does not hold a JSON object')
    return data


def write_config(data):
    """Replace the configuration file in one step, with mode 0600."""
    path = config_path()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    fd, scratch = tempfile.mkstemp(dir=path.parent, prefix='.config-')
    with os.fdopen(fd, 'w', encoding='utf-8') as handle:
        os.fchmod(handle.fileno(), 0o600)
        handle.write(json.dumps(data, indent=2) + '\n')
    os.replace(scratch, path)


def port_of(data):
    port = data.get('port', DEFAULT_PORT)
    if type(port) is not int or not 1 <= port <= 65535:
        raise ConfigError(f'the port in {config_path()} is not a number from 1 to 65535')
    return port


def remote_of(data):
    """The SSH destination of the key `remote` (a remote store), or None for the store of this computer."""
    value = data.get('remote')
    if value is None:
        return None
    if not valid_remote(value):
        raise ConfigError(f'remote in {config_path()} is not a plain SSH destination')
    return value


def valid_remote(value):
    return isinstance(value, str) and REMOTE.fullmatch(value) is not None


def retention_of(data):
    """The retention in days, or None for no retention."""
    days = data.get('retentionDays')
    if days is None:
        return None
    if type(days) is not int or not 1 <= days <= RETENTION_MAX:
        raise ConfigError(f'retentionDays in {config_path()} is not a number from 1 to {RETENTION_MAX}')
    return days


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)


def iso(moment):
    return moment.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


def parse_time(value):
    """A UTC datetime from an ISO 8601 text with a time zone, or None."""
    if not isinstance(value, str):
        return None
    # Python 3.9 and 3.10 refuse the `Z` form that iso() writes; `+00:00` is the same time.
    if value.endswith('Z'):
        value = value[:-1] + '+00:00'
    try:
        moment = datetime.datetime.fromisoformat(value)
    except ValueError:
        return None
    return moment if moment.tzinfo is not None else None


def last_change(meta):
    """The time of the last change of an artifact: `updatedAt` when it is valid, else `createdAt`; or None."""
    return parse_time(meta.get('updatedAt')) or parse_time(meta.get('createdAt'))


def expiry(meta, days):
    """The expiry time of an artifact as text: `never`, or the ISO time. Retention counts from the last change."""
    changed = last_change(meta)
    if days is None or changed is None:
        return 'never'
    try:
        return iso(changed + datetime.timedelta(days=days))
    except OverflowError:
        # A createdAt near the year 9999: the expiry is after the last date that Python can hold.
        return 'never'


def read_member(store, slug, name, limit=MAX_BYTES):
    """The bytes of one regular file of an artifact directory, or None.

    No symlink is followed: not at the artifact directory and not at the file. A slug that is not valid reads
    nothing."""
    if not SLUG.fullmatch(slug or ''):
        return None
    try:
        folder = os.open(os.path.join(store, slug), NOFOLLOW | os.O_DIRECTORY)
        try:
            fd = os.open(name, NOFOLLOW, dir_fd=folder)
        finally:
            os.close(folder)
        with os.fdopen(fd, 'rb') as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                return None
            data = handle.read(limit + 1)
    except OSError:
        return None
    return data if len(data) <= limit else None


def read_meta(store, slug):
    """The facts of one artifact as a dict, or None when `meta.json` cannot be read or is not valid."""
    raw = read_member(store, slug, META, limit=64 * 1024)
    try:
        meta = json.loads(raw.decode('utf-8')) if raw is not None else None
    except (UnicodeDecodeError, ValueError):
        return None
    if not isinstance(meta, dict) or meta.get('slug') != slug or parse_time(meta.get('createdAt')) is None:
        return None
    return meta


def artifacts(store):
    """The facts of each valid artifact of the store, newest first (by `createdAt`, then by slug)."""
    try:
        names = os.listdir(store)
    except OSError:
        return []
    found = [meta for meta in (read_meta(store, name) for name in names if SLUG.fullmatch(name)) if meta]
    return sorted(found, key=lambda meta: (parse_time(meta['createdAt']), meta['slug']), reverse=True)


def revision(meta):
    """The number of replaces of an artifact: `revision` when it is a whole number from 0, else 0. An artifact
    without the key counts as 0."""
    value = meta.get('revision')
    return value if type(value) is int and value >= 0 else 0


def version(meta):
    """The version of one artifact for the live pages: the time of the last change (the text of `updatedAt` when it
    is valid, else `createdAt`), then ` r<revision>` when the revision is above 0. The times have whole seconds; the
    revision tells two replaces in one second apart."""
    updated = meta.get('updatedAt')
    changed = updated if parse_time(updated) else meta['createdAt']
    count = revision(meta)
    return f'{changed} r{count}' if count else changed


def state(items, retention=''):
    """One value that changes when the list of artifacts, one artifact or the retention text changes: a hash of the
    slugs, their created times, their versions and the retention text."""
    facts = sorted((meta['slug'], meta['createdAt'], version(meta)) for meta in items)
    return hashlib.sha256(json.dumps([retention, facts]).encode('utf-8')).hexdigest()[:24]


def artifact_meta(store, slug):
    """The facts of one artifact, or None. An artifact is a directory directly inside the store, not a symlink,
    whose name is a valid slug and whose `meta.json` can be read and names that slug."""
    if not SLUG.fullmatch(slug or ''):
        return None
    try:
        if not stat.S_ISDIR(os.lstat(os.path.join(store, slug)).st_mode):
            return None
    except OSError:
        return None
    return read_meta(store, slug)


def expired(store, days, now):
    """The slugs of the artifacts whose last change is older than `days` at `now`. None days: no artifact expires.

    An unreadable `meta.json` keeps its artifact."""
    if days is None:
        return []
    limit = now - datetime.timedelta(days=days)
    try:
        names = os.listdir(store)
    except OSError:
        return []
    found = []
    for name in names:
        meta = artifact_meta(store, name)
        if meta is not None and last_change(meta) < limit:
            found.append(name)
    return found


def discard(store, slug):
    """Rename the directory of an artifact to a scratch name inside the store, then remove that directory. The
    rename takes the artifact out of the list in one step; a scratch name starts with `.` and is never a slug.
    A failed rename raises OSError and changes nothing. Return None, or the path of the scratch directory when it
    could not be removed: it stays. shutil.rmtree follows no symlink."""
    scratch = os.path.join(store, '.delete-' + secrets.token_hex(8))
    os.rename(os.path.join(store, slug), scratch)
    try:
        shutil.rmtree(scratch)
    except OSError:
        return scratch
    return None


def sweep(store, days, now):
    """Delete the artifacts older than `days`. Return the deleted slugs and the scratch directories that stay (see
    discard).

    For each chosen artifact, the sweep takes the lock of replace_artifact, reads the facts again and checks the
    limit again. So an artifact that a replace renewed after the choice stays."""
    gone, left = [], []
    if days is None:
        return gone, left
    limit = now - datetime.timedelta(days=days)
    for slug in expired(store, days, now):
        try:
            # No symlink: the open of a link fails.
            folder = os.open(os.path.join(store, slug), NOFOLLOW | os.O_DIRECTORY)
        except OSError:
            continue
        try:
            fcntl.flock(folder, fcntl.LOCK_EX)
            meta = artifact_meta(store, slug)
            if meta is None or not last_change(meta) < limit:
                continue
            scratch = discard(store, slug)
        except OSError:
            continue
        finally:
            os.close(folder)
        gone.append(slug)
        if scratch:
            left.append(scratch)
    return gone, left


def make_store(store):
    Path(store).mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(store, 0o700)


def add_artifact(store, raw, file_name, content_type, title, repo):
    """Write one artifact into the store and return its facts.

    The CLI builds the directory under a scratch name inside the store, then renames it to its slug: the server
    never lists a half-written artifact. A scratch name starts with `.` and is never a slug."""
    make_store(store)
    scratch = tempfile.mkdtemp(dir=store, prefix='.upload-')
    try:
        for _ in range(10):
            slug = secrets.token_urlsafe(24)
            # No slug starts with `-`, so the CLI never reads one as an option.
            if not slug.startswith('-') and not os.path.lexists(os.path.join(store, slug)):
                break
        meta = {'slug': slug, 'title': title, 'fileName': file_name, 'contentType': content_type, 'repo': repo,
                'createdAt': iso(now_utc()), 'byteSize': len(raw)}
        for name, data in ((SOURCE, raw), (META, (json.dumps(meta, indent=2) + '\n').encode('utf-8'))):
            fd = os.open(os.path.join(scratch, name), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
        os.rename(scratch, os.path.join(store, slug))
    except BaseException:
        shutil.rmtree(scratch, ignore_errors=True)
        raise
    return meta


class NotAnArtifact(Exception):
    """A slug that names no artifact of the store."""


def replace_artifact(store, slug, raw, file_name, content_type, title=None, repo=None, keep_repo=True):
    """Store new bytes under an existing slug and return the new facts.

    `slug` and `createdAt` stay; `updatedAt` is now; `revision` is the old revision plus 1; the file name, the
    content type and the size come from the new file. The title stays when `title` is None, and the repo stays
    when `keep_repo` is true.

    Both new files are written beside the old ones first. A failure there removes them and changes nothing. Then
    os.replace moves `source` and then `meta.json` over the old files. A reader gets each file whole, old or new;
    between the two moves it gets the new bytes with the old facts. When the second move fails, the artifact keeps
    the new bytes with the old facts, and the error goes to the caller. A lock on the artifact directory keeps two
    replaces of one slug, and a replace and the sweep, apart."""
    if artifact_meta(store, slug) is None:
        raise NotAnArtifact(slug)
    folder = os.open(os.path.join(store, slug), NOFOLLOW | os.O_DIRECTORY)
    # The scratch files that are not moved yet: name -> scratch name.
    scratches = {}
    try:
        fcntl.flock(folder, fcntl.LOCK_EX)
        old = read_meta(store, slug)
        if old is None:
            raise NotAnArtifact(slug)
        meta = {'slug': slug, 'title': old.get('title') if title is None else title, 'fileName': file_name,
                'contentType': content_type, 'repo': old.get('repo') if keep_repo else repo,
                'createdAt': old['createdAt'], 'updatedAt': iso(now_utc()), 'revision': revision(old) + 1,
                'byteSize': len(raw)}
        for name, data in ((SOURCE, raw), (META, (json.dumps(meta, indent=2) + '\n').encode('utf-8'))):
            # A scratch name starts with `.`; the server reads only `source` and `meta.json`.
            scratch = '.replace-' + secrets.token_hex(8)
            fd = os.open(scratch, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, 'O_NOFOLLOW', 0), 0o600,
                         dir_fd=folder)
            scratches[name] = scratch
            with os.fdopen(fd, 'wb') as handle:
                handle.write(data)
        for name in (SOURCE, META):
            os.replace(scratches[name], name, src_dir_fd=folder, dst_dir_fd=folder)
            del scratches[name]
    finally:
        for scratch in scratches.values():
            try:
                os.unlink(scratch, dir_fd=folder)
            except OSError:
                pass
        os.close(folder)
    return meta


def delete_artifacts(store, slugs, deleted=lambda slug, left: None):
    """Delete the named artifacts with discard and call `deleted(slug, left)` after each one; `left` is None, or the
    path of the scratch directory that stays. Each slug is checked first: when one names no artifact (see
    artifact_meta), NotAnArtifact names it and nothing is deleted. A failed rename raises OSError; that artifact
    and the next ones stay."""
    slugs = list(dict.fromkeys(slugs))
    for slug in slugs:
        if artifact_meta(store, slug) is None:
            raise NotAnArtifact(slug)
    for slug in slugs:
        deleted(slug, discard(store, slug))
