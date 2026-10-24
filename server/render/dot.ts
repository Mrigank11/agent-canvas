// Graphviz DOT to a safe SVG. Layout runs in a worker thread (Graphviz compiled to wasm, vendored: no node_modules, no
// browser) with a hard timeout, because a pathological graph can spin for ever; on overrun the worker is terminated.
import { gunzipSync } from "node:zlib";
import { Worker } from "node:worker_threads";
import { DOT_LIMITS, INK, PAPER, prepareDot } from "../../shared/dot.ts";
import { RENDERED_LIMITS, sanitizeSvg } from "../../shared/svg.ts";
import { GRAPHVIZ_WORKER_GZ_B64 } from "../vendor/graphviz-worker.ts";

export const DOT_TIMEOUT_MS = 3_000;
const IDLE_MS = 30_000;

let worker: Worker | null = null;
let ready: Promise<Worker> | null = null;
let idle: ReturnType<typeof setTimeout> | null = null;
let tail: Promise<unknown> = Promise.resolve();

function spawn(): Promise<Worker> {
  return (ready ??= new Promise<Worker>((resolve, reject) => {
    const src = gunzipSync(Buffer.from(GRAPHVIZ_WORKER_GZ_B64, "base64"));
    const w = new Worker(new URL(`data:text/javascript;base64,${src.toString("base64")}`) as never);
    worker = w;
    const fail = (e: Error) => { if (worker === w) { worker = null; ready = null; } reject(e); };
    w.once("error", fail);
    w.once("exit", () => fail(new Error("the Graphviz worker stopped")));
    const onReady = (m: { ready?: boolean; error?: string }) => {
      if (m.ready === undefined) return;
      w.off("message", onReady);
      if (m.ready) { w.unref(); resolve(w); } else fail(new Error(m.error ?? "Graphviz failed to start"));
    };
    w.on("message", onReady);
  }));
}

function stop() { const w = worker; worker = null; ready = null; if (idle) clearTimeout(idle); idle = null; if (w) void w.terminate(); }

let seq = 0;
async function layout(dot: string, timeoutMs: number): Promise<string> {
  const w = await spawn();
  const id = ++seq;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { cleanup(); stop(); reject(new Error(`Graphviz took longer than ${timeoutMs / 1000} s and was stopped: the graph is too complex to lay out (fewer nodes or edges, or drop splines=ortho / large clusters)`)); }, timeoutMs);
    const onMsg = (m: { id?: number; svg?: string; error?: string }) => {
      if (m.id !== id) return;
      cleanup();
      if (m.svg !== undefined) resolve(m.svg); else reject(new Error(m.error ?? "Graphviz failed"));
    };
    const onExit = () => { cleanup(); reject(new Error("the Graphviz worker stopped")); };
    const cleanup = () => { clearTimeout(timer); w.off("message", onMsg); w.off("exit", onExit); if (idle) clearTimeout(idle); idle = setTimeout(stop, IDLE_MS); idle.unref(); };
    w.on("message", onMsg);
    w.once("exit", onExit);
    w.postMessage({ id, dot });
  });
}

export type DotRender = { ok: true; svg: string; w: number; h: number; notes: string[] } | { ok: false; error: string };

export async function renderDot(body: string, opts: { timeoutMs?: number } = {}): Promise<DotRender> {
  const pre = prepareDot(body);
  if (!pre.ok) return pre;
  // one layout at a time: the worker is single-threaded and RAM is the constraint
  const run = tail.then(() => layout(pre.dot, opts.timeoutMs ?? DOT_TIMEOUT_MS));
  tail = run.catch(() => undefined);
  let raw: string;
  try { raw = await run; } catch (e) { return { ok: false, error: (e as Error).message.replace(/\s+/g, " ").trim() }; }
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
export const stopDotWorker = stop;
