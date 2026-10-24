// Graphviz DOT to a safe SVG. Layout runs in a worker thread (see worker.ts) (Graphviz compiled to wasm, vendored: no node_modules, no
// browser) with a hard timeout, because a pathological graph can spin for ever; on overrun the worker is terminated.
import { DOT_LIMITS, INK, PAPER, prepareDot } from "../../shared/dot.ts";
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
  const themed = raw
    .replace(/<!DOCTYPE[\s\S]*?>/, "")
    .replaceAll(`fill="${PAPER}"`, 'fill="none"').replaceAll(`stroke="${PAPER}"`, 'stroke="none"')
    .replaceAll(`"${INK}"`, '"currentColor"')
    .replace(/font-family="[^"]*"/g, 'font-family="Liberation Sans, Arial, Helvetica, sans-serif"');
  const s = sanitizeSvg(themed, RENDERED_LIMITS);
  if (!s.ok) return { ok: false, error: `Graphviz output was refused: ${s.error}` };
  const notes = pre.removed.length ? [`removed ${pre.removed.join(", ")} (links, files and stylesheets are not allowed)`] : [];
  return { ok: true, svg: s.svg, w: s.w, h: s.h, notes };
}

/** Test hook and shutdown. */
export const stopDotWorker = () => pool.stop();
