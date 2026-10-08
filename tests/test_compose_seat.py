"""Compose seat contract: the image recipe, the sshd configuration, the entrypoint, the shell profile,
the Compose files and the env templates, read as text.

No test builds an image or starts a container.
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from publish_check import PUBLISH  # noqa: E402

SEAT = ROOT / "deploy/compose"
FILES = (".dockerignore", "deploy/compose/Dockerfile", "deploy/compose/sshd_config",
         "deploy/compose/entrypoint.sh", "deploy/compose/README.md", "tests/test_compose_seat.py",
         "deploy/compose/compose.yaml", "deploy/compose/compose.projects.yaml",
         "deploy/compose/seat.env.example", "deploy/compose/compose.env.example", "deploy/compose/profile.sh")
HERDR = {"x86_64": "18a8dc65f1c2fa485884344356dea1cfd911c6f06cf46fa78e193f4087f4dba7",
         "aarch64": "4de7aa3e25678812e92960de64f7c2aaa1bca1f0f80a3c5e559837e231e1f5c0"}


def content(text):
    """The lines of a YAML, env or shell file that are not empty and are not comments, without indentation."""
    return [line.strip() for line in text.splitlines() if line.strip() and not line.lstrip().startswith("#")]


def instructions(text):
    """The Dockerfile instructions: comment lines dropped, continuation lines joined."""
    lines = [line for line in text.splitlines() if not line.lstrip().startswith("#")]
    return [item.strip() for item in re.sub(r"\\\n", " ", "\n".join(lines)).splitlines() if item.strip()]


class DockerfileTests(unittest.TestCase):
    def setUp(self):
        self.text = (SEAT / "Dockerfile").read_text(encoding="utf-8")
        self.steps = instructions(self.text)

    def test_base_image_has_the_tag_and_a_digest(self):
        bases = [step for step in self.steps if step.startswith("FROM ")]
        self.assertEqual(1, len(bases))
        self.assertRegex(bases[0], r"^FROM node:24-trixie-slim@sha256:[0-9a-f]{64}$")

    def test_herdr_has_one_digest_for_each_architecture(self):
        step = next(step for step in self.steps if "herdr-linux-" in step)
        self.assertIn("https://github.com/herdrdev/herdr/releases/download/v0.9.3/", step)
        for arch, debian in (("x86_64", "amd64"), ("aarch64", "arm64")):
            with self.subTest(arch=arch):
                found = re.search(rf"{debian}\) asset=herdr-linux-{arch}; sum=([0-9a-f]+) ;;", step)
                self.assertIsNotNone(found)
                self.assertRegex(found.group(1), r"^[0-9a-f]{64}$")
                self.assertEqual(HERDR[arch], found.group(1))
        self.assertIn("sha256sum -c -", step)

    def test_pi_install_reads_the_pin_from_the_manifest(self):
        step = next(step for step in self.steps if "pi-coding-agent" in step)
        self.assertIn('json.load(open("config/manifest.json"))["runtime"]["piVersion"]', step)
        self.assertIn('npm install --global --prefix /opt/pi-npm -- @earendil-works/pi-coding-agent@"${pin:?}"', step)
        pin = json.loads((ROOT / "config/manifest.json").read_text(encoding="utf-8"))["runtime"]["piVersion"]
        self.assertFalse([step for step in self.steps if pin in step])
        self.assertNotRegex(self.text, r"pi-coding-agent@[0-9]")
        self.assertFalse([step for step in self.steps if "npm config set" in step])

    def test_no_architecture_pin_and_no_user_instruction(self):
        self.assertNotIn("platform", self.text.lower())
        self.assertFalse([step for step in self.steps if re.match(r"(?i)USER\s", step)])
        self.assertEqual('ENTRYPOINT ["/usr/local/bin/seat-entrypoint"]', self.steps[-1])
        self.assertIn("EXPOSE 2222", self.steps)

    def test_account_has_a_star_password_field_and_no_admin_group(self):
        self.assertIn("usermod -p '*' \"$SEAT_USER\"", self.text)
        for word in ("sudo", "docker"):
            self.assertFalse([step for step in self.steps if word in step])
        for name, value in (("SEAT_USER", "pi"), ("SEAT_UID", "1000"), ("SEAT_GID", "1000")):
            self.assertIn(f"ARG {name}={value}", self.steps)
        self.assertIn("ARG TARGETARCH", self.steps)

    def test_checks_run_before_the_seat_build_record(self):
        checks = ("python3 -m unittest discover -s tests -q", "python3 scripts/examples.py",
                  "python3 scripts/validate.py --overlay config/config.example.json", "python3 scripts/publish_check.py")
        step = next(step for step in self.steps if checks[0] in step)
        for check in checks:
            self.assertIn(f'runuser -u "$SEAT_USER" -- env PYTHONDONTWRITEBYTECODE=1 {check}', step)
        record = next(step for step in self.steps if ".seat-build" in step)
        self.assertIn("printf 'kit_commit=%s\\npi_version=%s\\n' \"$KIT_COMMIT\" \"$pin\" > /opt/tenant-pi/.seat-build", record)
        self.assertLess(self.steps.index(step), self.steps.index(record))
        self.assertIn("ARG KIT_COMMIT=unknown", self.steps)

    def test_image_holds_no_host_key(self):
        self.assertTrue([step for step in self.steps if "rm -f /etc/ssh/ssh_host_*" in step])
        self.assertNotIn("ssh-keygen", self.text)

    def test_build_context_leaves_out_git_and_private_files(self):
        rules = (ROOT / ".dockerignore").read_text(encoding="utf-8").splitlines()
        for rule in (".git", ".local", ".env", "**/node_modules", "**/__pycache__"):
            self.assertIn(rule, rules)
        # The exception is after the rule: the last rule that matches a file wins.
        self.assertLess(rules.index(".env.*"), rules.index("!.env.example"))
        self.assertEqual(["!.env.example"], [rule for rule in rules if rule.startswith("!")])

    def test_build_writes_the_account_name_into_the_sshd_configuration(self):
        step = next(step for step in self.steps if "sed -i" in step)
        self.assertIn('sed -i "s/@SEAT_USER@/${SEAT_USER}/" /etc/ssh/sshd_config', step)
        self.assertIn("chmod 0700 /etc/ssh/keys", step)
        copy = self.steps.index("COPY deploy/compose/sshd_config /etc/ssh/sshd_config")
        self.assertLess(copy, self.steps.index(step))


    def test_build_installs_the_shell_profile_and_the_two_startup_files_read_it(self):
        copy = self.steps.index("COPY --chmod=644 deploy/compose/profile.sh /etc/profile.d/tenant-pi-seat.sh")
        self.assertLess(copy, self.steps.index("COPY --chown=${SEAT_UID}:${SEAT_GID} . /opt/tenant-pi"))
        step = self.steps[copy + 1]
        self.assertIn("line='[ -r /etc/profile.d/tenant-pi-seat.sh ] && . /etc/profile.d/tenant-pi-seat.sh'", step)
        self.assertIn('> "$home/.bashrc"', step)
        self.assertIn('>> "$home/.profile"', step)
        # The image holds no Herdr defaults file: Herdr 0.9.3 has no key for a default agent command.
        self.assertNotIn("herdr-config", self.text)
        for word in ("/etc/environment", "SetEnv", "AcceptEnv"):
            self.assertNotIn(word, self.text)


class SshdConfigTests(unittest.TestCase):
    def setUp(self):
        text = (SEAT / "sshd_config").read_text(encoding="utf-8")
        self.lines = [line.strip() for line in text.splitlines() if line.strip() and not line.startswith("#")]

    def test_settings(self):
        for line in ("Port 2222", "HostKey /etc/ssh/keys/ssh_host_ed25519_key", "PermitRootLogin no",
                     "PasswordAuthentication no", "KbdInteractiveAuthentication no", "UsePAM no",
                     "X11Forwarding no", "PrintMotd no", "AllowUsers @SEAT_USER@"):
            self.assertEqual(1, self.lines.count(line), line)

    def test_each_keyword_is_there_once_and_no_client_variable_is_accepted(self):
        words = [line.split()[0].lower() for line in self.lines]
        self.assertEqual(len(words), len(set(words)))
        for word in ("acceptenv", "setenv", "include", "match", "permituserenvironment"):
            self.assertNotIn(word, words)


class EntrypointTests(unittest.TestCase):
    def setUp(self):
        self.text = (SEAT / "entrypoint.sh").read_text(encoding="utf-8")
        self.lines = [line.strip() for line in self.text.splitlines()]
        self.code = [line for line in self.lines if line and not line.startswith("#")]

    def test_posix_shell_with_set_eu(self):
        self.assertEqual("#!/bin/sh", self.lines[0])
        self.assertEqual("set -eu", self.code[0])

    def test_host_key_only_when_absent(self):
        at = self.code.index("ssh-keygen -q -t ed25519 -N '' -f \"$HOST_KEY\"")
        self.assertEqual('if [ ! -f "$HOST_KEY" ]; then', self.code[at - 1])
        self.assertEqual(1, self.text.count("ssh-keygen"))
        self.assertIn("HOST_KEY=/etc/ssh/keys/ssh_host_ed25519_key", self.code)

    def test_missing_authorized_keys_stops_the_start(self):
        at = self.code.index('if [ ! -f "$PRIVATE/authorized_keys" ]; then')
        self.assertEqual("exit 1", self.code[at + 2])

    def test_authorized_keys_without_a_key_line_stops_the_start(self):
        at = self.code.index("if ! grep -q '^[[:space:]]*[^#[:space:]]' \"$PRIVATE/authorized_keys\"; then")
        self.assertEqual('say "authorized_keys: failed, $PRIVATE/authorized_keys holds no key line"', self.code[at + 1])
        self.assertEqual("exit 1", self.code[at + 2])
        self.assertLess(self.code.index('if [ ! -f "$PRIVATE/authorized_keys" ]; then'), at)
        self.assertLess(at, self.code.index('chown "$seat_uid:$seat_gid" "$SEAT_HOME"'))

    def test_key_directory_has_the_mode_0700(self):
        at = self.code.index("mkdir -p /etc/ssh/keys")
        self.assertEqual("chmod 0700 /etc/ssh/keys", self.code[at + 1])
        self.assertLess(at, self.code.index('if [ ! -f "$HOST_KEY" ]; then'))

    def test_root_part_runs_in_order(self):
        marks = ('if [ "$(id -u)" -ne 0 ]; then',
                 'if [ ! -f "$HOST_KEY" ]; then',
                 'if [ ! -f "$PRIVATE/authorized_keys" ]; then',
                 'chown "$seat_uid:$seat_gid" "$SEAT_HOME"',
                 '\' sh "$SEAT_HOME" < "$PRIVATE/authorized_keys"',
                 'install -d -m 0700 -o "$seat_uid" -g "$seat_gid" "$KEY_DIR"',
                 'runuser -u "$SEAT_USER" -- "$0" --seat-account',
                 "exec /usr/sbin/sshd -D -e")
        places = [self.code.index(mark) for mark in marks]
        self.assertEqual(sorted(places), places)
        for mark in marks:
            self.assertEqual(1, self.code.count(mark), mark)
        # The root part is after each function and after the --seat-account command.
        self.assertLess(self.code.index('if [ "${1:-}" = --seat-account ]; then'), places[0])
        self.assertLess(self.code.index("seat_account_steps() {"), places[0])

    def test_root_reads_authorized_keys_and_the_seat_account_writes_the_copy(self):
        start = self.code.index("runuser -u \"$SEAT_USER\" -- sh -c '")
        end = self.code.index('\' sh "$SEAT_HOME" < "$PRIVATE/authorized_keys"')
        self.assertEqual(["umask 077",
                          'mkdir -p "$1/.ssh" && chmod 0700 "$1/.ssh" || exit 1',
                          'rm -f "$1/.ssh/authorized_keys.new"',
                          'cat > "$1/.ssh/authorized_keys.new" && chmod 0600 "$1/.ssh/authorized_keys.new" || exit 1',
                          'mv -f "$1/.ssh/authorized_keys.new" "$1/.ssh/authorized_keys"'],
                         self.code[start + 1:end])
        # Root opens the source as the standard input. No root command names a file below .ssh.
        outside = self.code[:start] + self.code[end + 1:]
        self.assertFalse([line for line in outside if ".ssh/" in line and not line.startswith("say ")])
        self.assertFalse([line for line in self.code[start:end] if "PRIVATE" in line or "/private" in line])

    def test_gateway_key_goes_to_a_file_of_the_seat_account(self):
        self.assertIn("KEY_DIR=/run/tenant-pi-seat", self.code)
        at = self.code.index('install -d -m 0700 -o "$seat_uid" -g "$seat_gid" "$KEY_DIR"')
        # Each start removes the two files, then it reads the name of the variable.
        self.assertEqual(['rm -f "$KEY_DIR/gateway-key" "$KEY_DIR/gateway-key.name"',
                          'key_name="${SEAT_KEY_VAR:-TENANTEXT_LITELLM_API_KEY}"',
                          'case "$key_name" in',
                          "[!A-Za-z_]*|*[!A-Za-z0-9_]*)",
                          'say "gateway key: failed, SEAT_KEY_VAR is not the name of a variable"',
                          "exit 1", ";;", "esac",
                          'eval "key_value=\\${$key_name-}"',
                          'if [ -n "$key_value" ]; then'], self.code[at + 1:at + 11])
        start = self.code.index("printf '%s' \"$key_value\" | runuser -u \"$SEAT_USER\" -- sh -c '")
        end = self.code.index('\' sh "$KEY_DIR" "$key_name"')
        self.assertEqual(["umask 077",
                          'printf "%s\\n" "$2" > "$1/gateway-key.name" && chmod 0400 "$1/gateway-key.name" || exit 1',
                          'cat > "$1/gateway-key" && chmod 0400 "$1/gateway-key"'], self.code[start + 1:end])
        self.assertEqual("else", self.code[end + 2])
        self.assertEqual('say "gateway key: none, the variable $key_name is empty; '
                         'a provider with a native login needs no key"', self.code[end + 3])
        self.assertEqual(["fi", "unset key_value"], self.code[end + 4:end + 6])
        # An empty key does not stop the start: the only exit of the part is the name check.
        self.assertEqual(1, self.code[at:end + 6].count("exit 1"))

    def test_gateway_key_is_never_exported_and_never_in_a_message(self):
        self.assertEqual(["export HOME"], [line for line in self.code if re.match(r"export\b", line)])
        uses = [line for line in self.code if "key_value" in line]
        self.assertEqual(['eval "key_value=\\${$key_name-}"', 'if [ -n "$key_value" ]; then',
                          "printf '%s' \"$key_value\" | runuser -u \"$SEAT_USER\" -- sh -c '",
                          "unset key_value"], uses)
        # Root writes no file of the key directory: the seat account writes the two files.
        self.assertFalse([line for line in self.code if re.search(r'>>?\s*"?\$KEY_DIR', line)])
        for word in ("compose.env", "/etc/environment", ".profile", "AcceptEnv", "SetEnv"):
            self.assertNotIn(word, self.text)

    def test_entrypoint_writes_no_herdr_file(self):
        self.assertNotIn("herdr", self.text.lower())

    def test_home_owner_change_is_for_the_top_directory_only(self):
        owners = [line for line in self.code if re.match(r"chown\b", line)]
        self.assertEqual(['chown "$seat_uid:$seat_gid" "$SEAT_HOME"'], owners)
        self.assertNotRegex(self.text, r"chown\s+(-\S*R|--recursive)")

    def test_seat_account_command_runs_only_as_the_seat_account(self):
        at = self.code.index('if [ "${1:-}" = --seat-account ]; then')
        self.assertEqual(['if [ "$(id -u)" != "$(id -u "$SEAT_USER")" ]; then',
                          'say "seat account: failed, only the account $SEAT_USER runs the seat steps"',
                          "exit 1", "fi", "seat_account_steps", "exit 0", "fi"],
                         self.code[at + 1:at + 8])
        self.assertEqual(2, self.code.count("seat_account_steps") + self.code.count("seat_account_steps() {"))

    def test_incomplete_profile_without_a_build_record_stops_the_start(self):
        at = self.code.index('if [ ! -f "$STATE/seat-build" ]; then')
        self.assertEqual(['if ! profile_complete "$main"; then',
                          'record "main: the profile $main is incomplete; remove it and start again"',
                          "exit 1", "fi", 'cp "$KIT/.seat-build" "$STATE/seat-build"'],
                         self.code[at + 1:at + 6])
        self.assertEqual("return 0", self.code[at + 7])
        # The guard is before the comparison of the two records and before the candidate.
        compare = self.code.index('if cmp -s "$KIT/.seat-build" "$STATE/seat-build"; then')
        self.assertLess(at, compare)
        self.assertLess(self.code.index("seat_account_steps() {"), at)
        check = self.code.index("profile_complete() {")
        self.assertEqual('sys.exit(0 if json.load(open(sys.argv[1]))["status"] == "complete" else 1)\' \\',
                         self.code[check + 2])
        self.assertEqual('"$1/.tenant-pi/state.json" 2>/dev/null', self.code[check + 3])

    def test_candidate_name_holds_the_kit_commit_and_the_pi_version(self):
        compare = self.code.index('if cmp -s "$KIT/.seat-build" "$STATE/seat-build"; then')
        self.assertEqual("return 0", self.code[compare + 2])
        name = self.code.index('name="candidate-$(build_value kit_commit)-$(build_value pi_version)"')
        self.assertLess(compare, name)
        self.assertEqual(['candidate="$HOME/.pi/profiles/$name"', 'launcher="$HOME/.local/bin/pi-profile-$name"',
                          'if [ -e "$candidate" ] || [ -L "$candidate" ]; then'], self.code[name + 1:name + 4])
        self.assertIn('make_profile "$name" "$STATE/$name-overlay.json" "$candidate" "$launcher" || return 0', self.code)
        # One character rule for the two values of the record.
        value = self.code.index("build_value() {")
        self.assertEqual(['value="$(sed -n "s/^$1=//p" "$KIT/.seat-build" | head -n 1)"', 'case "$value" in',
                          '""|*[!A-Za-z0-9._-]*) value=unknown ;;', "esac"], self.code[value + 1:value + 5])
        self.assertEqual(1, self.text.count("A-Za-z0-9._-"))

    def test_generate_runs_only_behind_the_guard(self):
        calls = [n for n, line in enumerate(self.code) if "tenant_pi.py generate" in line]
        self.assertEqual(1, len(calls))
        guard = self.code.index('if [ -e "$target" ] || [ -L "$target" ]; then')
        start = self.code.index("make_profile() {")
        self.assertLess(start, guard)
        self.assertLess(guard, calls[0])
        # The guard leaves the function before any other command of the function runs.
        self.assertEqual("return 1", self.code[guard + 2])
        self.assertEqual("name=$1 overlay=$2 target=$3 launcher=$4", self.code[guard - 1])
        self.assertIn('--target "$target"', self.code[calls[0]])
        self.assertLess(calls[0], self.code.index("seat_account_steps() {"))

    def test_writes_stay_out_of_the_private_directory(self):
        for line in self.code:
            self.assertNotRegex(line, r'>>?\s*"?(\$PRIVATE|/private)')
        self.assertIn('--launcher "$launcher"', self.text)
        self.assertIn('"$HOME/.local/bin/pi-profile"', self.text)

    def test_ends_with_sshd_in_the_foreground(self):
        self.assertEqual("exec /usr/sbin/sshd -D -e", self.code[-1])
        self.assertEqual(1, len([line for line in self.code if line.startswith("exec ")]))


class ProfileTests(unittest.TestCase):
    def setUp(self):
        self.text = (SEAT / "profile.sh").read_text(encoding="utf-8")
        self.code = content(self.text)

    def run_profile(self, run_dir, command, **env):
        """Read a copy of the profile, with the key directory changed, in a shell that is not interactive."""
        with tempfile.TemporaryDirectory() as tmp:
            copy = Path(tmp) / "profile.sh"
            self.assertEqual(1, self.code.count("seat_run=/run/tenant-pi-seat"))
            copy.write_text(self.text.replace("seat_run=/run/tenant-pi-seat", f"seat_run='{run_dir}'"),
                            encoding="utf-8")
            return subprocess.run(["sh", "-euc", f'. "$1"; {command}', "sh", str(copy)], text=True,
                                  capture_output=True, timeout=20, stdin=subprocess.DEVNULL,
                                  env={"PATH": "/usr/bin:/bin", "HOME": "/home/EXAMPLE_USER", **env})

    def test_path_has_the_launcher_directory_and_the_pi_prefix(self):
        with tempfile.TemporaryDirectory() as run_dir:
            result = self.run_profile(run_dir, 'printf "%s" "$PATH"')
        self.assertEqual((0, "/opt/pi-npm/bin:/home/EXAMPLE_USER/.local/bin:/usr/bin:/bin"),
                         (result.returncode, result.stdout), result.stderr)

    def test_exports_the_key_from_the_file_under_the_name_of_the_name_file(self):
        self.assertIn('*) export "$seat_key_name=$(cat "$seat_run/gateway-key")" ;;', self.code)
        self.assertIn('if [ -r "$seat_run/gateway-key" ] && [ -r "$seat_run/gateway-key.name" ]; then', self.code)
        value = "example value$x\"q"
        with tempfile.TemporaryDirectory() as run_dir:
            Path(run_dir, "gateway-key").write_text(value, encoding="utf-8")
            Path(run_dir, "gateway-key.name").write_text("EXAMPLE_KEY\n", encoding="utf-8")
            result = self.run_profile(run_dir, 'env | grep -c "^EXAMPLE_KEY="; printf "%s" "$EXAMPLE_KEY"')
            self.assertEqual((0, "1\n" + value), (result.returncode, result.stdout), result.stderr)
            # A name that is not a variable name exports nothing and runs nothing.
            Path(run_dir, "gateway-key.name").write_text("A;touch $HOME/x\n", encoding="utf-8")
            result = self.run_profile(run_dir, "env")
            self.assertEqual(0, result.returncode, result.stderr)
            self.assertNotIn(value, result.stdout)

    def test_no_key_file_exports_no_variable(self):
        with tempfile.TemporaryDirectory() as run_dir:
            result = self.run_profile(run_dir, "env")
        self.assertEqual(0, result.returncode, result.stderr)
        self.assertLessEqual({line.split("=")[0] for line in result.stdout.splitlines()}, {"PATH", "HOME", "PWD"})

    def test_interactive_ssh_login_starts_or_attaches_the_tmux_session(self):
        at = self.code.index('tmux new-session -A -s seat -c "$seat_dir" && exit')
        self.assertEqual(['seat_dir="$HOME"', "if [ -d /projects ]; then seat_dir=/projects; fi"],
                         self.code[at - 2:at])
        self.assertEqual(1, self.text.count("tmux new-session"))
        # No exec: a tmux that fails must leave the login shell.
        self.assertFalse([line for line in self.code if re.match(r"exec\b", line)])
        start = self.code.index("seat_tmux() {")
        self.assertLess(start, at)
        call = self.code.index("seat_tmux")
        self.assertLess(at, call)
        self.assertEqual(['case "$-" in', "*i*)",
                          'if [ -n "${SSH_CONNECTION:-}" ] && [ -z "${TMUX:-}" ] && [ -t 0 ] '
                          '&& command -v tmux >/dev/null 2>&1; then'], self.code[call - 3:call])
        # A shell that is not interactive starts no tmux, also with SSH_CONNECTION.
        with tempfile.TemporaryDirectory() as run_dir:
            result = self.run_profile(run_dir, "printf done", SSH_CONNECTION="192.0.2.1 1 192.0.2.2 2222")
        self.assertEqual((0, "done"), (result.returncode, result.stdout), result.stderr)

    def run_seat_tmux(self, tmux_status, infocmp_status, term):
        """Run the function seat_tmux under dash, with a stub tmux and a stub infocmp first on the PATH."""
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp) / "home"
            stubs = home / ".local/bin"
            stubs.mkdir(parents=True)
            for name, body in (("tmux", f'printf "tmux %s TERM=%s\\n" "$*" "$TERM"\nexit {tmux_status}\n'),
                               ("infocmp", f"exit {infocmp_status}\n")):
                (stubs / name).write_text("#!/bin/sh\n" + body, encoding="utf-8")
                (stubs / name).chmod(0o755)
            return home, subprocess.run(["dash", "-euc", '. "$1"; seat_tmux; printf "shell continues\\n"', "dash",
                                         str(SEAT / "profile.sh")], text=True, capture_output=True, timeout=20,
                                        stdin=subprocess.DEVNULL,
                                        env={"PATH": "/usr/bin:/bin", "HOME": str(home), "TERM": term})

    @unittest.skipUnless(shutil.which("dash"), "dash is absent")
    def test_failing_tmux_leaves_the_shell(self):
        home, result = self.run_seat_tmux(1, 0, "xterm")
        self.assertEqual((0, [f"tmux new-session -A -s seat -c {home} TERM=xterm",
                              "seat: tmux failed; this shell has no tmux session", "shell continues"]),
                         (result.returncode, result.stdout.splitlines()), result.stderr)

    @unittest.skipUnless(shutil.which("dash"), "dash is absent")
    def test_tmux_without_an_error_ends_the_login(self):
        home, result = self.run_seat_tmux(0, 0, "xterm")
        self.assertEqual((0, [f"tmux new-session -A -s seat -c {home} TERM=xterm"]),
                         (result.returncode, result.stdout.splitlines()), result.stderr)

    @unittest.skipUnless(shutil.which("dash"), "dash is absent")
    def test_unknown_term_becomes_xterm_256color(self):
        home, result = self.run_seat_tmux(1, 1, "xterm-ghostty")
        self.assertEqual((0, ["seat: the image does not know TERM=xterm-ghostty; TERM is now xterm-256color",
                              f"tmux new-session -A -s seat -c {home} TERM=xterm-256color",
                              "seat: tmux failed; this shell has no tmux session", "shell continues"]),
                         (result.returncode, result.stdout.splitlines()), result.stderr)

    def test_profile_reads_no_private_file(self):
        for word in ("/private", "compose.env", "/etc/environment"):
            self.assertNotIn(word, self.text)


class ComposeFileTests(unittest.TestCase):
    def setUp(self):
        self.text = (SEAT / "compose.yaml").read_text(encoding="utf-8")
        self.code = content(self.text)
        self.projects = content((SEAT / "compose.projects.yaml").read_text(encoding="utf-8"))

    def test_one_service_with_the_build_from_the_kit_root(self):
        services = self.text[self.text.index("\nservices:\n"):self.text.index("\nvolumes:\n")]
        self.assertEqual(["  seat:"], re.findall(r"(?m)^  [^ #].*$", services))
        for line in ("name: tenant-pi-seat", "context: ../..", "dockerfile: deploy/compose/Dockerfile",
                     'SEAT_USER: "${SEAT_USER:-pi}"', 'SEAT_UID: "${SEAT_UID:-1000}"',
                     'SEAT_GID: "${SEAT_GID:-1000}"', 'image: "tenant-pi-seat:${KIT_COMMIT}"'):
            self.assertEqual(1, self.code.count(line), line)

    def test_kit_commit_is_mandatory(self):
        lines = [line for line in self.code if line.startswith("KIT_COMMIT:")]
        self.assertEqual(1, len(lines))
        self.assertRegex(lines[0], r'^KIT_COMMIT: "\$\{KIT_COMMIT:\?[^}]*git rev-parse --short HEAD[^}]*\}"$')

    def test_root_start_init_and_no_restart(self):
        for line in ('user: "0:0"', "init: true", 'restart: "no"'):
            self.assertEqual(1, self.code.count(line), line)

    def test_userns_mode_has_an_empty_default(self):
        self.assertEqual(['userns_mode: "${SEAT_USERNS:-}"'], [line for line in self.code if "userns" in line])

    def test_port_default_is_the_local_address(self):
        at = self.code.index("ports:")
        self.assertEqual('- "${SEAT_BIND:-127.0.0.1}:${SEAT_SSH_PORT:-2222}:2222"', self.code[at + 1])
        self.assertEqual(1, len([line for line in self.code if "2222" in line]))
        self.assertNotIn("0.0.0.0", " ".join(self.code))

    def test_environment_comes_from_the_private_directory(self):
        at = self.code.index("env_file:")
        self.assertRegex(self.code[at + 1], r'^- "\$\{SEAT_PRIVATE_DIR:\?[^}]*\}/compose\.env"$')
        at = self.code.index("environment:")
        self.assertEqual('SEAT_KEY_VAR: "${SEAT_KEY_VAR:-TENANTEXT_LITELLM_API_KEY}"', self.code[at + 1])
        self.assertEqual("volumes:", self.code[at + 2])

    def test_volumes_and_the_key_tmpfs(self):
        at = self.code.index("volumes:")
        self.assertEqual(['- "seat-home:/home/${SEAT_USER:-pi}"', '- "seat-ssh:/etc/ssh/keys"',
                          '- "${SEAT_PRIVATE_DIR}:/private:ro"', "tmpfs:", '- "/run/tenant-pi-seat:mode=0700"',
                          "volumes:", "seat-home:", "seat-ssh:"], self.code[at + 1:])

    def test_projects_bind_is_only_in_the_second_file(self):
        self.assertNotIn("/projects", " ".join(self.code))
        self.assertNotIn("SEAT_PROJECTS_DIR", " ".join(self.code))
        self.assertEqual(["services:", "seat:", "volumes:"], self.projects[:3])
        self.assertEqual(4, len(self.projects))
        self.assertRegex(self.projects[3], r'^- "\$\{SEAT_PROJECTS_DIR:\?[^}]*\}:/projects"$')

    def test_no_key_of_one_runtime_only(self):
        for lines in (self.code, self.projects):
            text = "\n".join(lines)
            for word in ("extra_hosts", "x-podman", "network_mode", "platform", "host-gateway", "privileged",
                         "cap_add"):
                self.assertNotIn(word, text)
            self.assertNotRegex(text, r":U\b|[:,]U[\",]")


class EnvExampleTests(unittest.TestCase):
    def values(self, name):
        lines = content((SEAT / name).read_text(encoding="utf-8"))
        for line in lines:
            self.assertRegex(line, r"^[A-Z][A-Z0-9_]*=\S*$")
        # Empty single quotes are an empty value: the key line shows the quotes that the operator keeps.
        return {name: "" if value == "''" else value for name, value in (line.split("=", 1) for line in lines)}

    def test_container_environment_example_holds_no_value(self):
        self.assertEqual({"TENANTEXT_LITELLM_API_KEY": "", "TENANTEXT_LITELLM_BASE_URL": ""},
                         self.values("compose.env.example"))
        text = (SEAT / "compose.env.example").read_text(encoding="utf-8")
        self.assertIn("\n# Put the value between single quotes: Compose interpolates $, "
                      "and an unquoted \" #\" starts a comment.\nTENANTEXT_LITELLM_API_KEY=''\n", text)

    def test_interpolation_example_has_the_defaults_of_the_compose_file(self):
        values = self.values("seat.env.example")
        self.assertEqual({"SEAT_PRIVATE_DIR": "", "SEAT_USER": "pi", "SEAT_UID": "1000", "SEAT_GID": "1000",
                          "SEAT_BIND": "127.0.0.1", "SEAT_SSH_PORT": "2222", "SEAT_USERNS": "",
                          "SEAT_KEY_VAR": "TENANTEXT_LITELLM_API_KEY"}, values)
        text = (SEAT / "seat.env.example").read_text(encoding="utf-8")
        self.assertIn("\n#SEAT_PROJECTS_DIR=\n", text)
        self.assertNotRegex(text, r"(?m)^#?KIT_COMMIT=")
        # Each variable has one comment line before it.
        lines = text.splitlines()
        for name in list(values) + ["#SEAT_PROJECTS_DIR"]:
            at = next(n for n, line in enumerate(lines) if line.startswith(name + "="))
            self.assertTrue(lines[at - 1].startswith("# "), name)

    def test_each_variable_of_the_compose_files_is_in_an_example_or_is_the_kit_commit(self):
        text = "".join((SEAT / name).read_text(encoding="utf-8") for name in ("compose.yaml", "compose.projects.yaml"))
        names = set(re.findall(r"\$\{([A-Z_]+)", "\n".join(content(text))))
        example = (SEAT / "seat.env.example").read_text(encoding="utf-8")
        self.assertEqual(names - {"KIT_COMMIT"}, set(re.findall(r"(?m)^#?([A-Z_]+)=", example)))


@unittest.skipUnless(shutil.which("docker"), "docker is absent")
class ComposeConfigTests(unittest.TestCase):
    """`docker compose config` reads the files and starts nothing."""

    def config(self, tmp, lines, *files, format="yaml"):
        env_file = Path(tmp) / "seat.env"
        env_file.write_text("".join(line + "\n" for line in lines), encoding="utf-8")
        command = ["docker", "compose", "--env-file", str(env_file)]
        for name in files:
            command += ["-f", str(SEAT / name)]
        env = {name: value for name, value in os.environ.items()
               if not name.startswith(("SEAT_", "KIT_COMMIT", "COMPOSE_"))}
        return subprocess.run(command + ["config", "--format", format], text=True, capture_output=True, timeout=60,
                              stdin=subprocess.DEVNULL, env=env)

    def setUp(self):
        probe = subprocess.run(["docker", "compose", "version"], capture_output=True, timeout=60,
                               stdin=subprocess.DEVNULL)
        if probe.returncode != 0:
            self.skipTest("docker compose is absent")

    def test_config_with_the_defaults(self):
        with tempfile.TemporaryDirectory() as tmp:
            private = Path(tmp) / "private dir"
            private.mkdir()
            (private / "compose.env").write_text("TENANTEXT_LITELLM_API_KEY=\n", encoding="utf-8")
            result = self.config(tmp, ["KIT_COMMIT=test", f"SEAT_PRIVATE_DIR={private}"], "compose.yaml")
            self.assertEqual(0, result.returncode, result.stderr)
            out = result.stdout
            for part in ("image: tenant-pi-seat:test", "KIT_COMMIT: test", "host_ip: 127.0.0.1",
                         'published: "2222"', "target: 2222", "init: true", "target: /home/pi",
                         "target: /etc/ssh/keys", "read_only: true",
                         "/run/tenant-pi-seat:mode=0700", "SEAT_KEY_VAR: TENANTEXT_LITELLM_API_KEY",
                         "name: tenant-pi-seat_seat-home"):
                self.assertIn(part, out)
            result = self.config(tmp, ["KIT_COMMIT=test", f"SEAT_PRIVATE_DIR={private}"], "compose.yaml",
                                 format="json")
            self.assertEqual(0, result.returncode, result.stderr)
            volumes = json.loads(result.stdout)["services"]["seat"]["volumes"]
            binds = [(item["source"], item["target"], item.get("read_only", False))
                     for item in volumes if item["type"] == "bind"]
            self.assertEqual([(str(private), "/private", True)], binds)
            self.assertRegex(out, r"restart: ['\"]no['\"]")
            self.assertRegex(out, r"user: ['\"]?0:0")
            # The empty default leaves the key out, so Docker gets no user namespace value.
            for word in ("userns_mode", "/projects", "extra_hosts", "platform"):
                self.assertNotIn(word, out)

    def test_config_with_the_podman_value_and_the_projects_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "compose.env").write_text("", encoding="utf-8")
            projects = Path(tmp) / "projects"
            projects.mkdir()
            result = self.config(tmp, ["KIT_COMMIT=test", f"SEAT_PRIVATE_DIR={tmp}", "SEAT_USER=dev",
                                       "SEAT_USERNS=keep-id:uid=501,gid=20", f"SEAT_PROJECTS_DIR={projects}"],
                                 "compose.yaml", "compose.projects.yaml")
            self.assertEqual(0, result.returncode, result.stderr)
            for part in ("userns_mode: keep-id:uid=501,gid=20", "target: /home/dev", "SEAT_USER: dev",
                         "target: /projects"):
                self.assertIn(part, result.stdout)
            result = self.config(tmp, ["KIT_COMMIT=test", f"SEAT_PRIVATE_DIR={tmp}", "SEAT_USER=dev",
                                       "SEAT_USERNS=keep-id:uid=501,gid=20", f"SEAT_PROJECTS_DIR={projects}"],
                                 "compose.yaml", "compose.projects.yaml", format="json")
            self.assertEqual(0, result.returncode, result.stderr)
            volumes = json.loads(result.stdout)["services"]["seat"]["volumes"]
            binds = [(item["source"], item["target"], item.get("read_only", False))
                     for item in volumes if item["type"] == "bind"]
            self.assertCountEqual([(tmp, "/private", True), (str(projects), "/projects", False)], binds)

    def test_config_fails_without_the_kit_commit(self):
        with tempfile.TemporaryDirectory() as tmp:
            (Path(tmp) / "compose.env").write_text("", encoding="utf-8")
            result = self.config(tmp, [f"SEAT_PRIVATE_DIR={tmp}"], "compose.yaml")
            self.assertNotEqual(0, result.returncode)
            self.assertIn("git rev-parse --short HEAD", result.stderr)


class PublishSetTests(unittest.TestCase):
    def test_each_new_file_is_in_the_publish_set(self):
        for name in FILES:
            with self.subTest(name=name):
                self.assertTrue((ROOT / name).is_file())
                self.assertEqual(1, PUBLISH.count(name))


if __name__ == "__main__":
    unittest.main()
