"""Session timings without paths, also available in the session log."""

from __future__ import annotations

import logging
import threading
import time
from contextlib import contextmanager

logger = logging.getLogger(__name__)


class Timings:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._values: dict[str, dict[str, float | int]] = {}

    @contextmanager
    def measure(self, phase: str):
        started = time.perf_counter()
        try:
            yield
        finally:
            self.record(phase, time.perf_counter() - started)

    def record(self, phase: str, seconds: float) -> None:
        with self._lock:
            value = self._values.setdefault(phase, {"count": 0, "seconds": 0.0})
            value["count"] += 1
            value["seconds"] += seconds
        logger.info("Timing %s: %.3f s", phase, seconds)

    def snapshot(self) -> dict:
        with self._lock:
            return {key: dict(value) for key, value in self._values.items()}
