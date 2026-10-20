"""Manual Windows release checks and packaging, without builds or network access."""

import hashlib
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_release_tag", ROOT / "scripts" / "check_release_tag.py")
release_tag = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_tag)
PWSH = shutil.which("pwsh")


@pytest.fixture
def release_run(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "0.1.0-beta.1"\n')
    output = tmp_path / "github-output"
    output.write_text("previous=value\n")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.delenv("RELEASE_TAG", raising=False)
    return output


def mock_git(monkeypatch, tag, *, missing=False, commit="abc123"):
    def run(args, **kwargs):
        if args == ["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}"]:
            return subprocess.CompletedProcess(args, 1 if missing else 0, stdout=commit + "\n")
        assert args == ["git", "rev-parse", "HEAD"]
        return subprocess.CompletedProcess(args, 0, stdout="abc123\n")

    monkeypatch.setattr(release_tag.subprocess, "run", run)


@pytest.mark.parametrize("tag", [None, "", "0.2.0-beta.2"])
def test_release_tag_defaults_to_raw_project_version(release_run, monkeypatch, tag):
    if tag is not None:
        monkeypatch.setenv("RELEASE_TAG", tag)
    expected = tag or "0.1.0-beta.1"
    mock_git(monkeypatch, expected)
    release_tag.main()
    assert release_run.read_text() == f"previous=value\ntag={expected}\n"


@pytest.mark.parametrize("missing,commit,message", [
    (True, "abc123", "does not exist"),
    (False, "def456", "does not point at the checked-out commit"),
])
def test_release_tag_rejects_missing_or_wrong_commit(release_run, monkeypatch, missing, commit, message):
    mock_git(monkeypatch, "0.1.0-beta.1", missing=missing, commit=commit)
    with pytest.raises(SystemExit, match=message):
        release_tag.main()
    assert release_run.read_text() == "previous=value\n"


@pytest.mark.skipif(PWSH is None, reason="PowerShell is not installed")
@pytest.mark.parametrize("target,kinds", [("Gui", [""]), ("Cli", ["-cli"]), ("All", ["", "-cli"])])
def test_windows_build_packages_selected_targets(tmp_path, target, kinds):
    # Run the build and packaging section with a compiler stub, bypassing dependency setup and downloads.
    script = (ROOT / "scripts" / "build_windows.ps1").read_text()
    build = script[script.index('$Name = "Blue-Archive-Modding-and-Patching-Tool"'):]
    harness = r'''
$ErrorActionPreference = "Stop"
$Root = (Get-Location).Path
$Build = Join-Path $Root "build"
$Dist = Join-Path $Root "dist"
New-Item -ItemType Directory -Path $Build, $Dist, "src" | Out-Null
$Target = $env:TEST_BUILD_TARGET
$Version = "0.1.0-beta.1"
$FileVersion = "0.1.0.0"
$Addons = $ArchspecCpu = $Build
$HadVersionFile = $false
$VersionFile = Join-Path $Root "src/_version.py"
function Build-Python {
    $Output = $args | Where-Object { $_ -like "--output-filename=*" }
    $FileName = $Output.Substring("--output-filename=".Length)
    [IO.File]::WriteAllText((Join-Path $Build $FileName), "built $FileName")
    $global:LASTEXITCODE = 0
}
$Py = "Build-Python"
'''
    result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", harness + build],
                            cwd=tmp_path, env={**os.environ, "TEST_BUILD_TARGET": target},
                            capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    names = [f"Blue-Archive-Modding-and-Patching-Tool{kind}-0.1.0-beta.1-windows-x64.exe" for kind in kinds]
    assert sorted(p.name for p in (tmp_path / "dist").iterdir()) == sorted(
        name + suffix for name in names for suffix in ("", ".md5"))
    for name in names:
        asset = tmp_path / "dist" / name
        expected = hashlib.md5(asset.read_bytes()).hexdigest()
        assert asset.with_suffix(".exe.md5").read_bytes() == f"{expected}  {name}\n".encode()
