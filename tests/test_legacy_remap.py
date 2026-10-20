"""Upgrade synthetic 0.2.0 records without opening an application or real library."""

import copy
import json

import pytest

from ba_modding_toolkit.i18n import I18n
from ba_modding_toolkit.library import service
from ba_modding_toolkit.library.migrations import LEGACY_REMAP

from test_library import game_bundle, reload_library, setup_library


OLD_SUFFIXES = {
    "en-US": " (remapped)",
    "zh-CN": "\uff08\u5df2\u91cd\u6392\uff09",
    "zh-TW": "\uff08\u5df2\u91cd\u6392\uff09",
    "ja-JP": "\uff08\u518d\u914d\u7f6e\u6e08\u307f\uff09",
    "ko-KR": " (\uc7ac\ubc30\uce58 \uc644\ub8cc)",
}


def legacy_record(root, number, label="test_spr", *, core="test_spr", target="test", kind="spr",
                  date="2026-01-01", parts=("002",), added="2026-10-01T08:00:00+00:00"):
    mod_id = f"{number:032x}"
    files = [game_bundle(root / "mods" / mod_id, core, part=part, date=date,
                         payload=f"paint {number} {part}".encode()).name for part in parts]
    return {"id": mod_id, "files": sorted(files), "label": label, "target": target,
            "kind": kind, "added": added, "seen": False}


def write_legacy_state(root, records, **extra):
    state = {"version": 1, "mods": records, "favorites": ["test"], "applied": {}, **extra}
    path = root / "state.json"
    path.write_text(json.dumps(state), encoding="utf-8")
    return path


@pytest.mark.parametrize("stored_language", OLD_SUFFIXES)
@pytest.mark.parametrize("language", OLD_SUFFIXES)
def test_legacy_pair_uses_current_repair_names_and_metadata_once(setup_library, monkeypatch, stored_language, language):
    env = setup_library
    original = legacy_record(env.root, 1)
    repaired = legacy_record(env.root, 2, "test_spr" + OLD_SUFFIXES[stored_language],
                             date="2026-10-01", parts=("002", "003"), added="2026-10-01T09:00:00+00:00")
    applied = {str(env.original): {"source": f"mod:{repaired['id']}", "sha1": "kept"}}
    path = write_legacy_state(env.root, [original, repaired], applied=applied)
    before = {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in env.tmp.rglob("*.bundle")}
    translate = I18n(language).t
    monkeypatch.setattr(service, "t", translate)
    monkeypatch.setattr(service.Bundle, "load", lambda *a, **kw: pytest.fail("Migration must not load bundles"))
    library = reload_library(env)
    mods = {m.id: m for m in library.mods()}
    assert mods[original["id"]].repaired_id == repaired["id"]
    fixed = mods[repaired["id"]]
    assert fixed.repaired_from == original["id"]
    assert fixed.label == translate("webui.remap.name", name="test_spr")
    assert fixed.to_json()["repaired_from"] == original["id"]
    assert not fixed.user_added
    assert len({m.repaired_from or m.id for m in mods.values()}) == 1
    for mod_id in mods:
        with pytest.raises(service.ServiceError, match="entry_changed"):
            library.remap(mod_id)
    monkeypatch.setattr(library, "_check_group", lambda *a, **kw: {"remappable": True})
    assert all(not library.compatibility(mod_id)["remappable"] for mod_id in mods)
    saved = json.loads(path.read_text())
    assert saved["migrations"] == [LEGACY_REMAP]
    assert saved["applied"] == applied and saved["favorites"] == ["test"]
    assert [m["files"] for m in saved["mods"]] == [original["files"], repaired["files"]]
    assert {p: (p.read_bytes(), p.stat().st_mtime_ns) for p in env.tmp.rglob("*.bundle")} == before
    contents = path.read_bytes()
    monkeypatch.setattr(service, "legacy_remapped", lambda _: pytest.fail("Migration must run once"))
    assert {m.id: m for m in reload_library(env).mods()} == mods
    assert path.read_bytes() == contents
    library.rename(original["id"], "Original alias")
    assert next(m for m in reload_library(env).mods() if m.id == fixed.id).label == translate(
        "webui.remap.name", name="Original alias")
    library.rename(original["id"], "")
    library.mark_seen(fixed.id)
    assert json.loads(path.read_text())["migrations"] == [LEGACY_REMAP]


@pytest.mark.parametrize("missing", ["record", "files"])
def test_deleted_original_leaves_a_tagged_standalone_repair(setup_library, missing):
    env = setup_library
    original = legacy_record(env.root, 1)
    repaired = legacy_record(env.root, 2, "test_spr (remapped)")
    if missing == "files":
        for name in original["files"]:
            (env.root / "mods" / original["id"] / name).unlink()
    write_legacy_state(env.root, [repaired] if missing == "record" else [original, repaired])
    library = reload_library(env)
    fixed, = library.mods()
    assert fixed.repaired_from and fixed.repaired_from != fixed.id
    assert not fixed.repaired_id
    assert fixed.label == service.t("webui.remap.name", name="test_spr")
    with pytest.raises(service.ServiceError, match="entry_changed"):
        library.remap(fixed.id)
    assert reload_library(env).mods() == [fixed]


@pytest.mark.parametrize("mismatch", ["core", "target", "kind", "added", "ambiguous"])
def test_legacy_link_requires_unique_name_core_variant_kind_and_earlier_source(setup_library, mismatch):
    env = setup_library
    original = legacy_record(env.root, 1)
    repaired = legacy_record(env.root, 2, "test_spr (remapped)")
    if mismatch == "core":
        original = legacy_record(env.root, 1, core="other_spr")
    elif mismatch == "kind":
        original = legacy_record(env.root, 1, core="test_home", kind="lobby")
    elif mismatch == "target":
        original["target"] = "other"
    elif mismatch == "added":
        original["added"] = "2026-10-02T08:00:00+00:00"
    records = [original, repaired]
    if mismatch == "ambiguous":
        records.append(legacy_record(env.root, 3))
    write_legacy_state(env.root, records)
    library = reload_library(env)
    mods = {m.id: m for m in library.mods()}
    fixed = mods[repaired["id"]]
    assert fixed.repaired_from not in mods
    assert all(not m.repaired_id for m in mods.values())
    assert len({m.repaired_from or m.id for m in mods.values()}) == len(records)


def test_migration_preserves_modern_metadata_and_ordinary_names(setup_library):
    env = setup_library
    original = legacy_record(env.root, 1)
    modern = legacy_record(env.root, 2, "test_spr (remapped)")
    modern.update(repaired_from=original["id"], alias="Own alias")
    original["repaired_id"] = modern["id"]
    records = [original, modern, legacy_record(env.root, 3, "test_spr (remapped) extra"),
               legacy_record(env.root, 4, "test_spr"), legacy_record(env.root, 5, "test_spr (remapped)")]
    records[-1]["user_added"] = True
    before = copy.deepcopy(records)
    path = write_legacy_state(env.root, records)
    reload_library(env)
    assert json.loads(path.read_text())["mods"] == before


def test_multiple_legacy_repairs_share_the_source_and_keep_an_existing_jump(setup_library):
    env = setup_library
    original = legacy_record(env.root, 1)
    repairs = [legacy_record(env.root, n, "test_spr (remapped)") for n in (2, 3)]
    original["repaired_id"] = repairs[1]["id"]
    write_legacy_state(env.root, [original, *repairs])
    mods = {m.id: m for m in reload_library(env).mods()}
    assert mods[original["id"]].repaired_id == repairs[1]["id"]
    assert all(mods[r["id"]].repaired_from == original["id"] for r in repairs)
    assert len({m.repaired_from or m.id for m in mods.values()}) == 1


@pytest.mark.parametrize("reverse", [False, True])
def test_legacy_repair_chains_are_independent_of_record_order(setup_library, reverse):
    env = setup_library
    original = legacy_record(env.root, 1)
    original["alias"] = "Original alias"
    first = legacy_record(env.root, 2, "test_spr (remapped)")
    second = legacy_record(env.root, 3, "test_spr (remapped)" + OLD_SUFFIXES["zh-CN"])
    first["repaired_id"] = second["id"]
    records = [original, first, second]
    write_legacy_state(env.root, list(reversed(records)) if reverse else records)
    library = reload_library(env)
    mods = {m.id: m for m in library.mods()}
    assert all(mods[r["id"]].repaired_from == original["id"] for r in (first, second))
    assert len({m.repaired_from or m.id for m in mods.values()}) == 1
    assert all(mods[r["id"]].label == service.t("webui.remap.name", name="Original alias") for r in (first, second))
    library.remove(original["id"])
    assert all(m.label == service.t("webui.remap.name", name="Original alias") for m in reload_library(env).mods())


def test_existing_empty_instance_migrates_legacy_state_on_refresh(setup_library):
    env = setup_library
    original = legacy_record(env.root, 1)
    repaired = legacy_record(env.root, 2, "test_spr (remapped)")
    path = write_legacy_state(env.root, [original, repaired])
    mods = {m.id: m for m in env.library.mods()}
    assert mods[repaired["id"]].repaired_from == original["id"]
    assert json.loads(path.read_text())["migrations"] == [LEGACY_REMAP]


def test_done_marker_survives_other_instance_saves_and_skips_later_similar_names(setup_library):
    env = setup_library
    original = legacy_record(env.root, 1)
    repaired = legacy_record(env.root, 2, "test_spr (remapped)")
    write_legacy_state(env.root, [original, repaired], migrations=["another_upgrade"])
    stale = reload_library(env)
    other = reload_library(env)
    other.rename(original["id"], "Alias from another instance")
    stale.set_favorite("other", True)
    path = env.root / "state.json"
    state = json.loads(path.read_text())
    assert set(state["migrations"]) == {"another_upgrade", LEGACY_REMAP}
    assert state["mods"][0]["alias"] == "Alias from another instance"
    later = legacy_record(env.root, 3, "test_spr (remapped)")
    state["mods"].append(later)
    path.write_text(json.dumps(state))
    assert not next(m for m in reload_library(env).mods() if m.id == later["id"]).repaired_from


def test_failed_migration_write_keeps_disk_and_memory_retryable(setup_library, monkeypatch):
    env = setup_library
    original = legacy_record(env.root, 1)
    repaired = legacy_record(env.root, 2, "test_spr (remapped)")
    path = write_legacy_state(env.root, [original, repaired])
    before = path.read_bytes()
    save = service.atomic_json
    with monkeypatch.context() as patch:
        patch.setattr(service, "atomic_json", lambda *a, **kw: (_ for _ in ()).throw(OSError("disk full")))
        library = reload_library(env)
        assert path.read_bytes() == before
        assert not library._records[repaired["id"]].get("repaired_from")
    assert service.atomic_json is save
    assert next(m for m in library.mods() if m.id == repaired["id"]).repaired_from == original["id"]
    assert json.loads(path.read_text())["migrations"] == [LEGACY_REMAP]
