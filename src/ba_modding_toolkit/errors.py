"""Errors raised by the services behind the web UI.

Services return data, not sentences: an error carries a code and parameters, and the front end shows the locale
string ``webui.error.<code>`` filled with the parameters.
"""

from __future__ import annotations

from typing import Any


class ServiceError(Exception):
    """A failure the user should see, identified by a code (e.g. ``"game_not_found"``)."""

    def __init__(self, code: str, **params: Any):
        super().__init__(code)
        self.code = code
        self.params = params

    def to_json(self) -> dict[str, Any]:
        return {"code": self.code, "params": {k: _jsonable(v) for k, v in self.params.items()}}

    def __repr__(self) -> str:
        return f"ServiceError({self.code!r}, {self.params!r})"


def _jsonable(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    return str(value)
