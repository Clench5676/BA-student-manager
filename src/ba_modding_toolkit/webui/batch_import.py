"""Batch import preflight and execution, built on the library and classic updater."""

from __future__ import annotations

import hashlib
import logging
import os
import shutil
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field, replace
from pathlib import Path
from typing import Any

from .. import core, devmode
from ..bundle import Bundle
from ..errors import ServiceError
from ..gameassets.spine import spine_revision
from ..library.identity import identify
from ..library.judge import core_of, kind_of, part_of
from ..library.storage import Fingerprints
from ..models import SaveOptions
from ..naming import parse_filename
from ..searching import _asset_match
from ..utils import no_log, parse_hex_bytes

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
    if error.code in ("bundle_invalid", "mod_platform_unknown", "library_io_error"):
        return "unreadable"
    if error.code in ("mod_target_ambiguous", "mod_parts_missing", "game_file_conflict", "mod_platform_mismatch"):
        return "conflict"
    if error.code in ("mod_unsupported", "source_unsupported"):
        return "unsupported"
    return "no_target"


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
                self._judge(candidate, library, pin, log)
                if candidate.identity and candidate.identity in known:
                    skipped += len(candidate.entry["paths"])
                    continue
                if candidate.identity:
                    known.add(candidate.identity)
                if not candidate.error and candidate.entry["variant"] and candidate.entry["kind"] in ("spr", "lobby"):
                    try:
                        stamp = spine_revision(list(candidate.files.values()))
                        key = hashlib.sha256(f"{revision}:{candidate.entry['id']}:{stamp}".encode()).hexdigest()
                        previews[key] = (candidate, stamp)
                        candidate.entry["preview"] = {"kind": "import", "key": key}
                    except (OSError, KeyError):
                        pass  # An unavailable source keeps its static catalog artwork.
                entries.append(candidate)
                progress(i + 1, len(candidates), candidate.entry["core"] or "")
            with self._lock:
                if revision == self._revision:
                    self._latest = {c.entry["id"]: c for c in entries}
                    self._previews = previews
            return {"entries": [c.entry for c in entries], "skipped": skipped}

        return self.services.submit("import.analyze", analyze)

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
            variant, error = None, None
            try:
                if self._hashes.get(path).trailing is None:
                    raise ServiceError("bundle_invalid")
                if not library.supports_kind(kind):
                    error = "unsupported"
                    resolve = getattr(library.catalog, "variant_for_asset_core", library.catalog.variant_for_core)
                    found = resolve(parsed.core.lower())
                    variant = found.key if found else None
                else:
                    name, variant, kind = identify(path, name, library.catalog)
            except OSError:
                error = "unreadable"
            except ServiceError as caught:
                error = blocked_reason(caught)
            except Exception:
                logger.debug("Cannot inspect uploaded bundle: %s", path, exc_info=True)
                error = "unreadable"
            parsed = parse_filename(name)
            # Date separates versions; folders separate alternative mods of the same release.
            key = (path.parent, "", "", kind, None) if kind == "other" else (
                path.parent, parsed.core.lower(), parsed.date, kind, variant)
            groups.setdefault(key, []).append((path, name, error))
        candidates = []
        for (_, core_name, _, kind, variant), items in groups.items():
            files, parts, sources, error = {}, {}, [], None
            for path, name, problem in items:
                error = error or problem
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
                     "state": "blocked", "reason": error, "libraryId": None, "preview": None}
            candidate = Candidate(files, entry, error)
            try:
                candidate.identity = frozenset((core_of(name), self._hashes.get(path).sha1) for name, path in files.items())
            except OSError:
                pass  # The unreadable row above still reports all of its source paths.
            candidates.append(candidate)
        return candidates, skipped

    def _judge(self, candidate: Candidate, library: Any, pin: Any, log: Any = no_log) -> None:
        entry = candidate.entry
        if candidate.error:
            return
        try:
            report = library.inspect_import(candidate.files, pin=pin)
            candidate.identity = report["identity"]
            live = report["targets"]
            if len({p.name for p in live}) != len(live):
                raise ServiceError("game_file_conflict")
            for file in entry["files"]:
                name = next((name for name, path in candidate.files.items() if str(path) == file["path"]), "")
                matches = [p for p in live if part_of(p.name) == part_of(name)]
                file["target"] = matches[0].name if len(matches) == 1 else None
            if report["libraryId"]:
                entry.update(state="library", reason=None, libraryId=report["libraryId"])
                return
            if report["installed"]:
                entry.update(state="installed", reason=None)
                return
            if not pin or not live:
                raise ServiceError("game_file_not_found")
            originals = report["originals"] if entry["kind"] == "other" else library.official_bundles(entry["core"], pin=pin)
            if len(live) != len(originals):
                raise ServiceError("game_file_conflict")
            baseline = dict(zip(live, originals))
            exact = set(candidate.files) <= {p.name for p in live}
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
                targets, _ = _asset_match(list(candidate.files.values()),
                                          [baseline[p] for p in live if parse_filename(p.name).date ==
                                           latest[parse_filename(p.name).prefix]], log)
                targets = [p for p in live if baseline[p] in targets]
            if not targets:
                raise ServiceError("game_file_not_found")
            candidate.targets, candidate.originals = targets, [baseline[p] for p in targets]
            for file in entry["files"]:
                if file["target"] is None and len(targets) == 1:
                    file["target"] = targets[0].name
            compatibility = report["compatibility"]
            if compatibility.get("remappable"):
                entry.update(state="blocked", reason="conflict")
                return
            official = compatibility["official"]["skeletons"]
            incoming = compatibility["mod"]["skeletons"]
            versions = {s["version"] for s in official.values() if s.get("version")}
            series = {tuple(version.split(".")[:2]) for version in versions}
            candidate.spine_version = max(versions, key=lambda version: tuple(map(int, version.split(".")))) if len(series) == 1 else None
            unknown = any(not s.get("version") for s in incoming.values())
            mismatch = any(s.get("version") and
                           tuple(s["version"].split(".")[:2]) not in (
                               {tuple(official[name]["version"].split(".")[:2])}
                               if official.get(name, {}).get("version") else series)
                           for name, s in incoming.items())
            if unknown or (mismatch and (candidate.spine_version is None or
                                        not self.services.settings.spine_options().is_valid())):
                entry.update(state="blocked", reason="spine_version")
            else:
                entry.update(state="ready" if exact and not mismatch else "update", reason=None)
        except ServiceError as error:
            entry.update(state="blocked", reason=blocked_reason(error))
        except (OSError, ValueError):
            entry.update(state="blocked", reason="unreadable")

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

            def report(candidate: Candidate, phase: str) -> None:
                with progress_lock:
                    progress({"done": completed[0], "total": total,
                              "current": candidate.entry["id"], "phase": phase})

            with tempfile.TemporaryDirectory(prefix=devmode.LIBRARY_STAGING_PREFIX + "import-") as temporary:
                with ThreadPoolExecutor(max_workers=options["workers"]) as workers:
                    futures = {}
                    for candidate in chosen:
                        if candidate.entry["state"] not in ("ready", "update"):
                            continue
                        # Recheck the actual inputs and current official files before launching parallel builds.
                        try:
                            current = frozenset((core_of(name), self._hashes.get(path).sha1)
                                                for name, path in candidate.files.items())
                            if current != candidate.identity:
                                raise ServiceError("entry_changed")
                            fresh = Candidate(dict(candidate.files), dict(candidate.entry))
                            fresh.entry["files"] = [dict(f) for f in candidate.entry["files"]]
                            self._judge(fresh, library, pin, log)
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
                            if state in ("library", "installed"):
                                item["outcome"] = "unchanged"
                            elif state == "blocked":
                                item["reason"] = candidate.entry["reason"]
                            else:
                                future = futures[candidate.entry["id"]]
                                if isinstance(future, Exception):
                                    raise future
                                paths, updated, fresh = future.result()
                                if paths is None:
                                    item.update(outcome="unchanged", libraryId=fresh.entry["libraryId"])
                                else:
                                    report(candidate, "add")
                                    added = library.add_files(fresh.entry["kind"], paths, pin=pin)
                                    entries = [*added, *added.duplicates]
                                    if len(entries) != 1:
                                        raise ServiceError("mod_unsupported")
                                    mod = entries[0]
                                    item.update(libraryId=mod.id, outcome=("updated" if updated else "imported")
                                                if added else "unchanged")
                                    result.added.extend(added)
                                    result.cores.update(core_of(path.name) for path in paths)
                                    result.kinds.add(mod.kind)
                                    if options["enableAfterImport"] and added:
                                        phase = "apply"
                                        report(candidate, phase)
                                        applied = library.apply_import(mod.target, f"mod:{mod.id}", kind=mod.kind,
                                            pin=pin, settings=settings, backup=options["backup"], log=log)
                                        item["applied"] = not applied.deferred
                        except ServiceError as error:
                            item.update(outcome="failed", reason=error.code)
                        except OSError:
                            item.update(outcome="failed", reason="library_io_error")
                        except Exception:
                            logger.exception("Batch import entry failed: %s", candidate.entry["id"])
                            item.update(outcome="failed", reason="internal")
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
            raise ServiceError(entry["reason"])
        if entry["state"] == "ready":
            return list(candidate.files.values()), False, candidate
        progress(candidate, "update")
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
                skip_unchanged=settings.options["skipUnchanged"], match_strategy=settings.options["strategy"],
                anim_check=settings.anim_check_options(), log=log)
            if not updated.success:
                raise ServiceError("mod_update_failed")
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
            destination = Path(settings.options["output"]) / "bundles" / entry["id"]
            for path in generated.values():
                exported = destination / path.name
                if exported.resolve() in candidate.files.values():
                    raise ServiceError("bad_params", key="output")
            destination.mkdir(parents=True, exist_ok=True)
            for path in generated.values():
                shutil.copy2(path, destination / path.name)
        return sorted(generated.values()), True, candidate
