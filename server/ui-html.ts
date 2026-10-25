// The browser's primitives: the same set as client/ui/atoms.tsx, as string functions, plus the CSS custom
// properties generated from shared/ui-spec.ts. No colour is written by hand in the component CSS: it only uses var(--…).
import type { StepState } from "../shared/canvas.ts";
import type { ActivityPlan, BackgroundPlan, FlagPlan, JobChipPlan, JobRowPlan, StatusPlan } from "../shared/plan.ts";
import { ACTIVITY_ICONS, BASE, DRAWING_MIN_SCALE, GRID_COMPACT_BELOW, GRID_GAP, SIGNAL, STEP_GLYPH, TONES, tokensFixed, type Delta, type Tone } from "../shared/ui-spec.ts";

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
export const sd = (tone: Tone, o: { halo?: boolean; pulse?: boolean; size?: number; spin?: boolean } = {}) => {
  const s = SIGNAL[tone];
  if (o.spin) return `<span class="sd spin ${tone}"${o.size ? ` style="width:${o.size}px;height:${o.size}px"` : ""}></span>`;
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

/** Lucide path data for each icon the Now row can use (Paseo draws the same names natively). */
export const ICON_SVG: Record<(typeof ACTIVITY_ICONS)[number], string> = {
  LayoutDashboard: '<rect width="7" height="9" x="3" y="3" rx="1"/><rect width="7" height="5" x="14" y="3" rx="1"/><rect width="7" height="9" x="14" y="12" rx="1"/><rect width="7" height="5" x="3" y="16" rx="1"/>',
  FlaskConical: '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  GitBranch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  SquareTerminal: '<path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2"/>',
  FilePen: '<path d="M12.5 22H18a2 2 0 0 0 2-2V7l-5-5H6a2 2 0 0 0-2 2v9.5"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M13.378 15.626a1 1 0 1 0-3.004-3.004l-5.01 5.012a2 2 0 0 0-.506.854l-.837 2.87a.5.5 0 0 0 .62.62l2.87-.837a2 2 0 0 0 .854-.506z"/>',
  Package: '<path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z"/><path d="M12 22V12"/><polyline points="3.29 7 12 12 20.71 7"/><path d="m7.5 4.27 9 5.15"/>',
  Hourglass: '<path d="M5 22h14"/><path d="M5 2h14"/><path d="M17 22v-4.172a2 2 0 0 0-.586-1.414L12 12l-4.414 4.414A2 2 0 0 0 7 17.828V22"/><path d="M7 2v4.172a2 2 0 0 0 .586 1.414L12 12l4.414-4.414A2 2 0 0 0 17 6.172V2"/>',
  Pencil: '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
  Eye: '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/>',
  Search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
  Globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
  Wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
};
const icon = (name: string) => `<svg class="ic" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_SVG[name as keyof typeof ICON_SVG] ?? ICON_SVG.Wrench}</svg>`;

/** The Now row. A <details> element, so tapping it opens the full command and the trail with no script (and the page's poll keeps it open). */
export function activityRow(a: ActivityPlan, foldPrefix?: string): string {
  const glyph = a.live ? `<span class="tg ${a.tone}">${icon(a.icon)}</span>` : '<span class="tg ring"></span>';
  const head = `${glyph}<span class="nt"><span class="nl">${esc(a.label)}</span>${a.target ? `<span class="mchip">${esc(a.target)}</span>` : ""}</span><span class="el ${a.tone}">${esc(a.elapsed)}</span>`;
  const cls = `now ${a.live ? a.tone : "idle"}${a.bookkeeping ? " book" : ""}`;
  if (!a.full && !a.recent.length) return `<div class="${cls}">${head}</div>`;
  const well = a.full ? `<div class="well">${a.full.split("\n").map((l) => `<span>${esc(l || " ")}</span>`).join("")}</div>` : "";
  const trail = a.recent.length ? `<ul class="trail">${a.recent.map((r) => `<li class="${r.ok ? "ok" : "err"}"><i class="tdot"></i>${esc(r.label)}${!r.ok && r.exitCode != null ? ` · exit ${r.exitCode}` : ""}</li>`).join("")}</ul>` : "";
  return `<details class="nowd"${foldPrefix ? ` id="${foldPrefix}-now"` : ""} data-k="now"><summary class="${cls}">${head}<span class="caret">›</span></summary><div class="nowx">${well}${trail}</div></details>`;
}

/**
 * One Background row: the Now row's grammar with a spinner and timer while running, a quiet check and the exit code once done,
 * and the one red-tinted row for a failure. A <details> so a tap shows the full command and the last Monitor event.
 */
export function jobRow(r: JobRowPlan, foldPrefix?: string): string {
  const tail = r.state === "running" ? sd("run", { spin: true, size: 14 }) : "";
  const head = `<span class="tg ${r.tone}">${icon(r.icon)}</span><span class="nt"><span class="nl">${esc(r.label)}</span>${r.target ? `<span class="mchip">${esc(r.target)}</span>` : ""}</span>${r.extra ? `<span class="jx">${esc(r.extra)}</span>` : ""}${tail}<span class="el ${r.tone}">${esc(r.elapsed)}</span>`;
  const cls = `now job ${r.tone}`;
  if (!r.full && !r.lastEvent) return `<div class="${cls}">${head}</div>`;
  const well = r.full ? `<div class="well">${r.full.split("\n").map((l) => `<span>${esc(l || " ")}</span>`).join("")}</div>` : "";
  const ev = r.lastEvent ? `<div class="meta">Last event: ${esc(r.lastEvent)}</div>` : "";
  return `<details class="nowd"${foldPrefix ? ` id="${foldPrefix}-job-${esc(r.id)}"` : ""} data-k="job-${esc(r.id)}"><summary class="${cls}">${head}<span class="caret">›</span></summary><div class="nowx">${well}${ev}</div></details>`;
}
/** B's compact form: one tinted chip for the Canvases list. */
export const jobChip = (c: JobChipPlan) => `<span class="chip ${c.tone} jobchip">${esc(c.glyph)} ${esc(c.text)}</span>`;
/** The Background group. On a phone the third row folds into "+n more" (CSS), so rows stay single-line. */
export function backgroundGroup(b: BackgroundPlan, foldPrefix?: string): string {
  const rows = b.rows.map((r, i) => `<div class="jr j${i + 1}">${jobRow(r, foldPrefix)}</div>`).join("");
  const more = b.more ? `<div class="meta jmore">${esc(b.more)}</div>` : "";
  // a third row hidden on a narrow screen is one more job behind the "+n more"
  const phone = b.rows.length > 2 ? `<div class="meta jmore jphone">+${(b.more ? Number(/\+(\d+)/.exec(b.more)?.[1] ?? 0) : 0) + b.rows.length - 2} more</div>` : "";
  return `<div class="bg">${slabel(b.heading, { count: b.count })}${rows}${more}${phone}</div>`;
}

/** Paseo's own line. Facts are Paseo's; the agent cannot write into it. */
/** `foldPrefix` (embed mode) gives the Now and job folds a page-unique id, so a host page keeps them open across refreshes. */
export function statusLine(p: StatusPlan, foldPrefix?: string): string {
  const facts = p.facts.map((f) => `<span${f.signal ? ` class="c-${f.signal}"` : ""}>${esc(f.text)}</span>`);
  const l2 = [...(p.lead ? [`<b class="c-${p.leadSignal}">${esc(p.lead)}</b>`] : []), ...facts].join('<span class="sep"> · </span>');
  return `<div class="statusline"><div class="l1">${badge(p.signal, p.label, p.signal === "ok" ? "check" : "dot")}${meta(p.run)}</div>${p.activity ? activityRow(p.activity, foldPrefix) : ""}${p.background ? backgroundGroup(p.background, foldPrefix) : ""}<div class="meta l2">${l2}</div>${p.flags.map(flagLine).join("")}</div>`;
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
.md{display:flex;flex-direction:column;gap:8px}.md p,.md ul,.md ol,.md blockquote,.md h2,.md h3,.md h4,.md h5,.md h6{margin:0}.md ul,.md ol{padding-left:22px}.md li{margin:2px 0}.md li>div>*+*{margin-top:4px}
.md h2{font-size:18px;line-height:26px;font-weight:600}.md h3{font-size:16px;line-height:24px;font-weight:600}.md h4,.md h5,.md h6{font-size:14px;line-height:20px;font-weight:600}
.md code{font:12px/18px var(--mono);background:var(--well);border-radius:4px;padding:1px 4px}.md .well code{background:none;padding:0}.md blockquote{border-left:2px solid var(--line-strong);padding-left:12px;color:var(--muted)}
.md li.task{list-style:none;display:flex;gap:8px;align-items:flex-start;margin-left:-22px}.chk{width:16px;height:16px;flex:none;margin-top:2px;border-radius:4px;box-shadow:inset 0 0 0 1.5px var(--line-strong);display:inline-flex;align-items:center;justify-content:center;font-size:11px}.chk.on{background:var(--ok);color:var(--bg);box-shadow:none}
.grid{display:grid;grid-template-columns:repeat(var(--cols,2),minmax(0,1fr));gap:${GRID_GAP}px;align-items:start}.cell{display:flex;flex-direction:column;gap:20px;min-width:0}
@media (max-width:${GRID_COMPACT_BELOW - 1}px){.grid{grid-template-columns:minmax(0,1fr)}}
.diff{border:1px solid var(--line);border-radius:10px;padding:0 12px}.diff summary{cursor:pointer;padding:9px 0;list-style:none;display:flex;align-items:center;gap:8px}.diff summary::-webkit-details-marker{display:none}.diff summary::before{content:"›";display:inline-block;width:10px;color:var(--muted);transition:transform .12s}.diff[open] summary::before{transform:rotate(90deg)}.diff .path{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.diff>.meta,.diff>.well{margin-bottom:12px}.diff>.meta{font:12px/16px var(--mono)}
.collapse{border:1px solid var(--line);border-radius:10px;padding:0 12px}.collapse summary{cursor:pointer;padding:9px 0;font-weight:500;list-style:none;display:flex;align-items:center;gap:8px}.collapse summary::-webkit-details-marker{display:none}.collapse summary::before{content:"›";display:inline-block;width:10px;color:var(--muted);transition:transform .12s}.collapse[open] summary::before{transform:rotate(90deg)}.collapse .cbody{display:flex;flex-direction:column;gap:20px;padding:4px 0 12px}
/* Drawings at natural size (one viewBox unit is one px), so a 13 px label stays 13 px: shrink to fit only down to 90%, then scroll. */
.svgwrap{color:var(--fg);max-width:100%;overflow-x:auto}.svgwrap svg{display:block;width:max(min(100%,var(--w,100%)),calc(var(--w,0px)*${DRAWING_MIN_SCALE}));max-width:none;height:auto}.fig img{display:block;max-width:100%;height:auto;border-radius:8px}.figmiss{color:var(--muted)}
.md .mdbody{display:flex;flex-direction:column;gap:4px;min-width:0}.md .tbl .ctr{text-align:center}.md .tbl{display:block;overflow-x:auto}
.note.run{background:var(--run-w)}.note.warn{background:var(--warn-w)}.note.err{background:var(--err-w)}.note.ok{background:var(--ok-w)}
.gc.solid.run{background:var(--run);color:var(--bg)}.gc.solid.warn{background:var(--warn);color:var(--bg)}.gc.solid.err{background:var(--err);color:var(--bg)}.gc.solid.ok{background:var(--ok);color:var(--bg)}
.chip{display:inline-flex;align-items:center;gap:5px;height:22px;padding:0 8px;border-radius:6px;font-size:13px;font-weight:500;align-self:flex-start}.chip.ok{background:var(--ok-w);color:var(--ok-t)}
.divider{height:1px;background:var(--line)}
.sd.spin{background:none;box-shadow:none;border:2px solid transparent;border-radius:50%;box-sizing:border-box;animation:spin .9s linear infinite}.sd.spin.run{border-color:var(--run-w);border-top-color:var(--run)}
@keyframes spin{to{transform:rotate(360deg)}}@media (prefers-reduced-motion:reduce){.sd.spin{animation:none;border-top-color:var(--run);border-right-color:var(--run)}}
.bg{display:flex;flex-direction:column;gap:2px;padding-top:2px}.jr{display:block}.jx{font-size:12px;color:var(--muted);white-space:nowrap;flex:none}.jmore{padding-left:0}.jphone{display:none}
.now.job.ok .tg,.tg.ok{background:var(--ok-w);color:var(--ok-t)}.tg.err{background:var(--err-w);color:var(--err-t)}.el.ok{color:var(--ok-t)}.el.err{color:var(--err-t)}
.now.job.err{background:var(--err-w)}details[open]>.now.job.err,details .now.job.err:hover{background:var(--err-w)}
.chip.run{background:var(--run-w);color:var(--run-t)}.chip.err{background:var(--err-w);color:var(--err-t)}.chip.warn{background:var(--warn-w);color:var(--warn-t)}.jobchip{height:20px;font-size:12px}
@media (max-width:480px){.jr.j3{display:none}.jmore:not(.jphone){display:none}.jphone{display:block}}
.nowd>summary{list-style:none}.nowd>summary::-webkit-details-marker{display:none}
.now{display:flex;align-items:center;gap:10px;min-height:32px;padding:4px 8px;margin:0 -8px;border-radius:8px}
details .now{cursor:pointer}details .now:hover,details[open]>.now{background:var(--raised)}
.tg{width:24px;height:24px;border-radius:6px;display:inline-flex;align-items:center;justify-content:center;flex:none}
.tg.run{background:var(--run-w);color:var(--run-t)}.tg.idle{background:var(--well);color:var(--muted)}
.tg.ring{background:none;box-shadow:inset 0 0 0 1.5px var(--line-strong);width:12px;height:12px;margin:0 6px;border-radius:6px}
.nt{display:flex;flex-direction:column;min-width:0;flex:1}
.nl{font-size:14px;line-height:18px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.now.idle .nl{color:var(--muted);font-weight:400}
.mchip{font:11.5px/16px var(--mono);color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.el{font-size:12px;font-weight:500;white-space:nowrap;margin-left:auto;flex:none}.el.run{color:var(--run-t)}.el.idle{color:var(--faint)}
.caret{color:var(--faint);font-size:16px;line-height:1;width:10px;text-align:center;flex:none}details[open] .caret{transform:rotate(90deg)}
.nowx{display:flex;flex-direction:column;gap:10px;padding-top:6px}
.nowx .well{font-size:11.5px;line-height:17px;max-height:calc(8*17px + 16px);overflow:auto}
.trail{list-style:none;margin:0;padding:0}.trail li{display:flex;align-items:center;gap:10px;font-size:12px;line-height:16px;color:var(--muted);padding:3px 0}
.tdot{width:8px;height:8px;border-radius:4px;flex:none}.trail .ok .tdot{background:var(--ok-w);box-shadow:inset 0 0 0 1.5px var(--ok)}.trail .err{color:var(--err-t)}.trail .err .tdot{background:var(--err)}
.list .row{display:flex;flex-direction:column;gap:4px;padding:14px 12px;margin:0 -12px;border-radius:8px;border-bottom:1px solid var(--line);color:inherit;text-decoration:none}.list .row:last-child{border-bottom:0}.list .row:hover{background:var(--raised);text-decoration:none}
.list .row.need{background:var(--hot-w);border-bottom-color:transparent}.list .row.dim{opacity:.55}
.list .row .ind:has(.jobchip){display:flex;align-items:center;gap:8px}.list .row .l1{display:flex;align-items:center;gap:10px}.list .row .l1 b{font-weight:600;min-width:0}.list .row .sp{flex:1}.list .row .ind{padding-left:18px}.list .row .bl{color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.list .row.need .bl{color:var(--fg)}
.canvas.dim .dimmable{opacity:.55}
`;
