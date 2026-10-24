import assert from "node:assert/strict";
import { test } from "node:test";
import { createDraft, sourceKey, portraitRows, studentChoices, memorialChoices, contentBounds } from "../../src/ba_modding_toolkit/web/js/student-hall-model.js";
import { normalizeView } from "../../src/ba_modding_toolkit/web/js/roster-order.js";
const saved = () => ({ revision: 0, mode: "portraits", background: "office-day", portraits: [], memorials: [{ id: "a", variant: "hero", source: "official" }, { id: "b", variant: "hero", source: "mod:alternate" }], active: "b" });
const source = (variant, kind = "spr", extra = {}) => ({ variant, family: "hero", familyNames: { en: "Hero" }, names: { en: { full: variant } },
  source: "mod:" + variant, kind, favorite: false, recruitable: true, ...extra });
const label = (names) => names?.en;

test("the same portrait source cannot be added twice, but different assets of one student remain independent", () => {
  const state = createDraft(saved()); state.begin("layout");
  const a = state.add(source("hero"), () => "one");
  assert.equal(state.add(source("hero"), () => "duplicate"), null);
  const b = state.add(source("hero", "spr", { source: "mod:alternate" }), () => "two");
  a.x = 400; assert.notEqual(a.x, b.x); assert.equal(state.current().portraits.length, 2);
  assert.equal(state.saved().portraits.length, 0); assert.ok(state.dirty());
  state.cancel(); assert.equal(state.current().portraits.length, 0); assert.equal(state.dirty(), false);
});
test("legacy duplicate portrait reads retain the first UUID and every intentional position or relative scale", () => {
  const value = saved();
  value.portraits = [{ id: "first", variant: "hero", source: "mod:one", x: 410, y: 905, scale: .6 },
    { id: "second", variant: "hero", source: "mod:one", x: 1000, y: 1120, scale: 1 },
    { id: "other", variant: "hero", source: "mod:two", x: 1310, y: 1055, scale: 1.3 }];
  const state = createDraft(value);
  assert.deepEqual(state.current().portraits, [value.portraits[0], value.portraits[2]]);
  assert.equal(value.portraits.length, 3, "reading never mutates the supplied saved snapshot");
  assert.equal(state.current().memorials.length, 2);
});

test("playlist reorder retains active UUID and the last entry cannot be removed", () => {
  const state = createDraft(saved()); state.begin("memorial");
  state.move("a", "b"); assert.equal(state.current().active, "b");
  assert.equal(state.remove("a"), true); assert.equal(state.remove("b"), false);
  state.cancel(); assert.deepEqual(state.current().memorials.map((entry) => entry.id), ["a", "b"]);
});
test("portrait rows offer only library mods, merge skins without leaking other students, and match saved aliases", () => {
  const choices = [source("hero", "spr", { source: "official" }), source("hero", "spr", { aliases: ["Alias Two"] }),
    source("hero_swimsuit", "spr", { custom: ["Summer Nickname"] }), source("other", "spr", { family: "other", familyNames: { en: "Other" } })];
  const view = normalizeView({ merged: true, sort: "name" });
  const all = portraitRows(choices, view, "", label, "en");
  assert.equal(all.find((row) => row.key === "hero").choices.length, 2);
  assert.ok(all.flatMap((row) => row.choices).every((choice) => choice.source.startsWith("mod:")));
  assert.deepEqual(portraitRows(choices, view, "Alias Two", label, "en").flatMap((row) => row.choices).map((choice) => choice.variant), ["hero"]);
  assert.deepEqual(portraitRows(choices, view, "Summer Nickname", label, "en").flatMap((row) => row.choices).map((choice) => choice.variant), ["hero_swimsuit"]);
});
test("memorial availability filters students, selected student narrows candidates, and recent order uses source history", () => {
  const choices = [source("hero", "lobby", { source: "official", viewed: 3 }), source("hero", "lobby", { viewed: 0 }),
    source("new", "lobby", { family: "new", recruitable: false, viewed: 1 })];
  const view = normalizeView({ sort: "recent", order: "desc" });
  const students = studentChoices(choices, view, "", label, "en");
  assert.deepEqual(memorialChoices(choices, students, null, view, "").map(sourceKey), ["hero:mod:hero", "new:mod:new", "hero:official"]);
  assert.equal(memorialChoices(choices, students, "hero", view, "").length, 2);
  const unreleased = studentChoices(choices, { ...view, recruit: "no" }, "", label, "en"); assert.deepEqual(unreleased.map((s) => s.key), ["new"]);
});
test("memorial sort controls respect direction, localized names, mod counts and aliases", () => {
  const a = source("raw_z", "lobby", { family: "a", names: { en: { full: "Alpha" } }, aliases: ["Secret"], mods: 5, order: 0 });
  const b = source("raw_a", "lobby", { family: "b", names: { en: { full: "Zulu" } }, mods: 1, order: 1 });
  const choices = [a, b], students = studentChoices(choices, normalizeView({}), "", label, "en");
  assert.deepEqual(memorialChoices(choices, students, null, { sort: "name", order: "asc" }, "", {}, label).map((c) => c.variant), ["raw_z", "raw_a"]);
  assert.equal(memorialChoices(choices, students, null, { sort: "name", order: "desc" }, "", {}, label)[0], b);
  assert.equal(memorialChoices(choices, students, null, { sort: "default", order: "asc" }, "")[0], a);
  assert.equal(memorialChoices(choices, students, null, { sort: "mods", order: "desc" }, "")[0], a);
  assert.equal(memorialChoices(choices, students, null, { sort: "default", order: "desc" }, "")[0], b);
  assert.deepEqual(memorialChoices(choices, students, null, { sort: "recent", order: "desc" }, "Secret"), [a]);
});


test("dialogue bounds clear the actual local toolbar and bottom navigation at any stage scale", () => {
  const scaled = contentBounds({ top: 0, width: 1280 }, [{ bottom: 120, height: 40 }], { top: 650.6666666667, height: 69.333333 });
  assert.equal(scaled.top, 196); assert.ok(Math.abs(scaled.bottom - 960) < .001);
  const bounds = contentBounds({ top: 20, width: 1920 }, [{ bottom: 210, height: 70 }], { top: 996, height: 104 });
  assert.equal(bounds.top, 206); assert.equal(bounds.bottom, 960);
});

test("portrait layers and mirror are draft-only, preserve identity and survive save or restore on cancel",()=>{
  const value=saved();value.portraits=["a","b","c"].map((id)=>({id,variant:id,source:`mod:${id}`,x:500,y:1000,scale:1}));
  const state=createDraft(value);state.begin("layout");
  assert.equal(state.layer("a","back"),false);assert.equal(state.layer("c","front"),false);
  state.layer("a",1);assert.deepEqual(state.current().portraits.map((entry)=>entry.id),["b","a","c"]);
  state.layer("b","front");state.layer("c","back");state.flip("a");
  assert.deepEqual(state.current().portraits.map((entry)=>entry.id),["c","a","b"]);assert.equal(state.current().portraits[1].mirror,true);
  state.cancel();assert.deepEqual(state.current().portraits,value.portraits);
  state.begin("layout");state.layer("a","front");state.flip("a");state.accept({...state.current(),revision:1});
  assert.deepEqual(state.saved().portraits.map((entry)=>entry.id),["b","c","a"]);assert.equal(state.saved().portraits[2].mirror,true);
});
test("merged memorial students expose every variant and source in the selected family",()=>{
  const choices=[source("hero","lobby",{source:"official"}),source("hero_swimsuit","lobby"),source("other","lobby",{family:"other"})];
  const view=normalizeView({merged:true,sort:"name",order:"asc"}),students=studentChoices(choices,view,"",label,"en");
  assert.equal(students.length,2);const hero=students.find((student)=>student.family==="hero");
  assert.deepEqual(memorialChoices(choices,students,hero.key,view,"").map((choice)=>choice.variant),["hero","hero_swimsuit"]);
});


test("memorial resources are unique while distinct sources of the same student remain selectable",()=>{
  const state=createDraft(saved());state.begin("memorial");
  assert.equal(state.add(source("hero","lobby",{source:"official"}),()=>"dup"),null);
  assert.equal(state.add(source("hero","lobby",{source:"mod:alternate"}),()=>"dup2"),null);
  assert.equal(state.add(source("hero","lobby",{source:"mod:another"}),()=>"other").id,"other");
  assert.equal(state.add(source("hero_swimsuit","lobby",{source:"official"}),()=>"skin").id,"skin");
  assert.equal(state.current().memorials.length,4);
});

test("legacy memorial repeats keep first position and preserve an active duplicate UUID without mutation",()=>{
  const value=saved();value.memorials.push({id:"active-duplicate",variant:"hero",source:"official"});value.active="active-duplicate";
  value.portraits=[{id:"portrait-id",variant:"hero",source:"official"}];
  const before=structuredClone(value),state=createDraft(value);
  assert.deepEqual(state.current().memorials.map(entry=>entry.id),["active-duplicate","b"]);
  assert.equal(state.current().active,"active-duplicate");assert.equal(state.dirty(),false);assert.deepEqual(value,before);
  const ids=[...state.current().portraits,...state.current().memorials].map(entry=>entry.id);assert.equal(new Set(ids).size,ids.length);
  state.accept(value);assert.deepEqual(state.current().memorials.map(entry=>entry.id),["active-duplicate","b"]);
});

test("picker Has Mod, No Mod and mod-count sorting are scoped to the selected asset kind",()=>{
  const choices=[];
  for(const variant of ["spr_only","lobby_only","both","none"]){
    for(const kind of ["spr","lobby"])choices.push(source(variant,kind,{family:variant,source:"official",mods:99}));
  }
  choices.push(source("spr_only","spr",{family:"spr_only",mods:99}),source("lobby_only","lobby",{family:"lobby_only",mods:99}),
    source("both","spr",{family:"both",mods:99}),source("both","lobby",{family:"both",mods:99}),source("both","lobby",{family:"both",source:"mod:second",mods:99}));
  const pick=(kind,mods)=>studentChoices(choices,normalizeView({mods,sort:"mods",order:"desc"}),"",label,"en",kind);
  assert.deepEqual(pick("spr","mods").map(s=>s.key).sort(),["both","spr_only"]);
  assert.deepEqual(pick("lobby","mods").map(s=>s.key),["both","lobby_only"]);
  assert.deepEqual(pick("spr","none").map(s=>s.key).sort(),["lobby_only","none"]);
  assert.deepEqual(pick("lobby","none").map(s=>s.key).sort(),["none","spr_only"]);
  assert.equal(pick("spr","mods").find(s=>s.key==="both").mods,1);assert.equal(pick("lobby","mods")[0].mods,2);
  assert.equal(studentChoices(choices,normalizeView({mods:"mods"}),"",label,"en").length,4,"unscoped roster semantics retain reported totals");
});

test("merged picker families aggregate only the current resource kind",()=>{
  const choices=[source("hero","spr",{source:"official",mods:100}),source("hero","lobby",{source:"official",mods:100}),
    source("hero","spr",{mods:100}),source("hero_swimsuit","lobby",{source:"official",mods:100}),source("hero_swimsuit","lobby",{mods:100})];
  for(const kind of ["spr","lobby"]){const [family]=studentChoices(choices,normalizeView({merged:true,mods:"mods"}),"",label,"en",kind);assert.equal(family.mods,1);}
  assert.equal(studentChoices(choices.filter(choice=>choice.kind!=="lobby"||choice.source==="official"),normalizeView({merged:true,mods:"mods"}),"",label,"en","lobby").length,0);
});
