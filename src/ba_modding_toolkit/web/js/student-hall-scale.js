// Bind the native slider; optional percentage fields retain partial text while typing.
import { HALL_SCALE, hallScale } from "./student-hall-framing.js";
export function bindScale(range, number, reset, { value, change, paint = () => {}, enabled = () => true }) {
  const lo = HALL_SCALE.min * 100, hi = HALL_SCALE.max * 100;
  let percent = Math.round(hallScale(value) * 100);
  for (const input of [range, number].filter(Boolean)) { input.min = String(lo); input.max = String(hi); input.step = "1"; }
  function show() { range.value = String(percent); if (number) number.value = String(percent); paint((percent - lo) / (hi - lo)); }
  function apply(next, sync = true) {
    if (!enabled()) { show(); return; }
    const clamped = Math.round(Math.max(lo, Math.min(hi, next)));
    const changed = clamped !== percent; percent = clamped;
    if (sync) show(); else { range.value = String(percent); paint((percent - lo) / (hi - lo)); }
    if (changed) change(percent / 100);
  }
  range.addEventListener("input", () => apply(Number(range.value)));
  number?.addEventListener("input", () => {
    const raw = number.value.trim(), next = Number(raw);
    // Do not turn the first digit of 75 into 25 before the second digit is typed.
    if (raw && Number.isFinite(next) && next >= lo && next <= hi) apply(next, false);
  });
  const commit = () => {
    const raw = number.value.trim(), next = Number(raw);
    if (raw && Number.isFinite(next)) apply(next); else show();
  };
  number?.addEventListener("change", commit); number?.addEventListener("blur", commit);
  number?.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } });
  reset?.addEventListener("click", () => apply(HALL_SCALE.default * 100));
  show(); return { value: () => percent / 100 };
}
