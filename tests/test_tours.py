"""Tours use synthetic copy, isolated profiles and no game assets or network."""
import copy
import json
import shutil

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui import tours
from ba_modding_toolkit.webui.state import UiState


def release(version, *features):
    return {'version': version, 'approved': True, 'pages': [
        {'id': feature, 'copy': {lang: {'title': f'{feature} {version}', 'body': 'Short feature copy'}
                                for lang in tours.LOCALES}} for feature in features]}


@pytest.fixture
def manifest(monkeypatch):
    records = (release('0.5.0', 'old'), release('0.6.0', 'photos', 'shared'), release('0.7.0', 'shared', 'hall'))
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
    return records


def plan(state, version):
    return tours.launch(state, version, tours.published(version, 'en-US'))


def acknowledge(state, version, planned):
    tours.presented(state, planned['versions'], tours.published(version, 'en-US'))


def test_shipped_manifest_has_no_unapproved_content():
    assert tours.PUBLISHED_TOURS == ()


def test_first_install_empty_content_and_same_version_are_quiet(tmp_path, manifest):
    state = UiState(tmp_path / 'webui.json')
    assert plan(state, '0.6.0')['pages'] == []
    assert plan(UiState(state.path), '0.6.0')['pages'] == []
    assert plan(state, '0.6.0+reinstall')['pages'] == []
    assert plan(state, 'invalid')['pages'] == []


def test_skipped_releases_use_newest_copy_deduplicate_and_acknowledge_on_display(tmp_path, manifest):
    state = UiState(tmp_path / 'webui.json')
    state.set('voice_muted', True)
    plan(state, '0.4.0')
    pending = plan(state, '0.7.0')
    assert pending['versions'] == ['0.7.0', '0.6.0', '0.5.0']
    assert [p['id'] for p in pending['pages']] == ['shared', 'hall', 'photos', 'old']
    assert pending['pages'][0]['title'] == 'shared 0.7.0'
    # A crash/failure before first render must not lose the pending offer.
    assert plan(UiState(state.path), '0.7.0') == pending
    acknowledge(state, '0.7.0', pending)
    assert plan(UiState(state.path), '0.7.0')['pages'] == []
    assert state.get('voice_muted') is True


def test_downgrade_reinstall_library_move_and_copied_profile_do_not_repeat(tmp_path, manifest):
    state = UiState(tmp_path / 'profile' / 'webui.json')
    plan(state, '0.5.0')
    acknowledge(state, '0.7.0', plan(state, '0.7.0'))
    state.set('library_dir', str(tmp_path / 'another-library'))
    assert plan(state, '0.6.0')['pages'] == []
    assert plan(UiState(state.path), '0.7.0')['pages'] == []
    copied = tmp_path / 'copied.json'
    shutil.copyfile(state.path, copied)
    assert plan(UiState(copied), '0.7.0')['pages'] == []
    assert plan(UiState(tmp_path / 'new-profile.json'), '0.7.0')['pages'] == []


def test_pending_newer_content_is_not_presented_on_a_downgrade(tmp_path, manifest):
    state = UiState(tmp_path / 'webui.json')
    plan(state, '0.5.0')
    pending = plan(state, '0.7.0')
    assert plan(UiState(state.path), '0.6.0')['pages'] == []
    assert plan(UiState(state.path), '0.7.0') == pending


def test_manual_replay_consumes_pending_but_keeps_earlier_tours_available(tmp_path, manifest):
    state = UiState(tmp_path / 'webui.json')
    plan(state, '0.5.0')
    plan(state, '0.6.0')
    tours.presented(state, ['0.6.0'], tours.published('0.6.0', 'en-US'))
    assert plan(state, '0.6.0')['pages'] == []
    assert [t['version'] for t in tours.published('0.6.0', 'en-US')] == ['0.6.0', '0.5.0']
    with pytest.raises(ServiceError):
        tours.presented(state, ['0.7.0'], tours.published('0.6.0', 'en-US'))


def test_approvals_all_locales_missing_copy_and_images(monkeypatch):
    complete = release('0.6.0', 'photos')
    draft, missing, invalid = [copy.deepcopy(complete) for _ in range(3)]
    draft['approved'] = False
    del missing['pages'][0]['copy']['th-TH']
    invalid['pages'][0]['id'] = 'bad id'
    for record in (draft, missing, invalid, {}, None):
        monkeypatch.setattr(tours, 'PUBLISHED_TOURS', (record,))
        assert tours.published('0.6.0', 'en-US') == []
    for image in ('https://example.invalid/x.png', '/asset/game.png', '/tours/../x.png', '/tours/approved-ui.png', None):
        complete['pages'][0]['image'] = image
        monkeypatch.setattr(tours, 'PUBLISHED_TOURS', (complete,))
        for lang in tours.LOCALES:
            page = tours.published('0.6.0', lang)[0]['pages'][0]
            assert page['image'] == (image if image == '/tours/approved-ui.png' else None)
            assert page['body'] == complete['pages'][0]['copy'][lang]['body']


def test_empty_manifest_records_baseline_without_scans_then_allows_future_content(tmp_path, monkeypatch):
    state = UiState(tmp_path / 'webui.json')
    assert plan(state, '0.5.0')['pages'] == []
    assert json.loads(state.path.read_text())['tours']['highest'] == '0.5.0'
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', (release('0.6.0', 'photos'),))
    assert len(plan(UiState(state.path), '0.6.0')['pages']) == 1


def test_other_instance_preferences_and_presentations_merge(tmp_path, manifest):
    first = UiState(tmp_path / 'webui.json')
    second = UiState(first.path)
    plan(first, '0.4.0')
    plan(first, '0.7.0')
    second.set('language', 'ja-JP')
    tours.presented(first, ['0.6.0'], tours.published('0.7.0', 'en-US'))
    tours.presented(second, ['0.7.0'], tours.published('0.7.0', 'en-US'))
    assert first.get('language') == 'ja-JP'
    assert plan(first, '0.7.0')['versions'] == ['0.5.0']
