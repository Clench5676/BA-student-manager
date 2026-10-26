// Authored stand-in for the measured UIPopup_Mulligan selected-card paths; no game mesh or pixels. The material colours and
// the number label's numbers are the prefab's own values (data, not assets).
const n = (name, pos = [0, 0], widgets = [], children = []) => ({ name, pos, widgets, children, active: true, scale: [1, 1], rotZ: 0 });
const sprite = (sprite, w_, h_, depth, color = '#ffffff/1.00') => ({ sprite, w_, h_, depth, color, pivot: 4, type: 1, incline: 0, prefabMarker: true });
export function selectionPrefab() {
  const effect = (blue) => ({ system: { main: { size: [115], rotation: [0, Math.PI, 0], duration: 1.5, life: 1.5, delay: 0, ring: 1, speedScale: 1,
    color: { col: blue ? [0.00392, 0.05882, 0.98039, 1] : [1, 0.14902, 0, 1] } } },
    mesh: { v: [-1, -2, 0, 1, -2, 0, 1, 2, 0], uv: [0, 0, 1, 0, 1, 1], i: [0, 1, 2] },
    material: { shader: 'DSFX/FX_SHADER_AlphaBlend_Add_Mask_0_NGUIClip', tex: { _Tex_Main: { id: 'fake_texture', st: [1, 1, 0, 0], srgb: 1 }, _Tex_Mask: { default: 'white' } },
      floats: { _Main_Speed_X: -.75, _Main_Speed_Y: 0, _Multiply: 1, _RGBRGBA: 0 }, colors: { _Color: blue ? [23.96863, 23.96863, 23.96863, 1] : [5.59088, 5.59088, 5.59088, 1] } } });
  const frame = (blue) => n(blue ? 'SelectLine_Sub' : 'SelectLine', [0, 7],
    [sprite('Common_Bg_Raius10px_Select', 298, 466, 40, blue ? '#0db4ff/1.00' : '#ffe900/1.00')], [
      { ...n('Sprite', [114.5, 215.2], [sprite('Common_Icon_Check_Y_Off', 60, 54, 42)]), active: false },
      n(blue ? 'FX_UI_Mulligan_Sub_03' : 'FX_UI_Mulligan_03', [0, 0], [], [
        { ...n('UV'), scale: [.96, .975], frameEffect: effect(blue) },
      ]),
    ]);
  const slot = n('UIMulliganSlot', [0, 0], [], [
    n('Common', [0, 0], [], [n('BG', [0, 0], [sprite('Common_Btn_BG', 312, 480, 7)])]),
    n('Mulligan_IndexBg', [120, 213], [sprite('Common_Icon_Mulligan_1', 76, 74, 50)]),
    n('Mulligan_IndexLabel', [120, 210], [{ cls: 'UILabel', text: '0', fontSize: 42, overflow: 0, align: 0, spacingX: -1, effect: 0,
      effectColor: '#39436f/1.00', effectDistance: [2, 2], w_: 70, h_: 52, pivot: 4, depth: 51, color: '#7a4800/1.00' }]), frame(false), frame(true),
  ]);
  return n('UIPopup_Mulligan', [0, 0], [], [n('Center', [0, 0], [], [n('Popup', [0, 0], [], [n('01', [0, 0], [], [slot])])])]);
}
