"""CLI CAB persistence stays inside the App's managed cache boundary."""

import json
import os
from pathlib import Path
import subprocess
import sys

import pytest

from ba_modding_toolkit import config, utils
from ba_modding_toolkit.gameassets.cache import AssetCache, PreviewCache
from ba_modding_toolkit.gameassets.service import GameAssets
from ba_modding_toolkit.searching import find_cab_bundles, managed_cab_index
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.services import Services
from ba_modding_toolkit.webui.state import UiState
from test_cab_discovery import bundle
from test_webui import FakeCatalog, FakeGame, FakeLibrary


@pytest.fixture
def managed(tmp_path, monkeypatch):
    data = tmp_path / "data"
    data.mkdir()
    monkeypatch.setattr(utils, "EXE_DIR", data)
    monkeypatch.setattr(config, "user_cache_dir", lambda: data / "cache")
    return data, UiState(data / "webui.json")


def no_header(path):
    pytest.fail(f"A valid managed mapping should not reparse {path.name}")


@pytest.mark.parametrize("first", ["cli", "app"])
def test_cli_and_app_share_compatible_metadata(managed, tmp_path, first):
    data, _ = managed
    game_dir = tmp_path / "game"
    game_dir.mkdir()
    target = bundle(game_dir, "target.bundle", "CAB-TARGET")
    game = GameAssets([game_dir], AssetCache(root=data / "cache"),
                      preview_cache=PreviewCache(data / "cache" / "previews", allowed=True))
    cli = managed_cab_index([game_dir])
    app = game._cab_discovery()
    assert cli.key == app.key
    writer, reader = (cli, app) if first == "cli" else (app, cli)
    assert writer.resolve({"CAB-TARGET"}) == {"cab-target": str(target)}
    reader.reader = no_header
    assert reader.resolve({"CAB-TARGET"}) == {"cab-target": str(target)}


def test_search_scopes_and_directory_precedence_are_isolated(managed, tmp_path):
    left, right = tmp_path / "left", tmp_path / "right"
    left.mkdir()
    right.mkdir()
    a = bundle(left, "target.bundle", "CAB-TARGET")
    b = bundle(right, "target.bundle", "CAB-TARGET")
    for scope, expected in [([left], a), ([right], b), ([left, right], a), ([right, left], b)]:
        assert find_cab_bundles({"CAB-TARGET"}, scope) == {"CAB-TARGET": expected}
    assert len({managed_cab_index(scope).key for scope in ([left], [right], [left, right], [right, left])}) == 4


def test_resource_versions_are_isolated_even_with_unchanged_bundles(managed, tmp_path):
    game = tmp_path / "game"
    catalog = game / "Catalog" / "Windows" / "catalog_Windows.hash"
    catalog.parent.mkdir(parents=True)
    catalog.write_text("revision one")
    target = bundle(game, "target.bundle", "CAB-TARGET")
    old = managed_cab_index([game])
    assert old.resolve({"cab-target"})
    catalog.write_text("revision two")
    new = managed_cab_index([game])
    assert new.key != old.key
    calls = []
    from ba_modding_toolkit.gameassets.discovery import cab_names
    new.reader = lambda path: calls.append(path) or cab_names(path)
    assert new.resolve({"cab-target"}) == {"cab-target": str(target)}
    assert calls == [target]


def test_legacy_and_explicit_json_paths_are_never_read_or_written(managed, tmp_path, monkeypatch):
    data, _ = managed
    game = tmp_path / "game"
    game.mkdir()
    outside = bundle(tmp_path, "outside.bundle", "CAB-OUTSIDE")
    bundle(game, "inside.bundle", "CAB-INSIDE")
    legacy = data / "Addons" / "cab_cache.json"
    explicit = tmp_path / "selected.json"
    payload = json.dumps({"version": 1, "entries": {
        "CAB-OUTSIDE": {"path": str(outside), "size": outside.stat().st_size,
                        "mtime": outside.stat().st_mtime}}}).encode()
    legacy.parent.mkdir()
    for path in (legacy, explicit):
        path.write_bytes(payload)
    read_bytes, read_text = Path.read_bytes, Path.read_text

    def guarded(reader):
        def read(path, *args, **kwargs):
            assert path not in (legacy, explicit), "Retired JSON must not be read"
            return reader(path, *args, **kwargs)
        return read

    monkeypatch.setattr(Path, "read_bytes", guarded(read_bytes))
    monkeypatch.setattr(Path, "read_text", guarded(read_text))
    assert find_cab_bundles({"CAB-OUTSIDE"}, [game]) == {}
    assert find_cab_bundles({"CAB-OUTSIDE"}, [game], cache_path=explicit) == {}
    assert managed_cab_index([game]).key != managed_cab_index([game], explicit).key
    assert all(read_bytes(path) == payload for path in (legacy, explicit))
    assert list((data / "cache" / "previews").glob("*.preview"))


@pytest.mark.parametrize("opt_out", ["cli", "settings"])
def test_cache_opt_out_keeps_discovery_in_memory(managed, tmp_path, opt_out):
    data, state = managed
    game = tmp_path / "game"
    game.mkdir()
    target = bundle(game, "target.bundle", "CAB-TARGET")
    if opt_out == "settings":
        state.set("preview_cache", False)
    assert find_cab_bundles({"CAB-TARGET"}, [game], use_cache=opt_out != "cli") == {"CAB-TARGET": target}
    assert not (data / "cache").exists()


def test_settings_clear_removes_cli_cache_and_invalidates_a_running_index(managed, tmp_path):
    data, state = managed
    chosen = tmp_path / "selected cache parent"
    chosen.mkdir()
    state.set("cache_parent", str(chosen))
    game = tmp_path / "game"
    game.mkdir()
    target = bundle(game, "target.bundle", "CAB-TARGET")
    cli = managed_cab_index([game])
    assert cli.resolve({"cab-target"})
    services = Services(config.Settings(data / "config.toml"), data, state=state,
                        game=FakeGame(), catalog=FakeCatalog(), library=FakeLibrary())
    try:
        assert cli.cache.root == services.preview_cache.root
        assert list(cli.cache.root.glob("*.preview"))
        generation = cli.cache.generation
        assert "result" in build_api(services).call("settings.clearCache", {})
        assert not cli.cache.root.exists()
        assert cli.cache.generation != generation
        assert not cli.cache.put(cli.key, b"stale", generation=generation)
        calls = []
        from ba_modding_toolkit.gameassets.discovery import cab_names
        cli.reader = lambda path: calls.append(path) or cab_names(path)
        assert cli.resolve({"cab-target"}) == {"cab-target": str(target)}
        assert calls == [target]
        assert not (data / "cache").exists()
    finally:
        services.close()


def test_many_hits_publish_one_snapshot_before_logging(managed, tmp_path, monkeypatch):
    game = tmp_path / "game"
    game.mkdir()
    targets = {f"CAB-{i}": bundle(game, f"target-{i}.bundle", f"CAB-{i}") for i in range(32)}
    index = managed_cab_index([game])
    writes = []
    put = index.cache.put
    monkeypatch.setattr(index.cache, "put", lambda *args, **kw: writes.append(1) or put(*args, **kw))

    def log(message):
        assert writes == [1]

    assert find_cab_bundles(set(targets), [game], log=log, index=index) == targets
    assert writes == [1]
    index.reader = no_header
    assert find_cab_bundles(set(targets), [game], index=index) == targets
    assert writes == [1]


def test_keyboard_interrupt_publishes_completed_header_reads(managed, tmp_path):
    game = tmp_path / "game"
    game.mkdir()
    first = bundle(game, "a.bundle", "CAB-A")
    bundle(game, "b.bundle", "CAB-B")
    index = managed_cab_index([game])

    def interrupted(path):
        if path == first:
            return ["cab-a"]
        raise KeyboardInterrupt

    index.reader = interrupted
    with pytest.raises(KeyboardInterrupt):
        find_cab_bundles({"CAB-A", "CAB-B"}, [game], index=index)
    restarted = managed_cab_index([game])
    restarted.reader = no_header
    assert restarted.resolve({"cab-a"}) == {"cab-a": str(first)}


def test_broken_pipe_after_match_keeps_all_hits(managed, tmp_path):
    game = tmp_path / "game"
    game.mkdir()
    target = bundle(game, "target.bundle", "CAB-TARGET")

    def closed(message):
        raise BrokenPipeError

    with pytest.raises(BrokenPipeError):
        find_cab_bundles({"CAB-TARGET"}, [game], log=closed)
    restarted = managed_cab_index([game])
    restarted.reader = no_header
    assert restarted.resolve({"cab-target"}) == {"cab-target": str(target)}


def test_closed_stdout_exits_cleanly_and_keeps_hits(managed, tmp_path):
    data, _ = managed
    game = tmp_path / "game"
    game.mkdir()
    target = bundle(game, "target.bundle", "CAB-TARGET")
    script = '''
import importlib
from pathlib import Path
import sys
from ba_modding_toolkit.cli.handlers import CLILogger
from ba_modding_toolkit.searching import find_cab_bundles
cli = importlib.import_module("ba_modding_toolkit.cli.main")
cli._run = lambda: find_cab_bundles({"CAB-TARGET"}, [Path(sys.argv[1])], log=CLILogger().log)
cli.main()
'''
    environment = dict(os.environ, BAMT_DATA_DIR=str(data), BAMT_DEV_ROOTS=str(tmp_path),
                       BAMT_DEV_WRITABLE=str(tmp_path))
    read_fd, write_fd = os.pipe()
    os.close(read_fd)
    try:
        result = subprocess.run([sys.executable, "-c", script, str(game)], stdout=write_fd,
                                stderr=subprocess.PIPE, env=environment, timeout=30)
    finally:
        os.close(write_fd)
    assert result.returncode == 0, result.stderr.decode()
    assert result.stderr == b""
    restarted = managed_cab_index([game])
    restarted.reader = no_header
    assert restarted.resolve({"cab-target"}) == {"cab-target": str(target)}
