#!/bin/sh
# Choose one named profile, then approve its additive install and shell alias.
set -eu
fail() { echo "install: $*" >&2; exit 2; }
ask() {
  # INSTALL_TEST_TTY is a test seam, not a saved installer setting.
  tty=${INSTALL_TEST_TTY:-/dev/tty}
  [ -c "$tty" ] || [ -f "$tty" ] || fail "missing choice: $1 (use flags without a terminal)"
  if ! { exec 3<>"$tty"; } 2>/dev/null; then fail "missing choice: $1 (use flags without a terminal)"; fi
  printf '%s ' "$1" >&3
  IFS= read -r answer <&3 || fail "cancelled"
  exec 3>&-
}
mode= name= shell= modules= runtime_choice= approved=no replace=no plugin= dummies= asked=no
while [ "$#" -gt 0 ]; do
  case $1 in
    --new|--upgrade)
      [ -z "$mode" ] || fail "choose only one of --new and --upgrade"
      mode=${1#--}; [ "$#" -ge 2 ] || fail "$1 needs a name"; name=$2; shift 2 ;;
    --shell|--with)
      option=$1; [ "$#" -ge 2 ] || fail "$1 needs a value"
      if [ "$option" = --shell ]; then shell=$2; else modules=$2; fi; shift 2 ;;
    --runtime) [ "$#" -ge 2 ] || fail "$1 needs a value"; runtime_choice=$2; shift 2 ;;
    --yes) approved=yes; shift ;;
    --replace-alias) replace=yes; shift ;;
    --claude-plugin) plugin=yes; shift ;;
    --dummies) dummies=yes; shift ;;
    *) fail "unknown option: $1" ;;
  esac
done
case ${HOME:-} in /*) ;; *) fail "HOME must be set to an absolute path" ;; esac
kit=$(cd "$(dirname "$0")" && pwd -P)
if [ -z "$mode" ]; then
  printf 'Choose upgrade or new. Inherited profile (suggestion only): %s\n' "${PI_CODING_AGENT_DIR:-none}"
  ask 'Profile action [upgrade/new]:'; mode=$answer
fi
case $mode in new|upgrade) ;; *) fail "choose upgrade or new" ;; esac
if [ "$mode" = upgrade ]; then
  echo 'Known profiles:'
  for dir in "$HOME"/.pi/profiles/*; do
    [ -d "$dir" ] || continue
    printf '  %s: %s\n' "${dir##*/}" "$dir"
  done
fi
if [ -z "$name" ]; then ask "Name of $mode profile:"; name=$answer; fi
if [ -z "$shell" ]; then ask 'Shell [bash/zsh/none]:'; shell=$answer; fi
if [ -z "$modules" ]; then ask 'Optional modules [wiki,hermes,mcp,computer-use or none]:'; modules=$answer; asked=yes; fi
case ,$modules, in
  *,computer-use,*)
    # A refused platform exits before the first write. --with computer-use is the yes to desktop control.
    [ "$(uname -s)" = Linux ] || fail "computer-use supports Linux only. The computer-use module for macOS is not chosen yet; see docs/guides/modules.md#computer-use"
    if [ "$asked" = yes ]; then
      ask 'computer-use lets the agent read your screen and send input to your desktop. Install it? [yes/no]:'
      [ "$answer" = yes ] || fail "cancelled"
    fi ;;
esac
# DUMMIES needs its own yes, as the Claude Code plugin: --dummies or a yes here. --yes does not give it.
if [ -z "$dummies" ] && [ "$asked" = yes ]; then
  ask 'DUMMIES reports: a coordinator session ends each reply with a compact report for a junior developer, and next-prompt drafts the next action. Turn it on for Pi? All your profiles share the switch; the autostart block goes into this profile. [y/N]'
  case $answer in y | Y | yes | Yes) dummies=yes ;; *) dummies= ;; esac
fi
# The Pi runtime: --runtime, else the choice in the launcher of an upgrade, else a question, else pi.
if [ -z "$runtime_choice" ] && [ "$mode" = upgrade ]; then
  case $name in
    '' | *[!a-z0-9-]*) ;;
    *)
      launcher=$HOME/.local/bin/$name
      if [ -f "$launcher" ] && grep -qxF "# tenant-pi launcher: $name" "$launcher"; then
        runtime_choice=$(sed -n 's/^# tenant-pi runtime: //p' "$launcher" | head -n 1)
      fi ;;
  esac
fi
if [ -z "$runtime_choice" ] && [ "$approved" != yes ] && command -v pi >/dev/null 2>&1 && command -v pi-bolt >/dev/null 2>&1; then
  ask 'Pi runtime [pi/pi-bolt]:'; runtime_choice=$answer
fi
runtime_choice=${runtime_choice:-pi}
case $runtime_choice in
  pi | pi-bolt) runtime=$(command -v "$runtime_choice") || fail "$runtime_choice is not installed; install it separately" ;;
  /*) runtime=$runtime_choice ;;
  *) fail "runtime must be pi, pi-bolt or an absolute path" ;;
esac
case $runtime in /*) ;; *) runtime=$(cd "$(dirname "$runtime")" && pwd -P)/${runtime##*/} ;; esac
export kit mode name shell modules runtime_choice runtime replace dummies
# Python handles JSON and shell quoting; prompts remain plain POSIX sh.
helper() {
python3 - "$1" <<'PY'
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import sys
import tempfile


PLUGIN = 'computer-use-linux@computer-use-linux'


def fail(message):
    raise ValueError(message)


def backup(path):
    fd, filename = tempfile.mkstemp(prefix=path.name + '.backup-', dir=path.parent)
    os.close(fd)
    shutil.copy2(path, filename)
    print('backup: ' + filename)


def put(path, content, mode=0o600):
    fd, filename = tempfile.mkstemp(prefix='.' + path.name + '-', dir=path.parent)
    with os.fdopen(fd, 'w', newline='') as stream:
        stream.write(content)
    os.chmod(filename, mode)
    os.replace(filename, path)


try:
    action = sys.argv[1]
    home = Path(os.environ['HOME'])
    kit = Path(os.environ['kit'])
    name = os.environ['name']
    shell = os.environ['shell']
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,31}', name):
        fail('invalid name: use [a-z][a-z0-9-]{0,31}')
    if shell not in ('bash', 'zsh', 'none'):
        fail('shell must be bash, zsh or none')
    profile = home / '.pi/profiles' / name
    target = profile.resolve()
    if target.is_relative_to((home / '.pi/agent').resolve()) or target.is_relative_to(kit.resolve()):
        fail('profile must not be in ~/.pi/agent or the clone')
    if action in ('plan', 'conflict'):
        if os.environ['mode'] == 'new' and (profile.exists() or profile.is_symlink()):
            fail('new profile name already exists')
        if os.environ['mode'] == 'upgrade' and not profile.is_dir():
            fail('upgrade profile does not exist')
    modules = os.environ['modules'].split(',')
    if modules == ['none']:
        modules = []
    if any(module not in ('wiki', 'hermes', 'mcp', 'computer-use', 'questions') for module in modules):
        fail('unknown optional module; use wiki,hermes,mcp,computer-use or none')
    manifest = json.loads((kit / 'config/manifest.json').read_text())
    # questions is mandatory; accept its old --with name without installing twice.
    specs = ['npm:' + manifest['components'][module]['source']['spec']
             for module in dict.fromkeys([*modules, 'questions'])]
    choice = os.environ['runtime_choice']
    if any(ord(c) < 32 or ord(c) == 127 for c in choice):
        fail('runtime path has a control character')
    runtime = Path(os.environ['runtime'])
    if not runtime.is_file() or not os.access(runtime, os.X_OK):
        fail('runtime must be an executable file: ' + str(runtime))
    # Herdr knows a Pi agent by the name of the started file. The Pi-Bolt installer links
    # pi-bolt to a release file named pi, so the launcher starts that file.
    if choice == 'pi-bolt' and runtime.resolve().name == 'pi':
        runtime = runtime.resolve()
    launcher = home / '.local/bin' / name
    startup = home / '.bashrc' if shell == 'bash' else Path(os.environ.get('ZDOTDIR') or str(home)) / '.zshrc'
    if not startup.is_absolute():
        fail('ZDOTDIR must be absolute')
    start = '# >>> tenant-pi ' + name + ' >>>'
    end = '# <<< tenant-pi ' + name + ' <<<'
    launcher_mark = '# tenant-pi launcher: ' + name
    launch_text = '\n'.join(['#!/bin/sh', launcher_mark, '# tenant-pi runtime: ' + choice,
        'export PI_CODING_AGENT_DIR=' + shlex.quote(str(profile)),
        'unset PI_CODING_AGENT_SESSION_DIR',
        'export PATH=' + shlex.quote(str(runtime.parent)) + ':"$PATH"',
        'exec ' + shlex.quote(str(runtime)) + ' "$@"', ''])
    block = start + '\nalias ' + name + '=' + shlex.quote(shlex.quote(str(launcher))) + '\n' + end + '\n'
    old = ''
    if shell != 'none':
        if startup.is_symlink() or launcher.is_symlink():
            fail('refusing a symlink startup file or launcher')
        if startup.exists():
            with startup.open(newline='') as stream:
                old = stream.read()
        lines = old.splitlines(keepends=True)
        starts = [i for i, line in enumerate(lines) if line.rstrip('\r\n') == start]
        ends = [i for i, line in enumerate(lines) if line.rstrip('\r\n') == end]
        if starts or ends:
            if len(starts) != 1 or len(ends) != 1 or ends[0] <= starts[0]:
                fail('malformed managed alias block')
            outside = ''.join(lines[:starts[0]] + lines[ends[0] + 1:])
            updated = ''.join(lines[:starts[0]]) + block + ''.join(lines[ends[0] + 1:])
        else:
            outside = old
            updated = old + ('\n' if old and not old.endswith('\n') else '') + block
        pattern = r'(?m)(?:^|[;\n])\s*(?:alias\s+[\'"]?' + re.escape(name) + r'=|(?:function\s+' + re.escape(name) + r'\b)|' + re.escape(name) + r'\s*\(\s*\))'
        conflict = bool(re.search(pattern, outside))
        for line in outside.splitlines():
            try:
                tokens = list(shlex.shlex(line, posix=True, punctuation_chars=True))
            except ValueError:
                tokens = []
            if 'alias' in tokens:
                assignments = tokens[tokens.index('alias') + 1:]
                conflict |= any(token.split('=', 1)[0] == name and '=' in token for token in assignments)
            # Dynamic or malformed shell syntax is not safe to interpret here.
            if re.search(r'\balias\b', line) and re.search(r'(?<![\w-])' + re.escape(name) + r'(?![\w-])', line):
                conflict = True
        if launcher.exists() and (not launcher.is_file() or launcher_mark not in launcher.read_text().splitlines()):
            conflict = True
        command = shutil.which(name)
        if command and not (Path(command) == launcher and launcher.exists() and launcher_mark in launcher.read_text().splitlines()):
            conflict = True
        if action == 'conflict':
            sys.exit(10 if conflict else 0)
    settings_path = profile / 'settings.json'
    models_path = profile / 'models.json'
    for path in (settings_path, models_path):
        if path.is_symlink():
            fail('refusing symlink template file: ' + str(path))
    # Substitute after parsing, so quotes and backslashes in clone paths remain valid JSON.
    defaults = json.loads((kit / 'config/settings.example.json').read_text())
    defaults['packages'] = [item.replace('{kit}', str(kit)) for item in defaults['packages']]
    settings = json.loads(settings_path.read_text()) if settings_path.exists() else defaults
    before = json.loads(json.dumps(settings))
    packages = settings.setdefault('packages', [])
    if not isinstance(packages, list):
        fail('settings packages must be a list')
    desired = str(kit / 'packages/tenantext')
    found = False
    for index, entry in enumerate(packages):
        source = entry.get('source') if isinstance(entry, dict) else entry
        if not isinstance(source, str):
            continue
        resolved = (profile / source).resolve()
        if source == desired or resolved == Path(desired).resolve() or source.rstrip('/').endswith('/packages/tenantext'):
            found = True
            if isinstance(entry, dict):
                entry['source'] = desired
            else:
                packages[index] = desired
    if not found:
        packages.append(desired)
    changed = before != settings
    models = (kit / 'config/models.example.json').read_text()
    # Claude Code gets the skills that the manifest declares for the package, not each folder with a SKILL.md.
    folder = home / '.claude/skills'
    skills = [kit / 'packages/tenantext' / item for component in manifest['components'].values()
              if component['source'] == {'kind': 'tree', 'path': 'packages/tenantext'}
              for item in component['resources']['skills']]

    def claude_links():
        # Replace a broken link or a link into this clone; keep a link to another skill source.
        names = [skill.name for skill in skills]
        for skill_name in names:
            if names.count(skill_name) > 1:
                fail('two declared skills have the name ' + skill_name + '; one Claude skill link cannot carry both')
        for skill in skills:
            dest = folder / skill.name
            if not (skill / 'SKILL.md').is_file():
                yield skill, dest, 'warning: the manifest declares ' + str(skill) + ' but it has no SKILL.md; no link'
            elif not dest.exists() and not dest.is_symlink():
                yield skill, dest, None
            elif dest.is_symlink() and (not dest.is_dir() or dest.resolve().is_relative_to(kit.resolve())):
                yield skill, dest, None
            elif dest.is_symlink():
                yield skill, dest, 'skipped: ' + str(dest) + ' links to another place: ' + str(dest.resolve())
            else:
                yield skill, dest, 'skipped: ' + str(dest) + ' exists and is not a link'
    if action == 'plan':
        print('profile: ' + name + '\npath: ' + str(profile))
        print('runtime: ' + choice + ' (' + str(runtime) + ')')
        print('launch: ' + shlex.quote(str(launcher)) if shell != 'none' else 'launch: PI_CODING_AGENT_DIR=' + shlex.quote(str(profile)) + ' ' + shlex.quote(str(runtime)))
        if shell != 'none':
            print('alias: ' + name + '\nlauncher: ' + str(launcher) + '\nstartup: ' + str(startup))
            print(block, end='')
        else:
            print('alias: none (shell setup disabled)\nstartup: none')
        if settings_path.exists() and changed:
            print('Proposed settings.json change (packages only):')
            print('- ' + json.dumps(before.get('packages'), ensure_ascii=True))
            print('+ ' + json.dumps(packages, ensure_ascii=True))
        for spec in specs:
            print('install module: ' + spec)
        if os.environ.get('dummies') == 'yes':
            print('DUMMIES: on for Pi, shared by all profiles of this user; autostart block in the instruction file of the profile, else a new AGENTS.md')
        if 'computer-use' in modules and (home / '.claude').is_dir() and shutil.which('claude'):
            print('Claude Code plugin: ' + PLUGIN + ' (asked separately; --claude-plugin is the yes)')
        if (home / '.claude').is_dir():
            links = [dest.name for _, dest, skipped in claude_links() if not skipped]
            print('Claude skill links: ' + str(len(links)) + '\ntarget: ' + str(folder))
            for link in links:
                print('link: ' + link)
    elif action == 'profile':
        os.umask(0o077)
        profile.mkdir(parents=True, exist_ok=True)
        if not settings_path.exists() or changed:
            if settings_path.exists():
                backup(settings_path)
            put(settings_path, json.dumps(settings, indent=2) + '\n')
        if not models_path.exists():
            put(models_path, models)
        import subprocess
        env = dict(os.environ, PI_CODING_AGENT_DIR=str(profile))
        env.pop('PI_CODING_AGENT_SESSION_DIR', None)
        env['PATH'] = str(runtime.parent) + os.pathsep + env.get('PATH', '')
        # Offline qualification checks loading separately with a local package fixture.
        if os.environ.get('INSTALL_SKIP_PACKAGES') != '1':
            for spec in specs:
                print('Installing: ' + spec, flush=True)
                subprocess.run([str(runtime), 'install', spec], env=env, check=True)
    elif action == 'links':
        folder.mkdir(parents=True, exist_ok=True)
        for skill, dest, skipped in claude_links():
            if skipped:
                print(skipped, file=sys.stderr)
                continue
            if dest.is_symlink():
                dest.unlink()
            dest.symlink_to(skill)
            print('link:    ' + str(dest))
    elif action == 'plugin':
        # Compare the installed Claude Code plugin with the kit pin; report a difference, never hide it.
        import subprocess
        pin = manifest['components']['computer-use']['source']['spec'].rsplit('@', 1)[1]
        listed = subprocess.run(['claude', 'plugin', 'list', '--json'], capture_output=True, text=True)
        if listed.returncode:
            fail('`claude plugin list --json` exited ' + str(listed.returncode) + '; kit pin ' + pin)
        try:
            items = json.loads(listed.stdout)
            entry = next((item for item in items if item['id'] == PLUGIN), None)
        except (ValueError, TypeError, KeyError) as error:
            fail('cannot parse `claude plugin list --json` (' + type(error).__name__ + ': ' + str(error)
                 + '); kit pin ' + pin)
        version = None if entry is None else entry.get('version')
        if entry is None:
            print('plugin:  ' + PLUGIN + ' is not in `claude plugin list`; kit pin ' + pin)
        elif not isinstance(version, str):
            fail(PLUGIN + ' in `claude plugin list --json` has no version; kit pin ' + pin)
        elif version == pin:
            print('plugin:  ' + PLUGIN + ' ' + version + ' equals the kit pin')
        else:
            print('plugin:  ' + PLUGIN + ' ' + version + ' differs from the kit pin ' + pin
                  + '; see docs/guides/modules.md#computer-use')
    elif action == 'alias' and shell != 'none':
        startup.parent.mkdir(parents=True, exist_ok=True)
        launcher.parent.mkdir(parents=True, exist_ok=True)
        if startup.exists():
            backup(startup)
        if launcher.exists():
            backup(launcher)
        put(launcher, launch_text, 0o700)
        put(startup, updated, startup.stat().st_mode & 0o777 if startup.exists() else 0o600)
    if action == 'alias':
        print('Complete: ' + name + '\nprofile: ' + str(profile))
        print('alias: ' + (name if shell != 'none' else 'none'))
        print('startup: ' + (str(startup) if shell != 'none' else 'none'))
        if shell != 'none':
            load = '~/.bashrc' if shell == 'bash' else '~/.zshrc' if startup.parent == home else shlex.quote(str(startup))
            print('Load alias: . ' + load)
except Exception as error:
    print('install: ' + str(error), file=sys.stderr)
    sys.exit(2)
PY
}
helper plan || exit 2
if helper conflict; then :; else
  status=$?
  [ "$status" -eq 10 ] || exit "$status"
  if [ "$replace" != yes ]; then
    ask "Conflict for $name. Replace this alias/function/command with the shown launcher? [yes/no]:"
    [ "$answer" = yes ] || fail "cancelled"
  fi
fi
if [ "$approved" != yes ]; then
  ask 'Apply the shown profile and shell changes? [yes/no]:'
  [ "$answer" = yes ] || fail "cancelled"
fi
# The Claude Code plugin needs its own yes; --yes does not give it. Without a terminal, no plugin.
case ,$modules, in
  *,computer-use,*)
    if [ ! -d "$HOME/.claude" ]; then
      plugin=
    elif ! command -v claude >/dev/null 2>&1; then
      echo "plugin:  no claude command on PATH, so no Claude Code plugin"
      plugin=
    elif [ -z "$plugin" ]; then
      # A subshell: a failed redirection of a special built-in would end this shell.
      if (true <"${INSTALL_TEST_TTY:-/dev/tty}") 2>/dev/null; then
        ask "Install the Claude Code plugin computer-use-linux too? Each new Claude Code session then gets the desktop tools. [yes/no]:"
        plugin=$answer
      else
        echo "plugin:  no terminal and no --claude-plugin, so no Claude Code plugin"
      fi
    fi ;;
  *) plugin= ;;
esac
helper profile || { echo 'install: profile step failed; alias unchanged' >&2; exit 1; }
profile=$HOME/.pi/profiles/$name
# The skill's own script turns DUMMIES on for Pi and writes the autostart block into the profile.
dummies_failed=no dummies_on= dummies_status=
if [ "$dummies" = yes ]; then
  state=$kit/packages/tenantext/skills/coordinator-skills/dummies/scripts/state.py
  if dummies_on=$(PI_CODING_AGENT_DIR=$profile python3 "$state" on --harness pi --autostart) &&
     dummies_status=$(PI_CODING_AGENT_DIR=$profile python3 "$state" status --harness pi); then :
  else
    dummies_failed=yes
  fi
fi
plugin_failed=no
if [ "$plugin" = yes ]; then
  # On a rerun the marketplace exists and its add can fail; continue only when the list names it.
  if claude plugin marketplace add agent-sh/computer-use-linux; then :
  elif claude plugin marketplace list 2>/dev/null | grep -q computer-use-linux; then
    echo "plugin:  the marketplace computer-use-linux exists"
  else
    plugin_failed=yes
  fi
  if [ "$plugin_failed" = no ] && claude plugin install computer-use-linux@computer-use-linux; then
    helper plugin || plugin_failed=yes
  else
    plugin_failed=yes
  fi
fi
if [ -d "$HOME/.claude" ]; then
  helper links || { echo 'install: Claude skill links failed after profile success; alias unchanged' >&2; exit 1; }
else
  echo "skills:  no ~/.claude directory, so no Claude Code skill link"
fi
helper alias || { echo 'install: alias setup failed after profile success' >&2; exit 1; }
if [ -n "$dummies_status" ]; then
  printf '%s\n' "$dummies_status"
  printf '%s\n' "$dummies_on" | grep '^autostart: ' || :
fi
if [ "$dummies_failed" = yes ]; then
  echo 'install: the DUMMIES step failed; the profile and the alias are in place' >&2
  exit 1
fi
if [ "$plugin_failed" = yes ]; then
  echo 'install: the Claude Code plugin step failed; the profile and the alias are in place' >&2
  exit 1
fi
