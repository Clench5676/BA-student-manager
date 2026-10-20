"""JSON-ready results returned by the mod library."""

from __future__ import annotations

from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Literal

Kind = Literal["spr", "lobby"]
CRCStatus = Literal["ok", "fixed", "needs_fix"]


class JsonResult:
    """Convert result dataclasses to plain JSON values."""

    def to_json(self) -> dict[str, Any]:
        """Return a dictionary with absolute paths represented as strings."""
        def convert(value: Any) -> Any:
            if isinstance(value, Path):
                return str(value.absolute())
            if isinstance(value, dict):
                return {key: convert(item) for key, item in value.items()}
            if isinstance(value, (tuple, list)):
                return [convert(item) for item in value]
            return value

        return convert(asdict(self))


@dataclass(frozen=True)
class ModEntry(JsonResult):
    """A user's mod and the game variant it targets."""

    id: str
    file: Path
    label: str
    target: str
    kind: Kind
    added: str
    fresh: bool
    size: int
    date: str
    crc: str
    core: str = ""  # the lower-case core of its files (a lobby mod belongs to one lobby core)
    alias: str = ""


class AddResult(list[ModEntry]):
    """New entries, with matched library entries and sources recognized in game files."""

    def __init__(self) -> None:
        super().__init__()
        self.duplicates: list[ModEntry] = []
        self.installed: list[ModEntry] = []
        self.applied: list[ModEntry] = []
        self.configured: list[ModEntry] = []
        self.failed: list[dict] = []
        self.compatibility: dict[str, dict] = {}

    @property
    def added(self) -> list[ModEntry]:
        return list(self)

    def to_json(self) -> dict[str, Any]:
        return {"added": [entry.to_json() for entry in self],
                "duplicates": [entry.to_json() for entry in self.duplicates],
                "installed": [entry.to_json() for entry in self.installed],
                "applied": [entry.to_json() for entry in self.applied],
                "configured": [entry.to_json() for entry in self.configured],
                "failed": self.failed, "compatibility": self.compatibility}


@dataclass(frozen=True)
class DeleteResult(JsonResult):
    """Deleted sources and any game entries still awaiting their configured source."""

    done: list[dict]
    failed: list[dict]
    dropped: list[dict]
    cores: list[str]
    kinds: list[str]


CopyKind = Literal["game", "kept", "backup", "elsewhere"]


@dataclass(frozen=True)
class GameFileState(JsonResult):
    """The installed source and restore availability for one bundle part, from the cheap judgement (size, date and
    header; never the whole file)."""

    file: Path
    core: str
    kind: Kind
    applied: str
    crc: CRCStatus
    original: bool
    date: str
    size: int
    # where an official copy of this file is: the file itself, the library's kept original, the classic GUI's
    # .backup beside it, a file of its name in another game folder; None: nowhere (overwritten)
    copy: CopyKind | None = None
    restorable: bool = False  # copy is not None
    official: bool = False  # the file holds official bytes (the front end's source rule leaves it out)


@dataclass(frozen=True)
class VariantState(JsonResult):
    """Bundle states for both the portrait and lobby of a variant.

    ``applied`` is ``unknown`` when the parts have different sources. Consumers
    displaying separate tabs should use the individual file states.
    """

    variant: str
    files: list[GameFileState]
    applied: str
    crc: CRCStatus
    backup: bool


@dataclass(frozen=True)
class ApplyResult(JsonResult):
    """Files installed or restored by one action."""

    variant: str
    source: str
    files: list[Path]
    unchanged: bool = False
    deferred: bool = False  # mods are off: the source is configured and applied when mods are on


@dataclass(frozen=True)
class UpdateResult(JsonResult):
    """A rebuilt library mod and its retained previous version."""

    mod: ModEntry
    files: list[Path]
    previous: list[Path]
    unchanged: bool = False


@dataclass(frozen=True)
class AssetDifference(JsonResult):
    """Raw serialized asset comparison, including external stream payloads."""

    name: str
    type: str
    status: Literal["changed", "same", "added", "removed"]
    mod_size: int | None
    official_size: int | None


@dataclass(frozen=True)
class CompareResult(JsonResult):
    """Asset differences between a mod and the current official bundles."""

    mod_id: str
    assets: list[AssetDifference]


@dataclass(frozen=True)
class RemapResult(JsonResult):
    """A separately stored repaint, its region report and comparison with the source mod."""

    mod: ModEntry
    report: dict
    compare: CompareResult

    @property
    def added(self) -> list[ModEntry]:
        return [self.mod]


@dataclass(frozen=True)
class Pin(JsonResult):
    """A game folder the library works on, fixed for one call or job: its install key (the install root, resolved),
    its resource folders and its server."""

    key: str
    root: Path
    dirs: tuple[Path, ...]
    server: str

    @property
    def id(self) -> str:
        """The first 12 hex digits of the install key's SHA-1: the install's name in URLs."""
        import hashlib

        return hashlib.sha1(self.key.encode("utf-8")).hexdigest()[:12]


EntryStateName = Literal["damaged", "missing", "untracked", "changed", "source_missing", "updated", "reset", "ok",
                         "pending"]


@dataclass(frozen=True)
class EntryState(JsonResult):
    """One game core of a variant in one install (a portrait or one memorial lobby core): what its files carry, what
    is configured for it, and what the switch would do with it."""

    install: str  # the install key
    core: str  # lower-case core
    variant: str  # the variant key of the core in its own install
    names: dict | None  # the variant's shipped names when the current catalog does not map the core, else None
    kind: Kind
    source: str  # what the files carry: "official", "mod:<id>", "variant:<key>", "removed", "unknown", "damaged"
    configured: str | None  # the configured source, None for official
    state: EntryStateName
    overwritten: bool  # a non-official file with no official copy anywhere
    fixed: bool  # the parts the library does not know have trailing bytes (CRC-fixed)
    size: int  # bytes of the non-official parts not in the library yet
    files: list[GameFileState]
    dismissed: bool = False  # its prompt was dismissed for these very files

    @property
    def key(self) -> tuple[str, str]:
        return self.install, self.core


@dataclass(frozen=True)
class ScanResult(JsonResult):
    """The entries of every known install, with counts per install. ``stale``: the library wrote meanwhile."""

    entries: list[EntryState]
    counts: dict[str, dict[str, int]]
    stale: bool = False


@dataclass(frozen=True)
class AdoptResult(JsonResult):
    """Mods added from the game files: the mods (new or matched) and the entries that failed or changed."""

    added: list[ModEntry]
    failed: list[dict]
    skipped: list[dict]
    cores: list[str]
    kinds: list[str]


@dataclass(frozen=True)
class ToggleResult(JsonResult):
    """What a toggle, Retry or Apply Mod Configuration did, entry by entry ({install, core, variant, kind})."""

    enabled: bool
    done: list[dict]
    adopted: list[dict]
    failed: list[dict]
    stuck: list[dict]
    left: list[dict]
    skipped: list[dict]
    dropped: list[dict]
    cores: list[str]
    kinds: list[str]
