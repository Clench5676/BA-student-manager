"""Tours use locale files, isolated profiles and no game assets or network."""
import copy
import json
import shutil

import pytest

from ba_modding_toolkit.errors import ServiceError
from ba_modding_toolkit.webui import strings, tours
from ba_modding_toolkit.webui.state import UiState


def release(version, *features):
    return {'version': version, 'approved': True, 'pages': [
        {'id': feature, 'copy': f'webui.tours.v{version.replace(".", "_")}.{feature}'} for feature in features]}


def write_locales(folder, records):
    for lang in tours.LOCALES:
        data = {}
        for record in records:
            for page in record['pages']:
                node = data
                for key in page['copy'].split('.'):
                    node = node.setdefault(key, {})
                node.update(title=f"{lang} {page['id']} {record['version']}", body=f'{lang} feature copy')
        (folder / f'{lang}.json').write_text(json.dumps(data), encoding='utf-8')


@pytest.fixture
def locale_files(tmp_path, monkeypatch):
    folder = tmp_path / 'locales'
    folder.mkdir()
    monkeypatch.setattr(strings, 'get_locale_dir', lambda: folder)
    return folder


@pytest.fixture
def manifest(monkeypatch, locale_files):
    records = (release('0.5.0', 'old'), release('0.6.0', 'photos', 'shared'), release('0.7.0', 'shared', 'hall'))
    write_locales(locale_files, records)
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
    return records


def plan(state, version):
    return tours.launch(state, version, tours.published(version, 'en-US'))


def acknowledge(state, version, planned):
    tours.presented(state, planned['versions'], tours.published(version, 'en-US'))


@pytest.mark.parametrize('current', ['0.6.0-alpha.9', '0.6.0-alpha.9-dev', '0.6.0-dev'])
def test_review_manifest_matches_draft_and_is_text_only(current):
    from pathlib import Path
    draft = (Path(__file__).parents[1] / 'docs/tours/0.6.0-draft.md').read_text()
    assert tours.PUBLISHED_TOURS[0]['approved'] is True
    for lang in tours.LOCALES:
        available = tours.published(current, lang)
        assert [t['version'] for t in available] == ['0.6.0']
        assert [p['id'] for p in available[0]['pages']] == ['student-thumbnails', 'hall-viewing-zoom']
        for page in available[0]['pages']:
            assert f"| {lang} | {page['title']} | {page['body']} |" in draft
            localized = strings.ui_strings(lang, fallback=False)
            key = f"webui.tours.v0_6_0.{page['id']}"
            assert (page['title'], page['body']) == (localized[f'{key}.title'], localized[f'{key}.body'])
            assert page['image'] is None and page['caption'] == ''


@pytest.mark.parametrize('current', ['0.6.0', '0.6.0+build.9', '0.7.0', 'invalid', '0.5.0-alpha.9'])
def test_review_manifest_is_hidden_outside_eligible_prereleases(tmp_path, monkeypatch, current):
    records = copy.deepcopy(tours.PUBLISHED_TOURS)
    records[0]['approved'] = 'prerelease'
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
    monkeypatch.setattr(tours, 'ui_strings', lambda *args, **kwargs: pytest.fail('hidden tours must not load copy'))
    state = UiState(tmp_path / 'webui.json')
    plan(state, '0.5.0')
    for lang in tours.LOCALES:
        assert tours.published(current, lang) == []
    assert plan(state, current)['pages'] == []


def test_final_approval_allows_the_localized_tour_in_stable(monkeypatch):
    records = copy.deepcopy(tours.PUBLISHED_TOURS)
    records[0]['approved'] = True
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
    for lang in tours.LOCALES:
        assert tours.published('0.6.0', lang) == tours.published('0.6.0-alpha.9', lang)
        assert len(tours.published('0.6.0', lang)[0]['pages']) == 2


def test_unknown_language_uses_english_copy():
    assert tours.published('0.6.0-alpha.9', 'unknown') == tours.published('0.6.0-alpha.9', 'en-US')


@pytest.mark.parametrize('previous', ['0.5.0', '0.6.0-alpha.8', '0.6.0-alpha.8-dev'])
def test_review_upgrade_uses_release_core_and_does_not_repeat(tmp_path, previous):
    state = UiState(tmp_path / 'webui.json')
    plan(state, previous)
    pending = plan(state, '0.6.0-alpha.9')
    assert pending['versions'] == ['0.6.0'] and len(pending['pages']) == 2
    assert plan(UiState(state.path), '0.6.0-alpha.9') == pending
    assert plan(state, previous)['pages'] == []
    acknowledge(state, '0.6.0-alpha.9', pending)
    assert plan(UiState(state.path), '0.6.0-alpha.10')['pages'] == []
    assert plan(state, '0.6.0')['pages'] == []


def test_first_install_empty_content_and_same_version_are_quiet(tmp_path, manifest):
    state = UiState(tmp_path / 'webui.json')
    assert plan(state, '0.6.0')['pages'] == []
    assert plan(UiState(state.path), '0.6.0')['pages'] == []
    assert plan(state, '0.6.0+reinstall')['pages'] == []
    assert plan(state, 'invalid')['pages'] == []


@pytest.mark.parametrize('consent', [True, False])
@pytest.mark.parametrize('history', [None, {}, {'highest': None}])
def test_pre_tour_profile_offers_upgrade_once_and_retries_until_presented(tmp_path, consent, history):
    path = tmp_path / 'webui.json'
    # 0.5.0 saved these choices, but had no tours/highest field.
    profile = {'consent': consent, 'prefs': {'voice_muted': True, 'scan_consent': False}}
    if history is not None:
        profile['tours'] = history
    path.write_text(json.dumps(profile), encoding='utf-8')
    state = UiState(path)
    assert state.had_asset_consent is True
    pending = plan(state, '0.6.0-alpha.13')
    assert pending['versions'] == ['0.6.0'] and len(pending['pages']) == 2
    assert plan(UiState(path), '0.6.0-alpha.13') == pending
    assert plan(UiState(path), '0.5.0')['pages'] == []
    acknowledge(state, '0.6.0-alpha.13', pending)
    for version in ('0.5.0', '0.6.0-alpha.13', '0.6.0-alpha.14', '0.6.0'):
        assert plan(UiState(path), version)['pages'] == []
    assert json.loads(path.read_text())['prefs'] == profile['prefs']
    assert state.consent is consent


@pytest.mark.parametrize('initial', [None, {}, {'prefs': {}}, {'consent': None}, {'consent': 'true'}])
@pytest.mark.parametrize('answer', [True, False])
def test_new_install_stays_quiet_after_startup_writes_and_consents(tmp_path, initial, answer):
    path = tmp_path / 'webui.json'
    if initial is not None:
        path.write_text(json.dumps(initial), encoding='utf-8')
    state = UiState(path)
    assert state.had_asset_consent is False
    # The first screen and startup popups may persist state before app.tours runs.
    state.set('voice_muted', True)
    state.set('spine_consent', answer)
    state.set('scan_consent', answer)
    state.set_consent(answer)
    assert plan(state, '0.6.0-alpha.13')['pages'] == []
    assert plan(UiState(path), '0.6.0-alpha.13')['pages'] == []


def test_existing_tour_highest_takes_priority_over_persisted_consent(tmp_path, manifest):
    path = tmp_path / 'webui.json'
    path.write_text(json.dumps({'consent': True, 'tours': {
        'highest': '0.7.0', 'pending': ['0.7.0'], 'presented': ['0.6.0'],
    }}), encoding='utf-8')
    state = UiState(path)
    assert plan(state, '0.6.0')['pages'] == []
    pending = plan(state, '0.7.0')
    assert pending['versions'] == ['0.7.0']
    acknowledge(state, '0.7.0', pending)
    assert plan(UiState(path), '0.7.0')['pages'] == []


def test_skipped_releases_use_newest_copy_deduplicate_and_acknowledge_on_display(tmp_path, manifest):
    state = UiState(tmp_path / 'webui.json')
    state.set('voice_muted', True)
    plan(state, '0.4.0')
    pending = plan(state, '0.7.0')
    assert pending['versions'] == ['0.7.0', '0.6.0', '0.5.0']
    assert [p['id'] for p in pending['pages']] == ['shared', 'hall', 'photos', 'old']
    assert pending['pages'][0]['title'] == 'en-US shared 0.7.0'
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


def test_approvals_invalid_keys_and_images(monkeypatch, locale_files):
    complete = release('0.6.0', 'photos')
    write_locales(locale_files, (complete,))
    draft, missing, invalid = [copy.deepcopy(complete) for _ in range(3)]
    draft['approved'] = False
    del missing['pages'][0]['copy']
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
            assert page['body'] == f'{lang} feature copy'


@pytest.mark.parametrize('lang', tours.LOCALES)
@pytest.mark.parametrize('field, limit', [('title', 80), ('body', 320)])
@pytest.mark.parametrize('invalid', ['missing', 'empty', 'whitespace', 'null', 'number', 'object', 'list', 'too-long'])
def test_incomplete_locale_omits_only_its_page_for_every_language(locale_files, monkeypatch, lang, field, limit, invalid):
    records = (release('0.6.0', 'photos', 'shared'),)
    write_locales(locale_files, records)
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
    path = locale_files / f'{lang}.json'
    data = json.loads(path.read_text())
    page = data['webui']['tours']['v0_6_0']['photos']
    if invalid == 'missing':
        del page[field]
    else:
        page[field] = {'empty': '', 'whitespace': ' \t\n', 'null': None, 'number': 42,
                       'object': {}, 'list': [], 'too-long': 'x' * (limit + 1)}[invalid]
    path.write_text(json.dumps(data), encoding='utf-8')
    for selected in tours.LOCALES:
        available = tours.published('0.6.0', selected)
        assert [page['id'] for page in available[0]['pages']] == ['shared']


@pytest.mark.parametrize('lang', tours.LOCALES)
def test_missing_locale_file_cannot_be_hidden_by_english_fallback(locale_files, monkeypatch, lang):
    records = (release('0.6.0', 'photos'),)
    write_locales(locale_files, records)
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
    (locale_files / f'{lang}.json').unlink()
    for selected in tours.LOCALES:
        assert tours.published('0.6.0', selected) == []


@pytest.mark.parametrize('lang', tours.LOCALES)
def test_title_body_limits_are_inclusive_and_captions_are_optional(locale_files, monkeypatch, lang):
    records = (release('0.6.0', 'photos'),)
    write_locales(locale_files, records)
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
    records[0]['pages'][0]['image'] = '/tours/app-ui.png'
    path = locale_files / f'{lang}.json'
    data = json.loads(path.read_text())
    localized = data['webui']['tours']['v0_6_0']['photos']
    localized.update(title='x' * 80, body='x' * 320)
    for caption in (None, 'x' * 40, 'x' * 41, 'two\nlines'):
        localized['caption'] = caption
        path.write_text(json.dumps(data), encoding='utf-8')
        page = tours.published('0.6.0', lang)[0]['pages'][0]
        assert page['title'] == 'x' * 80 and page['body'] == 'x' * 320
        assert page['caption'] == (caption if caption == 'x' * 40 else '')
        assert page['image'] == (None if caption in ('x' * 41, 'two\nlines') else '/tours/app-ui.png')


def test_empty_manifest_records_baseline_without_scans_then_allows_future_content(tmp_path, monkeypatch, locale_files):
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', ())
    state = UiState(tmp_path / 'webui.json')
    assert plan(state, '0.5.0')['pages'] == []
    assert json.loads(state.path.read_text())['tours']['highest'] == '0.5.0'
    records = (release('0.6.0', 'photos'),)
    write_locales(locale_files, records)
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', records)
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


def test_release_core_exception_never_admits_a_future_prerelease_tour(monkeypatch):
    monkeypatch.setattr(tours, 'PUBLISHED_TOURS', (release('0.6.0-beta.1', 'future'),))
    assert tours.published('0.6.0-alpha.9', 'en-US') == []
