"""The installer screen in a pty of 80x24 with a real inventory of a throwaway profile and its catalog."""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import struct
import subprocess
import sys
import tempfile
import termios
import time
import unittest

from scripts import kit_tui

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / 'scripts/kit_tui.py'
FIXTURES = ROOT / 'tests/fixtures/kit_tui'
DOWN = b'\x1bOB'


class KitTuiTests(unittest.TestCase):
    def stop(self, process):
        """Kill and reap the screen, then return its stderr; a wait past the timeout fails the test."""
        if process.poll() is None:
            process.kill()
        return process.communicate(timeout=10)[1].decode(errors='replace')

    def read_until(self, master, process, marker, deadline):
        screen = b''
        while marker not in screen:
            if time.monotonic() > deadline or process.poll() is not None:
                self.fail('no ' + marker.decode() + ' on the screen: ' + self.stop(process))
            if select.select([master], [], [], .1)[0]:
                screen += os.read(master, 65536)

    def test_toggle_one_item_and_confirm_prints_the_selection(self):
        # The target is off in the fixture. The number of Down keys comes from the row order of the script itself.
        inventory = json.loads((FIXTURES / 'inventory.json').read_text())
        model = kit_tui.Model(inventory, json.loads((FIXTURES / 'catalog.json').read_text()))
        items = [row[1] for row in model.rows if row[0] == 'item']
        target = next(item for item in items if item.name == 'wiki')
        self.assertFalse(target.on)
        # An installed item whose own switch is off starts off: the selection starts from `active`, not from `plan`.
        self.assertFalse(next(item for item in items if item.installed is True and item.active is False).on)
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'TERM': 'xterm', 'PYTHONDONTWRITEBYTECODE': '1',
               'INSTALL_TEST_TTY': os.ttyname(slave)}
        process = subprocess.Popen([sys.executable, str(SCRIPT), '--inventory', str(FIXTURES / 'inventory.json'),
                                    '--catalog', str(FIXTURES / 'catalog.json')],
                                   env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop, process)
        deadline = time.monotonic() + 20
        # The footer comes last in the first paint. Space names the item that it toggles in the status line.
        self.read_until(master, process, b'abort', deadline)
        os.write(master, DOWN * items.index(target) + b' ')
        self.read_until(master, process, target.name.encode() + b': ', deadline)
        os.write(master, b'\r')
        self.read_until(master, process, b'Confirm the plan', deadline)
        os.write(master, b'\r')
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                os.read(master, 65536)
        if process.poll() is None:
            self.fail('no exit after the confirmation: ' + self.stop(process))
        out, err = process.communicate(timeout=10)
        self.assertEqual(0, process.returncode, err.decode())
        selection = json.loads(out)
        self.assertTrue(selection['confirmed'])
        self.assertIn(target.name, selection['enable'])
        self.assertNotIn(target.name, selection['disable'])
        # The fixture item needs consent, so the screen marks it as requested.
        self.assertEqual([target.name], selection['consent'])

    def profile_choice(self, folder, keys):
        """Run the profile choice in a pty, send the keys after the first paint, and return the finished process."""
        master, slave = pty.openpty()
        self.addCleanup(os.close, master)
        self.addCleanup(os.close, slave)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 80, 0, 0))
        env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'TERM': 'xterm', 'PYTHONDONTWRITEBYTECODE': '1',
               'INSTALL_TEST_TTY': os.ttyname(slave)}
        process = subprocess.Popen([sys.executable, str(SCRIPT), '--profiles', str(folder)], env=env,
                                   stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.addCleanup(self.stop, process)
        deadline = time.monotonic() + 20
        sent = False
        while process.poll() is None and time.monotonic() < deadline:
            if select.select([master], [], [], .1)[0]:
                os.read(master, 65536)
                if not sent:
                    os.write(master, keys)
                    sent = True
        if process.poll() is None:
            self.fail('no exit after the keys: ' + self.stop(process))
        out, err = process.communicate(timeout=10)
        return process.returncode, out.decode(), err.decode()

    def test_the_profile_choice_gives_a_known_profile_or_a_new_valid_name(self):
        with tempfile.TemporaryDirectory() as folder:
            for name in ('alpha', 'beta', 'Not-A-Profile'):
                (Path(folder) / name).mkdir()
            self.assertEqual(['alpha', 'beta'], kit_tui.known_profiles(folder))
            choice = kit_tui.ProfileChoice(kit_tui.known_profiles(folder))
            choice.move(1)
            self.assertEqual({'mode': 'upgrade', 'name': 'beta'}, choice.choice())
            choice.move(1)
            # The name rule of install.sh: a refused name and the name of a known profile give no choice.
            for typed in ('', 'Upper', '9x', 'a' * 33, 'alpha'):
                choice.typed = typed
                self.assertIsNone(choice.choice(), typed)
            choice.typed = ''
            for key in 'xyz-pi':
                choice.type(key)
            self.assertEqual({'mode': 'new', 'name': 'xyz-pi'}, choice.choice())
            # On the terminal, the screen prints the choice that install.sh reads.
            code, out, err = self.profile_choice(folder, DOWN + b'\r')
            self.assertEqual((0, {'mode': 'upgrade', 'name': 'beta'}), (code, json.loads(out or 'null')), err)

    def test_a_module_and_its_prompt_resource_get_the_plan_of_the_planner(self):
        # The planner is the real inventory of an absent profile in a throwaway HOME, as install.sh passes it.
        with tempfile.TemporaryDirectory() as home:
            planner = ['env', 'HOME=' + home, sys.executable, '-B', str(ROOT / 'scripts/kit_inventory.py'),
                       '--kit', str(ROOT), '--profile', home + '/demo', '--name', 'demo', '--json']
            inventory = json.loads(subprocess.run(planner, capture_output=True, check=True, timeout=60).stdout)
            model = kit_tui.Model(inventory, json.loads((ROOT / 'config/catalog.json').read_text()), {'artifacts'},
                                  planner=planner)
            items = {item.name: item for item in model.items}
            model.toggle(items['artifacts'])
            model.refresh()
            self.assertEqual(['install', 'install'],
                             [model.plan(items[name]) for name in ('artifacts', 'artifacts-prompt')])

    def test_an_installed_item_that_a_kit_step_turns_on_gets_install(self):
        # The real inventory of a profile whose plain filter list predates the kit step of herdr-idle-cleanup.
        with tempfile.TemporaryDirectory() as home:
            profile = Path(home) / '.pi/profiles/demo'
            profile.mkdir(parents=True)
            entry = {'source': str(ROOT / 'packages/tenantext'), 'extensions': ['extensions/tenantext/index.ts'],
                     'skills': [], 'prompts': []}
            (profile / 'settings.json').write_text(json.dumps({'packages': [entry]}))
            planner = ['env', 'HOME=' + home, sys.executable, '-B', str(ROOT / 'scripts/kit_inventory.py'),
                       '--kit', str(ROOT), '--profile', str(profile), '--name', 'demo', '--json']
            inventory = json.loads(subprocess.run(planner, capture_output=True, check=True, timeout=60).stdout)
            # The choices of install.sh: handoffs is no choice, so its row keeps the plan of the inventory.
            choices = {'wiki', 'hermes', 'mcp', 'computer-use', 'okknow', 'artifacts', 'walkr', 'mcp-codemode'}
            model = kit_tui.Model(inventory, json.loads((ROOT / 'config/catalog.json').read_text()), choices)
            handoffs = next(item for item in model.items if item.name == 'handoffs')
            self.assertEqual((False, 'install'), (handoffs.on, model.plan(handoffs)))

    def test_a_failed_planner_leaves_no_plan_to_confirm(self):
        # Enter in the plan view returns the selection only when `confirmable`; a failed planner gives an estimate.
        model = kit_tui.Model(json.loads((FIXTURES / 'inventory.json').read_text()),
                              json.loads((FIXTURES / 'catalog.json').read_text()),
                              planner=[sys.executable, '-c', 'raise SystemExit(2)'])
        model.refresh(retry=True)
        self.assertFalse(model.confirmable)

    def test_an_unexpected_error_exits_2_with_one_line(self):
        code = ('import sys\nfrom scripts import kit_tui\n'
                'def fail(function):\n    raise RuntimeError("forced\\nfailure")\n'
                'kit_tui.on_terminal = fail\nsys.exit(kit_tui.main(sys.argv[1:]))\n')
        result = subprocess.run([sys.executable, '-B', '-c', code, '--inventory', str(FIXTURES / 'inventory.json'),
                                 '--catalog', str(FIXTURES / 'catalog.json')], cwd=ROOT, capture_output=True, text=True,
                                timeout=60)
        self.assertEqual((2, 1), (result.returncode, len(result.stderr.splitlines())), result.stderr)


if __name__ == '__main__':
    unittest.main()
