"""Synthetic affine/overlap controls, plus opt-in official binary pose checks."""
import json
import os
from pathlib import Path
import subprocess

import numpy as np
from PIL import Image, ImageDraw
import pytest

from ba_modding_toolkit.refine_composite import compose, project, movement_check


def geometry(overlap=False, blend=0, tint=None):
    def attachment(name, page, vertices):
        return {'slot': name, 'attachment': name, 'region': {'page': page, 'name': name, 'index': -1},
                'vertices': vertices, 'uvs': [0, 0, 1, 0, 1, 1, 0, 1], 'triangles': [0, 1, 2, 2, 3, 0],
                'blend': blend if name == 'front' else 0, 'slotColor': tint or [1, 1, 1, 1]}
    a = [attachment('back', 'back.png', [0, 16, 16, 16, 16, 0, 0, 0])]
    if overlap:
        a.append(attachment('front', 'front.png', [8, 16, 24, 16, 24, 0, 8, 0]))
    return {'pages': [{'name': n, 'width': 16, 'height': 16, 'pma': False} for n in ['back.png', 'front.png']], 'attachments': a}


def pages(alpha=255):
    return {'back.png': Image.new('RGBA', (16, 16), (60, 100, 140, alpha)),
            'front.png': Image.new('RGBA', (16, 16), (180, 80, 40, alpha))}


@pytest.mark.parametrize('scale', [1, 2])
@pytest.mark.parametrize('pma', [False, True])
def test_identity_is_byte_exact_everywhere_with_overlap_and_partial_alpha(scale, pma):
    g, p = geometry(True), pages(128)
    for spec in g['pages']:
        spec['pma'] = pma
    p = {k: v.resize((16 * scale, 16 * scale), Image.Resampling.NEAREST) for k, v in p.items()}
    c = compose(g, p, density=scale, frame=(0, 0, 24, 16))
    out, report = project(c, c.image)
    assert all(out[k].tobytes() == p[k].tobytes() for k in p)
    assert all(a['visible']['rgb_rmse'] == 0 for a in report['attachments'])


def test_visible_projection_covered_and_undrawn_pixels_and_draw_order():
    g, p = geometry(True), pages()
    c = compose(g, p, frame=(0, 0, 24, 16))
    back, front = c.inverse
    assert back['visible'].sum() == 128 and front['visible'].sum() == 256
    assert c.image.getpixel((12, 5)) == (180, 80, 40, 255)
    target = c.image.copy();target.paste((100, 110, 120, 255), (0, 0, 24, 16))
    out, report = project(c, target, band_width=0, allow_flagged=True)
    assert out['back.png'].getpixel((3, 3)) == (100, 110, 120, 255)
    assert out['back.png'].getpixel((12, 3)) == p['back.png'].getpixel((12, 3))
    assert out['front.png'].getpixel((3, 3)) == (100, 110, 120, 255)
    assert report['attachments'][0]['covered_or_off_frame'] == 128
    g['attachments'].reverse()
    assert compose(g, p, frame=c.frame).image.getpixel((12, 5)) == (60, 100, 140, 255)


@pytest.mark.parametrize('mode', [0, 1, 2, 3])
def test_runtime_blend_factors_and_tint(mode):
    g, p = geometry(True, mode, [.5, .75, 1, .5]), pages()
    c = compose(g, p, frame=(0, 0, 24, 16))
    src = np.array([180/255*.5, 80/255*.75, 40/255, .5]);src[:3] *= src[3]
    dst = np.array([60/255*.5, 100/255*.75, 140/255, .5]);dst[:3] *= dst[3]
    expected = [src + dst*(1-src[3]), src+dst, src*dst+dst*(1-src[3]), src+dst*(1-src)][mode]
    expected = np.clip(expected, 0, 1);expected[:3] /= expected[3]
    assert np.max(abs(np.array(c.image.getpixel((12, 5))) - np.rint(expected*255))) <= 1


def test_pma_matches_straight_for_exactly_representable_source():
    g, p = geometry(), pages(128)
    p['back.png'] = Image.new('RGBA', (16, 16), (100, 50, 0, 128))
    straight = compose(g, p).image
    p['back.png'] = Image.new('RGBA', (16, 16), (50, 25, 0, 128));g['pages'][0]['pma'] = True
    actual = compose(g, p).image
    assert np.max(abs(np.asarray(straight).astype(int)-np.asarray(actual).astype(int))) <= 1


def test_edge_and_visibility_bands_in_official_pixels_at_both_densities():
    for scale in [1, 2]:
        g, p = geometry(True), pages()
        p = {k: v.resize((16*scale, 16*scale), Image.Resampling.NEAREST) for k,v in p.items()}
        c = compose(g, p, density=scale, frame=(0, 0, 24, 16))
        target = Image.new('RGBA', c.image.size, (200, 200, 200, 255))
        out, report = project(c, target, band_width=3, allow_flagged=True)
        assert out['back.png'].getpixel((0, 8*scale)) == p['back.png'].getpixel((0, 8*scale))
        assert out['back.png'].getpixel((7*scale+scale-1, 8*scale)) == p['back.png'].getpixel((7*scale+scale-1, 8*scale))
        assert out['back.png'].getpixel((4*scale, 8*scale))[:3] != p['back.png'].getpixel((4*scale, 8*scale))[:3]
        assert 0 < report['attachments'][0]['edge_band']['pixels'] < report['attachments'][0]['visible']['pixels']
        assert report['attachments'][0]['seam_band']['pixels'] > 0
        assert out['back.png'].getpixel((4*scale, 8*scale))[:3] == (200,200,200)
        assert all(out[k].getchannel('A').tobytes() == p[k].getchannel('A').tobytes() for k in p)


def test_off_frame_texels_and_unused_page_are_byte_exact():
    g, p = geometry(), pages()
    c = compose(g, p, frame=(4, 0, 12, 16))
    target = Image.new('RGBA', (31, 57), (200, 150, 30, 255))
    out, _ = project(c, target, band_width=0, allow_flagged=True)
    assert out['front.png'].tobytes() == p['front.png'].tobytes()
    assert out['back.png'].crop((0, 0, 4, 16)).tobytes() == p['back.png'].crop((0, 0, 4, 16)).tobytes()


def test_movement_check_catches_silhouette_and_internal_feature_drift():
    a = Image.new('RGBA', (100, 80));ImageDraw.Draw(a).rectangle((5, 5, 90, 70), fill='white')
    ImageDraw.Draw(a).rectangle((25, 15, 28, 60), fill='black')
    b = Image.new('RGBA', a.size);b.paste(a, (20, 0))
    assert 'silhouette_moved' in movement_check(a, b)['flags']
    b = a.copy();ImageDraw.Draw(b).rectangle((25,15,28,60),fill='white');ImageDraw.Draw(b).rectangle((50,15,53,60),fill='black')
    assert 'features_moved' in movement_check(a, b)['flags']
    c = compose(geometry(), pages())
    with pytest.raises(ValueError, match='moved'):
        project(c, Image.new('RGBA', c.image.size))


def test_optional_colour_match_removes_constant_join_bias():
    c = compose(geometry(), pages(), frame=(0, 0, 16, 16))
    out, _ = project(c, Image.new('RGBA', c.image.size, (80, 120, 160, 255)), colour_match=True, allow_flagged=True)
    assert out['back.png'].tobytes() == c.pages['back.png'].tobytes()


def test_invalid_geometry_or_density_is_refused():
    with pytest.raises(ValueError): compose(geometry(), pages(), density=0)
    g=geometry();g['attachments'][0]['vertices'][0]=float('nan')
    with pytest.raises(ValueError): compose(g, pages())


def test_official_binary_composite_identity_and_every_expression(tmp_path):
    if not os.environ.get('BAMT_TEST_GAME_DIR'):
        pytest.skip('Set BAMT_TEST_GAME_DIR to a verified official development view')
    from ba_modding_toolkit.atlas_remap import read_inputs
    from ba_modding_toolkit.searching import get_search_dirs
    paths = sorted(p for d in get_search_dirs(Path(os.environ['BAMT_TEST_GAME_DIR'])) for p in d.glob('assets-_mx-spinecharacters-shiroko_ridingsuit_spr-*.bundle'))
    if not paths: pytest.skip('Official view has no Shiroko (Cycling)')
    inputs=read_inputs(paths);name='shiroko_ridingsuit_spr'
    (tmp_path/(name+'.atlas')).write_bytes(inputs.atlases[name+'.atlas'])
    (tmp_path/(name+'.skel')).write_bytes(inputs.skeletons[name+'.skel'])
    helper=Path(__file__).parent/'js/helpers/refine-pose.mjs'
    def pose(replace):
        result=subprocess.run(['node',str(helper),str(tmp_path/name),json.dumps(replace)],check=True,capture_output=True,text=True)
        return json.loads(result.stdout)
    g=pose({});p={spec['name']:inputs.textures[Path(spec['name']).stem] for spec in g['pages']}
    c=compose(g,p);out,_=project(c,c.image)
    assert c.image.width>500 and c.image.height>900
    assert all(out[k].tobytes()==p[k].tobytes() for k in p)
    choices=[x for x in g['choices'] if x['slot']=='00_default']
    assert len(choices)==7
    for choice in choices:
        posed=pose({choice['slot']:choice['attachment']})
        assert any(a['slot']==choice['slot'] and a['attachment']==choice['attachment'] for a in posed['attachments'])
    closed=pose({'00_default':None,'eyeclose':'eyeclose'})
    assert any(a['slot']=='eyeclose' for a in closed['attachments'])


@pytest.mark.parametrize('rotation', [0, 1, 2, 3])
def test_rotated_uv_mesh_inverse_and_only_selected_slot_changes(rotation):
    g,p=geometry(True),pages()
    uv=np.array(g['attachments'][0]['uvs']).reshape(-1,2)
    for _ in range(rotation): uv=np.stack((uv[:,1],1-uv[:,0]),axis=1)
    g['attachments'][0]['uvs']=uv.ravel().tolist()
    # A single triangle leaves half the attachment's page unused.
    g['attachments'][0]['triangles']=[0,1,2]
    c=compose(g,p,frame=(0,0,24,16));target=Image.new('RGBA',c.image.size,(150,150,150,255))
    out,_=project(c,target,band_width=0,allow_flagged=True,only_slots={'back'})
    assert out['front.png'].tobytes()==p['front.png'].tobytes()
    before,after=np.array(p['back.png']),np.array(out['back.png'])
    m=c.inverse[0];allowed=np.zeros((16,16),bool);allowed[m['y'][m['visible']],m['x'][m['visible']]]=True
    assert (before[~allowed]==after[~allowed]).all()
    assert np.any(before[allowed]!=after[allowed])
    assert all(np.isfinite(m['xy']).ravel())



def test_coincident_normal_and_additive_instances_share_the_colour_derivative():
    g=geometry(True,1);g['attachments'][1]['region']['page']='back.png'
    g['attachments'][1]['vertices']=g['attachments'][0]['vertices'][:]
    p=pages(128);p['back.png']=Image.new('RGBA',(16,16),(40,60,80,128))
    c=compose(g,p,frame=(0,0,16,16));target=Image.new('RGBA',c.image.size,(50,70,90,c.image.getpixel((8,8))[3]))
    out,_=project(c,target,band_width=0,allow_flagged=True)
    actual=compose(g,out,frame=c.frame).image
    assert np.max(abs(np.array(actual).astype(int)-np.array(target).astype(int)))<=1


def test_a_saturated_colour_channel_does_not_hide_other_visible_channels():
    g=geometry(True,1);p=pages();p['front.png']=Image.new('RGBA',(16,16),(255,0,0,255))
    c=compose(g,p,frame=(0,0,24,16))
    m=c.inverse[1];assert m['visible'].all()
    target=c.image.copy();target.paste((255,130,160,255),(8,0,24,16))
    out,_=project(c,target,band_width=0,allow_flagged=True)
    assert out['front.png'].getpixel((4,8))[1]>0
    assert out['back.png'].getchannel('A').tobytes()==p['back.png'].getchannel('A').tobytes()
