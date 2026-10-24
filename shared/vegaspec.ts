// <Chart lang="vega-lite">: the checks on the agent's spec that need no Vega code. A spec is data plus a recipe, so the rules
// are about what it may reach: inline rows only (no url, no datasets from elsewhere), no links, no images, bounded size.
// Vega-Lite's own compile() then rejects what is not a valid chart; the renderer returns that message to the agent.

export const VEGA_LIMITS = { chars: 16_000, rows: 5_000, size: 2_000 };

/** Keys that fetch (`url`), link (`href`), carry opaque payloads (`usermeta`) or generate unbounded data (`sequence`). Rejected anywhere in the spec. */
const FORBIDDEN_KEYS = new Set(["url", "href", "usermeta", "sequence", "loader", "baseURL"]);
/** Mark types that draw something fetched. */
const FORBIDDEN_MARKS = new Set(["image"]);
/** Top-level properties Vega-Lite v5/v6 defines; anything else is a typo the agent should hear about. */
const TOP_KEYS = new Set(["$schema", "title", "description", "name", "width", "height", "padding", "autosize", "background", "data", "datasets", "transform", "params", "mark", "encoding", "layer", "hconcat", "vconcat", "concat", "facet", "repeat", "spec", "columns", "resolve", "config", "projection", "view", "center", "spacing", "bounds", "align"]);

export type VegaCheck = { ok: true; spec: Record<string, unknown>; rows: number } | { ok: false; error: string };

export function checkVegaSpec(text: string): VegaCheck {
  if (!text.trim()) return { ok: false, error: "the Vega-Lite spec is empty" };
  if (text.length > VEGA_LIMITS.chars) return { ok: false, error: `the Vega-Lite spec is over ${VEGA_LIMITS.chars} characters` };
  let spec: unknown;
  try { spec = JSON.parse(text); } catch (e) { return { ok: false, error: `the Vega-Lite spec is not valid JSON (${(e as Error).message})` }; }
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return { ok: false, error: "the Vega-Lite spec must be a JSON object" };
  const top = spec as Record<string, unknown>;
  for (const k of Object.keys(top)) if (!TOP_KEYS.has(k)) return { ok: false, error: `unknown top-level property "${k}" (Vega-Lite properties: ${[...TOP_KEYS].join(", ")})` };
  if (typeof top.$schema === "string" && !/^https:\/\/vega\.github\.io\/schema\/vega-lite\/v[56](\.\d+)*\.json$/.test(top.$schema)) return { ok: false, error: '$schema must be a Vega-Lite v5 or v6 schema URL, or omitted (it is never fetched)' };
  for (const k of ["width", "height"]) {
    const v = top[k];
    if (v !== undefined && v !== "container" && (typeof v !== "number" || !(v > 0) || v > VEGA_LIMITS.size)) return { ok: false, error: `${k} must be a number between 1 and ${VEGA_LIMITS.size}` };
  }
  let rows = 0, nodes = 0, problem: string | null = null;
  const visit = (v: unknown, path: string, depth: number) => {
    if (problem) return;
    if (++nodes > 20_000 || depth > 24) { problem = "the spec is nested too deeply or has too many parts"; return; }
    if (Array.isArray(v)) { v.forEach((x, i) => visit(x, `${path}[${i}]`, depth + 1)); return; }
    if (!v || typeof v !== "object") return;
    for (const [k, x] of Object.entries(v)) {
      if (k === "values" && Array.isArray(x) && /(^|\.)(data|datasets\.[^.]+)$/.test(path)) { rows += x.length; continue; }
      if (FORBIDDEN_KEYS.has(k)) { problem = `"${k}" is not allowed (at ${path || "the top"}): data must be inline rows, with no URLs, links or metadata`; return; }
      if (k === "mark" || k === "type") {
        const m = typeof x === "string" ? x : (x as { type?: unknown } | null)?.type;
        if (k === "mark" && typeof m === "string" && FORBIDDEN_MARKS.has(m)) { problem = `mark "${m}" is not allowed: it loads a picture (use <Image>)`; return; }
      }
      if (typeof x === "string" && /(https?:|file:|javascript:|data:[a-z]+\/)|^\/\//i.test(x) && k !== "title" && k !== "text" && k !== "label" && k !== "name" && k !== "field") { problem = `"${k}" looks like a URL (at ${path || "the top"}): nothing is fetched`; return; }
      visit(x, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  visit(top, "", 0);
  if (problem) return { ok: false, error: problem };
  if (rows > VEGA_LIMITS.rows) return { ok: false, error: `more than ${VEGA_LIMITS.rows} inline data rows (${rows})` };
  const d = top.data as { values?: unknown } | undefined;
  const named = top.datasets && typeof top.datasets === "object";
  const hasData = (d && typeof d === "object" && "values" in d) || named || ["layer", "hconcat", "vconcat", "concat", "spec", "repeat"].some((k) => k in top);
  if (!hasData) return { ok: false, error: 'the spec needs inline data: "data": {"values": [ … ]}' };
  return { ok: true, spec: top, rows };
}

/** The old `<Chart kind data>` as a Vega-Lite spec (one conversion for every consumer). */
export function legacyChartSpec(kind: string | undefined, title: string | undefined, points: { label: string; value: number }[]): string {
  const spec: Record<string, unknown> = {
    ...(title ? { title } : {}),
    data: { values: points.map((p) => ({ label: p.label, value: p.value })) },
    mark: kind === "line" ? { type: "line", point: true } : "bar",
    encoding: { x: { field: "label", type: "nominal", sort: null, title: null, axis: { labelAngle: 0 } }, y: { field: "value", type: "quantitative", title: null } },
  };
  return JSON.stringify(spec);
}
