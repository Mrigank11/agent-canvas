// Vega-Lite spec to a safe SVG, in Node with no DOM and no canvas: vega-lite compiles to a Vega spec, Vega's dataflow runs it
// with the AST interpreter (so no Function/eval ever sees an agent expression) and its SVG string renderer draws it. Text is
// measured by Vega's estimator since there is no canvas. The bundle is vendored (gzipped) and loaded on first use.
import { gunzipSync } from "node:zlib";
import { RENDERED_LIMITS, sanitizeSvg } from "../../shared/svg.ts";
import { checkVegaSpec } from "../../shared/vegaspec.ts";
import { VEGA_GZ_B64 } from "../vendor/vega-bundle.ts";

type Lib = {
  compile: (spec: unknown, opts: { logger: unknown }) => { spec: unknown };
  parse: (spec: unknown, config: unknown, opts: { ast: boolean }) => unknown;
  View: new (rt: unknown, opts: { renderer: string; expr: unknown }) => { toSVG(): Promise<string>; finalize(): void };
  expressionInterpreter: unknown;
};
let lib: Promise<Lib> | null = null;
const load = () => (lib ??= import(`data:text/javascript;base64,${gunzipSync(Buffer.from(VEGA_GZ_B64, "base64")).toString("base64")}`).catch((e) => { lib = null; throw e; }) as Promise<Lib>);

/** Theme: ink is currentColor (black on light, white on dark, set by whoever draws the SVG), no background, quiet grid. */
const INK = "currentColor";
const THEME = {
  background: "transparent",
  view: { stroke: "transparent" },
  font: "Liberation Sans",
  axis: { domainColor: INK, domainOpacity: 0.5, tickColor: INK, tickOpacity: 0.5, gridColor: INK, gridOpacity: 0.12, labelColor: INK, titleColor: INK, labelFontSize: 10, titleFontSize: 11, titleFontWeight: "normal" },
  legend: { labelColor: INK, titleColor: INK, labelFontSize: 10, titleFontSize: 11, titleFontWeight: "normal" },
  header: { labelColor: INK, titleColor: INK },
  title: { color: INK, subtitleColor: INK, fontSize: 13, fontWeight: 600, anchor: "start" },
  text: { color: INK, fontSize: 10 },
  mark: { color: "#4c78a8" },
  style: { "guide-label": { fill: INK }, "guide-title": { fill: INK }, "group-title": { fill: INK } },
};
const isObj = (x: unknown): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x);
const merge = (base: Record<string, unknown>, over: unknown): Record<string, unknown> => {
  if (!isObj(over)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(base[k]) ? merge(base[k] as Record<string, unknown>, v) : v;
  return out;
};

export type VegaRender = { ok: true; svg: string; w: number; h: number; notes: string[] } | { ok: false; error: string };

export async function renderVega(body: string): Promise<VegaRender> {
  const c = checkVegaSpec(body);
  if (!c.ok) return c;
  const spec: Record<string, unknown> = { ...c.spec, config: merge(THEME, c.spec.config) };
  if (spec.width === undefined && !("layer" in spec) && !("hconcat" in spec) && !("vconcat" in spec) && !("facet" in spec) && !("repeat" in spec)) spec.width = 480;
  if (spec.height === undefined && "mark" in spec) spec.height = 240;
  const warnings: string[] = [];
  const logger = { level() { return this; }, warn: (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); return logger; }, info: () => logger, debug: () => logger, error: (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); return logger; } };
  let raw: string;
  try {
    const v = await load();
    const vg = v.compile(spec, { logger }).spec;
    const view = new v.View(v.parse(vg, null, { ast: true }), { renderer: "none", expr: v.expressionInterpreter });
    try { raw = await view.toSVG(); } finally { view.finalize(); }
  } catch (e) {
    return { ok: false, error: `Vega-Lite: ${(e as Error).message.replace(/\s+/g, " ").trim().slice(0, 300)}` };
  }
  const s = sanitizeSvg(raw, RENDERED_LIMITS);
  if (!s.ok) return { ok: false, error: `the chart output was refused: ${s.error}` };
  return { ok: true, svg: s.svg, w: s.w, h: s.h, notes: [...new Set(warnings)].slice(0, 3).map((w) => `Vega-Lite: ${w.slice(0, 160)}`) };
}
