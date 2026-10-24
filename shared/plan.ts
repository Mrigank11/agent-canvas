// A render plan: the canvas tree turned into a short list of primitive descriptions (kind, signal, glyph, text).
// The native and browser renderers draw from the same plan, so what a block means (which signal, which glyph,
// which cell is best) is decided here once. Renderers only decide how to paint it.
import { chartPoints, type Node, type StepState } from "./canvas.ts";
import { bgFacts, checkHonesty, summarize, type Verdict } from "./honesty.ts";
import type { CanvasView } from "./contract.ts";
import { pillState } from "./pill.ts";
import { BG_CAP, FLAG_GLYPH, LAST_VISIBLE_MS, NOTE_GLYPH, STEP_GLYPH, TONES, ago, bestCells, classifyActivity, classifyJob, jobName, oneLine, flagSignal, isNumericColumn, metricSignal, noteSignal, parseDelta, runSignal, signalFor, stepSignal, visibleFlags, visibleJobs, type BgJobLike, type Delta, type Tone } from "./ui-spec.ts";

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
/** The Now row. `live`: a call is running (elapsed ticks). Otherwise it is the quiet "Last: …" line, hidden after 10 minutes. */
export type ActivityPlan = {
  live: boolean;
  /** run = blue and ticking; idle = grey (idle agent, or the agent's own canvas bookkeeping) */
  tone: "run" | "idle";
  icon: string;
  label: string;
  target: string | null;
  /** "12s" while live, "2m 3s ago" for the last action */
  elapsed: string;
  bookkeeping: boolean;
  /** The full command, path, URL or query, for the expanded state. */
  full: string | null;
  /** The last three finished actions, newest first. */
  recent: { label: string; ok: boolean; exitCode: number | null }[];
};

export function activityPlan(view: Pick<CanvasView, "activity" | "recent">, now: number): ActivityPlan | null {
  const recent = (view.recent ?? []).map((r) => ({ label: r.label, ok: r.ok, exitCode: r.exitCode ?? null }));
  const a = view.activity;
  if (a) {
    const c = classifyActivity(a);
    return { live: true, tone: c.bookkeeping ? "idle" : "run", icon: c.icon, label: c.label, target: c.target, elapsed: ago(now - a.startedAt), bookkeeping: c.bookkeeping, full: a.command ?? a.path ?? a.url ?? a.query ?? null, recent };
  }
  const last = view.recent?.[0];
  if (!last || now - last.endedAt > LAST_VISIBLE_MS) return null;
  return { live: false, tone: "idle", icon: iconForKind(last.kind), label: `Last: ${last.label}`, target: null, elapsed: `${ago(now - last.endedAt)} ago`, bookkeeping: false, full: null, recent };
}
const iconForKind = (k: string) => (k === "shell" ? "SquareTerminal" : k === "edit" || k === "write" ? "Pencil" : k === "read" ? "Eye" : k === "search" ? "Search" : k === "fetch" ? "Globe" : "Wrench");

// ---------- background jobs (the Background rows and the compact chip) ----------

export type JobRowPlan = {
  id: string;
  kind: BgJobLike["kind"];
  /** run = ticking; ok = finished clean; err = failed or killed (the one red-tinted row); idle = lost */
  tone: "run" | "ok" | "err" | "idle";
  state: BgJobLike["state"];
  icon: string;
  label: string;
  target: string | null;
  /** "6m 12s" (a lower bound reads "≥ 6m 12s") while running; "exit 0 · 2m ago" once finished */
  elapsed: string;
  /** Right-hand count for a Monitor: "2 events". */
  extra: string | null;
  /** The full command and the last Monitor event, for the expanded state. */
  full: string | null;
  lastEvent: string | null;
};
export type JobChipPlan = { tone: "run" | "ok" | "err" | "warn"; glyph: string; text: string };
export type BackgroundPlan = {
  heading: string;
  /** "2 running", or "1 finished" when none is running */
  count: string;
  rows: JobRowPlan[];
  /** Jobs beyond the cap: "+1 more · Monitor “deploy logs”" */
  more: string | null;
  /** B's compact form, for the timeline card and the Canvases list. */
  chip: JobChipPlan;
  running: number;
};

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

function jobRow(j: BgJobLike, now: number): JobRowPlan {
  const c = classifyJob(j);
  const running = j.state === "running";
  const tone: JobRowPlan["tone"] = running ? "run" : j.state === "done" ? "ok" : j.state === "lost" ? "idle" : "err";
  const exit = j.exitCode != null ? `exit ${j.exitCode}` : j.state === "killed" ? "killed" : j.state === "lost" ? "lost" : j.state === "failed" ? "failed" : null;
  const tail = `${ago(now - (j.endedAt ?? now))} ago`;
  const elapsed = running ? `${j.approx ? "≥ " : ""}${ago(now - j.startedAt)}` : [exit, tail].filter(Boolean).join(" · ");
  const events = j.events ?? 0;
  return {
    id: j.id,
    kind: j.kind,
    tone,
    state: j.state,
    icon: c.icon,
    label: running || j.state === "lost" ? c.label : c.past,
    target: j.kind === "monitor" ? ["Monitor", running && j.expires ? `expires in ${j.expires}` : null].filter(Boolean).join(" · ") : c.target,
    elapsed,
    extra: j.kind === "monitor" && events > 0 ? plural(events, "event") : null,
    full: j.command || null,
    lastEvent: j.lastEvent ?? null,
  };
}

export function backgroundPlan(view: Pick<CanvasView, "background" | "runState">, now: number, cap: number = BG_CAP.wide): BackgroundPlan | null {
  const jobs = visibleJobs(view, now);
  if (!jobs.length) return null;
  const rows = jobs.slice(0, cap).map((j) => jobRow(j, now));
  const left = jobs.slice(cap);
  const running = jobs.filter((j) => j.state === "running").length;
  const failed = jobs.filter((j) => j.state === "failed" || j.state === "killed").length;
  const lost = jobs.filter((j) => j.state === "lost").length;
  const chip: JobChipPlan = failed ? { tone: "err", glyph: "✕", text: `${plural(failed, "job")} failed` }
    : running ? { tone: "run", glyph: "⟳", text: `${running} in background` }
    : lost ? { tone: "warn", glyph: "!", text: `${plural(lost, "job")} lost` }
    : { tone: "ok", glyph: "✓", text: `${plural(jobs.length, "job")} done` };
  return {
    heading: "Background",
    count: running ? `${running} running` : `${jobs.length} finished`,
    rows,
    more: left.length ? `+${left.length} more${left.length === 1 ? ` · ${jobName(left[0])}` : ""}` : null,
    chip,
    running,
  };
}

export type StatusPlan = {
  signal: Tone;
  label: Verdict["label"];
  /** "Paseo: idle" */
  run: string;
  /** Line 2: the lead (needs-you) first, then facts. */
  lead: string | null;
  /** hot for "needs you", run for "Waiting on 2 background jobs" */
  leadSignal: "hot" | "run";
  facts: { text: string; signal?: Tone }[];
  flags: FlagPlan[];
  dim: boolean;
  /** The Now row, or null when the agent has been quiet for 10 minutes. */
  activity: ActivityPlan | null;
  /** The Background rows under it, or null when the agent has no job to show. */
  background: BackgroundPlan | null;
};

export function statusPlan(view: Pick<CanvasView, "tree" | "runState" | "updatedAt" | "callsNow" | "callsAtUpdate" | "currentTool" | "lastActivityAt" | "activity" | "recent" | "background">, now: number, runOverride?: CanvasView["runState"], jobCap: number = BG_CAP.wide): StatusPlan {
  const run = runOverride ?? view.runState;
  const jobs = visibleJobs({ background: view.background, runState: run }, now);
  const bg = bgFacts(jobs, run, now);
  const calls = Math.max(0, view.callsNow - view.callsAtUpdate);
  const verdict = checkHonesty(view.tree, { runState: run, canvasUpdatedAt: view.updatedAt, toolCallsSinceUpdate: calls, now, background: bg });
  const asks = summarize(view.tree).openAsks;
  const facts: StatusPlan["facts"] = [];
  const activity = activityPlan(view, now);
  // the Now row says what is running; the old one-line fact stays only for a view that carries no structured activity
  if (view.currentTool && !view.activity) facts.push({ text: `running ${oneLine(view.currentTool)}`, signal: "run" });
  // a job that finished while the agent was idle and has not woken it yet
  const fin = run === "idle" ? jobs.filter((j) => j.state === "done" && j.endedAt != null && j.endedAt > view.lastActivityAt).sort((a, b) => b.endedAt! - a.endedAt!)[0] : undefined;
  if (fin) facts.unshift({ text: `Background job finished ${ago(now - fin.endedAt!)} ago · agent will pick it up` });
  facts.push({ text: `active ${ago(now - view.lastActivityAt)} ago` });
  facts.push({ text: view.updatedAt == null ? "canvas never written (auto canvas)" : `canvas updated ${ago(now - view.updatedAt)} ago` });
  facts.push({ text: `${calls} tool call${calls === 1 ? "" : "s"} since` });
  return {
    signal: signalFor(verdict.label),
    label: verdict.label,
    run: `Paseo: ${run}`,
    lead: verdict.needsYou ? (asks > 1 ? `Waiting on ${asks} answers` : "Waiting for your answer") : verdict.waitingOn > 0 ? `Waiting on ${plural(verdict.waitingOn, "background job")}` : null,
    facts,
    leadSignal: verdict.needsYou ? "hot" : "run",
    flags: visibleFlags(verdict.flags).map((f) => ({ signal: flagSignal(f), glyph: FLAG_GLYPH[flagSignal(f)], text: f.text })),
    dim: verdict.dim,
    activity,
    background: backgroundPlan({ background: view.background, runState: run }, now, jobCap),
  };
}

/** What the agent says about itself next to its title; it turns warn-coloured when the verdict contradicts it. */
export function selfStatus(view: Pick<CanvasView, "tree" | "auto">, label: Verdict["label"]): { text: string; contradicted: boolean } {
  if (view.auto) return { text: "auto canvas", contradicted: false };
  const status = String(view.tree.attrs.status ?? "working");
  return { text: status, contradicted: status === "done" && (label === "Disputed" || label === "Stale") };
}

export type RowPlan = { agentId: string; title: string; signal: Tone; label: string; ticks: StepState[]; bluf: string; meta: string; needsYou: boolean; flag: FlagPlan | null; dim: boolean; /** "2 in background", the compact form of the Background rows */ jobs: JobChipPlan | null };
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
    jobs: backgroundPlan(view, now)?.chip ?? null,
    needsYou: st.verdict.needsYou,
    flag: sp.flags[0] ?? null,
    dim: sp.dim,
  };
}

export { runSignal, TONES };
