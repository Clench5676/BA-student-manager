"""Photography RPC integration, immutable assets and student-list App selection."""

import base64
import io
import json
import time
from pathlib import Path
from dataclasses import replace

import pytest
from PIL import Image

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.library.models import Pin, PhotographApplyResult
from ba_modding_toolkit.webui.server import MAX_BODY
from test_webui import app, call, rpc, services


@pytest.fixture
def photography_env(services, tmp_path):
    library, game = services.library, services.game
    library.photographs = services.photographs
    pin = Pin('install', tmp_path / 'game', (tmp_path / 'game',), 'global')
    library.pins = [pin]
    services.catalog.v.portrait = 'Student_Portrait_Test_Collection'
    descriptor = {'name': services.catalog.v.portrait,
                  'bundle': 'uis-01_common-14_charactercollect-_mxload-2024-01-01_000_assets_all_1.bundle',
                  'cab': 'CAB-test', 'pid': 1}
    game.collection_target = lambda name: dict(descriptor)
    chosen = {'id': None, 'known': True, 'enabled': True}
    library.photograph_choice = lambda target, selected: dict(chosen)
    library.photograph_removal_info = lambda variant, key: {'official': key == 'official', 'used': chosen['id'] == key}
    def delete(variant, key, confirm=False, log=None):
        if key == chosen['id']:
            if not confirm:
                raise ServiceError('asset_delete_confirm')
            chosen['id'] = None
        return services.photographs.delete(variant, key)
    library.delete_photograph = delete
    def apply(variant, key, target, pin=None, log=None, progress=None):
        assert pin.key == 'install' and target['name'] == descriptor['name']
        chosen['id'] = key
        return PhotographApplyResult(variant, 'official' if key is None else 'mod:photo', [], deferred=not library.enabled, cores=['other:test'])
    library.apply_photograph = apply
    stream = io.BytesIO();Image.new('RGBA', (202, 228), (10, 130, 200, 240)).save(stream, format='PNG')
    return {'pin': pin, 'descriptor': descriptor, 'png': 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode(),
            'raw': stream.getvalue(), 'chosen': chosen}


def done(services, key):
    deadline = time.monotonic() + 3
    while services.jobs.get(key).pending and time.monotonic() < deadline:
        time.sleep(.01)
    job = services.jobs.get(key)
    assert job.state == 'done', job.error
    return job.result


def test_save_select_asset_and_roster_thumbnail(app, services, photography_env):
    env = photography_env
    saved = rpc(app, 'photography.save', variant='hoshino', png=env['png'], mode='portrait')['result']
    key = saved['saved']
    selected = rpc(app, 'photography.select', variant='hoshino', id=key)['result']
    url = selected['photos'][0]['url']
    assert call(app, url)[2] == env['raw']
    roster = rpc(app, 'roster.list')['result']
    assert roster['families'][0]['variants'][0]['thumbnail'] == url
    assert rpc(app, 'family.get', key='hoshino')['result']['variants'][0]['thumbnail'] == url
    current = rpc(app, 'photography.list', variant='hoshino')['result']
    assert current['default'].startswith('/asset/photography/default/')
    assert current['game']['id'] == 'official'


@pytest.mark.parametrize('enabled', [True, False])
def test_applied_is_scoped_to_the_shown_skin_but_deletion_checks_every_skin(
        app, services, photography_env, enabled):
    original = services.catalog.v
    alternative = replace(original, key='hoshino_swimsuit', portrait='Student_Portrait_Test_swimsuit_Collection')
    services.catalog.f.variants.append(alternative)
    keys = [rpc(app, 'photography.save', variant=v.key, png=photography_env['png'], mode='portrait')['result']['saved']
            for v in (original, alternative)]
    choices = dict(zip([v.portrait for v in (original, alternative)], keys))
    services.game.collection_target = lambda name: {**photography_env['descriptor'], 'name': name}
    services.library.photograph_choice = lambda descriptor, pin: {
        'id': choices[descriptor['name']], 'known': True, 'enabled': enabled, 'pending': not enabled}
    def removal_info(variant, key):
        targets = sorted(v.key for v in (original, alternative) if choices[v.portrait] == key)
        return {'official': False, 'used': bool(targets), 'used_here': variant in targets,
                'used_elsewhere': any(target != variant for target in targets), 'targets': targets}
    services.library.photograph_removal_info = removal_info
    for variant, own, other in [(original, keys[0], keys[1]), (alternative, keys[1], keys[0])]:
        result = rpc(app, 'photography.list', variant=variant.key)['result']
        assert {entry['variant'] for entry in result['photos']} == {original.key, alternative.key}
        assert {entry['id'] for entry in result['photos'] if entry['applied']} == {own}
        assert result['game']['id'] == own and result['game']['enabled'] == enabled
        for key in (own, other):
            assert rpc(app, 'photography.removalInfo', variant=variant.key, id=key)['result'] == removal_info(variant.key, key)
    # Returning to official must not mark the other skin's persisted photo Applied.
    choices[original.portrait] = None
    result = rpc(app, 'photography.list', variant=original.key)['result']
    assert result['game']['id'] == 'official' and not any(entry['applied'] for entry in result['photos'])
    assert rpc(app, 'photography.removalInfo', variant=original.key, id=keys[1])['result']['used']


@pytest.mark.parametrize('unavailable', ['game', 'target', 'unknown'])
def test_unavailable_or_unknown_target_has_no_applied_photo(app, services, photography_env, unavailable):
    key = rpc(app, 'photography.save', variant='hoshino', png=photography_env['png'], mode='portrait')['result']['saved']
    photography_env['chosen'].update(id=key, known=unavailable != 'unknown')
    if unavailable == 'game':
        services.library.pins = []
    elif unavailable == 'target':
        services.catalog.v.portrait = None
    result = rpc(app, 'photography.list', variant='hoshino')['result']
    assert not any(entry['applied'] for entry in result['photos'])


def test_apply_waits_for_real_job_and_restore_resets_app_choice(app, services, photography_env):
    key = rpc(app, 'photography.save', variant='hoshino', png=photography_env['png'], mode='lobby')['result']['saved']
    rpc(app, 'photography.select', variant='hoshino', id=key)
    done(services, rpc(app, 'photography.apply', variant='hoshino', id=key)['result'])
    assert rpc(app, 'photography.list', variant='hoshino')['result']['game']['id'] == key
    failed = rpc(app, 'photography.delete', variant='hoshino', id=key)['result']
    deadline = time.monotonic() + 3
    while services.jobs.get(failed).pending and time.monotonic() < deadline:
        time.sleep(.01)
    assert services.jobs.get(failed).error['code'] == 'asset_delete_confirm'
    done(services, rpc(app, 'photography.restore', variant='hoshino')['result'])
    result = rpc(app, 'photography.list', variant='hoshino')['result']
    assert result['app'] is None and result['game']['id'] == 'official'
    assert len(result['photos']) == 1
    assert 'thumbnail' not in rpc(app, 'roster.list')['result']['families'][0]['variants'][0]


def test_capture_upload_has_a_bounded_larger_limit_without_widening_other_rpcs(app, services, photography_env):
    large = 'x' * (MAX_BODY + 100)
    status, _, data = call(app, '/api/rpc', 'POST', {'method': 'photography.save', 'params': {
        'variant': 'hoshino', 'png': large, 'mode': 'portrait'}})
    assert status == '200 OK' and json.loads(data)['error']['code'] == 'photo_invalid'
    assert call(app, '/api/rpc', 'POST', {'method': 'app.info', 'params': {'value': large}})[0] == '400 Bad Request'


def test_missing_original_keeps_app_photography_and_default_restore_available(app, services, photography_env):
    services.catalog.v.portrait = None
    saved = rpc(app, 'photography.save', variant='hoshino', png=photography_env['png'], mode='portrait')['result']
    current = rpc(app, 'photography.list', variant='hoshino')['result']
    assert not current['applicable'] and current['default'] is None
    rpc(app, 'photography.select', variant='hoshino', id=saved['saved'])
    done(services, rpc(app, 'photography.restore', variant='hoshino')['result'])
    assert services.photographs.list('hoshino')['app'] is None
    assert rpc(app, 'photography.apply', variant='hoshino', id=saved['saved'])['error']['code'] == 'photo_target_unavailable'


def test_default_asset_is_pinned_and_reads_only_official_bundles(app, services, photography_env):
    env = photography_env
    official = Path('/verified/' + env['descriptor']['bundle'])
    services.library.official_bundles = lambda core, pin: [official]
    def original(name, paths):
        assert name == env['descriptor']['name'] and paths == [official]
        return env['raw']
    services.game.collection_portrait_from = original
    default = rpc(app, 'photography.list', variant='hoshino')['result']['default']
    assert call(app, default)[2] == env['raw']
    assert call(app, default.replace(env['pin'].id, 'another-install'))[0] == '404 Not Found'


def test_saving_does_not_wait_for_an_unrelated_game_status_read(app, services, photography_env):
    def blocked(*args):
        raise AssertionError('A capture must not request game status')
    services.library.photograph_choice = blocked
    saved = rpc(app, 'photography.save', variant='hoshino', png=photography_env['png'], mode='portrait')['result']
    assert services.photographs.image('hoshino', saved['saved']) == photography_env['raw']


def test_photo_only_library_moves_with_images_and_app_choice(app, services, photography_env, tmp_path):
    saved = rpc(app, 'photography.save', variant='hoshino', png=photography_env['png'], mode='portrait')['result']
    key = saved['saved']
    rpc(app, 'photography.select', variant='hoshino', id=key)
    old = services.library_dir()
    assert not (old / 'state.json').exists() and not (old / 'profiles.json').exists()
    target = services.move_library(tmp_path / 'moved-library')
    assert target != old and (target / 'photographs' / 'index.json').is_file()
    assert services.photographs.list('hoshino')['app'] == key
    assert services.photographs.image('hoshino', key) == photography_env['raw']
    assert not (old / 'photographs').exists()


def test_preview_cache_clear_does_not_remove_photographs(app, services, photography_env):
    from types import SimpleNamespace
    saved = rpc(app, 'photography.save', variant='hoshino', png=photography_env['png'], mode='portrait')['result']
    services._cache = SimpleNamespace(clear=lambda: None)
    services.clear_cache()
    assert services.photographs.image('hoshino', saved['saved']) == photography_env['raw']


def test_export_preserves_pixels_and_avoids_collisions(services, photography_env, tmp_path, monkeypatch):
    from ba_modding_toolkit.webui import photography
    destination = tmp_path / 'exports'
    services.settings.set('output_dir', str(destination))
    opened = []
    monkeypatch.setattr(photography, 'reveal', opened.append)
    key = services.photography.save('hoshino', photography_env['png'], 'portrait', '', '', '')['saved']
    first = services.photography.export('hoshino', key)
    second = services.photography.export('hoshino', key)
    assert first['path'] != second['path']
    assert Path(first['path']).read_bytes() == Path(second['path']).read_bytes() == photography_env['raw']
    assert opened == [destination, destination]


@pytest.mark.parametrize('existing', [False, True])
@pytest.mark.parametrize('deferred', [False, True])
def test_restore_reuses_or_creates_one_default_and_reports_the_deletion_identity(
        app, services, photography_env, existing, deferred):
    env = photography_env
    saved = services.photographs.save('hoshino', env['png'], 'portrait')['saved']
    services.photographs.select('hoshino', saved)
    generated = services.photographs.save('hoshino', env['png'], 'portrait', builtin=True)['saved'] if existing else None
    services.library.enabled = not deferred
    env['chosen'].update(id=saved, enabled=not deferred, pending=deferred, error={'code': 'photo_apply_failed'} if deferred else None)
    stream = io.BytesIO()
    Image.new('RGBA', (202, 228), (200, 30, 10, 255)).save(stream, format='PNG')
    changed_png = 'data:image/png;base64,' + base64.b64encode(stream.getvalue()).decode()
    done(services, rpc(app, 'photography.restore', variant='hoshino', png=changed_png)['result'])
    result = rpc(app, 'photography.list', variant='hoshino')['result']
    defaults = [entry for entry in result['photos'] if entry.get('builtin')]
    assert len(defaults) == 1
    key = defaults[0]['id']
    assert not existing or key == generated
    assert result['app'] == result['game']['id'] == key
    for entry in result['photos']:
        info = rpc(app, 'photography.removalInfo', variant='hoshino', id=entry['id'])['result']
        assert entry['applied'] == info['used'] == (entry['id'] == key)
    assert services.photographs.image('hoshino', key) == (env['raw'] if existing else stream.getvalue())
    done(services, rpc(app, 'photography.restore', variant='hoshino', png=env['png'])['result'])
    assert len(services.photographs.list('hoshino')['photos']) == 2
    done(services, rpc(app, 'photography.delete', variant='hoshino', id=saved)['result'])
    failed = rpc(app, 'photography.delete', variant='hoshino', id=key)['result']
    deadline = time.monotonic() + 3
    while services.jobs.get(failed).pending and time.monotonic() < deadline:
        time.sleep(.01)
    assert services.jobs.get(failed).error['code'] == 'asset_delete_confirm'
