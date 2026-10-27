"""Approved, local feature tours and profile-local presentation history. No game or network access."""
from __future__ import annotations

import re
from typing import Any

from ..errors import ServiceError
from ..updater import parse_version, prerelease_previews
from .state import UiState
from .strings import ui_strings

LOCALES = ('en-US', 'zh-CN', 'zh-TW', 'ja-JP', 'ko-KR', 'th-TH')
# True publishes owner-approved content to all builds; 'prerelease' is local review content, hidden in stable.
# Final stable publication requires the owner's approval of every locale. Review tables live in docs/tours/.
# Each page's copy key names webui.tours.v<major>_<minor>_<patch>.<page-id> in locales/*.json;
# its title/body (80/320 characters) and optional caption are resolved without language fallback.
PUBLISHED_TOURS: tuple[dict, ...] = ({
    'version': '0.6.0',
    'approved': 'prerelease',
    'pages': [
        {
            'id': 'student-thumbnails',
            'copy': 'webui.tours.v0_6_0.student-thumbnails',
        },
        {
            'id': 'hall-viewing-zoom',
            'copy': 'webui.tours.v0_6_0.hall-viewing-zoom',
        },
    ],
},)


def version_key(version: Any) -> tuple | None:
    return parse_version(version.removesuffix('-dev')) if isinstance(version, str) else None


def release_key(version: str, current: str) -> tuple | None:
    """A release's tour can be reviewed during that release's own pre-release series."""
    key, running = version_key(version), version_key(current)
    if key and running and key[3][0] == 1 and prerelease_previews(current) and key[:3] == running[:3]:
        return min(key, running)
    return key


def published(current: str, language: str) -> list[dict]:
    """Ignore incomplete content; an absent illustration is always optional. Newest release first."""
    current_key = version_key(current)
    result, versions = [], set()
    locale_strings = {}
    for tour in PUBLISHED_TOURS:
        if not isinstance(tour, dict) or not (tour.get('approved') is True
                or (tour.get('approved') == 'prerelease' and prerelease_previews(current))):
            continue
        version, pages = tour.get('version'), tour.get('pages')
        key = version_key(version)
        if (key is None or current_key is None or release_key(version, current) > current_key
                or key in versions or not isinstance(pages, list)):
            continue
        localized, ids = [], set()
        for page in pages:
            if not isinstance(page, dict):
                continue
            feature, copy_key = page.get('id'), page.get('copy')
            if not isinstance(feature, str) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,79}', feature) or feature in ids:
                continue
            if not isinstance(copy_key, str) or not copy_key.strip():
                continue
            if not locale_strings:
                locale_strings = {lang: ui_strings(lang, fallback=False) for lang in LOCALES}
            # Fallback must not make an incomplete locale look ready for publication.
            if any(
                not isinstance(value := strings.get(f'{copy_key}.{field}'), str)
                or not value.strip() or len(value) > limit
                for strings in locale_strings.values() for field, limit in (('title', 80), ('body', 320))
            ):
                continue
            text = locale_strings[language if language in LOCALES else 'en-US']
            image = page.get('image')
            # Only bundled App UI illustrations; never a URL, game-asset endpoint or startup capture.
            image = image if isinstance(image, str) and re.fullmatch(r'/tours/[A-Za-z0-9_-]+\.png', image) else None
            caption = text.get(f'{copy_key}.caption', '')
            if len(caption) > 40 or '\n' in caption:
                image, caption = None, ''
            localized.append({'id': feature, 'title': text[f'{copy_key}.title'], 'body': text[f'{copy_key}.body'],
                              'image': image, 'caption': caption, 'version': version})
            ids.add(feature)
        if localized:
            result.append({'version': version, 'pages': localized})
            versions.add(key)
    return sorted(result, key=lambda tour: version_key(tour['version']), reverse=True)


def launch(state: UiState, current: str, tours: list[dict]) -> dict:
    """Keep a high-water version across downgrades; failed pre-renders remain pending on restart."""
    current_key = version_key(current)
    if current_key is None:
        return {'versions': [], 'pages': []}
    snapshot = {}

    def change(history: dict) -> None:
        high = version_key(history.get('highest'))
        seen = history.get('presented', [])
        seen = {v for v in seen if version_key(v)} if isinstance(seen, list) else set()
        pending = history.get('pending', [])
        pending = {v for v in pending if version_key(v)} if isinstance(pending, list) else set()
        if high is not None and current_key > high:
            pending.update(t['version'] for t in tours if high < release_key(t['version'], current) <= current_key)
        if high is None or current_key > high:
            history['highest'] = current
        history['pending'] = sorted(pending - seen)
        # A downgrade never auto-presents, including content pending from a failed newer launch.
        eligible = pending - seen if high is not None and current_key >= high else set()
        selected = [t for t in tours if t['version'] in eligible]
        ids, pages = set(), []
        for tour in selected:
            for page in tour['pages']:
                if page['id'] not in ids:
                    pages.append(page)
                    ids.add(page['id'])
        snapshot.update(versions=[t['version'] for t in selected], pages=pages)

    state.update_tours(change)
    return snapshot


def presented(state: UiState, versions: list[str], tours: list[dict]) -> None:
    allowed = {t['version'] for t in tours}
    if not isinstance(versions, list) or not versions or any(not isinstance(v, str) or v not in allowed for v in versions):
        raise ServiceError('bad_params', key='versions')

    def change(history: dict) -> None:
        seen = history.get('presented', [])
        seen = {v for v in seen if version_key(v)} if isinstance(seen, list) else set()
        history['presented'] = sorted(seen | set(versions))
        pending = history.get('pending', [])
        history['pending'] = [v for v in pending if isinstance(v, str) and v not in versions] if isinstance(pending, list) else []

    state.update_tours(change)


def register(rpc: Any, services: Any) -> None:
    from ..utils import get_version_info
    from ..i18n import i18n_manager

    def available() -> tuple[str, list[dict]]:
        current = get_version_info().get('version') or ''
        return current, published(current, i18n_manager.lang)

    @rpc.method('app.tours')
    def app_tours(launching: bool = False) -> dict:
        current, tours = available()
        automatic = {'versions': [], 'pages': []}
        if launching and getattr(services, 'tours_ready', False) and not getattr(services, 'safe_mode', False):
            automatic = launch(services.state, current, tours)
        return {'tours': tours, 'automatic': automatic}

    @rpc.method('app.tourPresented')
    def app_tour_presented(versions: list[str]) -> None:
        _, tours = available()
        presented(services.state, versions, tours)
