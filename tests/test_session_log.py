"""The settings log RPC reads only the current session and never discloses credentials."""

import logging
from types import SimpleNamespace
from urllib.parse import quote

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui.api import build_api
from ba_modding_toolkit.webui.session_log import LOG_BYTES, RedactingFormatter, redact, tail
from ba_modding_toolkit.webui.timing import Timings


def test_log_rpc_returns_the_last_500_lines_in_order_and_redacts_secrets(tmp_path):
    secret = "session/value+with?punctuation"
    path = tmp_path / "webui.log"
    lines = [f"line {i}" for i in range(510)]
    lines += [f"URL http://127.0.0.1/?t={quote(secret, safe='')}",
              f"unexpected failure: {secret}", "Authorization: Bearer abcdef", "password='hidden value'"]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    services = SimpleNamespace(log_path=path, log_secrets={secret}, timings=Timings())
    result = build_api(services).call("app.log", {})["result"]
    assert result["path"] == str(path)
    text = result["text"]
    assert len(text.splitlines()) == 500
    assert text.startswith("line 14\n")
    assert text.endswith("password=[redacted]")
    for value in (secret, quote(secret, safe=""), "abcdef", "hidden value"):
        assert value not in text
    assert "line 509\nURL" in text


@pytest.mark.parametrize("line,secret", [
    ('{"token": "json-secret"}', "json-secret"),
    ("api_key=key-secret", "key-secret"),
    ("BAMT_CLASSIC_TOKEN=classic-secret", "classic-secret"),
    ("Cookie: bamt123=cookie-secret; Path=/", "cookie-secret"),
    ("Authorization: Basic abcdef==", "abcdef"),
    ("https://user:password@example.invalid", "password"),
    ("http://localhost/?t=query-secret&next=/", "query-secret"),
])
def test_redaction_covers_credentials_even_without_a_known_value(line, secret):
    assert secret not in redact(line, set())


def test_tail_handles_missing_invalid_utf8_and_oversized_logs(tmp_path):
    path = tmp_path / "webui.log"
    assert tail(path, set()) == ""
    path.write_bytes(b"password=" + b"x" * LOG_BYTES + b"\nlast \xff\n")
    assert tail(path, set()) == "last \ufffd"
    with pytest.raises(ServiceError):
        tail(tmp_path, set())


def test_file_handler_redacts_the_formatted_message_and_traceback(tmp_path):
    path = tmp_path / "webui.log"
    handler = logging.FileHandler(path, mode="w", encoding="utf-8")
    handler.setFormatter(RedactingFormatter({"actual-session-secret"}))
    logger = logging.getLogger("test.session-log")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    try:
        logger.info("web UI at http://localhost/?t=actual-session-secret")
        try:
            raise ValueError("token=traceback-secret")
        except ValueError:
            logger.exception("failed")
    finally:
        logger.removeHandler(handler)
        handler.close()
    text = path.read_text()
    assert "actual-session-secret" not in text and "traceback-secret" not in text
    assert "ValueError" in text
