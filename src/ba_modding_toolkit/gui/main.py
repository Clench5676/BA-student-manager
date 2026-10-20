# gui/main.py

import argparse
import atexit
import os
import sys

from ..utils import EXE_DIR
from ..webui.classic import remove_classic_json
from .control import ControlBridge, ControlClient, take_channel
from .utils import tbDnDWindow
from .app import App

def main(argv: list[str] | None = None):
    # --tab <name> opens the classic GUI on that tab (used by the web UI's nav)
    # --control: started by the web UI, which places and raises this window over its own (webui/classic.py)
    parser = argparse.ArgumentParser(prog="bamt", add_help=False)
    parser.add_argument("--tab")
    parser.add_argument("--settings", action="store_true")
    parser.add_argument("--control", action="store_true")
    args, _ = parser.parse_known_args(sys.argv[1:] if argv is None else argv)
    # always taken out of the environment, so the classic GUI's own subprocesses never inherit them
    channel = take_channel()
    control = args.control and channel is not None

    root = tbDnDWindow(themename='cosmo')
    if control:
        # hidden until the web UI has placed it (the raise line shows it; ControlBridge shows it after 5 s anyway)
        root.attributes("-alpha", 0.0)
    app = App(root)
    tab = getattr(app.tabs, args.tab, None) if args.tab else None
    if tab is not None:
        app.show_tab(tab)
    if args.settings:
        root.after(200, app.open_settings_dialog)
    if control:
        ControlBridge(root, app, ControlClient(*channel)).start()
        # the web UI wrote classic.json at ready; an instance started later reads it while this window is open
        atexit.register(remove_classic_json, EXE_DIR, os.getpid())
    print("Blue Archive Modding and Patching Tool 已启动")

    root.mainloop()
