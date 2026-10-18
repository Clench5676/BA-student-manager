# gui/main.py

import argparse
import sys

from .utils import tbDnDWindow
from .app import App

def main(argv: list[str] | None = None):
    # --tab <name> opens the classic GUI on that tab (used by the web UI's nav)
    parser = argparse.ArgumentParser(prog="bamt", add_help=False)
    parser.add_argument("--tab")
    args, _ = parser.parse_known_args(sys.argv[1:] if argv is None else argv)

    root = tbDnDWindow(themename='cosmo')
    app = App(root)
    tab = getattr(app.tabs, args.tab, None) if args.tab else None
    if tab is not None:
        app.show_tab(tab)
    print("Blue Archive Modding and Patching Tool 已启动")

    root.mainloop()
