"""Checks made immediately before modifying game bundle files."""

from __future__ import annotations

import csv
import io
import os
import subprocess
from contextlib import ExitStack, contextmanager
from pathlib import Path
from typing import Iterator

from ..errors import ServiceError


def check_game_not_running() -> None:
    """Refuse replacement while the Blue Archive game process is running."""
    command = ["tasklist", "/FO", "CSV", "/NH"] if os.name == "nt" else ["ps", "-A", "-o", "comm="]
    try:
        result = subprocess.run(command, capture_output=True, text=True, timeout=5, check=True)
    except (OSError, subprocess.SubprocessError) as error:
        raise ServiceError("game_status_unavailable") from error
    names = [row[0] for row in csv.reader(io.StringIO(result.stdout)) if row] if os.name == "nt" else result.stdout.splitlines()
    for name in names:
        if name.strip().replace("\\", "/").rsplit("/", 1)[-1].casefold() in {
            "bluearchive", "bluearchive.exe", "blue archive", "blue archive.exe",
        }:
            raise ServiceError("game_running")


def check_resource_path(path: Path, resource_dirs: list[Path]) -> Path:
    """Resolve a game destination and reject symlinks that escape resource folders."""
    resolved = path.resolve()
    if not any(resolved.is_relative_to(directory.resolve()) for directory in resource_dirs):
        raise ServiceError("game_file_outside_resources", file=path)
    return resolved


@contextmanager
def writable_game_files(paths: list[Path], resource_dirs: list[Path]) -> Iterator[None]:
    """Preflight destinations and hold POSIX advisory locks through replacement."""
    check_game_not_running()
    with ExitStack() as stack:
        for path in sorted(set(paths)):
            check_resource_path(path, resource_dirs)
            try:
                if not path.is_file() or not path.stat().st_mode & 0o222 or not path.parent.stat().st_mode & 0o222:
                    raise PermissionError(str(path))
                if os.name == "nt":
                    # Python's Windows file handles do not share delete access;
                    # keeping our probe open would block our own atomic replace.
                    with path.open("r+b"):
                        pass
                else:
                    import fcntl

                    stream = stack.enter_context(path.open("r+b"))
                    fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise ServiceError("game_file_locked", file=path) from error
        yield
