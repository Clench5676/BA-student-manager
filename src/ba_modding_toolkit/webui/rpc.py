"""A registry of named methods the front end calls through POST /api/rpc."""

from __future__ import annotations

import inspect
import logging
from typing import Any, Callable

from ..errors import ServiceError

logger = logging.getLogger(__name__)


class RpcRegistry:
    def __init__(self) -> None:
        self._methods: dict[str, Callable[..., Any]] = {}

    def method(self, name: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
        def register(fn: Callable[..., Any]) -> Callable[..., Any]:
            if name in self._methods:
                raise ValueError(f"duplicate RPC method {name}")
            self._methods[name] = fn
            return fn
        return register

    def names(self) -> list[str]:
        return sorted(self._methods)

    def call(self, name: str, params: dict[str, Any] | None) -> dict[str, Any]:
        """Run a method; returns ``{"result": ...}`` or ``{"error": {"code", "params"}}``, never raises."""
        fn = self._methods.get(name)
        if fn is None:
            return {"error": {"code": "unknown_method", "params": {"method": name}}}
        params = params or {}
        if not isinstance(params, dict):
            return {"error": {"code": "bad_params", "params": {"method": name}}}
        try:
            inspect.signature(fn).bind(**params)
        except TypeError as e:
            return {"error": {"code": "bad_params", "params": {"method": name, "error": str(e)}}}
        try:
            result = fn(**params)
        except ServiceError as e:
            return {"error": e.to_json()}
        except Exception as e:
            logger.exception("RPC %s failed", name)
            return {"error": {"code": "internal", "params": {"method": name, "error": f"{type(e).__name__}: {e}"}}}
        return {"result": to_json(result)}


def to_json(value: Any) -> Any:
    """Turn service results (dataclasses with to_json, paths, sets) into plain JSON values."""
    if hasattr(value, "to_json"):
        return to_json(value.to_json())
    if isinstance(value, dict):
        return {str(k): to_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        items = [to_json(v) for v in value]
        return sorted(items, key=str) if isinstance(value, (set, frozenset)) else items
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)
