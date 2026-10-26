"""Selection-frame export uses a fake prefab and fake resolved mesh/material resources."""

from types import SimpleNamespace

import pytest

from ba_modding_toolkit.gameassets.selection_frames import ROOT, SLOT, export_effects
from ba_modding_toolkit.gameassets.layouts import export_layout, subtree
from ba_modding_toolkit.gameassets import particles
from test_gameassets import _fake_prefab


def test_layout_attaches_frame_effect_only_to_its_own_node():
    env = _fake_prefab({1: ('Root', 0), 2: ('UV', 1)}, [])
    effect = {'system': {'main': {'duration': 1.5}}, 'mesh': {'v': []}}
    tree = export_layout(env, 'Root', {}, effects={2: effect})
    assert 'frameEffect' not in tree
    assert subtree(tree, 'UV')['frameEffect'] == effect


@pytest.mark.parametrize('blue', [False, True])
def test_frame_export_resolves_the_authored_particle_and_material_timing(blue):
    objects = []
    names = [ROOT, *SLOT.split('/'), 'SelectLine_Sub' if blue else 'SelectLine',
             'FX_UI_Mulligan_Sub_03' if blue else 'FX_UI_Mulligan_03', 'UV']
    for go, name in enumerate(names, 1):
        objects.append(SimpleNamespace(type=SimpleNamespace(name='GameObject'), path_id=go,
                                       read=lambda name=name: SimpleNamespace(m_Name=name)))
        transform = {'m_GameObject': {'m_PathID': go}, 'm_Father': {'m_PathID': go + 999 if go > 1 else 0}}
        objects.append(SimpleNamespace(type=SimpleNamespace(name='Transform'), path_id=go + 1000,
                                       read_typetree=lambda t=transform: t))
    ps = {'m_GameObject': {'m_PathID': len(names)}, 'lengthInSec': 1.5, 'looping': False, 'simulationSpeed': 1.0,
          'startDelay': {'scalar': 0}, 'ringBufferMode': 1, 'InitialModule': {
              'startLifetime': {'scalar': 1.5}, 'startSize': {'scalar': 115},
              'startColor': {'minMaxState': 0, 'maxColor': dict(r=1, g=.14902, b=0, a=1)}}}
    renderer = {'m_GameObject': ps['m_GameObject'], 'm_Enabled': True,
                'm_Materials': [{'m_PathID': 901}], 'm_Mesh': {'m_PathID': 902}}
    for pid, kind, tree in [(800, 'ParticleSystem', ps), (801, 'ParticleSystemRenderer', renderer)]:
        objects.append(SimpleNamespace(type=SimpleNamespace(name=kind), path_id=pid, read_typetree=lambda t=tree: t))
    material = {'shader': 'DSFX/FX_SHADER_AlphaBlend_Add_Mask_0_NGUIClip',
                'floats': {'_Main_Speed_X': -.75, '_Main_Speed_Y': 0}}
    mesh = {'v': [0, 0, 0], 'i': [0]}
    calls = []
    def resolve(kind, owner, pointer):
        calls.append((kind, owner, pointer['m_PathID']))
        return kind, material if kind == 'material' else mesh
    effects = export_effects(SimpleNamespace(objects=objects), resolve)
    assert list(effects) == [len(names)]
    result = effects[len(names)]
    assert result['system'] == particles.system(ps, renderer)
    assert result['system']['main']['duration'] == result['system']['main']['life'] == 1.5
    assert result['system']['main']['delay'] == 0
    assert result['system']['main']['ring'] == 1
    assert result['material']['floats']['_Main_Speed_X'] == -.75
    assert result['mesh'] == mesh
    assert calls == [('material', 801, 901), ('mesh', 801, 902)]
    renderer['m_Enabled'] = False
    assert export_effects(SimpleNamespace(objects=objects), resolve) == {}


def test_frame_texture_export_rejects_ids_outside_the_prefab(tmp_path, monkeypatch):
    from ba_modding_toolkit.gameassets import AssetCache, AssetNotFound, GameAssets
    from PIL import Image
    game = GameAssets([tmp_path], AssetCache(root=tmp_path / 'cache'))
    slot = {'frameEffect': {'material': {'tex': {'_Tex_Main': {'id': 'cab-test_42'}}}}}
    monkeypatch.setattr(game, 'layout', lambda root, path: slot)
    monkeypatch.setattr(game, '_resolve_cabs', lambda wanted: {'cab-test': str(tmp_path / 'fake.bundle')})
    from contextlib import contextmanager
    from ba_modding_toolkit.gameassets import service
    (tmp_path / 'fake.bundle').write_bytes(b'fake')
    reads = []
    @contextmanager
    def open_bundle(path):
        reads.append(path)
        yield SimpleNamespace(objects=[SimpleNamespace(path_id=42, assets_file=SimpleNamespace(name='CAB-test'),
            type=SimpleNamespace(name='Texture2D'), read=lambda: SimpleNamespace(image=Image.new('RGBA', (2, 2))))])
    monkeypatch.setattr(service, 'open_bundle', open_bundle)
    with pytest.raises(AssetNotFound):
        game.selection_frame_texture('cab-unlisted_42')
    assert not reads
    assert game.selection_frame_texture('cab-test_42').startswith(b'\x89PNG')
    assert reads == [tmp_path / 'fake.bundle']
