"""Regression coverage for the upstream CLI and cross-bundle integration."""

import struct
from types import SimpleNamespace

import pytest
from UnityPy.helpers import CompressionHelper

from ba_modding_toolkit.bundle import Bundle, get_cab_names
from ba_modding_toolkit.cli import handlers
from ba_modding_toolkit.cli.taps import InspectTap, InstallTap, MainTap, TraceTap
from ba_modding_toolkit.core.mod_install import InstallAction, ModFilePlan, ModGroup
from ba_modding_toolkit.core.introspect import inspect_bundles, trace_bundle
from ba_modding_toolkit.naming import parse_filename
from ba_modding_toolkit.references import BundleGraph, iter_pptrs, reference
from ba_modding_toolkit.searching import find_cab_bundles, managed_cab_index


def unityfs(path, *, compression=0, at_end=False, engine="2022.3.55f1", tail=b"CRC!"):
    names = {"CAB-synthetic", "CAB-synthetic.resS"}
    info = b"\0" * 16 + struct.pack(">ii", 0, len(names))
    for name in sorted(names):
        info += struct.pack(">qqI", 0, 0, 0) + name.encode() + b"\0"
    compressed = (CompressionHelper.compress_lzma(info) if compression == 1
                  else CompressionHelper.compress_lz4(info) if compression == 2 else info)
    prefix = b"UnityFS\0" + struct.pack(">I", 7) + b"5.x.x\0" + engine.encode() + b"\0"
    header_size = (len(prefix) + 20 + 15) & ~15
    flags = compression | 0x40 | (0x80 if at_end else 0)
    payload = b"unused data block" * 100
    header = prefix + struct.pack(">qIII", header_size + len(compressed) + len(payload),
                                  len(compressed), len(info), flags)
    header += b"\0" * (header_size - len(header))
    path.write_bytes(header + (payload + compressed if at_end else compressed + payload) + tail)
    return names


@pytest.mark.parametrize("engine", ["2019.4.40f1", "2022.3.55f1"])
@pytest.mark.parametrize("at_end", [False, True])
@pytest.mark.parametrize("compression", [0, 1, 2])
def test_cab_header_handles_compression_versions_and_crc_tail(tmp_path, engine, at_end, compression):
    path = tmp_path / "sample.bundle"
    expected = unityfs(path, engine=engine, at_end=at_end, compression=compression)
    assert get_cab_names(path) == expected


@pytest.mark.parametrize("payload", [b"", b"not a bundle", b"UnityFS\0\0"])
def test_cab_header_invalid_input_returns_fallback(tmp_path, payload):
    path = tmp_path / "bad.bundle"
    path.write_bytes(payload)
    assert get_cab_names(path) is None


def test_introspection_reads_official_samples_without_writing(sample_case):
    paths = sample_case.bundle_paths
    for path in paths:
        bundle = Bundle.load(path)
        assert get_cab_names(path) == set(bundle.env.file.files)
    logs = []
    inspect_bundles(paths, log=logs.append)
    assert any(line.startswith("Platform:") for line in logs)
    assert any(line.startswith("Objects:") for line in logs)
    trace_bundle(paths[0], log=logs.append)
    assert any("resolved," in line and "unresolved." in line for line in logs)


def test_cab_scan_caches_and_invalidates_changed_bundle(tmp_path, monkeypatch):
    bundle = tmp_path / "sample.bundle"
    names = unityfs(bundle)
    from ba_modding_toolkit import config, utils
    monkeypatch.setattr(utils, "EXE_DIR", tmp_path / "data")
    monkeypatch.setattr(config, "user_cache_dir", lambda: tmp_path / "cache")
    assert find_cab_bundles(names, [tmp_path]) == dict.fromkeys(names, bundle)
    cache = managed_cab_index([tmp_path])
    cache.reader = lambda path: pytest.fail("a valid cache must avoid scanning")
    assert find_cab_bundles(names, [tmp_path], index=cache) == dict.fromkeys(names, bundle)
    bundle.write_bytes(b"changed bundle")
    cache.reader = lambda path: ()
    assert cache.resolve(names) == {}


def test_same_group_cab_scan_stops_before_unrelated_bundle(tmp_path, monkeypatch):
    hint = tmp_path / "assets-_mx-spinecharacters-hoshino_spr-2026-10-24_001_1.bundle"
    sibling = tmp_path / "assets-_mx-spinecharacters-hoshino_spr-2026-10-24_002_2.bundle"
    unrelated = tmp_path / "other.bundle"
    sibling.write_bytes(b"same group")
    unrelated.write_bytes(b"x")
    visited = []

    def headers(path):
        visited.append(path)
        return {"cab-target"}

    index = managed_cab_index([tmp_path], use_cache=False)
    index.reader = headers
    assert find_cab_bundles({"CAB-target"}, [tmp_path], hint_path=hint, index=index) == {"CAB-target": sibling}
    assert visited == [sibling]


def test_reference_graph_resolves_external_script_once(monkeypatch, tmp_path):
    local = SimpleNamespace(name="CAB-local", externals=[SimpleNamespace(path="archive:/CAB-Remote")])
    remote = SimpleNamespace(name="CAB-remote", externals=[])
    pointer = {"m_FileID": 1, "m_PathID": 7}
    source = SimpleNamespace(assets_file=local, path_id=2,
                             read_typetree=lambda: {"m_Script": pointer})
    target = SimpleNamespace(assets_file=remote, path_id=7,
                             read_typetree=lambda: {"m_ClassName": "SyntheticScript"})
    path = tmp_path / "remote.bundle"
    loads, scans = [], []

    def load(bundle_path, log):
        loads.append(bundle_path)
        return SimpleNamespace(env=SimpleNamespace(objects=[target]))

    monkeypatch.setattr("ba_modding_toolkit.references.Bundle.load", load)
    graph = BundleGraph({}, fallback=lambda: scans.append(True) or {"CAB-REMOTE": path})
    assert reference(source, pointer) == ("CAB-Remote", 7)
    assert graph.deref(source, {"m_FileID": 0, "m_PathID": 0}) is None
    assert graph.script(source) == "SyntheticScript"
    assert graph.deref(source, pointer) is target
    assert loads == [path] and scans == [True]
    assert list(iter_pptrs({"rows": [pointer, {"value": {"m_FileID": 0, "m_PathID": 2}}]})) == [
        pointer, {"m_FileID": 0, "m_PathID": 2}]


def test_new_commands_are_present_in_grouped_help():
    help_text = MainTap().format_help()
    for text in ("Console output:", "File output:", "inspect", "trace", "install"):
        assert text in help_text


@pytest.mark.parametrize("cancel", [False, True])
def test_cli_install_keeps_backup_and_cancellation(tmp_path, monkeypatch, cancel):
    source = tmp_path / "mod.bundle"
    source.write_bytes(b"synthetic mod")
    game = tmp_path / "game"
    game.mkdir()
    target = game / source.name
    target.write_bytes(b"original")
    group = ModGroup("synthetic", "spinecharacters", "synthetic", [
        ModFilePlan(source, parse_filename(source.name), InstallAction.DIRECT_REPLACE,
                    existing_path=target)])
    monkeypatch.setattr(handlers, "plan_mod_install", lambda *args: [group])
    monkeypatch.setattr("builtins.input", lambda prompt: "q")
    argv = [str(source), "--resource-dir", str(game), "--output-dir", str(tmp_path / "out")]
    if not cancel:
        argv += ["--yes"]
    logs = []
    handlers.handle_install(InstallTap().parse_args(argv), SimpleNamespace(log=logs.append))
    assert target.read_bytes() == (b"original" if cancel else b"synthetic mod")
    backup = target.with_suffix(".bundle.backup")
    assert backup.exists() is not cancel
    if not cancel:
        assert backup.read_bytes() == b"original"
        assert any("Installed: 1 group(s)" in line for line in logs)


@pytest.mark.parametrize("command", ["install", "inspect", "trace"])
def test_new_cli_commands_keep_path_isolation(tmp_path, monkeypatch, command):
    allowed = tmp_path / "allowed"
    allowed.mkdir()
    monkeypatch.setenv("BAMT_DEV_ROOTS", str(allowed))
    monkeypatch.setenv("BAMT_DEV_WRITABLE", str(allowed))
    outside = tmp_path / "outside.bundle"
    parsers = {"install": InstallTap, "inspect": InspectTap, "trace": TraceTap}
    argv = [str(outside)]
    if command == "install":
        argv += ["--output-dir", str(allowed / "out")]
    logs = []
    getattr(handlers, "handle_" + command)(parsers[command]().parse_args(argv), SimpleNamespace(log=logs.append))
    assert any("outside the dev roots" in line for line in logs)
    assert not (allowed / "out").exists()
