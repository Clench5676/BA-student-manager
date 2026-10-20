"""The job runner: writer jobs apart from read-only ones, and what shutdown waits for."""

from __future__ import annotations

import threading
import time

from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.jobs import JobRunner


def wait_for(cond, timeout=5.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if cond():
            return True
        time.sleep(0.01)
    return cond()

def test_only_writer_jobs_make_the_runner_busy():
    jobs = JobRunner(EventBus())
    gate = threading.Event()
    reading = jobs.submit("extract", lambda log, progress: gate.wait(5))
    assert wait_for(lambda: jobs.get(reading).state == "running")
    assert not jobs.busy() and jobs.active("extract")
    for kind, writes in (("library.prune", "library"), ("update", "library"), ("library.clearBuilt", "library")):
        jobs.submit(kind, lambda log, progress: None, writes=writes)
    assert jobs.busy() and jobs.busy("library") and not jobs.busy("game")
    jobs.submit("mods.toggle", lambda log, progress: None, writes="game")
    assert jobs.busy("game") and jobs.active("mods.toggle")
    gate.set()
    assert wait_for(lambda: not jobs.busy())
    jobs.shutdown()


def test_shutdown_drops_queued_read_only_jobs_and_never_joins_a_running_one():
    jobs = JobRunner(EventBus())
    gate, ran = threading.Event(), []
    running = jobs.submit("extract", lambda log, progress: gate.wait(10))
    assert wait_for(lambda: jobs.get(running).state == "running")
    queued = jobs.submit("update.download", lambda log, progress: ran.append("download"))
    start = time.monotonic()
    jobs.shutdown(wait=5)
    assert time.monotonic() - start < 1  # no writer job: nothing to wait for
    gate.set()
    assert wait_for(lambda: jobs.get(queued).state == "dropped")
    assert ran == []


def test_shutdown_waits_for_a_writer_job():
    jobs = JobRunner(EventBus())
    gate, ran = threading.Event(), []
    writer = jobs.submit("mods.toggle", lambda log, progress: gate.wait(5) and ran.append("toggle"), writes="game")
    assert wait_for(lambda: jobs.get(writer).state == "running")
    threading.Timer(0.2, gate.set).start()
    jobs.shutdown(wait=5)
    assert ran == ["toggle"] and jobs.get(writer).state == "done"


def test_a_pending_job_is_never_forgotten():
    jobs = JobRunner(EventBus(), keep=2)
    gate = threading.Event()
    first = jobs.submit("slow", lambda log, progress: gate.wait(5), writes="library")
    others = [jobs.submit("x", lambda log, progress: None) for _ in range(4)]
    assert jobs.get(first).state in ("queued", "running") and jobs.busy()
    gate.set()
    assert jobs.wait(others[-1], 5)
    jobs.shutdown()


def test_failures_in_run_result_or_listeners_always_finish_and_release_the_worker():
    from ba_modding_toolkit.errors import ServiceError

    events = EventBus()
    seen = events.subscribe()
    jobs = JobRunner(events)

    class BadResult:
        def to_json(self):
            raise ValueError("bad result")

    def crash(error):
        def run(log, progress):
            log("building")
            progress(1, 1)
            raise error
        return run

    def listener(job):
        raise RuntimeError("listener failed")

    jobs.listen(listener)
    try:
        for fn, code in ((crash(ServiceError("mod_apply_failed")), "mod_apply_failed"),
                         (crash(RuntimeError("build failed")), "internal"),
                         (crash(SystemExit("builder exited")), "internal"),
                         (lambda log, progress: BadResult(), "internal")):
            jid = jobs.submit("apply", fn, writes="game")
            assert jobs.wait(jid, 5)
            job = jobs.get(jid)
            assert job.state == "failed" and job.error["code"] == code
            assert job.finished and not jobs.busy()
        next_id = jobs.submit("restore", lambda log, progress: "restored", writes="game")
        assert jobs.wait(next_id, 5)
        assert jobs.get(next_id).result == "restored"
        messages = []
        while not seen.empty():
            messages.append(seen.get_nowait())
        assert len([d for e, d in messages if e == "job.failed"]) == 4
    finally:
        jobs.shutdown()


def test_event_delivery_failure_cannot_kill_the_job_worker():
    class BrokenEvents(EventBus):
        def publish(self, event, data=None):
            raise RuntimeError("event delivery failed")

    jobs = JobRunner(BrokenEvents())
    try:
        jid = jobs.submit("apply", lambda log, progress: log("applied"), writes="game")
        assert jobs.wait(jid, 5)
        assert jobs.get(jid).state == "done" and not jobs.busy()
        next_id = jobs.submit("restore", lambda log, progress: "ok", writes="game")
        assert jobs.wait(next_id, 5)
        assert jobs.get(next_id).result == "ok"
    finally:
        jobs.shutdown()
