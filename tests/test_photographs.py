"""Persistent camera captures and App selection never alter preview caches or game files."""

import base64
import hashlib
import io
import json
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library import photographs
from ba_modding_toolkit.library.photographs import Photographs


def capture(size=(202, 228), color=(13, 85, 170, 180)):
    stream = io.BytesIO()
    Image.new("RGBA", size, color).save(stream, format="PNG")
    raw = stream.getvalue()
    return "data:image/png;base64," + base64.b64encode(raw).decode(), raw


def test_lossless_rectangular_capture_ownership_and_independent_app_selection(tmp_path):
    gallery = Photographs(tmp_path)
    png, raw = capture()
    first = gallery.save("student_a", png, "portrait", "02", source="portrait/source")
    key = first["saved"]
    second = gallery.save("student_b", png, "lobby", action="Talk_01")
    assert first["photos"][0]["width"] == 202 and first["photos"][0]["height"] == 228
    assert gallery.image("student_a", key) == raw
    assert first["photos"][0]["sha256"] == hashlib.sha256(raw).hexdigest()
    gallery.select("student_a", key)
    assert Photographs(tmp_path).app_url("student_a").endswith(key + ".png")
    assert gallery.list("student_b")["app"] is None
    assert gallery.list("student_b")["photos"][0]["id"] == second["saved"]
    with pytest.raises(ServiceError, match="photo_missing"):
        gallery.image("student_b", key)


@pytest.mark.parametrize("bad", ["", "data:image/jpeg;base64,abc", "data:image/png;base64,!!!", 42])
def test_invalid_capture_is_rejected_without_creating_files(tmp_path, bad):
    gallery = Photographs(tmp_path)
    with pytest.raises(ServiceError, match="photo_invalid"):
        gallery.save("a", bad, "portrait")
    assert not gallery.root.exists()


def test_unreasonable_dimensions_and_wrong_mode_are_rejected(tmp_path):
    gallery = Photographs(tmp_path)
    for size in ((32, 228), (202, 32), (4097, 64)):
        with pytest.raises(ServiceError, match="photo_invalid"):
            gallery.save("a", capture(size)[0], "portrait")
    with pytest.raises(ServiceError, match="photo_invalid"):
        gallery.save("a", capture()[0], "model")


def test_metadata_failure_leaves_no_partial_photo_or_choice(tmp_path, monkeypatch):
    gallery = Photographs(tmp_path)
    monkeypatch.setattr(photographs, "atomic_json", lambda *args: (_ for _ in ()).throw(OSError("Synthetic failure")))
    with pytest.raises(OSError):
        gallery.save("a", capture()[0], "portrait")
    assert gallery.list("a")["photos"] == []
    assert not list((gallery.root / "images").iterdir())


def test_preview_selection_is_deletable_but_unreconciled_game_use_is_protected(tmp_path):
    gallery = Photographs(tmp_path)
    key = gallery.save("a", capture()[0], "portrait")["saved"]
    gallery.select("a", key)
    with pytest.raises(ServiceError, match="photo_in_use"):
        gallery.delete("a", key, {key})
    gallery.delete("a", key)
    assert gallery.selection('a') is None
    assert gallery.list("a")["photos"] == []


def test_modified_png_and_path_traversal_cannot_be_selected(tmp_path):
    gallery = Photographs(tmp_path)
    key = gallery.save("a", capture()[0], "portrait")["saved"]
    (gallery.root / "images" / (key + ".png")).write_bytes(b"changed")
    with pytest.raises(ServiceError, match="photo_invalid"):
        gallery.select("a", key)
    for value in ("../../escape", "default", None, "A" * 32):
        with pytest.raises(ServiceError, match="photo_missing"):
            gallery.image("a", value)
    assert gallery.list("a")["app"] is None


def test_manifest_corruption_is_reported_without_overwriting_it(tmp_path):
    gallery = Photographs(tmp_path)
    gallery.root.mkdir()
    gallery.index.write_text("bad JSON")
    with pytest.raises(ServiceError, match="photo_library_invalid"):
        gallery.save("a", capture()[0], "portrait")
    assert gallery.index.read_text() == "bad JSON"


def test_two_instances_preserve_each_others_captures_and_selection(tmp_path):
    first, second = Photographs(tmp_path), Photographs(tmp_path)
    png, _ = capture()
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda store: store.save("a", png, "portrait"), (first, second)))
    photos = first.list("a")["photos"]
    assert len(photos) == 2 and {entry["number"] for entry in photos} == {1, 2}
    key = results[0]["saved"]
    second.select("a", key)
    assert first.list("a")["app"] == key


def test_symlinked_capture_cannot_escape_the_library(tmp_path):
    gallery = Photographs(tmp_path)
    key = gallery.save("a", capture()[0], "portrait")["saved"]
    path = gallery.root / "images" / (key + ".png")
    elsewhere = tmp_path / "elsewhere.png"
    path.rename(elsewhere)
    path.symlink_to(elsewhere)
    with pytest.raises(ServiceError, match="photo_invalid"):
        gallery.image("a", key)
    assert elsewhere.exists()


def test_failed_selection_publish_retains_previous_selection(tmp_path, monkeypatch):
    gallery = Photographs(tmp_path)
    first = gallery.save("a", capture()[0], "portrait")["saved"]
    second = gallery.save("a", capture(color=(10, 20, 30, 255))[0], "portrait")["saved"]
    gallery.select("a", first)
    monkeypatch.setattr(photographs, "atomic_json", lambda *args: (_ for _ in ()).throw(OSError("Synthetic failure")))
    with pytest.raises(OSError):
        gallery.select("a", second)
    assert Photographs(tmp_path).list("a")["app"] == first


def test_family_gallery_has_independent_variant_counters_and_selections(tmp_path):
    from ba_modding_toolkit.library.photographs import Photographs
    import base64
    import io
    from PIL import Image
    stream = io.BytesIO()
    Image.new('RGBA', (202, 228), (40, 120, 180, 255)).save(stream, 'PNG')
    png = 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()
    store = Photographs(tmp_path, lambda key: key.split('_')[0])
    a = store.save('student_base', png, 'portrait')['saved']
    b = store.save('student_swimsuit', png, 'lobby')['saved']
    entries = store.list('student_base')['photos']
    assert {item['id'] for item in entries} == {a, b}
    assert [item['number'] for item in entries] == [1, 1]
    store.select('student_base', b)
    assert store.list('student_base')['app'] == b
    assert store.list('student_swimsuit')['app'] is None
    assert store.list('another_base')['photos'] == []
    builtin = store.save('student_base', png, 'portrait', builtin=True)['saved']
    generated = next(item for item in store.list('student_base')['photos'] if item['id'] == builtin)
    assert generated['provenance'] == 'generated' and generated['managed']
    assert next(item for item in store.save('student_base', png, 'portrait')['photos'] if item['number'] == 2)
    store.select('student_base', 'official')
    assert store.selection('student_base') == 'official'
    assert store.app_url('student_base') is None
    reopened = Photographs(tmp_path, lambda key: key.split('_')[0])
    assert reopened.image('student_base', b) == stream.getvalue()


def test_manifest_flush_failure_restores_references_before_removing_image(tmp_path, monkeypatch):
    gallery = Photographs(tmp_path)
    first = gallery.save("a", capture()[0], "portrait")["saved"]
    real = photographs.atomic_json
    calls = []
    def fail_after_replace(path, data):
        real(path, data)
        calls.append(path)
        if len(calls) == 1:
            raise OSError("Manifest directory flush failed")
    monkeypatch.setattr(photographs, "atomic_json", fail_after_replace)
    with pytest.raises(OSError):
        gallery.save("a", capture()[0], "portrait")
    fresh = Photographs(tmp_path)
    assert [entry["id"] for entry in fresh.list("a")["photos"]] == [first]
    assert len(list((gallery.root / "images").glob("*.png"))) == 1
    assert fresh.image("a", first)


def test_failed_save_rollback_retains_valid_published_bytes_without_success(tmp_path, monkeypatch):
    gallery = Photographs(tmp_path)
    real = photographs.atomic_json
    calls = []
    def fail(path, data):
        calls.append(path)
        if len(calls) == 1:
            real(path, data)
        raise OSError("Flush or rollback failed")
    monkeypatch.setattr(photographs, "atomic_json", fail)
    with pytest.raises(OSError):
        gallery.save("a", capture()[0], "portrait")
    fresh = Photographs(tmp_path)
    for entry in fresh.list("a")["photos"]:
        assert fresh.image("a", entry["id"])
