"""The event bus's observers on the Python side."""

from ba_modding_toolkit.webui.events import EventBus


def test_the_event_bus_observer_is_called_and_can_stop():
    bus = EventBus()
    seen = []

    def broken(event, data):
        raise RuntimeError("observer bug")

    bus.observe(broken)  # a failing observer never stops the others or the pages
    stop = bus.observe(lambda event, data: seen.append((event, data)))
    q = bus.subscribe()
    bus.publish("mods.state", {"enabled": True})
    assert seen == [("mods.state", {"enabled": True})]
    assert q.get_nowait() == ("mods.state", {"enabled": True})
    assert bus.listeners() == 1
    stop()
    bus.publish("mods.state", {})
    assert len(seen) == 1
