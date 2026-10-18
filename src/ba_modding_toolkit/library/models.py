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


@dataclass(frozen=True)
class GameFileState(JsonResult):
    """The installed source and restore availability for one bundle part."""

    file: Path
    core: str
    kind: Kind
    applied: str
    crc: CRCStatus
    original: bool
    date: str
    size: int


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
