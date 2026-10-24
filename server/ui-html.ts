// The browser's primitives: the same set as client/ui/atoms.tsx, as string functions, plus the CSS custom
// properties generated from shared/ui-spec.ts. No colour is written by hand in the component CSS: it only uses var(--…).
import type { StepState } from "../shared/canvas.ts";
import type { FlagPlan, StatusPlan } from "../shared/plan.ts";
import { BASE, SIGNAL, STEP_GLYPH, TONES, tokensFixed, type Delta, type Tone } from "../shared/ui-spec.ts";

export const esc = (s: unknown) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// ---------- tokens as CSS ----------

function vars(mode: "light" | "dark"): string {
  const t = tokensFixed(mode);
  const out = [`--bg:${t.bg}`, `--raised:${t.raised}`, `--well:${t.well}`, `--line:${t.line}`, `--line-strong:${t.lineStrong}`, `--fg:${t.fg}`, `--muted:${t.muted}`, `--faint:${t.faint}`, `--ask:${t.askTint}`];
  for (const tone of TONES) {
    const s = t.sig(tone);
    out.push(`--${tone}:${s.dot}`, `--${tone}-t:${s.text}`, `--${tone}-w:${s.tint}`);
  }
  return out.join(";");
}
/** :root for light, and the dark set when the OS asks for it. Generated, so it cannot drift from the native renderer. */
export function cssVars(): string {
  return `:root{${vars("light")};color-scheme:light dark}@media (prefers-color-scheme:dark){:root{${vars("dark")}}}`;
}
export { BASE, SIGNAL };

// ---------- primitives ----------

/** StatusDot. Halo and pulse come from the signal spec. */
export const sd = (tone: Tone, o: { halo?: boolean; pulse?: boolean; size?: number } = {}) => {
  const s = SIGNAL[tone];
  const cls = ["sd", tone, o.halo === false || !s.halo ? "nohalo" : "", o.pulse === false || !s.pulse ? "nopulse" : ""].join(" ");
  return `<span class="${cls}"${o.size ? ` style="width:${o.size}px;height:${o.size}px"` : ""}></span>`;
};
export const badge = (tone: Tone, label: string, glyph: "dot" | "check" | "none" = "dot") =>
  `<span class="badge ${tone}">${glyph === "dot" ? sd(tone, { halo: false, pulse: false, size: 6 }) : glyph === "check" ? '<span class="ck">✓</span>' : ""}${esc(label)}</span>`;
export const meta = (text: string, cls = "") => `<span class="meta ${cls}">${esc(text)}</span>`;
export const ticks = (states: readonly StepState[], wide = false) => (states.length ? `<span class="ticks${wide ? " wide" : ""}">${states.map((s) => `<i class="${s}"></i>`).join("")}</span>` : "");
export const slabel = (text: string, o: { ticks?: readonly StepState[]; count?: string; tone?: Tone } = {}) =>
  `<div class="slabel${o.tone ? ` c-${o.tone}` : ""}">${o.tone ? sd(o.tone, { halo: false, pulse: false, size: 6 }) : ""}<span>${esc(text)}</span>${o.ticks ? ticks(o.ticks, true) : ""}${o.count ? `<span class="cnt">${esc(o.count)}</span>` : ""}</div>`;
export const bar = (pct: number, tone: Tone = "run", o: { ticks?: boolean } = {}) =>
  `<div class="bar${o.ticks ? " qt" : ""}"><i style="width:${Math.max(0, Math.min(100, pct)).toFixed(1)}%;background:var(--${tone})"></i></div>`;
export const glyphCircle = (tone: Tone, glyph: string, solid = false) => `<span class="gc ${tone}${solid ? " solid" : ""}">${esc(glyph)}</span>`;
export const stepGlyph = (state: StepState, signal: Tone) =>
  state === "active" ? `<span class="g">${sd("run", { size: 7 })}</span>` : state === "done" || state === "failed" ? `<span class="g gc ${signal}">${STEP_GLYPH[state]}</span>` : state === "pending" ? '<span class="g ring"></span>' : `<span class="g faint">${STEP_GLYPH.skipped}</span>`;
export const stepRow = (state: StepState, signal: Tone, text: string) => `<div class="step st-${state}">${stepGlyph(state, signal)}<span class="t">${esc(text)}</span></div>`;
export const chip = (tone: Tone, text: string, glyph?: string) => `<span class="chip ${tone}">${glyph ? esc(glyph) : ""}${esc(text)}</span>`;
export const delta = (d: Delta) => `<span class="delta ${d.signal}">${esc(d.text)}</span>`;
export const button = (variant: "primary" | "secondary" | "ghost", label: string, attrs = "") => `<button class="btn ${variant}" ${attrs}>${esc(label)}</button>`;
export const linkButton = (variant: "primary" | "secondary" | "ghost", label: string, href: string, newTab = true) =>
  `<a class="btn ${variant}" href="${esc(href)}"${newTab ? ' target="_blank" rel="noopener noreferrer"' : ""}>${esc(label)}</a>`;
export const flagLine = (f: FlagPlan) => `<div class="flag ${f.signal}">${glyphCircle(f.signal, f.glyph)}<span>${esc(f.text)}</span></div>`;

/** Paseo's own line. Facts are Paseo's; the agent cannot write into it. */
export function statusLine(p: StatusPlan): string {
  const facts = p.facts.map((f) => `<span${f.signal ? ` class="c-${f.signal}"` : ""}>${esc(f.text)}</span>`);
  const l2 = [...(p.lead ? [`<b class="c-hot">${esc(p.lead)}</b>`] : []), ...facts].join('<span class="sep"> · </span>');
  return `<div class="statusline"><div class="l1">${badge(p.signal, p.label, p.signal === "ok" ? "check" : "dot")}${meta(p.run)}</div><div class="meta l2">${l2}</div>${p.flags.map(flagLine).join("")}</div>`;
}

// ---------- component CSS (var(--…) only) ----------

export const COMPONENT_CSS = `
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/20px var(--sans,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif);font-variant-numeric:tabular-nums;-webkit-font-smoothing:antialiased}
:root{--sans:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
main{max-width:720px;margin:0 auto;padding:20px 16px 48px}
nav{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--line);font-size:13px}nav a{color:var(--fg);text-decoration:none;font-weight:500}nav .crumb{color:var(--muted)}nav .demo{margin-left:auto;color:var(--faint);font-size:12px}
a{color:var(--run-t);text-decoration:none}a:hover{text-decoration:underline}
.sd{width:8px;height:8px;border-radius:4px;flex:none;display:inline-block;position:relative}
.sd.hot{background:var(--hot);box-shadow:0 0 0 3px var(--hot-w)}.sd.run{background:var(--run);box-shadow:0 0 0 3px var(--run-w);animation:pulse 1.4s ease-in-out infinite}
.sd.ok{background:var(--ok)}.sd.idle{background:transparent;box-shadow:inset 0 0 0 1.5px var(--faint)}
.sd.warn{background:var(--warn);box-shadow:0 0 0 3px var(--warn-w)}.sd.err{background:var(--err);box-shadow:0 0 0 3px var(--err-w)}
.sd.nohalo{box-shadow:none}.sd.idle.nohalo{box-shadow:inset 0 0 0 1.5px var(--faint)}.sd.nopulse{animation:none}
@keyframes pulse{50%{box-shadow:0 0 0 5px transparent;opacity:.7}}@media (prefers-reduced-motion:reduce){.sd.run{animation:none}}
.badge{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px 0 7px;border-radius:6px;font-size:12px;line-height:16px;font-weight:500;white-space:nowrap}
.badge.hot{background:var(--hot-w);color:var(--hot-t)}.badge.run{background:var(--run-w);color:var(--run-t)}.badge.ok{background:var(--ok-w);color:var(--ok-t)}.badge.warn{background:var(--warn-w);color:var(--warn-t)}.badge.err{background:var(--err-w);color:var(--err-t)}.badge.idle{background:var(--well);color:var(--muted)}
.badge .ck{font-size:11px;line-height:1}
.meta{font-size:12px;line-height:16px;color:var(--muted)}
.slabel{font-size:12px;line-height:16px;font-weight:500;color:var(--muted);display:flex;align-items:center;gap:8px}.slabel .cnt{margin-left:auto;color:var(--fg)}
.c-hot{color:var(--hot-t)}.c-run{color:var(--run-t)}.c-ok{color:var(--ok-t)}.c-warn{color:var(--warn-t)}.c-err{color:var(--err-t)}.c-idle{color:var(--muted)}
.title{font-size:17px;line-height:24px;font-weight:600}.lede{font-size:15px;line-height:22px;margin:0}.screentitle{font-size:20px;line-height:28px;font-weight:600}
.sheet{display:flex;flex-direction:column;gap:20px}.sec{display:flex;flex-direction:column;gap:8px}
.statusline{display:flex;flex-direction:column;gap:6px;padding-bottom:12px;border-bottom:1px solid var(--line)}.statusline .l1{display:flex;align-items:center;gap:10px}.statusline b{font-weight:500}
.flag{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:16px}.flag.warn{color:var(--warn-t)}.flag.err{color:var(--err-t)}
.gc{flex:none;width:16px;height:16px;border-radius:8px;display:inline-flex;align-items:center;justify-content:center;font-size:10px;font-weight:600;line-height:1}
.gc.hot{background:var(--hot-w);color:var(--hot-t)}.gc.run{background:var(--run-w);color:var(--run-t)}.gc.ok{background:var(--ok-w);color:var(--ok-t)}.gc.warn{background:var(--warn-w);color:var(--warn-t)}.gc.err{background:var(--err-w);color:var(--err-t)}.gc.idle{background:var(--well);color:var(--muted)}
.trow{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}.trow .meta{font-size:13px}
.btn{font:500 13px/1 var(--sans);height:32px;padding:0 12px;border-radius:8px;display:inline-flex;align-items:center;gap:6px;cursor:pointer;border:1px solid transparent;background:none;color:var(--fg);white-space:nowrap;text-decoration:none}
.btn.primary{background:var(--fg);color:var(--bg)}.btn.secondary{background:var(--bg);border-color:var(--line-strong)}.btn.secondary:hover{background:var(--hot-w);border-color:transparent;color:var(--hot-t)}
.btn.ghost{color:var(--muted);padding:0 4px}.btn.ghost:hover{color:var(--fg);text-decoration:none}.btn:disabled{opacity:.5;cursor:default}
.btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ask{background:var(--ask);border-radius:10px;padding:14px;display:flex;flex-direction:column;gap:10px}.ask .slabel{color:var(--hot-t)}.ask .q{font-size:15px;line-height:22px;font-weight:500}
.ticks{display:flex;gap:2px;height:4px;flex:1;min-width:40px;max-width:120px}.ticks.wide{max-width:none}.ticks i{flex:1;border-radius:1px;background:var(--well)}
@media (prefers-color-scheme:dark){.ticks i{background:var(--line-strong)}}
.ticks .done{background:var(--ok)!important}.ticks .active{background:var(--run)!important}.ticks .failed{background:var(--err)!important}.ticks .skipped{background:var(--line)!important}
.steps{display:flex;flex-direction:column;gap:2px}
.step{display:flex;gap:10px;align-items:center;min-height:26px;padding:0 8px;margin:0 -8px;border-radius:6px}.step .g{width:16px;height:16px;flex:none;display:inline-flex;align-items:center;justify-content:center;font-size:11px;border-radius:8px}
.st-active{background:var(--run-w)}.st-active .t{font-weight:500}.g.ring{box-shadow:inset 0 0 0 1.5px var(--line)}.st-pending .t{color:var(--muted)}.st-failed .t{color:var(--err-t)}
.g.faint,.st-skipped .t{color:var(--faint)}.st-skipped .t{text-decoration:line-through;text-decoration-color:var(--line)}
.prog .top{display:flex;justify-content:space-between;align-items:baseline}.prog .top b{font-size:12px;font-weight:600}
.bar{height:6px;border-radius:3px;background:var(--well);overflow:hidden;position:relative}@media (prefers-color-scheme:dark){.bar{background:var(--line-strong)}}
.bar i{display:block;height:100%;border-radius:3px}
.bar.qt:after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent calc(25% - 1px),var(--bg) calc(25% - 1px),var(--bg) 25%,transparent 25%,transparent calc(50% - 1px),var(--bg) calc(50% - 1px),var(--bg) 50%,transparent 50%,transparent calc(75% - 1px),var(--bg) calc(75% - 1px),var(--bg) 75%,transparent 75%)}
.metrics{display:flex;gap:12px 28px;flex-wrap:wrap}.metric .v{font-size:20px;line-height:28px;font-weight:600}
.delta{display:inline-flex;align-items:center;font-size:11px;font-weight:600;height:18px;padding:0 5px;border-radius:4px;margin-left:6px;vertical-align:3px}.delta.ok{background:var(--ok-w);color:var(--ok-t)}.delta.err{background:var(--err-w);color:var(--err-t)}
.tbl{width:100%;border-collapse:separate;border-spacing:0;font-size:14px}.tbl th{font-size:12px;line-height:16px;font-weight:500;color:var(--muted);text-align:left;padding:5px 8px;background:var(--well)}
.tbl th:first-child{border-radius:6px 0 0 6px}.tbl th:last-child{border-radius:0 6px 6px 0}.tbl td{padding:7px 8px;border-bottom:1px solid var(--line)}.tbl tr:last-child td{border-bottom:0}.tbl .num{text-align:right}.tbl .best{color:var(--ok-t);font-weight:500}
.chartrows{display:flex;flex-direction:column;gap:8px}.chartrows .top{display:flex;justify-content:space-between;font-size:12px;line-height:16px;margin-bottom:4px}.chartrows .top span{color:var(--muted)}
.svgchart{width:100%;max-width:420px;height:auto}.svgchart text{font:10px var(--sans);fill:var(--muted)}.svgchart .v{font-weight:600;fill:var(--fg)}
.pathrow{display:flex;align-items:center;gap:8px}.path{font:12px/16px var(--mono)}.dstat{font:500 12px/16px var(--mono)}.dstat .a{color:var(--ok-t)}.dstat .d{color:var(--err-t)}
.well{background:var(--well);border-radius:10px;padding:8px 0;font:12px/18px var(--mono);overflow:auto}.well span{display:block;padding:0 12px;white-space:pre;color:var(--muted)}
.well .add{color:var(--ok-t);background:var(--ok-w)}.well .del{color:var(--err-t);background:var(--err-w)}.well .hunk{color:var(--run-t);opacity:.8}.well.code span{color:var(--fg)}
.note{border-radius:10px;padding:10px 12px;display:flex;gap:10px;align-items:flex-start}.note .gc{width:18px;height:18px;border-radius:9px;font-size:11px;font-weight:700;margin-top:1px}
.note.run{background:var(--run-w)}.note.warn{background:var(--warn-w)}.note.err{background:var(--err-w)}.note.ok{background:var(--ok-w)}
.gc.solid.run{background:var(--run);color:var(--bg)}.gc.solid.warn{background:var(--warn);color:var(--bg)}.gc.solid.err{background:var(--err);color:var(--bg)}.gc.solid.ok{background:var(--ok);color:var(--bg)}
.chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;font-size:13px;font-weight:500;align-self:flex-start}.chip.ok{background:var(--ok-w);color:var(--ok-t)}
.divider{height:1px;background:var(--line)}
.list .row{display:flex;flex-direction:column;gap:4px;padding:14px 12px;margin:0 -12px;border-radius:8px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.list .row:last-child{border-bottom:0}.list .row:hover{background:var(--raised);text-decoration:none}
.list .row.need{background:var(--hot-w);border-bottom-color:transparent}.list .row.dim{opacity:.55}
.list .row .l1{display:flex;align-items:center;gap:10px}.list .row .l1 b{font-weight:600;min-width:0}.list .row .sp{flex:1}.list .row .ind{padding-left:18px}.list .row .bl{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.list .row.need .bl{color:var(--fg)}
.canvas.dim .dimmable{opacity:.55}
`;
