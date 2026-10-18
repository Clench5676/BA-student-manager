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
from .events import EventBus

logger = logging.getLogger(__name__)

LOG_FLUSH_SECONDS = 0.1
PROGRESS_SECONDS = 0.1


@dataclass
class Job:
    id: str
    kind: str
    params: dict[str, Any]
    fn: Callable[..., Any]
    state: str = "queued"  # queued, running, done, failed
    result: Any = None
    error: dict[str, Any] | None = None
    log: list[str] = field(default_factory=list)

    def to_json(self) -> dict[str, Any]:
        return {"id": self.id, "kind": self.kind, "state": self.state, "result": self.result, "error": self.error}


class JobRunner:
    """A single worker thread: UnityPy and the game folder are never touched by two jobs at once."""

    def __init__(self, events: EventBus, keep: int = 50):
        self._events = events
        self._queue: queue.Queue[Job | None] = queue.Queue()
        self._jobs: dict[str, Job] = {}
        self._order: list[str] = []
        self._keep = keep
        self._ids = itertools.count(1)
        self._lock = threading.Lock()
        self._thread = threading.Thread(target=self._run, name="bamt-jobs", daemon=True)
        self._thread.start()

    def submit(self, kind: str, fn: Callable[..., Any], **params: Any) -> str:
        """Queue ``fn(log=..., progress=..., **params)``; returns the job id."""
        job = Job(id=f"j{next(self._ids)}", kind=kind, params=params, fn=fn)
        with self._lock:
            self._jobs[job.id] = job
            self._order.append(job.id)
            while len(self._order) > self._keep:
                self._jobs.pop(self._order.pop(0), None)
        self._queue.put(job)
        return job.id

    def get(self, job_id: str) -> Job:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise ServiceError("job_not_found", id=job_id)
        return job

    def busy(self) -> bool:
        with self._lock:
            return any(j.state in ("queued", "running") for j in self._jobs.values())

    def shutdown(self, wait: float | None = None) -> None:
        """Stop after the queued jobs; with ``wait``, block up to that many seconds for them (a job writing into the
        game folder must not be cut off by the app exiting)."""
        self._queue.put(None)
        if wait is not None and self._thread.is_alive():
            self._thread.join(wait)

    def _run(self) -> None:
        while True:
            job = self._queue.get()
            if job is None:
                return
            self._execute(job)

    def _execute(self, job: Job) -> None:
        events = self._events
        pending: list[str] = []
        last_flush = [time.monotonic()]
        last_progress = [0.0]

        def flush() -> None:
            if pending:
                events.publish("job.log", {"id": job.id, "lines": list(pending)})
                pending.clear()
            last_flush[0] = time.monotonic()

        def log(line: str) -> None:
            text = str(line)
            job.log.append(text)
            pending.append(text)
            if time.monotonic() - last_flush[0] >= LOG_FLUSH_SECONDS:
                flush()

        def progress(current: int, total: int, label: str = "") -> None:
            now = time.monotonic()
            if current < total and now - last_progress[0] < PROGRESS_SECONDS:
                return
            last_progress[0] = now
            events.publish("job.progress", {"id": job.id, "current": current, "total": total, "label": label})

        job.state = "running"
        events.publish("job.started", {"id": job.id, "kind": job.kind})
        try:
            result = job.fn(log=log, progress=progress, **job.params)
            job.result = result.to_json() if hasattr(result, "to_json") else result
            job.state = "done"
            flush()
            events.publish("job.done", {"id": job.id, "kind": job.kind, "result": job.result})
        except ServiceError as e:
            job.error = e.to_json()
            job.state = "failed"
            flush()
            events.publish("job.failed", {"id": job.id, "kind": job.kind, **job.error})
        except Exception as e:  # report and keep the worker alive
            logger.exception("job %s (%s) failed", job.id, job.kind)
            job.error = {"code": "internal", "params": {"error": f"{type(e).__name__}: {e}"}}
            job.log.append(traceback.format_exc())
            job.state = "failed"
            flush()
            events.publish("job.failed", {"id": job.id, "kind": job.kind, **job.error})
