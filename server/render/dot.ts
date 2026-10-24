// Graphviz DOT to a safe SVG. Layout runs in a worker thread (see worker.ts) (Graphviz compiled to wasm, vendored: no node_modules, no
// browser) with a hard timeout, because a pathological graph can spin for ever; on overrun the worker is terminated.
import { DOT_LIMITS, INK, LINE, MUTED, MUTED_TEXT, PAPER, WELL, prepareDot } from "../../shared/dot.ts";
import { DIAGRAM, DIAGRAM_FONT } from "../../shared/ui-spec.ts";
import { RENDERED_LIMITS, sanitizeSvg } from "../../shared/svg.ts";
import { GRAPHVIZ_WORKER_GZ_B64 } from "../vendor/graphviz-worker.ts";
import { TimedWorker } from "./worker.ts";

export const DOT_TIMEOUT_MS = 3_000;
const pool = new TimedWorker<{ dot: string }, { svg?: string; error?: string }>(GRAPHVIZ_WORKER_GZ_B64, "Graphviz", DOT_TIMEOUT_MS);
const overrun = (ms: number) => `Graphviz took longer than ${ms / 1000} s and was stopped: the graph is too complex to lay out (fewer nodes or edges, or drop splines=ortho / large clusters)`;

export type DotRender = { ok: true; svg: string; w: number; h: number; notes: string[] } | { ok: false; error: string };

export async function renderDot(body: string, opts: { timeoutMs?: number } = {}): Promise<DotRender> {
  const pre = prepareDot(body);
  if (!pre.ok) return pre;
  let raw: string;
  try {
    const r = await pool.run({ dot: pre.dot }, overrun, opts.timeoutMs);
    if (r.svg === undefined) return { ok: false, error: (r.error ?? "Graphviz failed").replace(/\s+/g, " ").trim() };
    raw = r.svg;
  } catch (e) { return { ok: false, error: (e as Error).message.replace(/\s+/g, " ").trim() }; }
  const nodes = (raw.match(/<g id="node\d+" class="node">/g) ?? []).length;
  if (nodes > DOT_LIMITS.nodes) return { ok: false, error: `more than ${DOT_LIMITS.nodes} nodes (${nodes})` };
  // Page-dependent paint: ink is currentColor, and the card fill, outline and connectors are ink at a low opacity (see DIAGRAM).
  const inkAt = (hex: string, opacity: number) => (t: string) => t.replaceAll(`fill="${hex}"`, `fill="currentColor" fill-opacity="${opacity}"`).replaceAll(`stroke="${hex}"`, `stroke="currentColor" stroke-opacity="${opacity}"`);
  const themed = [inkAt(WELL, DIAGRAM.well), inkAt(LINE, DIAGRAM.line), inkAt(MUTED, DIAGRAM.muted), inkAt(MUTED_TEXT, DIAGRAM.mutedText)]
    .reduce((t, f) => f(t), raw.replace(/<!DOCTYPE[\s\S]*?>/, ""))
    .replaceAll(`fill="${PAPER}"`, 'fill="none"').replaceAll(`stroke="${PAPER}"`, 'stroke="none"')
    .replaceAll(`"${INK}"`, '"currentColor"')
    .replace(/<g id="edge(\d+)" class="edge">/g, '<g id="edge$1" class="edge" stroke-linecap="round" stroke-linejoin="round">')
    .replace(/font-family="[^"]*"/g, `font-family="${DIAGRAM_FONT}"`);
  const s = sanitizeSvg(themed, RENDERED_LIMITS);
  if (!s.ok) return { ok: false, error: `Graphviz output was refused: ${s.error}` };
  const notes = pre.removed.length ? [`removed ${pre.removed.join(", ")} (links, files and stylesheets are not allowed)`] : [];
  return { ok: true, svg: s.svg, w: s.w, h: s.h, notes };
}

/** Test hook and shutdown. */
export const stopDotWorker = () => pool.stop();
