"""Tracked synthetic calibration: thresholds are fixed by explicit failure cases."""
from dataclasses import replace

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import pytest

from ba_modding_toolkit.refine_stitch import (minimum_seam, seam_mask, stitch,
    double_edge_count, native_movement, gross_disagreement, fringe_gate, nearest_inside)
from ba_modding_toolkit.refine_inputs import InputParameters, key_image, flatten, crop_boxes, prompt
from ba_modding_toolkit.refine_cut import join_band_gate


def drawing():
    im = Image.new('RGBA', (128, 128), (130, 150, 170, 255))
    d = ImageDraw.Draw(im)
    for x, y in ((20, 20), (44, 35), (70, 65), (25, 95)):
        d.rectangle((x, y, x + 16, y + 8), fill=(25, 30, 40, 255))
    return im


def test_dynamic_seam_avoids_disagreeing_line():
    cost = np.ones((20, 60))
    cost[5:14] = 500
    cost[16] = 0
    assert np.all(minimum_seam(cost) == 16)
    a = np.full((20, 60, 3), 180, np.float32)
    b = a.copy(); a[8] = 0; b[11] = 0
    weight, band, path = seam_mask(a, b)
    assert not np.isin(path, (8, 9, 11, 12)).any()
    assert not (((weight > 0) & (weight < 1)) & (np.max(abs(a - b), axis=-1) > 6)).any()
    with pytest.raises(ValueError): minimum_seam(np.array([[np.nan]]))


def test_merge_selects_one_line_and_double_edge_control_rejects_crossfade():
    a = np.full((48, 80, 3), 180, np.float32)
    b = a.copy(); a[18] = 0; b[22] = 0
    covered = np.zeros((48, 80), bool); covered[:32] = True
    merged, band, paths, ownership = stitch(a, b, covered)
    assert paths and double_edge_count(a, b, merged, band) == 0
    assert sum(np.mean(merged[:, :, 0], axis=1) < 100) == 1
    crossfade = (a + b) / 2
    assert double_edge_count(a, b, crossfade, np.ones(covered.shape, bool)) > 0
    assert ((ownership == 0) | (ownership == 1) | (np.max(abs(a-b),axis=-1) <= 6)).all()


def test_head_uses_perimeter_seams_and_retains_context():
    a = np.full((80, 100, 3), 100, np.float32); b = a + 2
    merged, band, paths, weight = stitch(a, b, np.ones((80,100),bool), head=True, feather=12)
    assert len(paths) == 4 and band.any()
    assert weight[40,50] == 1 and weight[0,0] < .5
    assert np.all(merged[40,50] == b[40,50])


def test_nearest_fill_uses_spatial_interior_without_wraparound():
    a = np.zeros((8, 9, 3), np.float32); seeds = np.zeros((8,9),bool)
    seeds[3,4] = True; a[3,4] = (90,120,150)
    out, missing = nearest_inside(a, seeds, ~seeds)
    assert missing == 0 and np.all(out == (90,120,150))


def test_despill_has_no_alpha_amplification_and_preserves_identity():
    a = np.zeros((32,32,4),np.uint8); a[...,:3] = (72,129,181)
    a[4:28,4:28,3] = 255; a[4:28,3,3] = 100
    official = Image.fromarray(a); key=(255,0,255)
    opaque=flatten(official,key)
    exact,_=key_image(opaque,official,key)
    assert exact.tobytes() == official.tobytes()
    c=np.array(opaque); c[4:28,3] = (190,48,219)
    out,_=key_image(Image.fromarray(c),official,key)
    edge=np.asarray(out)[4:28,3,:3].astype(int)
    assert np.max(abs(edge - (72,129,181))) <= 3
    # Complementary green cannot exceed both the observation and interior.
    assert edge[:,1].max() <= 132


@pytest.mark.parametrize('change', ['shift','part'])
def test_native_movement_accepts_sharpening_rejects_drift_and_moved_part(change):
    original=drawing(); soft=original.filter(ImageFilter.GaussianBlur(.5))
    assert not native_movement(soft,original,density=1)['flags']
    changed=original.copy()
    if change=='shift':
        changed=Image.new('RGBA', original.size, (130,150,170,255)); changed.paste(original,(3,0))
    else:
        d=ImageDraw.Draw(changed); d.rectangle((70,65,86,73),fill=(130,150,170,255))
        d.rectangle((78,73,94,81),fill=(25,30,40,255))
    assert native_movement(original,changed,density=1)['flags']


def test_overlap_gross_gate_accepts_line_variation_rejects_missing_part():
    a=np.full((64,128,3),180,np.float32); b=a.copy()
    a[:,30:32]=0; b[:,32:34]=0
    visible=np.ones((64,128),bool)
    assert gross_disagreement(a,b,visible)['passed']
    b[:32,:64]=0
    assert not gross_disagreement(a,b,visible)['passed']


def test_seam_band_gate_accepts_uniform_error_rejects_local_join_fault():
    reference=Image.new('RGBA',(128,128),(120,140,160,255))
    a=np.array(reference); a[...,:3] += 4
    band=np.zeros((128,128),bool); band[60:66]=True
    support=np.ones((128,128),bool)
    a[~band,:3] += 4
    assert join_band_gate(Image.fromarray(a),reference,{'seam':band},support)['seam']['passed']
    a[band,:3] += 40
    assert not join_band_gate(Image.fromarray(a),reference,{'seam':band},support)['seam']['passed']


def test_fringe_gate_accepts_identity_rejects_green_and_colour_spike():
    a=np.zeros((48,48,4),np.uint8); a[...,:3]=(100,120,150)
    a[8:40,8:40,3]=255; a[8:40,7,3]=100
    reference=Image.fromarray(a.copy())
    assert fringe_gate(reference,(255,0,255),reference=reference)['passed']
    a[8:40,7,:3]=(20,230,30)
    failed=fringe_gate(Image.fromarray(a),(255,0,255),reference=reference)
    assert not failed['passed'] and failed['excess_complement_share'] > .02
    assert failed['excess_distance_p95_255'] > 48


def test_new_plan_boundaries_seek_flat_areas_with_budget_and_coverage():
    p=InputParameters(pixel_budget=16_384)
    im=Image.new('RGBA',(192,256),(150,150,150,255));d=ImageDraw.Draw(im)
    for y in range(48,180,4):d.line((0,y,191,y),fill='black')
    boxes=crop_boxes(im.size,(50,20,90,60),p,im)
    coverage=np.zeros((256,192),bool)
    for _,(l,t,r,b) in boxes[1:]:
        assert (r-l)*(b-t) <= p.pixel_budget
        coverage[t:b,l:r]=True
    assert coverage.all()


def test_prompt_v2_keeps_v1_and_forbids_wording_at_fill_time():
    fields=dict(crop_role='head',pose='base',width=1311,height=1201,
                preserve='all existing features and their exact coordinates',key_colour='RGB(255, 0, 255)')
    v1=prompt('detail-crisp-lines',version=1,**fields)
    v2=prompt('detail-crisp-lines',version=2,**fields)
    assert 'Do not add outlines' not in v1
    assert 'between colour areas where the input has none' in v2 and 'including eye highlights' in v2
    for version in (1,2):
        for forbidden in ('transparent','restore','redesign'):
            with pytest.raises(ValueError,match='Forbidden'):
                prompt('detail-crisp-lines',version=version,**{**fields,'preserve':forbidden})


def test_outline_matte_preserves_neutral_interior_and_softens_only_outer_band():
    from ba_modding_toolkit.refine_stitch import frame_background
    official=Image.new('RGBA',(128,128))
    ImageDraw.Draw(official).rectangle((16,16,111,111),fill=(180,180,180,255))
    c=np.asarray(flatten(official,(255,0,255))).copy()
    c[50:60,50:60]=(142,140,143);c[65:75,65:75]=(69,67,98)
    c[30:90,15]=(195,90,195)
    out,_=key_image(Image.fromarray(c),official,(255,0,255))
    a=np.asarray(out)
    for box in ((50,50,60,60),(65,65,75,75)):
        l,t,r,b=box
        assert (a[t:b,l:r,3] == 255).all()
        assert np.array_equal(a[t:b,l:r,:3],c[t:b,l:r])
    key=np.max(abs(c.astype(float)-(255,0,255)),axis=-1)<=32
    connected=frame_background(key)
    allowed=np.asarray(Image.fromarray(np.uint8(connected)*255).filter(ImageFilter.MaxFilter(7)))>0
    assert not (((a[...,3]>0)&(a[...,3]<255))&~allowed).any()
    soft=(a[...,3]>0)&(a[...,3]<255)&(a[...,3]>=128)
    # Chroma cleanup may also act at alpha 1, without RGB amplification.
    removed=c.astype(float)-a[...,:3]
    assert (removed[soft,0] >= 0).all()
    assert (removed[soft,2] >= 0).all()
    assert np.array_equal(a[soft,1],c[soft,1])


def test_frame_background_uses_connectivity_not_neutral_colour():
    from ba_modding_toolkit.refine_stitch import frame_background
    mask=np.ones((20,20),bool);mask[3:17,3:17]=False;mask[8:12,8:12]=True
    connected=frame_background(mask)
    assert connected[0,0] and not connected[9,9]
    mask[0:9,9]=True
    assert frame_background(mask)[9,9]


def test_rigid_subpixel_estimator_corrects_shift_and_retains_identity():
    from ba_modding_toolkit.refine_stitch import estimate_translation,translate_rgb
    a=np.asarray(drawing())[...,:3].astype(np.float32)
    assert np.array_equal(translate_rgb(a,(0,0)),a)
    b=translate_rgb(a,(.75,-.5),fill=(130,150,170))
    visible=np.ones(a.shape[:2],bool)
    estimated=estimate_translation(a,b,visible)
    assert np.linalg.norm(np.array(estimated['shift_native'])-(-.75,.5)) < .4
    corrected=translate_rgb(b,estimated['shift_native'],fill=(130,150,170))
    assert np.linalg.norm(estimate_translation(a,corrected,visible)['shift_native']) <= .5


def test_nearest_colour_accepts_existing_dark_ink_rejects_green_outlier():
    from ba_modding_toolkit.refine_stitch import nearest_colour
    rgb=np.full((24,24,3),220,np.float32);rgb[10,10]=(30,30,30);rgb[10,14]=(30,30,30)
    seeds=np.zeros((24,24),bool);seeds[10,11]=True;seeds[10,14]=True
    query=np.zeros((24,24),bool);query[10,10]=True
    closest,matched=nearest_colour(rgb,seeds,query)
    assert matched[10,10] and np.array_equal(closest[10,10],rgb[10,10])
    rgb[10,10]=(20,220,20)
    closest,_=nearest_colour(rgb,seeds,query)
    assert np.linalg.norm(closest[10,10]-rgb[10,10]) > 48


def test_contour_rate_accepts_isolated_junctions_rejects_sustained_double_line():
    length=1000.
    assert 20/length <= InputParameters().contour_rate
    a=np.full((48,80,3),180,np.float32);b=a.copy();a[18]=0;b[22]=0
    count=double_edge_count(a,b,(a+b)/2,np.ones((48,80),bool))
    assert count/80 > InputParameters().contour_rate


def test_unpaired_outline_rate_accepts_sparse_pixels_rejects_missing_interior_run():
    a=np.zeros((600,600,4),np.uint8);a[...,:3]=(100,120,150);a[20:580,20:580,3]=255
    reference=Image.fromarray(a.copy());a[2,2,3]=a[4,2,3]=128
    sparse=fringe_gate(Image.fromarray(a),(255,0,255),reference=reference)
    assert sparse['unpaired_changed_pixels']==2 and sparse['passed']
    a[100:180,2,3]=128
    failed=fringe_gate(Image.fromarray(a),(255,0,255),reference=reference)
    assert failed['unpaired_per_outline_px'] > .001 and not failed['passed']


def test_complement_gate_accepts_palette_interpolation_rejects_new_green():
    a=np.zeros((48,48,4),np.uint8);a[...,:3]=(100,120,150);a[8:40,8:40,3]=255
    a[8:40,8:16,:3]=(50,150,180);a[8:40,16:24,:3]=(130,130,100)
    reference=Image.fromarray(a.copy());a[8:40,7]=(90,140,140,150)
    assert fringe_gate(Image.fromarray(a),(255,0,255),reference=reference)['passed']
    a[8:40,7]=(20,240,30,150)
    fault=fringe_gate(Image.fromarray(a),(255,0,255),reference=reference)
    assert not fault['passed'] and fault['excess_complement_share'] > .02


@pytest.mark.parametrize('coverage',[1.,.75])
def test_key_chroma_despill_includes_opaque_edges_without_changing_interior(coverage):
    from ba_modding_toolkit.refine_stitch import despill_key_band
    rgb=np.zeros((96,96,3),np.float32);rgb[16:80,16:80]=(.25,.25,.4)
    alpha=np.zeros((96,96),np.float32);alpha[16:80,16:80]=1
    band=np.zeros((96,96),bool);band[16:19,16:80]=True
    rgb[16,20:76]=(.9,.25,.9);alpha[16,20:76]=coverage
    original=rgb.copy()
    out=despill_key_band(rgb,alpha,(1,0,1),band)
    direction=np.array([1,-2,1])/np.sqrt(6)
    allowed=np.array([.25,.25,.4])@direction
    assert np.max(out[16,20:76]@direction) <= allowed+1e-5
    assert np.array_equal(out[~band],original[~band])
    assert (out<=original+1e-6).all()
    assert np.array_equal(out[...,1],original[...,1])
    assert (alpha[16,20:76]==coverage).all()


def test_key_chroma_despill_uses_the_crop_own_interior_palette():
    from ba_modding_toolkit.refine_stitch import despill_key_band
    results=[]
    for paint in ((.2,.2,.35),(.4,.2,.45)):
        rgb=np.zeros((80,80,3),np.float32);rgb[12:68,12:68]=paint
        alpha=np.zeros((80,80),np.float32);alpha[12:68,12:68]=1
        band=np.zeros((80,80),bool);band[12:15,12:68]=True
        rgb[12,20:60]=(.9,.2,.9)
        results.append(despill_key_band(rgb,alpha,(1,0,1),band)[12,30])
    unit=np.array([1,-2,1])/np.sqrt(6)
    assert results[1]@unit > results[0]@unit+.05


def test_key_direction_gate_rejects_opaque_magenta_rim_accepts_interior_paint():
    from ba_modding_toolkit.refine_stitch import key_fringe_gate
    a=np.zeros((128,128,4),np.uint8);a[...,:3]=(100,100,130);a[16:112,16:112,3]=255
    a[50:60,50:60,:3]=(220,80,220)
    good=Image.fromarray(a.copy())
    accepted=key_fringe_gate(good,(255,0,255))
    assert accepted['visible_key_lean_pixels']==100 and accepted['key_gate_passed']
    a[16,20:108,:3]=(240,60,240)
    bad=Image.fromarray(a)
    rejected=key_fringe_gate(bad,(255,0,255))
    assert rejected['band_key_excess_pixels']>=88 and not rejected['key_gate_passed']
    assert not fringe_gate(bad,(255,0,255),reference=good)['passed']
