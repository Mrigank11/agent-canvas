// A render plan: the canvas tree turned into a short list of primitive descriptions (kind, signal, glyph, text).
// The native and browser renderers draw from the same plan, so what a block means (which signal, which glyph,
// which cell is best) is decided here once. Renderers only decide how to paint it.
import { chartPoints, type Node, type StepState } from "./canvas.ts";
import { checkHonesty, summarize, type Verdict } from "./honesty.ts";
import type { CanvasView } from "./contract.ts";
import { pillState } from "./pill.ts";
import { FLAG_GLYPH, NOTE_GLYPH, STEP_GLYPH, TONES, ago, bestCells, flagSignal, isNumericColumn, metricSignal, noteSignal, parseDelta, runSignal, signalFor, stepSignal, visibleFlags, type Delta, type Tone } from "./ui-spec.ts";

export type StepPlan = { id: string; state: StepState; text: string; glyph: string; signal: Tone };
export type MetricPlan = { id: string; label: string; head: string; valueSignal: Tone | null; delta: Delta | null };
export type DiffLine = { kind: "add" | "del" | "hunk" | "ctx"; text: string };
export type BlockPlan =
  | { kind: "bluf"; id: string; text: string }
  | { kind: "steps"; id: string; label: string; ticks: StepState[]; count: string; rows: StepPlan[] }
  | { kind: "progress"; id: string; label: string; pct: number; text: string; signal: "run" | "ok" }
  | { kind: "metrics"; id: string; items: MetricPlan[] }
  | { kind: "decision"; id: string; label: string; chosen: string | null; reason: string }
  | { kind: "ask"; id: string; question: string; answered: string | null; options: { value: string; label: string }[] }
  | { kind: "diff"; id: string; file: string | null; add: number; del: number; lines: DiffLine[] }
  | { kind: "code"; id: string; text: string }
  | { kind: "chart"; id: string; label: string | null; line: boolean; points: { label: string; value: number }[] }
  | { kind: "table"; id: string; cols: string[]; numeric: boolean[]; rows: { text: string; best: boolean }[][] }
  | { kind: "link"; id: string; href: string; text: string }
  | { kind: "note"; id: string; signal: Tone; glyph: string; text: string };

export function diffLines(text: string): DiffLine[] {
  return text.split("\n").map((l) => ({ kind: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "ctx", text: l }));
}

function stepsPlan(n: Node): Extract<BlockPlan, { kind: "steps" }> {
  const rows = n.children.map((s) => { const state = String(s.attrs.state) as StepState; return { id: s.id, state, text: s.text, glyph: STEP_GLYPH[state], signal: stepSignal(state) }; });
  const done = rows.filter((r) => r.state === "done").length;
  return { kind: "steps", id: n.id, label: String(n.attrs.title ?? "Steps"), ticks: rows.map((r) => r.state), count: `${done}/${rows.length}`, rows };
}

/** Plan one block; consecutive Metrics are merged by `planBlocks`. */
export function planBlock(n: Node): BlockPlan | null {
  switch (n.tag) {
    case "Bluf": return { kind: "bluf", id: n.id, text: n.text };
    case "Steps": return stepsPlan(n);
    case "Progress": {
      const max = Number(n.attrs.max ?? 100) || 100;
      const pct = Math.max(0, Math.min(100, (Number(n.attrs.value) / max) * 100));
      return { kind: "progress", id: n.id, label: String(n.attrs.label ?? ""), pct, text: `${Math.round(pct)}%`, signal: pct >= 100 ? "ok" : "run" };
    }
    case "Metric": {
      const { head, delta } = parseDelta(String(n.attrs.value), n.attrs.tone as string | undefined);
      return { kind: "metrics", id: n.id, items: [{ id: n.id, label: String(n.attrs.label), head, valueSignal: metricSignal(n.attrs.tone as string | undefined), delta }] };
    }
    case "Decision": return { kind: "decision", id: n.id, label: `Decision · ${n.attrs.title}`, chosen: n.attrs.chosen ? String(n.attrs.chosen) : null, reason: n.text };
    case "Ask": {
      const options = n.children.map((o) => ({ value: String(o.attrs.value), label: o.text || String(o.attrs.value) }));
      const answer = n.attrs.answer ? String(n.attrs.answer) : null;
      return { kind: "ask", id: n.id, question: String(n.attrs.question), answered: answer === null ? null : options.find((o) => o.value === answer)?.label ?? answer, options };
    }
    case "Diff": {
      const lines = diffLines(n.text);
      return { kind: "diff", id: n.id, file: n.attrs.file ? String(n.attrs.file) : null, add: lines.filter((l) => l.kind === "add" && !l.text.startsWith("+++")).length, del: lines.filter((l) => l.kind === "del" && !l.text.startsWith("---")).length, lines };
    }
    case "Code": return { kind: "code", id: n.id, text: n.text };
    case "Chart": return { kind: "chart", id: n.id, label: n.attrs.title ? String(n.attrs.title) : null, line: n.attrs.kind === "line", points: chartPoints(String(n.attrs.data)) ?? [] };
    case "Table": {
      const cols = String(n.attrs.cols).split("|").map((c) => c.trim());
      const raw = n.children.map((r) => r.text.split("|").map((c) => c.trim()));
      const best = bestCells(cols, raw);
      return { kind: "table", id: n.id, cols, numeric: cols.map((_, c) => isNumericColumn(raw, c)), rows: raw.map((r, ri) => cols.map((_, c) => ({ text: r[c] ?? "", best: best.has(`${ri}:${c}`) }))) };
    }
    case "Link": return { kind: "link", id: n.id, href: String(n.attrs.href), text: n.text || String(n.attrs.href) };
    case "Note": {
      const tone = n.attrs.tone as string | undefined;
      return { kind: "note", id: n.id, signal: noteSignal(tone), glyph: NOTE_GLYPH[tone ?? "info"], text: n.text };
    }
    default: return null;
  }
}

/** The canvas's blocks in order, with runs of Metrics merged into one row. */
export function planBlocks(root: Node, only?: ReadonlySet<string>): BlockPlan[] {
  const out: BlockPlan[] = [];
  for (const c of root.children) {
    if (only && !only.has(c.tag)) continue;
    const p = planBlock(c);
    if (!p) continue;
    const last = out[out.length - 1];
    if (p.kind === "metrics" && last?.kind === "metrics") last.items.push(...p.items);
    else out.push(p);
  }
  return out;
}

// ---------- the status line and the per-agent view ----------

export type FlagPlan = { signal: "warn" | "err"; glyph: string; text: string };
export type StatusPlan = {
  signal: Tone;
  label: Verdict["label"];
  /** "Paseo: idle" */
  run: string;
  /** Line 2: the lead (needs-you) first, then facts. */
  lead: string | null;
  facts: { text: string; signal?: Tone }[];
  flags: FlagPlan[];
  dim: boolean;
};

export function statusPlan(view: Pick<CanvasView, "tree" | "runState" | "updatedAt" | "callsNow" | "callsAtUpdate" | "currentTool" | "lastActivityAt">, now: number, runOverride?: CanvasView["runState"]): StatusPlan {
  const run = runOverride ?? view.runState;
  const calls = Math.max(0, view.callsNow - view.callsAtUpdate);
  const verdict = checkHonesty(view.tree, { runState: run, canvasUpdatedAt: view.updatedAt, toolCallsSinceUpdate: calls, now });
  const asks = summarize(view.tree).openAsks;
  const facts: StatusPlan["facts"] = [];
  if (view.currentTool) facts.push({ text: `running ${view.currentTool}`, signal: "run" });
  facts.push({ text: `active ${ago(now - view.lastActivityAt)} ago` });
  facts.push({ text: view.updatedAt == null ? "canvas never written (auto canvas)" : `canvas updated ${ago(now - view.updatedAt)} ago` });
  facts.push({ text: `${calls} tool call${calls === 1 ? "" : "s"} since` });
  return {
    signal: signalFor(verdict.label),
    label: verdict.label,
    run: `Paseo: ${run}`,
    lead: verdict.needsYou ? (asks > 1 ? `Waiting on ${asks} answers` : "Waiting for your answer") : null,
    facts,
    flags: visibleFlags(verdict.flags).map((f) => ({ signal: flagSignal(f), glyph: FLAG_GLYPH[flagSignal(f)], text: f.text })),
    dim: verdict.dim,
  };
}

/** What the agent says about itself next to its title; it turns warn-coloured when the verdict contradicts it. */
export function selfStatus(view: Pick<CanvasView, "tree" | "auto">, label: Verdict["label"]): { text: string; contradicted: boolean } {
  if (view.auto) return { text: "auto canvas", contradicted: false };
  const status = String(view.tree.attrs.status ?? "working");
  return { text: status, contradicted: status === "done" && (label === "Disputed" || label === "Stale") };
}

export type RowPlan = { agentId: string; title: string; signal: Tone; label: string; ticks: StepState[]; bluf: string; meta: string; needsYou: boolean; flag: FlagPlan | null; dim: boolean };
/** One agent as a row in the Canvases list (native screen and browser index). */
export function rowPlan(view: CanvasView, now: number): RowPlan {
  const st = pillState(view, now);
  const sp = statusPlan(view, now);
  const steps = planBlocks(view.tree, new Set(["Steps"])).flatMap((b) => (b.kind === "steps" ? b.ticks : []));
  const bluf = view.tree.children.find((c) => c.tag === "Bluf");
  return {
    agentId: view.agentId,
    title: view.title,
    signal: st.tone === "hot" ? "hot" : sp.signal,
    label: sp.label,
    ticks: steps,
    bluf: bluf?.text ?? "",
    meta: `${view.auto ? "auto canvas" : "agent canvas"} · ${view.runState}`,
    needsYou: st.verdict.needsYou,
    flag: sp.flags[0] ?? null,
    dim: sp.dim,
  };
}

export { runSignal, TONES };
