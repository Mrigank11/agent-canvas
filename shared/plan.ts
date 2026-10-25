// A render plan: the canvas tree turned into a short list of primitive descriptions (kind, signal, glyph, text).
// The native and browser renderers draw from the same plan, so what a block means (which signal, which glyph,
// which cell is best) is decided here once. Renderers only decide how to paint it.
import { mapImages, parseMarkdown, type MdBlock } from "./markdown.ts";
import { type Node, type StepState } from "./canvas.ts";
import { bgFacts, checkHonesty, summarize, type Verdict } from "./honesty.ts";
import type { CanvasView } from "./contract.ts";
import { pillState } from "./pill.ts";
import { BG_CAP, FLAG_GLYPH, LAST_VISIBLE_MS, STEP_GLYPH, TONES, ago, classifyActivity, classifyJob, jobName, oneLine, flagSignal, metricSignal, parseDelta, runSignal, signalFor, stepSignal, visibleFlags, visibleJobs, type BgJobLike, type Delta, type Tone } from "./ui-spec.ts";

export type StepPlan = { id: string; state: StepState; text: string; glyph: string; signal: Tone };
export type MetricPlan = { id: string; label: string; head: string; valueSignal: Tone | null; delta: Delta | null };
export type DiffLine = { kind: "add" | "del" | "hunk" | "ctx"; text: string };
export type BlockPlan =
  | { kind: "bluf"; id: string; text: string }
  | { kind: "steps"; id: string; label: string; ticks: StepState[]; count: string; rows: StepPlan[] }
  | { kind: "progress"; id: string; label: string; pct: number; text: string; signal: "run" | "ok" }
  | { kind: "metrics"; id: string; items: MetricPlan[] }
  | { kind: "decision"; id: string; label: string; chosen: string | null; reason: string }
  | { kind: "ask"; id: string; question: string; answered: string | null; /** a pick sent to a relay agent and not yet delivered, as the option label */ pending: string | null; options: { value: string; label: string }[] }
  | { kind: "diff"; id: string; file: string | null; /** every file the body touches (else the `file` attribute), in order */ files: string[]; add: number; del: number; /** the closed header: "src/a.ts · +5 −2", "3 files · +40 −12" or "Diff · +5 −2" */ summary: string; lines: DiffLine[] }
  | { kind: "markdown"; id: string; blocks: MdBlock[] }
  /** Layout: `cols` is the wide-screen count (a compact surface draws one). `open` is forced when an unanswered Ask is inside. */
  | { kind: "grid"; id: string; cols: number; /** natural width of the widest drawing directly in it, 0 if none: a grid gives such a drawing a wider cell by using fewer columns */ wide: number; children: BlockPlan[] }
  | { kind: "collapse"; id: string; title: string; open: boolean; children: BlockPlan[] }
  /** An agent drawing, a DOT diagram or a Vega-Lite chart: all three end as one rebuilt SVG artefact. `hash`: the server's artefact for it (null when the client was given the raw tree, or the artefact is gone: drawn as `alt`). */
  | { kind: "svg"; id: string; hash: string | null; alt: string; w: number; h: number }
  | { kind: "image"; id: string; hash: string | null; alt: string; src: string; w: number; h: number };

/** The size and hash the server attached to a node (see Assets.wire); absent on a tree that was never wired. */
const assetOf = (a: Node["attrs"]): { hash: string | null; w: number; h: number } => ({ hash: typeof a.hash === "string" ? a.hash : null, w: Number(a.w) || 0, h: Number(a.h) || 0 });

export function diffLines(text: string): DiffLine[] {
  return text.split("\n").map((l) => ({ kind: l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("@@") ? "hunk" : "ctx", text: l }));
}

/** The files a unified diff touches, in order: the `b/` side of `diff --git` and `+++` lines, `/dev/null` skipped. */
export function diffFiles(text: string): string[] {
  const out: string[] = [];
  for (const l of text.split("\n")) {
    const m = /^diff --git a\/.* b\/(.+)$/.exec(l) ?? /^\+\+\+ (?:b\/)?(\S.*?)(?:\t.*)?$/.exec(l);
    if (m && m[1] !== "/dev/null" && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/** The one line a closed Diff shows. */
export function diffSummary(files: string[], add: number, del: number): string {
  return `${files.length === 1 ? files[0] : files.length > 1 ? `${files.length} files` : "Diff"} · +${add} −${del}`;
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
      return { kind: "ask", id: n.id, question: String(n.attrs.question), answered: answer === null ? null : options.find((o) => o.value === answer)?.label ?? answer, pending: !answer && n.attrs.pending ? options.find((o) => o.value === n.attrs.pending)?.label ?? String(n.attrs.pending) : null, options };
    }
    case "Diff": {
      const lines = diffLines(n.text);
      const file = n.attrs.file ? String(n.attrs.file) : null;
      const found = diffFiles(n.text);
      const files = found.length ? found : file ? [file] : [];
      const add = lines.filter((l) => l.kind === "add" && !l.text.startsWith("+++")).length;
      const del = lines.filter((l) => l.kind === "del" && !l.text.startsWith("---")).length;
      return { kind: "diff", id: n.id, file, files, add, del, summary: diffSummary(files, add, del), lines };
    }
    case "Markdown": {
      const md = parseMarkdown(n.text);
      let found: Record<string, { hash: string; w: number; h: number }> = {};
      try { found = typeof n.attrs.assets === "string" ? JSON.parse(n.attrs.assets) : {}; } catch { /* a tree from a wire that is not ours: no images */ }
      const blocks = md.ok ? mapImages(md.blocks, (b) => (found[b.src] ? { ...b, ...found[b.src] } : b)) : [{ k: "paragraph" as const, c: [{ t: "text" as const, v: n.text }] }];
      return { kind: "markdown", id: n.id, blocks };
    }
    case "Svg": case "Diagram": case "Chart": return { kind: "svg", id: n.id, alt: String(n.attrs.alt ?? ""), ...assetOf(n.attrs) };
    case "Image": return { kind: "image", id: n.id, alt: String(n.attrs.alt ?? ""), src: String(n.attrs.src), ...assetOf(n.attrs) };
    case "Grid": { const children = planBlocks(n); return { kind: "grid", id: n.id, cols: Math.max(1, Math.min(3, Number(n.attrs.cols ?? 2) || 2)), wide: Math.max(0, ...children.map((c) => (c.kind === "svg" ? c.w : 0))), children }; }
    case "Collapse": return { kind: "collapse", id: n.id, title: String(n.attrs.title), open: n.attrs.open === true || hasOpenAsk(n), children: planBlocks(n) };
    default: return null;
  }
}

const LAYOUT_TAGS = new Set(["Grid", "Collapse"]);
const hasOpenAsk = (n: Node): boolean => (n.tag === "Ask" && !n.attrs.answer) || n.children.some(hasOpenAsk);

/**
 * The container's blocks in order, with runs of Metrics merged into one row. With `only` (the popover and
 * pill show a few kinds) layout containers are transparent: what they hold is hoisted, so a Steps or Ask inside a
 * Grid is still shown there.
 */
export function planBlocks(root: Node, only?: ReadonlySet<string>): BlockPlan[] {
  const out: BlockPlan[] = [];
  const add = (c: Node) => {
    if (only && !only.has(c.tag)) {
      if (LAYOUT_TAGS.has(c.tag)) c.children.forEach(add);
      return;
    }
    const p = planBlock(c);
    if (!p) return;
    const last = out[out.length - 1];
    if (p.kind === "metrics" && last?.kind === "metrics") last.items.push(...p.items);
    else out.push(p);
  };
  root.children.forEach(add);
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
  /** B's compact form, for the Canvases list. */
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
