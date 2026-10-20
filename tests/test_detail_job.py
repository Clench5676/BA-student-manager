"""The detail screen's mod-backed render and failed asset loaders on a stand-in DOM."""

import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is not installed")
def test_detail_job_in_node():
    path = Path(__file__).parent / "js" / "detail_job.test.mjs"
    result = subprocess.run([shutil.which("node"), "--test", str(path)], capture_output=True, text=True, timeout=120)
    assert result.returncode == 0, result.stdout + result.stderr
