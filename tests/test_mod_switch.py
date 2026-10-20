"""The Enable Mods switch (web/js/mod-switch.js: its view from mods.state, a click, the first toggle's explanation,
the help, the result, the classic modal, the start prompts) is front-end code: its tests run with Node's test runner
on a stand-in DOM, skipped where Node is not installed."""

import shutil
import subprocess
from pathlib import Path

import pytest

NODE = shutil.which("node")
TESTS = Path(__file__).parent / "js" / "mod_switch.test.mjs"


@pytest.mark.skipif(NODE is None, reason="Node.js is not installed")
def test_mod_switch_in_node():
    result = subprocess.run([NODE, "--test", str(TESTS)], capture_output=True, text=True, timeout=180)
    assert result.returncode == 0, result.stdout + result.stderr
