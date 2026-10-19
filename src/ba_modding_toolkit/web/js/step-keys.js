// The detail screen's keys for the previous and next student, as the PC client binds them. Its key mapping
// (Assets/_MX/AddressableAsset/KeyMapping/PCKeyMappingSO.asset, BindingPrefabDictionary) gives UICharacterDetail's
// Arrow_L/Left UI_KeyMapping_Common_ArrowLeft_isUsed (LeftArrow) and Arrow_R/Right
// UI_KeyMapping_Common_ArrowRight_isUsed (RightArrow): no second key, no key icon on the arrows, a press rather than a
// long press. No DOM: the tests run it in Node.
//   deltaOf(ev) -> -1 or 1 for a step key pressed alone; 0 for another key, a modifier held, an input method
//                  composing, or a press another handler took
//   typing(el)  -> the element takes typed text or arrow keys itself (inputs, text areas, selects, editable text)
//   pacer(run)  -> { press(delta, repeat), release(delta), clear(), busy }: one step at a time. run(delta) steps and
//                  resolves once the screen shows where it went. A press meanwhile waits for it (the latest one
//                  only), a held key's repeat only while the key is held: a held key steps at the screen's pace.

export const KEYS = Object.freeze({ ArrowLeft: -1, ArrowRight: 1 });

export function deltaOf(ev) {
  // keyCode 229: WebKit's key that ends a conversion, sent after compositionend
  if (!ev || ev.defaultPrevented || ev.isComposing || ev.keyCode === 229) return 0;
  if (ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return 0;
  return KEYS[ev.key] || 0;
}

export const typing = (el) => !!el && (el.isContentEditable === true || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName || ""));

export function pacer(run) {
  let running = false, next = null;
  const go = (delta) => {
    running = true;
    const done = () => {
      running = false;
      const n = next;
      next = null;
      if (n) go(n.delta);
    };
    Promise.resolve().then(() => run(delta)).then(done, (err) => { console.error(err); done(); });
  };
  return {
    press(delta, repeat = false) {
      if (!delta) return;
      if (running) next = { delta, repeat: !!repeat };
      else go(delta);
    },
    // a step key let go (any, without delta: the window lost the keyboard): its repeat waits no longer
    release(delta) {
      if (next?.repeat && (delta === undefined || next.delta === delta)) next = null;
    },
    clear() { next = null; },
    get busy() { return running; },
  };
}
