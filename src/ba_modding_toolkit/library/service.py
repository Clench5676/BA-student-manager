"""Thread-safe library operations built on the classic mod installer."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import tempfile
import threading
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from functools import wraps
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from UnityPy.helpers.ResourceReader import get_resource_data

from .. import core, mod_install
from ..bundle import Bundle
from ..errors import ServiceError
from ..models import AssetType, LogFunc, ProgressCallback
from ..naming import parse_filename
from ..utils import no_log
from .models import (
    ApplyResult, AssetDifference, CompareResult, GameFileState, Kind, ModEntry,
    UpdateResult, VariantState,
)
from .safety import check_resource_path, writable_game_files
from .storage import Fingerprints, atomic_copy, atomic_json
from .variants import adapt_variant_sources

if TYPE_CHECKING:
    from ..catalog import Catalog
    from ..config import Settings
    from ..gameassets import GameAssets

logger = logging.getLogger(__name__)


def _serialized(method: Callable) -> Callable:
    @wraps(method)
    def call(self: ModLibrary, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            try:
                return method(self, *args, **kwargs)
            except OSError as error:
                logger.exception("Library file operation failed")
                raise ServiceError("library_io_error", file=error.filename) from error
            except ServiceError:
                raise
            except Exception as error:
                logger.exception("Library operation failed: %s", method.__name__)
                raise ServiceError("library_operation_failed", operation=method.__name__) from error
    return call


class ModLibrary:
    """Store mods, retain verified official originals, and track installed sources.

    One reentrant lock serializes state changes and UnityPy work in this service.
    Call long operations on the caller's worker thread.
    """

    def __init__(self, root: Path, catalog: Catalog, game: GameAssets, settings: Settings) -> None:
        self.root = Path(root).resolve()
        self.catalog = catalog
        self.game = game
        self.settings = settings
        self._lock = threading.RLock()
        self._hashes = Fingerprints()
        self._records: dict[str, dict[str, Any]] = {}
        self._favorites: set[str] = set()
        self._applied: dict[str, dict[str, str]] = {}
        self._index_signature: tuple = ()
        self._index: dict[str, list[Path]] = {}
        self._load()

    def _load(self) -> None:
        try:
            data = json.loads((self.root / "state.json").read_text(encoding="utf-8"))
            if not isinstance(data, dict) or data.get("version") != 1:
                return
            records = {}
            for record in data.get("mods", []):
                mod_id = record["id"]
                if not isinstance(mod_id, str) or len(mod_id) != 32 or any(c not in "0123456789abcdef" for c in mod_id):
                    continue
                files = record["files"]
                if not files or not all(isinstance(f, str) and Path(f).name == f and f.endswith(".bundle") for f in files):
                    continue
                if not all(isinstance(record[key], str) for key in ("label", "target", "added")):
                    continue
                if record["kind"] not in ("spr", "lobby") or not isinstance(record["seen"], bool):
                    continue
                if all((self.root / "mods" / mod_id / f).is_file() for f in files):
                    records[mod_id] = record
            favorites = {key for key in data.get("favorites", []) if isinstance(key, str)}
            applied = {
                path: record for path, record in data.get("applied", {}).items()
                if isinstance(path, str) and isinstance(record, dict)
                and isinstance(record.get("source"), str) and isinstance(record.get("sha1"), str)
            }
            self._records, self._favorites, self._applied = records, favorites, applied
        except FileNotFoundError:
            pass
        except (OSError, ValueError, TypeError, KeyError, AttributeError):
            logger.warning("Ignoring unreadable library state", exc_info=True)

    def _save(self) -> None:
        atomic_json(self.root / "state.json", {
            "version": 1, "mods": list(self._records.values()),
            "favorites": sorted(self._favorites), "applied": self._applied,
        })

    def _variant(self, key: str) -> Any:
        try:
            return self.catalog.variant(key)
        except KeyError as error:
            raise ServiceError("variant_not_found", variant=key) from error

    def _record(self, mod_id: str) -> dict[str, Any]:
        try:
            return self._records[mod_id]
        except KeyError as error:
            raise ServiceError("mod_not_found", id=mod_id) from error

    def _paths(self, record: dict[str, Any]) -> list[Path]:
        directory = self.root / "mods" / record["id"]
        paths = [directory / name for name in record["files"]]
        if any(not path.resolve().is_relative_to(directory.resolve()) for path in paths):
            raise ServiceError("mod_unsupported", file=paths[0])
        return paths

    def _entry(self, record: dict[str, Any]) -> ModEntry:
        paths = self._paths(record)
        parsed = parse_filename(paths[0].name)
        return ModEntry(record["id"], paths[0], record["label"], record["target"], record["kind"],
                        record["added"], not record["seen"], sum(p.stat().st_size for p in paths),
                        parsed.date, parsed.crc)

    @_serialized
    def mods(self) -> list[ModEntry]:
        """Return the mod entries in insertion order."""
        return [self._entry(record) for record in self._records.values()]

    @_serialized
    def add(self, paths: list[Path]) -> list[ModEntry]:
        """Copy supported bundles into the library, deduplicating by SHA-1."""
        known = {self._hashes.get(path).sha1 for record in self._records.values() for path in self._paths(record)}
        added = []
        for source in map(Path, paths):
            name = source.name.removesuffix(".backup") if source.name.endswith(".bundle.backup") else source.name
            parsed = parse_filename(name)
            kind: Kind | None = "spr" if parsed.core.lower().endswith("_spr") else (
                "lobby" if parsed.core.lower().endswith(("_home", "_home_gl")) else None)
            variant = self.catalog.variant_for_core(parsed.core.lower()) if kind else None
            if not name.endswith(".bundle") or not parsed.prefix or not parsed.crc or kind is None or variant is None:
                raise ServiceError("mod_unsupported", file=source)
            fingerprint = self._hashes.get(source)
            if fingerprint.sha1 in known:
                continue
            mod_id = uuid.uuid4().hex
            target = self.root / "mods" / mod_id / name
            atomic_copy(source, target)
            record = {"id": mod_id, "files": [name], "label": parsed.core, "target": variant.key,
                      "kind": kind, "added": datetime.now(timezone.utc).isoformat(), "seen": False}
            self._records[mod_id] = record
            try:
                self._save()
            except OSError:
                del self._records[mod_id]
                shutil.rmtree(target.parent)
                raise
            known.add(fingerprint.sha1)
            added.append(self._entry(record))
        return added

    @_serialized
    def remove(self, mod_id: str) -> None:
        """Remove a stored mod while retaining restore copies and applied history."""
        record = self._record(mod_id)
        del self._records[mod_id]
        try:
            self._save()
        except OSError:
            self._records[mod_id] = record
            raise
        shutil.rmtree(self.root / "mods" / mod_id)

    @_serialized
    def rename(self, mod_id: str, label: str) -> None:
        """Change a mod's display label."""
        record = self._record(mod_id)
        old = record["label"]
        record["label"] = label
        try:
            self._save()
        except OSError:
            record["label"] = old
            raise

    @_serialized
    def mark_seen(self, mod_id: str) -> None:
        """Clear a mod's fresh flag."""
        record = self._record(mod_id)
        old = record["seen"]
        record["seen"] = True
        try:
            self._save()
        except OSError:
            record["seen"] = old
            raise

    @_serialized
    def favorites(self) -> set[str]:
        """Return a snapshot of the favorite variant keys."""
        return set(self._favorites)

    @_serialized
    def set_favorite(self, variant_key: str, on: bool) -> None:
        """Set a variant's favorite flag."""
        self._variant(variant_key)
        old = set(self._favorites)
        if on:
            self._favorites.add(variant_key)
        else:
            self._favorites.discard(variant_key)
        try:
            self._save()
        except OSError:
            self._favorites = old
            raise

    def _resource_dirs(self) -> list[Path]:
        return [Path(directory).resolve() for directory in self.settings.resource_dirs()]

    def _scan(self) -> dict[str, list[Path]]:
        directories = self._resource_dirs()
        signature = tuple((str(d), d.stat().st_mtime_ns) for d in directories)
        if signature != self._index_signature:
            index: dict[str, list[Path]] = {}
            for directory in directories:
                with os.scandir(directory) as entries:
                    for entry in entries:
                        if entry.name.endswith(".bundle") and entry.is_file(follow_symlinks=False):
                            parsed = parse_filename(entry.name)
                            index.setdefault(parsed.core.lower(), []).append(Path(entry.path))
            self._index = {key: sorted(paths) for key, paths in index.items()}
            self._index_signature = signature
        return self._index

    def _game_files(self, key: str, kind: Kind | None = None) -> list[Path]:
        variant = self._variant(key)
        index = self._scan()
        return [path for current, value in (("spr", variant.spr), ("lobby", variant.lobby))
                if value and (kind is None or current == kind) for path in index.get(value.lower(), [])]

    def _is_official(self, path: Path) -> bool:
        parsed = parse_filename(path.name)
        fingerprint = self._hashes.get(path)
        return fingerprint.trailing == 0 and bool(parsed.crc) and fingerprint.crc == int(parsed.crc)

    def _original_path(self, game_file: Path) -> Path:
        return self.root / "originals" / game_file.name

    def _official_for(self, game_file: Path) -> Path:
        check_resource_path(game_file, self._resource_dirs())
        original = self._original_path(game_file)
        if original.exists():
            if not self._is_official(original):
                raise ServiceError("original_invalid", file=original)
            return original
        if not self._is_official(game_file):
            raise ServiceError("original_unavailable", file=game_file)
        return game_file

    def _keep_original(self, game_file: Path) -> None:
        official = self._official_for(game_file)
        original = self._original_path(game_file)
        if official != original:
            atomic_copy(official, original)
            if not self._is_official(original):
                original.unlink()
                raise ServiceError("original_invalid", file=game_file)

    @_serialized
    def state(self, variant_key: str) -> VariantState:
        """Inspect all game parts using headers and cached hashes, without UnityPy."""
        files = []
        for path in self._game_files(variant_key):
            parsed = parse_filename(path.name)
            fingerprint = self._hashes.get(path)
            official = self._is_official(path)
            record = self._applied.get(str(path.resolve()), {})
            applied = "official" if official else (
                record["source"] if record.get("sha1") == fingerprint.sha1 else "unknown")
            crc = "ok" if official else "fixed" if (
                fingerprint.trailing is not None and fingerprint.trailing > 0
                and parsed.crc and fingerprint.crc == int(parsed.crc)) else "needs_fix"
            original = self._original_path(path)
            files.append(GameFileState(path, parsed.core, "spr" if parsed.core.lower().endswith("_spr") else "lobby",
                                       applied, crc, original.exists() and self._is_official(original),
                                       parsed.date, fingerprint.size))
        sources = {file.applied for file in files}
        crc = "needs_fix" if any(f.crc == "needs_fix" for f in files) else (
            "fixed" if any(f.crc == "fixed" for f in files) else "ok")
        return VariantState(variant_key, files, sources.pop() if len(sources) == 1 else "unknown",
                            crc, any(f.original for f in files))

    def _plan(self, record: dict[str, Any], log: LogFunc) -> list[mod_install.ModGroup]:
        groups = mod_install.plan_mod_install(self._paths(record), self._resource_dirs(), log)
        if not groups or any(file.action not in (mod_install.InstallAction.DIRECT_REPLACE,
                                                 mod_install.InstallAction.UPDATE)
                             for group in groups for file in group.files):
            raise ServiceError("game_file_not_found", variant=record["target"])
        return groups

    @staticmethod
    def _plan_targets(groups: list[mod_install.ModGroup]) -> list[Path]:
        return sorted({path for group in groups for path in (
            group.target_paths + [file.existing_path for file in group.files if file.existing_path is not None])})

    def _stage_official(self, paths: list[Path], directory: Path) -> dict[Path, Path]:
        staged = {}
        directory.mkdir(parents=True, exist_ok=True)
        for path in paths:
            target = directory / path.name
            if target in staged.values():
                raise ServiceError("game_file_conflict", file=path)
            atomic_copy(self._official_for(path), target)
            staged[path] = target
        return staged

    def _commit(self, replacements: dict[Path, Path], source: str, log: LogFunc,
                progress: ProgressCallback | None = None) -> list[Path]:
        for target, prepared in replacements.items():
            check_resource_path(target, self._resource_dirs())
            if self._hashes.get(prepared).trailing is None:
                raise ServiceError("bundle_invalid", file=prepared)
        changed = {target: prepared for target, prepared in replacements.items()
                   if self._hashes.get(target).sha1 != self._hashes.get(prepared).sha1}
        old_applied = dict(self._applied)
        records = {str(target.resolve()): {"source": source, "sha1": self._hashes.get(prepared).sha1}
                   for target, prepared in replacements.items()}
        if not changed:
            if any(self._applied.get(path) != record for path, record in records.items()):
                self._applied.update(records)
                try:
                    self._save()
                except OSError:
                    self._applied = old_applied
                    raise
            return []
        written = []
        with writable_game_files(list(changed), self._resource_dirs()), tempfile.TemporaryDirectory() as temporary:
            rollback = {}
            for i, target in enumerate(changed):
                self._keep_original(target)
                backup = Path(temporary) / str(i)
                shutil.copyfile(target, backup)
                rollback[target] = backup
            saving_state = False
            try:
                for i, (target, prepared) in enumerate(changed.items(), 1):
                    check_resource_path(target, self._resource_dirs())
                    atomic_copy(prepared, target)
                    written.append(target)
                    log(f"Installed {target.name}")
                    if progress:
                        progress(i, len(changed), target.name)
                saving_state = True
                self._applied.update(records)
                self._save()
            except Exception as error:
                self._applied = old_applied
                for target in reversed(written):
                    try:
                        atomic_copy(rollback[target], target)
                    except OSError:
                        logger.exception("Could not roll back game file %s", target)
                if isinstance(error, OSError):
                    code = "library_io_error" if saving_state else "game_file_locked"
                    raise ServiceError(code, file=error.filename) from error
                raise
        return written

    @_serialized
    def apply(self, variant_key: str, source: str, log: LogFunc = no_log,
              progress: ProgressCallback | None = None) -> ApplyResult:
        """Install a stored mod, another official variant, or the kept originals."""
        self._variant(variant_key)
        if source == "official":
            return self.restore(variant_key, log)
        with tempfile.TemporaryDirectory(prefix="bamt-library-") as temporary:
            work = Path(temporary)
            if source.startswith("mod:"):
                record = self._record(source[4:])
                if record["target"] != variant_key:
                    raise ServiceError("mod_target_mismatch", id=record["id"], variant=variant_key)
                groups = self._plan(record, log)
                targets = self._plan_targets(groups)
                allowed = set(self._game_files(variant_key, record["kind"]))
                if any(path not in allowed for path in targets):
                    raise ServiceError("game_file_outside_resources", file=next(p for p in targets if p not in allowed))
                staged = self._stage_official(targets, work / "targets")
                # Execute only against temporary copies. The classic installer may
                # copy directly or rebuild; all real game writes go through _commit.
                staged_groups = [replace(group, files=[replace(file,
                    existing_path=staged.get(file.existing_path),
                    need_crc_fix=self.settings.crc_needed(file.existing_path)
                    if file.existing_path else False) for file in group.files],
                    target_paths=[staged[path] for path in group.target_paths]) for group in groups]
                result = mod_install.execute_mod_install(
                    staged_groups, work / "output", self.settings.asset_types(),
                    self.settings.save_options(self.settings.crc_needed(targets[0])),
                    self.settings.spine_options(), anim_check=self.settings.anim_check_options(),
                    create_backup=False, log=log, progress_callback=progress)
                if result.failed_groups:
                    raise ServiceError("mod_apply_failed", id=record["id"])
                replacements = staged
            elif source.startswith("variant:"):
                other = source[8:]
                self._variant(other)
                replacements = {}
                for kind in ("spr", "lobby"):
                    targets = self._game_files(variant_key, kind)
                    sources = self._game_files(other, kind)
                    if not targets or not sources:
                        continue
                    staged = self._stage_official(targets, work / kind / "targets")
                    output = work / kind / "output"
                    output.mkdir(parents=True)
                    adapted = adapt_variant_sources(
                        [self._official_for(path) for path in sources], list(staged.values()),
                        work / kind / "sources", self.settings.asset_types(), log)
                    result = core.process_mod_update(
                        adapted, list(staged.values()), output,
                        self.settings.asset_types(), self.settings.save_options(self.settings.crc_needed(targets[0])),
                        self.settings.spine_options(), skip_unchanged=True, match_strategy="name_type",
                        anim_check=self.settings.anim_check_options(), log=log)
                    if not result.success:
                        raise ServiceError("mod_apply_failed", variant=variant_key)
                    reverse = {value: key for key, value in staged.items()}
                    replacements.update(staged)
                    for pair in result.file_pairs:
                        replacements[reverse[pair.source]] = pair.output
                if not replacements:
                    raise ServiceError("game_file_not_found", variant=variant_key)
            else:
                raise ServiceError("source_unsupported", source=source)
            files = self._commit(replacements, source, log, progress)
            return ApplyResult(variant_key, source, files, unchanged=not files)

    @_serialized
    def restore(self, variant_key: str, log: LogFunc = no_log) -> ApplyResult:
        """Restore every available part to its verified official bytes."""
        targets = self._game_files(variant_key)
        if not targets:
            raise ServiceError("game_file_not_found", variant=variant_key)
        replacements = {path: self._official_for(path) for path in targets}
        files = self._commit(replacements, "official", log)
        return ApplyResult(variant_key, "official", files, unchanged=not files)

    @_serialized
    def update(self, mod_id: str, log: LogFunc = no_log,
               progress: ProgressCallback | None = None) -> UpdateResult:
        """Rebuild a mod against current official bundles and retain its old files."""
        record = self._record(mod_id)
        paths = self._paths(record)
        targets = self._plan_targets(self._plan(record, log))
        with tempfile.TemporaryDirectory(prefix="bamt-library-update-") as temporary:
            output = Path(temporary)
            generated = []
            all_unchanged = True
            for i, target in enumerate(targets, 1):
                if progress:
                    progress(i, len(targets), target.name)
                result = core.process_mod_update(
                    paths, [self._official_for(target)], output, self.settings.asset_types(),
                    self.settings.save_options(self.settings.crc_needed(target)), self.settings.spine_options(),
                    skip_unchanged=True, match_strategy="cont_name_type",
                    anim_check=self.settings.anim_check_options(), log=log)
                if not result.success:
                    raise ServiceError("mod_update_failed", id=mod_id)
                if result.message != "all_targets_unchanged":
                    all_unchanged = False
                generated.extend(pair.output for pair in result.file_pairs)
            if all_unchanged or (len(generated) == len(paths) and all(
                    new.name == old.name and self._hashes.get(new).sha1 == self._hashes.get(old).sha1
                    for new, old in zip(sorted(generated), sorted(paths)))):
                return UpdateResult(self._entry(record), paths, [], unchanged=True)
            # Include unchanged parts when a rebuild splits a mod across bundles.
            names = {path.name for path in generated}
            for target in targets:
                if target.name not in names:
                    atomic_copy(self._official_for(target), output / target.name)
                    generated.append(output / target.name)
            directory = paths[0].parent
            previous_dir = directory / "previous" / uuid.uuid4().hex
            previous = []
            for path in paths:
                backup = previous_dir / path.name
                atomic_copy(path, backup)
                previous.append(backup)
            old_record = dict(record)
            try:
                for path in generated:
                    atomic_copy(path, directory / path.name)
                record["files"] = [path.name for path in sorted(generated)]
                self._save()
            except OSError:
                record.update(old_record)
                for path in previous:
                    atomic_copy(path, directory / path.name)
                for path in generated:
                    if path.name not in old_record["files"]:
                        (directory / path.name).unlink(missing_ok=True)
                raise
            for path in paths:
                if path.name not in record["files"]:
                    path.unlink()
            return UpdateResult(self._entry(record), self._paths(record), previous)

    @_serialized
    def extract(self, target: str, out_dir: Path, log: LogFunc = no_log) -> Path:
        """Extract game or mod bundles into a folder named after their core."""
        if target.startswith("mod:"):
            paths = self._paths(self._record(target[4:]))
        elif target.startswith("variant:"):
            paths = self._game_files(target[8:])
        else:
            raise ServiceError("source_unsupported", source=target)
        if not paths:
            raise ServiceError("game_file_not_found", target=target)
        folder = Path(out_dir).resolve() / parse_filename(paths[0].name).core
        folder.mkdir(parents=True, exist_ok=True)
        success, _ = core.process_asset_extraction(paths, folder, spine_options=self.settings.spine_options(False), log=log)
        if not success:
            raise ServiceError("asset_extraction_failed", target=target)
        return folder

    def _asset_hashes(self, paths: list[Path]) -> dict[tuple[str, str, int], tuple[str, int]]:
        assets = {}
        counts: dict[tuple[str, str], int] = {}
        types = {AssetType.Texture2D, AssetType.TextAsset, AssetType.Mesh, AssetType.AnimationClip}
        for path in paths:
            bundle = Bundle.load(path)
            if bundle is None:
                raise ServiceError("bundle_invalid", file=path)
            for obj in bundle.env.objects:
                if obj.type not in types:
                    continue
                name = obj.peek_name() or ""
                key = (name, obj.type.name)
                occurrence = counts.get(key, 0)
                counts[key] = occurrence + 1
                raw = obj.get_raw_data()
                digest = hashlib.sha1(raw)
                size = len(raw)
                # Streamed textures and meshes may change without any change to
                # their serialized object; include the referenced payload too.
                data = obj.read()
                stream = getattr(data, "m_StreamData", None)
                if stream and stream.path and stream.size:
                    payload = get_resource_data(stream.path, obj.assets_file, stream.offset, stream.size)
                    digest.update(payload)
                    size += len(payload)
                assets[(*key, occurrence)] = (digest.hexdigest(), size)
        return assets

    @_serialized
    def compare(self, mod_id: str) -> CompareResult:
        """Hash raw assets against the current official files, even when a mod is installed."""
        record = self._record(mod_id)
        targets = self._plan_targets(self._plan(record, no_log))
        try:
            mod = self._asset_hashes(self._paths(record))
            official = self._asset_hashes([self._official_for(path) for path in targets])
        except (ValueError, EOFError) as error:
            raise ServiceError("bundle_invalid", id=mod_id) from error
        differences = []
        for key in sorted(mod.keys() | official.keys()):
            left, right = mod.get(key), official.get(key)
            status = "removed" if left is None else "added" if right is None else (
                "same" if left[0] == right[0] else "changed")
            differences.append(AssetDifference(key[0], key[1], status, left[1] if left else None,
                                               right[1] if right else None))
        return CompareResult(mod_id, differences)
