"""Tests for the update check and the update scripts (no network)."""

import hashlib
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import updater, utils
from ba_modding_toolkit.errors import ServiceError


def test_semver_precedence():
    order = ["0.1.0-alpha", "0.1.0-alpha.1", "0.1.0-alpha.beta", "0.1.0-beta", "0.1.0-beta.2", "0.1.0-beta.11",
             "0.1.0-rc.1", "0.1.0", "0.1.1", "0.2.0", "1.0.0"]
    keys = [updater.parse_version(v) for v in order]
    assert keys == sorted(keys)
    assert updater.parse_version("v0.1.0") == updater.parse_version("0.1.0")
    assert updater.parse_version("alpha-0.1.0") is None


def release(tag, *names, draft=False, prerelease=True):
    return {"tag_name": tag, "draft": draft, "prerelease": prerelease, "html_url": f"https://github.com/{updater.REPO}/releases/tag/{tag}",
            "assets": [{"name": n, "browser_download_url": f"https://example.invalid/{n}", "size": 10} for n in names]}


def test_latest_picks_the_newest_newer_release():
    mac = "-macos-arm64.dmg"
    releases = [
        release("0.1.0-alpha", f"BAMPT-0.1.0-alpha{mac}", f"BAMPT-0.1.0-alpha{mac}.md5"),
        release("0.1.1-alpha", f"BAMPT-0.1.1-alpha{mac}", f"BAMPT-0.1.1-alpha{mac}.md5"),
        release("0.2.0-alpha", f"BAMPT-0.2.0-alpha{mac}", draft=True),
    ]
    info = updater.latest(releases, "0.1.0-alpha", mac)
    assert info.version == "0.1.1-alpha"
    assert info.asset.name.endswith(mac) and info.checksum.name == info.asset.name + ".md5"
    assert updater.latest(releases, "0.1.1-alpha", mac) is None
    # a development run counts as its base version
    assert updater.latest(releases, "0.1.1-alpha-dev", mac) is None


def test_pick_assets_skips_the_cli_build():
    win = "-windows-x64.exe"
    assets = release("0.1.0", f"BAMPT-cli-0.1.0{win}", f"BAMPT-0.1.0{win}", f"BAMPT-0.1.0{win}.md5")["assets"]
    build, checksum = updater.pick_assets(assets, win, "0.1.0")
    assert build.name == f"BAMPT-0.1.0{win}" and checksum.name == build.name + ".md5"
    assert updater.pick_assets(assets, None, "0.1.0") == (None, None)


def test_parse_md5():
    h = "d41d8cd98f00b204e9800998ecf8427e"
    assert updater.parse_md5(f"{h}  app.dmg\n", "app.dmg") == h
    assert updater.parse_md5(f"{h.upper()} *app.dmg", "app.dmg") == h
    assert updater.parse_md5(h, "app.dmg") == h
    assert updater.parse_md5(f"{h}  other.dmg", "app.dmg") is None


def test_download_checks_the_md5(tmp_path, monkeypatch):
    payload = b"new build"
    good = hashlib.md5(payload).hexdigest()

    class Response:
        def __init__(self, data):
            self.data, self.headers = data, {"Content-Length": str(len(data))}
        def read(self, n=-1):
            data, self.data = self.data, b""
            return data
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False

    info = updater.UpdateInfo("0.1.1", "0.1.0", "", updater.Asset("app.dmg", "https://x/app.dmg", len(payload)),
                              updater.Asset("app.dmg.md5", "https://x/app.dmg.md5", 40))
    monkeypatch.setattr(updater.urllib.request, "urlopen", lambda req, timeout=0: Response(payload))
    monkeypatch.setattr(updater, "_get", lambda url, timeout: f"{good}  app.dmg".encode())
    seen = []
    path, expected_md5 = updater.download(info, tmp_path, lambda c, t, n: seen.append((c, t)))
    assert expected_md5 == good
    assert path.read_bytes() == payload and seen[-1] == (len(payload), len(payload))
    monkeypatch.setattr(updater, "_get", lambda url, timeout: b"0" * 32 + b"  app.dmg")
    with pytest.raises(ServiceError) as e:
        updater.download(info, tmp_path / "again")
    assert e.value.code == "update_checksum_mismatch"
    assert not list((tmp_path / "again").iterdir())


def test_scripts_wait_replace_and_restart():
    mac = updater.macos_script(Path("/tmp/u/new app.dmg"), Path("/Applications/Tool.app"), 42)
    assert "kill -0 42" in mac and "'/tmp/u/new app.dmg'" in mac and "open /Applications/Tool.app" in mac
    win = updater.windows_script([42, 7])
    assert 'PID eq 42' in win and 'PID eq 7' in win and "goto move" in win
    assert 'move /Y "%BAMT_UPDATE_NEW_EXE%" "%BAMT_UPDATE_EXE%"' in win
    assert 'start "" "%BAMT_UPDATE_EXE%"' in win
    assert "setlocal DisableDelayedExpansion" in win
    win.encode("ascii")


def test_install_refuses_development_runs(tmp_path):
    with pytest.raises(ServiceError) as e:
        updater.install(tmp_path / "x.dmg", "0" * 32)
    assert e.value.code == "update_unsupported"


@pytest.mark.parametrize("tag", ["0.1.0", "0.1.0-alpha.2", "v0.1.0"])
@pytest.mark.parametrize("suffix", ["-macos-arm64.dmg", "-windows-x64.exe"])
def test_latest_assets_match_the_release_version(tag: str, suffix: str) -> None:
    version = tag.removeprefix("v")
    stale = [f"BAMPT-{v}{suffix}" for v in ("0.1.0-alpha", "0.1.0-alpha.1", "0.0.9", "0.2.0")]
    expected = f"BAMPT-{version}{suffix}"
    info = updater.latest([release(tag, *stale, expected, expected + ".md5")], "0.0.1", suffix)
    assert info.asset.name == expected
    assert info.checksum.name == expected + ".md5"
    info = updater.latest([release(tag, *stale)], "0.0.1", suffix)
    assert info.asset is None and info.checksum is None and not info.installable


@pytest.mark.parametrize("build, expected", [("win-amd64", "-windows-x64.exe"), ("win-arm64", None), ("win32", None)])
def test_windows_suffix_uses_the_running_build_on_arm_hosts(
    monkeypatch: pytest.MonkeyPatch, build: str, expected: str | None,
) -> None:
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(updater.platform, "machine", lambda: "ARM64")
    monkeypatch.setattr(updater.sysconfig, "get_platform", lambda: build)
    assert updater.platform_suffix() == expected


@pytest.mark.parametrize("system", ["darwin", "win32"])
@pytest.mark.parametrize("denied", ["target", "parent", None])
def test_install_target_requires_writable_target_and_parent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, system: str, denied: str | None,
) -> None:
    if system == "darwin":
        target = tmp_path / "Tool.app"
        executable = target / "Contents" / "MacOS" / "Tool"
    else:
        executable = target = tmp_path / "Tool.exe"
    executable.parent.mkdir(parents=True, exist_ok=True)
    executable.touch()
    monkeypatch.setattr(sys, "platform", system)
    monkeypatch.setattr(sys, "executable", str(executable))
    monkeypatch.setattr(sys, "argv", [str(executable)])
    blocked = target if denied == "target" else target.parent if denied == "parent" else None
    monkeypatch.setattr(updater.os, "access", lambda path, mode: path != blocked)
    monkeypatch.setattr(updater, "is_compiled", lambda: True)
    assert updater.install_target() == (target if denied is None else None)
    suffix = "-macos-arm64.dmg" if system == "darwin" else "-windows-x64.exe"
    name = f"BAMPT-0.1.1{suffix}"
    info = updater.latest([release("0.1.1", name, name + ".md5")], "0.1.0", suffix)
    assert info.installable == (denied is None)


@pytest.mark.parametrize("executable", [
    "/Volumes/Tool/Tool.app/Contents/MacOS/Tool",
    "/private/var/folders/test/AppTranslocation/random/d/Tool.app/Contents/MacOS/Tool",
])
def test_install_target_rejects_mounted_or_translocated_apps(
    monkeypatch: pytest.MonkeyPatch, executable: str,
) -> None:
    monkeypatch.setattr(sys, "platform", "darwin")
    monkeypatch.setattr(sys, "executable", executable)
    monkeypatch.setattr(updater.os, "access", lambda *args: True)
    assert updater.install_target() is None


def test_install_target_probes_directory_permissions_even_when_os_access_succeeds(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    exe = tmp_path / "Tool.exe"
    exe.touch()
    monkeypatch.setattr(sys, "platform", "win32")
    monkeypatch.setattr(sys, "argv", [str(exe)])
    monkeypatch.setattr(updater.os, "access", lambda *args: True)

    def deny_write(**kwargs) -> None:
        raise PermissionError("directory ACL denies writing")

    monkeypatch.setattr(updater.tempfile, "TemporaryFile", deny_write)
    assert updater.install_target() is None


@pytest.mark.parametrize("system", ["darwin", "win32"])
@pytest.mark.parametrize("change", ["tampered", "missing", "invalid_digest"])
def test_install_rejects_changed_or_unverified_downloads_before_spawning(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, system: str, change: str,
) -> None:
    downloaded = tmp_path / "new build"
    downloaded.write_bytes(b"verified build")
    expected = updater.md5_of(downloaded)
    if change == "tampered":
        downloaded.write_bytes(b"different build with the same file name")
    elif change == "missing":
        downloaded.unlink()
    else:
        expected = "not a checksum"
    monkeypatch.setattr(sys, "platform", system)
    monkeypatch.setattr(updater, "is_compiled", lambda: True)
    monkeypatch.setattr(updater, "install_target", lambda: tmp_path / "Tool")
    monkeypatch.setattr(updater.tempfile, "mkstemp", lambda **kw: pytest.fail("must not create a swap helper"))
    monkeypatch.setattr(updater.subprocess, "Popen", lambda *a, **kw: pytest.fail("must not start a swap helper"))
    with pytest.raises(ServiceError) as exc:
        updater.install(downloaded, expected)
    assert exc.value.code == ("update_download_failed" if change == "missing" else "update_checksum_mismatch")


@pytest.mark.parametrize("system", ["darwin", "win32"])
def test_install_handoff_preserves_paths_and_hides_windows_console(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, system: str,
) -> None:
    folder = tmp_path / "Möds 100% %PATH% !keep!"
    folder.mkdir()
    downloaded = folder / "new build.exe"
    downloaded.write_bytes(b"verified build")
    target = folder / "Tool.exe"
    monkeypatch.setattr(sys, "platform", system)
    monkeypatch.setattr(updater, "is_compiled", lambda: True)
    monkeypatch.setattr(updater, "install_target", lambda: target)
    monkeypatch.setattr(updater.os, "getpid", lambda: 42)
    monkeypatch.setenv("NUITKA_ONEFILE_PARENT", "7")
    make_temp = updater.tempfile.mkstemp
    monkeypatch.setattr(updater.tempfile, "mkstemp", lambda **kw: make_temp(dir=folder, **kw))
    calls = []
    monkeypatch.setattr(updater.subprocess, "Popen", lambda *a, **kw: calls.append((a, kw)))
    updater.install(downloaded, updater.md5_of(downloaded).upper())
    args, kwargs = calls[0]
    if system == "darwin":
        assert args[0][0] == "/bin/sh" and kwargs["start_new_session"]
        script = Path(args[0][1]).read_text(encoding="utf-8")
        assert str(downloaded) in script and str(target) in script
    else:
        assert args[0].endswith('/d /v:off /s /c ""%BAMT_UPDATE_SCRIPT%""')
        assert kwargs["creationflags"] == 0x08000200
        assert not kwargs["creationflags"] & 0x00000008  # DETACHED_PROCESS cancels CREATE_NO_WINDOW
        assert kwargs["close_fds"]
        env = kwargs["env"]
        assert env["BAMT_UPDATE_NEW_EXE"] == str(downloaded.resolve())
        assert env["BAMT_UPDATE_EXE"] == str(target)
        script = Path(env["BAMT_UPDATE_SCRIPT"]).read_text(encoding="ascii")
        assert "PID eq 42" in script and "PID eq 7" in script
        assert str(folder) not in script


@pytest.mark.skipif(sys.platform != "win32", reason="requires the native Windows command interpreter")
def test_windows_helper_moves_with_literal_unicode_and_percent_paths(tmp_path: Path) -> None:
    folder = tmp_path / "Möds 100% %PATH% !keep!"
    folder.mkdir()
    new = folder / "new.exe"
    target = folder / "installed.exe"
    # A system executable can run from the temporary directory without Python's adjacent DLLs.
    shutil.copyfile(Path(os.environ["SystemRoot"]) / "System32" / "where.exe", new)
    expected = updater.md5_of(new)
    target.write_text("old build", encoding="ascii")
    script = folder / "update.cmd"
    script.write_text(updater.windows_script([]), encoding="ascii")
    env = dict(os.environ, BAMT_UPDATE_SCRIPT=str(script), BAMT_UPDATE_NEW_EXE=str(new),
               BAMT_UPDATE_EXE=str(target))
    command = f'"{env.get("COMSPEC", "cmd.exe")}" /d /v:off /s /c ""%BAMT_UPDATE_SCRIPT%""'
    subprocess.run(command, env=env, creationflags=0x08000200, check=True, timeout=10)
    assert updater.md5_of(target) == expected
    assert not new.exists() and not script.exists()


@pytest.mark.parametrize("macos", [False, True])
def test_compiled_addons_are_copied_once_and_existing_maps_are_preserved(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, macos: bool,
) -> None:
    portable = tmp_path / "portable"
    extracted = tmp_path / "extracted"
    portable.mkdir()
    bundled = extracted / "Addons"
    bundled.mkdir(parents=True)
    csv = "BA-Characters-Internal-ID.csv"
    license_name = "BA-Characters-Internal-ID-LICENSE.txt"
    (bundled / csv).write_text("bundled map")
    (bundled / license_name).write_text("CC BY-SA 4.0")
    monkeypatch.setattr(utils, "__compiled__", SimpleNamespace(containing_dir=str(portable), macos_bundle_mode=macos),
                        raising=False)
    monkeypatch.setattr(utils, "__file__", str(extracted / "ba_modding_toolkit" / "utils.py"))
    monkeypatch.setattr(sys, "executable", str(extracted / "Tool" if macos else portable / "Tool.exe"))
    monkeypatch.setattr(Path, "home", lambda: tmp_path)
    expected_dir = tmp_path / "Library" / "Application Support" / "BA-Modding-Toolkit" if macos else portable
    assert utils._get_exe_dir() == expected_dir
    assert (expected_dir / "Addons" / csv).read_text() == "bundled map"
    assert (expected_dir / "Addons" / license_name).read_text() == "CC BY-SA 4.0"
    (expected_dir / "Addons" / csv).write_text("user map")
    assert utils._get_exe_dir() == expected_dir
    assert (expected_dir / "Addons" / csv).read_text() == "user map"


def test_compiled_build_without_addons_still_returns_portable_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(utils, "__compiled__", SimpleNamespace(containing_dir=str(tmp_path)), raising=False)
    monkeypatch.setattr(utils, "__file__", str(tmp_path / "extracted" / "ba_modding_toolkit" / "utils.py"))
    assert utils._get_exe_dir() == tmp_path
    assert not (tmp_path / "Addons").exists()


def test_bundled_addons_do_not_prevent_launch_from_an_unwritable_install(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    bundled = tmp_path / "extracted" / "Addons"
    bundled.mkdir(parents=True)
    monkeypatch.setattr(utils, "__compiled__", SimpleNamespace(containing_dir=str(tmp_path)), raising=False)
    monkeypatch.setattr(utils, "__file__", str(tmp_path / "extracted" / "ba_modding_toolkit" / "utils.py"))

    def deny_copy(*args) -> None:
        raise PermissionError("install directory is read-only")

    monkeypatch.setattr(utils.shutil, "copytree", deny_copy)
    assert utils._get_exe_dir() == tmp_path


@pytest.fixture
def release_workspace(tmp_path: Path) -> tuple[Path, dict[str, str]]:
    """A local Git repo with stubs that record every publish command without accessing the network."""
    if os.name == "nt":
        pytest.skip("release.sh fixtures require a POSIX shell and executable scripts")
    repo = tmp_path / "release"
    scripts = repo / "scripts"
    scripts.mkdir(parents=True)
    shutil.copyfile(Path(__file__).resolve().parents[1] / "scripts" / "release.sh", scripts / "release.sh")
    (repo / "pyproject.toml").write_text('[project]\nversion = "0.1.0"\n')
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    env.update(GIT_CONFIG_NOSYSTEM="1", GIT_CONFIG_GLOBAL=os.devnull, GIT_AUTHOR_NAME="Release test",
               GIT_AUTHOR_EMAIL="test@example.invalid", GIT_COMMITTER_NAME="Release test",
               GIT_COMMITTER_EMAIL="test@example.invalid")
    git = shutil.which("git")
    assert git is not None
    for args in (["init", "-q"], ["add", "."], ["-c", "commit.gpgsign=false", "commit", "-qm", "fixture"]):
        subprocess.run([git, *args], cwd=repo, env=env, check=True, capture_output=True)
    stubs = tmp_path / "bin"
    stubs.mkdir()
    (stubs / "python3").symlink_to(sys.executable)
    env.update(BAMT_REAL_GIT=git, BAMT_RELEASE_LOG=str(tmp_path / "publish.jsonl"), BAMT_RELEASE_EXISTS="0")
    git_stub = stubs / "git"
    git_stub.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
if sys.argv[1] != "push":
    os.execv(os.environ["BAMT_REAL_GIT"], [os.environ["BAMT_REAL_GIT"], *sys.argv[1:]])
with open(os.environ["BAMT_RELEASE_LOG"], "a") as log:
    log.write(json.dumps(["git", *sys.argv[1:]]) + "\\n")
''')
    gh_stub = stubs / "gh"
    gh_stub.write_text(f'#!{sys.executable}\n' + '''import json, os, sys
with open(os.environ["BAMT_RELEASE_LOG"], "a") as log:
    log.write(json.dumps(["gh", *sys.argv[1:]]) + "\\n")
if sys.argv[1:3] == ["release", "view"]:
    sys.exit(0 if os.environ["BAMT_RELEASE_EXISTS"] == "1" else 1)
''')
    git_stub.chmod(0o755)
    gh_stub.chmod(0o755)
    env["PATH"] = str(stubs) + os.pathsep + env["PATH"]
    return repo, env


def run_release(repo: Path, env: dict[str, str], *names: str) -> subprocess.CompletedProcess:
    """Run the real release script against local fixture builds."""
    for name in names:
        (repo / name).write_bytes(b"fixture build")
    return subprocess.run(["bash", "scripts/release.sh", *names], cwd=repo, env=env, capture_output=True,
                          text=True, timeout=15)


@pytest.mark.parametrize("name", [
    "Blue-Archive-Modding-and-Patching-Tool-0.1.0-alpha-macos-arm64.dmg",
    "Blue-Archive-Modding-and-Patching-Tool-0.1.0.1-macos-arm64.dmg",
    "Blue-Archive-Modding-and-Patching-Tool-0.1.1-windows-x64.exe",
    "Blue-Archive-Modding-and-Patching-Tool-0.1.0-windows-arm64.exe",
])
def test_release_rejects_wrong_version_and_unsupported_builds(release_workspace, name: str) -> None:
    repo, env = release_workspace
    result = run_release(repo, env, name)
    assert result.returncode != 0 and "is not a 0.1.0 build" in result.stderr
    assert not Path(env["BAMT_RELEASE_LOG"]).exists()


@pytest.mark.parametrize("suffix", ["macos-arm64.dmg", "macos-x86_64.dmg", "windows-x64.exe", "cli"])
def test_release_creates_exact_version_tag_and_checksum(release_workspace, suffix: str) -> None:
    repo, env = release_workspace
    name = ("Blue-Archive-Modding-and-Patching-Tool-cli-0.1.0-windows-x64.exe" if suffix == "cli" else
            f"Blue-Archive-Modding-and-Patching-Tool-0.1.0-{suffix}")
    result = run_release(repo, env, name)
    assert result.returncode == 0, result.stderr
    assert (repo / (name + ".md5")).read_text() == f"{hashlib.md5(b'fixture build').hexdigest()}  {name}\n"
    head = subprocess.check_output([env["BAMT_REAL_GIT"], "rev-parse", "HEAD"], cwd=repo, env=env)
    tagged = subprocess.check_output([env["BAMT_REAL_GIT"], "rev-list", "-n1", "refs/tags/0.1.0"], cwd=repo, env=env)
    assert head == tagged
    commands = [json.loads(line) for line in Path(env["BAMT_RELEASE_LOG"]).read_text().splitlines()]
    assert commands[0] == ["git", "push", "origin", "refs/tags/0.1.0"]
    assert commands[-1] == ["gh", "release", "create", "0.1.0", "--verify-tag", "--title", "0.1.0", "--notes", "",
                            name, name + ".md5"]


@pytest.mark.parametrize("annotated", [False, True])
@pytest.mark.parametrize("stale", [False, True])
def test_release_reuses_only_tags_at_head_and_uploads_existing_releases(release_workspace, annotated: bool, stale: bool) -> None:
    repo, env = release_workspace
    tag_args = ["tag", "-a", "0.1.0", "-m", "release"] if annotated else ["tag", "0.1.0"]
    subprocess.run([env["BAMT_REAL_GIT"], *tag_args], cwd=repo, env=env, check=True, capture_output=True)
    if stale:
        subprocess.run([env["BAMT_REAL_GIT"], "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "fix"],
                       cwd=repo, env=env, check=True, capture_output=True)
    env["BAMT_RELEASE_EXISTS"] = "1"
    name = "Blue-Archive-Modding-and-Patching-Tool-0.1.0-windows-x64.exe"
    result = run_release(repo, env, name)
    if stale:
        assert result.returncode != 0 and "tag 0.1.0 does not point at HEAD" in result.stderr
        assert not Path(env["BAMT_RELEASE_LOG"]).exists()
    else:
        assert result.returncode == 0, result.stderr
        commands = [json.loads(line) for line in Path(env["BAMT_RELEASE_LOG"]).read_text().splitlines()]
        assert commands[-1] == ["gh", "release", "upload", "0.1.0", "--clobber", name, name + ".md5"]


@pytest.mark.parametrize("build_version, accepted", [("0.1.0-alpha", True), ("0.1.0-alpha.1", False), ("0.1.0", False)])
def test_release_requires_exact_prerelease_version(release_workspace, build_version: str, accepted: bool) -> None:
    repo, env = release_workspace
    (repo / "pyproject.toml").write_text('[project]\nversion = "0.1.0-alpha"\n')
    for args in (["add", "pyproject.toml"], ["-c", "commit.gpgsign=false", "commit", "-qm", "prerelease"]):
        subprocess.run([env["BAMT_REAL_GIT"], *args], cwd=repo, env=env, check=True, capture_output=True)
    name = f"Blue-Archive-Modding-and-Patching-Tool-{build_version}-macos-arm64.dmg"
    result = run_release(repo, env, name)
    if accepted:
        assert result.returncode == 0, result.stderr
        commands = [json.loads(line) for line in Path(env["BAMT_RELEASE_LOG"]).read_text().splitlines()]
        assert commands[-1][3] == "0.1.0-alpha" and "--prerelease" in commands[-1]
    else:
        assert result.returncode != 0 and "is not a 0.1.0-alpha build" in result.stderr
        assert not Path(env["BAMT_RELEASE_LOG"]).exists()
