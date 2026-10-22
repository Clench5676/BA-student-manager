"""Published stable Windows release checks and packaging without builds or network access."""

import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import textwrap

import pytest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("check_release_tag", ROOT / "scripts" / "check_release_tag.py")
release_tag = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(release_tag)
PWSH = shutil.which("pwsh")


@pytest.fixture
def release_run(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "pyproject.toml").write_text('[project]\nversion = "0.4.1"\n')
    output = tmp_path / "github-output"
    output.write_text("previous=value\n")
    monkeypatch.setenv("GITHUB_OUTPUT", str(output))
    monkeypatch.delenv("RELEASE_TAG", raising=False)
    event_path = tmp_path / "release-event.json"
    event_path.write_text(json.dumps({"action": "published", "release": {
        "tag_name": "0.4.1", "draft": False, "prerelease": False, "published_at": "2026-10-22T10:00:00Z"}}))
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event_path))
    monkeypatch.setenv("GITHUB_EVENT_NAME", "release")
    monkeypatch.setenv("GITHUB_SHA", "a" * 40)
    return output


def mock_git(monkeypatch, tag, *, missing=False, commit="a" * 40):
    def run(args, **kwargs):
        if args == ["git", "rev-parse", "--verify", "--quiet", f"refs/tags/{tag}^{{commit}}"]:
            return subprocess.CompletedProcess(args, 1 if missing else 0, stdout=commit + "\n")
        assert args == ["git", "rev-parse", "HEAD"]
        return subprocess.CompletedProcess(args, 0, stdout="a" * 40 + "\n")

    monkeypatch.setattr(release_tag.subprocess, "run", run)


def edit_event(**fields):
    path = Path(os.environ["GITHUB_EVENT_PATH"])
    event = json.loads(path.read_text())
    event["release"].update(fields)
    path.write_text(json.dumps(event))


@pytest.mark.parametrize("tag", ["0.4.1", "1.0.0", "10.20.300"])
def test_published_stable_tag_matches_project_and_event_commit(release_run, monkeypatch, tag):
    edit_event(tag_name=tag)
    Path("pyproject.toml").write_text(f'[project]\nversion = "{tag}"\n')
    monkeypatch.setenv("RELEASE_TAG", tag)
    mock_git(monkeypatch, tag)
    release_tag.main()
    assert release_run.read_text() == f"previous=value\ntag={tag}\n"


@pytest.mark.parametrize("tag", [
    "0.4.1-alpha", "0.4.1-alpha.1", "0.4.1-beta.2", "0.4.1-rc.1", "0.4.1-RC.1", "0.4.1-preview",
    "0.4.1.alpha", "0.4.1a1", "v0.4.1", "0.4.1+build", "01.4.1", "0.4", "0.4.1\ninjected=true", None, True,
])
def test_prerelease_and_noncanonical_tags_never_reach_git(release_run, monkeypatch, tag):
    edit_event(tag_name=tag)
    monkeypatch.setattr(release_tag.subprocess, "run", lambda *args, **kwargs: pytest.fail("Rejected tag reached Git"))
    with pytest.raises(SystemExit, match="Only a stable"):
        release_tag.main()
    assert release_run.read_text() == "previous=value\n"


@pytest.mark.parametrize("fields", [{"prerelease": True}, {"draft": True}, {"published_at": None},
                                    {"published_at": ""}, {"prerelease": 0}, {"draft": "false"}])
def test_non_stable_release_flags_are_rejected(release_run, monkeypatch, fields):
    edit_event(**fields)
    monkeypatch.setattr(release_tag.subprocess, "run", lambda *args, **kwargs: pytest.fail("Rejected release reached Git"))
    with pytest.raises(SystemExit, match="Draft, unpublished and prerelease"):
        release_tag.main()


@pytest.mark.parametrize("name,action", [("push", "published"), ("workflow_dispatch", "published"),
                                       ("pull_request", "published"), ("release", "created"),
                                       ("release", "edited"), ("release", "released"), ("release", "prereleased")])
def test_only_published_release_events_are_accepted(release_run, monkeypatch, name, action):
    monkeypatch.setenv("GITHUB_EVENT_NAME", name)
    event_path = Path(os.environ["GITHUB_EVENT_PATH"])
    event = json.loads(event_path.read_text())
    event["action"] = action
    event_path.write_text(json.dumps(event))
    with pytest.raises(SystemExit, match="published release event"):
        release_tag.main()


@pytest.mark.parametrize("value", ["", "0.4.2", "0.4.1\nother=tag"])
def test_requested_tag_cannot_override_release_event(release_run, monkeypatch, value):
    monkeypatch.setenv("RELEASE_TAG", value)
    with pytest.raises(SystemExit, match="differs from the published release event"):
        release_tag.main()


@pytest.mark.parametrize("version", ["0.4.2", "0.4.1-alpha.1"])
def test_project_version_must_equal_stable_release_tag(release_run, version):
    Path("pyproject.toml").write_text(f'[project]\nversion = "{version}"\n')
    with pytest.raises(SystemExit, match="Project version"):
        release_tag.main()


@pytest.mark.parametrize("missing,commit,message", [
    (True, "a" * 40, "does not exist"),
    (False, "b" * 40, "does not point at the checked-out commit"),
])
def test_release_tag_rejects_missing_or_wrong_commit(release_run, monkeypatch, missing, commit, message):
    mock_git(monkeypatch, "0.4.1", missing=missing, commit=commit)
    with pytest.raises(SystemExit, match=message):
        release_tag.main()
    assert release_run.read_text() == "previous=value\n"


@pytest.mark.parametrize("commit", ["", "abc123", "b" * 40])
def test_event_commit_cannot_change_after_publication(release_run, monkeypatch, commit):
    monkeypatch.setenv("GITHUB_SHA", commit)
    mock_git(monkeypatch, "0.4.1")
    with pytest.raises(SystemExit, match="differs from the published release event"):
        release_tag.main()


def test_only_windows_gui_release_workflow_remains():
    workflows = sorted((ROOT / ".github/workflows").glob("*.y*ml"))
    assert [path.name for path in workflows] == ["build.yml"]
    workflow = workflows[0].read_text()
    trigger = workflow[workflow.index("on:\n"):workflow.index("permissions:\n")]
    assert trigger.strip() == "on:\n  release:\n    types: [published]"
    assert "github.event.release.prerelease == false" in workflow
    assert "github.event.release.draft == false" in workflow
    assert "ref: refs/tags/${{ github.event.release.tag_name }}" in workflow
    assert workflow.index("python scripts/check_release_tag.py") < workflow.index("-Target Gui")
    assert "-Target Cli" not in workflow and "upload-artifact" not in workflow


@pytest.mark.skipif(PWSH is None, reason="PowerShell is not installed")
@pytest.mark.parametrize("failure", [None, "prerelease", "draft", "tag", "checksum"])
def test_release_upload_uses_exact_gui_pair_and_rechecks_release(tmp_path, failure):
    workflow = (ROOT / ".github/workflows/build.yml").read_text()
    upload = textwrap.dedent(workflow.split("        run: |\n", 1)[1])
    name = "Blue-Archive-Modding-and-Patching-Tool-0.4.1-windows-x64.exe"
    dist = tmp_path / "dist"
    dist.mkdir()
    executable = dist / name
    executable.write_bytes(b"GUI executable")
    digest = hashlib.md5(executable.read_bytes()).hexdigest()
    (dist / (name + ".md5")).write_text(f'{"bad" if failure == "checksum" else digest}  {name}\n')
    (dist / "unrelated-cli.exe").write_bytes(b"must not upload")
    view = {"tagName": "0.4.2" if failure == "tag" else "0.4.1", "isDraft": failure == "draft", "isPrerelease": failure == "prerelease"}
    harness = '''
function gh {
    $global:LASTEXITCODE = 0
    if ($args[1] -eq "view") { Write-Output $env:TEST_RELEASE; return }
    if ($args[1] -eq "upload") { $args | ConvertTo-Json | Set-Content -LiteralPath "uploaded.json"; return }
    throw "Unexpected GitHub command"
}
'''
    result = subprocess.run([PWSH, "-NoProfile", "-NonInteractive", "-Command", harness + upload], cwd=tmp_path,
                            env={**os.environ, "RELEASE_TAG": "0.4.1", "TEST_RELEASE": json.dumps(view)},
                            capture_output=True, text=True, timeout=30)
    if failure:
        assert result.returncode != 0
        assert not (tmp_path / "uploaded.json").exists()
    else:
        assert result.returncode == 0, result.stdout + result.stderr
        assert json.loads((tmp_path / "uploaded.json").read_text()) == [
            "release", "upload", "0.4.1", "--clobber", str(executable), str(dist / (name + ".md5"))]


@pytest.mark.skipif(PWSH is None, reason="PowerShell is not installed")
@pytest.mark.parametrize("python", [None, "3.12.10"])
def test_windows_build_python_default_and_override(tmp_path, python):
    script = (ROOT / "scripts" / "build_windows.ps1").read_text()
    harness = tmp_path / "parameters.ps1"
    harness.write_text(script[:script.index('$ErrorActionPreference')] + 'Write-Output $Python\n')
    args = [PWSH, "-NoProfile", "-NonInteractive", "-File", str(harness)]
    if python is not None:
        args += ["-Python", python]
    result = subprocess.run(args, cwd=tmp_path, capture_output=True, text=True, timeout=30)
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == (python or "3.12")


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
