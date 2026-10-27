"""Synthetic join/cut controls. No game or generated assets are test fixtures."""
from copy import deepcopy
from pathlib import Path
import ast
import json
import os
import subprocess

import numpy as np
from PIL import Image, ImageDraw
import pytest

from ba_modding_toolkit.refine_composite import compose
from ba_modding_toolkit.refine_cut import (cut, Pose, CutParameters, GateError, join_band_gate,
                                           check_invariants, pushpull)


SIZE = 64
FRAME = (0, 0, SIZE, SIZE)


def attachment(slot, page=None, name=None, box=(0, 0, SIZE, SIZE), uv=None, blend=0):
    l, t, r, b = box
    return {'slot': slot, 'attachment': name or slot,
            'region': {'page': page or slot + '.png', 'name': name or slot, 'index': -1},
            'vertices': [l, SIZE-t, r, SIZE-t, r, SIZE-b, l, SIZE-b],
            'uvs': uv or [0, 0, 1, 0, 1, 1, 0, 1], 'triangles': [0, 1, 2, 2, 3, 0], 'blend': blend}


def geometry(*items):
    return {'pages': [{'name': n, 'width': SIZE, 'height': SIZE, 'pma': False}
                      for n in dict.fromkeys(a['region']['page'] for a in items)], 'attachments': list(items)}


def image(colour=(180, 160, 140, 255)):
    return Image.new('RGBA', (SIZE, SIZE), colour)


def run(poses, pages, **kwargs):
    return cut(poses, pages, frame=FRAME, diagnostic=True, **kwargs)


def test_cover_fill_soft_join_has_no_seam_and_keeps_internal_alpha():
    g = geometry(attachment('back'), attachment('front'))
    front = image((40, 80, 120, 255))
    alpha = np.zeros((SIZE, SIZE), np.uint8); alpha[:, :32] = 255
    alpha[:, 32:40] = np.linspace(230, 20, 8).astype(np.uint8)
    front.putalpha(Image.fromarray(alpha))
    pages = {'back.png': image(), 'front.png': front}
    target = image((100, 140, 180, 255))
    result = run([Pose('base', g, target)], pages)
    actual = compose(g, result.pages, frame=FRAME).image
    assert np.max(abs(np.asarray(actual).astype(int) - np.asarray(target).astype(int))) == 0
    assert result.pages['front.png'].getchannel('A').tobytes() == front.getchannel('A').tobytes()
    assert result.pages['back.png'].getpixel((35, 20))[:3] == (100, 140, 180)
    assert result.report['poses'][0]['joins']['front']['passed']


def test_mask_shared_region_freezes_overlapping_uv_polygons_not_rectangles():
    body = attachment('body', 'page.png')
    halo = attachment('halo', 'page.png', 'halo-region', box=(5, 5, 25, 25),
                      uv=[.25, .25, .5, .25, .5, .5, .25, .5], blend=1)
    alias = deepcopy(halo); alias['slot'] = 'normal-halo'; alias['blend'] = 0
    g = geometry(body, halo, alias)
    original = image((20, 30, 40, 150))
    result = run([Pose('base', g, image((200, 210, 220, 255)))], {'page.png': original})
    a, b = np.asarray(result.pages['page.png']), np.asarray(original)
    assert np.array_equal(a[16:32, 16:32], b[16:32, 16:32])
    assert np.any(a[40:60, 40:60] != b[40:60, 40:60])
    assert result.report['masked_slots'] == ['halo', 'normal-halo']
    assert result.report['invariants']['page.png']['masked_changed'] == 0


@pytest.mark.parametrize('grow', [False, True])
def test_silhouette_pass_through_grow_and_shrink_including_opaque_far_content(grow):
    g = geometry(attachment('body'))
    original = image((170, 150, 130, 0)); ImageDraw.Draw(original).rectangle((20, 12, 43, 51), fill=(170, 150, 130, 255))
    target = image((240, 0, 240, 0))
    bounds = (14, 12, 49, 51) if grow else (24, 16, 39, 47)
    ImageDraw.Draw(target).rectangle(bounds, fill=(80, 100, 120, 255))
    result = run([Pose('base', g, target)], {'body.png': original})
    assert result.pages['body.png'].getchannel('A').tobytes() == target.getchannel('A').tobytes()
    assert result.pages['body.png'].getpixel((15, 20) if grow else (24, 20))[:3] == (80, 100, 120)
    assert result.report['poses'][0]['silhouette_iou'] == 1


def overlay_fixture(two=False):
    head = attachment('head'); face = attachment('face', name='default')
    g = geometry(head, face)
    pages = {'head.png': image((210, 190, 170, 255)), 'face.png': image((10, 10, 10, 0)),
             'other.png': image((10, 10, 10, 0))}
    ImageDraw.Draw(pages['face.png']).rectangle((26, 28, 37, 30), fill=(10, 10, 10, 180))
    alt = deepcopy(g); alt['attachments'][1] = attachment('face', 'other.png', 'alternate')
    alt['pages'].append({'name': 'other.png', 'width': SIZE, 'height': SIZE})
    if two:
        g['attachments'].append(attachment('glasses', 'glasses.png', 'glasses-default'))
        alt['attachments'].append(attachment('glasses', 'other-glasses.png', 'glasses-alt'))
        pages['glasses.png'] = image((0, 0, 0, 0)); pages['other-glasses.png'] = image((0, 0, 0, 0))
        for pg in ('glasses.png', 'other-glasses.png'):
            for geom in (g, alt):
                geom['pages'].append({'name': pg, 'width': SIZE, 'height': SIZE})
            ImageDraw.Draw(pages[pg]).rectangle((24, 24, 40, 26), fill=(0, 0, 0, 200))
    return g, alt, pages


def test_overlay_alpha_solve_reproduces_generated_lines():
    g, alt, pages = overlay_fixture()
    target = image((210, 190, 170, 255))
    ImageDraw.Draw(target).rectangle((26, 28, 37, 32), fill=(20, 20, 20, 255))
    result = run([Pose('base', g, target), Pose('other', alt, image((210, 190, 170, 255)))], pages)
    actual = np.asarray(compose(g, result.pages, frame=FRAME).image).astype(int)
    assert np.max(abs(actual[28:33, 26:38, :3] - np.asarray(target)[28:33, 26:38, :3])) <= 1
    assert result.report['layers'][-1]['alpha_raised'] > 0
    assert result.pages['face.png'].getpixel((1, 1))[3] == 0


def test_head_median_rejects_one_poses_spilled_feature():
    g, alt, pages = overlay_fixture()
    third = deepcopy(alt); third['attachments'][1]['attachment'] = 'third'; third['attachments'][1]['region']['name'] = 'third'
    third['attachments'][1]['region']['page'] = 'third.png'; third['pages'].append({'name': 'third.png', 'width': SIZE, 'height': SIZE})
    pages['third.png'] = image((0, 0, 0, 0))
    spilled = image((210, 190, 170, 255)); ImageDraw.Draw(spilled).rectangle((24, 32, 39, 34), fill=(0, 0, 0, 255))
    result = run([Pose('base', g, spilled), Pose('alt', alt, image((210, 190, 170, 255))),
                  Pose('third', third, image((210, 190, 170, 255)))], pages)
    assert result.pages['head.png'].getpixel((30, 33)) == (210, 190, 170, 255)
    assert result.report['head_median_texels']['head'] > 0


def test_idle_reveal_uses_same_parts_nearest_edited_colour():
    g = geometry(attachment('head'), attachment('cover', box=(24, 0, 64, 64)))
    idle = deepcopy(g)
    idle['attachments'][1]['vertices'] = [40, 64, 80, 64, 80, 0, 40, 0]
    pages = {'head.png': image((90, 80, 70, 255)), 'cover.png': image((100, 100, 100, 255))}
    target = image((180, 160, 140, 255))
    result = run([Pose('base', g, target), Pose('idle', idle)], pages)
    assert result.report['poses'][1]['revealed']['head'] == 16 * 64
    assert result.pages['head.png'].getpixel((32, 20))[:3] == (180, 160, 140)
    assert result.report['swappable_slots'] == []


def test_two_overlapping_swappable_slots_solve_in_draw_order():
    g, alt, pages = overlay_fixture(two=True)
    for pg in ('glasses.png', 'other-glasses.png'):
        pages[pg] = image((0, 0, 0, 0))
        ImageDraw.Draw(pages[pg]).rectangle((24, 28, 40, 30), fill=(0, 0, 0, 200))
    target = image((210, 190, 170, 255))
    ImageDraw.Draw(target).rectangle((26, 28, 37, 32), fill=(20, 20, 20, 255))
    ImageDraw.Draw(target).rectangle((24, 28, 40, 31), fill=(30, 30, 30, 255))
    result = run([Pose('base', g, target), Pose('alt', alt, image((210, 190, 170, 255)))], pages)
    assert result.report['swappable_slots'] == ['face', 'glasses']
    assert [x['slot'] for x in result.report['layers'][-2:]] == ['face', 'glasses']
    actual = np.asarray(compose(g, result.pages, frame=FRAME).image).astype(int)
    assert np.max(abs(actual[24:33, 24:41, :3] - np.asarray(target)[24:33, 24:41, :3])) <= 1


def test_bleed_protects_unedited_polygons_plus_two_texels():
    body = attachment('body', 'page.png'); body['triangles'] = [0, 1, 2]
    halo = attachment('halo', 'page.png', 'halo', box=(0, 0, 16, 16),
                      uv=[0, .7, .2, .7, .2, .9, 0, .9], blend=1)
    g = geometry(body, halo)
    page = image((8, 9, 10, 0)); ImageDraw.Draw(page).rectangle((30, 5, 60, 25), fill=(180, 160, 140, 255))
    result = run([Pose('base', g, image((200, 190, 180, 255)))], {'page.png': page})
    assert result.pages['page.png'].getpixel((8, 50)) == page.getpixel((8, 50))
    assert result.pages['page.png'].getpixel((14, 50)) == page.getpixel((14, 50))
    assert result.pages['page.png'].getpixel((20, 50))[:3] != page.getpixel((20, 50))[:3]
    assert result.report['invariants']['page.png']['outside_changed'] == 0


def test_join_gate_pass_and_fail_with_same_detail_reference():
    target = image((100, 100, 100, 255)); rendered = image((110, 110, 110, 255))
    band = np.zeros((SIZE, SIZE), bool); band[:, 30:34] = True
    ref = np.ones_like(band)
    check = join_band_gate(rendered, target, {'join': band}, ref)['join']
    assert check['ratio'] == pytest.approx(1) and check['passed']
    rendered.paste((130, 130, 130, 255), (30, 0, 34, SIZE))
    check = join_band_gate(rendered, target, {'join': band}, ref)['join']
    assert check['ratio'] == pytest.approx(3) and not check['passed']
    transparent = target.copy(); transparent.putalpha(0)
    assert join_band_gate(rendered, transparent, {'join': band}, ref)['join']['passed']


def test_invariant_gates_pass_and_fail():
    base = {'p': image()}; empty = {'p': np.zeros((SIZE, SIZE), bool)}
    full = {'p': np.ones((SIZE, SIZE), bool)}
    assert not any(check_invariants(base, base, empty, full, full)['p'][k] for k in ('masked_changed', 'outside_changed', 'alpha_outside_mesh'))
    changed = {'p': image()}; changed['p'].putpixel((20, 20), (0, 0, 0, 0))
    bad = check_invariants(changed, base, full, empty, empty)['p']
    assert bad['masked_changed'] == bad['outside_changed'] == bad['alpha_outside_mesh'] == 1


def test_silhouette_and_pose_rmse_gates_raise_unless_diagnostic(tmp_path):
    g = geometry(attachment('body', box=(16, 16, 48, 48)))
    poses = [Pose('base', g, image())]
    with pytest.raises(GateError, match='silhouette'):
        cut(poses, {'body.png': image()}, frame=FRAME)
    result = run(poses, {'body.png': image()}, review_dir=tmp_path)
    assert not result.report['passed'] and list(tmp_path.glob('*.png'))
    # Target pixels outside mesh coverage remain measurable errors.
    with pytest.raises(GateError, match='rmse'):
        cut([Pose('base', g, image((255, 255, 255, 255)))], {'body.png': image()}, frame=FRAME,
            parameters=CutParameters(min_iou=0, max_pose_rmse=1))


def test_unknown_mask_and_noncoincident_shared_region_fail():
    g = geometry(attachment('body'))
    with pytest.raises(ValueError, match='Unknown masked'):
        run([Pose('base', g, image())], {'body.png': image()}, masked_slots=['absent'])
    other = attachment('other', 'body.png', 'body', box=(8, 8, 60, 60))
    with pytest.raises(ValueError, match='different places'):
        run([Pose('base', geometry(g['attachments'][0], other), image())], {'body.png': image()})


def test_push_pull_upsampling_is_bilinear():
    values = np.zeros((9, 9, 3), np.float32); values[:, -1] = 1
    valid = np.zeros((9, 9), bool); valid[:, [0, -1]] = True
    filled = pushpull(values, valid)
    assert np.unique(filled[4, :, 0]).size > 4


def test_shipped_paths_do_not_import_optional_refine_modules():
    root = Path(__file__).resolve().parents[1] / 'src' / 'ba_modding_toolkit'
    for path in root.rglob('*.py'):
        if path.stem.startswith('refine_'): continue
        for node in ast.walk(ast.parse(path.read_text())):
            if isinstance(node, ast.Import): names = [a.name for a in node.names]
            elif isinstance(node, ast.ImportFrom): names = [node.module or '', *[a.name for a in node.names]]
            else: continue
            assert not any('refine_' in name for name in names), path
    for path in (root / 'web' / 'js').glob('*.js'):
        if path.name == 'refine-composite.js': continue
        assert 'refine-composite' not in path.read_text(), path


def test_official_animation_state_every_listed_pose(tmp_path):
    if not os.environ.get('BAMT_TEST_GAME_DIR'):
        pytest.skip('Set BAMT_TEST_GAME_DIR to a verified official development view')
    from ba_modding_toolkit.atlas_remap import read_inputs
    from ba_modding_toolkit.searching import get_search_dirs
    name = 'shiroko_ridingsuit_spr'
    paths = sorted(p for folder in get_search_dirs(Path(os.environ['BAMT_TEST_GAME_DIR']))
                   for p in folder.glob(f'assets-_mx-spinecharacters-{name}-*.bundle'))
    if not paths: pytest.skip('Official view has no Shiroko (Cycling)')
    inputs = read_inputs(paths)
    for ext in ('.atlas', '.skel'):
        (tmp_path / (name + ext)).write_bytes((inputs.atlases if ext == '.atlas' else inputs.skeletons)[name + ext])
    helper = Path(__file__).parent / 'js' / 'helpers' / 'refine-pose.mjs'
    result = subprocess.run(['node', str(helper), str(tmp_path / name), '--poses'], capture_output=True, text=True, check=True)
    poses = json.loads(result.stdout)
    assert {'base', '99', 'blink-0', 'idle-0'} <= {p['name'] for p in poses}
    assert len(poses) >= 19
    for pose in poses:
        assert pose['geometry']['attachments']
        assert all(np.isfinite(a['vertices']).all() for a in pose['geometry']['attachments'])


def test_common_root_translation_reveals_no_texels_and_identity_is_exact():
    from ba_modding_toolkit.refine_cut import revealed_texels
    g = geometry(attachment('back'), attachment('front', box=(24, 0, 64, 64)))
    shifted = deepcopy(g)
    for a in shifted['attachments']:
        a['vertices'] = [v + (.46117 if i % 2 else 0) for i, v in enumerate(a['vertices'])]
    pages = {'back.png': image(), 'front.png': image((10, 20, 30, 128))}
    counts = revealed_texels([Pose('base', g), Pose('idle', shifted)], pages)
    assert counts[1]['revealed_texels'] == 0
    result = run([Pose('base', g, image((120, 130, 140, 255))), Pose('idle', shifted)], pages)
    assert result.report['poses'][1]['revealed_texels'] == 0
    assert result.report['untargeted_filled']['back'] == 0
    target = compose(g, pages, frame=FRAME).image
    result = run([Pose('base', g, target)], pages)
    assert result.report['identity']
    assert all(result.pages[name].tobytes() == original.tobytes() for name, original in pages.items())


def test_manifest_command_writes_only_to_external_folder(tmp_path, capsys):
    from ba_modding_toolkit.refine_cut import main
    g = geometry(attachment('body'))
    (tmp_path / 'g.json').write_text(json.dumps(g))
    image().save(tmp_path / 'official.png'); image((100, 120, 140, 255)).save(tmp_path / 'target.png')
    spec = {'pages': {'body.png': 'official.png'}, 'frame': FRAME,
            'poses': [{'name': 'base', 'geometry': 'g.json', 'target': 'target.png'}]}
    manifest = tmp_path / 'run.json'; manifest.write_text(json.dumps(spec))
    main([str(manifest), '--output', str(tmp_path / 'result')])
    report = json.loads((tmp_path / 'result' / 'report.json').read_text())
    assert report['passed'] and (tmp_path / 'result' / report['page_files']['body.png']).exists()
    assert (tmp_path / 'result' / 'page-0-meshes.png').exists()


def test_strict_overlay_excludes_five_pixel_boundary_and_defaults_match_reference():
    g, alt, pages = overlay_fixture()
    # Draw features close enough to the left mesh boundary to exercise the exclusion.
    ImageDraw.Draw(pages['face.png']).rectangle((2, 20, 12, 22), fill=(10, 10, 10, 120))
    target = image((210, 190, 170, 255))
    ImageDraw.Draw(target).rectangle((1, 20, 14, 24), fill=(0, 0, 0, 255))
    poses = [Pose('base', g, target), Pose('alt', alt, image((210, 190, 170, 255)))]
    strict = run(poses, pages, parameters=CutParameters.strict())
    reference = run(poses, pages, parameters=CutParameters.r1b_reference())
    default = run(poses, pages)
    assert all(default.pages[n].tobytes() == reference.pages[n].tobytes() for n in reference.pages)
    original = np.asarray(pages['face.png'])[..., 3]
    actual = np.asarray(strict.pages['face.png'])[..., 3]
    assert np.array_equal(actual[:, :5], original[:, :5])
    assert np.any(np.asarray(reference.pages['face.png'])[:, :5, 3] > original[:, :5])


def test_strict_bleed_uses_existing_nearest_colour_without_averaging():
    a = attachment('body'); a['triangles'] = [0, 1, 2]
    g = geometry(a)
    page = image((0, 0, 0, 0))
    ImageDraw.Draw(page).rectangle((20, 2, 30, 10), fill=(255, 0, 0, 255))
    ImageDraw.Draw(page).rectangle((40, 2, 50, 10), fill=(0, 0, 255, 255))
    target = compose(g, {'body.png': page}, frame=FRAME).image.copy()
    # A real RGB change avoids the exact identity shortcut.
    target.putpixel((25, 5), (250, 0, 0, 255))
    result = run([Pose('base', g, target)], {'body.png': page}, parameters=CutParameters.strict())
    seeds = {tuple(c) for c in np.asarray(result.pages['body.png'])[..., :3][np.asarray(result.pages['body.png'])[..., 3] > 0]}
    colour = result.pages['body.png'].getpixel((30, 60))[:3]
    assert colour in seeds
