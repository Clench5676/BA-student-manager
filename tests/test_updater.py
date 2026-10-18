"""Tests for the update check and the update scripts (no network)."""

import hashlib
from pathlib import Path

import pytest

from ba_modding_toolkit import updater
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
    build, checksum = updater.pick_assets(assets, win)
    assert build.name == f"BAMPT-0.1.0{win}" and checksum.name == build.name + ".md5"
    assert updater.pick_assets(assets, None) == (None, None)


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
    path = updater.download(info, tmp_path, lambda c, t, n: seen.append((c, t)))
    assert path.read_bytes() == payload and seen[-1] == (len(payload), len(payload))
    monkeypatch.setattr(updater, "_get", lambda url, timeout: b"0" * 32 + b"  app.dmg")
    with pytest.raises(ServiceError) as e:
        updater.download(info, tmp_path / "again")
    assert e.value.code == "update_checksum_mismatch"
    assert not list((tmp_path / "again").iterdir())


def test_scripts_wait_replace_and_restart():
    mac = updater.macos_script(Path("/tmp/u/new app.dmg"), Path("/Applications/Tool.app"), 42)
    assert "kill -0 42" in mac and "'/tmp/u/new app.dmg'" in mac and "open /Applications/Tool.app" in mac
    win = updater.windows_script(Path(r"C:\t\new.exe"), Path(r"C:\Tools\Tool.exe"), [42, 7])
    assert 'PID eq 42' in win and 'PID eq 7' in win and "goto move" in win
    assert r'move /Y "C:\t\new.exe" "C:\Tools\Tool.exe"' in win and r'start "" "C:\Tools\Tool.exe"' in win


def test_install_refuses_development_runs(tmp_path):
    with pytest.raises(ServiceError) as e:
        updater.install(tmp_path / "x.dmg")
    assert e.value.code == "update_unsupported"
