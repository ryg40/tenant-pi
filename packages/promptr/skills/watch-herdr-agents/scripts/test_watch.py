#!/usr/bin/env python3
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import subprocess
import watch


class WatchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.cfg = json.loads((Path(__file__).parent.parent / 'assets/config.example.json').read_text())
        self.cfg.update(stateDir=str(self.root / 'state'), intervalSeconds=1, deadlineSeconds=10)
        self.live = {}
        for t in [self.cfg['coordinator'], *self.cfg['workers']]:
            self.live[t['pane']] = {'agent': t['agent'], 'agent_session': t['session'],
                                   'foreground_cwd': t['cwds'][0], 'agent_status': 'idle'}
        for i, w in enumerate(self.cfg['workers']):
            p = self.root / f'report-{i}.md'
            p.write_text('FINAL REPORT\nMarker: REPORT_COMPLETE\n')
            w['completion'].update(path=str(p), notBefore=0)

    def execute(self, live=None, fail=False):
        with patch.object(watch, 'agents', return_value=live or self.live), patch.object(watch.time, 'sleep'), patch.object(watch, 'cli', side_effect=subprocess.TimeoutExpired('herdr', 30) if fail else None, return_value='accepted') as cli:
            result = watch.run(self.cfg)
        return result, cli

    def test_validate(self):
        p = self.root / 'config.json'
        p.write_text(json.dumps(self.cfg))
        self.assertEqual(watch.load(p)['mode'], 'all')
        self.cfg['workers'][0]['pane'] = self.cfg['coordinator']['pane']
        p.write_text(json.dumps(self.cfg))
        with self.assertRaises(ValueError): watch.load(p)

    def test_mixed_agents_tabs(self):
        result = watch.assess(self.cfg, self.live, set())
        self.assertTrue(all(r['eligible'] for r in result['workers']))

    def test_replaced_session(self):
        self.live[self.cfg['workers'][0]['pane']]['agent_session'] = {'kind': 'id', 'value': 'replacement'}
        self.assertEqual(watch.assess(self.cfg, self.live, set())['state'], 'identity-mismatch')

    def test_wrong_cwd_or_agent(self):
        t = self.cfg['workers'][0]
        self.live[t['pane']]['foreground_cwd'] = '/wrong'
        self.assertFalse(watch.identity(t, self.live))
        self.live[t['pane']]['foreground_cwd'] = t['cwds'][1]
        self.assertTrue(watch.identity(t, self.live))
        self.live[t['pane']]['agent'] = 'not-claude'
        self.assertFalse(watch.identity(t, self.live))

    def test_stale_missing_marker(self):
        w = self.cfg['workers'][0]
        w['completion']['notBefore'] = 10**12
        self.assertFalse(watch.evidence(w, set()))
        w['completion']['notBefore'] = 0
        Path(w['completion']['path']).write_text('still working')
        self.assertFalse(watch.evidence(w, set()))

    def test_status_requires_observed_working(self):
        w = self.cfg['workers'][0]
        w['completion'] = {'kind': 'status-after-working'}
        self.assertFalse(watch.evidence(w, set()))
        seen = set()
        self.live[w['pane']]['agent_status'] = 'working'
        watch.assess(self.cfg, self.live, seen)
        self.assertTrue(watch.evidence(w, seen))

    def test_blocked_does_not_send(self):
        self.live[self.cfg['workers'][0]['pane']]['agent_status'] = 'blocked'
        result, cli = self.execute()
        self.assertEqual(result, 2)
        cli.assert_not_called()

    def test_all_sends_once_and_receipt_prevents_replay(self):
        result, cli = self.execute()
        self.assertEqual(result, 0)
        cli.assert_called_once_with('agent', 'prompt', self.cfg['coordinator']['pane'], self.cfg['wakeMessage'])
        self.assertTrue((self.root / 'state/wake-attempt.json').exists())
        with self.assertRaises(SystemExit): self.execute()

    def test_any_leaves_other_worker_active(self):
        self.cfg['mode'] = 'any'
        self.live[self.cfg['workers'][1]['pane']]['agent_status'] = 'working'
        result, cli = self.execute()
        self.assertEqual(result, 0)
        receipt = json.loads((self.root / 'state/wake-attempt.json').read_text())
        self.assertEqual(receipt['qualifiedPanes'], [self.cfg['workers'][0]['pane']])
        self.assertEqual(cli.call_count, 1)

    def test_uncertain_send_no_retry(self):
        result, cli = self.execute(fail=True)
        self.assertEqual(result, 3)
        self.assertEqual(cli.call_count, 1)
        self.assertEqual(json.loads((self.root / 'state/status.json').read_text())['state'], 'wake-uncertain-no-retry')

    def test_coordinator_busy_expires_without_send(self):
        self.live[self.cfg['coordinator']['pane']]['agent_status'] = 'working'
        with patch.object(watch.time, 'monotonic', side_effect=[0, 1, 2, 20]):
            result, cli = self.execute()
        self.assertEqual(result, 4)
        cli.assert_not_called()

    def test_final_revalidation_blocks_replaced_coordinator(self):
        changed = copy.deepcopy(self.live)
        changed[self.cfg['coordinator']['pane']]['agent_session']['value'] = 'replacement'
        with patch.object(watch, 'agents', side_effect=[self.live, self.live, changed]), patch.object(watch.time, 'sleep'), patch.object(watch, 'cli') as cli:
            self.assertEqual(watch.run(self.cfg), 2)
        cli.assert_not_called()


if __name__ == '__main__':
    unittest.main()
