"""Entry point of the app: the web UI, or the classic Tk GUI with ``--classic``, ``--tab <name>`` or ``--settings``."""

from __future__ import annotations

import sys


def main(argv: list[str] | None = None) -> None:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--classic" in args or "--tab" in args or "--settings" in args:
        from .gui.main import main as classic

        classic([a for a in args if a != "--classic"])
    else:
        from .webui.main import main as web

        web(args)


if __name__ == "__main__":
    main()
