"""Catalog snapshots, local data generation and read-only install integration."""

from concurrent.futures import ThreadPoolExecutor
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import time

import pytest

from ba_modding_toolkit.catalog import Catalog, DEFAULT_DATA
from ba_modding_toolkit.catalog._names import BASE_SHORT, LANGUAGES
from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.naming import parse_filename

FIXTURES = Path(__file__).parent / "fixtures" / "catalog"
ROOT = Path(__file__).resolve().parents[1]
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or Path.home() / "Library/Application Support/Blue Archive/Game")


class FakeGame:
    """Minimal game interface with query counters and editable scan results."""

    def __init__(self):
        self.calls = []
        self.cores = {
            "spr": {key + "_spr": [] for key in ("hoshino", "ch0010", "ch0020", "np0001",
                                                  "np0999", "unknown_new")},
            "lobby": {"hoshino_home": [], "hoshino_swimsuit_home": [], "ch0020_home_gl": [],
                      "unknown_new_home": [], "missing_home": [], "hoshino_home_teen": []},
        }
        self.cores["spr"]["hoshino_spr"] = [
            Path("assets-_mx-spinecharacters-hoshino_spr-2024-01-01_000_1.bundle"),
            Path("assets-_mx-spinecharacters-hoshino_spr-2025-02-03_001_2.bundle"),
        ]

    def spine_cores(self, kind: str) -> dict[str, list[Path]]:
        self.calls.append(kind)
        time.sleep(0.001)
        return self.cores[kind]

    def collection_names(self) -> dict[str, list[str]]:
        self.calls.append("collection")
        return {"bg": ["BG_Abydos_Collection"],
                "portrait": ["Student_Portrait_Hoshino_Collection", "Student_Portrait_CH0010_Collection"]}


@pytest.fixture
def game() -> FakeGame:
    return FakeGame()


@pytest.fixture
def catalog(game: FakeGame) -> Catalog:
    return Catalog(game, FIXTURES / "characters.csv", FIXTURES / "catalog.json")


def test_grouping_and_base_playable_story_order(catalog: Catalog):
    families = catalog.families()
    assert [family.key for family in families] == ["hoshino", "unknown_new"]
    family = catalog.family("HOSHINO")
    assert family.school == "Abydos"
    assert [variant.key for variant in family.variants] == ["hoshino", "ch0010", "ch0020", "np0001", "np0999"]
    assert all(variant.family == "hoshino" and variant.spr for variant in family.variants)
    assert family.names["en"] == "Hoshino"
    assert catalog.variant("hoshino").date == "2025-02-03"


def test_no_install_and_missing_portraits_are_excluded(catalog: Catalog):
    assert Catalog(None, None, Path("missing.json")).families() == []
    assert Catalog(None, None).variant_for_core("hoshino_home") is None
    with pytest.raises(ServiceError, match="catalog_variant_not_found"):
        catalog.variant("ch9000")
    with pytest.raises(ServiceError) as failure:
        catalog.family("missing")
    assert failure.value.params == {"key": "missing"}
    assert catalog.variant_for_core("missing_home") is None


def test_unknown_skeleton_has_own_file_id_family(catalog: Catalog):
    family = catalog.family("unknown_new")
    assert family.names == {lang: "unknown_new" for lang in LANGUAGES}
    variant = family.variants[0]
    assert variant.file_id == variant.key == family.key
    assert variant.playable is False
    assert variant.lobby == "unknown_new_home"
    assert variant.bg is variant.portrait is variant.date is None


def test_new_csv_additions_and_shipped_values_win(game: FakeGame, tmp_path: Path):
    csv_path = tmp_path / "map.csv"
    text = (FIXTURES / "characters.csv").read_text(encoding="utf-8-sig")
    csv_path.write_text(text.replace("Takanashi Hoshino", "Wrong Name"), encoding="utf-8")
    game.cores["spr"].update({"np1000_spr": [], "ch1001_spr": []})
    catalog = Catalog(game, csv_path, FIXTURES / "catalog.json")
    assert catalog.family("hoshino").names["en"] == "Hoshino"
    assert catalog.variant("hoshino").playable is True
    assert catalog.variant("np0999").family == "hoshino"
    assert catalog.variant("np0999").names["en"]["full"] == "Hoshino (Track)"
    assert [variant.key for variant in catalog.family("np1000").variants] == ["np1000", "ch1001"]


def test_missing_csv_is_optional(game: FakeGame, tmp_path: Path):
    catalog = Catalog(game, tmp_path / "missing.csv", FIXTURES / "catalog.json")
    assert catalog.variant("np0999").family == "np0999"


def test_added_file_ids_can_use_installed_collection_portraits(game: FakeGame):
    game.cores["spr"].update({"np1000_spr": [], "ch1001_spr": []})
    names = game.collection_names()
    names["portrait"].extend(["Student_Portrait_CH1001_Collection", "Student_Portrait_Unknown_New_Collection"])
    game.collection_names = lambda: names
    catalog = Catalog(game, FIXTURES / "characters.csv", FIXTURES / "catalog.json")
    assert catalog.variant("ch1001").playable is True
    assert catalog.variant("ch1001").portrait == "Student_Portrait_CH1001_Collection"
    assert catalog.variant("unknown_new").playable is True
    assert catalog.variant("np0999").bg == "BG_Abydos_Collection"


def test_lobby_aliases_regional_suffix_and_core_lookup(catalog: Catalog):
    assert catalog.variant("hoshino").lobby == "hoshino_home"
    assert catalog.variant("ch0010").lobby == "hoshino_swimsuit_home"
    assert catalog.variant("ch0020").lobby == "ch0020_home_gl"
    assert catalog.variant("np0001").lobby is None
    assert catalog.variant_for_core("CH0010_SPR").key == "ch0010"
    assert catalog.variant_for_core("HOSHINO_SWIMSUIT_HOME").key == "ch0010"
    assert catalog.variant_for_core("ch0020_home_gl").key == "ch0020"
    assert catalog.variant_for_core("hoshino_home_teen").key == "hoshino"
    assert catalog.variant_for_core("ch0010_home") is None


def test_shared_dev_alias_cannot_claim_another_variants_lobby(game: FakeGame, tmp_path: Path):
    data = json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))
    data["variants"]["ch0010"]["core_aliases"] = ["ch0020"]
    path = tmp_path / "shared.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    catalog = Catalog(game, None, path)
    assert catalog.variant("ch0010").lobby is None
    assert catalog.variant_for_core("ch0020_home_gl").key == "ch0020"


def test_json_records_and_callers_cannot_mutate_cache(catalog: Catalog):
    family = catalog.family("hoshino")
    payload = family.to_json()
    assert payload["variants"][0] == family.variants[0].to_json()
    json.dumps(payload)
    payload["names"]["en"] = "Changed"
    family.names["en"] = "Also changed"
    family.variants.clear()
    assert catalog.family("hoshino").names["en"] == "Hoshino"
    assert len(catalog.family("hoshino").variants) == 5


def test_thread_safe_single_build_and_reload(catalog: Catalog, game: FakeGame):
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: catalog.family("hoshino").key, range(24)))
    assert results == ["hoshino"] * 24
    assert game.calls == ["spr", "lobby", "collection"]
    del game.cores["spr"]["ch0010_spr"]
    game.cores["spr"]["future_spr"] = []
    assert catalog.variant("ch0010").spr
    catalog.reload()
    assert catalog.family("future").key == "future"
    with pytest.raises(ServiceError):
        catalog.variant("ch0010")
    assert game.calls == ["spr", "lobby", "collection"] * 2


def test_invalid_data_has_service_error_and_reload_keeps_snapshot(game: FakeGame, tmp_path: Path):
    data_path = tmp_path / "data.json"
    data_path.write_bytes((FIXTURES / "catalog.json").read_bytes())
    catalog = Catalog(game, None, data_path)
    catalog.families()
    data_path.write_text('{"students":{},"variants":{"bad":{}}}', encoding="utf-8")
    with pytest.raises(ServiceError) as failure:
        catalog.reload()
    assert failure.value.code == "catalog_data_invalid"
    assert catalog.family("hoshino").key == "hoshino"


@pytest.fixture(scope="module")
def shipped() -> dict:
    return json.loads(DEFAULT_DATA.read_text(encoding="utf-8"))


def test_shipped_names_and_playable_art_invariants(shipped: dict):
    assert shipped["version"] == 1
    assert len(shipped["variants"]) > 600
    for key, entry in shipped["variants"].items():
        assert key == entry["file_id"].lower()
        assert set(entry["names"]) == set(LANGUAGES)
        student = shipped["students"][str(entry["student_id"])]
        assert student["base"] in shipped["variants"]
        assert set(student["names"]) == set(LANGUAGES)
        if entry["playable"]:
            assert entry["bg"] and entry["portrait"]
            # every playable student is out on Japan; Global may not have them yet
            assert set(entry["released"]) == {"japan", "global"}
            assert all(isinstance(flag, bool) for flag in entry["released"].values())
            assert entry["released"]["japan"] is True
        else:
            assert "released" not in entry
        for lang, name in entry["names"].items():
            assert name["full"] and name["short"]
            assert not any(dot in str(name) for dot in ("\u00b7", "\u30fb"))
            if name["full"] == student["names"][lang]:
                assert name["short"] == BASE_SHORT[lang]
            if lang != "en":
                assert "(" not in name["full"] and ")" not in name["full"]
            if entry["name_sources"][lang] == "fallback":
                assert lang in entry["fallbacks"]


def test_all_43_curated_names_match_approved_snapshot(shipped: dict):
    approved = json.loads((FIXTURES / "curated_names.json").read_text(encoding="utf-8"))
    assert len(approved["variants"]) == 43
    assert shipped["rules"] == approved["rules"]
    for research_key, names in approved["variants"].items():
        key = approved["file_ids"][research_key]
        assert shipped["variants"][key]["names"] == names, research_key


def test_numbered_playables_legacy_names_and_shared_forms(shipped: dict):
    entries = shipped["variants"]
    assert entries["ch0258"]["schale_id"] == 10098
    assert entries["ch0258"]["portrait"] == "Student_Portrait_CH0258_Collection"
    assert entries["shiroko_ridingsuit"]["schale_id"] == 10024
    assert entries["reizyo"]["schale_id"] == 10104
    assert entries["np0288"]["playable"] is True
    assert entries["np0288"]["portrait"] == "Student_Portrait_CH0355_01_Collection"
    assert entries["np0186"]["student_id"] == entries["hoshino"]["student_id"]
    family_entries = sorted((entry for entry in entries.values() if entry["student_id"] == "42"),
                            key=lambda entry: entry["order"])
    assert [entry["file_id"].lower() for entry in family_entries[:3]] == ["hoshino", "hoshino_swimsuit", "ch0258"]


@pytest.fixture(scope="module")
def generator():
    spec = importlib.util.spec_from_file_location("build_catalog_data", ROOT / "scripts" / "build_catalog_data.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_generator_matches_orders_and_applies_curated_then_wiki(generator):
    data = generator.build_catalog(FIXTURES / "characters.csv", FIXTURES, FIXTURES / "names.json",
                                   FIXTURES / "wiki.json", FIXTURES / "variants.json")
    entries = data["variants"]
    assert entries["ch0020"]["order"] < entries["ch0010"]["order"] < entries["np0001"]["order"]
    assert entries["np0001"]["names"]["en"] == {"full": "Hoshino (Robber)", "short": "Robber"}
    assert entries["np0001"]["name_sources"]["en"] == "curated"
    assert entries["np0001"]["fallbacks"]["en"] == "story_variant"
    assert entries["np0001"]["portrait"] is None
    assert entries["ch0010"]["portrait"] == "Student_Portrait_CH0010_Collection"
    assert data["summary"]["kinds"]["playable"] == 3
    assert not data["summary"]["conflicts"]


def test_generator_ships_the_per_server_release_flags(generator):
    entries = generator.build_catalog(FIXTURES / "characters.csv", FIXTURES, FIXTURES / "names.json",
                                      FIXTURES / "wiki.json", FIXTURES / "variants.json")["variants"]
    assert entries["ch0020"]["released"] == {"japan": True, "global": False}
    assert entries["hoshino"]["released"] == entries["ch0010"]["released"] == {"japan": True, "global": True}
    assert "released" not in entries["np0001"]


def test_generator_cli_is_deterministic_and_needs_no_install(tmp_path: Path):
    command = [sys.executable, str(ROOT / "scripts" / "build_catalog_data.py"),
               "--csv", str(FIXTURES / "characters.csv"), "--schaledb", str(FIXTURES)]
    paths = [tmp_path / "first.json", tmp_path / "second.json"]
    for path in paths:
        result = subprocess.run([*command, "--out", str(path)], capture_output=True, text=True, check=True)
        assert "Catalog:" in result.stderr
        assert not result.stdout
    assert paths[0].read_bytes() == paths[1].read_bytes()
    assert len(paths[0].read_text().splitlines()) == 1
    data = json.loads(paths[0].read_text())
    assert paths[0].read_text() == json.dumps(data, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n"


class InstalledGame:
    """Read-only filename scan implementing the interface before GameAssets lands."""

    def __init__(self, directory: Path):
        from ba_modding_toolkit.searching import get_search_dirs

        self.cores = {"spr": {}, "lobby": {}}
        for root in get_search_dirs(directory):
            for path in root.glob("*.bundle"):
                parsed = parse_filename(path.name)
                kind = "spr" if parsed.category == "spinecharacters" and parsed.core.endswith("_spr") else "lobby"
                if kind == "spr" or parsed.category == "spinelobbies" and "_home" in parsed.core:
                    self.cores[kind].setdefault(parsed.core, []).append(path)

    def spine_cores(self, kind: str) -> dict[str, list[Path]]:
        return self.cores[kind]

    def collection_names(self) -> dict[str, list[str]]:
        return {"bg": [], "portrait": []}


@pytest.fixture(scope="module")
def installed_game_dir() -> Path:
    if not GAME_DIR.is_dir():
        pytest.skip("No game install found")
    return GAME_DIR


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install for integration")
def test_installed_hoshino_portraits_and_swimsuit_lobby(installed_game_dir: Path):
    game = InstalledGame(installed_game_dir)
    catalog = Catalog(game, None)
    family = catalog.family("hoshino")
    assert family.variants[0].key == "hoshino"
    expected = {"hoshino", "hoshino_swimsuit", "ch0241", "np0045", "ch0258"}
    assert expected <= {variant.key for variant in family.variants}
    assert all(variant.spr in game.spine_cores("spr") for variant in family.variants)
    assert catalog.variant("hoshino_swimsuit").lobby == "hoshino_swimsuit_home"
    assert catalog.variant_for_core("hoshino_swimsuit_home").key == "hoshino_swimsuit"
    if "airi0_home" in game.spine_cores("lobby"):
        assert catalog.variant_for_core("airi0_home").key == "airi"


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install for integration")
def test_installed_collection_validation_reports_absent_textures(generator, shipped: dict, installed_game_dir: Path):
    mismatches = generator.validate_game(shipped, installed_game_dir)
    assert not [item for item in mismatches if item["key"] in ("hoshino", "hoshino_swimsuit", "ch0258")]
