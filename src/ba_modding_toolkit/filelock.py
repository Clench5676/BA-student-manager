"""File locks shared between processes, and a replace that waits for a moment on Windows.

Several app instances may share one data folder or one mod library: each change to a shared file is made under a lock
file the instances share (``file_lock``), and the new contents replace the file in one step (``replace``)."""

from __future__ import annotations

import contextlib
import logging
import os
import time
from collections.abc import Iterator
from pathlib import Path

logger = logging.getLogger(__name__)


@contextlib.contextmanager
def file_lock(path: Path) -> Iterator[None]:
    """An exclusive lock on a lock file, shared with the other processes using it (fcntl.flock, msvcrt.locking on
    Windows). Without a lock file (an unwritable folder) the change goes ahead unlocked; writing then fails as before."""
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        handle = open(path, "a+b")  # noqa: SIM115 - held for the lock's lifetime
    except OSError:
        logger.warning("cannot lock %s", path, exc_info=True)
        yield
        return
    with handle:
        if os.name == "nt":
            import msvcrt

            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)  # retries for 10 s, then raises
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


# Windows: a file another program has open without delete sharing (a virus scanner or the search indexer looking at
# the new file) cannot be replaced for a moment
REPLACE_TRIES, REPLACE_WAIT = (20, 0.05) if os.name == "nt" else (1, 0.0)


def replace(src: str | Path, dst: Path, tries: int = REPLACE_TRIES, wait: float = REPLACE_WAIT) -> None:
    """os.replace, tried again for a moment while another program holds the file (PermissionError)."""
    for attempt in range(1, tries + 1):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if attempt >= tries:
                raise
            time.sleep(wait)
