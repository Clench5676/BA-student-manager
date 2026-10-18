"""Serialized, read-only access to Unity bundles."""

from __future__ import annotations

import logging
import threading
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

from UnityPy.environment import Environment
from UnityPy.files import ObjectReader

from ..bundle import Bundle
from ..errors import ServiceError

logger = logging.getLogger(__name__)
_guard = threading.Lock()
_locks: dict[Path, threading.RLock] = {}


@contextmanager
def open_bundle(path: Path) -> Iterator[Environment]:
    """Hold the process-wide path lock throughout loading and object reads."""
    path = path.resolve()
    with _guard:
        lock = _locks.setdefault(path, threading.RLock())
    with lock:
        bundle = Bundle.load(path, log=logger.debug)
        if bundle is None:
            raise ServiceError("asset_load_failed", path=str(path))
        yield bundle.env


def reference(obj: ObjectReader, pointer: dict) -> tuple[str, int]:
    """Resolve a typetree pointer to its CAB name and path ID."""
    fid = pointer.get("m_FileID", 0)
    cab = obj.assets_file.name if fid == 0 else obj.assets_file.externals[fid - 1].path.replace("\\", "/").rsplit("/", 1)[-1]
    return cab, pointer.get("m_PathID", 0)


def ref_key(cab: str, pid: int) -> str:
    """Encode a CAB/path-ID pair as a JSON object key."""
    return f"{cab.lower()}:{pid}"


def object_record(path: Path, obj: ObjectReader, name: str) -> dict:
    """Build a JSON-ready object locator without retaining a Unity environment."""
    # Resource-version caches are reusable if the user moves the install.
    return {"bundle": path.name, "cab": obj.assets_file.name, "pid": obj.path_id, "name": name}


def find_object(env: Environment, record: dict) -> ObjectReader:
    """Find an object in a loaded bundle without confusing IDs across CABs."""
    return next(o for o in env.objects if o.path_id == record["pid"] and o.assets_file.name == record["cab"])
