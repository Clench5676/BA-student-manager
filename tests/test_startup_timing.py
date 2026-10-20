"""Phase timers remain useful with concurrent asset requests and failed work."""

from concurrent.futures import ThreadPoolExecutor

import pytest

from ba_modding_toolkit.webui.timing import Timings


def test_failed_work_is_timed_and_snapshots_are_detached(monkeypatch):
    ticks = iter([10, 10.25])
    monkeypatch.setattr("ba_modding_toolkit.webui.timing.time.perf_counter", lambda: next(ticks))
    timings = Timings()
    with pytest.raises(ValueError), timings.measure("ui.atlases"):
        raise ValueError("unreadable fixture")
    snapshot = timings.snapshot()
    assert snapshot == {"ui.atlases": {"count": 1, "seconds": .25}}
    snapshot["ui.atlases"]["count"] = 99
    assert timings.snapshot()["ui.atlases"]["count"] == 1


def test_concurrent_asset_timings_accumulate():
    timings = Timings()
    with ThreadPoolExecutor(max_workers=4) as workers:
        list(workers.map(lambda _: timings.record("ui.layouts", .125), range(100)))
    assert timings.snapshot() == {"ui.layouts": {"count": 100, "seconds": 12.5}}
