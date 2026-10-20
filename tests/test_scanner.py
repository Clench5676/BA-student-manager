"""The scanner thread: the consent gate, coalescing, cancelling and stale results."""

from __future__ import annotations

import threading
import time
from types import SimpleNamespace

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui.scanner import Scanner


def wait_for(cond, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return cond()


class Fake:
    def __init__(self):
        self.allowed = True
        self.busy = False
        self.calls = []  # (dismissed,) per scan
        self.done = []  # (result, served)
        self.gate = threading.Event()
        self.gate.set()
        self.results = []  # what the next scans return, else a fresh result

    def scan(self, cancel, dismissed):
        self.calls.append(dismissed)
        self.gate.wait(5)
        if self.results:
            result = self.results.pop(0)
            if isinstance(result, Exception):
                raise result
            return result
        return SimpleNamespace(stale=False, entries=[], counts={}, n=len(self.calls))

    def scanner(self):
        return Scanner(self.scan, allowed=lambda: self.allowed, writer_busy=lambda: self.busy,
                       on_done=lambda result, served: self.done.append((result, served)))


def test_no_scan_without_the_consent():
    fake = Fake()
    fake.allowed = False
    scanner = fake.scanner()
    assert scanner.request() is None
    time.sleep(0.05)
    assert fake.calls == []
    scanner.stop()


def test_requests_while_a_scan_runs_are_served_by_one_more_scan():
    fake = Fake()
    fake.gate.clear()
    scanner = fake.scanner()
    first = scanner.request()
    assert wait_for(lambda: scanner.running)
    later = [scanner.request(), scanner.request(dismissed=True), scanner.request()]
    fake.gate.set()
    assert scanner.wait_idle(5)
    assert fake.calls == [False, True]  # the three later requests coalesce, and the widest one wins
    assert [served for _, served in fake.done] == [first, later[-1]]
    scanner.stop()


def test_a_cancelled_scan_is_dropped_and_the_next_request_runs():
    fake = Fake()
    fake.gate.clear()
    scanner = fake.scanner()
    scanner.request()
    assert wait_for(lambda: scanner.running)
    scanner.cancel()
    scanner.request()
    fake.gate.set()
    assert scanner.wait_idle(5)
    assert [result is None for result, _ in fake.done] == [True, False]
    scanner.stop()


def test_a_stale_scan_runs_again_once_unless_a_writer_job_runs():
    fake = Fake()
    fresh = SimpleNamespace(stale=False, entries=[], counts={})
    fake.results = [SimpleNamespace(stale=True), fresh]
    scanner = fake.scanner()
    scanner.request()
    assert scanner.wait_idle(5)
    assert len(fake.calls) == 2 and fake.done[-1][0] is fresh
    # while a writer job runs the stale result is dropped: the scan after that job replaces it
    fake.busy = True
    fake.results = [SimpleNamespace(stale=True)]
    scanner.request()
    assert scanner.wait_idle(5)
    assert len(fake.calls) == 3 and fake.done[-1][0] is None
    scanner.stop()


def test_a_failed_scan_reports_nothing_and_the_thread_goes_on():
    fake = Fake()
    fake.results = [ServiceError("scan_off"), RuntimeError("boom")]
    scanner = fake.scanner()
    scanner.request()
    assert scanner.wait_idle(5)
    scanner.request()
    assert scanner.wait_idle(5)
    scanner.request()
    assert scanner.wait_idle(5)
    assert [result is None for result, _ in fake.done] == [True, True, False]
    scanner.stop()


def test_withdrawn_consent_drops_what_was_requested():
    fake = Fake()
    fake.gate.clear()
    scanner = fake.scanner()
    scanner.request()
    assert wait_for(lambda: scanner.running)
    scanner.request()
    fake.allowed = False
    scanner.clear()
    fake.gate.set()
    assert scanner.wait_idle(5)
    assert len(fake.calls) == 1 and fake.done[0][0] is None
    scanner.stop()
