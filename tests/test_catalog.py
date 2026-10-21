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
# the real-install tests run only on an official game folder named by BAMT_TEST_GAME_DIR
GAME_DIR = Path(os.environ.get("BAMT_TEST_GAME_DIR") or "/nonexistent/bamt-real-game")


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


def test_thai_names_fall_back_to_english_for_older_catalogs_and_new_csv_rows(catalog: Catalog):
    assert catalog.family("hoshino").names["th"] == catalog.family("hoshino").names["en"]
    assert catalog.variant("hoshino").names["th"] == {"full": "Hoshino", "short": "ต้นฉบับ"}
    assert catalog.variant("np0999").names["th"] == catalog.variant("np0999").names["en"]


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
    assert catalog.variant("ch1001").recruitable is True
    assert catalog.variant("ch1001").portrait == "Student_Portrait_CH1001_Collection"
    assert catalog.variant("unknown_new").playable is True
    assert catalog.variant("unknown_new").recruitable is True
    assert catalog.variant("np1000").recruitable is False
    assert catalog.variant("np0999").bg == "BG_Abydos_Collection"


def with_portraits(game: FakeGame, portraits: list[str]) -> FakeGame:
    game.collection_names = lambda: {"bg": ["BG_Abydos_Collection"], "portrait": list(portraits)}
    return game


def recruitable(catalog: Catalog, *keys: str) -> dict[str, bool]:
    return {key: catalog.variant(key).recruitable for key in keys}


def test_recruitable_follows_the_installed_portraits_then_the_servers_flags(game: FakeGame):
    keys = ("hoshino", "ch0010", "ch0020", "np0001", "np0999")
    on_global = Catalog(game, FIXTURES / "characters.csv", FIXTURES / "catalog.json", server="global")
    assert recruitable(on_global, *keys) == {"hoshino": True, "ch0010": True, "ch0020": False,
                                             "np0001": False, "np0999": False}
    assert on_global.variant("ch0020").playable is True  # playable on Japan only
    on_japan = Catalog(game, FIXTURES / "characters.csv", FIXTURES / "catalog.json", server="japan")
    assert recruitable(on_japan, *keys) == {"hoshino": True, "ch0010": True, "ch0020": True,
                                            "np0001": False, "np0999": False}


def test_installed_portrait_wins_over_a_stale_flag(game: FakeGame):
    # a game update releases the student on Global before the app ships new flags
    with_portraits(game, ["Student_Portrait_Hoshino_Collection", "Student_Portrait_CH0010_Collection",
                          "Student_Portrait_CH0020_Collection"])
    assert Catalog(game, None, FIXTURES / "catalog.json").variant("ch0020").recruitable is True


def test_released_flag_covers_a_missing_portrait(game: FakeGame):
    with_portraits(game, ["Student_Portrait_Hoshino_Collection"])
    assert recruitable(Catalog(game, None, FIXTURES / "catalog.json"), "ch0010", "ch0020") == {
        "ch0010": True, "ch0020": False}


def test_without_flags_the_install_decides_unless_it_has_no_collection_index(game: FakeGame, caplog):
    game.cores["spr"]["ch9000_spr"] = []
    with_portraits(game, ["Student_Portrait_CH0010_Collection"])
    assert recruitable(Catalog(game, None, FIXTURES / "catalog.json"), "hoshino", "ch9000") == {
        "hoshino": True, "ch9000": False}
    with_portraits(game, [])
    catalog = Catalog(game, None, FIXTURES / "catalog.json")
    assert recruitable(catalog, "hoshino", "ch0010", "ch0020", "ch9000", "np0001") == {
        "hoshino": True, "ch0010": True, "ch0020": False, "ch9000": True, "np0001": False}
    assert "No collection portraits" in caplog.text


def test_not_recruitable_playables_follow_the_recruitable_ones(game: FakeGame, tmp_path: Path):
    data = json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))
    data["variants"]["ch0010"]["released"] = {"japan": False, "global": True}
    path = tmp_path / "order.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with_portraits(game, ["Student_Portrait_Hoshino_Collection"])
    family = Catalog(game, FIXTURES / "characters.csv", path, server="japan").family("hoshino")
    assert [variant.key for variant in family.variants] == ["hoshino", "ch0020", "ch0010", "np0001", "np0999"]


@pytest.mark.parametrize("released", [{"global": "no"}, {"china": True}, [True, False]])
def test_invalid_release_flags_are_rejected(game: FakeGame, tmp_path: Path, released):
    data = json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))
    data["variants"]["ch0020"]["released"] = released
    path = tmp_path / "flags.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ServiceError) as failure:
        Catalog(game, None, path).families()
    assert failure.value.code == "catalog_data_invalid"


def test_shipped_aliases_reach_families_and_variants(game: FakeGame, tmp_path: Path):
    data = json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))
    data["students"]["42"]["aliases"] = ["\u5c0f\u661f"]
    data["variants"]["ch0010"]["aliases"] = ["\u5c0f\u661f\uff08\u6cf3\u88c5\uff09"]
    path = tmp_path / "aliases.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    catalog = Catalog(game, None, path)
    family = catalog.family("hoshino")
    assert family.aliases == ["\u5c0f\u661f"]
    assert catalog.variant("ch0010").aliases == ["\u5c0f\u661f\uff08\u6cf3\u88c5\uff09"]
    assert catalog.variant("hoshino").aliases == []
    assert family.to_json()["aliases"] == ["\u5c0f\u661f"]
    assert family.to_json()["variants"][1]["aliases"] == ["\u5c0f\u661f\uff08\u6cf3\u88c5\uff09"]


@pytest.mark.parametrize("aliases", ["\u5c0f\u661f", [""], [3], {"zh-CN": "x"}])
def test_invalid_aliases_are_rejected(game: FakeGame, tmp_path: Path, aliases):
    data = json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))
    data["variants"]["ch0020"]["aliases"] = aliases
    path = tmp_path / "aliases.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    with pytest.raises(ServiceError) as failure:
        Catalog(game, None, path).families()
    assert failure.value.code == "catalog_data_invalid"


def test_new_csv_rows_take_the_cn_servers_names_as_aliases(game: FakeGame, tmp_path: Path):
    """A character the shipped data lacks: zh-CN shows Kivo's wording, the CN server's is an alias."""
    momoi_kivo, momoi_cn = "\u624d\u7fbd \u6843\u4e95", "\u624d\u7fbd \u6843"  # Momoi
    armed_kivo, armed_cn = "\u4e34\u6218", "\u6b66\u88c5"  # the Armed costume word
    fields = ["file_id", "student_id", "page_id", "spine_remark", "name_kivo", "name_cn", "name_tw", "name_en",
              "name_jp", "skin_kivo", "skin_cn", "skin_tw", "skin_en", "skin_jp", "school_id", "school_name"]
    rows = [["CH1100", "900", "", "", momoi_kivo, momoi_cn, "", "Saiba Momoi", "", "", "", "", "", "", "4", ""],
            ["NP1101", "900", "", "", momoi_kivo, momoi_cn, "", "Saiba Momoi", "", armed_kivo, armed_cn,
             "", "Armed", "", "4", ""]]
    csv_path = tmp_path / "map.csv"
    csv_path.write_text("\n".join(",".join(row) for row in [fields, *rows]) + "\n", encoding="utf-8")
    game.cores["spr"].update({"ch1100_spr": [], "np1101_spr": []})
    catalog = Catalog(game, csv_path, FIXTURES / "catalog.json")
    family = catalog.family("ch1100")
    assert family.names["zh-CN"] == "\u6843\u4e95"
    assert family.aliases == ["\u6843"]
    assert catalog.variant("ch1100").aliases == ["\u6843"]
    armed = catalog.variant("np1101")
    assert armed.names["zh-CN"]["full"] == "\u6843\u4e95\uff08\u4e34\u6218\uff09"
    assert armed.aliases == ["\u6843\uff08\u6b66\u88c5\uff09"]


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


def test_core_map_agrees_with_the_roster_on_every_core(game: FakeGame):
    game.cores["spr"].update({"np1000_spr": [], "ch1001_spr": []})  # rows only the character map has
    catalog = Catalog(game, FIXTURES / "characters.csv", FIXTURES / "catalog.json")
    mapped = catalog.core_map(game.cores["spr"], game.cores["lobby"])
    roster = {core: catalog.variant_for_core(core) for core in [*game.cores["spr"], *game.cores["lobby"]]}
    for core, variant in roster.items():
        if variant is not None:
            assert mapped.key(core) == variant.key, core
    assert all(mapped.core(v.key, "spr") == v.spr for f in catalog.families() for v in f.variants)
    assert all(mapped.core(v.key, "lobby") == v.lobby for f in catalog.families() for v in f.variants if v.lobby)
    # a lobby without a portrait of its variant here: the variant its name gives, else the core less its suffix
    assert roster["missing_home"] is None and mapped.key("missing_home") == "missing"
    assert mapped.names["hoshino"]["en"]["full"] == catalog.variant("hoshino").names["en"]["full"]
    assert "unknown_new" not in mapped.names  # no shipped names: the cards show the core name
    assert game.calls == ["spr", "lobby", "collection"]  # the map asks the game nothing


def test_core_map_of_another_install_follows_the_data_not_the_current_install(catalog: Catalog):
    # a Japan folder holding a lobby named by a dev alias and a student the current install lacks
    japan = catalog.core_map(["ch0020_spr", "ch0042_spr"], ["hoshino_swimsuit_home", "ch0042_home", "ch0010_home_gl"])
    assert japan.key("hoshino_swimsuit_home") == "ch0010"  # ch0010's core alias, though ch0010 has no portrait there
    assert japan.key("ch0010_home_gl") == "ch0010"
    assert japan.core("ch0010", "lobby") == "ch0010_home_gl"  # a direct file-id match first
    assert japan.key("ch0042_spr") == japan.key("ch0042_home") == "ch0042"
    assert japan.core("ch0042", "spr") == "ch0042_spr" and japan.core("ch0010", "spr") is None
    assert catalog.variant_for_core("hoshino_swimsuit_home").key == "ch0010"


def test_core_map_copies_the_kept_parse(game: FakeGame):
    catalog = Catalog(game, None, FIXTURES / "catalog.json")
    before = {core: catalog.variant_for_core(core).key for core in game.cores["spr"]}
    first = catalog.core_map(["newcomer_spr"], [])
    assert first.key("newcomer_spr") == "newcomer"
    second = catalog.core_map(["hoshino_spr"], ["newcomer_home"])
    # the first install's unknown key never enters the second's map, nor the roster's
    assert second.key("newcomer_home") == "newcomer" and "newcomer" not in second.spr
    assert "newcomer" not in second.names
    with pytest.raises(ServiceError):
        catalog.variant("newcomer")
    assert {core: catalog.variant_for_core(core).key for core in game.cores["spr"]} == before


def test_reload_parses_the_data_again_for_the_map_and_keeps_both_when_invalid(game: FakeGame, tmp_path: Path):
    data_path = tmp_path / "data.json"
    data = json.loads((FIXTURES / "catalog.json").read_text(encoding="utf-8"))
    data_path.write_text(json.dumps(data), encoding="utf-8")
    catalog = Catalog(game, None, data_path)
    assert catalog.core_map([], ["dev_alias_home"]).key("dev_alias_home") == "dev_alias"
    data["variants"]["ch0020"]["core_aliases"] = ["dev_alias"]
    data_path.write_text(json.dumps(data), encoding="utf-8")
    assert catalog.core_map([], ["dev_alias_home"]).key("dev_alias_home") == "dev_alias"  # the kept parse
    catalog.reload()
    assert catalog.core_map([], ["dev_alias_home"]).key("dev_alias_home") == "ch0020"
    data_path.write_text('{"students":{},"variants":{"bad":{}}}', encoding="utf-8")
    with pytest.raises(ServiceError) as failure:
        catalog.reload()
    assert failure.value.code == "catalog_data_invalid"
    assert catalog.core_map([], ["dev_alias_home"]).key("dev_alias_home") == "ch0020"
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
            if lang in ("en", "ko", "th"):  # half-width brackets, as the game writes them
                assert "（" not in name["full"] and "）" not in name["full"]
            else:
                assert "(" not in name["full"] and ")" not in name["full"]
            if entry["name_sources"][lang] == "fallback":
                assert lang in entry["fallbacks"]


def test_all_43_curated_names_match_approved_snapshot(shipped: dict):
    approved = json.loads((FIXTURES / "curated_names.json").read_text(encoding="utf-8"))
    assert len(approved["variants"]) == 43
    assert shipped["rules"] == approved["rules"]
    for research_key, names in approved["variants"].items():
        key = approved["file_ids"][research_key]
        assert {lang: value for lang, value in shipped["variants"][key]["names"].items() if lang != "th"} == names, research_key


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


@pytest.mark.skipif(not GAME_DIR.is_dir(), reason="No local game install for integration")
def test_installed_recruitable_follows_portraits_then_flags(shipped: dict, installed_game_dir: Path, tmp_path: Path):
    from ba_modding_toolkit.gameassets import AssetCache, GameAssets
    from ba_modding_toolkit.searching import get_search_dirs

    # allowed=False: the collection index stays in memory, nothing is written
    game = GameAssets(get_search_dirs(installed_game_dir), AssetCache(allowed=False, root=tmp_path))
    assert game.collection_names()["portrait"]  # the install signal is available
    for server in ("global", "japan"):
        for family in Catalog(game, None, server=server).families():
            for variant in family.variants:
                flag = shipped["variants"].get(variant.key, {}).get("released", {}).get(server)
                assert variant.recruitable == (variant.playable and (variant.portrait is not None or flag is True))
