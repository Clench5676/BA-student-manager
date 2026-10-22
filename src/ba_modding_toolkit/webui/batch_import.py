"""Batch import preflight and execution, built on the library and classic updater."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import shutil
import threading
from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .. import atlas_remap, core, devmode, mod_origin
from ..bundle import Bundle, UpdateScope
from ..errors import ServiceError
from ..gameassets.spine import spine_revision
from ..i18n import t
from ..library import integrity, staging
from ..library.judge import core_of, kind_of, part_of
from ..library.storage import Fingerprints
from ..models import AssetType, SaveOptions
from ..naming import parse_filename
from ..searching import _asset_match
from ..spine import get_skel_version
from ..utils import CRCUtils, no_log, parse_hex_bytes

logger = logging.getLogger(__name__)
PREF = "batch_import"
TYPES = ("Texture2D", "TextAsset", "Mesh", "AnimationClip", "ALL")
CHOICES = {"strategy": ("path_id", "cont_name_type", "name_type"),
           "crc": ("auto", "on", "off"), "compression": ("lzma", "lz4", "original", "none")}
BOOLS = ("skipUnchanged", "backup", "enableAfterImport")


def options_of(value: Any, defaults: dict) -> dict:
    """Validate complete RPC options (and merge older saved preferences with new defaults)."""
    if not isinstance(value, dict) or set(value) - set(defaults):
        raise ServiceError("bad_params", key="options")
    out = {**defaults, **value}
    for key, choices in CHOICES.items():
        if not isinstance(out[key], str) or out[key] not in choices:
            raise ServiceError("bad_params", key=key)
    if any(not isinstance(out[key], bool) for key in BOOLS):
        raise ServiceError("bad_params", key="options")
    if not isinstance(out["types"], list) or not out["types"] or any(
            not isinstance(item, str) or item not in TYPES for item in out["types"]):
        raise ServiceError("bad_params", key="types")
    out["types"] = list(dict.fromkeys(out["types"]))
    if not isinstance(out["workers"], int) or isinstance(out["workers"], bool) or not 1 <= out["workers"] <= 64:
        raise ServiceError("bad_params", key="workers")
    if not isinstance(out["extraBytes"], str) or (out["extraBytes"] and parse_hex_bytes(out["extraBytes"]) is None):
        raise ServiceError("bad_params", key="extraBytes")
    if out["output"] is not None and (not isinstance(out["output"], str) or not out["output"].strip()):
        raise ServiceError("bad_params", key="output")
    if out["output"] is not None:
        out["output"] = str(Path(out["output"]).expanduser().resolve())
        devmode.check_read(Path(out["output"]))
    return out


class ImportSettings:
    """A read-only overlay; the classic config and the library's shared settings stay intact."""

    def __init__(self, base: Any, options: dict):
        self.base, self.options = base, options

    def __getattr__(self, name: str) -> Any:
        return getattr(self.base, name)

    def asset_types(self) -> set[str]:
        return set(self.options["types"])

    def crc_needed(self, target: Path | None) -> bool:
        setting = self.options["crc"]
        return setting == "on" or (setting == "auto" and target is not None and Bundle.check_need_crc(target))

    def save_options(self, perform_crc: bool) -> SaveOptions:
        return SaveOptions(perform_crc=perform_crc, compression=self.options["compression"],
                           extra_bytes=parse_hex_bytes(self.options["extraBytes"]))


@dataclass
class Candidate:
    files: dict[str, Path]
    entry: dict
    error: str | None = None
    identity: frozenset = frozenset()
    targets: list[Path] = field(default_factory=list)
    originals: list[Path] = field(default_factory=list)
    spine_version: str | None = None
    source_override: dict | None = None
    conversion: bool = False
    not_transferred: list[str] = field(default_factory=list)
    failure: dict | None = None
    direct: dict[Path, Path] = field(default_factory=dict)


@dataclass
class ImportResult:
    results: list[dict]
    cores: set[str] = field(default_factory=set)
    kinds: set[str] = field(default_factory=set)
    added: list[Any] = field(default_factory=list)
    mods_changed: bool = True

    def to_json(self) -> dict:
        return {"results": self.results}


def blocked_reason(error: ServiceError) -> str:
    aliases = {"bundle_invalid": "unreadable", "game_file_not_found": "no_target",
               "mod_unsupported": "unsupported", "source_unsupported": "unsupported"}
    reasons = {"mod_platform_unknown", "library_io_error", "mod_target_ambiguous", "mod_target_unknown",
               "mod_parts_missing", "game_file_conflict", "mod_platform_mismatch", "mod_unity_version_mismatch",
               "required_asset_extract_failed", "required_asset_apply_failed", "required_assets_unmatched",
               "spine_version", "source_unknown", "source_conflict", "platform_unsupported", "target_unknown",
               "conversion_names", "no_matching_assets", "conversion_failed", "entry_changed",
               "original_unavailable", "original_invalid", "conflict", "unreadable", "unsupported", "failed"}
    return aliases.get(error.code, error.code if error.code in reasons else "failed")


def failure_detail(error: ServiceError, paths: Any, log: Any = no_log) -> dict:
    detail = error.to_json()
    message = f"Batch import: {', '.join(map(str, paths))}: {json.dumps(detail, ensure_ascii=False, sort_keys=True)}"
    logger.warning(message)
    log(message)
    return detail


def copy_compatibility(report: dict, uploaded: integrity.Contents) -> tuple[dict, dict, bool]:
    """A direct copy installs every uploaded asset alongside the retained official parts."""
    skeletons = report.get("official", {}).get("skeletons", {})
    incoming = {name: get_skel_version(data) for name, data in uploaded.skeletons.items()}
    versions = {data["version"] for data in skeletons.values()} or {None}
    official = {name: {skeletons[name]["version"]} if name in skeletons else versions for name in incoming}
    return official, incoming, report.get("remappable", False)


def transfer_compatibility(inspection: integrity.Inspection, sources: list[Path], targets: list[Path],
                           originals: list[Path], strategy: str) -> tuple[dict, dict, bool]:
    """Check transferred Spine inputs against their counterparts and retained official parts."""
    scope = UpdateScope([inspection.bundle(path) for path in targets], strategy, inspection.asset_types)
    key_of = Bundle._get_key_func(strategy)
    incoming, official = {}, {}
    atlases, textures, transferred_atlases, transferred_textures = {}, {}, set(), {}
    for path in originals:
        contents = inspection.inspect(path)
        atlases.update(contents.atlases)
        textures.update(contents.textures)
    for path in sources:
        contents = inspection.inspect(path, allow_unknown=True)
        for obj in inspection.bundle(path).env.objects:
            if obj.type not in (AssetType.TextAsset, AssetType.Texture2D):
                continue
            if "ALL" not in inspection.asset_types and obj.type.name not in inspection.asset_types:
                continue
            key = key_of(obj)
            if key not in scope.counterparts:
                continue
            name = obj.peek_name()
            for target, counterpart in scope.counterparts[key]:
                target_name = counterpart.peek_name()
                if obj.type == AssetType.TextAsset and name in contents.skeletons:
                    incoming[key] = get_skel_version(contents.skeletons[name])
                    data = inspection.inspect(target.path).skeletons.get(target_name)
                    official.setdefault(key, set()).add(get_skel_version(data) if data is not None else None)
                elif obj.type == AssetType.TextAsset and name in contents.atlases:
                    transferred_atlases.add(target_name)
                elif obj.type == AssetType.Texture2D:
                    size = contents.textures.get(integrity.texture_key(name))
                    if size is not None:
                        transferred_textures[integrity.texture_key(target_name)] = size
    try:
        mixed = {name: data for name, data in atlases.items() if name not in transferred_atlases
                 and any(integrity.texture_key(page) in transferred_textures
                         for page in atlas_remap.parse_atlas(data, name).pages)}
        remappable = bool(mixed) and atlas_remap.page_size_mismatch(mixed, {**textures, **transferred_textures})
    except (ValueError, UnicodeError):
        remappable = False
    inspection.validate()
    return official, incoming, remappable


class BatchImport:
    def __init__(self, services: Any):
        self.services = services
        self._lock = threading.RLock()
        self._revision = 0
        self._latest: dict[str, Candidate] = {}
        self._previews: dict[str, tuple[Candidate, str]] = {}
        self._library: Any = None
        self._pin: Any = None
        self._hashes = Fingerprints()
        self._sources: dict[str, tuple[frozenset, dict]] = {}
        self._completed: dict[tuple, str] = {}

    def defaults(self) -> dict:
        settings = self.services.settings
        return {"strategy": "cont_name_type", "types": sorted(settings.asset_types()) or ["ALL"],
                "skipUnchanged": settings.get("skip_unchanged"),
                "crc": {"true": "on", "false": "off"}.get(settings.get("enable_crc_correction"), "auto"),
                "compression": settings.get("compression_method"), "extraBytes": settings.get("extra_bytes"),
                "backup": settings.get("create_backup"), "workers": settings.get("max_workers"),
                "output": settings.get("output_dir") or None, "enableAfterImport": True}

    def options(self) -> dict:
        defaults = self.defaults()
        try:
            return options_of(self.services.state.get(PREF, {}), defaults)
        except ServiceError:
            return options_of({}, defaults)

    def set_options(self, value: dict) -> dict:
        options = options_of(value, self.defaults())
        self.services.state.set(PREF, options)
        return options

    def pick(self, folder: bool = False, recursive: bool = False) -> dict:
        if not isinstance(folder, bool) or not isinstance(recursive, bool):
            raise ServiceError("bad_params", key="folder")
        if self.services.window is None:
            raise ServiceError("native_unavailable")
        from .native import pick_files, pick_folder

        paths = pick_folder(self.services.window) if folder else pick_files(
            self.services.window, ("Bundle (*.bundle;*.bundle.backup)",))
        return {"paths": [str(path) for path in paths]}

    def analyze(self, paths: list[str], recursive: bool = False) -> str:
        if not isinstance(paths, list) or not all(isinstance(p, str) and p for p in paths):
            raise ServiceError("bad_params", key="paths")
        if not isinstance(recursive, bool):
            raise ServiceError("bad_params", key="recursive")
        for path in paths:
            devmode.check_read(Path(path))
        library = self.services.library
        pin = library.current_pin()
        with self._lock:
            self._revision += 1
            revision = self._revision
            self._latest = {}
            self._previews = {}
            self._library, self._pin = library, pin

        def analyze(log: Any, progress: Any) -> dict:
            candidates, skipped = self._collect(paths, recursive, library)
            entries, known, previews = [], set(), {}
            for i, candidate in enumerate(candidates):
                with self._lock:
                    override = self._sources.get(candidate.entry["id"])
                if override and override[0] == candidate.identity:
                    candidate.source_override = dict(override[1])
                self._judge(candidate, library, pin, log)
                self._restore_completed(candidate, library, pin)
                if candidate.identity and candidate.identity in known:
                    skipped += len(candidate.entry["paths"])
                    continue
                if candidate.identity:
                    known.add(candidate.identity)
                self._register_preview(candidate, revision, previews)
                entries.append(candidate)
                progress(i + 1, len(candidates), candidate.entry["core"] or "")
            with self._lock:
                if revision == self._revision:
                    self._latest = {c.entry["id"]: c for c in entries}
                    self._previews = previews
            return {"entries": [c.entry for c in entries], "skipped": skipped}

        return self.services.submit("import.analyze", analyze)

    def _register_preview(self, candidate: Candidate, revision: int, previews: dict) -> None:
        if candidate.entry["core"] and candidate.entry["kind"] in ("spr", "lobby", "model"):
            try:
                stamp = spine_revision(list(candidate.files.values()))
                key = hashlib.sha256(f"{revision}:{candidate.entry['id']}:{stamp}".encode()).hexdigest()
                previews[key] = (candidate, stamp)
                candidate.entry["preview"] = {"kind": "import", "key": key}
            except (OSError, KeyError):
                pass  # An unavailable source keeps its static catalog artwork.

    def set_source(self, id: str, server: str, platform: str) -> str:
        if not isinstance(id, str) or server not in mod_origin.SERVERS or platform not in mod_origin.PLATFORMS:
            raise ServiceError("bad_params", key="source")
        with self._lock:
            if id not in self._latest:
                raise ServiceError("bad_params", key="id")
            candidate = self._latest[id]
            fresh = Candidate(dict(candidate.files), deepcopy(candidate.entry), candidate.error,
                              identity=candidate.identity, failure=candidate.failure,
                              source_override={"server": server, "platform": platform, "detected": False})
            library, pin, revision = self._library, self._pin, self._revision

        def analyze(log: Any, progress: Any) -> dict:
            if self.services.library is not library:
                raise ServiceError("folder_changed")
            if pin:
                self.services._check_pin(library, pin)
            identity = frozenset((core_of(name), self._hashes.get(path).sha1) for name, path in fresh.files.items())
            if identity != fresh.identity:
                raise ServiceError("entry_changed")
            self._judge(fresh, library, pin, log)
            self._restore_completed(fresh, library, pin)
            previews = {}
            self._register_preview(fresh, revision, previews)
            with self._lock:
                if revision != self._revision or self._latest.get(id) is not candidate:
                    raise ServiceError("entry_changed")
                self._latest[id] = fresh
                self._sources[id] = (identity, dict(fresh.source_override))
                self._previews.update(previews)
            progress(1, 1, fresh.entry["core"] or "")
            return fresh.entry

        return self.services.submit("import.setSource", analyze)

    def _completion_key(self, candidate: Candidate, library: Any, pin: Any) -> tuple:
        return (library, pin.key if pin else None, tuple(pin.dirs) if pin else (),
                candidate.entry["id"], candidate.identity)

    def _restore_completed(self, candidate: Candidate, library: Any, pin: Any) -> None:
        with self._lock:
            mod_id = self._completed.get(self._completion_key(candidate, library, pin))
        if mod_id and any(mod.id == mod_id for mod in library.mods()):
            candidate.entry.update(state="done", reason=None, libraryId=mod_id)

    def _complete(self, candidate: Candidate, library: Any, pin: Any, mod_id: str) -> None:
        with self._lock:
            self._completed[self._completion_key(candidate, library, pin)] = mod_id
            candidate.entry.update(state="done", reason=None, libraryId=mod_id)

    def preview(self, key: str) -> tuple[str, list[Path]]:
        """Compose an analyzed source in memory, with missing parts from the pinned official files."""
        with self._lock:
            candidate, stamp = self._previews[key]
            library, pin = self._library, self._pin
        if self.services.library is not library:
            raise KeyError(key)
        if pin:
            self.services._check_pin(library, pin)
        paths = list(candidate.files.values())
        if spine_revision(paths) != stamp:
            raise KeyError(key)
        core_name = candidate.entry["core"]
        try:
            originals = library.official_bundles(core_name, pin=pin) if pin else []
        except ServiceError as error:
            if error.code not in ("game_file_not_found", "original_unavailable", "original_invalid"):
                raise
            originals = []  # A self-contained upload can preview without recoverable official parts.
        replaced = {part_of(name) for name in candidate.files}
        bundles = [path for path in originals if part_of(path.name) not in replaced] + paths
        with self._lock:
            if key not in self._previews:
                raise KeyError(key)
        return core_name, bundles

    def _collect(self, paths: list[str], recursive: bool, library: Any) -> tuple[list[Candidate], int]:
        selected, seen, skipped = [], set(), 0

        def take(path: Path) -> None:
            nonlocal skipped
            path = path.expanduser().resolve()
            devmode.check_read(path)
            if path in seen or not path.name.endswith((".bundle", ".bundle.backup")):
                skipped += 1
            else:
                seen.add(path)
                selected.append(path)

        for value in paths:
            path = Path(value).expanduser().resolve()
            if path.is_dir():
                if recursive:
                    def failed(error: OSError) -> None:
                        raise ServiceError("library_io_error", file=error.filename)

                    for folder, directories, files in os.walk(path, followlinks=False, onerror=failed):
                        devmode.check_read(Path(folder))
                        directories.sort()
                        for name in sorted(files):
                            take(Path(folder) / name)
                else:
                    for child in sorted(path.iterdir()):
                        if not child.is_dir():
                            take(child)
            else:
                take(path)
        groups: dict[tuple, list[tuple]] = {}
        for path in selected:
            name = path.name.removesuffix(".backup")
            parsed = parse_filename(name)
            kind = kind_of(parsed.core, parsed.category) or "other"
            variant, error, failure = None, None, None
            try:
                if self._hashes.get(path).trailing is None:
                    raise ServiceError("bundle_invalid")
                if not library.supports_kind(kind):
                    error = "unsupported"
                    failure = ServiceError("mod_unsupported", file=path, kind=kind).to_json()
                    resolve = getattr(library.catalog, "variant_for_asset_core", library.catalog.variant_for_core)
                    found = resolve(parsed.core.lower())
                    variant = found.key if found else None
                else:
                    name, variant, kind = library.identify_import(path, name)
            except OSError as caught:
                error = "library_io_error"
                failure = ServiceError("library_io_error", file=path, error=str(caught)).to_json()
            except ServiceError as caught:
                error = blocked_reason(caught)
                failure = caught.to_json()
            except Exception as caught:
                logger.debug("Cannot inspect uploaded bundle: %s", path, exc_info=True)
                error = "unreadable"
                failure = ServiceError("bundle_invalid", file=path, error=str(caught)).to_json()
            parsed = parse_filename(name)
            # Date separates versions; folders separate alternative mods of the same release.
            key = (path.parent, "", "", kind, None) if kind == "other" else (
                path.parent, parsed.core.lower(), parsed.date, kind, variant)
            groups.setdefault(key, []).append((path, name, error, failure))
        candidates = []
        for (_, core_name, _, kind, variant), items in groups.items():
            files, parts, sources, error, failure = {}, {}, [], None, None
            for path, name, problem, detail in items:
                error = error or problem
                failure = failure or detail
                try:
                    if name in files:
                        if self._hashes.get(files[name]).sha1 == self._hashes.get(path).sha1:
                            skipped += 1
                            continue
                        error = "conflict"
                    part = part_of(name)
                    if part in parts and self._hashes.get(parts[part]).sha1 != self._hashes.get(path).sha1:
                        error = "conflict"
                    parts[part] = path
                except OSError:
                    error = "unreadable"
                files[name] = path
                sources.append(path)
            sources.sort()
            file_list = []
            for path in sources:
                try:
                    size = path.stat().st_size
                except OSError:
                    size, error = 0, "unreadable"
                file_list.append({"path": str(path), "size": size, "target": None})
            entry = {"id": hashlib.sha256("\0".join(map(str, sources)).encode()).hexdigest(),
                     "paths": list(map(str, sources)), "variant": variant, "core": core_name or None,
                     "kind": kind, "files": file_list, "size": sum(f["size"] for f in file_list),
                     "state": "blocked", "reason": error, "libraryId": None, "preview": None,
                     "source": None, "target": mod_origin.target_of(self.services.settings, library.current_pin())}
            candidate = Candidate(files, entry, error, failure=failure)
            try:
                candidate.identity = frozenset((core_of(name), self._hashes.get(path).sha1) for name, path in files.items())
            except OSError:
                pass  # The unreadable row above still reports all of its source paths.
            candidates.append(candidate)
        return candidates, skipped

    def _judge(self, candidate: Candidate, library: Any, pin: Any, log: Any = no_log,
               *, asset_types: set[str] | None = None, strategy: str | None = None) -> None:
        entry = candidate.entry
        entry.pop("params", None)
        entry.pop("error", None)
        entry.update(state="blocked", reason=candidate.error, libraryId=None, source=None,
                     target=mod_origin.target_of(self.services.settings, pin))
        candidate.targets, candidate.originals, candidate.spine_version, candidate.conversion = [], [], None, False
        candidate.direct = {}
        inspection = integrity.Inspection(asset_types if asset_types is not None else set(self.options()["types"]))
        try:
            if candidate.failure:
                raise ServiceError(candidate.failure["code"], **candidate.failure["params"])
            if candidate.error:
                raise ServiceError(candidate.error)
            for path in candidate.files.values():
                inspection.check(path)
            report = library.inspect_import(candidate.files, pin=pin, conversion=True, inspection=inspection)
            if report.get("recognized"):
                entry.update(state="library" if report["libraryId"] else "installed", reason=None,
                             libraryId=report["libraryId"])
                return
            if report.get("direct"):
                candidate.identity = report["identity"]
                candidate.direct = report["direct"]
                candidate.targets, candidate.originals = report["targets"], report["originals"]
                entry["target"] = mod_origin.target_of(self.services.settings, pin, report["officialContents"])
                entry["source"] = {**entry["target"], "detected": True}
                for file in entry["files"]:
                    file["target"] = next(target.name for target, source in candidate.direct.items()
                                          if str(source) == file["path"])
                entry.update(state="library" if report["libraryId"] else "installed" if report["installed"] else "ready",
                             reason=None, libraryId=report["libraryId"])
                return
            selected = integrity.Contents()
            for path in candidate.files.values():
                selected.merge(inspection.inspect(path, allow_unknown=True))
            names = {path.name.removesuffix(".backup") for path in candidate.files.values()}
            source, source_error = mod_origin.source_of(names, selected, integrity.Contents(), entry["target"])
            entry["source"] = candidate.source_override or source
            inspection.validate()
            candidate.identity = report["identity"]
            live = report["targets"]
            compatibility = report.get("compatibility") or {}
            official_contents = compatibility.get("officialContents", integrity.Contents())
            if not compatibility and pin and live:
                try:
                    for path in library.official_bundles(entry["core"], pin=pin):
                        official_contents.merge(inspection.inspect(path))
                except ServiceError:
                    pass  # Installed uploads can be recognized without a recoverable original.
            entry["target"] = mod_origin.target_of(self.services.settings, pin, official_contents)
            source, source_error = mod_origin.source_of(names, selected, official_contents, entry["target"])
            entry["source"] = candidate.source_override or source
            if source_error in ("source_conflict", "platform_unsupported"):
                raise ServiceError(source_error)
            evidence, _ = mod_origin.constraints(names, selected, official_contents, entry["target"])
            if candidate.source_override and any(value and candidate.source_override[key] != value
                                                  for key, value in evidence.items()):
                raise ServiceError("source_conflict")

            def conversion(source: dict) -> bool:
                return bool(any(source[key] != entry["target"][key] for key in ("server", "platform"))
                            or (official_contents.platforms and selected.platforms != official_contents.platforms)
                            or mod_origin.platform_of(selected) is None)

            if len({p.name for p in live}) != len(live):
                raise ServiceError("game_file_conflict")
            for file in entry["files"]:
                name = next((name for name, path in candidate.files.items() if str(path) == file["path"]), "")
                matches = [p for p in live if part_of(p.name) == part_of(name)]
                file["target"] = matches[0].name if len(matches) == 1 else None
            if entry["source"] is None or not conversion(entry["source"]):
                if report["libraryId"]:
                    entry.update(state="library", reason=None, libraryId=report["libraryId"])
                    return
                if report["installed"]:
                    entry.update(state="installed", reason=None)
                    return
            if not pin or not live:
                raise ServiceError("game_file_not_found")
            originals = report["originals"] if entry["kind"] == "other" else library.official_bundles(entry["core"], pin=pin)
            if not entry["target"]["platform"]:
                raise ServiceError("target_unknown")
            if len(live) != len(originals):
                raise ServiceError("game_file_conflict")
            baseline = dict(zip(live, originals))
            exact = set(candidate.files) <= {p.name for p in live}
            sources = list(candidate.files.values())
            if exact:
                targets = [p for p in live if p.name in candidate.files]
            elif entry["kind"] == "other":
                targets = live
            else:
                # A model's prefab and dependencies can have different release dates.
                latest = {}
                for path in live:
                    parsed = parse_filename(path.name)
                    latest[parsed.prefix] = max(latest.get(parsed.prefix, ""), parsed.date)
                matched, _ = _asset_match(sources, [baseline[p] for p in live if parse_filename(p.name).date ==
                                          latest[parse_filename(p.name).prefix]], log, keys=inspection.keys)
                targets = [p for p in live if baseline[p] in matched]
            inferred = entry["source"] is None
            choices = (mod_origin.candidates(names, selected, official_contents, entry["target"]) if inferred
                       else [entry["source"]])
            matched_targets, last_failure = None, None
            for choice in choices:
                converting = conversion(choice)
                failure = None
                chosen = targets
                if choice["server"] != entry["target"]["server"] and not all(
                        any(part_of(name) == part_of(path.name) for path in live) for name in names):
                    failure = "conversion_names"
                if not failure and (converting or inferred):
                    if matched_targets is None:
                        matches, _ = _asset_match(sources, [baseline[p] for p in targets], log, keys=inspection.keys)
                        matched_targets = [p for p in targets if baseline[p] in matches]
                    chosen = matched_targets
                if not chosen:
                    failure = failure or ("no_matching_assets" if converting or inferred else "game_file_not_found")
                mismatch = False
                if not failure and (selected.skeletons or compatibility.get("remappable")):
                    if exact and not converting:
                        # The ready path copies whole bundles, ignoring update filters and matching keys.
                        official, incoming, remappable = copy_compatibility(compatibility, selected)
                    else:
                        official, incoming, remappable = transfer_compatibility(inspection, sources,
                            [baseline[path] for path in chosen], originals,
                            "name_type" if converting else strategy or self.options()["strategy"])
                    versions = {version for values in official.values() for version in values if version}
                    series = {tuple(version.split(".")[:2]) for version in versions}
                    candidate.spine_version = (max(versions, key=lambda version: tuple(map(int, version.split("."))))
                                               if len(series) == 1 else None)
                    unknown = any(not version for version in incoming.values())
                    mismatch = any(version and any(not target or version.split(".")[:2] != target.split(".")[:2]
                                                   for target in official[key]) for key, version in incoming.items())
                    failure = "conflict" if remappable else "spine_version" if (
                        unknown or (mismatch and (candidate.spine_version is None or
                                                not self.services.settings.spine_options().is_valid()))) else None
                if failure:
                    if inferred:
                        last_failure = failure
                        continue
                    raise ServiceError(failure)
                if inferred or (candidate.source_override or {}).get("detected"):
                    # Validate selected inputs against current counterparts using the execution reader.
                    try:
                        counterparts = tuple(baseline[path] for path in chosen)
                        required = set().union(*(inspection.readable_keys(path, targets=counterparts) for path in sources))
                        available = set().union(*(inspection.keys(baseline[path]) for path in chosen))
                        if not required or not required <= available:
                            raise ServiceError("no_matching_assets")
                    except (ServiceError, OSError, ValueError):
                        inspection.validate()
                        raise
                if not converting:
                    library.inspect_import(candidate.files, pin=pin, inspection=inspection)
                inspection.validate()
                candidate.conversion = converting
                candidate.targets, candidate.originals = chosen, [baseline[p] for p in chosen]
                if inferred:
                    candidate.source_override = dict(choice)
                entry["source"] = choice
                for file in entry["files"]:
                    if file["target"] is None and len(chosen) == 1:
                        file["target"] = chosen[0].name
                entry.update(state="convert" if converting else "ready" if exact and not mismatch else "update", reason=None)
                return
            raise ServiceError(last_failure or "source_unknown")
        except ServiceError as error:
            entry.update(state="blocked", reason=blocked_reason(error),
                         error=failure_detail(error, candidate.files.values(), log))
            if error.params:
                entry["params"] = error.to_json()["params"]
        except (OSError, ValueError) as error:
            detail = ServiceError("bundle_invalid", error=str(error))
            entry.update(state="blocked", reason="unreadable",
                         error=failure_detail(detail, candidate.files.values(), log))

    def run(self, ids: list[str], options: dict) -> str:
        options = options_of(options, self.defaults())
        if not isinstance(ids, list) or not all(isinstance(i, str) for i in ids):
            raise ServiceError("bad_params", key="ids")
        with self._lock:
            if any(i not in self._latest for i in ids):
                raise ServiceError("bad_params", key="ids")
            chosen = [self._latest[i] for i in dict.fromkeys(ids)]
            library, pin = self._library, self._pin
        if library is None:
            raise ServiceError("bad_params", key="ids")
        if self.services.library is not library:
            raise ServiceError("folder_changed")
        settings = ImportSettings(self.services.settings, options)

        def run(log: Any, progress: Any) -> ImportResult:
            if pin:
                self.services._check_pin(library, pin)
            result = ImportResult([])
            total, completed = len(chosen), [0]
            progress_lock = threading.Lock()

            positions = {candidate.entry["id"]: index for index, candidate in enumerate(chosen, 1)}

            def report(candidate: Candidate, phase: str, step: str | None = None) -> None:
                with progress_lock:
                    progress({"done": completed[0], "total": total, "index": positions[candidate.entry["id"]],
                              "current": candidate.entry["id"], "phase": phase,
                              "step": "import.step." + (step or phase)})

            # Converted bundles are read back by add_files. Keep both target
            # copies and output in this library's allowed data, not system temp.
            with staging.import_directory(library.root) as temporary:
                with ThreadPoolExecutor(max_workers=options["workers"]) as workers:
                    futures = {}
                    for candidate in chosen:
                        if candidate.entry["state"] not in ("ready", "convert", "update"):
                            continue
                        # Recheck the actual inputs and current official files before launching parallel builds.
                        try:
                            current = frozenset((core_of(name), self._hashes.get(path).sha1)
                                                for name, path in candidate.files.items())
                            if current != candidate.identity:
                                raise ServiceError("entry_changed")
                            fresh = Candidate(dict(candidate.files), dict(candidate.entry),
                                              source_override=candidate.source_override)
                            fresh.entry["files"] = [dict(f) for f in candidate.entry["files"]]
                            report(candidate, "convert" if candidate.conversion else "update"
                                   if candidate.entry["state"] == "update" else "add", "check")
                            self._judge(fresh, library, pin, log, asset_types=settings.asset_types(),
                                        strategy=settings.options["strategy"])
                            futures[candidate.entry["id"]] = workers.submit(
                                self._prepare, fresh, settings, Path(temporary), log, report)
                        except (OSError, ServiceError) as error:
                            futures[candidate.entry["id"]] = error
                    for candidate in chosen:
                        item = {"id": candidate.entry["id"], "outcome": "skipped", "reason": None,
                                "libraryId": candidate.entry["libraryId"], "applied": False}
                        phase = "add"
                        try:
                            state = candidate.entry["state"]
                            if state in ("done", "library", "installed"):
                                item["outcome"] = "unchanged"
                            elif state == "blocked":
                                item["reason"] = candidate.entry["reason"]
                                if candidate.entry.get("error"):
                                    item["error"] = candidate.entry["error"]
                                if candidate.entry.get("params"):
                                    item["params"] = candidate.entry["params"]
                            else:
                                future = futures[candidate.entry["id"]]
                                if isinstance(future, Exception):
                                    raise future
                                paths, updated, fresh = future.result()
                                if fresh.not_transferred:
                                    item["notTransferred"] = fresh.not_transferred
                                    logger.warning("%s: %s", ", ".join(sorted(fresh.files)),
                                        t("webui.import.notTransferred", names=", ".join(fresh.not_transferred)))
                                if paths is None:
                                    item.update(outcome="unchanged", libraryId=fresh.entry["libraryId"])
                                    mod = next((mod for mod in library.mods() if mod.id == item["libraryId"]), None)
                                else:
                                    report(candidate, "add")
                                    added = library.add_files(fresh.entry["kind"], paths, pin=pin, direct=bool(fresh.direct))
                                    entries = [*added, *added.duplicates]
                                    if len(entries) != 1:
                                        raise ServiceError("mod_unsupported")
                                    mod = entries[0]
                                    item.update(libraryId=mod.id, outcome=("updated" if updated else "imported")
                                                if added else "unchanged")
                                    result.added.extend(added)
                                if mod is not None:
                                    result.cores.update(core_of(name) for name in fresh.files)
                                    result.kinds.add(mod.kind)
                                    if options["enableAfterImport"]:
                                        phase = "apply"
                                        report(candidate, phase)
                                        library.apply_import(mod.target, f"mod:{mod.id}", kind=mod.kind,
                                            pin=pin, settings=settings, backup=options["backup"], log=log)
                                        # A successful apply configures the source, including deferred applies.
                                        item["applied"] = True
                                    self._complete(candidate, library, pin, mod.id)
                        except ServiceError as error:
                            item.update(outcome="failed", reason=error.code,
                                        error=failure_detail(error, candidate.files.values(), log))
                            if error.params:
                                item["params"] = error.to_json()["params"]
                        except OSError as error:
                            detail = ServiceError("library_io_error", error=str(error))
                            item.update(outcome="failed", reason=detail.code, params=detail.params,
                                        error=failure_detail(detail, candidate.files.values(), log))
                        except Exception as error:
                            logger.exception("Batch import entry failed: %s", candidate.entry["id"])
                            detail = ServiceError("internal", error=str(error))
                            item.update(outcome="failed", reason=detail.code, params=detail.params,
                                        error=failure_detail(detail, candidate.files.values(), log))
                        result.results.append(item)
                        with progress_lock:
                            completed[0] += 1
                        report(candidate, phase)
            return result

        return self.services.submit("import.run", run, writes="game" if options["enableAfterImport"] else "library",
                                    library=library)

    def _prepare(self, candidate: Candidate, settings: ImportSettings, temporary: Path,
                 log: Any, progress: Any) -> tuple[list[Path] | None, bool, Candidate]:
        entry = candidate.entry
        if entry["state"] in ("library", "installed"):
            return None, False, candidate
        if entry["state"] == "blocked":
            detail = entry.get("error") or {"code": entry["reason"], "params": entry.get("params", {})}
            raise ServiceError(detail["code"], **detail["params"])
        if entry["state"] == "ready":
            if candidate.direct:
                output = temporary / entry["id"] / "direct"
                output.mkdir(parents=True)
                paths = []
                for (target, source), original in zip(candidate.direct.items(), candidate.originals):
                    path = output / target.name
                    data = source.read_bytes()
                    expected = int(parse_filename(target.name).crc)
                    fix = Bundle.check_need_crc(original) and CRCUtils.compute_crc32(data) != expected
                    if not fix and source.name.removesuffix(".backup") == target.name:
                        paths.append(source)
                        continue
                    if fix:
                        data = CRCUtils.apply_crc_fix(data, expected)
                        if data is None:
                            raise ServiceError("crc_fix_failed", file=source.name)
                    path.write_bytes(data)
                    paths.append(path)
                return paths, False, candidate
            return list(candidate.files.values()), False, candidate
        phase = "convert" if candidate.conversion else "update"
        progress(candidate, phase, "check")
        work = temporary / entry["id"]
        output, targets_dir = work / "output", work / "targets"
        output.mkdir(parents=True)
        targets_dir.mkdir()
        targets = []
        for live, original in zip(candidate.targets, candidate.originals):
            target = targets_dir / live.name
            shutil.copy2(original, target)
            targets.append(target)
        spine = settings.spine_options()
        if candidate.spine_version:
            spine = replace(spine, target_version=candidate.spine_version)
        groups = {}
        for target in targets:
            prefix = parse_filename(target.name).prefix if entry["kind"] == "other" else ""
            groups.setdefault(prefix, []).append(target)
        generated, unchanged = {}, True
        for prefix, group in groups.items():
            sources = [path for name, path in candidate.files.items()
                       if not prefix or parse_filename(name).prefix == prefix]
            updated = core.process_mod_update(source_paths=sources, target_paths=group,
                output_dir=output, asset_types_to_replace=settings.asset_types(),
                save_options=settings.save_options(settings.crc_needed(group[0])), spine_options=spine,
                skip_unchanged=settings.options["skipUnchanged"],
                match_strategy="name_type" if candidate.conversion else settings.options["strategy"],
                anim_check=settings.anim_check_options(), log=log,
                on_step=lambda step: progress(candidate, phase, step))
            if not updated.success:
                if updated.error:
                    raise updated.error
                raise ServiceError("conversion_failed" if candidate.conversion else "mod_update_failed")
            candidate.not_transferred = sorted(set(candidate.not_transferred) | set(updated.not_transferred))
            if updated.message != "all_targets_unchanged":
                if not updated.file_pairs:
                    raise ServiceError("mod_update_failed")
                unchanged = False
            generated.update((pair.output.name, pair.output) for pair in updated.file_pairs)
        if unchanged:
            return None, False, candidate
        # Retain unchanged official parts when the current game splits one old mod into several bundles.
        for target in targets:
            if target.name not in generated:
                shutil.copy2(target, output / target.name)
                generated[target.name] = output / target.name
        if settings.options["output"]:
            progress(candidate, phase, "export")
            destination = Path(settings.options["output"]) / "bundles" / entry["id"]
            for path in generated.values():
                exported = destination / path.name
                if exported.resolve() in candidate.files.values():
                    raise ServiceError("bad_params", key="output")
            destination.mkdir(parents=True, exist_ok=True)
            for path in generated.values():
                shutil.copy2(path, destination / path.name)
        return sorted(generated.values()), True, candidate
