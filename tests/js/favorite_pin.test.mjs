import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
const code = readFileSync(new URL("../../src/ba_modding_toolkit/web/js/detail.js", import.meta.url), "utf8");
const n = (name, widgets = [], children = [], pos = [0, 0]) => ({ name, widgets, children, pos, active: true });
const find = (tree, path) => path.split("/").filter(Boolean).reduce((n, part) => n?.children.find((c) => c.name === part), tree);

test("Favorite preserves the prefab's off/on sprite, tint and child geometry", () => {
  const pin = n("Pin", [], [
    n("Pin_On", [], [n("Bg", [{ sprite: "Common_Bg_Pin_Detail_01", w_: 262, h_: 73 }], [
      n("Icon", [{ sprite: "Common_Icon_Pin_Detail", color: "#ffffff/1.00", w_: 38, h_: 38, gradient: ["#fa8c21/1.00", "#e6780e/1.00"] }],
        [n("Label_Locale", [{ text: "caption", w_: 172, fontSize: 38, color: "#725538/1.00" }], [], [20, -5])], [40, 2]),
    ], [24, 1])]),
    n("Pin_Off", [], [n("Bg", [{ sprite: "Common_Bg_Pin_Detail_02", w_: 266, h_: 68 }], [
      n("Icon", [{ sprite: "Common_Icon_Pin_Detail", color: "#ffffff/1.00", w_: 38, h_: 38 }], [], [38, -1]),
      n("Label_Locale", [{ text: "caption", w_: 180, fontSize: 38, color: "#828282/1.00" }], [], [61, -3]),
    ], [26, 4])]),
  ]);
  const start = code.indexOf('  const fav = isFav(v);'), end = code.indexOf('  // Both names share', start);
  const env = { isFav: (v) => v.favorite, at: find, find, widget: (tree, path) => find(tree, path).widgets[0],
    advanceOf: () => 160, T: () => "Favorite" };
  const apply = new Function("env", `const { ${Object.keys(env)} } = env; return (t,v,np) => { ${code.slice(start, end)} };`)(env);
  for (const favorite of [false, true]) {
    const tree = structuredClone(pin); apply(n("root", [], [tree]), { favorite }, "");
    assert.equal(find(tree, "Pin_On").active, favorite); assert.equal(find(tree, "Pin_Off").active, !favorite);
    for (const state of ["Pin_On", "Pin_Off"]) {
      const original = find(pin, state + "/Bg/Icon"), icon = find(tree, state + "/Bg/Icon");
      assert.deepEqual(icon.pos, original.pos); assert.deepEqual(icon.widgets, original.widgets);
      assert.equal(find(tree, state + "/Bg").widgets[0].sprite, find(pin, state + "/Bg").widgets[0].sprite);
    }
    assert.equal(find(tree, "Pin_Off/Bg/Label_Locale").widgets[0].color, "#828282/1.00");
  }
});
