"""Export cache validators apply to every light asset and survive schema changes."""
from ba_modding_toolkit.webui import server
from ba_modding_toolkit.webui.events import EventBus
from ba_modding_toolkit.webui.rpc import RpcRegistry
from ba_modding_toolkit.webui.server import AssetResponse, WebApp
import pytest


def get(app, path, etag=None):
    env = {"REQUEST_METHOD": "GET", "PATH_INFO": path, "HTTP_X_BAMT_TOKEN": "tok"}
    if etag:
        env["HTTP_IF_NONE_MATCH"] = etag
    response = {}
    body = b"".join(app(env, lambda status, headers: response.update(status=status, headers=dict(headers))))
    return response["status"], response["headers"], body


@pytest.mark.parametrize("path", ["ui/layout/UICharacterDetail.json", "ui/atlases.json", "ui/textures.json", "ui/sprite/Common/Frame.png", "ui/texture/Frame.png"])
def test_cached_exports_revalidate_changed_bodies_and_schema(monkeypatch, path):
    body = [b'old export']
    app = WebApp(RpcRegistry(), EventBus(), assets=lambda *args: AssetResponse(body[0], "application/json", True), token="tok", consent=lambda: True)
    status, headers, data = get(app, "/asset/" + path)
    assert status == "200 OK" and data == body[0]
    assert headers["Cache-Control"] == "private, no-cache"
    old = headers["ETag"]
    assert get(app, "/asset/" + path, old)[::2] == ("304 Not Modified", b"")
    body[0] = b'new export with effectDistance and gradient'
    status, changed, data = get(app, "/asset/" + path, old)
    assert status == "200 OK" and data == body[0] and changed["ETag"] != old
    monkeypatch.setattr(server, "HTTP_EXPORT_SCHEMA", "next-schema")
    assert get(app, "/asset/" + path, changed["ETag"])[0] == "200 OK"


def test_heavy_assets_and_unconsented_exports_remain_no_store():
    for light, consent in [(False, True), (True, False)]:
        app = WebApp(RpcRegistry(), EventBus(), assets=lambda *args: AssetResponse(b'bytes', "image/png", light), token="tok", consent=lambda: consent)
        status, headers, data = get(app, "/asset/ui/textures.json")
        assert headers["Cache-Control"] == "no-store" and "ETag" not in headers


def test_bootstrap_and_css_bypass_legacy_unversioned_image_caches(tmp_path):
    (tmp_path / "index.html").write_text("<head></head><body></body>")
    (tmp_path / "app.css").write_text('a { background: url("/asset/ui/sprite/Common/Frame.png"); }')
    app = WebApp(RpcRegistry(), EventBus(), static_dir=tmp_path, token="tok")
    html = get(app, "/")[2].decode()
    assert 'name="bamt-ui-exports"' in html and server.HTTP_EXPORT_SCHEMA in html
    assert f"Frame.png?export={server.HTTP_EXPORT_SCHEMA}" in get(app, "/app.css")[2].decode()
