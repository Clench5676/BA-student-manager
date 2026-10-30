"""Phase timers remain useful with concurrent asset requests and failed work."""

from concurrent.futures import ThreadPoolExecutor
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.webui.timing import Timings
from ba_modding_toolkit.webui.services import Services


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


@pytest.mark.parametrize('fails', [False, True])
def test_layout_route_names_the_root_in_timings_even_on_failure(caplog, fails):
    calls = []

    def layout(root, subpath):
        calls.append((root, subpath))
        if fails:
            raise ValueError('unreadable fixture')
        return {'name': root}

    host = SimpleNamespace(game=SimpleNamespace(layout=layout), timings=Timings())
    with caplog.at_level('INFO', logger='ba_modding_toolkit.webui.timing'):
        if fails:
            with pytest.raises(ValueError):
                Services._ui_asset(host, ['layout', 'UILobbyCharacterSelectPopup_Slot.json'], {'path': 'Child'})
        else:
            assert Services._ui_asset(host, ['layout', 'UILobbyCharacterSelectPopup_Slot.json'],
                                      {'path': 'Child'}).light is True
    assert calls == [('UILobbyCharacterSelectPopup_Slot', 'Child')]
    measured = host.timings.snapshot()
    assert list(measured) == ['ui.layouts.UILobbyCharacterSelectPopup_Slot']
    assert measured['ui.layouts.UILobbyCharacterSelectPopup_Slot']['count'] == 1
    assert 'Timing ui.layouts.UILobbyCharacterSelectPopup_Slot:' in caplog.text
