#!/usr/bin/env python3
"""Choose the kit resources of one profile on one curses screen, then print the selection as JSON.

Input: --inventory FILE, the JSON of scripts/kit_inventory.py (`-` reads stdin), and --catalog FILE,
config/catalog.json. Both must match the schema that scripts/kit_inventory.py states and reads, key
for key; else the script prints one line on stderr and exits 2. A catalog item needs a row in the
inventory. An inventory row without a catalog entry shows the mark `no description`.
Each item starts on when its `active` is true, else off; the `plan` of the inventory never turns an item on.
An installed item that is off, with the plan upgrade or skip, starts off. A `remove` plan shows as a removal.
An installed item that is off with the plan install starts off too: the kit step of the run turns it on.

The plan: with a planner command after `--`, the screen runs it with `--with <the choices that are on, or none>`,
and with `--runtime NAME` after a switch away from the start runtime. The planner prints the inventory JSON of
that selection, as `scripts/kit_inventory.py --json` does, so the screen shows the plan of the dry run, with each
resource that a module brings (for example artifacts-prompt with artifacts). The choices must be `--with`
names of the planner. The screen runs it at the start, 300 ms after the last change of the selection, before
the plan view and on `r`; it keeps each result for its selection. On `r`, the state of each item changes to
the state for the new runtime; the selection of the choices stays. A planner that fails leaves one line in
the status line and in the plan view, and `r` keeps the runtime. Until the planner answers, or without
a planner, the screen estimates the plan: a choice follows the rules of kit_inventory.py (on: install, repair
or keep; off: leave it), and an item that is not a choice keeps the plan of the inventory. With a planner,
Enter confirms only a plan of the planner: after a failure, Enter in the plan view asks the planner again.
Without a planner, Enter confirms the estimate.
Output on stdout, one line:
  {"enable": [...], "disable": [...], "consent": [...], "runtime": "pi|pi-bolt", "confirmed": true|false}
Each item of the screen is in `enable` or `disable`. `consent` lists the requested items: an item that
needs consent and that the screen turned on. The caller asks for that consent before it installs them.
Exit 0 on confirm, 1 on an abort (q or Ctrl-C) only, 2 on an error: one line on stderr, also for an
unexpected exception.

The screen reads the keys from the terminal and draws on it: INSTALL_TEST_TTY (the test seam of
install.sh), else /dev/tty. So stdout carries only the JSON. The script writes no file and no state.
Standard library only; 80x24 or larger; no mouse; color when the terminal has it and NO_COLOR is
empty, else glyphs and text attributes.

Options for a caller such as install.sh:
  --choices A,B     only these items toggle; the others show their state and plan (default: all)
  --exclusive A,B   at most one item of the set is on (repeatable). When the start breaks the rule, one item
                    stays on: an item that is not a choice, else the first in the order of the set
  --replaces A=B    A on removes an installed B (repeatable); the plan of B is `remove`, also with --no-remove
  --requires A=B    A needs B (repeatable): A on turns B on, and B off turns A off
  --no-remove       the caller removes no item that the screen turns off: an installed item that is off keeps
                    the plan `keep`. A `remove` plan of the inventory or of --replaces stays.
  --runtime NAME    the runtime at the start (default: pi)
  --runtimes A,B    the runtimes that `r` switches between (default: the start runtime only); without a planner,
                    `r` offers no other runtime, because the screen cannot read the state for it
  -- PLANNER...     the planner command, for example: python3 scripts/kit_inventory.py --kit K --profile P --json
"""
import argparse
import curses
import json
import locale
import os
import platform
import subprocess
import sys
import textwrap

PLANS = ('install', 'upgrade', 'keep', 'remove', 'skip')
PLAN_TEXT = {'install': '+install', 'upgrade': '^upgrade', 'keep': '=keep', 'remove': '-remove', 'skip': ' off'}
INSTALLED_TEXT = {True: 'yes', 'partial': 'part', False: 'no'}
ACTIVE_TEXT = {True: 'on', False: 'off', None: '-'}
PLATFORMS = {'linux': 'Linux', 'macos': 'macOS'}
HERE = {'Linux': 'linux', 'Darwin': 'macos'}.get(platform.system())
# The schema of scripts/kit_inventory.py: the catalog that it reads and the inventory that it prints.
CATALOG_KEYS = ('schemaVersion', 'groups', 'items')
CATALOG_FIELDS = ('name', 'group', 'title', 'description', 'when_on', 'when_off', 'default', 'needs', 'docs')
CATALOG_TEXT = ('name', 'group', 'title', 'description', 'when_on', 'when_off', 'docs')
DEFAULTS = ('on', 'off', 'ask')
INVENTORY_KEYS = ('profile', 'runtime', 'items')
INVENTORY_FIELDS = ('name', 'group', 'installed', 'active', 'version_installed', 'version_pinned', 'state_source', 'plan')
RUNTIMES = ('pi', 'pi_bolt', 'node', 'python')
RUNTIME_FIELDS = ('installed', 'required', 'status')
STATUSES = ('match', 'untested_in_range', 'mismatch', 'missing', 'unparsed')
NO_DESCRIPTION = 'no description: config/catalog.json has no entry for this item'
LEFT_MIN = 46
ASCII = False
# The planner runs this long after the last change of the selection; a key in this time starts the wait again.
DEBOUNCE_MS = 300
PLANNER_TIMEOUT = 60


class Invalid(Exception):
    pass


def text(value):
    """One line of printable text; no control character reaches the terminal."""
    if value is None or isinstance(value, (bool, dict, list)):
        return ''
    line = ''.join(char if char.isprintable() else ' ' for char in str(value))
    return line.encode('ascii', 'replace').decode() if ASCII else line


def read_json(path, what):
    try:
        if path == '-':
            return json.loads(sys.stdin.read())
        with open(path, encoding='utf-8') as stream:
            return json.load(stream)
    except (OSError, ValueError) as error:
        raise Invalid('cannot read the ' + what + ' ' + path + ': ' + str(error)) from None


def filled(value):
    return isinstance(value, str) and value != ''


def optional(value):
    return value is None or isinstance(value, str)


def exact(value, keys, where):
    """The object with exactly these keys, else Invalid."""
    if not isinstance(value, dict):
        raise Invalid(where + ' is not a JSON object')
    if set(value) != set(keys):
        raise Invalid(where + ' does not match the schema: ' + ', '.join(
            ['no ' + key for key in keys if key not in value] + ['unknown ' + text(key) for key in value if key not in keys]))
    return value


def named(where, value):
    """`where`, and the name of the object when it has one."""
    return where + (' (' + text(value['name']) + ')' if isinstance(value, dict) and filled(value.get('name')) else '')


def read_catalog(data):
    """The group titles by id and the entries by name, in catalog order."""
    exact(data, CATALOG_KEYS, 'the catalog')
    if data['schemaVersion'] != 1:
        raise Invalid('the catalog has schemaVersion ' + text(json.dumps(data['schemaVersion'])) + '; this screen reads 1')
    if not isinstance(data['groups'], list) or not isinstance(data['items'], list):
        raise Invalid('the catalog needs a groups list and an items list')
    groups = {}
    for number, group in enumerate(data['groups'], 1):
        exact(group, ('id', 'title'), 'catalog group ' + str(number))
        if not filled(group['id']) or not filled(group['title']) or group['id'] in groups:
            raise Invalid('catalog group ' + str(number) + ' needs a new id and a title')
        groups[group['id']] = group['title']
    entries = {}
    for number, entry in enumerate(data['items'], 1):
        where = named('catalog item ' + str(number), entry)
        exact(entry, CATALOG_FIELDS, where)
        bad = [field for field in CATALOG_TEXT if not filled(entry[field])]
        bad += [] if entry['default'] in DEFAULTS else ['default']
        bad += [] if isinstance(entry['needs'], list) and all(filled(need) for need in entry['needs']) else ['needs']
        if bad:
            raise Invalid(where + ' has no valid ' + ', '.join(bad))
        if entry['group'] not in groups:
            raise Invalid(where + ' names a group that the catalog does not list')
        if entry['name'] in entries:
            raise Invalid(where + ' repeats a name')
        entries[entry['name']] = entry
    return groups, entries


def read_inventory(data):
    """The rows by name, in inventory order."""
    exact(data, INVENTORY_KEYS, 'the inventory')
    if not filled(data['profile']):
        raise Invalid('the inventory has no profile')
    exact(data['runtime'], RUNTIMES, 'the inventory runtime')
    for key in RUNTIMES:
        found = exact(data['runtime'][key], RUNTIME_FIELDS, 'the inventory runtime ' + key)
        if not optional(found['installed']) or not optional(found['required']) or found['status'] not in STATUSES:
            raise Invalid('the inventory runtime ' + key + ' has no valid installed, required or status')
    if not isinstance(data['items'], list):
        raise Invalid('the inventory has no items list')
    states = {}
    for number, state in enumerate(data['items'], 1):
        where = named('inventory item ' + str(number), state)
        exact(state, INVENTORY_FIELDS, where)
        installed, active = state['installed'], state['active']
        bad = [field for field in ('name', 'group') if not filled(state[field])]
        bad += [] if installed is True or installed is False or installed == 'partial' else ['installed']
        bad += [] if active is True or active is False or active is None else ['active']
        bad += [field for field in ('version_installed', 'version_pinned') if not optional(state[field])]
        bad += [] if isinstance(state['state_source'], list) and all(filled(one) for one in state['state_source']) \
            else ['state_source']
        bad += [] if isinstance(state['plan'], str) and state['plan'] in PLANS else ['plan']
        # keep: installed and on, or without an on/off state. install: absent, or installed and off when the kit
        # step of the run turns it on. An installed item that is off is skip.
        if not bad and state['plan'] == 'keep' and (installed is False or active is False):
            bad.append('plan keep for an item that is absent or off')
        if not bad and state['plan'] == 'install' and installed is not False and active is not False:
            bad.append('plan install for an item that is present and not off')
        if bad:
            raise Invalid(where + ' has no valid ' + ', '.join(bad))
        if state['name'] in states:
            raise Invalid(where + ' repeats a name')
        states[state['name']] = state
    return states


class Item:
    def __init__(self, name, entry, state):
        self.name = text(name)
        self.group = (entry or state)['group']
        self.described = entry is not None
        entry = entry or {'title': name, 'description': '', 'when_on': '', 'when_off': '', 'needs': [], 'docs': ''}
        self.title = text(entry['title'])
        self.description = text(entry['description'])
        self.when_on = text(entry['when_on'])
        self.when_off = text(entry['when_off'])
        self.needs = [text(need) for need in entry['needs']]
        self.docs = text(entry['docs'])
        self.load(state)
        # The selection starts from `active` only: a plan of upgrade or skip for an item that is off keeps it off.
        self.initial = self.active is True
        self.on = self.initial
        self.choice = True
        wanted = [need for need in self.needs if need in PLATFORMS]
        self.blocked = None if not wanted or HERE in wanted else 'needs ' + ' or '.join(PLATFORMS[n] for n in wanted)
        self.consent = 'consent' in self.needs

    def load(self, state):
        """The state of the item in the profile, from one inventory row."""
        self.installed = state['installed']
        self.active = state['active']
        self.version_installed = text(state['version_installed'])
        self.version_pinned = text(state['version_pinned'])
        self.sources = [text(source) for source in state['state_source']]
        self.start_plan = state['plan']

    @property
    def requested(self):
        """On by a toggle of this screen and in need of consent: the caller asks for it after the screen."""
        return self.consent and self.on and not self.initial


class Model:
    """The items in catalog order, grouped, and the state of the selection. No curses here."""

    def __init__(self, inventory, catalog, choices=None, exclusive=(), no_remove=False, runtime='pi', runtimes=(),
                 replaces=(), planner=None, requires=()):
        groups, entries = read_catalog(catalog)
        states = read_inventory(inventory)
        missing = [text(name) for name in entries if name not in states]
        if missing:
            raise Invalid('the inventory has no row for the catalog item ' + ', '.join(missing))
        items = [Item(name, entries.get(name), states[name]) for name in dict.fromkeys([*entries, *states])]
        if not items:
            raise Invalid('the catalog and the inventory have no item')
        order = list(dict.fromkeys([*groups, *(item.group for item in items)]))
        self.items = sorted(items, key=lambda item: order.index(item.group))
        self.rows = []
        for group in order:
            members = [('item', item) for item in self.items if item.group == group]
            if members:
                self.rows += [('group', text(groups.get(group, group)))] + members
        if choices is not None:
            for item in self.items:
                item.choice = item.name in choices
        self.exclusive = [list(dict.fromkeys(names)) for names in exclusive]
        self.replaces = list(replaces)
        self.requires = list(requires)
        self.no_remove = no_remove
        self.runtime = self.start_runtime = runtime
        # Without a planner the screen cannot read the state for another runtime, so it offers none.
        self.runtimes = list(dict.fromkeys([runtime, *runtimes])) if planner else [runtime]
        self.planner = list(planner) if planner else None
        # The planner results by selection key, the plans of the selection on the screen, and the last failure.
        self.results, self.planned, self.planned_for, self.failed_for, self.plan_error = {}, None, None, None, ''
        self.note = None
        self.profile = text(inventory['profile'])
        self.load_runtime(inventory)
        self.cursor = next(index for index, row in enumerate(self.rows) if row[0] == 'item')
        # The start can break a one-of rule, for example when the profile holds both items. The first item that is
        # on stays on: an item that is not a choice of this run, else the first in the order of --exclusive.
        notes = []
        for names in self.exclusive:
            found = sorted((item for item in self.items if item.name in names and item.on),
                           key=lambda item: (item.choice, names.index(item.name)))
            for item in found[1:]:
                item.on = False
                notes.append(item.name + ' starts off: only one of ' + ', '.join(names) + ' can be on')
        self.message = '; '.join(notes)

    def load_runtime(self, inventory):
        """The installed version and the pin (`required`) of each runtime key: pi, pi_bolt, node, python."""
        self.versions = {key: (text(value['installed']), text(value['required']))
                         for key, value in inventory['runtime'].items()}
        self.states_runtime = self.runtime

    def key(self):
        """The selection that a plan belongs to: the choices that are on, and the runtime."""
        return tuple(item.name for item in self.items if item.choice and item.on), self.runtime

    @property
    def stale(self):
        """True when the planner has neither answered nor failed for the selection on the screen."""
        return self.planner is not None and self.key() not in (self.planned_for, self.failed_for)

    @property
    def confirmable(self):
        """True when Enter in the plan view can confirm: the planner answered for the selection on the screen.
        Without a planner, the estimate of this screen is the plan."""
        return self.planner is None or self.planned_for == self.key()

    def refresh(self, retry=False):
        """Ask the planner for the plan of the selection; True when the screen shows the plans of the planner.

        A new runtime also changes the state of each item: the planner reads the profile for that runtime. The
        choices keep their selection; an item that is not a choice follows its new `active`."""
        if self.planner is None:
            return False
        key = self.key()
        if key == self.planned_for:
            return True
        if key == self.failed_for and not retry:
            return False
        if key not in self.results:
            command = self.planner + ['--with', ','.join(key[0]) or 'none']
            if self.runtime != self.start_runtime:
                command += ['--runtime', self.runtime]
            try:
                done = subprocess.run(command, stdin=subprocess.DEVNULL, capture_output=True, timeout=PLANNER_TIMEOUT)
                if done.returncode != 0:
                    lines = [line for line in done.stderr.decode(errors='replace').splitlines() if line.strip()]
                    raise Invalid('exit ' + str(done.returncode) + (': ' + lines[-1] if lines else ''))
                data = json.loads(done.stdout)
                self.results[key] = data, read_inventory(data)
            except subprocess.TimeoutExpired:
                self.failed_for, self.plan_error = key, 'the planner gave no plan in ' + str(PLANNER_TIMEOUT) + ' s'
                return False
            except (OSError, ValueError, Invalid) as error:
                self.failed_for, self.plan_error = key, 'the planner gave no plan: ' + text(error)
                return False
        data, states = self.results[key]
        if self.states_runtime != self.runtime:
            for item in self.items:
                if item.name in states:
                    item.load(states[item.name])
                    if not item.choice:
                        item.on = item.active is True
            self.load_runtime(data)
        self.planned = {name: state['plan'] for name, state in states.items()}
        # A failure blocks a new call only while its selection stays on the screen.
        self.planned_for, self.failed_for, self.plan_error = key, None, ''
        return True

    @property
    def item(self):
        return self.rows[self.cursor][1]

    def move(self, steps):
        """Move the cursor `steps` rows; it stops on an item row, never on a group header."""
        positions = [index for index, row in enumerate(self.rows) if row[0] == 'item']
        target = max(0, min(len(self.rows) - 1, self.cursor + steps))
        after = [index for index in positions if (index >= target if steps >= 0 else index <= target)]
        self.cursor = (after[0] if steps >= 0 else after[-1]) if after else (positions[-1] if steps >= 0 else positions[0])

    def others(self, item):
        return [other for other in self.items if other is not item and other.on
                and any({item.name, other.name} <= set(names) for names in self.exclusive)]

    def replacing(self, item):
        """The items that are on and that replace this item."""
        return [other for new, old in self.replaces if old == item.name
                for other in self.items if other.name == new and other.on]

    def replaced(self, item):
        """The installed items that this item replaces while it is on."""
        return [other for new, old in self.replaces if new == item.name and item.on
                for other in self.items if other.name == old and other.installed and not other.on]

    def plan(self, item):
        """The plan of the run with the selection of this screen: the plan of the planner for this selection, else
        the estimate of this screen. The run leaves each own switch as it is."""
        if self.planned is not None and self.planned_for == self.key() and item.name in self.planned:
            return self.planned[item.name]
        if item.installed and not item.on and self.replacing(item):
            return 'remove'
        if not item.choice or (item.on == item.initial and item.start_plan == 'remove'):
            return item.start_plan
        if not item.on:
            # The run leaves the item: absent or off stays skip, an installed item that is on stays.
            if item.installed is False or item.active is False:
                return 'skip'
            return 'keep' if self.no_remove else 'remove'
        if item.installed is False:
            return 'install'
        changed = item.version_pinned and item.version_installed and item.version_installed != item.version_pinned
        if item.start_plan == 'upgrade' or item.installed == 'partial' or changed:
            return 'upgrade'
        return 'skip' if item.active is False else 'keep'

    def needed(self, item):
        """The choices that this item needs (--requires), on or off."""
        return [other for new, old in self.requires if new == item.name
                for other in self.items if other.name == old and other.choice]

    def needing(self, item):
        """The items that are on and that need this item."""
        return [other for new, old in self.requires if old == item.name
                for other in self.items if other.name == new and other.on]

    def toggle(self, item):
        if not item.choice:
            self.message = item.name + ' is not a choice of this run; the installer sets it'
        elif item.on:
            item.on = False
            dropped = self.needing(item)
            for other in dropped:
                other.on = False
            self.message = item.name + ': off' + (
                '; ' + ', '.join(other.name for other in dropped) + ' off (they need it)' if dropped else '')
            # The status adds what the plan does with the installed item (status()).
            self.note = (item, self.message) if item.installed is not False else None
        elif item.blocked or any(other.blocked for other in self.needed(item)):
            self.message = item.name + ' ' + (item.blocked or 'needs an item of another platform') + '; it stays off'
        else:
            item.on = True
            turned = self.others(item)
            for other in turned:
                other.on = False
            added = [other for other in self.needed(item) if not other.on]
            for other in added:
                other.on = True
            parts = [item.name + (': requested; the installer asks for your consent after this screen'
                                  if item.requested else ': on')]
            if added:
                parts.append(', '.join(other.name for other in added) + ' on (' + item.name + ' needs it)')
            if turned:
                parts.append(', '.join(other.name for other in turned) + ' off (choose one of them)')
            removed = [other.name for other in self.replaced(item)]
            if removed:
                parts.append('the run removes ' + ', '.join(removed))
            self.message = '; '.join(parts)

    def status(self):
        """The message of the last key. After Space turned an installed item off, the plan of the item follows:
        the plan of the planner for this selection, else the estimate of this screen. While the planner has not
        read this selection, the status says nothing about a removal."""
        item, message = self.note or (None, None)
        if item is None or message != self.message or item.on:
            return self.message
        if self.planner is not None and self.planned_for != self.key():
            return self.message
        plan = self.plan(item)
        if plan == 'remove':
            return self.message + '; the run removes it'
        if plan in ('keep', 'skip'):
            return self.message + '; the run removes no installed module'
        return self.message

    def all_on(self):
        turned, kept = 0, []
        for item in self.items:
            if not item.choice or item.on:
                continue
            if item.blocked or item.consent or self.others(item):
                kept.append(item.name)
                continue
            item.on = True
            turned += 1
        # An item whose needed item stays off goes off again.
        for item in self.items:
            if item.choice and item.on and any(not other.on for other in self.needed(item)):
                item.on = False
                turned -= 1
                kept.append(item.name)
        self.message = 'a: ' + str(turned) + ' on'
        if kept:
            self.message += ', ' + str(len(kept)) + ' stay off (consent, platform or one-of rule: use Space)'

    def all_off(self):
        turned = [item for item in self.items if item.choice and item.on]
        for item in turned:
            item.on = False
        self.message = 'n: ' + str(len(turned)) + ' off'

    def runtime_text(self):
        """The runtime with its installed version and its pin, for example `pi 1.5.0, pin 1.5.0`."""
        installed, pinned = self.versions.get('pi_bolt' if self.runtime == 'pi-bolt' else 'pi', ('', ''))
        return self.runtime + ' ' + (installed or 'not found') + (', pin ' + pinned if pinned else '')

    def switch_runtime(self):
        """The next runtime, with the state and the plan that the planner reads for it; a failure keeps the runtime."""
        if len(self.runtimes) < 2:
            self.message = 'only runtime ' + self.runtime + ' is offered; to switch, run install.sh with --runtime'
            return
        old = self.runtime
        self.runtime = self.runtimes[(self.runtimes.index(old) + 1) % len(self.runtimes)]
        if self.refresh(retry=True):
            self.message = 'runtime: ' + self.runtime + '; the state and the plan are those of ' + self.runtime
        else:
            self.runtime, self.message = old, 'the runtime stays ' + old + '; ' + self.plan_error

    def plans(self):
        found = {plan: [] for plan in PLANS}
        for item in self.items:
            found[self.plan(item)].append(item.name)
        return found

    def selection(self, confirmed):
        return {'enable': [item.name for item in self.items if item.on],
                'disable': [item.name for item in self.items if not item.on],
                'consent': [item.name for item in self.items if item.requested],
                'runtime': self.runtime, 'confirmed': confirmed}


def styles():
    plain = curses.A_NORMAL
    color = {}
    if curses.has_colors() and not os.environ.get('NO_COLOR'):
        curses.start_color()
        try:
            curses.use_default_colors()
            background = -1
        except curses.error:
            background = curses.COLOR_BLACK
        for number, (name, value) in enumerate((('green', curses.COLOR_GREEN), ('yellow', curses.COLOR_YELLOW),
                                                ('cyan', curses.COLOR_CYAN), ('red', curses.COLOR_RED),
                                                ('magenta', curses.COLOR_MAGENTA)), 1):
            curses.init_pair(number, value, background)
            color[name] = curses.color_pair(number)
    bold, dim, under = curses.A_BOLD, curses.A_DIM, curses.A_UNDERLINE
    if color:
        return {'yes': color['green'], 'part': color['yellow'] | bold, 'no': dim, 'on': color['green'], 'off': dim,
                '-': dim, 'install': color['cyan'] | bold, 'upgrade': color['yellow'] | bold, 'keep': color['green'],
                'remove': color['red'] | bold, 'skip': dim, 'group': color['magenta'] | bold, 'label': bold,
                'warn': color['red'] | bold, 'bar': curses.A_REVERSE | bold, 'key': curses.A_REVERSE, 'plain': plain}
    return {'yes': bold, 'part': bold | under, 'no': dim, 'on': bold, 'off': dim, '-': dim, 'install': bold,
            'upgrade': bold | under, 'keep': plain, 'remove': under, 'skip': dim, 'group': bold | under,
            'label': bold, 'warn': bold, 'bar': curses.A_REVERSE | bold, 'key': curses.A_REVERSE, 'plain': plain}


def put(window, y, x, value, attr=curses.A_NORMAL, width=None):
    """Write clipped text; a write into the last cell of a window raises in curses, so ignore that."""
    height, columns = window.getmaxyx()
    if y < 0 or y >= height or x >= columns:
        return
    room = columns - x if width is None else min(width, columns - x)
    try:
        window.addnstr(y, x, value, max(0, room), attr)
    except curses.error:
        pass


def fit(value, width):
    return value if len(value) <= width else value[:max(0, width - 1)] + '~'


def wrap(value, width):
    return textwrap.wrap(value, width, break_on_hyphens=False) or ['-']


class Screen:
    def __init__(self, window, model):
        self.window = window
        self.model = model
        self.style = styles()
        self.top = 0
        self.detail_cursor, self.detail_page, self.detail_pages = None, 0, 1
        self.plan_top, self.plan_more = 0, False

    def run(self):
        """The key loop. True on confirm, False on abort."""
        view = 'list'
        while True:
            self.draw(view)
            # While the plan is stale, the wait for a key ends after DEBOUNCE_MS; then the planner runs.
            self.window.timeout(DEBOUNCE_MS if self.model.stale else -1)
            try:
                key = read_key(self.window)
            except curses.error:
                key = -1
            if key == -1:
                if self.model.stale:
                    self.busy('kit_inventory.py reads the plan of this selection ...')
                    self.model.refresh()
                continue
            if key == curses.KEY_RESIZE:
                continue
            if self.too_small():
                if key in ('q', 'Q'):
                    return False
                continue
            if view == 'plan':
                if key in ('\n', '\r', curses.KEY_ENTER):
                    if self.model.confirmable:
                        return True
                    # After a failure of the planner, the table is an estimate: Enter asks the planner again. A key
                    # typed during the call is dropped, so it cannot confirm a table that the user did not see.
                    self.busy('kit_inventory.py reads the plan of this selection ...')
                    self.model.refresh(retry=True)
                    curses.flushinp()
                    continue
                if key in ('q', 'Q'):
                    return False
                page = max(1, self.window.getmaxyx()[0] - 8)
                steps = {curses.KEY_UP: -1, curses.KEY_DOWN: 1, curses.KEY_PPAGE: -page, curses.KEY_NPAGE: page,
                         curses.KEY_HOME: -10 ** 6, curses.KEY_END: 10 ** 6}
                if key in steps:
                    self.plan_top += steps[key]
                else:
                    view = 'list'
                continue
            if view == 'help':
                view = 'list'
                continue
            self.model.message = ''
            if key == curses.KEY_UP:
                self.model.move(-1)
            elif key == curses.KEY_DOWN:
                self.model.move(1)
            elif key == curses.KEY_PPAGE:
                self.model.move(-self.list_height())
            elif key == curses.KEY_NPAGE:
                self.model.move(self.list_height())
            elif key == curses.KEY_HOME:
                self.model.move(-len(self.model.rows))
            elif key == curses.KEY_END:
                self.model.move(len(self.model.rows))
            elif key == ' ':
                self.model.toggle(self.model.item)
            elif key == 'a':
                self.model.all_on()
            elif key == 'n':
                self.model.all_off()
            elif key == 'd':
                self.detail_page += 1
                if self.detail_pages < 2:
                    self.model.message = 'the details of ' + self.model.item.name + ' fit on one page'
            elif key == 'r':
                if len(self.model.runtimes) > 1:
                    self.busy('kit_inventory.py reads the state of the profile for the next runtime ...')
                self.model.switch_runtime()
            elif key == '?':
                view = 'help'
            elif key in ('p', '\n', '\r', curses.KEY_ENTER):
                # The plan view shows the plan of the planner, so it waits for the planner, also after a failure.
                if self.model.planner and self.model.planned_for != self.model.key():
                    self.busy('kit_inventory.py reads the plan of this selection ...')
                    self.model.refresh(retry=True)
                view, self.plan_top = 'plan', 0
            elif key in ('q', 'Q'):
                return False

    def too_small(self):
        height, width = self.window.getmaxyx()
        return height < 24 or width < 80

    def busy(self, message):
        """A wait line in the status line before a call of the planner, which takes a moment."""
        if self.too_small():
            return
        height, width = self.window.getmaxyx()
        put(self.window, height - 2, 0, ' ' * width)
        put(self.window, height - 2, 1, fit(message, width - 2), self.style['label'])
        self.window.refresh()

    def list_height(self):
        return max(1, self.window.getmaxyx()[0] - 6)

    def draw(self, view):
        window = self.window
        window.erase()
        height, width = window.getmaxyx()
        if self.too_small():
            message = 'The terminal is %dx%d; this screen needs 80x24. Resize it, or press q to abort.' % (width, height)
            for y, line in enumerate(wrap(message, max(10, width - 1))):
                put(window, y, 0, line, self.style['warn'])
            window.refresh()
            return
        name = os.path.basename(self.model.profile.rstrip('/')) or self.model.profile or '-'
        put(window, 0, 0, ' ' * width, self.style['bar'])
        bar = 'runtime ' + fit(self.model.runtime_text(), 40) + ' '
        put(window, 0, 1, fit('tenant-pi kit: resources of profile ' + name, width - len(bar) - 3), self.style['bar'])
        put(window, 0, width - len(bar) - 1, bar, self.style['bar'])
        if view == 'plan':
            self.draw_plan(height, width)
        elif view == 'help':
            self.draw_help(height, width)
        else:
            left = max(LEFT_MIN, min(width // 2, 64))
            self.draw_list(window.derwin(height - 3, left, 1, 0))
            self.draw_detail(window.derwin(height - 3, width - left, 1, left))
            self.draw_status(height - 2, width)
        self.draw_footer(height - 1, width, view)
        window.refresh()

    def draw_list(self, pane):
        pane.box()
        height, width = pane.getmaxyx()
        put(pane, 0, 2, ' Resources ', self.style['label'])
        inner = width - 2
        name_width = inner - 24
        put(pane, 1, 1, fit('     ' + 'Resource'.ljust(name_width) + ' Inst Act Plan', inner), self.style['label'])
        rows = height - 3
        model = self.model
        if model.cursor < self.top:
            self.top = model.cursor
        if model.cursor >= self.top + rows:
            self.top = model.cursor - rows + 1
        if self.top == model.cursor and self.top > 0 and model.rows[self.top - 1][0] == 'group':
            self.top -= 1
        for line, (kind, value) in enumerate(model.rows[self.top:self.top + rows]):
            y = line + 2
            if kind == 'group':
                label = ' ' + fit(value, inner - 4) + ' '
                pane.hline(y, 1, curses.ACS_HLINE, inner)
                put(pane, y, 2, label, self.style['group'])
                continue
            item = value
            selected = self.top + line == model.cursor
            if item.choice:
                box = '[?]' if item.requested else '[x]' if item.on else '[!]' if item.blocked else '[ ]'
            else:
                box = '(x)' if item.on else '( )'
            plan = model.plan(item)
            row = ' ' + box + ' ' + fit(item.name, name_width).ljust(name_width) + ' '
            highlight = curses.A_REVERSE if selected else 0
            put(pane, y, 1, row.ljust(inner), highlight | (self.style['plain'] if item.choice else curses.A_DIM))
            x = 1 + len(row)
            for value_text, attr, size in ((INSTALLED_TEXT[item.installed], self.style[INSTALLED_TEXT[item.installed]], 5),
                                           (ACTIVE_TEXT[item.active], self.style[ACTIVE_TEXT[item.active]], 4),
                                           (PLAN_TEXT[plan], self.style[plan], 8)):
                put(pane, y, x, value_text.ljust(size), attr | highlight, size)
                x += size
        if self.top > 0:
            put(pane, 1, width - 3, '^', self.style['label'])
        if self.top + rows < len(model.rows):
            put(pane, height - 1, width - 3, 'v', self.style['label'])

    def detail_lines(self, item, width):
        """(label, text, attribute, first line of the field) for each line of the details."""
        model = self.model
        plan = model.plan(item)
        state = {True: 'installed', 'partial': 'partly installed', False: 'not installed'}[item.installed]
        state += {True: ', active', False: ', inactive', None: ''}[item.active]
        versions = ', '.join(part for part in (item.version_installed,
                                               ('pin ' + item.version_pinned) if item.version_pinned else '') if part)
        notes = []
        if not item.choice:
            notes.append('not a choice on this screen; the installer sets it, or asks about it after the screen')
        if item.blocked:
            notes.append(item.blocked + '; it stays off')
        if item.requested:
            notes.append('requested: the installer asks for your consent after this screen')
        elif item.consent and item.choice and not item.on and not item.initial and not item.blocked:
            notes.append('needs your consent: Space requests it, and the installer asks after this screen')
        if item.active is False and item.installed is not False and plan == 'install':
            notes.append('it is off now; the kit step of this upgrade turns it on once, and kit-steps.json of the '
                         'profile records the step')
        if item.active is False and item.installed is not False and plan in ('upgrade', 'skip'):
            # Its own switch, a filter or a link of the profile keeps it off, also after a kit step.
            notes.append('it is off; the run ' + ('repairs it and ' if plan == 'upgrade' else '') + 'leaves it off')
        replacing = model.replacing(item)
        if plan == 'remove' and replacing:
            notes.append(', '.join(other.name for other in replacing) + ' replaces it: the run removes it')
        elif not item.on and item.installed and model.no_remove and plan == 'keep':
            notes.append('the run removes nothing here, so it stays installed')
        replaced = model.replaced(item)
        if replaced:
            notes.append('it replaces ' + ', '.join(other.name for other in replaced) + ': the run removes it')
        about = (item.description, self.style['plain']) if item.described else (NO_DESCRIPTION, self.style['warn'])
        # The plan and the effects of on and off come first, so that the first page shows them in full at 80x24.
        # The state and the versions follow; the Inst and Act columns of the list also show the state.
        fields = [('Plan', PLAN_TEXT[plan].strip(), self.style[plan]),
                  ('On', item.when_on, self.style['plain']), ('Off', item.when_off, self.style['plain']),
                  ('State', state, self.style['plain']), ('Ver', versions, self.style['plain']),
                  ('About', *about), ('Needs', ', '.join(item.needs), self.style['plain']),
                  *(('Note', note, self.style['warn']) for note in notes), ('Docs', item.docs, self.style['plain']),
                  *(('From', source, self.style['plain']) for source in item.sources)]
        lines = [(None, item.title, self.style['label'], True)]
        if item.title != item.name:
            lines.append(('Name', item.name, self.style['plain'], True))
        # A value starts in column 8 of the pane and fills the room that draw_detail gives it.
        for label, value, attr in fields:
            if value:
                lines += [(label, part, attr, number == 0) for number, part in enumerate(wrap(value, width - 6))]
        return lines

    def draw_detail(self, pane):
        """The title, then one page of the other lines; `d` shows the next page."""
        pane.box()
        height, width = pane.getmaxyx()
        put(pane, 0, 2, ' Details ', self.style['label'])
        model = self.model
        if self.detail_cursor != model.cursor:
            self.detail_cursor, self.detail_page = model.cursor, 0
        lines = self.detail_lines(model.item, width - 4)
        per = max(1, height - 3)
        self.detail_pages = max(1, -(-(len(lines) - 1) // per))
        self.detail_page %= self.detail_pages
        shown = lines[:1] + lines[1 + self.detail_page * per:1 + (self.detail_page + 1) * per]
        for y, (label, value, attr, first) in enumerate(shown, 1):
            if label is None:
                put(pane, y, 2, fit(value, width - 4), attr)
                continue
            put(pane, y, 2, (label if first or y == 2 else '').ljust(6), self.style['label'])
            put(pane, y, 8, value, attr, width - 10)
        if self.detail_pages > 1:
            mark = ' d more %d/%d ' % (self.detail_page + 1, self.detail_pages)
            put(pane, height - 1, width - len(mark) - 2, mark, self.style['label'])

    def draw_status(self, y, width):
        model = self.model
        # A failure of the planner for this selection comes first; the message of the last key follows it.
        failed = model.plan_error if model.failed_for == model.key() else ''
        message = model.status()
        if message or failed:
            put(self.window, y, 1, fit('; '.join(part for part in (failed, message) if part), width - 2),
                self.style['warn'])
            return
        x = 1
        for plan, names in model.plans().items():
            part = PLAN_TEXT[plan].strip() + ' ' + str(len(names)) + '  '
            put(self.window, y, x, part, self.style[plan])
            x += len(part)

    def draw_footer(self, y, width, view):
        if view == 'plan':
            keys = [*([('Up/Dn', 'scroll')] if self.plan_more else []),
                    ('Enter', 'confirm' if self.model.confirmable else 'retry'), ('Esc', 'back'), ('q', 'abort')]
        elif view == 'help':
            keys = [('any key', 'back')]
        else:
            keys = [('Up/Dn', 'move'), ('Space', 'toggle'), ('a', 'all'), ('n', 'none'),
                    *([('r', 'runtime')] if len(self.model.runtimes) > 1 else []),
                    ('?', 'help'), ('Enter', 'plan'), ('q', 'abort')]

        def size(gap):
            return sum(len(key) + 1 + len(label) for key, label in keys) + gap * (len(keys) - 1)
        # Two spaces between the keys when they fit, else one. Move, toggle, plan and abort always stay.
        for dropped in ('n', 'a', 'r', '?'):
            if size(1) <= width - 2:
                break
            keys = [one for one in keys if one[0] != dropped]
        gap = 2 if size(2) <= width - 2 else 1
        x = 1
        for key, label in keys:
            put(self.window, y, x, key, self.style['key'])
            put(self.window, y, x + len(key) + 1, label)
            x += len(key) + 1 + len(label) + gap

    def boxed(self, height, width, inner_width):
        box_width = min(width, inner_width + 2)
        pane = self.window.derwin(height - 3, box_width, 1, (width - box_width) // 2)
        pane.box()
        return pane

    def draw_plan(self, height, width):
        """The plan table; Up and Down scroll its rows when they do not fit."""
        model = self.model
        plans = model.plans()
        pane = self.boxed(height, width, 76)
        box_height, box_width = pane.getmaxyx()
        first, second = 11, 19
        items_width = box_width - second - 3
        rows = [(PLAN_TEXT[plan], str(len(plans[plan])), plans[plan], self.style[plan]) for plan in PLANS]
        rows.append(('runtime', '', [model.runtime], self.style['label']))
        consent = [item.name + ' (asked next)' for item in model.items if item.requested]
        if consent:
            rows.append(('consent', '', consent, self.style['warn']))
        entries = []
        for number, (label, count, names, attr) in enumerate(rows):
            if number == len(PLANS):
                entries.append(None)
            entries += [(label, count, line, attr, index == 0) for index, line in enumerate(lines_of(names, items_width))]
        room = box_height - 4
        self.plan_more = len(entries) > room
        self.plan_top = max(0, min(self.plan_top, len(entries) - room))
        shown = entries[self.plan_top:self.plan_top + room]
        for x in (first, second):
            pane.vline(1, x, curses.ACS_VLINE, box_height - 2)
            pane.addch(0, x, curses.ACS_TTEE)
            pane.addch(box_height - 1, x, curses.ACS_BTEE)
        put(pane, 1, 2, 'Action', self.style['label'])
        put(pane, 1, first + 2, 'Count', self.style['label'])
        put(pane, 1, second + 2, 'Items', self.style['label'])
        self.rule(pane, 2, box_width, first, second)
        for offset, entry in enumerate(shown):
            y = 3 + offset
            if entry is None:
                self.rule(pane, y, box_width, first, second)
                continue
            label, count, line, attr, start = entry
            if start or offset == 0:
                put(pane, y, 2, label, attr)
                put(pane, y, second - 2 - len(count), count, attr)
            put(pane, y, second + 2, line, curses.A_NORMAL, items_width)
        profile = os.path.basename(model.profile.rstrip('/')) or '-'
        put(pane, 0, 2, fit((' Confirm the plan for profile ' if model.confirmable else
                             ' Estimate only, no plan to confirm, for profile ') + profile + ' ', box_width - 4),
            self.style['label'])
        if self.plan_more:
            mark = ' rows %d-%d of %d, Up/Dn ' % (self.plan_top + 1, self.plan_top + len(shown), len(entries))
            put(pane, box_height - 1, box_width - len(mark) - 2, mark, self.style['label'])
        if not model.confirmable:
            # The planner failed: the table is the estimate of this screen, and Enter asks the planner again.
            put(self.window, height - 2, 1, fit('No confirmation: ' + model.plan_error, width - 2), self.style['warn'])
        elif model.no_remove:
            # Each form fits the 78 columns of an 80-column terminal.
            note = ('The run removes only -remove items.' if plans['remove'] else 'The run removes no item.')
            note += (' Off items stay off, except +install rows.'
                     if any(item.installed is not False and model.plan(item) == 'install' for item in model.items)
                     else ' An installed item that is off stays.')
            put(self.window, height - 2, 1, fit(note, width - 2), self.style['plain'])

    def rule(self, pane, y, width, first, second):
        pane.hline(y, 1, curses.ACS_HLINE, width - 2)
        for x, char in ((0, curses.ACS_LTEE), (first, curses.ACS_PLUS), (second, curses.ACS_PLUS),
                        (width - 1, curses.ACS_RTEE)):
            try:
                pane.addch(y, x, char)
            except curses.error:
                pass

    def draw_help(self, height, width):
        model = self.model
        lines = [
            ('Keys', ''),
            ('  Up, Down', 'move one row; PgUp, PgDn move one page; Home, End'),
            ('  Space', 'turn the item on or off; [?] for an item that needs consent'),
            ('  a, n', 'all on (not consent, platform or one-of items); all off'),
            ('  d', 'the next page of the details, when they do not fit'),
            ('  r', 'switch the runtime, and read its state again: ' + ', '.join(model.runtimes)),
            ('  p, Enter', 'show the plan; Up/Dn scroll, Enter confirms or retries'),
            ('  q', 'abort; the installer writes nothing'),
            ('Columns', ''),
            ('  Inst', 'yes installed, part partly installed, no not installed'),
            ('  Act', 'on active in the profile, off inactive, - no switch'),
            ('  Plan', '+install ^upgrade =keep -remove; off: left absent or off'),
            ('Marks', '[x] on, [ ] off, [?] requested: consent after the screen'),
            ('', '[!] needs another platform, (x) ( ) set by the installer'),
            ('Runtime', 'installed version, pin of the kit'),
        ]
        lines += [('  ' + key, (installed or 'not found') + (', pin ' + pinned if pinned else ''))
                  for key, (installed, pinned) in model.versions.items()]
        pane = self.boxed(height, width, 76)
        put(pane, 0, 2, ' Help ', self.style['label'])
        box_width = pane.getmaxyx()[1]
        for y, (label, value) in enumerate(lines, 1):
            put(pane, y, 2, label, self.style['label'])
            put(pane, y, 14, value, self.style['plain'], box_width - 16)


def read_key(window):
    """A character as a string, a special key as a number; get_wch needs a wide-character curses."""
    if hasattr(window, 'get_wch'):
        return window.get_wch()
    key = window.getch()
    return chr(key) if 0 <= key < 256 else key


def lines_of(names, width):
    """Pack the names into lines of `width`, separated by commas."""
    lines, current = [], ''
    for name in names:
        part = name if not current else current + ', ' + name
        if current and len(part) > width:
            lines.append(current)
            current = name
        else:
            current = part
    lines.append(current or '-')
    return [fit(line, width) for line in lines]


def on_terminal(function):
    """Run curses on the terminal, not on stdin and stdout: those carry the inventory and the JSON."""
    path = os.environ.get('INSTALL_TEST_TTY') or '/dev/tty'
    try:
        fd = os.open(path, os.O_RDWR | os.O_NOCTTY)
    except OSError as error:
        raise Invalid('no terminal: ' + path + ': ' + error.strerror) from None
    saved = []
    try:
        if not os.isatty(fd):
            raise Invalid('not a terminal: ' + path)
        try:
            curses.setupterm(None, fd)
        except curses.error as error:
            raise Invalid('the terminal type is unknown: ' + str(error)) from None
        if not curses.tigetstr('cup'):
            raise Invalid('the terminal type cannot move the cursor')
        sys.stdout.flush()
        saved = [os.dup(0), os.dup(1)]
        os.dup2(fd, 0)
        os.dup2(fd, 1)
        os.environ.setdefault('ESCDELAY', '25')
        return curses.wrapper(function)
    finally:
        if saved:
            os.dup2(saved[0], 0)
            os.dup2(saved[1], 1)
        for one in (*saved, fd):
            os.close(one)


def names(value):
    return [name for name in value.split(',') if name] if value else []


def main(argv=None):
    global ASCII
    parser = argparse.ArgumentParser(description=__doc__.split('\n', 1)[0])
    parser.add_argument('--inventory', required=True)
    parser.add_argument('--catalog', required=True)
    parser.add_argument('--choices')
    parser.add_argument('--exclusive', action='append', default=[])
    parser.add_argument('--replaces', action='append', default=[])
    parser.add_argument('--requires', action='append', default=[])
    parser.add_argument('--no-remove', action='store_true')
    parser.add_argument('--runtime', default='pi')
    parser.add_argument('--runtimes', default='')
    parser.add_argument('planner', nargs='*', help='after --: the planner command, without --with and --runtime')
    args = parser.parse_args(argv)
    replaces = [value.split('=') for value in args.replaces]
    if not all(len(pair) == 2 and all(pair) for pair in replaces):
        parser.error('--replaces needs the form NEW=OLD')
    requires = [value.split('=') for value in args.requires]
    if not all(len(pair) == 2 and all(pair) for pair in requires):
        parser.error('--requires needs the form ITEM=NEEDED')
    try:
        locale.setlocale(locale.LC_ALL, '')
    except locale.Error:
        pass
    ASCII = 'utf' not in locale.getpreferredencoding(False).lower()
    try:
        model = Model(read_json(args.inventory, 'inventory'), read_json(args.catalog, 'catalog'),
                      None if args.choices is None else set(names(args.choices)),
                      [names(value) for value in args.exclusive], args.no_remove, text(args.runtime),
                      [text(value) for value in names(args.runtimes)], [tuple(pair) for pair in replaces],
                      args.planner, [tuple(pair) for pair in requires])

        def screen(window):
            try:
                curses.curs_set(0)
            except curses.error:
                pass
            window.keypad(True)
            return Screen(window, model).run()
        try:
            # The first view shows the plan of the planner for the start selection.
            model.refresh()
            confirmed = on_terminal(screen)
        except KeyboardInterrupt:
            confirmed = False
    except (Invalid, curses.error) as error:
        print('kit_tui: ' + text(error), file=sys.stderr)
        return 2
    except Exception as error:
        # curses.wrapper and on_terminal restore the terminal first. Exit 1 stays the abort of the user.
        print('kit_tui: unexpected error: ' + type(error).__name__ + ': ' + text(error), file=sys.stderr)
        return 2
    print(json.dumps(model.selection(confirmed)))
    return 0 if confirmed else 1


if __name__ == '__main__':
    sys.exit(main())
