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
mode= name= shell= modules= runtime_choice= approved=no replace=no plugin= dummies= asked=no inventory=no dry_run=no
claude_aws= adopt=no
ui= tui_consent= tui_dummies=
while [ "$#" -gt 0 ]; do
  case $1 in
    --inventory) inventory=yes; shift ;;
    --dry-run) dry_run=yes; shift ;;
    --new|--upgrade)
      [ -z "$mode" ] || fail "choose only one of --new and --upgrade"
      mode=${1#--}; [ "$#" -ge 2 ] || fail "$1 needs a name"; name=$2; shift 2 ;;
    --shell|--with)
      option=$1; [ "$#" -ge 2 ] || fail "$1 needs a value"
      if [ "$option" = --shell ]; then shell=$2; else modules=$2; fi; shift 2 ;;
    --runtime) [ "$#" -ge 2 ] || fail "$1 needs a value"; runtime_choice=$2; shift 2 ;;
    --yes) approved=yes; shift ;;
    --tui|--plain)
      [ -z "$ui" ] || [ "$ui" = "${1#--}" ] || fail "choose only one of --tui and --plain"
      ui=${1#--}; shift ;;
    --replace-alias) replace=yes; shift ;;
    --claude-plugin) plugin=yes; shift ;;
    # The yes to the Claude Code plugins of the AWS rows, and the move of an AWS entry of the user to the kit pin.
    --claude-aws) claude_aws=yes; shift ;;
    --adopt-aws) adopt=yes; shift ;;
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
# Each platform offers its own computer-use module: computer-use on Linux, computer-use-macos on macOS.
desktop_module=computer-use
[ "$(uname -s)" = Darwin ] && desktop_module=computer-use-macos
# all means every optional module of this platform; it stands alone.
optional_modules=wiki,hermes,mcp,$desktop_module,okknow,artifacts,walkr
# The AWS rows: the components of config/manifest.json with a git source (scripts/kit_aws.py). all leaves them out.
aws_modules=aws-core,aws-agents,aws-data-analytics,aws-agents-for-devsecops,aws-startup-advisor,aws-emulator
# The checks of a --with value that ask nothing and write nothing. A refused platform exits before the first write.
check_modules() {
  case ,$modules, in
    ,all,) modules=$optional_modules ;;
    *,all,*) fail "all stands alone; use $optional_modules, mcp-codemode, $aws_modules, all or none" ;;
  esac
  # An AWS plugin row needs aws-core.
  case ,$modules, in
    *,aws-*) python3 "$kit/scripts/kit_aws.py" check --kit "$kit" --with "$modules" || exit 2 ;;
  esac
  case ,$modules, in
    *,mcp-codemode,*)
      # The adapter replaces the MCP support of Pi, so one profile cannot hold both.
      case ,$modules, in
        *,mcp,*) fail "choose one of mcp and mcp-codemode; see docs/guides/modules.md#mcp-with-codemode" ;;
      esac ;;
  esac
  case ,$modules, in
    *,computer-use,*) [ "$(uname -s)" = Linux ] || fail "computer-use supports Linux only. On macOS use computer-use-macos; see docs/guides/modules.md#computer-use" ;;
  esac
  case ,$modules, in
    *,computer-use-macos,*) [ "$(uname -s)" = Darwin ] || fail "computer-use-macos supports macOS only. On Linux use computer-use; see docs/guides/modules.md#computer-use-on-macos" ;;
  esac
}
# --inventory prints the state of the profile and the plan of the given choices, then exits. It asks nothing more and
# writes no file. kit_inventory.py finds the runtime as a run does: --runtime, else the launcher choice, else pi.
if [ "$inventory" = yes ]; then
  case $name in [a-z]*) ;; *) fail "invalid name: use [a-z][a-z0-9-]{0,31}" ;; esac
  case $name in *[!a-z0-9-]*) fail "invalid name: use [a-z][a-z0-9-]{0,31}" ;; esac
  [ "${#name}" -le 32 ] || fail "invalid name: use [a-z][a-z0-9-]{0,31}"
  case $shell in '' | bash | zsh | none) ;; *) fail "shell must be bash, zsh or none" ;; esac
  dir=$HOME/.pi/profiles/$name
  if [ "$mode" = upgrade ] && [ ! -d "$dir" ]; then fail "upgrade profile does not exist"; fi
  if [ "$mode" = new ] && { [ -e "$dir" ] || [ -L "$dir" ]; }; then fail "new profile name already exists"; fi
  [ -z "$modules" ] || check_modules
  set -- --kit "$kit" --profile "$dir" --name "$name" --plain
  [ -z "$modules" ] || set -- "$@" --with "$modules"
  [ -z "$shell" ] || set -- "$@" --shell "$shell"
  [ -z "$dummies" ] || set -- "$@" --dummies
  [ -z "$plugin" ] || set -- "$@" --claude-plugin
  [ -z "$claude_aws" ] || set -- "$@" --claude-aws
  [ "$adopt" = no ] || set -- "$@" --adopt-aws
  [ -z "$runtime_choice" ] || set -- "$@" --runtime "$runtime_choice"
  exec python3 "$kit/scripts/kit_inventory.py" "$@"
fi
if [ -z "$shell" ]; then ask 'Shell [bash/zsh/none]:'; shell=$answer; fi
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
# --tui, the default with a terminal, asks the optional modules and the runtime on one screen. --yes skips the
# screen, also with --tui. The selection takes the path of --with, and the consent questions follow it.
# --plain keeps the questions.
tui_tty=${INSTALL_TEST_TTY:-/dev/tty}
if [ -z "$modules" ] && [ "$ui" != plain ] && [ "$approved" != yes ] &&
   [ -c "$tui_tty" ] && (true <"$tui_tty") 2>/dev/null; then
  case $name in
    '' | *[!a-z0-9-]*) ;;
    *)
      if [ ! -f "$kit/scripts/kit_inventory.py" ] || [ ! -f "$kit/config/catalog.json" ]; then
        echo 'tui:     no scripts/kit_inventory.py or config/catalog.json in this clone, so the plain questions follow' >&2
      else
        runtimes=$runtime_choice
        if [ -z "$runtimes" ]; then
          runtimes=pi
          if command -v pi >/dev/null 2>&1 && command -v pi-bolt >/dev/null 2>&1; then runtimes=pi,pi-bolt; fi
        fi
        # The inventory reads state only, with the choices that are known now. The screen draws on the terminal and
        # prints the selection JSON. It runs the same inventory command with --with of its selection (and --runtime
        # after r) for the plan, as the dry run does. DUMMIES is no choice there: --dummies sets the plan of its row,
        # and without it the DUMMIES question follows the screen. mcp-codemode replaces the adapter, so the plan shows
        # an installed mcp as a removal. Exit 1 of the screen is an abort; another failure falls back to the questions.
        set -- --kit "$kit" --profile "$HOME/.pi/profiles/$name" --name "$name" --json
        case $shell in bash | zsh | none) set -- "$@" --shell "$shell" ;; esac
        [ -z "$dummies" ] || set -- "$@" --dummies
        [ -z "$plugin" ] || set -- "$@" --claude-plugin
        [ -z "$claude_aws" ] || set -- "$@" --claude-aws
        [ "$adopt" = no ] || set -- "$@" --adopt-aws
        [ -z "$runtime_choice" ] || set -- "$@" --runtime "$runtime_choice"
        # Ctrl-C ends the run as q does. The screen restores the terminal first; the trap runs after it exits.
        trap 'fail "cancelled"' INT
        if ! profile_state=$(python3 "$kit/scripts/kit_inventory.py" "$@"); then
          echo 'tui:     the inventory did not run (see the line above), so the plain questions follow' >&2
        elif selection=$(printf '%s\n' "$profile_state" |
            python3 "$kit/scripts/kit_tui.py" --inventory - --catalog "$kit/config/catalog.json" --no-remove \
              --choices "$optional_modules,mcp-codemode,$aws_modules" --exclusive mcp,mcp-codemode --replaces mcp-codemode=mcp \
              --requires aws-agents=aws-core --requires aws-data-analytics=aws-core \
              --requires aws-agents-for-devsecops=aws-core --requires aws-startup-advisor=aws-core \
              --runtime "${runtimes%%,*}" --runtimes "$runtimes" -- python3 "$kit/scripts/kit_inventory.py" "$@"); then
          parsed=$(printf '%s\n' "$selection" | python3 -c '
import json, sys
try:
    data = json.loads(sys.stdin.read())
    valid = data["confirmed"] is True and isinstance(data["runtime"], str) and all(
        isinstance(data[key], list) and all(isinstance(name, str) for name in data[key])
        for key in ("enable", "disable", "consent"))
except (ValueError, KeyError, TypeError):
    valid = False
if not valid:
    sys.exit(1)
known = sys.argv[1].split(",")
print(",".join(name for name in data["enable"] if name in known) or "none")
print(data["runtime"])
# The desktop modules have their own question below.
print(",".join(name for name in data["consent"] if name in known and name in data["enable"]
               and name not in ("computer-use", "computer-use-macos")))
# DUMMIES is active in the profile: its block is there and the Pi switch is on.
print("on" if "dummies" in data["enable"] else "")
' "$optional_modules,mcp-codemode,$aws_modules") || fail "the selection of the screen is not valid"
          modules=$(printf '%s\n' "$parsed" | sed -n 1p)
          [ -n "$runtime_choice" ] || runtime_choice=$(printf '%s\n' "$parsed" | sed -n 2p)
          tui_consent=$(printf '%s\n' "$parsed" | sed -n 3p)
          tui_dummies=$(printf '%s\n' "$parsed" | sed -n 4p)
          asked=yes
        else
          case $? in
            1) fail "cancelled" ;;
            *) echo 'tui:     the screen stopped with an error (see the line above), so the plain questions follow' >&2 ;;
          esac
        fi
        trap - INT
      fi ;;
  esac
fi
# mcp-codemode is a choice for a comparison profile, so all leaves it out. all leaves out the AWS rows too.
if [ -z "$modules" ]; then ask "Optional modules [$optional_modules, mcp-codemode, $aws_modules, all or none]:"; modules=$answer; asked=yes; fi
check_modules
# A module that needs consent and that the screen turned on gets an explicit yes here. A no cancels the run.
if [ -n "$tui_consent" ]; then
  ask "These modules need your consent: $tui_consent. The screen showed the effect of each one. Install them? [yes/no]:"
  [ "$answer" = yes ] || fail "cancelled"
fi
case ,$modules, in
  *,computer-use,*)
    # --with computer-use is the yes to desktop control.
    if [ "$asked" = yes ]; then
      ask 'computer-use lets the agent read your screen and send input to your desktop. Install it? [yes/no]:'
      [ "$answer" = yes ] || fail "cancelled"
    fi ;;
esac
case ,$modules, in
  *,computer-use-macos,*)
    # --with computer-use-macos is the yes to desktop control. The install starts no driver and requests no grant.
    if [ "$asked" = yes ]; then
      ask 'computer-use-macos lets the agent read your screen and send input to your Mac. Screenshots, accessibility text and typed text go to the model provider. Cua Driver sends telemetry by default. macOS asks for the grants at the first desktop tool call. Install it? [yes/no]:'
      [ "$answer" = yes ] || fail "cancelled"
    fi ;;
esac
# okknow: the origin comes from OKKNOW_ORIGIN, an existing user config or the wizard in a terminal.
okknow_cli=$kit/packages/okknow/skills/okknow/scripts/okknow
case ,$modules, in
  *,okknow,*)
    if [ -n "${OKKNOW_ORIGIN:-}" ]; then
      # No request: the form of the origin, and setup --yes keeps a different saved origin.
      python3 "$okknow_cli" setup --check --no-probe --yes >/dev/null || fail "OKKNOW_ORIGIN is refused (see the line above); see docs/guides/modules.md#okknow"
    elif python3 "$okknow_cli" origin >/dev/null 2>&1; then :
    elif ! (true <"${INSTALL_TEST_TTY:-/dev/tty}") 2>/dev/null || [ ! -c "${INSTALL_TEST_TTY:-/dev/tty}" ]; then
      fail "missing choice: the okknow origin (set OKKNOW_ORIGIN, or run in a terminal)"
    fi ;;
esac
# artifacts: the origin and the token file path come from ARTIFACTS_ORIGIN and ARTIFACTS_TOKEN_FILE, an existing
# user config or the wizard in a terminal. The checks write nothing and send no request.
artifacts_cli=$kit/packages/artifacts/skills/artifacts/scripts/artifacts
case ,$modules, in
  *,artifacts,*)
    if [ -n "${ARTIFACTS_ORIGIN:-}" ] || [ -n "${ARTIFACTS_TOKEN_FILE:-}" ]; then
      [ -n "${ARTIFACTS_ORIGIN:-}" ] && [ -n "${ARTIFACTS_TOKEN_FILE:-}" ] || fail "set both ARTIFACTS_ORIGIN and ARTIFACTS_TOKEN_FILE"
      python3 "$artifacts_cli" setup --check --origin "$ARTIFACTS_ORIGIN" --token-file "$ARTIFACTS_TOKEN_FILE" ||
        fail "ARTIFACTS_ORIGIN or ARTIFACTS_TOKEN_FILE is refused (see the line above); see docs/guides/modules.md#artifacts"
    elif python3 "$artifacts_cli" setup --check >/dev/null 2>&1; then :
    elif ! (true <"${INSTALL_TEST_TTY:-/dev/tty}") 2>/dev/null || [ ! -c "${INSTALL_TEST_TTY:-/dev/tty}" ]; then
      fail "missing choice: the artifacts origin and token file (set ARTIFACTS_ORIGIN and ARTIFACTS_TOKEN_FILE, or run in a terminal)"
    fi ;;
esac
# DUMMIES needs its own yes, as the Claude Code plugin: --dummies or a yes here. --yes does not give it.
# When the screen showed DUMMIES on in the profile, a no would change nothing, so the question is left out.
if [ -z "$dummies" ] && [ "$asked" = yes ] && [ "$tui_dummies" = on ]; then
  echo 'DUMMIES: on in this profile; the run keeps it'
elif [ -z "$dummies" ] && [ "$asked" = yes ]; then
  ask 'DUMMIES reports: a coordinator session ends each reply with a compact report for a junior developer, and next-prompt drafts the next action. Turn it on for Pi? All your profiles share the switch; the autostart block goes into this profile. [y/N]'
  case $answer in y | Y | yes | Yes) dummies=yes ;; *) dummies= ;; esac
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
export kit mode name shell modules runtime_choice runtime replace dummies plugin optional_modules claude_aws adopt aws_modules
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
# The settings that install.sh writes for computer-use-macos: the bundled driver, the core tools, both confirmations.
MACOS_DESKTOP_DEFAULTS = {'mode': 'bundled', 'toolProfile': 'core', 'confirmAppLaunch': True, 'confirmDangerousActions': True}
# Kit resources that an upgrade adds once to the filter lists of the tenantext entry of a profile, by the rules of
# docs/resources.md. Each step runs once for each profile; kit-steps.json of the profile records it, so a later
# removal by the user stays.
KIT_STEPS = {
    'herdr-idle-cleanup': {'skills': ['skills/herdr-idle-cleanup'], 'extensions': ['extensions/handoffs/index.ts'],
                           'prompts': ['prompts/herdr-idle-cleanup.md']},
}


def add_kit_items(entry, key, items):
    """Add items to the filter list `key` of a package entry when the list would not load them.

    A list with a plain entry includes only its matches: add the item. A missing key, `[]` and a list of only
    `!`, `+` or `-` entries stay: the file loads already, or the user turned the kind or the item off (this
    installer writes the tenantext entry as a plain source, never `[]`). With `autoload: false` the list is a
    delta: add the item. An item that an entry names already, with or without a prefix, stays as the user set it.
    """
    current = entry.get(key)
    delta = entry.get('autoload') is False
    if current is None and delta:
        current = entry[key] = []
    if not isinstance(current, list):
        return
    if not delta and not any(isinstance(one, str) and one[:1] not in ('!', '+', '-') for one in current):
        return
    named = {one.lstrip('!+-') for one in current if isinstance(one, str)}
    current.extend(item for item in items if item not in named)


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
    aws_names = os.environ['aws_modules'].split(',')
    if any(module not in ('wiki', 'hermes', 'mcp', 'mcp-codemode', 'computer-use', 'computer-use-macos', 'okknow', 'artifacts', 'walkr', 'questions', *aws_names)
           for module in modules):
        fail('unknown optional module; use ' + os.environ['optional_modules'] + ', mcp-codemode, ' + os.environ['aws_modules'] + ', all or none')
    manifest = json.loads((kit / 'config/manifest.json').read_text())
    # questions is mandatory; accept its old --with name without installing twice. Only an npm source is a Pi package
    # install: okknow, artifacts and walkr are tree packages, the AWS rows come from one git clone, and mcp-codemode
    # has no package (Pi carries the MCP client and codemode).
    specs = ['npm:' + manifest['components'][module]['source']['spec']
             for module in dict.fromkeys([*modules, 'questions'])
             if manifest['components'].get(module, {}).get('source', {}).get('kind') == 'npm']
    # The AWS rows: Pi skills entries into the kit clone, and the plan lines of scripts/kit_aws.py.
    sys.dont_write_bytecode = True
    sys.path.insert(0, str(kit))
    from scripts import kit_aws
    aws_rows = kit_aws.components(manifest)
    if sorted(aws_rows) != sorted(aws_names):
        fail('the AWS rows of install.sh differ from config/manifest.json')
    aws_clone = kit_aws.clone_dir(home, kit_aws.source(aws_rows)[0])
    aws_selected = [module for module in modules if module in aws_rows]
    adopt = os.environ.get('adopt') == 'yes'
    okknow_package = kit / manifest['components']['okknow']['source']['path']
    okknow_script = okknow_package / 'skills/okknow/scripts/okknow'
    okknow_link = home / '.local/bin/okknow'
    artifacts_package = kit / manifest['components']['artifacts']['source']['path']
    artifacts_script = artifacts_package / 'skills/artifacts/scripts/artifacts'
    artifacts_link = home / '.local/bin/artifacts'
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
    # With the okknow CLI link of the kit, the launcher puts its directory at the end of PATH.
    # The same holds for the artifacts and Walkr command links of the kit, which are in the same directory.
    walkr_link = home / '.local/bin/walkr-core'
    okknow_path = ['export PATH="$PATH":' + shlex.quote(str(okknow_link.parent))] if (
        okknow_link.is_symlink() and okknow_link.resolve() == okknow_script.resolve()
        or artifacts_link.is_symlink() and artifacts_link.resolve() == artifacts_script.resolve()
        or walkr_link.is_symlink() and walkr_link.resolve() == (kit / 'packages/walkr/src/walkr-core.js').resolve()) else []
    launch_text = '\n'.join(['#!/bin/sh', launcher_mark, '# tenant-pi runtime: ' + choice,
        'export PI_CODING_AGENT_DIR=' + shlex.quote(str(profile)),
        'unset PI_CODING_AGENT_SESSION_DIR',
        'export PATH=' + shlex.quote(str(runtime.parent)) + ':"$PATH"', *okknow_path,
        'if [ -r ' + shlex.quote(str(kit / 'packages/tenantext/skills/herdr/scripts/credsync-launch.sh')) + ' ] && { [ -e .credsync.json ] || [ "${TENANT_CREDSYNC_PID-}" = "$$" ]; }; then',
        '  exec /bin/sh ' + shlex.quote(str(kit / 'packages/tenantext/skills/herdr/scripts/credsync-launch.sh')) + ' ' + shlex.quote(str(runtime)) + ' "$@"',
        'fi',
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
    for desired in ([str(kit / 'packages/tenantext')] + ([str(okknow_package)] if 'okknow' in modules else [])
                    + ([str(artifacts_package)] if 'artifacts' in modules else [])):
        found = False
        tail = '/packages/' + Path(desired).name
        for index, entry in enumerate(packages):
            source = entry.get('source') if isinstance(entry, dict) else entry
            if not isinstance(source, str):
                continue
            resolved = (profile / source).resolve()
            if source == desired or resolved == Path(desired).resolve() or source.rstrip('/').endswith(tail):
                found = True
                if isinstance(entry, dict):
                    entry['source'] = desired
                else:
                    packages[index] = desired
        if not found:
            packages.append(desired)
    steps_path = profile / 'kit-steps.json'
    if steps_path.is_symlink():
        fail('refusing symlink kit steps file: ' + str(steps_path))
    try:
        done_steps = json.loads(steps_path.read_text())['added'] if steps_path.exists() else []
    except (ValueError, KeyError, TypeError):
        fail('invalid kit steps file: ' + str(steps_path) + '; remove the file to run the steps again')
    if not isinstance(done_steps, list):
        fail('invalid kit steps file: ' + str(steps_path) + '; remove the file to run the steps again')
    new_steps = [step for step in KIT_STEPS if step not in done_steps]
    for entry in packages:
        if not (isinstance(entry, dict) and entry.get('source') == str(kit / 'packages/tenantext')):
            continue
        for step in new_steps:
            for key, items in KIT_STEPS[step].items():
                add_kit_items(entry, key, items)
    if 'computer-use-macos' in modules:
        # The safe defaults of the macOS desktop extension; a value that the user set stays.
        desktop = settings.setdefault('pi-computer-use', {})
        if not isinstance(desktop, dict):
            fail('settings pi-computer-use must be an object')
        for key, value in MACOS_DESKTOP_DEFAULTS.items():
            desktop.setdefault(key, value)
    if 'mcp-codemode' in modules:
        # An adapter replaces the MCP support of Pi. Its server file stays for a move back.
        adapter = manifest['components']['mcp']['source']['spec'].rsplit('@', 1)[0]

        def is_adapter(entry):
            source = entry.get('source') if isinstance(entry, dict) else entry
            return isinstance(source, str) and source.rsplit('@', 1)[0] == 'npm:' + adapter
        packages[:] = [entry for entry in packages if not is_adapter(entry)]
        extensions = settings.get('extensions', [])
        if not isinstance(extensions, list):
            fail('settings extensions must be a list')
        extensions[:] = [entry for entry in extensions if entry not in ('-builtin:mcp', '-builtin:codemode')]
        tools = settings.get('defaultTools')
        if tools is None:
            settings['defaultTools'] = ['+codemode']
        elif not isinstance(tools, list):
            fail('settings defaultTools must be a list')
        elif not {'+codemode', 'codemode'} & set(tools):
            # A list of plain names replaces the defaults, and it takes no + entry.
            additive = tools and all(isinstance(tool, str) and tool[:1] in ('+', '-') for tool in tools)
            tools.append('+codemode' if additive else 'codemode')
    aws_lines = kit_aws.pi_skills(settings, aws_clone, aws_rows, aws_selected, adopt)
    changed = before != settings
    models = (kit / 'config/models.example.json').read_text()
    # Claude Code gets the skills that the manifest declares for the package, not each folder with a SKILL.md.
    folder = home / '.claude/skills'
    skills = [kit / 'packages/tenantext' / item for component in manifest['components'].values()
              if component['source'] == {'kind': 'tree', 'path': 'packages/tenantext'}
              for item in component['resources']['skills']]
    if 'okknow' in modules:
        skills += [okknow_package / item for item in manifest['components']['okknow']['resources']['skills']]
    if 'artifacts' in modules:
        skills += [artifacts_package / item for item in manifest['components']['artifacts']['resources']['skills']]

    def okknow_link_state():
        # Make or replace only a link of this kit; keep another okknow command.
        if not okknow_link.exists() and not okknow_link.is_symlink():
            return None
        if okknow_link.is_symlink() and (not okknow_link.exists() or okknow_link.resolve().is_relative_to(kit.resolve())):
            return None
        return 'skipped: ' + str(okknow_link) + ' exists and is not a link of this kit'

    def artifacts_link_state():
        # Make or replace only a link of this kit; keep another artifacts command.
        if not artifacts_link.exists() and not artifacts_link.is_symlink():
            return None
        if artifacts_link.is_symlink() and (not artifacts_link.exists()
                                            or artifacts_link.resolve().is_relative_to(kit.resolve())):
            return None
        return 'skipped: ' + str(artifacts_link) + ' exists and is not a link of this kit'
    adapter_path = profile / 'mcp-adapter.json'
    native_path = profile / 'mcp.json'
    mcp_path = native_path if 'mcp-codemode' in modules else adapter_path

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
        if choice == 'pi-bolt':
            print('herdr: none (pi-bolt has its own Herdr reporter)')
        elif shutil.which('herdr'):
            print('herdr: Pi integration in ' + str(profile / 'extensions'))
        if settings_path.exists() and changed:
            print('Proposed settings.json change:')
            for key in ('packages', 'skills', 'pi-computer-use', 'extensions', 'defaultTools'):
                if before.get(key) != settings.get(key):
                    print(key + ':')
                    print('- ' + json.dumps(before.get(key), ensure_ascii=True))
                    print('+ ' + json.dumps(settings.get(key), ensure_ascii=True))
        for spec in specs:
            print('install module: ' + spec)
        if 'mcp-codemode' in modules:
            print('mcp-codemode: servers from ' + str(native_path) + '; no adapter package; settings defaultTools ' + json.dumps(settings['defaultTools']))
            if adapter_path.exists() and not native_path.exists():
                print('mcp-codemode: ' + str(adapter_path) + ' stays; to convert it, run: python3 ' + shlex.quote(str(kit / 'scripts/mcp_to_native.py'))
                      + ' --from ' + shlex.quote(str(adapter_path)) + ' --to ' + shlex.quote(str(native_path)))
        if 'computer-use-macos' in modules:
            print('settings pi-computer-use: ' + json.dumps(settings['pi-computer-use'], ensure_ascii=True)
                  + ' (no driver start and no macOS grant during the install)')
        # Pi-Bolt runs on Bun, so the qmd index of the wiki opens SQLite with bun:sqlite. On macOS
        # that SQLite loads the sqlite-vec extension only from a Homebrew SQLite at these paths.
        brew_sqlite = ('/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib', '/usr/local/opt/sqlite/lib/libsqlite3.dylib')
        if 'wiki' in modules and choice == 'pi-bolt' and sys.platform == 'darwin' and not any(Path(p).exists() for p in brew_sqlite):
            print('note: wiki vector search on Pi-Bolt needs Homebrew SQLite: brew install sqlite; see docs/guides/macos.md#optional-modules')
        if 'walkr' in modules:
            # Walkr has its own installer for the skills and the Pi prompts; the kit runs it after the profile step.
            print('walkr: package ' + str(kit / manifest['components']['walkr']['source']['path'])
                  + ' (its setup writes the Walkr skills to ~/.claude, ~/.codex and ~/.agents, and the prompts to the profile)')
        if 'okknow' in modules:
            print('okknow: package ' + str(okknow_package))
            print('okknow: CLI link ' + str(okknow_link) + (' (' + okknow_link_state() + ')' if okknow_link_state() else ''))
            import subprocess
            saved = subprocess.run([sys.executable, str(okknow_script), 'origin'], capture_output=True, text=True)
            if os.environ.get('OKKNOW_ORIGIN'):
                print('okknow: origin ' + os.environ['OKKNOW_ORIGIN'] + ' (from OKKNOW_ORIGIN; the probe sends no credentials)')
            elif saved.returncode == 0:
                print('okknow: origin ' + saved.stdout.strip() + ' (kept from the user config)')
            else:
                print('okknow: origin: the setup wizard asks for it')
            if 'mcp' in modules or 'mcp-codemode' in modules:
                print('okknow: MCP server okknow in ' + str(mcp_path))
        if 'artifacts' in modules:
            print('artifacts: package ' + str(artifacts_package))
            print('artifacts: CLI link ' + str(artifacts_link)
                  + (' (' + artifacts_link_state() + ')' if artifacts_link_state() else ''))
            if os.environ.get('ARTIFACTS_ORIGIN'):
                print('artifacts: origin ' + os.environ['ARTIFACTS_ORIGIN'] + ' (from ARTIFACTS_ORIGIN)')
            else:
                print('artifacts: origin from the user config, else the setup wizard asks for it')
        if os.environ.get('dummies') == 'yes':
            print('DUMMIES: on for Pi, shared by all profiles of this user; autostart block in the instruction file of the profile, else a new AGENTS.md')
        for line in aws_lines + kit_aws.plan_lines(home, profile, aws_rows, modules, os.environ.get('claude_aws') == 'yes',
                                                   adopt, skills=False):
            print(line)
        if 'computer-use' in modules and (home / '.claude').is_dir() and shutil.which('claude'):
            print('Claude Code plugin: ' + PLUGIN + (' (chosen)' if os.environ.get('plugin') == 'yes'
                                                      else ' (not chosen; --claude-plugin or a yes in a terminal is the yes)'))
        if (home / '.claude').is_dir():
            links = [dest.name for _, dest, skipped in claude_links() if not skipped]
            print('Claude skill links: ' + str(len(links)) + '\ntarget: ' + str(folder))
            for link in links:
                print('link: ' + link)
    elif action == 'profile':
        os.umask(0o077)
        profile.mkdir(parents=True, exist_ok=True)
        for line in aws_lines:
            print(line)
        if not settings_path.exists() or changed:
            if settings_path.exists():
                backup(settings_path)
            put(settings_path, json.dumps(settings, indent=2) + '\n')
        if new_steps:
            put(steps_path, json.dumps({'version': 1, 'added': done_steps + new_steps}, indent=2) + '\n')
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
    elif action == 'okknow-cli':
        state = okknow_link_state()
        if state:
            print(state, file=sys.stderr)
        else:
            okknow_link.parent.mkdir(parents=True, exist_ok=True)
            if okknow_link.is_symlink():
                okknow_link.unlink()
            okknow_link.symlink_to(okknow_script)
            print('okknow:  ' + str(okknow_link))
        found = shutil.which('okknow')
        if not found or Path(found).resolve() != okknow_script.resolve():
            print('okknow:  ' + ('the okknow on PATH is ' + found if found else str(okknow_link.parent) + ' is not on PATH')
                  + '; the profile launcher adds ' + str(okknow_link.parent) + ' at the end of PATH')
    elif action == 'artifacts-cli':
        state = artifacts_link_state()
        if state:
            print(state, file=sys.stderr)
        else:
            artifacts_link.parent.mkdir(parents=True, exist_ok=True)
            if artifacts_link.is_symlink():
                artifacts_link.unlink()
            artifacts_link.symlink_to(artifacts_script)
            print('artifacts: ' + str(artifacts_link))
    elif action == 'okknow-mcp':
        # Only the command of a header helper enters the file, never a credential.
        import subprocess
        command = str(okknow_link) if not okknow_link_state() else str(okknow_script)
        done = subprocess.run([sys.executable, str(okknow_script), 'origin'], capture_output=True, text=True)
        if done.returncode:
            print('okknow:  no origin configured, so no MCP entry; run okknow setup, then install.sh again')
            sys.exit(0)
        header = '!' + shlex.quote(command) + ' auth-header'
        entry = {'type': 'http', 'url': done.stdout.strip() + '/mcp', 'headers': {'Authorization': header}}
        entry |= {'timeout': 60} if mcp_path == native_path else {'lifecycle': 'lazy', 'requestTimeoutMs': 60000}
        if mcp_path.is_symlink():
            fail('refusing a symlink ' + mcp_path.name)
        data = json.loads(mcp_path.read_text()) if mcp_path.exists() else {}
        servers = data.setdefault('mcpServers', {}) if isinstance(data, dict) else None
        if not isinstance(servers, dict):
            fail(mcp_path.name + ' has no mcpServers object')
        old = servers.get('okknow')
        ours = isinstance(old, dict) and str(old.get('headers', {}).get('Authorization', '')).endswith(' auth-header')
        if old == entry:
            print('okknow:  MCP entry okknow unchanged')
        elif old is not None and not ours:
            print('skipped: ' + str(mcp_path) + ' has its own okknow entry', file=sys.stderr)
        else:
            if mcp_path.exists():
                backup(mcp_path)
            servers['okknow'] = entry
            put(mcp_path, json.dumps(data, indent=2) + '\n')
            print('okknow:  MCP entry okknow in ' + str(mcp_path))
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
        print('profile: ' + str(profile))
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
# The Claude Code plugin needs its own yes; --yes does not give it. Without a terminal, no plugin. The choice writes
# nothing, so it comes before the plan and the dry-run exit.
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
# The AWS rows of this run. One yes covers the Claude Code plugins of all of them, as for the plugin above:
# --claude-aws or a yes in a terminal; --yes does not give it, and without a terminal there is none.
aws_chosen=
for row in $(printf '%s\n' "$aws_modules" | tr , ' '); do
  case ,$modules, in *,"$row",*) aws_chosen=$aws_chosen${aws_chosen:+,}$row ;; esac
done
if [ ! -d "$HOME/.claude" ]; then
  claude_aws=
elif ! command -v claude >/dev/null 2>&1; then
  [ -z "$aws_chosen$claude_aws" ] || echo "claude-aws: no claude command on PATH, so no Claude Code AWS plugins"
  claude_aws=
elif [ -z "$claude_aws" ] && [ -n "$aws_chosen" ]; then
  if (true <"${INSTALL_TEST_TTY:-/dev/tty}") 2>/dev/null; then
    ask "Install the Claude Code plugins of the AWS rows $aws_chosen too, from a folder marketplace at the kit clone? The kit also adds deniedMcpServers entries to ~/.claude/settings.json. They turn off each server with the command of a plugin aws-mcp server, also a server of yours. One yes covers all of them. [yes/no]:"
    claude_aws=$answer
  else
    echo "claude-aws: no terminal and no --claude-aws, so no Claude Code AWS plugins"
  fi
fi
[ "$claude_aws" = yes ] || claude_aws=
helper plan || exit 2
# --dry-run: the plan of the choices, then exit 0 before the conflict question, the approval and the first write.
if [ "$dry_run" = yes ]; then
  if helper conflict; then :; else
    status=$?
    [ "$status" -eq 10 ] || exit "$status"
    if [ "$replace" = yes ]; then
      echo "conflict: the run replaces the alias, function or command $name (--replace-alias)"
    else
      echo "conflict: $name is another alias, function or command; the run asks before it replaces it"
    fi
  fi
  set -- --kit "$kit" --profile "$HOME/.pi/profiles/$name" --name "$name" --plain --with "$modules" --shell "$shell" --runtime "$runtime"
  [ -z "$dummies" ] || set -- "$@" --dummies
  [ "$plugin" != yes ] || set -- "$@" --claude-plugin
  [ -z "$claude_aws" ] || set -- "$@" --claude-aws
  [ "$adopt" = no ] || set -- "$@" --adopt-aws
  python3 "$kit/scripts/kit_inventory.py" "$@" || exit 2
  echo 'dry run: no file was written'
  exit 0
fi
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
# The AWS clone comes first: the skills entries of the profile step name its folders.
if [ -n "$aws_chosen" ]; then
  python3 "$kit/scripts/kit_aws.py" clone --kit "$kit" || { echo 'install: the AWS clone step failed; nothing was written' >&2; exit 1; }
fi
helper profile || { echo 'install: profile step failed; alias unchanged' >&2; exit 1; }
profile=$HOME/.pi/profiles/$name
# The aws-mcp entry of aws-core, or the removal of the kit entry when aws-core is off.
aws_failed=no
set -- mcp --kit "$kit" --profile "$profile" --with "$modules"
[ "$adopt" = no ] || set -- "$@" --adopt
python3 "$kit/scripts/kit_aws.py" "$@" || aws_failed=yes
# Herdr reads the transcript path of a Pi pane from its Pi integration. Pi loads it from <profile>/extensions.
# The step is best effort: a failure prints a warning and the install still exits 0.
if [ "$runtime_choice" = pi-bolt ]; then
  echo "herdr:   runtime pi-bolt has its own Herdr reporter, so no Herdr Pi integration"
elif command -v herdr >/dev/null 2>&1; then
  PI_CODING_AGENT_DIR=$profile herdr integration install pi ||
    echo "herdr:   warning: the Herdr Pi integration step failed; the install continues" >&2
else
  echo "herdr:   no herdr command on PATH, so no Herdr Pi integration"
fi
# okknow: the CLI link, then the setup wizard writes the user config, then the MCP entry.
okknow_failed=no
case ,$modules, in
  *,okknow,*)
    helper okknow-cli || okknow_failed=yes
    if [ -n "${OKKNOW_ORIGIN:-}" ]; then
      python3 "$okknow_cli" setup --origin "$OKKNOW_ORIGIN" --yes || okknow_failed=yes
    elif python3 "$okknow_cli" origin >/dev/null 2>&1; then
      echo "okknow:  keeps the origin $(python3 "$okknow_cli" origin) of the user config"
    else
      python3 "$okknow_cli" setup <"${INSTALL_TEST_TTY:-/dev/tty}" || okknow_failed=yes
    fi
    case ,$modules, in *,mcp,* | *,mcp-codemode,*) helper okknow-mcp || okknow_failed=yes ;; esac ;;
esac
# artifacts: the CLI link, then the setup writes the user config (no token).
artifacts_failed=no
case ,$modules, in
  *,artifacts,*)
    helper artifacts-cli || artifacts_failed=yes
    if [ -n "${ARTIFACTS_ORIGIN:-}" ]; then
      python3 "$artifacts_cli" setup --origin "$ARTIFACTS_ORIGIN" --token-file "$ARTIFACTS_TOKEN_FILE" --yes || artifacts_failed=yes
    elif python3 "$artifacts_cli" setup --check >/dev/null 2>&1; then
      echo "artifacts: keeps the user config $(python3 "$artifacts_cli" setup --check)"
    else
      python3 "$artifacts_cli" setup <"${INSTALL_TEST_TTY:-/dev/tty}" || artifacts_failed=yes
    fi ;;
esac
# The Walkr setup makes ~/.claude when it is absent. The Claude skill links of the kit follow the state before it.
claude_dir=no; [ -d "$HOME/.claude" ] && claude_dir=yes
# walkr: the dependencies of the package, then its own setup writes the skills and the Pi prompts.
# The package is not a Pi package of the profile: the skills hold the path of this clone.
walkr_failed=no
case ,$modules, in
  *,walkr,*)
    walkr_dir=$kit/packages/walkr
    if ! command -v node >/dev/null 2>&1; then
      echo 'walkr:   no node command on PATH' >&2; walkr_failed=yes
    elif [ "${INSTALL_SKIP_PACKAGES:-}" != 1 ]; then
      # A node_modules folder proves nothing: an interrupted npm run leaves one. Load each dependency.
      walkr_deps() { (cd "$walkr_dir" && node --input-type=module -e 'await import("css-tree"); await import("marked"); await import("parse5");') >/dev/null 2>&1; }
      if ! walkr_deps; then
        (cd "$walkr_dir" && npm ci --ignore-scripts --omit=dev) && walkr_deps || {
          echo 'walkr:   the dependencies of packages/walkr are not complete' >&2; walkr_failed=yes; }
      fi
    fi
    # The walkr-core skill calls its command by name, so the six commands get links, as in the Walkr installer.
    if [ "$walkr_failed" = no ]; then
      mkdir -p "$HOME/.local/bin"
      for pair in walkr:cli.js walkr-core:walkr-core.js walkr-double:walkr-double.js walkr-coinflip:walkr-coinflip.js walkr-trainer:walkr-trainer.js walkr-compare:walkr-compare.js; do
        link=$HOME/.local/bin/${pair%%:*} target=$walkr_dir/src/${pair#*:}
        if [ -L "$link" ]; then
          # A matching filename proves no ownership. Read the resolved package metadata, without executing it.
          if python3 - "$link" "${pair#*:}" <<'PY'
import json, sys
from pathlib import Path
try:
    target = Path(sys.argv[1]).resolve()
    package = json.loads((target.parent.parent / 'package.json').read_text())
    owned = target.parent.name == 'src' and target.name == sys.argv[2] and package.get('name') == 'walkr'
except (OSError, ValueError, RuntimeError, AttributeError):
    owned = False
sys.exit(0 if owned else 1)
PY
          then
            rm -f "$link"
          else
            echo "walkr:   $link is a link to another place; move it away and run again" >&2; walkr_failed=yes; continue
          fi
        elif [ -e "$link" ]; then
          echo "walkr:   $link exists and is not a link; move it away and run again" >&2; walkr_failed=yes; continue
        fi
        if ln -s "$target" "$link"; then
          echo "walkr:   $link"
        else
          echo "walkr:   could not create $link" >&2; walkr_failed=yes
        fi
      done
    fi
    if [ "$walkr_failed" = no ]; then
      node --input-type=module -e '
        const [setup, home, profile] = process.argv.slice(1);
        const { installSkills } = await import(setup);
        for (const line of installSkills(home, { global: true, home, piAgentDir: profile })) console.log("walkr:   " + line);
      ' "$walkr_dir/src/setup.js" "$HOME" "$profile" || walkr_failed=yes
    fi ;;
esac
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
# The Claude Code AWS plugins after the yes: for the chosen rows, and off for the kit plugins of the other rows.
aws_claude_failed=no
if [ -n "$claude_aws" ] && { [ -n "$aws_chosen" ] || python3 "$kit/scripts/kit_aws.py" claude-installed --kit "$kit"; }; then
  set -- claude --kit "$kit" --with "$modules" --claude
  [ "$adopt" = no ] || set -- "$@" --adopt
  python3 "$kit/scripts/kit_aws.py" "$@" || aws_claude_failed=yes
fi
if [ "$claude_dir" = yes ]; then
  helper links || { echo 'install: Claude skill links failed after profile success; alias unchanged' >&2; exit 1; }
else
  echo "skills:  no ~/.claude directory, so no Claude Code skill link"
fi
helper alias || { echo 'install: alias setup failed after profile success' >&2; exit 1; }
if [ -n "$dummies_status" ]; then
  printf '%s\n' "$dummies_status"
  printf '%s\n' "$dummies_on" | grep '^autostart: ' || :
fi
if [ "$okknow_failed" = yes ]; then
  echo 'install: an okknow step failed; the profile and the alias are in place. Run okknow setup' >&2
  exit 1
fi
if [ "$artifacts_failed" = yes ]; then
  echo 'install: an artifacts step failed; the profile and the alias are in place. Run artifacts setup' >&2
  exit 1
fi
if [ "$walkr_failed" = yes ]; then
  echo 'install: the walkr step failed; the profile and the alias are in place. See docs/guides/modules.md#walkr' >&2
  exit 1
fi
if [ "$dummies_failed" = yes ]; then
  echo 'install: the DUMMIES step failed; the profile and the alias are in place' >&2
  exit 1
fi
if [ "$plugin_failed" = yes ]; then
  echo 'install: the Claude Code plugin step failed; the profile and the alias are in place' >&2
  exit 1
fi
if [ "$aws_failed" = yes ]; then
  echo 'install: the aws-mcp step failed; the profile and the alias are in place. See docs/guides/aws-agent-toolkit.md' >&2
  exit 1
fi
if [ "$aws_claude_failed" = yes ]; then
  echo 'install: the Claude Code AWS step failed; the profile and the alias are in place. See docs/guides/aws-agent-toolkit.md' >&2
  exit 1
fi
printf 'Complete: %s\n' "$name"
