"""Long operations run one at a time on a worker thread and report through events."""

from __future__ import annotations

import itertools
import logging
import queue
import threading
import time
import traceback
from dataclasses import dataclass, field
from typing import Any, Callable

from ..errors import ServiceError
from ..i18n import t
from .events import EventBus
from .rpc import to_json

logger = logging.getLogger(__name__)

LOG_FLUSH_SECONDS = 0.1
PROGRESS_SECONDS = 0.1
WRITES = ("game", "library")  # a writer job writes the game folder (and the library), or the library only


@dataclass
class Job:
    id: str
    kind: str
    params: dict[str, Any]
    fn: Callable[..., Any]
    writes: str | None = None  # "game", "library" or None (read-only)
    state: str = "queued"  # queued, running, done, failed, dropped
    result: Any = None
    error: dict[str, Any] | None = None
    log: list[str] = field(default_factory=list)
    finished: bool = False  # it ran and its end's listeners ran too
    progress: dict[str, Any] | None = None

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "state": self.state, "result": self.result, "error": self.error,
                "progress": self.progress}

    @property
    def pending(self) -> bool:
        return self.state in ("queued", "running")


class JobRunner:
    """A single worker thread: UnityPy and the game folder are never touched by two jobs at once.

    Writer jobs (``writes``: the game folder or the library) hold back the window's close button, ``app.quit``, a
    library move and the services rebuild after a game folder change; read-only jobs (an extract, a download) do not.
    """

    def __init__(self, events: EventBus, keep: int = 50):
        self._events = events
        self._queue: queue.Queue[Job | None] = queue.Queue()
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._keep = keep
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._closing = False
        self._quit_reserved = False
        self._idle = threading.Condition(self._lock)
        self._listeners: list[Callable[[Job], Any]] = []
        self._thread = threading.Thread(target=self._run, name="bamt-jobs", daemon=True)
        self._thread.start()

    def submit(self, kind: str, fn: Callable[..., Any], *, writes: str | None = None, **params: Any) -> str:
        """Queue ``fn(log=..., progress=..., **params)``; returns the job id. ``writes`` marks a writer job."""
        if writes is not None and writes not in WRITES:
            raise ValueError(f"unknown writes {writes!r}")
        job = Job(id=f"j{next(self._ids)}", kind=kind, params=params, fn=fn, writes=writes)
        with self._lock:
            if writes and self._quit_reserved:
                raise ServiceError("busy")
            self._jobs[job.id] = job
            self._order.append(job.id)
            while len(self._order) > self._keep:
                # never forget a job that is still to run: busy() and wait() count it
                drop = next((i for i, jid in enumerate(self._order) if not self._jobs[jid].pending), None)
                if drop is None:
                    break
                self._jobs.pop(self._order.pop(drop), None)
        self._queue.put(job)
        return job.id

    def listen(self, fn: Callable[[Job], Any]) -> None:
        """Call ``fn(job)`` on the worker after each job finished (its state is done or failed by then)."""
        self._listeners.append(fn)

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise ServiceError("job_not_found", id=job_id)
        return job

    def busy(self, writes: str | None = None) -> bool:
        """Whether a writer job (one writing ``writes``, when given) is queued or running."""
        with self._lock:
            return any(j.writes and (writes is None or j.writes == writes) and j.pending for j in self._jobs.values())

    def reserve_quit(self) -> None:
        """Refuse new writers atomically with checking that no writer is pending."""
        with self._lock:
            if self._quit_reserved or any(j.writes and j.pending for j in self._jobs.values()):
                raise ServiceError("busy")
            self._quit_reserved = True

    def cancel_quit(self) -> None:
        """Allow writers again after a refused update quit."""
        with self._lock:
            self._quit_reserved = False

    def active(self, *kinds: str) -> bool:
        """Whether a job of one of these kinds is queued or running."""
        with self._lock:
            return any(j.kind in kinds and j.pending for j in self._jobs.values())

    def running(self) -> Job | None:
        with self._lock:
            return next((j for j in self._jobs.values() if j.state == "running"), None)

    def wait(self, job_id: str, timeout: float | None = None) -> bool:
        """Wait until a job ran (done, failed or dropped) and the listeners heard its end; whether it did in time. An
        unknown job counts as done."""
        with self._idle:
            return self._idle.wait_for(lambda: job_id not in self._jobs or self._jobs[job_id].finished, timeout)

    def shutdown(self, wait: float | None = None) -> None:
        """Stop: queued read-only jobs are dropped, queued writer jobs still run (quitting is refused while one is
        queued, so a normal quit drops none). With ``wait``, block up to that many seconds while a writer job is
        queued or running (a job writing into the game folder must not be cut off by the app exiting); a running
        read-only job is not waited for (the worker is a daemon thread)."""
        with self._lock:
            self._closing = True
        self._queue.put(None)
        if wait is not None and self._thread.is_alive() and self.busy():
            deadline = time.monotonic() + wait
            with self._idle:
                self._idle.wait_for(lambda: not any(j.writes and j.pending for j in self._jobs.values()),
                                    max(0.0, deadline - time.monotonic()))

    def _run(self) -> None:
        while True:
            job = self._queue.get()
            if job is None:
                return
            with self._lock:
                drop = self._closing and not job.writes
                if drop:
                    job.state, job.finished = "dropped", True
                    self._idle.notify_all()
            if drop:
                logger.info("job %s (%s) dropped at shutdown", job.id, job.kind)
                continue
            try:
                self._execute(job)
                for fn in list(self._listeners):
                    try:
                        fn(job)
                    except BaseException:
                        logger.exception("job listener failed")
            finally:
                with self._idle:
                    job.finished = True
                    self._idle.notify_all()

    def _execute(self, job: Job) -> None:
        def publish(event: str, data: Any) -> None:
            try:
                self._events.publish(event, data)
            except Exception:
                logger.exception("job event %s failed", event)

        pending: list[str] = []
        last_flush = [time.monotonic()]
        last_progress = [0.0]

        def flush() -> None:
            if pending:
                publish("job.log", {"id": job.id, "lines": list(pending)})
                pending.clear()
            last_flush[0] = time.monotonic()

        def log(line: str) -> None:
            text = str(line)
            job.log.append(text)
            pending.append(text)
            if time.monotonic() - last_flush[0] >= LOG_FLUSH_SECONDS:
                flush()

        def progress(current: int | dict[str, Any], total: int | None = None, label: str = "") -> None:
            if isinstance(current, dict):
                # Batch import reports completed mods, the entry id and the active phase.
                job.progress = {"id": job.id, **current}
                publish("job.progress", job.progress)
                return
            label = label or t("webui.progress.process", name=t("webui.progress.mods"))
            job.progress = {"id": job.id, "current": current, "total": total, "label": label}
            now = time.monotonic()
            if current < total and now - last_progress[0] < PROGRESS_SECONDS:
                return
            last_progress[0] = now
            publish("job.progress", job.progress)

        job.state = "running"
        publish("job.started", {"id": job.id, "kind": job.kind})
        try:
            result = job.fn(log=log, progress=progress, **job.params)
            job.result = to_json(result)
            job.state = "done"
            flush()
            publish("job.done", {"id": job.id, "kind": job.kind, "result": job.result})
        except ServiceError as e:
            job.error = e.to_json()
            job.state = "failed"
            flush()
            publish("job.failed", {"id": job.id, "kind": job.kind, **job.error})
        except BaseException as e:  # report and keep the worker alive
            logger.exception("job %s (%s) failed", job.id, job.kind)
            job.error = {"code": "internal", "params": {"error": f"{type(e).__name__}: {e}"}}
            job.log.append(traceback.format_exc())
            job.state = "failed"
            flush()
            publish("job.failed", {"id": job.id, "kind": job.kind, **job.error})
