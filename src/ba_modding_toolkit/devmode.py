"""Environment hooks for isolated development runs, inert unless their variables are set.

A development run (tests, a dev server, a build run for testing) can keep the tool away from the user's own data
directory, cache and game install: it names a data folder and game folders of its own. A user's run sets none of
these variables and behaves as before.

- ``BAMT_DATA_DIR``: the data directory (``config.toml``, ``webui.json``, ``library/``, ``output/``, ``Addons/``)
  instead of the checkout or the app's folder, and the disk cache ``<BAMT_DATA_DIR>/cache``. Read once, when
  ``utils`` fixes ``EXE_DIR`` on import, so it must be set before ``ba_modding_toolkit`` is imported.
- ``BAMT_GAME_DIRS_GLOBAL``, ``BAMT_GAME_DIRS_JAPAN``: the game folders of a region (``os.pathsep``-separated, may be
  empty). ``game_paths.find_game_dirs`` returns these and searches nothing, which covers the settings' defaults, the
  CLI's default game folder and both GUIs' detect buttons. Read when used.
"""

from __future__ import annotations

import os
from pathlib import Path

DATA_DIR = "BAMT_DATA_DIR"
GAME_DIRS = {"global": "BAMT_GAME_DIRS_GLOBAL", "japan": "BAMT_GAME_DIRS_JAPAN"}


def data_dir() -> Path | None:
    """The data directory ``BAMT_DATA_DIR`` names (absolute), or None when it is not set."""
    value = os.environ.get(DATA_DIR, "").strip()
    return Path(value).expanduser().resolve() if value else None


def game_dirs(region: str) -> list[Path] | None:
    """The game folders ``BAMT_GAME_DIRS_<REGION>`` names, in order (empty when it is set to nothing), or None when it
    is not set and the game is searched for as usual."""
    value = os.environ.get(GAME_DIRS[region])
    return None if value is None else _path_list(value)


def _path_list(value: str) -> list[Path]:
    return [Path(part.strip()).expanduser() for part in value.split(os.pathsep) if part.strip()]
