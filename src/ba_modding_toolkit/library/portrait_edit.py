"""Compose one roster portrait into a shared Collection bundle without changing its neighbors."""

from __future__ import annotations

import copy
import hashlib
import io
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING

from PIL import Image, ImageOps
from UnityPy.helpers.ResourceReader import get_resource_data

from .. import devmode
from ..bundle import Bundle
from ..errors import ServiceError
from ..models import SaveOptions
from . import profiles
from .judge import core_of, date_of, other_target
from .models import PhotographApplyResult

if TYPE_CHECKING:
    from .models import ApplyResult, Pin
    from .service import ModLibrary

TAG = "roster_photography"


def _objects(bundle: Bundle) -> dict:
    return {(obj.assets_file.name, obj.path_id): obj for obj in bundle.env.objects}


def _streams(bundle: Bundle) -> dict[str, str]:
    return {name: hashlib.sha256(file.bytes).hexdigest() for name, file in bundle.env.file.files.items()
            if not hasattr(file, "objects")}


def _texture(bundle: Bundle, name: str):
    found = [obj for obj in bundle.env.objects if obj.type.name == "Texture2D" and obj.peek_name() == name]
    if len(found) != 1:
        raise ServiceError("photo_target_unavailable")
    return found[0]


def patch_portraits(base: Path, official: Path, output: Path, edits: dict[str, bytes | None],
                    *, compression: str = "lz4", crc: bool = True) -> None:
    """Compose a batch without changing unrelated objects, streams or texture geometry."""
    bundle, original = Bundle.load(base), Bundle.load(official)
    if bundle is None or original is None:
        raise ServiceError("bundle_invalid", file=base)
    targets = {name: _texture(bundle, name) for name in edits}
    changed = {(obj.assets_file.name, obj.path_id) for obj in targets.values()}
    before = {entry: hashlib.sha256(obj.get_raw_data()).hexdigest()
              for entry, obj in _objects(bundle).items() if entry not in changed}
    streams = _streams(bundle)
    expected = {}
    for name, png in edits.items():
        target, source = targets[name], _texture(original, name)
        source_data = source.read()
        width, height = source_data.m_Width, source_data.m_Height
        if png is None:
            # Inline the exact official GPU-encoded bytes, including mipmaps.
            stream = source_data.m_StreamData
            payload = bytes(get_resource_data(stream.path, source.assets_file, stream.offset, stream.size)
                            if stream and stream.path else source_data.image_data)
            if not payload:
                raise ServiceError("photo_target_unavailable")
            source_data.image_data = payload
            if stream:
                stream.path, stream.offset, stream.size = "", 0, 0
            target.save_typetree(source_data)
            expected[name] = (width, height, source_data.m_TextureFormat, payload, None)
        else:
            with Image.open(io.BytesIO(png)) as image:
                image.load()
                fitted = ImageOps.fit(image.convert("RGBA"), (width, height), Image.Resampling.LANCZOS)
            data = target.read()
            # Preserve capture quality instead of introducing GPU block-compression loss.
            data.set_image(fitted, target_format=4, mipmap_count=max(1, source_data.m_MipCount or 1))
            data.save()
            expected[name] = (width, height, 4, None, fitted.tobytes())
    success, _ = bundle.save(output, SaveOptions(perform_crc=crc, compression=compression))
    if not success:
        raise ServiceError("photo_apply_failed")
    checked = Bundle.load(output)
    if checked is None:
        raise ServiceError("photo_apply_failed")
    after_objects = _objects(checked)
    if (set(after_objects) != set(_objects(bundle)) or streams != _streams(checked) or
            any(hashlib.sha256(after_objects[entry].get_raw_data()).hexdigest() != digest
                for entry, digest in before.items())):
        raise ServiceError("photo_apply_failed")
    for name, (width, height, texture_format, encoded, pixels) in expected.items():
        result = _texture(checked, name).read()
        if (result.m_Width, result.m_Height, result.m_TextureFormat) != (width, height, texture_format):
            raise ServiceError("photo_apply_failed")
        if pixels is not None:
            if result.image.convert("RGBA").tobytes() != pixels:
                raise ServiceError("photo_apply_failed")
        elif bytes(result.image_data) != encoded:
            raise ServiceError("photo_apply_failed")


def patch_portrait(base: Path, official: Path, output: Path, name: str, png: bytes | None,
                   *, compression: str = "lz4", crc: bool = True) -> None:
    patch_portraits(base, official, output, {name: png}, compression=compression, crc=crc)


def target_file(library: ModLibrary, descriptor: dict, pin: Pin) -> Path:
    core = core_of(descriptor["bundle"])
    paths = library._index(pin).get(core, [])
    exact = [path for path in paths if path.name == descriptor["bundle"]]
    if (len(exact) != 1 or any(date_of(path.name) > date_of(descriptor["bundle"]) for path in paths)):
        raise ServiceError("photo_target_unavailable")
    return exact[0]


def _configuration(library: ModLibrary, descriptor: dict, pin: Pin) -> tuple[str, dict, dict | None]:
    core = core_of(descriptor["bundle"])
    configured = (library.profiles.read() or {}).get("folders", {}).get(pin.key, {}).get("configured", {})
    direct = configured.get(core)
    if direct:
        source = direct.get("source", "")
        return core, direct, library._records.get(source[4:]) if source.startswith("mod:") else None
    matches = []
    for slot, entry in configured.items():
        source = entry.get("source", "")
        record = library._records.get(source[4:]) if source.startswith("mod:") else None
        if descriptor["name"] not in entry.get("photo_defaults", []) and (
                descriptor["name"] in ((record or {}).get(TAG) or {}).get("choices", {})):
            matches.append((slot, entry, record))
    return max(matches, key=lambda item: item[1].get("since", "")) if matches else (core, {}, None)


def choice(library: ModLibrary, descriptor: dict, pin: Pin) -> dict:
    """The desired photo choice, including a configuration deferred by the master switch."""
    target = target_file(library, descriptor, pin)
    config = library.profiles.read()
    slot, entry, record = _configuration(library, descriptor, pin)
    enabled = profiles.enabled(config)
    part = library._view([pin], "family", config).part(target, pin, "other")
    source = entry.get("source")
    if not source:
        return {"id": None, "known": not enabled or part.official, "enabled": enabled}
    meta = (record or {}).get(TAG) or {}
    item = (meta.get("choices") or {}).get(descriptor["name"])
    if isinstance(item, dict):
        return {"id": item.get("photo"), "known": True, "enabled": enabled,
                "pending": enabled and part.carried != source,
                "error": entry.get("error") or ({"code": "photo_target_unavailable", "params": {}}
                                                 if slot != core_of(target.name) else None)}
    return {"id": None, "known": meta.get("base_official") is True, "enabled": enabled,
            "pending": enabled and part.carried != source, "error": entry.get("error")}


def _referenced_sources(library: ModLibrary) -> set:
    config = library.profiles.read() or {}
    sources = {entry.get("source") for folder in config.get("folders", {}).values()
               for entry in folder.get("configured", {}).values()}
    sources.update(entry.get("source") for path, entry in library._applied.items() if Path(path).exists() and not entry.get('removed'))
    return sources


def usage_targets(library: ModLibrary) -> dict[str, set[str]]:
    """Map referenced photos to their target skins, independently of the photo's originating skin."""
    config = library.profiles.read() or {}
    uses = [(entry.get('source'), set(entry.get('photo_defaults', [])))
            for folder in config.get('folders', {}).values() for entry in folder.get('configured', {}).values()]
    uses.extend((entry.get('source'), set()) for path, entry in library._applied.items()
                if Path(path).exists() and not entry.get('removed'))
    targets = {}
    for source, defaults in uses:
        if not isinstance(source, str) or not source.startswith('mod:'):
            continue
        for name, item in ((library._records.get(source[4:], {}).get(TAG) or {}).get('choices') or {}).items():
            if name in defaults or not isinstance(item, dict) or not isinstance(item.get('photo'), str):
                continue
            variants = targets.setdefault(item['photo'], set())
            if isinstance(item.get('variant'), str):
                variants.add(item['variant'])
    return targets


def in_use(library: ModLibrary) -> set[str]:
    return set(usage_targets(library))


def remove_photo(library: ModLibrary, key: str, log) -> None:
    """Reset every affected texture, retaining other choices in each shared Collection recipe."""
    config = library.profiles.read() or {}
    enabled = profiles.enabled(config)
    pins = {pin.key: pin for pin in library._all_pins()}
    # Applied-only recipes also own real texture choices. Reconcile a different desired recipe first.
    for path, applied in list(library._applied.items()):
        source = applied.get('source', '')
        record = library._records.get(source[4:], {}) if source.startswith('mod:') else {}
        if applied.get('removed') or not any(value.get('photo') == key
                for value in (record.get(TAG) or {}).get('choices', {}).values()):
            continue
        target = Path(path)
        if not target.exists():
            continue
        pin = next((pin for pin in pins.values() if target.parent in pin.dirs), None)
        if not enabled:
            applied.update(source='removed', removed=True)
            applied.pop('build', None)
            continue
        if pin is None:
            raise ServiceError('game_not_found')
        core = core_of(target.name)
        desired = config.get('folders', {}).get(pin.key, {}).get('configured', {}).get(core)
        if desired and desired.get('source') != source:
            library._switch(pin, core, desired['source'], log)
        elif not desired:
            library._configure(pin, core, {core: core}, source)
    tasks = []
    for install, folder in (library.profiles.read() or {}).get('folders', {}).items():
        for core, entry in folder.get('configured', {}).items():
            source = entry.get('source', '')
            record = library._records.get(source[4:], {}) if source.startswith('mod:') else {}
            matches = [(name, value) for name, value in (record.get(TAG) or {}).get('choices', {}).items()
                       if value.get('photo') == key and name not in entry.get('photo_defaults', [])]
            if not matches:
                continue
            pin = pins.get(install)
            if pin is None:
                raise ServiceError('game_not_found')
            paths = library._index(pin).get(core, [])
            if len(paths) != 1:
                raise ServiceError('photo_target_unavailable')
            tasks.extend((pin, {'bundle': paths[0].name, 'name': name}, value['variant']) for name, value in matches)
    for pin, descriptor, variant in tasks:
        apply(library, variant, None, None, descriptor, pin, log, None)
    library._save()
    if key in in_use(library):
        raise ServiceError('photo_in_use')


def _prune_composites(library: ModLibrary) -> None:
    referenced = _referenced_sources(library)
    obsolete = [key for key, entry in library._records.items() if entry.get(TAG) and f"mod:{key}" not in referenced]
    library._drop_mods(obsolete)


def _drop_migrated_choices(library: ModLibrary, pin: Pin) -> None:
    """Retire a vanished batch only once all of its photo choices have newer live-batch choices."""
    live = set(library._index(pin))
    def update(data):
        folder = data.get("folders", {}).get(pin.key, {})
        configured = folder.get("configured", {})
        covered = {}
        for slot, entry in configured.items():
            source = entry.get("source", "")
            record = library._records.get(source[4:], {}) if source.startswith("mod:") else {}
            if slot in live:
                for name in (record.get(TAG) or {}).get("choices", {}):
                    covered[name] = max(covered.get(name, ""), entry.get("since", ""))
        removed = set()
        for slot, entry in list(configured.items()):
            source = entry.get("source", "")
            meta = (library._records.get(source[4:], {}).get(TAG) or {}) if source.startswith("mod:") else {}
            if slot in live or not meta.get("base_official"):
                continue
            required = [name for name, value in meta.get("choices", {}).items()
                        if value.get("photo") and name not in entry.get("photo_defaults", [])]
            if all(name in covered and covered[name] >= entry.get("since", "") for name in required):
                del configured[slot]
                removed.add(slot)
                for field in ("built", "updated"):
                    folder.get(field, {}).pop(slot, None)
        if removed:
            data["unfinished"] = [item for item in data.get("unfinished", [])
                                  if not (item.get("install") == pin.key and item.get("core") in removed)]
        return bool(removed)
    library.profiles.update(update)


def _default_missing(library: ModLibrary, pin: Pin, slot: str, name: str) -> None:
    def update(data):
        entry = data.get("folders", {}).get(pin.key, {}).get("configured", {}).get(slot)
        if entry is None or name in entry.get("photo_defaults", []):
            return False
        entry.setdefault("photo_defaults", []).append(name)
        return True
    library.profiles.update(update)


def _result(result: ApplyResult, variant: str, core: str) -> PhotographApplyResult:
    return PhotographApplyResult(variant, result.source, result.files, result.unchanged,
                                 result.deferred, cores=[core])


def apply(library: ModLibrary, variant: str, photo: str | None, png: bytes | None, descriptor: dict,
          pin: Pin, log, progress, *, configure_only: bool = False) -> ApplyResult:
    """Produce a managed generic Mod so journaled writes, version updates and the master switch remain shared."""
    target = target_file(library, descriptor, pin)
    core = core_of(target.name)
    official = library._official_for(target, pin)
    before = library._hashes.get(target).sha1
    config = library.profiles.read() or {}
    slot, configured, record = _configuration(library, descriptor, pin)
    configured_source = configured.get("source", "official")
    meta = copy.deepcopy((record or {}).get(TAG) or {})
    if photo is None and configured_source == "official" and (
            library._hashes.get(target).sha1 == library._hashes.get(official).sha1):
        return _result(library.apply(core, "official", kind="other", pin=pin, log=log, progress=progress), variant, core)
    with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX) as temporary:
        work = Path(temporary)
        edits = {descriptor["name"]: png}
        if record is not None and slot != core:
            if not meta.get("base_official"):
                raise ServiceError("photo_target_unavailable")
            loaded = Bundle.load(official)
            if loaded is None:
                raise ServiceError("bundle_invalid", file=official)
            names = {obj.peek_name() for obj in loaded.env.objects if obj.type.name == "Texture2D"}
            choices = {name: value for name, value in meta.get("choices", {}).items() if name in names}
            for name, value in choices.items():
                if name != descriptor["name"] and value.get("photo"):
                    edits[name] = library.photographs.image(value["variant"], value["photo"])
            meta["choices"] = choices
            base = official
        elif record is not None:
            base = library._install_direct(record, [target], work / "base", log, progress, pin)[target]
        else:
            base = target
        # Preserve an outside change instead of rebuilding over it from stale configured bytes.
        part = library._view([pin], "full", config).part(target, pin, "other")
        if profiles.enabled(config) and part.carried not in ("official", configured_source):
            base, meta = target, {}
            edits = {descriptor["name"]: png}
        if "base_official" not in meta:
            meta["base_official"] = library._hashes.get(base).sha1 == library._hashes.get(official).sha1
        choices = meta.setdefault("choices", {})
        choices[descriptor["name"]] = {"variant": variant, "photo": photo}
        if photo is None and meta["base_official"] and all(item.get("photo") is None for item in choices.values()):
            result = library.apply(core, "official", kind="other", pin=pin, log=log, progress=progress)
            if slot != core:
                _default_missing(library, pin, slot, descriptor["name"])
                _drop_migrated_choices(library, pin)
            _prune_composites(library)
            return _result(result, variant, core)
        directory = work / "composite"
        directory.mkdir()
        output = directory / target.name
        patch_portraits(base, official, output, edits, compression="lz4", crc=library.settings.crc_needed(target))
        files = {target.name: output}
        saved = library._store(files, "Student thumbnail", other_target(files), "other",
                               metadata={TAG: meta})
        source = f"mod:{saved['id']}"
        if configure_only or not profiles.enabled(config):
            library._defer(pin, saved["target"], {core: core}, source)
            result = PhotographApplyResult(variant, source, [], unchanged=True, deferred=True, cores=[core])
        else:
            library._configure(pin, saved["target"], {core: core}, source)
            try:
                files = library._commit({target: library._paths(saved)[0]}, source, log, progress, pin,
                                        prune=False, expected={target: before})
                library._selection_error(pin, [core], None)
                library._clear_marker(pin, core)
                result = PhotographApplyResult(variant, source, files, unchanged=not files, cores=[core])
            except Exception as error:
                library._selection_error(pin, [core], error.to_json() if isinstance(error, ServiceError) else {
                    "code": "library_io_error", "params": {"file": str(target)}})
                raise
    _drop_migrated_choices(library, pin)
    # Captured PNGs persist; only obsolete compiled composites can be discarded.
    _prune_composites(library)
    return result


def refresh_missing(library: ModLibrary, pins: list[Pin], log) -> None:
    """Rebuild photograph-only recipes on changed Collection batches before a master-switch plan."""
    from ..filelock import file_lock
    from ..gameassets import GameAssets

    config = library.profiles.read() or {}
    current_pin = library.current_pin()
    for pin in pins:
        configured = config.get("folders", {}).get(pin.key, {}).get("configured", {})
        live = library._index(pin)
        missing = []
        for slot, entry in configured.items():
            source = entry.get("source", "")
            record = library._records.get(source[4:], {}) if source.startswith("mod:") else {}
            meta = record.get(TAG) or {}
            if slot not in live and meta.get("base_official"):
                missing.append((slot, entry, meta))
        if not missing:
            continue
        if pin.key == getattr(current_pin, "key", None) and callable(getattr(library.game, "collection_target", None)):
            game = library.game
            game.clear_memory()
        elif getattr(library.game, "cache", None) is not None:
            game = GameAssets(list(pin.dirs), library.game.cache, preview_cache=library.game.preview_cache)
        else:
            continue
        with library._transaction_lock(), file_lock(library.root / "mods.lock"):
            for slot, old_entry, meta in missing:
                for name, value in meta.get("choices", {}).items():
                    if not value.get("photo") or name in old_entry.get("photo_defaults", []):
                        continue
                    try:
                        descriptor = game.collection_target(name)
                        new_core = core_of(descriptor["bundle"])
                        now = (library.profiles.read() or {}).get("folders", {}).get(pin.key, {}).get("configured", {})
                        present = now.get(new_core)
                        if present:
                            source = present.get("source", "")
                            current = library._records.get(source[4:], {}) if source.startswith("mod:") else {}
                            current_choice = (current.get(TAG) or {}).get("choices", {}).get(name)
                            if current_choice and present.get("since", "") >= old_entry.get("since", ""):
                                continue
                            if not current.get(TAG):
                                # An explicit shared-bundle Mod is not replaced by an old photo recipe.
                                continue
                        png = library.photographs.image(value["variant"], value["photo"])
                        apply(library, value["variant"], value["photo"], png, descriptor, pin,
                              log, None, configure_only=True)
                    except ServiceError as error:
                        library._selection_error(pin, [slot], error.to_json())
                        log(f"Photograph configuration retained for unavailable texture {name}")
            _drop_migrated_choices(library, pin)
            _prune_composites(library)
