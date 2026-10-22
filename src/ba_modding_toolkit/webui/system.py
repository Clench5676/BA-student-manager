"""Operating-system helpers without Tk: reveal a file, the classic GUI's command line."""

from __future__ import annotations

import logging
import subprocess
import sys
from pathlib import Path

from ..errors import ServiceError
from .. import devmode, updater

logger = logging.getLogger(__name__)

CREATE_NO_WINDOW = 0x08000000 if sys.platform == "win32" else 0


def _is_wsl() -> bool:
    try:
        return "microsoft" in Path("/proc/version").read_text().lower()
    except OSError:
        return False


def reveal(path: str | Path) -> None:
    """Show a file (selected) or a folder in the system file manager."""
    p = Path(path).resolve()
    if not p.exists():
        raise ServiceError("path_not_found", path=str(p))
    try:
        if sys.platform == "win32":
            # explorer parses its command line loosely: quote the whole path as one argument
            subprocess.Popen(f'explorer /select,"{p}"' if p.is_file() else f'explorer "{p}"',
                             creationflags=CREATE_NO_WINDOW)
        elif sys.platform == "darwin":
            subprocess.run(["open", "-R", str(p)] if p.is_file() else ["open", str(p)], check=True)
        elif _is_wsl():
            win = subprocess.run(["wslpath", "-w", str(p)], capture_output=True, text=True, check=True).stdout.strip()
            subprocess.Popen(["explorer.exe", f"/select,{win}"] if p.is_file() else ["explorer.exe", win])
        else:
            subprocess.run(["xdg-open", str(p.parent if p.is_file() else p)], check=True)
    except (OSError, subprocess.CalledProcessError) as e:
        raise ServiceError("reveal_failed", path=str(p), error=str(e)) from e


def program_command() -> list[str]:
    """How to start this program again: a compiled build runs its own executable (argv[0]: sys.executable names a
    "python" that does not exist inside a Nuitka app bundle, and on Windows argv[0] is the onefile launcher)."""
    if "__compiled__" in globals() or getattr(sys, "frozen", False):
        argv0 = Path(sys.argv[0])
        if argv0.is_file():
            return [str(argv0.resolve())]
        return [sys.executable]
    return [sys.executable, "-m", "ba_modding_toolkit"]


def can_restart_safe() -> bool:
    return updater.is_compiled() and not devmode.active()


def safe_restart_command() -> list[str]:
    if not can_restart_safe():
        raise ServiceError("safe_restart_unavailable")
    return program_command()


CLASSIC_TABS = ("mod_update", "batch_update", "mod_install", "crc_tool", "asset_packer", "asset_extractor",
                "adb_push", "tools")


def check_classic_tab(tab: str | None) -> None:
    """``bad_params`` unless ``tab`` is a classic tab, ``"settings"`` (the classic settings) or ``None``."""
    if tab is not None and tab not in CLASSIC_TABS and tab != "settings":
        raise ServiceError("bad_params", tab=tab)


def classic_command(tab: str | None = None, *, control: bool = False) -> list[str]:
    """The command line of the classic Tk GUI, optionally on a tab or (``"settings"``) in its settings; ``control``
    for a window the web UI places and raises over its control channel (``webui/classic.py``)."""
    check_classic_tab(tab)
    # without --classic the launcher starts the web UI again
    cmd = program_command() + ["--classic"]
    if control:
        cmd += ["--control"]
    if tab == "settings":
        cmd += ["--settings"]
    elif tab:
        cmd += ["--tab", tab]
    return cmd

