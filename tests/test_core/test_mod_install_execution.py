"""Install execution stays compatible with the library and isolated development runs."""

import binascii
from dataclasses import replace
from threading import Barrier

import pytest

from ba_modding_toolkit import mod_install as install
from ba_modding_toolkit.bundle import Bundle
from ba_modding_toolkit.models import FilePair, ModUpdateResult, SaveOptions
from ba_modding_toolkit.naming import parse_filename


def make_group(tmp_path, core, action=install.InstallAction.DIRECT_REPLACE, need_crc_fix=False):
    payload = f"mod {core}".encode()
    crc = binascii.crc32(payload) & 0xFFFFFFFF
    name = f"assets-_mx-spinecharacters-{core}-2026-10-20_003_{crc}.bundle"
    source, target = tmp_path / "mods" / name, tmp_path / "game" / name
    source.parent.mkdir(exist_ok=True)
    target.parent.mkdir(exist_ok=True)
    source.write_bytes(payload)
    target.write_bytes(b"original")
    parsed = parse_filename(name)
    file = install.ModFilePlan(source, parsed, action,
                               existing_path=target if action == install.InstallAction.DIRECT_REPLACE else None,
                               need_crc_fix=need_crc_fix)
    return install.ModGroup(parsed.prefix, parsed.category, core, [file],
                            target_paths=[target] if action == install.InstallAction.UPDATE else [])


@pytest.mark.parametrize("crc", [None, "mismatch", "missing"])
def test_bundle_crc_checks_bytes_without_loading_unity(tmp_path, monkeypatch, crc):
    payload = b"synthetic bytes, not a Unity bundle"
    expected = binascii.crc32(payload) & 0xFFFFFFFF
    suffix = str(expected if crc is None else expected ^ 1) if crc != "missing" else "unknown"
    path = tmp_path / f"bundle_{suffix}.bundle"
    path.write_bytes(payload)
    monkeypatch.setattr(Bundle, "load", lambda *args: pytest.fail("CRC checking must not load Unity"))
    assert Bundle.check_crc_match(path) is (crc is None)


def test_crc_matched_direct_install_copies_without_resaving(tmp_path, monkeypatch):
    group = make_group(tmp_path, "matched", need_crc_fix=True)
    file = group.files[0]
    monkeypatch.setattr(Bundle, "load", lambda *args: pytest.fail("matching CRC must use a direct copy"))

    result = install.execute_mod_install([group], tmp_path / "output", {"Texture2D"}, SaveOptions())

    assert file.existing_path.read_bytes() == file.mod_path.read_bytes()
    assert file.existing_path.with_suffix(".bundle.backup").read_bytes() == b"original"
    assert (result.installed_groups, result.skipped_groups, result.failed_groups) == (1, 0, [])
    assert result.installed_files == [file.mod_path]


def test_crc_mismatch_resaves_in_temp_and_preserves_caller_options(tmp_path, monkeypatch):
    group = make_group(tmp_path, "mismatch", need_crc_fix=True)
    file = group.files[0]
    file.mod_path.write_bytes(b"changed CRC")
    options = SaveOptions(perform_crc=False, extra_bytes=b"tail", compression="lz4")
    saved = []

    class RebuiltBundle:
        def save(self, path, save_options):
            saved.append(path)
            assert save_options == replace(options, perform_crc=True)
            assert path.parent != file.existing_path.parent
            path.write_bytes(b"rebuilt")
            return True, ""

    monkeypatch.setattr(Bundle, "load", lambda *args: RebuiltBundle())
    result = install.execute_mod_install([group], tmp_path / "output", {"Texture2D"}, options)

    assert result.installed_groups == 1 and result.failed_groups == []
    assert file.existing_path.read_bytes() == b"rebuilt"
    assert file.mod_path.read_bytes() == b"changed CRC"
    assert options.perform_crc is False
    assert len(saved) == 1 and not saved[0].exists()


def test_parallel_groups_merge_results_progress_and_animation_warnings(tmp_path, monkeypatch):
    groups = [make_group(tmp_path, core, install.InstallAction.UPDATE)
              for core in ("first", "second", "unchanged", "failed", "raised")]
    groups.append(make_group(tmp_path, "direct"))
    rendezvous = Barrier(2)
    progress = []

    def update(source_paths, target_paths, output_dir, **kwargs):
        core = parse_filename(source_paths[0].name).core
        assert kwargs["skip_unchanged"] is True
        if core == "raised":
            raise OSError("unreadable bundle")
        if core == "failed":
            return ModUpdateResult(False, "incompatible skeleton", [])
        if core == "unchanged":
            return ModUpdateResult(True, "all_targets_unchanged", [])
        # Both groups must reach this point together; this fails for serial execution.
        rendezvous.wait(timeout=5)
        output = output_dir / target_paths[0].name
        output.write_bytes(f"updated {core}".encode())
        return ModUpdateResult(True, "updated", [FilePair(output, target_paths[0])],
                               anim_diffs={"portrait.skel": {core}})

    monkeypatch.setattr(install, "process_mod_update", update)
    result = install.execute_mod_install(
        groups, tmp_path / "output", {"Texture2D"}, SaveOptions(), max_workers=2,
        progress_callback=lambda *args: progress.append(args))

    assert (result.installed_groups, result.skipped_groups) == (3, 1)
    assert set(result.failed_groups) == {("failed", "incompatible skeleton"), ("raised", "unreadable bundle")}
    assert result.anim_diffs == {"portrait.skel": {"first", "second"}}
    assert set(result.installed_files) == {g.files[0].mod_path for g in groups if g.core not in {"failed", "raised"}}
    assert [entry[0] for entry in progress] == list(range(1, len(groups) + 1))
    assert {entry[1] for entry in progress} == {len(groups)}
    assert {entry[2] for entry in progress} == {g.core for g in groups}
    for group in groups[:2]:
        target = group.target_paths[0]
        assert target.read_bytes() == f"updated {group.core}".encode()
        assert target.with_suffix(".bundle.backup").read_bytes() == b"original"


@pytest.mark.parametrize("max_workers", [1, 2])
def test_mixed_group_counts_direct_copy_when_update_is_unchanged(tmp_path, monkeypatch, max_workers):
    direct = make_group(tmp_path, "direct")
    update = make_group(tmp_path, "unchanged", install.InstallAction.UPDATE)
    direct.files += update.files
    direct.target_paths = update.target_paths
    monkeypatch.setattr(install, "process_mod_update",
                        lambda **kwargs: ModUpdateResult(True, "all_targets_unchanged", []))

    result = install.execute_mod_install([direct], tmp_path / "output", {"Texture2D"}, SaveOptions(),
                                         max_workers=max_workers)

    assert (result.installed_groups, result.skipped_groups, result.failed_groups) == (1, 0, [])
    assert set(result.installed_files) == {f.mod_path for f in direct.files}
    assert direct.files[0].existing_path.read_bytes() == direct.files[0].mod_path.read_bytes()
    assert update.target_paths[0].read_bytes() == b"original"


@pytest.mark.parametrize("max_workers", [1, 2])
def test_execution_keeps_dev_write_guard_in_worker_threads(tmp_path, monkeypatch, max_workers):
    groups = [make_group(tmp_path, core, need_crc_fix=True) for core in ("one", "two")]
    monkeypatch.setenv("BAMT_DEV_ROOTS", str(tmp_path))
    monkeypatch.setenv("BAMT_DEV_WRITABLE", "")

    result = install.execute_mod_install(groups, tmp_path / "output", {"Texture2D"}, SaveOptions(),
                                         max_workers=max_workers)

    assert result.installed_groups == 0 and result.installed_files == []
    assert {core for core, _ in result.failed_groups} == {"one", "two"}
    for group in groups:
        target = group.files[0].existing_path
        assert target.read_bytes() == b"original"
        assert not target.with_suffix(".bundle.backup").exists()
