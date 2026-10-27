"""Synthetic input/merge controls; official pixels are opt-in external fixtures."""
from copy import deepcopy
from dataclasses import replace
import json
import os
from pathlib import Path
import re
import subprocess

import numpy as np
from PIL import Image, ImageDraw
import pytest

from ba_modding_toolkit.refine_composite import compose
from ba_modding_toolkit.refine_cut import Pose
from ba_modding_toolkit.refine_inputs import (InputParameters, InputGateError, choose_key,
    flatten, key_image, templates, prompt, plan_inputs, load_plan, merge_inputs, finish, main, expression_inputs)


def attachment(slot, page, box, name=None, blend=0):
    l, b, r, t = box
    return {'slot': slot, 'attachment': name or slot, 'region': {'page': page, 'name': name or slot},
            'vertices': [l, b, r, b, r, t, l, t], 'uvs': [0, 1, 1, 1, 1, 0, 0, 0],
            'triangles': [0, 1, 2, 2, 3, 0], 'blend': blend}


def fixture():
    body = Image.new('RGBA', (192, 256), (100, 140, 180, 255))
    draw = ImageDraw.Draw(body)
    for x in range(15, 180, 12): draw.line((x, 10, x, 245), fill=(20, 20, 20, 255), width=2)
    alpha = np.zeros((256, 192), np.uint8)
    alpha[8:248, 8:184] = 255
    alpha[8:248, 5:8] = [64, 128, 192]
    body.putalpha(Image.fromarray(alpha))
    face = Image.new('RGBA', (32, 24), (230, 200, 180, 255))
    alternate = face.copy(); ImageDraw.Draw(alternate).line((5, 8, 26, 8), fill=(10, 10, 10, 255), width=2)
    lid = Image.new('RGBA', (32, 24)); ImageDraw.Draw(lid).line((5, 12, 26, 12), fill=(10, 10, 10, 255), width=2)
    pages = {'body.png': body, 'face.png': face, 'alt.png': alternate, 'lid.png': lid,
             'halo.png': Image.new('RGBA', (16, 16), (0, 200, 255, 128))}
    geometry = {'version': 1, 'textureDensity': 1, 'pages': [
        {'name': name, 'width': im.width, 'height': im.height, 'pma': False} for name, im in pages.items()],
        'attachments': [attachment('body', 'body.png', (0, 0, 192, 256)),
                        attachment('face', 'face.png', (64, 170, 96, 194)),
                        attachment('halo', 'halo.png', (60, 210, 100, 230), blend=1)]}
    alt = deepcopy(geometry)
    alt['attachments'][1] = attachment('face', 'alt.png', (64, 170, 96, 194), name='alt')
    alt['attachments'].insert(2, attachment('lid', 'lid.png', (64, 170, 96, 194)))
    return [Pose('base', geometry), Pose('expression', alt)], pages


PARAMS = InputParameters(pixel_budget=16_384, head_context=.25)


def make_plan(tmp_path, **kwargs):
    poses, pages = fixture()
    folder = tmp_path / 'inputs'
    parameters = kwargs.pop('parameters', PARAMS)
    plan = plan_inputs(poses, pages, folder, density=1, frame=(0, 0, 192, 256), parameters=parameters, **kwargs)
    return plan, folder, poses, pages


def test_plan_density_budget_coverage_context_and_shared_expression_frame(tmp_path):
    plan, folder, _, _ = make_plan(tmp_path)
    assert plan['masked_slots'] == ['halo']
    assert plan['switching_slots'] == ['face', 'lid']
    assert plan['page_scale'] == plan['density'] == 1
    heads = [c for c in plan['crops'] if c['role'] == 'head']
    assert len(heads) == 2 and heads[0]['box'] == heads[1]['box']
    assert heads[0]['world_frame'] == heads[1]['world_frame']
    coverage = np.zeros((256, 192), int)
    for c in plan['crops']:
        assert c['density'] >= 1 and abs(c['pixels'] / PARAMS.pixel_budget - 1) < .03
        assert Image.open(folder / c['input']).mode == 'RGB'
        if c['pose'] == 'base':
            l,t,r,b = c['box']; coverage[t:b,l:r] += 1
        assert c['prompt_template']['version'] == 1
    assert coverage.min() > 0 and coverage.max() >= 2
    assert plan['source_hashes'] and (folder / 'crop-plan.png').is_file()
    assert load_plan(folder / 'plan.json') == plan


@pytest.mark.parametrize('changes', [{'overlap': 47}, {'pixel_budget': 100}, {'alpha_snap': 2}, {'overlap': 2.5}])
def test_invalid_parameters_raise(tmp_path, changes):
    poses, pages = fixture()
    with pytest.raises(ValueError):
        plan_inputs(poses, pages, tmp_path, parameters=replace(PARAMS, **changes))


def test_no_switching_slot_and_unknown_masks_raise(tmp_path):
    poses, pages = fixture()
    with pytest.raises(ValueError, match='switching'): plan_inputs(poses[:1], pages, tmp_path)
    with pytest.raises(ValueError, match='mask'): plan_inputs(poses, pages, tmp_path, masked_slots=['unknown'])


def test_repository_output_is_rejected():
    poses, pages = fixture()
    with pytest.raises(ValueError, match='outside'):
        plan_inputs(poses, pages, Path(__file__).resolve().parents[1] / 'forbidden', parameters=PARAMS)


def test_key_identity_soft_alpha_and_no_key_fringe():
    pixels = np.zeros((8, 256, 4), np.uint8)
    pixels[..., :3] = (72, 129, 181)
    pixels[..., 3] = np.arange(256)
    official = Image.fromarray(pixels)
    key, scores = choose_key(official)
    keyed, report = key_image(flatten(official, key), official, key)
    assert keyed.tobytes() == official.tobytes()
    assert report['alpha_rmse_255'] == report['alpha_p99_255'] == 0
    assert max(scores) > 100
    # A global colour wash without connected key background is an opaque edit.
    changed = pixels.copy(); changed[..., 3] = 128
    changed[..., :3] = (72, 129, 181)
    out, _ = key_image(flatten(Image.fromarray(changed), key), official, key)
    a = np.asarray(out).astype(int)
    assert (a[...,3] == 255).all()
    assert np.array_equal(a[..., :3], np.asarray(flatten(Image.fromarray(changed), key)))


def test_candidate_key_must_be_unused():
    values = [(0,255,0,255),(255,0,255,255),(0,255,255,255),(255,128,0,255),(0,0,255,255)]
    with pytest.raises(ValueError, match='distinct'):
        choose_key(Image.fromarray(np.array([values],np.uint8)))


def test_identity_chain_is_byte_exact_including_hidden_and_masked_texels(tmp_path):
    plan, folder, _, pages = make_plan(tmp_path)
    result, report = finish(folder / 'plan.json', folder, tmp_path / 'result')
    assert report['merge']['passed'] and result.report['passed'] and result.report['identity']
    assert all(result.pages[n].tobytes() == im.tobytes() for n, im in pages.items())
    assert all(row['rmse_255'] == 0 for row in report['merge']['overlaps'])


def test_three_pixel_drift_fails_overlap_or_movement_before_cut(tmp_path):
    plan, folder, _, _ = make_plan(tmp_path)
    returns = tmp_path / 'returns'; returns.mkdir()
    shifted = False
    for crop in plan['crops']:
        image = Image.open(folder / crop['input'])
        if crop['role'] == 'body' and not shifted:
            out = Image.new('RGB', image.size, tuple(plan['key_colour'])); out.paste(image, (3,0)); image = out
            shifted = True
        image.save(returns / (crop['id'] + '.png'))
    with pytest.raises(InputGateError) as exc:
        finish(folder / 'plan.json', returns, tmp_path / 'rejected')
    assert any('overlap' in f or 'movement' in f for f in exc.value.report['failures'])
    assert not list((tmp_path / 'rejected').glob('page-*.png'))
    _, report = merge_inputs(folder / 'plan.json', returns, tmp_path / 'diagnostic', diagnostic=True)
    assert not report['passed']


def test_overlap_colour_offset_is_matched_without_changing_backdrop(tmp_path):
    plan,folder,_,_ = make_plan(tmp_path)
    returns = tmp_path/'returns'; returns.mkdir()
    for crop in plan['crops']:
        official = Image.open(folder/crop['official']).convert('RGBA')
        a = np.array(official)
        if crop['role'] == 'body': a[...,:3] = np.clip(a[...,:3].astype(int)+4,0,255)
        flatten(Image.fromarray(a),plan['key_colour']).save(returns/(crop['id']+'.png'))
    targets,report = merge_inputs(folder/'plan.json',returns,tmp_path/'merged',diagnostic=True)
    assert any(max(abs(v) for v in c['colour_offset_255']) > 3 for c in report['crops'].values())
    assert max(c['rmse_255'] for c in report['overlaps']) < 1
    image = Image.open(tmp_path/'merged/merged-0.png')
    assert image.getpixel((0,0)) == tuple(plan['key_colour'])


def test_simulated_return_sizes_have_no_seams_and_real_edits_survive(tmp_path):
    plan,folder,_,_ = make_plan(tmp_path)
    returns = tmp_path/'returns'; returns.mkdir()
    for c in plan['crops']:
        im = Image.open(folder/c['input'])
        w,h = im.size
        im.resize((w-1,h-1),Image.Resampling.LANCZOS).save(returns/(c['id']+'.png'))
    targets,report = merge_inputs(folder/'plan.json',returns,tmp_path/'resized')
    assert report['passed'] and all(c['rmse_255']==0 for c in report['overlaps'])
    official = Image.open(folder/plan['poses'][0]['official'])
    assert targets['base'][0].tobytes() == official.tobytes()
    c = plan['crops'][0]
    im = Image.open(returns/(c['id']+'.png'))
    a = np.array(im)
    h,w = a.shape[:2]; a[h//3:2*h//3,w//3:2*w//3,:] = np.clip(a[h//3:2*h//3,w//3:2*w//3,:].astype(int)+2,0,255)
    Image.fromarray(a).save(returns/(c['id']+'.png'))
    targets,_ = merge_inputs(folder/'plan.json',returns,tmp_path/'edited',diagnostic=True)
    assert targets['base'][0].tobytes() != official.tobytes()


def test_expression_inputs_keep_generated_base_as_fixed_context(tmp_path):
    plan,folder,_,_ = make_plan(tmp_path,parameters=replace(PARAMS,expression_context_radius=2))
    base = Image.open(folder/plan['poses'][0]['official']).convert('RGBA')
    a = np.array(base); a[30:80,30:60,:3] += 2
    base_file = tmp_path/'base.png'; Image.fromarray(a).save(base_file)
    revised = expression_inputs(folder/'plan.json',base_file,tmp_path/'expressions')
    assert revised['base_context_sha256'] and load_plan(tmp_path/'expressions/plan.json') == revised
    crop = next(c for c in revised['crops'] if c['pose']=='expression')
    assert crop['fixed_context'].endswith('-base-context.png')
    assert Image.open(tmp_path/'expressions'/crop['fixed_context']).size == tuple(crop['size'])
    expected = Image.open(tmp_path/'expressions'/crop['official'])
    # The window contains the animated expression; its corner is fixed base context.
    context = Image.open(base_file).crop(crop['box']).resize(expected.size,Image.Resampling.LANCZOS)
    assert expected.getpixel((0,0)) == context.getpixel((0,0))
    assert json.loads((folder/'plan.json').read_text()) == plan
    unchanged_file = folder/plan['poses'][0]['official']
    unchanged = expression_inputs(folder/'plan.json',unchanged_file,tmp_path/'unchanged-context')
    for c in unchanged['crops']:
        assert Image.open(tmp_path/'unchanged-context'/c['input']).tobytes() == Image.open(folder/c['input']).tobytes()


def test_key_quality_gate_rejects_destructive_alpha_snapping(tmp_path):
    _,folder,_,_ = make_plan(tmp_path,parameters=replace(PARAMS,alpha_snap=.5))
    with pytest.raises(InputGateError) as exc:
        merge_inputs(folder/'plan.json',folder,tmp_path/'rejected')
    assert any(f.endswith(':key') for f in exc.value.report['failures'])


def test_real_synthetic_bundle_chain_packs_every_page_and_preserves_metadata(tmp_path):
    from test_atlas_remap import atlas_text, write_bundle
    from ba_modding_toolkit.atlas_remap import read_inputs
    plan,folder,_,pages = make_plan(tmp_path)
    text = atlas_text([(n,im.size,[(Path(n).stem,-1,(0,0),im.size,im.size,(0,0),0)]) for n,im in pages.items()])
    filename = 'assets-_mx-spinecharacters-test_spr-_mxdependency-2026-01-01_003_assets_all_123456.bundle'
    bundle = write_bundle(tmp_path/'official'/filename,{'hero.atlas':text},
                          {Path(n).stem:im for n,im in pages.items()})
    original = bundle.read_bytes()
    result,report = finish(folder/'plan.json',folder,tmp_path/'finished',pack={'bundles':[str(bundle)],'atlas_name':'hero.atlas'})
    decoded = read_inputs([tmp_path/'finished/packed'/filename])
    assert len(report['packed']) == len(pages)
    assert all(decoded.textures[Path(n).stem].tobytes() == im.tobytes() for n,im in result.pages.items())
    assert decoded.atlases == read_inputs([bundle]).atlases
    assert bundle.read_bytes() == original


def test_changed_source_hash_and_aspect_and_translucent_return_raise(tmp_path):
    plan, folder, _, _ = make_plan(tmp_path)
    crop = plan['crops'][0]
    returns = tmp_path / 'returns'; returns.mkdir()
    Image.new('RGB',(128,128)).save(returns/(crop['id']+'.png'))
    with pytest.raises(ValueError, match='aspect'): merge_inputs(folder/'plan.json',returns,tmp_path/'bad')
    Image.new('RGBA',tuple(crop['size']),(1,2,3,128)).save(returns/(crop['id']+'.png'))
    with pytest.raises(ValueError, match='opaque'): merge_inputs(folder/'plan.json',returns,tmp_path/'bad')
    (folder/crop['input']).write_bytes(b'changed')
    with pytest.raises(ValueError, match='artifact'): load_plan(folder/'plan.json')


def test_templates_are_versioned_english_edit_only_and_forbid_wording():
    data = templates()
    assert len(data) == len({(t['id'],t['version']) for t in data}) == 4
    assert {(t['id'], t['version']) for t in data} >= {('detail-crisp-lines', 1), ('detail-crisp-lines', 2)}
    for t in data:
        assert not re.search(r'\b(?:transparen\w*|restor\w*|redesign\w*)\b', t['text'], re.I)
        text = prompt(t['id'],version=t['version'],crop_role='head',pose='01',width=128,height=128,preserve='all features',
                      key_colour='magenta',style_edit='line treatment')
        assert text.startswith('Use case: precise-object-edit.')
        assert 'Repeat:' in text and 'flat and unchanged' in text
    with pytest.raises(ValueError, match='Forbidden'):
        prompt('detail-crisp-lines',crop_role='head',pose='01',width=1,height=1,preserve='redesign',key_colour='green')
    with pytest.raises(ValueError, match='Unknown'): prompt('detail-crisp-lines', version=3)


def test_manifest_plan_and_finish_commands(tmp_path, capsys):
    poses,pages = fixture()
    for i,pose in enumerate(poses): (tmp_path/f'g{i}.json').write_text(json.dumps(pose.geometry))
    for n,im in pages.items(): im.save(tmp_path/n)
    manifest = tmp_path/'manifest.json'
    manifest.write_text(json.dumps({'pages':{n:n for n in pages},'poses':[
        {'name':p.name,'geometry':f'g{i}.json'} for i,p in enumerate(poses)],
        'density':1,'frame':[0,0,192,256],'input_parameters':{'pixel_budget':16384,'head_context':.25}}))
    main(['plan',str(manifest),'--output',str(tmp_path/'inputs')])
    main(['finish',str(tmp_path/'inputs/plan.json'),'--returns',str(tmp_path/'inputs'),'--output',str(tmp_path/'result')])
    assert json.loads((tmp_path/'result/report.json').read_text())['cut']['identity']
    assert '"passed": true' in capsys.readouterr().out


def test_official_cycling_input_identity(tmp_path):
    if not os.environ.get('BAMT_TEST_GAME_DIR'):
        pytest.skip('Set BAMT_TEST_GAME_DIR to a verified official development view')
    from ba_modding_toolkit.atlas_remap import read_inputs, texture_key
    from ba_modding_toolkit.searching import get_search_dirs
    name = 'shiroko_ridingsuit_spr'
    paths = sorted(p for d in get_search_dirs(Path(os.environ['BAMT_TEST_GAME_DIR'])) for p in d.glob(f'assets-_mx-spinecharacters-{name}-*.bundle'))
    if not paths: pytest.skip('Official view has no Shiroko (Cycling)')
    inputs = read_inputs(paths)
    for ext, data in (('.atlas',inputs.atlases),('.skel',inputs.skeletons)):
        (tmp_path/(name+ext)).write_bytes(data[name+ext])
    helper = Path(__file__).parent/'js/helpers/refine-pose.mjs'
    raw = json.loads(subprocess.run(['node',str(helper),str(tmp_path/name),'--poses'],check=True,capture_output=True,text=True).stdout)
    poses = [Pose(p['name'],p['geometry']) for p in raw if p['name'] in ('base','99','blink-1')]
    pages = {p['name']:inputs.textures[texture_key(p['name'])] for p in poses[0].geometry['pages']}
    plan = plan_inputs(poses,pages,tmp_path/'inputs')
    assert set(plan['switching_slots']) == {'00_default','eyeclose'}
    result,report = finish(tmp_path/'inputs/plan.json',tmp_path/'inputs',tmp_path/'result')
    assert report['merge']['passed'] and result.report['identity']
    for n,im in pages.items():
        assert result.pages[n].tobytes() == im.resize((im.width*2,im.height*2),Image.Resampling.NEAREST).tobytes()


def test_overlap_correction_cannot_rehabilitate_original_geometry_drift(tmp_path):
    plan,folder,_,_=make_plan(tmp_path)
    returns=tmp_path/'returns';returns.mkdir()
    moved=next(c['id'] for c in plan['crops'] if c['role']=='body')
    for c in plan['crops']:
        im=Image.open(folder/c['input']).convert('RGB')
        if c['id']==moved:
            shifted=Image.new('RGB',im.size,tuple(plan['key_colour']));shifted.paste(im,(3,0));im=shifted
        im.save(returns/(c['id']+'.png'))
    _,report=merge_inputs(folder/'plan.json',returns,tmp_path/'diagnostic',diagnostic=True)
    assert report['crops'][moved]['movement']['flags']
    affected=[r for r in report['overlaps'] if moved in (r['a'],r['b'])]
    assert affected and all('source_geometry' in r['movement']['flags'] for r in affected)
    assert all(np.linalg.norm(c['applied_shift_native_px'])<=2 for c in report['crops'].values())
    assert not report['passed']
