"""Opt-in switching benchmark over temporary fixtures; never opens the application.

Run with PYTHONPATH=src:tests and the project's Python. --baseline loads the checked-in
library modules from HEAD in memory, without changing files in the worktree.
Header-only bundles cannot pass through UnityPy serialization, so the builder stages
real official bytes and performs real CRC correction in place of serialization.
"""

import argparse
import importlib
import json
import statistics
import subprocess
import tempfile
import time
from pathlib import Path

from pytest import MonkeyPatch

import test_library
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.utils import CRCUtils


def run_trial():
    with tempfile.TemporaryDirectory() as temporary, MonkeyPatch.context() as patch:
        patch.setattr('ba_modding_toolkit.library.identity.content_cores', lambda path: set())
        env = test_library.setup_library.__wrapped__(Path(temporary), patch, None)
        env.original.unlink()
        env.original = test_library.game_bundle(env.game_dir, payload=b'A' * (8 * 1024 * 1024))
        mod, = env.library.add([test_library.make_mod(env.original, env.tmp / 'input', b'B' * (8 * 1024 * 1024))])
        library = env.library
        totals, counts = {}, {}

        def measured(name, fn):
            def call(*args, **kwargs):
                start = time.perf_counter()
                try:
                    return fn(*args, **kwargs)
                finally:
                    totals[name] = totals.get(name, 0) + time.perf_counter() - start
                    counts[name] = counts.get(name, 0) + 1
            return call

        def build(record, targets, work, log, progress, pin):
            staged = library._stage_official(targets, work / 'targets', pin)
            data = library._paths(record)[0].read_bytes()
            staged[targets[0]].write_bytes(CRCUtils.apply_crc_fix(data, int(parse_filename(targets[0].name).crc)))
            return staged

        patch.setattr(library, '_install_direct', measured('build_crc', build))
        patch.setattr(library._hashes, 'get', measured('fingerprints', library._hashes.get))
        module = importlib.import_module('ba_modding_toolkit.library.service')
        patch.setattr(module, 'atomic_copy', measured('copy', module.atomic_copy))
        for name in ('_commit', '_stage_official', '_prune_quietly', '_official_for'):
            patch.setattr(library, name, measured(name, getattr(library, name)))

        def operation(fn):
            totals.clear()
            counts.clear()
            start = time.perf_counter()
            fn()
            return {'total': (time.perf_counter() - start) * 1000,
                    **{name: value * 1000 for name, value in totals.items()},
                    'build_calls': counts.get('build_crc', 0)}

        result = {}
        result['cold_apply'] = operation(lambda: library.apply('test', f'mod:{mod.id}'))
        result['unchanged_apply'] = operation(lambda: library.apply('test', f'mod:{mod.id}'))
        result['restore'] = operation(lambda: library.restore('test'))
        result['unchanged_restore'] = operation(lambda: library.restore('test'))
        result['reapply_after_restore'] = operation(lambda: library.apply('test', f'mod:{mod.id}'))
        for i in range(1200):
            test_library.game_bundle(env.game_dir, f'entry{i}_spr')
        library._scan_allowed = lambda: True
        library.scan()
        result['full_scan'] = operation(lambda: library.scan())
        if 'cores' in __import__('inspect').signature(library.scan).parameters:
            result['changed_core_scan'] = operation(lambda: library.scan(cores={'test_spr'}))
        return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', action='store_true')
    parser.add_argument('--trials', type=int, default=5)
    args = parser.parse_args()
    if args.baseline:
        for suffix in ('storage', 'service'):
            module = importlib.import_module(f'ba_modding_toolkit.library.{suffix}')
            path = f'src/ba_modding_toolkit/library/{suffix}.py'
            source = subprocess.run(['git', 'show', f'HEAD:{path}'], check=True, capture_output=True, text=True).stdout
            exec(compile(source, f'<baseline {path}>', 'exec'), vars(module))
        test_library.ModLibrary = importlib.import_module('ba_modding_toolkit.library.service').ModLibrary
    trials = [run_trial() for _ in range(args.trials)]
    median = {name: {phase: round(statistics.median(trial[name].get(phase, 0) for trial in trials), 3)
                     for phase in sorted({p for trial in trials for p in trial[name]})}
              for name in trials[0]}
    print(json.dumps({'mode': 'HEAD' if args.baseline else 'worktree', 'trials': args.trials,
                      'median_ms': median}, indent=2))


if __name__ == '__main__':
    main()
