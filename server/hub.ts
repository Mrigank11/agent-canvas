// The hub owns every agent's canvas and keeps three things in step: what the agent wrote, what Paseo says is
// true about the agent (run state, tool calls, current tool), and the plugin row drawn in the agent's pane.
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { autoCanvas, type AutoItem } from "../shared/auto.ts";
import { BG_MONITOR_STARTED, BG_SHELL_STARTED, classifyActivity, oneLine, parseExitCode, type ActivityCall, type RecentCall } from "../shared/ui-spec.ts";
import { findNode, parseCanvas, patchCanvas, serialize, walk, type Node, type PatchOp } from "../shared/canvas.ts";
import { type BgJob, type CanvasView } from "../shared/contract.ts";
import type { RunState } from "../shared/honesty.ts";
import { statusPlan } from "../shared/plan.ts";
import { Assets } from "./render/assets.ts";
import { LABEL_KEY, RELAY_LABEL, TASK_LABEL, firstOverride, parseOverride, resolveCanvas, type CanvasPolicy, type Override, type Resolved } from "../shared/config.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type Handle = ReturnType<PaseoApi["agents"]["ref"]>;
type Page = Awaited<ReturnType<Handle["timeline"]["refetch"]>>;
type Item = Page["entries"][number]["item"];

/** What the agent wrote and when. */
type Authored = { source: Node; updatedAt: number; callsAtUpdate: number };
/** What Paseo says. */
type Live = { activity: ActivityCall | null; recent: RecentCall[]; seenRunning: Map<string, number>; seenDone: Map<string, number>; /** background jobs by the launching call's id */ bg: Map<string, BgJob>; /** call ids already read as a possible job start, and notifications already counted */ bgChecked: Set<string>; bgNotes: Set<string>; loaded: boolean; title: string | null; workspaceId: string | null; runState: RunState; callIds: Set<string>; items: AutoItem[]; currentTool: string | null; lastActivityAt: number; seq: number };

export type HubOptions = { log: (m: string) => void; stateFile: string | null; publicBase: string; localBase: string; agentLink?: (agentId: string) => string | null;
  /** The current host-wide settings. */
  policy?: () => CanvasPolicy;
  /** The message that teaches an agent without the tools to use the HTTP endpoint. */
  recipe?: (agentId: string) => string; now?: () => number };

/** What `GET /api/fm/summary` returns per agent. */
export type FmSummary = {
  agentId: string; rev: number; archived: boolean; title: string;
  verdict: { label: string; flags: { signal: string; text: string }[]; needsYou: boolean };
  bluf: string; steps: { done: number; total: number; current: string | null };
  openAsks: { id: string; question: string; options: { value: string; label: string }[]; blocking: boolean; pending?: string }[];
  updatedAt: number | null; runState: RunState; activity: CanvasView["activity"]; url: string; agentUrl: string | null; auto: boolean;
};

const isRunState = (s: string): s is RunState => ["initializing", "idle", "running", "error", "closed"].includes(s);

function toolLabel(c: Extract<Item, { type: "tool_call" }>): { label: string; file?: string } {
  const d = c.detail;
  // a label is one short line: a shell command can be a 40-line heredoc
  switch (d.type) {
    case "shell": return { label: oneLine(`Shell: ${d.command}`) };
    case "read": return { label: oneLine(`Read ${d.filePath}`), file: undefined };
    case "edit": return { label: oneLine(`Edit ${d.filePath}`), file: d.filePath };
    case "write": return { label: oneLine(`Write ${d.filePath}`), file: d.filePath };
    case "search": return { label: oneLine(`Search ${d.query}`) };
    case "fetch": return { label: oneLine(`Fetch ${d.url}`) };
    default: return { label: oneLine(c.name.replace(/^mcp__/, "").replace(/__/g, ":")) };
  }
}

const MAX_COMMAND = 4000;
type ToolCall = Extract<Item, { type: "tool_call" }>;
const isTaskNotification = (c: ToolCall) => /^task_?notification$/i.test(c.name.replace(/\s+/g, "_"));
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** The text a finished call returned, whatever shape its detail has. */
function resultText(c: ToolCall): string {
  const d = c.detail;
  if (d.type === "shell") return d.output ?? "";
  if (d.type === "plain_text") return d.text ?? d.label ?? "";
  if (d.type === "unknown") return typeof d.output === "string" ? d.output : JSON.stringify(d.output ?? "");
  return "";
}

/** Read a launching call as the start of a background job (Claude Code's wording), or null. */
export function parseJobStart(c: ToolCall): Pick<BgJob, "id" | "kind" | "command" | "description" | "expires"> | null {
  if (c.status === "running" || isTaskNotification(c)) return null;
  const text = resultText(c);
  const input = c.detail.type === "unknown" && c.detail.input && typeof c.detail.input === "object" && !Array.isArray(c.detail.input) ? (c.detail.input as Record<string, unknown>) : {};
  const mon = BG_MONITOR_STARTED.exec(text);
  if (mon) return { id: mon[1], kind: "monitor", command: (str(input.command) ?? "").slice(0, MAX_COMMAND), description: str(input.description), expires: mon[2]?.trim() || undefined };
  const sh = BG_SHELL_STARTED.exec(text);
  if (sh) return { id: sh[1], kind: "shell", command: (c.detail.type === "shell" ? c.detail.command : str(input.command) ?? "").slice(0, MAX_COMMAND), description: str(input.description) };
  return null;
}

/** What a task notification says, from the summary text and the synthetic item's metadata. */
export function parseNotification(c: ToolCall): { taskId?: string; toolUseId?: string; status?: string; summary: string; event?: string } {
  const md = (c.metadata ?? {}) as Record<string, unknown>;
  const d = c.detail;
  const summary = d.type === "plain_text" ? d.label ?? "" : "";
  const raw = d.type === "plain_text" ? d.text ?? "" : "";
  return { taskId: str(md.taskId), toolUseId: str(md.toolUseId), status: str(md.status)?.toLowerCase(), summary, event: /<event>\s*([\s\S]*?)\s*<\/event>/i.exec(raw)?.[1] };
}

/** A tool call as the Now row wants it: kind and the raw fields, not a flattened label. */
export function rawCall(c: Extract<Item, { type: "tool_call" }>): Omit<ActivityCall, "startedAt"> & { exitCode?: number | null } {
  const d = c.detail;
  switch (d.type) {
    case "shell": return { kind: "shell", name: c.name, command: d.command.slice(0, MAX_COMMAND), exitCode: d.exitCode };
    case "read": return { kind: "read", name: c.name, path: d.filePath };
    case "edit": return { kind: "edit", name: c.name, path: d.filePath };
    case "write": return { kind: "write", name: c.name, path: d.filePath };
    case "search": return { kind: "search", name: c.name, query: d.query };
    case "fetch": return { kind: "fetch", name: c.name, url: d.url };
    default: return { kind: "other", name: c.name };
  }
}

export function toAutoItems(items: readonly Item[]): AutoItem[] {
  const out: AutoItem[] = [];
  for (const it of items) {
    switch (it.type) {
      case "user_message": out.push({ kind: "user", text: it.text }); break;
      case "assistant_message": out.push({ kind: "assistant", text: it.text }); break;
      case "error": out.push({ kind: "error", text: it.message }); break;
      case "todo": out.push({ kind: "todo", items: it.items.map((t) => ({ text: t.text, status: t.status ?? (t.completed ? "completed" : "pending") })) }); break;
      case "tool_call": {
        // the plugin's own canvas tool calls are bookkeeping, not work
        if (/canvas_(set|patch|get)/.test(c(it))) break;
        out.push({ kind: "tool", status: it.status, ...toolLabel(it) });
        break;
      }
      default: break;
    }
  }
  return out;
}
const c = (it: Extract<Item, { type: "tool_call" }>) => it.name;

export class Hub {
  private api: PaseoApi | null = null;
  private authored = new Map<string, Authored>();
  private live = new Map<string, Live>();
  private tokens = new Map<string, string | null>();
  private pending: { token: string; cwd: string; at: number }[] = [];
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = new Set<string>();
  /** Failed refreshes back off per agent, and are logged once until one succeeds. */
  private fails = new Map<string, { n: number; retryAt: number }>();
  private now: () => number;
  /** Rich blocks: validation, hashes, the render cache. Lives next to the state file. */
  readonly assets: Assets;
  /** Each agent's workspace folder: the only place an <Image> may come from. */
  private cwds = new Map<string, string>();

  private o: HubOptions;
  get publicBase() { return this.o.publicBase; }
  /** Per-agent overrides by where they came from. The latest explicit one wins: runtime (the pill), then env at creation, then label. */
  private ovRuntime = new Map<string, Override>();
  private ovEnv = new Map<string, Override>();
  private ovLabel = new Map<string, Override>();
  private recipeSent = new Set<string>();
  /** Relay mode (label canvas.relay=<agentId>): a pick is sent to that agent instead of the crew. `task` is the fm.task label, for the message. */
  private relay = new Map<string, { to: string; task?: string }>();
  /** Bumped on every change to an agent's view, so a consumer can skip the ones it already has. */
  private revs = new Map<string, number>();
  /** Agents whose first turn has started (the recipe must not overtake the initial prompt), and those still waiting for one. */
  private started = new Set<string>();
  private recipeWanted = new Set<string>();
  /** Canvases read back from disk at start-up: dropped if their agent turns out to be gone. */
  private restored = new Set<string>();
  /** Agents archived this session: late hooks (closed, turn_ended) must not bring them back. */
  private archived = new Set<string>();
  constructor(o: HubOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.assets = new Assets(o.stateFile ? join(dirname(o.stateFile), "cache") : null, this.now);
    this.restore();
    this.pruneArchive();
  }

  // ---------- plumbing ----------

  /** Remember the SDK handle a hook or RPC callback was given. The poller starts with the first one. */
  capture(ctx: { paseo?: PaseoApi | null } | null | undefined, source: string) {
    const api = ctx?.paseo;
    if (!api || api === this.api) return;
    const first = !this.api;
    this.api = api;
    if (first) {
      this.o.log(`SDK handle captured (from ${source})`);
      void this.discover();
      this.poller = setInterval(() => void this.tick(), 2500);
    }
  }

  stop() {
    if (this.poller) clearInterval(this.poller);
    this.persist();
  }

  private persist() {
    if (!this.o.stateFile) return;
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      const tmp = `${this.o.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ authored: [...this.authored], tokens: [...this.tokens], ovRuntime: [...this.ovRuntime], ovEnv: [...this.ovEnv], ovLabel: [...this.ovLabel], recipeSent: [...this.recipeSent], relay: [...this.relay] }));
      renameSync(tmp, this.o.stateFile);
    } catch (e) { this.o.log(`persist failed: ${(e as Error).message}`); }
  }
  private restore() {
    if (!this.o.stateFile) return;
    try {
      const s = JSON.parse(readFileSync(this.o.stateFile, "utf8"));
      this.authored = new Map(s.authored);
      this.restored = new Set(this.authored.keys());
      this.tokens = new Map(s.tokens);
      this.ovRuntime = new Map(s.ovRuntime ?? []);
      this.ovEnv = new Map(s.ovEnv ?? []);
      this.ovLabel = new Map(s.ovLabel ?? []);
      this.recipeSent = new Set(s.recipeSent ?? []);
      this.relay = new Map(s.relay ?? []);
    } catch {}
  }

  // ---------- binding a creation token to the agent it became ----------

  mintToken(cwd: string): string {
    const token = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
    this.tokens.set(token, null);
    this.pending.push({ token, cwd, at: this.now() });
    return token;
  }
  bind(token: string, agentId: string) {
    if (this.tokens.get(token) === agentId) return;
    this.tokens.set(token, agentId);
    const was = this.pending.find((p) => p.token === token);
    if (was?.cwd) this.cwds.set(agentId, was.cwd);
    this.pending = this.pending.filter((p) => p.token !== token);
    this.o.log(`canvas ${token.slice(0, 6)}… bound to agent ${agentId}`);
    this.persist();
  }
  /** Fallback when the session-open hook does not carry the token: match a fresh agent by working directory. */
  bindByCwd(agentId: string, cwd: string) {
    if ([...this.tokens.values()].includes(agentId)) return;
    if (cwd) this.cwds.set(agentId, cwd);
    const hit = [...this.pending].reverse().find((p) => p.cwd === cwd && this.now() - p.at < 120_000);
    if (hit) this.bind(hit.token, agentId);
  }
  /** The agent a write key stands for: a creation token's agent, or an agent id that Paseo knows (null for anything else). */
  async resolve(key: string): Promise<string | null> {
    if (this.tokens.has(key)) return this.tokens.get(key) ?? null;
    return (await this.exists(key)) ? key : null;
  }
  /** Is this a real, live agent? Known ones are trusted; others are asked of Paseo (and then become known). */
  async exists(agentId: string): Promise<boolean> {
    if (this.archived.has(agentId)) return false;
    if (this.live.has(agentId) || this.authored.has(agentId)) return true;
    if (!this.api) return false;
    try {
      const h = this.api.agents.ref(agentId);
      const a = h.current?.() ?? (await h.refresh?.())?.agent ?? null;
      if (!a || a.archivedAt) return false;
      this.noteAgent(agentId, a.title, a.workspaceId, a.cwd);
      void this.learnLabels(agentId);
      return true;
    } catch { return false; }
  }
  tokenFor(agentId: string): string | null {
    for (const [t, a] of this.tokens) if (a === agentId) return t;
    return null;
  }

  // ---------- who gets a canvas: override > global switch > default ----------

  policy(): CanvasPolicy { return this.o.policy?.() ?? { defaultOn: false, autoCanvas: true }; }
  override(agentId: string): Override | null { return firstOverride(this.ovRuntime.get(agentId), this.ovEnv.get(agentId), this.ovLabel.get(agentId)); }
  resolved(agentId: string): Resolved { return resolveCanvas(this.override(agentId), this.policy()); }

  /** Record where an override came from. `null` clears a runtime override only. */
  setOverride(agentId: string, value: Override | null, source: "runtime" | "env" | "label") {
    const map = source === "runtime" ? this.ovRuntime : source === "env" ? this.ovEnv : this.ovLabel;
    if (value) map.set(agentId, value); else map.delete(agentId);
    this.persist();
    this.changed(agentId);
    // an env override arrives while the agent is still being created: it does not exist to read yet (agent.created reads it)
    if (source !== "env" && this.resolved(agentId).show) void this.refresh(agentId);
    void this.ensureTools(agentId, source === "runtime");
  }

  /** The agent began a turn: a recipe that was waiting for the initial prompt can go now. */
  turnStarted(agentId: string) {
    this.started.add(agentId);
    if (this.recipeWanted.delete(agentId)) void this.ensureTools(agentId, true);
  }

  /** An agent that should have the canvas but was not given the MCP tools gets the plain-HTTP recipe, once. */
  async ensureTools(agentId: string, now = true) {
    if (!this.api || !this.o.recipe || this.recipeSent.has(agentId)) return;
    if (this.override(agentId) !== "on" || this.tokenFor(agentId) || this.authored.has(agentId)) return;
    // Sent straight away for a runtime choice; for a label, after the first turn has started so the initial prompt goes first.
    if (!now && !this.started.has(agentId)) { this.recipeWanted.add(agentId); return; }
    this.recipeSent.add(agentId);
    this.persist();
    try { await this.send(agentId, this.o.recipe(agentId)); } catch (e) { this.recipeSent.delete(agentId); this.o.log(`recipe to ${agentId} failed: ${(e as Error).message}`); }
  }

  /** Read the agent's labels from Paseo (the only place a label override is visible: not in the create hook). */
  async learnLabels(agentId: string) {
    if (!this.api) return;
    try {
      const h = this.api.agents.ref(agentId);
      const a = h.current() ?? (await h.refresh())?.agent ?? null;
      const o = parseOverride(a?.labels?.[LABEL_KEY]);
      if (o !== (this.ovLabel.get(agentId) ?? null)) this.setOverride(agentId, o, "label");
      this.learnRelay(agentId, a?.labels);
    } catch { /* an agent whose record cannot be read (a provider that is too old) is simply left alone */ }
  }

  private learnRelay(agentId: string, labels: Record<string, string> | undefined | null) {
    const to = labels?.[RELAY_LABEL]?.trim();
    const was = this.relay.get(agentId);
    if (!to) { if (was) { this.relay.delete(agentId); this.persist(); } return; }
    const task = labels?.[TASK_LABEL]?.trim() || undefined;
    if (was?.to === to && was.task === task) return;
    this.relay.set(agentId, { to, task });
    this.persist();
    this.changed(agentId);
  }
  /** Who a pick on this agent's canvas goes to instead of the agent (null: the agent itself). */
  relayOf(agentId: string): string | null { return this.relay.get(agentId)?.to ?? null; }

  stateOf(agentId: string): { override: Override | null; tools: boolean; show: boolean } {
    const r = this.resolved(agentId);
    return { override: this.override(agentId), tools: r.tools, show: r.show };
  }

  /** Settings changed: every row and view is re-derived. */
  policyChanged() { for (const id of this.agents()) { this.changed(id); if (this.resolved(id).show) void this.refresh(id); } }

  // ---------- what the agent writes ----------

  /**
   * The slow half of canvas_set/canvas_patch (laying out diagrams and charts), run before the synchronous `set`/`patch`.
   * Anything that would fail there anyway (off, unparseable, no canvas) is left for them to report.
   */
  async prepare(agentId: string, change: { source: string } | { ops: PatchOp[] }): Promise<{ ok: true; notes: string[] } | { ok: false; errors: string[] }> {
    let root: Node | null = null;
    if ("source" in change) { const r = parseCanvas(change.source); if (r.ok) root = r.root; }
    else { const cur = this.authored.get(agentId); const r = cur && change.ops.length ? patchCanvas(cur.source, change.ops) : null; if (r?.ok) root = r.root; }
    return root ? this.assets.prepare(root) : { ok: true, notes: [] };
  }

  /** canvas_set: replace the canvas. */
  set(agentId: string, source: string): { ok: true; ids: string[]; notes: string[] } | { ok: false; errors: string[] } {
    if (!this.resolved(agentId).tools) return { ok: false, errors: ["the canvas is off for this agent (if it was only just created with canvas=on, wait a few seconds and retry)"] };
    const r = parseCanvas(source);
    if (!r.ok) return { ok: false, errors: r.errors.map((e) => `${e.line ? `line ${e.line}: ` : ""}${e.message}`) };
    const rich = this.assets.check(r.root, this.cwdOf(agentId));
    if (!rich.ok) return { ok: false, errors: rich.errors };
    this.authored.set(agentId, { source: r.root, updatedAt: this.now(), callsAtUpdate: this.callCount(agentId) });
    const ids: string[] = [];
    walk(r.root, (n) => ids.push(n.id));
    this.changed(agentId);
    return { ok: true, ids, notes: rich.notes };
  }
  /** canvas_patch: atomic. */
  patch(agentId: string, ops: PatchOp[]): { ok: true; notes: string[] } | { ok: false; errors: string[] } {
    if (!this.resolved(agentId).tools) return { ok: false, errors: ["the canvas is off for this agent (if it was only just created with canvas=on, wait a few seconds and retry)"] };
    const cur = this.authored.get(agentId);
    if (!cur) return { ok: false, errors: ["there is no canvas yet: call canvas_set first"] };
    const r = patchCanvas(cur.source, ops);
    if (!r.ok) return { ok: false, errors: r.errors.map((e) => e.message) };
    const rich = this.assets.check(r.root, this.cwdOf(agentId));
    if (!rich.ok) return { ok: false, errors: rich.errors };
    this.authored.set(agentId, { source: r.root, updatedAt: this.now(), callsAtUpdate: this.callCount(agentId) });
    this.changed(agentId);
    return { ok: true, notes: rich.notes };
  }
  /** The agent's workspace folder, from the creation hook or Paseo's record; null until one is known. */
  cwdOf(agentId: string): string | null {
    const known = this.cwds.get(agentId);
    if (known) return known;
    let cwd: string | null | undefined;
    try { cwd = this.api?.agents.ref(agentId).current?.()?.cwd; } catch { /* no record yet */ }
    if (cwd) this.cwds.set(agentId, cwd);
    return cwd ?? null;
  }
  source(agentId: string): string | null {
    const a = this.authored.get(agentId);
    return a ? serialize(a.source) : null;
  }

  /** The open Ask `askId` with its option for `value`, or the reason there is none. */
  private openAsk(agentId: string, askId: string, value: string | null): { cur: Authored; ask: Node; option?: Node } | { error: string } {
    const cur = this.authored.get(agentId);
    const ask = cur && findNode(cur.source, askId);
    if (!cur || !ask || ask.tag !== "Ask") return { error: "no such question on this canvas" };
    if (ask.attrs.answer) return { error: "already answered" };
    const option = value === null ? undefined : ask.children.find((o) => o.attrs.value === value);
    if (value !== null && !option) return { error: `"${value}" is not one of the options` };
    return { cur, ask, option };
  }

  /**
   * Record the human's pick on the Ask (without counting it as the agent's update). Normally it is delivered to the agent.
   * With a relay (label canvas.relay) it is only recorded as pending and sent to the relay agent, which delivers it later;
   * if the relay agent is gone, the pick goes straight to the agent after all.
   */
  async answer(agentId: string, askId: string, value: string): Promise<{ ok: boolean; error?: string; pending?: boolean }> {
    const r = this.openAsk(agentId, askId, value);
    if ("error" in r) return { ok: false, error: r.error };
    const { ask, option } = r;
    const relay = this.relay.get(agentId);
    if (relay && (await this.exists(relay.to))) {
      if (ask.attrs.pending) return { ok: false, error: `already pending: "${ask.attrs.pending}" was sent to the first mate` };
      ask.attrs.pending = value;
      this.changed(agentId);
      this.persist();
      try {
        const q = oneLine(String(ask.attrs.question), 200);
        await this.send(relay.to, `## Canvas answer · ${relay.task ?? agentId} · ask ${askId}: ${value} (${option!.text || value})\nagent ${agentId} · question "${q}"`);
      } catch (e) {
        delete ask.attrs.pending;
        this.changed(agentId);
        return { ok: false, error: `could not reach the relay agent: ${(e as Error).message}` };
      }
      return { ok: true, pending: true };
    }
    ask.attrs.answer = value;
    delete ask.attrs.pending;
    this.changed(agentId);
    this.persist();
    try {
      await this.send(agentId, `Canvas answer to "${ask.attrs.question}": ${value} (${option!.text || value}).`);
    } catch (e) {
      delete ask.attrs.answer;
      this.changed(agentId);
      return { ok: false, error: `could not reach the agent: ${(e as Error).message}` };
    }
    return { ok: true };
  }

  /**
   * The relay agent's side: put a pick on the Ask for good and tell the agent. With `decline` the Ask is closed with the
   * note instead and the agent is told why. A pending pick is cleared either way; `value` need not match it (the relay
   * agent may deliver a different one).
   */
  async deliver(agentId: string, askId: string, d: { value: string } | { decline: string }): Promise<{ ok: boolean; error?: string }> {
    const r = this.openAsk(agentId, askId, "value" in d ? d.value : null);
    if ("error" in r) return { ok: false, error: r.error };
    const { ask, option } = r;
    const was = ask.attrs.pending;
    delete ask.attrs.pending;
    if ("value" in d) ask.attrs.answer = d.value; else { ask.attrs.answer = "declined"; ask.attrs.note = d.decline.slice(0, 300); }
    this.changed(agentId);
    this.persist();
    const text = "value" in d
      ? `Canvas answer to "${ask.attrs.question}": ${d.value} (${option!.text || d.value}).`
      : `Canvas question "${ask.attrs.question}" was closed without an answer: ${d.decline}`;
    try { await this.send(agentId, text); } catch (e) {
      delete ask.attrs.answer; delete ask.attrs.note;
      if (was) ask.attrs.pending = was;
      this.changed(agentId);
      return { ok: false, error: `could not reach the agent: ${(e as Error).message}` };
    }
    return { ok: true };
  }

  async send(agentId: string, text: string) {
    if (!this.api) throw new Error("no SDK handle yet");
    await this.api.agents.ref(agentId).send(text, { activeTurnBehavior: "steer" });
  }

  // ---------- what Paseo says ----------

  private callCount(agentId: string) { return this.live.get(agentId)?.callIds.size ?? 0; }
  private liveFor(agentId: string): Live {
    let l = this.live.get(agentId);
    if (!l) this.live.set(agentId, (l = { activity: null, recent: [], seenRunning: new Map(), seenDone: new Map(), bg: new Map(), bgChecked: new Set(), bgNotes: new Set(), loaded: false, title: null, workspaceId: null, runState: "idle", callIds: new Set(), items: [], currentTool: null, lastActivityAt: this.now(), seq: 0 }));
    return l;
  }

  /** Agents already running when the plugin started. */
  private async discover() {
    try {
      const r = await this.api!.agents.list({ page: { limit: 100 } });
      const alive = new Set<string>();
      for (const { agent } of r.entries) if (!agent.archivedAt) { alive.add(agent.id); const l0 = this.liveFor(agent.id); l0.title = agent.title; l0.workspaceId = agent.workspaceId ?? null; if (agent.cwd) this.cwds.set(agent.id, agent.cwd); const lo = parseOverride(agent.labels?.[LABEL_KEY]); if (lo) this.ovLabel.set(agent.id, lo); this.learnRelay(agent.id, agent.labels); if (this.resolved(agent.id).show) await this.refresh(agent.id); }
      // a canvas restored from disk for an agent that is archived or gone does not belong on the board
      for (const id of this.restored) if (!alive.has(id)) this.authored.delete(id);
      this.restored.clear();
    } catch (e) { this.o.log(`discover failed: ${(e as Error).message}`); }
  }

  noteAgent(agentId: string, title?: string | null, workspaceId?: string | null, cwd?: string | null) {
    if (this.archived.has(agentId)) return;
    if (cwd) this.cwds.set(agentId, cwd);
    const l = this.liveFor(agentId);
    if (title !== undefined) l.title = title;
    if (workspaceId) l.workspaceId = workspaceId;
    if (this.resolved(agentId).show) void this.refresh(agentId);
  }
  /** Archived agents leave the board; their last canvas is kept for 30 days where a consumer can still read it. */
  forget(agentId: string) {
    this.snapshot(agentId);
    this.archived.add(agentId);
    this.live.delete(agentId);
    if (this.authored.delete(agentId)) this.persist();
  }

  /** Pull the timeline tail and the run state for one agent. */
  async refresh(agentId: string) {
    if (!this.api || this.busy.has(agentId)) return;
    // Nothing is read for an agent that has no canvas, no override and no auto canvas: on a daemon where the
    // canvas is off for most agents this keeps the plugin silent.
    if (!this.resolved(agentId).show) return;
    const f = this.fails.get(agentId);
    if (f && this.now() < f.retryAt) return;
    this.busy.add(agentId);
    try {
      const page = await this.api.agents.ref(agentId).timeline.refetch({ direction: "tail", limit: 200, projection: "projected" });
      const l = this.liveFor(agentId);
      const items = [...page.entries].sort((a, b) => a.seqStart - b.seqStart).map((e) => e.item);
      if (page.agent) {
        l.title = page.agent.title ?? l.title;
        if (isRunState(page.agent.status)) l.runState = page.agent.status;
        l.lastActivityAt = Date.parse(page.agent.updatedAt ?? "") || l.lastActivityAt;
      }
      for (const it of items) if (it.type === "tool_call" && !/canvas_(set|patch|get)/.test(it.name)) l.callIds.add(it.callId);
      l.seq = page.window?.maxSeq ?? l.seq;
      this.trackCalls(l, items);
      l.items = toAutoItems(items);
      const running = [...l.items].reverse().find((i) => i.kind === "tool" && i.status === "running");
      l.currentTool = running?.kind === "tool" ? running.label : null;
      this.fails.delete(agentId);
      this.changed(agentId);
    } catch (e) {
      const n = (this.fails.get(agentId)?.n ?? 0) + 1;
      // 3 s (an agent still being created), then 30 s, 1 min, 2 min ... capped at 15 min; only the first failure is logged
      this.fails.set(agentId, { n, retryAt: this.now() + (n === 1 ? 3_000 : Math.min(30_000 * 2 ** (n - 2), 15 * 60_000)) });
      if (n === 1) this.o.log(`refresh ${agentId} failed (retrying with backoff, not logged again): ${(e as Error).message}`);
    } finally { this.busy.delete(agentId); }
  }

  /**
   * The Now row's data. Timeline items carry no timestamps, so the hub stamps the first time it sees a call running
   * (startedAt, good to about the poll interval) and the first time it sees one finished (endedAt). Calls already finished
   * when an agent is first read are stamped with the agent's last activity, not "now".
   */
  private trackCalls(l: Live, items: readonly Item[]) {
    // Claude's own task notifications are not actions the agent took
    const calls = items.filter((i): i is Extract<Item, { type: "tool_call" }> => i.type === "tool_call" && !/^task_?notification$/i.test(i.name.replace(/\s+/g, "_")));
    const first = !l.loaded;
    l.loaded = true;
    const t = this.now();
    this.trackBackground(l, items, first, t);
    for (const c of calls) {
      if (c.status === "running") { if (!l.seenRunning.has(c.callId)) l.seenRunning.set(c.callId, t); }
      else if (!l.seenDone.has(c.callId)) l.seenDone.set(c.callId, first ? l.lastActivityAt : t);
    }
    const running = [...calls].reverse().find((c) => c.status === "running");
    l.activity = running ? { ...rawCall(running), startedAt: l.seenRunning.get(running.callId) ?? t } : null;
    l.recent = [...calls]
      .filter((c) => c.status !== "running")
      .reverse()
      .map((c) => ({ c, raw: rawCall(c) }))
      .filter(({ raw }) => !classifyActivity(raw).bookkeeping)
      .slice(0, 3)
      .map(({ c, raw }) => ({ kind: raw.kind, label: classifyActivity(raw).past, ok: c.status === "completed" && (raw.exitCode == null || raw.exitCode === 0), exitCode: raw.exitCode ?? null, endedAt: l.seenDone.get(c.callId) ?? t }));
    // bounded: forget calls that fell out of the 200-item window
    if (l.seenRunning.size > 400) for (const k of [...l.seenRunning.keys()].slice(0, 200)) l.seenRunning.delete(k);
    if (l.seenDone.size > 400) for (const k of [...l.seenDone.keys()].slice(0, 200)) l.seenDone.delete(k);
  }

  /**
   * Background jobs, for Claude Code agents. A job opens on the launching call's result text, closes on the task
   * notification whose toolUseId is that call's id, and a Monitor event is a notification with no status. Timeline items carry no
   * time, so start and end are first-seen stamps (a job already running when the agent is first read is marked approximate).
   * A notification whose start was not recognised still shows, as a finished job, so a wording change never hides one.
   */
  private trackBackground(l: Live, items: readonly Item[], first: boolean, t: number) {
    const ended = first ? l.lastActivityAt : t;
    const calls = items.filter((i): i is ToolCall => i.type === "tool_call");
    for (const c of calls) {
      if (isTaskNotification(c)) continue;
      if (l.bgChecked.has(c.callId) || c.status === "running") continue;
      l.bgChecked.add(c.callId);
      const start = parseJobStart(c);
      if (start) l.bg.set(c.callId, { ...start, state: "running", startedAt: t, ...(first ? { approx: true } : {}) });
    }
    for (const c of calls) {
      if (!isTaskNotification(c) || l.bgNotes.has(c.callId)) continue;
      l.bgNotes.add(c.callId);
      const n = parseNotification(c);
      const key = (n.toolUseId && l.bg.has(n.toolUseId) ? n.toolUseId : null) ?? [...l.bg].find(([, j]) => n.taskId && j.id === n.taskId)?.[0] ?? null;
      let job = key ? l.bg.get(key) : undefined;
      if (!job) {
        // a finish (or event) without a recognised start: keep it as a job whose start we did not see
        const isMon = /^Monitor event/i.test(n.summary);
        job = { id: n.taskId ?? c.callId, kind: isMon ? "monitor" : "shell", command: isMon ? "" : /Background command "([\s\S]*?)" (?:completed|failed|was stopped|has been)/.exec(n.summary)?.[1]?.slice(0, MAX_COMMAND) ?? "", description: isMon ? /Monitor event: "([\s\S]*?)"/.exec(n.summary)?.[1] : undefined, state: "running", startedAt: t, approx: true, unrecognised: true };
        l.bg.set(n.toolUseId ?? `note:${c.callId}`, job);
      }
      if (job.state !== "running") continue;
      const status = n.status;
      const expiry = job.kind === "monitor" && !status && !/^Monitor event/i.test(n.summary) && /\b(expired|ended|timed out|stopped)\b/i.test(n.summary);
      if (job.kind === "monitor" && !status && !expiry) {
        job.events = (job.events ?? 0) + 1;
        job.lastEvent = oneLine(n.event ?? n.summary, 160);
        continue;
      }
      const code = parseExitCode(n.summary);
      const state: BgJob["state"] = status === "failed" || status === "error" ? "failed" : status && /^(killed|stopped|cancel+ed)$/.test(status) ? "killed" : code != null && code !== 0 ? "failed" : "done";
      job.state = state;
      job.endedAt = ended;
      if (code != null) job.exitCode = code;
    }
    if (l.runState === "error" || l.runState === "closed") for (const j of l.bg.values()) if (j.state === "running") { j.state = "lost"; j.endedAt = t; }
    // bounded
    if (l.bg.size > 60) for (const [k, j] of [...l.bg]) if (j.state !== "running" && l.bg.size > 40) l.bg.delete(k);
    if (l.bgChecked.size > 600) for (const k of [...l.bgChecked].slice(0, 300)) l.bgChecked.delete(k);
    if (l.bgNotes.size > 600) for (const k of [...l.bgNotes].slice(0, 300)) l.bgNotes.delete(k);
  }

  private async tick() {
    for (const [id, l] of this.live) {
      // Running agents every tick; a recently-active or errored one a few more times so the final state lands.
      if (!this.resolved(id).show) continue;
      if (l.runState === "running" || l.runState === "initializing" || this.now() - l.lastActivityAt < 15_000 || [...l.bg.values()].some((j) => j.state === "running")) await this.refresh(id); // an idle agent waiting on a job is the one that must be watched
    }
  }

  // ---------- the final canvas of an archived agent ----------

  private archiveDir(): string | null { return this.o.stateFile ? join(dirname(this.o.stateFile), "archive") : null; }
  private snapshot(agentId: string) {
    const dir = this.archiveDir();
    const v = dir && /^[\w-]+$/.test(agentId) ? this.view(agentId) : null;
    if (!dir || !v) return;
    try {
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `${agentId}.json.tmp`);
      writeFileSync(tmp, JSON.stringify({ archivedAt: this.now(), rev: this.revs.get(agentId) ?? 0, view: { ...v, runState: "closed", activity: null, currentTool: null } }));
      renameSync(tmp, join(dir, `${agentId}.json`));
    } catch (e) { this.o.log(`snapshot of ${agentId} failed: ${(e as Error).message}`); }
    this.pruneArchive();
  }
  /** Snapshots older than 30 days are deleted. */
  pruneArchive(maxAgeMs = 30 * 24 * 3600_000) {
    const dir = this.archiveDir();
    if (!dir) return;
    try {
      for (const f of readdirSync(dir)) {
        const p = join(dir, f);
        if (this.now() - statSync(p).mtimeMs > maxAgeMs) unlinkSync(p);
      }
    } catch { /* no archive yet */ }
  }
  /** The last canvas of an archived agent, or null. */
  archivedView(agentId: string): { view: CanvasView; rev: number; archivedAt: number } | null {
    const dir = this.archiveDir();
    if (!dir || !/^[\w-]+$/.test(agentId)) return null;
    try { const s = JSON.parse(readFileSync(join(dir, `${agentId}.json`), "utf8")); return { view: s.view, rev: s.rev ?? 0, archivedAt: s.archivedAt }; } catch { return null; }
  }

  // ---------- what a consumer (the first mate's deck) pulls ----------

  /** One agent as a card header: verdict, BLUF, steps, open questions. A live agent, or else its archived snapshot. */
  summary(agentId: string, now: number = this.now()): FmSummary | null {
    const live = this.view(agentId);
    const arch = live ? null : this.archivedView(agentId);
    const v = live ?? arch?.view ?? null;
    if (!v) return null;
    const sp = statusPlan(v, now);
    let bluf = "", done = 0, total = 0, current: string | null = null;
    const openAsks: FmSummary["openAsks"] = [];
    walk(v.tree, (n) => {
      if (n.tag === "Bluf" && !bluf) bluf = n.text;
      if (n.tag === "Step") { total++; if (n.attrs.state === "done") done++; if (n.attrs.state === "active" && current === null) current = n.text; }
      if (n.tag === "Ask" && !n.attrs.answer) openAsks.push({ id: n.id, question: String(n.attrs.question), options: n.children.map((o) => ({ value: String(o.attrs.value), label: o.text || String(o.attrs.value) })), blocking: n.attrs.blocking === true, ...(n.attrs.pending ? { pending: String(n.attrs.pending) } : {}) });
    });
    return {
      agentId, rev: live ? this.revs.get(agentId) ?? 0 : arch!.rev, archived: !live, title: v.title,
      verdict: { label: sp.label, flags: sp.flags.map((f) => ({ signal: f.signal, text: f.text })), needsYou: sp.label === "Needs you" },
      bluf, steps: { done, total, current }, openAsks, updatedAt: v.updatedAt, runState: v.runState, activity: v.activity, url: v.url, agentUrl: v.agentUrl, auto: v.auto,
    };
  }

  // ---------- the view ----------

  agents(): string[] {
    return [...new Set([...this.live.keys(), ...this.authored.keys()])];
  }

  view(agentId: string): CanvasView | null {
    const live = this.live.get(agentId);
    const a = this.authored.get(agentId);
    if (!live && !a) return null;
    const res = this.resolved(agentId);
    if (!res.show || (!a && !res.auto)) return null;
    const l = live ?? this.liveFor(agentId);
    // the clients get hashes and sizes in place of drawing bodies (the row is capped at 64 KiB)
    const tree = a ? this.assets.wire(a.source, this.cwdOf(agentId)) : autoCanvas(l.title, l.items, l.runState === "running");
    return {
      agentId,
      workspaceId: l.workspaceId,
      title: a?.source.attrs.title ? String(a.source.attrs.title) : l.title ?? agentId.slice(0, 8),
      tree,
      auto: !a,
      updatedAt: a?.updatedAt ?? null,
      callsAtUpdate: a?.callsAtUpdate ?? 0,
      callsNow: l.callIds.size,
      runState: l.runState,
      currentTool: l.currentTool,
      activity: l.activity,
      recent: l.recent,
      background: [...l.bg.values()].map((j) => ({ ...j })),
      lastActivityAt: l.lastActivityAt,
      url: `${this.o.publicBase}/a/${agentId}`,
      agentUrl: this.o.agentLink?.(agentId) ?? null,
    };
  }

  // ---------- change tracking ----------

  /** Something changed: bump the revision the consumer API reports (clients poll the RPCs, nothing is written to the timeline). */
  private changed(agentId: string) {
    this.revs.set(agentId, (this.revs.get(agentId) ?? 0) + 1);
  }
}
