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
