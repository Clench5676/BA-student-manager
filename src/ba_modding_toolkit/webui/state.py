"""Small UI state kept between launches: the asset consent and recently opened variants."""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

RECENT_MAX = 50


class UiState:
    def __init__(self, path: Path):
        self.path = Path(path)
        self._lock = threading.Lock()
        self._data: dict[str, Any] = {}
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
            if isinstance(data, dict):
                self._data = data
        except (OSError, ValueError):
            self._data = {}

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self._data, ensure_ascii=False, indent=1), encoding="utf-8")
        os.replace(tmp, self.path)

    @property
    def consent(self) -> bool | None:
        """None until the user answered the consent popup; then True (cache allowed) or False."""
        value = self._data.get("consent")
        return value if isinstance(value, bool) else None

    def set_consent(self, granted: bool) -> None:
        with self._lock:
            self._data["consent"] = bool(granted)
            self._save()

    def recent(self) -> list[str]:
        value = self._data.get("recent")
        return [v for v in value if isinstance(v, str)] if isinstance(value, list) else []

    def visit(self, variant_key: str) -> None:
        with self._lock:
            recent = [v for v in self.recent() if v != variant_key]
            self._data["recent"] = [variant_key, *recent][:RECENT_MAX]
            self._save()
