"""Server-Sent Events: services publish events, every open page receives them on /api/events."""

from __future__ import annotations

import json
import logging
import queue
import threading
from typing import Any, Callable, Iterator

HEARTBEAT_SECONDS = 15.0

logger = logging.getLogger(__name__)


class EventBus:
    """Fan-out of events to subscribers; each subscriber has its own bounded queue. Observers on the Python side (the
    tray) are called in ``publish`` itself and are not counted as listeners."""

    def __init__(self, max_queue: int = 2000):
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue] = []
        self._observers: list[Callable[[str, Any], Any]] = []
        self._max_queue = max_queue
        self._closed = threading.Event()

    def observe(self, fn: Callable[[str, Any], Any]) -> Callable[[], None]:
        """Call ``fn(event, data)`` on the publishing thread for every event; it must return at once (hand any real
        work to another thread). Returns the function that stops it."""
        with self._lock:
            self._observers.append(fn)

        def stop() -> None:
            with self._lock:
                if fn in self._observers:
                    self._observers.remove(fn)

        return stop

    def publish(self, event: str, data: Any = None) -> None:
        message = (event, data if data is not None else {})
        with self._lock:
            subscribers = list(self._subscribers)
            observers = list(self._observers)
        for fn in observers:
            try:
                fn(*message)
            except Exception:
                logger.exception("event observer failed on %s", event)
        for q in subscribers:
            try:
                q.put_nowait(message)
            except queue.Full:
                # a stalled page drops old events rather than blocking the services
                try:
                    q.get_nowait()
                    q.put_nowait(message)
                except (queue.Empty, queue.Full):
                    pass

    def subscribe(self) -> queue.Queue:
        q: queue.Queue = queue.Queue(self._max_queue)
        with self._lock:
            self._subscribers.append(q)
        return q

    def listeners(self) -> int:
        """How many pages are connected to /api/events."""
        with self._lock:
            return len(self._subscribers)

    def unsubscribe(self, q: queue.Queue) -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def close(self) -> None:
        self._closed.set()
        self.publish("server.closing")

    def stream(self, heartbeat: float = HEARTBEAT_SECONDS) -> Iterator[bytes]:
        """An SSE byte stream for one client; ends when the bus closes."""
        q = self.subscribe()
        try:
            yield b"retry: 1000\n\n"
            while not self._closed.is_set():
                try:
                    event, data = q.get(timeout=heartbeat)
                except queue.Empty:
                    yield b": keep-alive\n\n"
                    continue
                payload = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
                yield f"event: {event}\ndata: {payload}\n\n".encode("utf-8")
                if event == "server.closing":
                    return
        finally:
            self.unsubscribe(q)
