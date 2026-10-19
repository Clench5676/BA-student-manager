"""Environment hooks for isolated development runs, inert unless their variables are set.

A development run (tests, a dev server, a build run for testing) can keep the tool away from the user's own data
directory, cache and game install: it names a data folder and game folders of its own, and dev mode holds every path
the tool uses to the folders the run names. A user's run sets none of these variables and behaves as before.

- ``BAMT_DATA_DIR``: the data directory (``config.toml``, ``webui.json``, ``library/``, ``output/``, ``Addons/``)
  instead of the checkout or the app's folder, and the disk cache ``<BAMT_DATA_DIR>/cache``. Read once, when
  ``utils`` fixes ``EXE_DIR`` on import, so it must be set before ``ba_modding_toolkit`` is imported.
- ``BAMT_GAME_DIRS_GLOBAL``, ``BAMT_GAME_DIRS_JAPAN``: the game folders of a region (``os.pathsep``-separated, may be
  empty). ``game_paths.find_game_dirs`` returns these and searches nothing, which covers the settings' defaults, the
  CLI's default game folder and both GUIs' detect buttons.
- ``BAMT_DEV_ROOTS``: dev mode. The folders the tool may use: the settings file, the data directory, game folders,
  mods to import, the library, the cache and output folders must lie inside them (``check_read``). A game folder
  outside is ignored, any other path outside is refused (``ServiceError("dev_path_outside")``), and the game is never
  searched for: only ``BAMT_GAME_DIRS_*`` name it. ADB commands are refused (the user's phone) and a build never
  replaces itself with an update. Set to nothing, it allows nothing.
- ``BAMT_DEV_WRITABLE``: the folders whose files the tool may change in place in dev mode (``check_write``): a
  writable copy of a game folder, the run's data folder, pytest's basetemp, never a read-only game folder. Game files
  are written (switch, restore, mod install, CRC fix) only there or in the library's staging folders, and the check
  for a running game is skipped there. Its folders count as dev roots; set alone, it turns dev mode on too.

Lists of folders are separated by ``os.pathsep`` (``:``, ``;`` on Windows). All variables but ``BAMT_DATA_DIR`` are
read when used, so a test session may set them after importing the package. Paths are compared with links resolved
on both sides (``/var`` is ``/private/var`` on macOS), so a link cannot lead out of a root.

``HOOKS`` is the version of these hooks; ``assets/dev-hooks.json`` carries it into builds, so whoever starts a build
can tell it has them without running it.
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from .errors import ServiceError

# The version of these hooks, also in assets/dev-hooks.json (the tests check they match)
HOOKS = 1
DATA_DIR = "BAMT_DATA_DIR"
GAME_DIRS = {"global": "BAMT_GAME_DIRS_GLOBAL", "japan": "BAMT_GAME_DIRS_JAPAN"}
ROOTS = "BAMT_DEV_ROOTS"
WRITABLE = "BAMT_DEV_WRITABLE"
# The library stages a switch in temporary folders named so (library/service.py); the mod installer writes there
LIBRARY_STAGING_PREFIX = "bamt-library-"


def data_dir() -> Path | None:
    """The data directory ``BAMT_DATA_DIR`` names (absolute), or None when it is not set."""
    value = os.environ.get(DATA_DIR, "").strip()
    return Path(value).expanduser().resolve() if value else None


def game_dirs(region: str) -> list[Path] | None:
    """The game folders ``BAMT_GAME_DIRS_<REGION>`` names, in order (empty when it is set to nothing), or None when it
    is not set and the game is searched for as usual."""
    value = os.environ.get(GAME_DIRS[region])
    return None if value is None else _path_list(value)


def active() -> bool:
    """Whether dev mode is on (``BAMT_DEV_ROOTS`` or ``BAMT_DEV_WRITABLE`` is set, even to nothing)."""
    return ROOTS in os.environ or WRITABLE in os.environ


def roots() -> list[Path]:
    """The folders the tool may use in dev mode (the writable ones included), links resolved."""
    return [_real(path) for path in _path_list(os.environ.get(ROOTS, "")) + _path_list(os.environ.get(WRITABLE, ""))]


def writable_roots() -> list[Path]:
    """The folders whose files the tool may change in place in dev mode, links resolved."""
    return [_real(path) for path in _path_list(os.environ.get(WRITABLE, ""))]


def in_writable(path: str | os.PathLike[str]) -> bool:
    """Whether dev mode is on and a path lies inside ``BAMT_DEV_WRITABLE``."""
    return active() and _inside(_real(path), writable_roots())


def allows_read(path: str | os.PathLike[str]) -> bool:
    """Whether the tool may use a path: always outside dev mode, else only inside the dev roots."""
    return not active() or _inside(_real(path), roots())


def check_read(path: str | os.PathLike[str]) -> None:
    """In dev mode, refuse a path outside the dev roots: one the tool reads, or a folder it writes new files into
    (library, cache, output). Raises ``ServiceError("dev_path_outside", path=...)``."""
    if not allows_read(path):
        raise ServiceError("dev_path_outside", path=str(path))


def allows_write(path: str | os.PathLike[str]) -> bool:
    """Whether the tool may change a file in place: always outside dev mode, else only inside ``BAMT_DEV_WRITABLE``
    or one of the library's staging folders."""
    if not active():
        return True
    real = _real(path)
    return _inside(real, writable_roots()) or _in_library_staging(real)


def check_write(path: str | os.PathLike[str]) -> None:
    """In dev mode, refuse changing a file in place (a game file, a CRC fix) outside ``BAMT_DEV_WRITABLE``. Raises
    ``ServiceError("dev_path_outside", path=...)``."""
    if not allows_write(path):
        raise ServiceError("dev_path_outside", path=str(path))


def _in_library_staging(real: Path) -> bool:
    temp = _real(tempfile.gettempdir())
    parts = real.relative_to(temp).parts if real.is_relative_to(temp) else ()
    return len(parts) > 1 and parts[0].startswith(LIBRARY_STAGING_PREFIX)


def _path_list(value: str) -> list[Path]:
    return [Path(part.strip()).expanduser() for part in value.split(os.pathsep) if part.strip()]


def _real(path: str | os.PathLike[str]) -> Path:
    """The absolute path with links resolved, as far as it exists."""
    return Path(os.path.realpath(os.path.expanduser(os.fspath(path))))


def _inside(path: Path, folders: list[Path]) -> bool:
    return any(path.is_relative_to(folder) for folder in folders)
