"""The checks before a game file is written: game processes, Steam busy, destinations."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path
from types import SimpleNamespace

import pytest

from ba_modding_toolkit import game_paths
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import safety

WINE_LINE = r"C:\Program Files (x86)\Steam\steamapps\common\BlueArchive\BlueArchive.exe"
NATIVE_COMM = "/Applications/Blue Archive.app/Contents/MacOS/Blue Archive"
OWN_COMM = "/Applications/Blue Archive Modding and Patching Tool.app/Contents/MacOS/Blue-Archive-Modding-and-Patching-Tool"


@pytest.fixture(autouse=True)
def outside_dev_mode(monkeypatch):
    """The checks as a user's run makes them: dev mode skips the game and Steam checks for its writable folders."""
    for name in ("BAMT_DEV_ROOTS", "BAMT_DEV_WRITABLE"):
        monkeypatch.delenv(name, raising=False)


def expect_error(code, action):
    with pytest.raises(ServiceError) as caught:
        action()
    assert caught.value.code == code


def fake_ps(monkeypatch, comm: str = "", args: str = ""):
    """Answer the two ps calls with fixed lines; returns the commands run."""
    calls = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        assert command[:4] == ["ps", "-A", "-ww", "-o"]
        return SimpleNamespace(stdout=comm if command[4] == "pid=,comm=" else args)

    monkeypatch.setattr(safety, "_WINDOWS", False)
    monkeypatch.setattr(safety.subprocess, "run", run)
    return calls


# --- process matching ---

@pytest.mark.parametrize("name", [
    "BlueArchive.exe", "bluearchive.exe", "Blue Archive.exe", r"C:\Games\BlueArchive\BlueArchive.exe",
    "BlueArchive", NATIVE_COMM, "/home/user/.wine/drive_c/BlueArchive/BlueArchive.exe",
])
def test_game_names(name):
    assert safety.is_game_name(name)


@pytest.mark.parametrize("name", [
    "BlueArchiveTool.exe", "MyBlueArchive.exe", "BlueArchive.exe.bak", "Blue-Archive-Modding-and-Patching-Tool",
    "Blue-Archive-Modding-and-Patching-Tool-0.1.0-alpha.4-windows-x64.exe", OWN_COMM, "steam.exe", "",
])
def test_names_that_are_not_the_game(name):
    assert not safety.is_game_name(name)


@pytest.mark.parametrize("line", [
    WINE_LINE,
    WINE_LINE + " -popupwindow",
    f'"{WINE_LINE}" -screen-fullscreen 0',
    r"/Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64-preloader " + WINE_LINE,
    r"Z:\Users\me\Games\Blue Archive\Blue Archive.exe",
    "wine bluearchive.exe",
])
def test_wine_command_lines(line):
    assert safety.is_game_command(line)


@pytest.mark.parametrize("line", [
    r"C:\Program Files (x86)\Steam\steamapps\common\BlueArchive\BlueArchiveTool.exe",
    r"C:\Games\MyBlueArchive.exe",
    r"C:\Games\BlueArchive.exe.bak",
    r"C:\Program Files (x86)\Steam\steam.exe -silent",
    OWN_COMM + " --classic --tab update",
    "/usr/bin/python3 -m ba_modding_toolkit.webui --serve --port 8790",
    "Blue-Archive-Modding-and-Patching-Tool-0.1.0-alpha.4-windows-x64.exe --classic",
])
def test_command_lines_that_are_not_the_game(line):
    assert not safety.is_game_command(line)


def test_a_native_build_is_found_by_its_executable_path(monkeypatch):
    calls = fake_ps(monkeypatch, comm=f"    1 /sbin/launchd\n  812 {NATIVE_COMM}\n 4242 {OWN_COMM}\n")
    assert safety.game_processes() == [NATIVE_COMM]
    assert len(calls) == 1  # no command line read once the executable matched
    expect_error("game_running", safety.check_game_not_running)


def test_wine_is_found_by_its_command_line(monkeypatch):
    calls = fake_ps(monkeypatch, comm="  900 /Applications/CrossOver.app/Contents/SharedSupport/CrossOver/bin/wine64-preloader\n",
                    args=f"  900 {WINE_LINE}\n  901 C:\\windows\\system32\\services.exe\n")
    assert safety.game_processes() == [WINE_LINE]
    assert [command[4] for command, _ in calls] == ["pid=,comm=", "pid=,args="]
    assert all(kwargs["timeout"] and kwargs["check"] for _, kwargs in calls)


def test_this_programs_own_command_line_is_never_the_game(monkeypatch):
    fake_ps(monkeypatch, comm=f"{os.getpid()} /usr/bin/python3\n{os.getppid()} /bin/zsh\n",
            args=f"{os.getpid()} /usr/bin/python3 -m pytest -k {WINE_LINE}\n"
                 f"{os.getppid()} /bin/zsh -c 'run {WINE_LINE}'\n")
    assert safety.game_processes() == []
    safety.check_game_not_running()


def test_no_game_process(monkeypatch):
    fake_ps(monkeypatch, comm="    1 /sbin/launchd\n", args="    1 /sbin/launchd\n")
    assert safety.game_processes() == []
    safety.check_game_not_running()


@pytest.mark.parametrize("error", [OSError("ps blocked"), subprocess.TimeoutExpired("ps", 5),
                                   subprocess.CalledProcessError(1, "ps")])
def test_an_unreadable_process_list_is_reported(monkeypatch, error):
    def run(*args, **kwargs):
        raise error
    monkeypatch.setattr(safety, "_WINDOWS", False)
    monkeypatch.setattr(safety.subprocess, "run", run)
    expect_error("game_status_unavailable", safety.check_game_not_running)


def test_windows_matches_exe_names_and_skips_its_own_pid(monkeypatch):
    monkeypatch.setattr(safety, "_WINDOWS", True)
    monkeypatch.setattr(safety, "_toolhelp_processes", lambda: [
        (4, "System"), (300, "BlueArchiveTool.exe"), (301, "BlueArchive.exe"), (os.getpid(), "BlueArchive.exe"),
    ])
    assert safety.game_processes() == ["BlueArchive.exe"]
    expect_error("game_running", safety.check_game_not_running)


def test_windows_falls_back_to_tasklist_without_a_console_window(monkeypatch):
    calls = []

    def no_snapshot():
        raise OSError("snapshot refused")

    def run(command, **kwargs):
        calls.append((command, kwargs))
        return SimpleNamespace(stdout='"System","4","Services","0","152 K"\n'
                                      '"BlueArchive.exe","5120","Console","1","1,024,000 K"\n')

    monkeypatch.setattr(safety, "_WINDOWS", True)
    monkeypatch.setattr(safety, "_toolhelp_processes", no_snapshot)
    monkeypatch.setattr(safety.subprocess, "run", run)
    assert safety.game_processes() == ["BlueArchive.exe"]
    [(command, kwargs)] = calls
    assert command == ["tasklist", "/FO", "CSV", "/NH"]
    assert kwargs["creationflags"] == safety.CREATE_NO_WINDOW == 0x08000000
    assert kwargs["timeout"]


@pytest.mark.skipif(os.name != "nt", reason="Toolhelp snapshots exist only on Windows")
def test_toolhelp_lists_this_process():
    assert any(pid == os.getpid() for pid, _ in safety._toolhelp_processes())


# --- Steam ---

def manifest_text(flags: int | str) -> str:
    return (f'"AppState"\n{{\n\t"appid"\t\t"{game_paths.STEAM_APP_ID}"\n\t"name"\t\t"Blue Archive"\n'
            f'\t"StateFlags"\t\t"{flags}"\n\t"installdir"\t\t"BlueArchive"\n}}\n')


def steam_install(root: Path, flags: int | str | None = 4) -> Path:
    """A Steam library with the game; returns the install root."""
    steamapps = root / "SteamLibrary" / "steamapps"
    install = steamapps / "common" / "BlueArchive"
    (install / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource" / "GameData" / "Windows").mkdir(parents=True)
    if flags is not None:
        (steamapps / f"appmanifest_{game_paths.STEAM_APP_ID}.acf").write_text(manifest_text(flags), encoding="utf-8")
    return install


@pytest.mark.parametrize("bit", sorted(safety.STEAM_BUSY_FLAGS))
def test_every_busy_bit_refuses(tmp_path, bit):
    install = steam_install(tmp_path, flags=4 | bit)
    assert safety.steam_state_flags(install) == 4 | bit
    expect_error("steam_busy", lambda: safety.check_steam_idle(install))


@pytest.mark.parametrize("flags", [4, 0, 64, 4 | 64, 2, 512])
def test_idle_flags_pass(tmp_path, flags):
    # 4 fully installed, 64 app running (not a busy bit until user check U5 says otherwise), 512 update required
    safety.check_steam_idle(steam_install(tmp_path, flags=flags))


def test_flags_are_a_bit_mask():
    assert safety.STEAM_BUSY_MASK == sum(safety.STEAM_BUSY_FLAGS)
    assert safety.STEAM_BUSY_MASK & 1048576 and safety.STEAM_BUSY_MASK & 256
    assert not safety.STEAM_BUSY_MASK & (4 | 64)


def test_the_manifest_is_found_from_the_install_root_and_a_resource_folder(tmp_path):
    install = steam_install(tmp_path, flags=1048580)
    manifest = install.parent.parent / f"appmanifest_{game_paths.STEAM_APP_ID}.acf"
    resource = install / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource" / "GameData" / "Windows"
    assert game_paths.steam_app_manifest(install) == manifest
    assert game_paths.steam_app_manifest(resource) == manifest
    expect_error("steam_busy", lambda: safety.check_steam_idle(resource))
    expect_error("steam_busy", lambda: safety.check_steam_idle(str(install)))


def test_the_manifest_is_found_through_a_link_to_the_install(tmp_path):
    install = steam_install(tmp_path / "real", flags=131076)
    link = tmp_path / "Games" / "BA"
    link.parent.mkdir()
    link.symlink_to(install, target_is_directory=True)
    assert game_paths.steam_app_manifest(link) == install.parent.parent / f"appmanifest_{game_paths.STEAM_APP_ID}.acf"
    expect_error("steam_busy", lambda: safety.check_steam_idle(link))


def test_steam_folder_names_ignore_case(tmp_path):
    steamapps = tmp_path / "SteamApps"
    install = steamapps / "Common" / "BlueArchive"
    install.mkdir(parents=True)
    (steamapps / f"appmanifest_{game_paths.STEAM_APP_ID}.acf").write_text(manifest_text(1024), encoding="utf-8")
    expect_error("steam_busy", lambda: safety.check_steam_idle(install))


@pytest.mark.parametrize("make", [
    lambda root: steam_install(root, flags=None),  # a Steam library without the manifest
    lambda root: steam_install(root, flags="busy"),  # unreadable flags
    lambda root: (root / "Games" / "BlueArchive").mkdir(parents=True) or root / "Games" / "BlueArchive",  # no Steam
    lambda root: root / "missing",  # no folder at all
])
def test_no_manifest_no_refusal(tmp_path, make):
    folder = make(tmp_path)
    assert safety.steam_state_flags(folder) is None
    safety.check_steam_idle(folder)


def test_a_common_folder_outside_steamapps_is_not_a_library(tmp_path):
    install = tmp_path / "common" / "BlueArchive"
    install.mkdir(parents=True)
    (tmp_path / f"appmanifest_{game_paths.STEAM_APP_ID}.acf").write_text(manifest_text(1048576), encoding="utf-8")
    assert game_paths.steam_app_manifest(install) is None
    safety.check_steam_idle(install)


# --- the call site ---

def game_file(install: Path) -> tuple[Path, list[Path]]:
    resource = install / "BlueArchive_Data" / "StreamingAssets" / "PUB" / "Resource" / "GameData" / "Windows"
    resource.mkdir(parents=True, exist_ok=True)
    path = resource / "assets-_mx-spinecharacters-test_spr-_mxdependency-2024-01-01_assets_all_1.bundle"
    path.write_bytes(b"UnityFS")
    return path, [resource]


def test_writable_game_files_checks_steam_for_its_game_folder(tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    install = steam_install(tmp_path, flags=1048580)
    path, resource_dirs = game_file(install)

    def write():
        with safety.writable_game_files([path], resource_dirs, game_folder=install):
            raise AssertionError("written while Steam is busy")

    expect_error("steam_busy", write)
    # the existing call, without a folder, keeps working
    with safety.writable_game_files([path], resource_dirs):
        pass


def test_writable_game_files_with_steam_idle(tmp_path, monkeypatch):
    monkeypatch.setattr(safety, "check_game_not_running", lambda: None)
    install = steam_install(tmp_path, flags=4)
    path, resource_dirs = game_file(install)
    with safety.writable_game_files([path], resource_dirs, game_folder=install):
        pass


def test_writable_game_files_checks_the_game_first(tmp_path, monkeypatch):
    install = steam_install(tmp_path, flags=1048580)
    path, resource_dirs = game_file(install)

    def running():
        raise ServiceError("game_running")

    monkeypatch.setattr(safety, "check_game_not_running", running)

    def write():
        with safety.writable_game_files([path], resource_dirs, game_folder=install):
            pass

    expect_error("game_running", write)
