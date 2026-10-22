"""Failure logs without private paths or exception tracebacks."""

import html
import logging
import re
from urllib.parse import unquote


def _private_text(message: str) -> str:
    for _ in range(3):
        decoded = html.unescape(unquote(message))
        if decoded == message:
            break
        message = decoded
    # Free-form messages do not delimit unquoted paths reliably. Discard the
    # whole message when it contains separators or a filename with any extension.
    # This also covers arbitrary directories, temporary names and escaped paths.
    if re.search(r"[/\\]|\.[\w]|\b[A-Za-z]:", message):
        return "[path]"
    # Quoted values can also be relative, extensionless directory names.
    return re.sub(r"'[^']*'|\"[^\"]*\"", "[path]", message)


def _private_message(error: Exception) -> str:
    message = str(error)
    # OSError exposes both endpoints of a failed rename. Replace their repr first
    # to cover spaces, quotes, control characters and Windows path separators.
    for attribute in ("filename", "filename2"):
        filename = getattr(error, attribute, None)
        if filename:
            message = message.replace(repr(filename), "[path]").replace(str(filename), "[path]")
    return _private_text(message)


def log_failure(logger: logging.Logger, level: int, context: str, error: Exception,
                *, code: str | None = None) -> None:
    """Log only sanitized strings; callers supply a path-free operation label."""
    code = code or getattr(error, "code", None)
    if code is None:
        code = getattr(error, "winerror", None) or getattr(error, "returncode", None)
    errno = getattr(error, "errno", None)
    logger.log(level, "%s: %s (code=%s, errno=%s): %s", context, type(error).__name__,
               _private_text(str(code)), errno if isinstance(errno, int) else None,
               _private_message(error))
