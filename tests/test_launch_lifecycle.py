"""Headless evidence for BL-055: a loaded handler can outlive the native event loop."""

import logging
import sys
import threading
from types import SimpleNamespace

import pytest

from ba_modding_toolkit.webui import main, native
from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.timing import Timings
from ba_modding_toolkit.webui.tray import Tray


@pytest.fixture
def desktop(monkeypatch, tmp_path):
    class Hook:
        def __init__(self):
            self.handlers = []

        def __iadd__(self, handler):
            self.handlers.append(handler)
            return self

        def fire(self, *args):
            return [handler(*args) for handler in self.handlers]

    class DOMEventHandler:
        def __init__(self, callback, prevent_default, stop_propagation, debounce=0):
            self.callback = callback
            self.options = (prevent_default, stop_propagation, debounce)

    class DOMEvent:
        def __init__(self, name):
            self.name, self.handler = name, None

        def __iadd__(self, handler):
            # Like Element.on, registration waits for evaluate_js before retaining the handler.
            evaluate(self.name)
            self.handler = handler
            return self

    state = SimpleNamespace(block=None, entered=threading.Event(), resume=threading.Event(),
                            registered=[], callbacks=[], run=lambda: None)

    def evaluate(event):
        if event == state.block:
            state.entered.set()
            if not state.resume.wait(5):
                raise TimeoutError("Fake renderer was not resumed")
        state.registered.append(event)

    hooks = SimpleNamespace(**{name: Hook() for name in (
        "before_show", "shown", "initialized", "loaded", "closing", "closed", "maximized", "minimized", "restored")})
    dom_events = SimpleNamespace(**{name: DOMEvent(name) for name in ("dragenter", "dragstart", "dragover", "drop")})
    window = SimpleNamespace(events=hooks, native=None, dom=SimpleNamespace(document=SimpleNamespace(events=dom_events)))
    state.window = window
    state.services = SimpleNamespace(data_dir=tmp_path, events=EventBus(), timings=Timings(),
                                    on_closing=lambda: state.callbacks.append("closing") or False,
                                    on_closed=lambda: state.callbacks.append("closed"))

    def commands(*args):
        def dispose():
            state.callbacks.append("commands disposed")
        return dispose

    def start(**options):
        assert hooks.initialized.fire("wkwebview") == [True]
        hooks.before_show.fire()
        hooks.shown.fire()
        return state.run()

    monkeypatch.setattr(main.sys, "platform", "darwin")
    monkeypatch.setattr(native, "install_window_commands", commands)
    monkeypatch.setattr(Tray, "supported", staticmethod(lambda: False))
    monkeypatch.setitem(sys.modules, "webview", SimpleNamespace(settings={}, create_window=lambda *a, **kw: window,
                                                                start=start))
    monkeypatch.setitem(sys.modules, "webview.dom", SimpleNamespace(DOMEventHandler=DOMEventHandler))
    return state


def run_window(desktop):
    main._run_window(desktop.services, SimpleNamespace(url="http://127.0.0.1:1/"), False)


@pytest.mark.parametrize("blocked_event", ["dragenter", "dragstart", "dragover", "drop"])
def test_loop_return_with_pending_drop_registration_reproduces_shutdown_wait(desktop, caplog, blocked_event):
    desktop.block = blocked_event
    loaded = threading.Thread(target=desktop.window.events.loaded.fire, daemon=False)
    joining, finished = threading.Event(), threading.Event()

    def shutdown():
        # CPython's wait_for_thread_shutdown joins non-daemon threads after the GUI loop is gone.
        joining.set()
        loaded.join()
        finished.set()

    finalizer = threading.Thread(target=shutdown, daemon=True)

    def leave_loop():
        loaded.start()
        assert desktop.entered.wait(3)

    desktop.run = leave_loop
    with caplog.at_level(logging.INFO):
        try:
            run_window(desktop)
            assert loaded.is_alive() and not loaded.daemon
            finalizer.start()
            assert joining.wait(3)
            assert not finished.wait(0.02)
            assert "Native lifecycle: loop returned" in caplog.text
            assert "cleanup begin shown=True loaded=True closing=False closed=False drops=running" in caplog.text
            assert f"Native drop registration: begin event={blocked_event}" in caplog.text
            assert "Native lifecycle: loaded complete" not in caplog.text
            assert "Native drop registration: complete" not in caplog.text
            assert desktop.callbacks == ["commands disposed"]
        finally:
            # Supply the missing GUI result so the deliberate non-daemon test thread cannot hold up pytest.
            desktop.resume.set()
            loaded.join(3)
            if finalizer.ident is not None:
                finalizer.join(3)
        assert not loaded.is_alive() and not finalizer.is_alive()
        assert finished.is_set()
        assert desktop.registered == ["dragenter", "dragstart", "dragover", "drop"]
        assert "Native lifecycle: loaded complete drops=complete" in caplog.text


@pytest.mark.parametrize("error_type", [RuntimeError, SystemExit])
def test_loop_exception_is_identified_and_propagated_without_logging_its_contents(desktop, caplog, error_type):
    error = error_type("private diagnostic payload")

    def fail():
        raise error

    desktop.run = fail
    with caplog.at_level(logging.INFO), pytest.raises(error_type) as caught:
        run_window(desktop)
    assert caught.value is error
    assert f"Native lifecycle: loop raised type={error_type.__name__}" in caplog.text
    assert "Native lifecycle: loop returned" not in caplog.text
    assert "cleanup begin shown=True loaded=False closing=False closed=False drops=not-started" in caplog.text
    assert "Native lifecycle: cleanup complete" in caplog.text
    assert "private diagnostic payload" not in caplog.text
    assert desktop.callbacks == ["commands disposed"]


def test_completed_load_preserves_drop_options_paths_and_close_results(desktop, caplog):
    def close():
        desktop.window.events.loaded.fire()
        assert desktop.services.close_coordinator.page_loaded is True
        assert desktop.window.events.closing.fire() == [False]
        desktop.window.events.closed.fire()

    desktop.run = close
    drops = []
    desktop.services.events.observe(lambda event, data: drops.append(data) if event == "drop" else None)
    with caplog.at_level(logging.INFO):
        run_window(desktop)
        handlers = desktop.window.dom.document.events
        for name in ("dragenter", "dragstart", "dragover", "drop"):
            assert getattr(handlers, name).handler.options == (True, True, 500 if name == "dragover" else 0)
        handlers.drop.handler.callback({"dataTransfer": {"files": [
            {"pywebviewFullPath": "/fake/private/dropped.bundle"}, {"name": "no-native-path"}]}})
    assert drops == [{"paths": ["/fake/private/dropped.bundle"]}]
    assert "/fake/private" not in caplog.text
    assert desktop.callbacks == ["closing", "closed", "commands disposed"]
    assert "Native lifecycle: closing complete allowed=False" in caplog.text
    assert "cleanup begin shown=True loaded=True closing=True closed=True drops=complete" in caplog.text


def test_run_completion_is_written_before_the_session_log_closes(monkeypatch, tmp_path):
    monkeypatch.setattr(main, "EXE_DIR", tmp_path)
    monkeypatch.setattr(main, "_serve", lambda *args: False)
    args = SimpleNamespace(safe_mode=False, token=None, serve=False)
    logger = logging.getLogger(main.__name__)
    previous = logger.level
    logger.setLevel(logging.INFO)
    try:
        assert main._run(args, SimpleNamespace()) is False
    finally:
        logger.setLevel(previous)
    assert "Application lifecycle: run finished" in (tmp_path / "webui.log").read_text(encoding="utf-8")
