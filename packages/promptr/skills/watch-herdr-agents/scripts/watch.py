#!/usr/bin/env python3
"""Observe pinned Herdr agents; issue at most one Coordinator wake (POSIX)."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import subprocess
import sys
import time


def load(path):
    cfg = json.loads(Path(path).read_text())
    if cfg.get('version') != 1 or cfg.get('mode', 'all') not in ('all', 'any'):
        raise ValueError('Expected version 1 and mode all/any')
    workers = cfg.get('workers', [])
    if not isinstance(workers, list) or not 1 <= len(workers) <= 32:
        raise ValueError('Expected 1–32 workers')
    panes = set()
    for target in [cfg['coordinator'], *workers]:
        for field in ('pane', 'agent'):
            if not isinstance(target.get(field), str) or not target[field]:
                raise ValueError('Missing target ' + field)
        session = target.get('session', {})
        if session.get('kind') not in ('id', 'path') or not session.get('value'):
            raise ValueError('Pin exact session kind/value')
        cwds = target.get('cwds')
        if not isinstance(cwds, list) or not cwds or not all(isinstance(c, str) and Path(c).is_absolute() for c in cwds):
            raise ValueError('Pin absolute allowed foreground cwds')
        if target['pane'] in panes:
            raise ValueError('Duplicate pane or Coordinator also a worker')
        panes.add(target['pane'])
    for worker in workers:
        completion = worker.get('completion', {})
        kind = completion.get('kind', 'report')
        if kind == 'report':
            if not Path(completion.get('path', '')).is_absolute():
                raise ValueError('Report path must be absolute')
            if not isinstance(completion.get('notBefore'), (int, float)):
                raise ValueError('Report notBefore Unix timestamp is required')
            markers = completion.get('markers')
            if not isinstance(markers, list) or not markers or not all(isinstance(m, str) and m for m in markers):
                raise ValueError('Report markers must be non-empty strings')
        elif kind != 'status-after-working':
            raise ValueError('Unsupported completion kind')
    for key, default, low, high in [('intervalSeconds', 15, 1, 300), ('deadlineSeconds', 7200, 1, 86400), ('stablePolls', 2, 2, 20)]:
        value = cfg.setdefault(key, default)
        if type(value) is not int or not low <= value <= high:
            raise ValueError('Invalid ' + key)
    if not Path(cfg.get('stateDir', '')).is_absolute():
        raise ValueError('stateDir must be absolute')
    message = cfg.get('wakeMessage')
    if not isinstance(message, str) or not message.strip() or len(message) > 8000:
        raise ValueError('Expected trusted wakeMessage, 1–8000 characters')
    return cfg


def cli(*args):
    return subprocess.run(['herdr', *args], capture_output=True, text=True, timeout=30, check=True).stdout


def agents():
    return {a['pane_id']: a for a in json.loads(cli('agent', 'list'))['result']['agents']}


def identity(target, live):
    a = live.get(target['pane'], {})
    session = a.get('agent_session', {})
    return (a.get('agent') == target['agent']
            and session.get('kind') == target['session']['kind']
            and session.get('value') == target['session']['value']
            and a.get('foreground_cwd') in target['cwds'])


def evidence(worker, seen_working):
    completion = worker.get('completion', {})
    if completion.get('kind') == 'status-after-working':
        return worker['pane'] in seen_working
    path = Path(completion['path'])
    try:
        with path.open('rb') as f:
            stat = os.fstat(f.fileno())
            if stat.st_mtime < completion['notBefore'] or stat.st_size > 1024 * 1024:
                return False
            text = f.read(1024 * 1024 + 1).decode('utf-8')
        return all(marker in text for marker in completion['markers'])
    except (OSError, UnicodeError):
        return False


def assess(cfg, live, seen_working):
    for target in [cfg['coordinator'], *cfg['workers']]:
        if not identity(target, live):
            return {'state': 'identity-mismatch', 'pane': target['pane']}
    rows = []
    for worker in cfg['workers']:
        status = live[worker['pane']].get('agent_status', 'unknown')
        if status == 'working':
            seen_working.add(worker['pane'])
        rows.append({'pane': worker['pane'], 'status': status,
                     'eligible': status in ('idle', 'done') and evidence(worker, seen_working)})
    blocked = [r['pane'] for r in rows if r['status'] == 'blocked']
    if blocked:
        return {'state': 'blocked', 'panes': blocked, 'workers': rows}
    return {'state': 'monitoring', 'workers': rows}


def save(root, name, value):
    value = dict(value, at=time.time())
    temp = root / (name + '.tmp')
    temp.write_text(json.dumps(value, indent=2) + '\n')
    temp.replace(root / name)


def run(cfg):
    root = Path(cfg['stateDir'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (root / 'watcher.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise SystemExit('Watcher already active in this stateDir')
        if (root / 'wake-attempt.json').exists():
            raise SystemExit('Wake already attempted; inspect receipt, never auto-replay')
        seen, counts = set(), {w['pane']: 0 for w in cfg['workers']}
        start = time.monotonic()
        while time.monotonic() - start < cfg['deadlineSeconds']:
            try:
                live = agents()
                result = assess(cfg, live, seen)
                save(root, 'status.json', result)
                if result['state'] != 'monitoring':
                    return 2
                for row in result['workers']:
                    counts[row['pane']] = counts[row['pane']] + 1 if row['eligible'] else 0
                ready = [p for p, n in counts.items() if n >= cfg['stablePolls']]
                qualified = len(ready) == len(counts) if cfg.get('mode', 'all') == 'all' else bool(ready)
                if qualified and live[cfg['coordinator']['pane']].get('agent_status') in ('idle', 'done'):
                    # Refresh immediately before submission; Herdr has no atomic identity+prompt operation.
                    fresh = agents()
                    check = assess(cfg, fresh, seen)
                    eligible = {r['pane'] for r in check.get('workers', []) if r['eligible']}
                    if check['state'] != 'monitoring':
                        save(root, 'status.json', check)
                        return 2
                    if not set(ready).issubset(eligible) or fresh[cfg['coordinator']['pane']].get('agent_status') not in ('idle', 'done'):
                        time.sleep(cfg['intervalSeconds'])
                        continue
                    attempt = {'coordinator': cfg['coordinator'], 'qualifiedPanes': ready,
                               'mode': cfg.get('mode', 'all'), 'message': cfg['wakeMessage'], 'at': time.time()}
                    with (root / 'wake-attempt.json').open('x') as f:
                        json.dump(attempt, f, indent=2)
                        f.flush()
                        os.fsync(f.fileno())
                    try:
                        response = cli('agent', 'prompt', cfg['coordinator']['pane'], cfg['wakeMessage'])
                        save(root, 'status.json', {'state': 'wake-submitted', 'qualifiedPanes': ready, 'response': response[-2000:]})
                        return 0
                    except (OSError, subprocess.SubprocessError) as error:
                        save(root, 'status.json', {'state': 'wake-uncertain-no-retry', 'error': type(error).__name__})
                        return 3
            except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
                counts = {p: 0 for p in counts}
                save(root, 'status.json', {'state': 'monitoring-error', 'error': type(error).__name__})
            time.sleep(cfg['intervalSeconds'])
        save(root, 'status.json', {'state': 'expired'})
        return 4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['check', 'run', 'start'])
    parser.add_argument('config')
    args = parser.parse_args()
    cfg = load(args.config)
    if args.action == 'check':
        print(json.dumps(assess(cfg, agents(), set()), indent=2))
        return
    if args.action == 'run':
        raise SystemExit(run(cfg))
    root = Path(cfg['stateDir'])
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    # Snapshot configuration before detaching: subsequent config edits cannot change ownership.
    with (root / 'launch.lock').open('w') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        if (root / 'launch.json').exists() or (root / 'wake-attempt.json').exists():
            raise SystemExit('State directory already launched; inspect it before any new watcher')
        frozen = root / 'config.json'
        frozen.write_text(json.dumps(cfg, indent=2) + '\n')
        with (root / 'watcher.log').open('a') as log:
            child = subprocess.Popen([sys.executable, str(Path(__file__).resolve()), 'run', str(frozen)],
                                     stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
        receipt = {'pid': child.pid, 'stateDir': str(root), 'config': str(frozen)}
        save(root, 'launch.json', receipt)
        print(json.dumps(receipt, indent=2))


if __name__ == '__main__':
    main()
