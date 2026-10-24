// The hub owns every agent's canvas and keeps three things in step: what the agent wrote, what Paseo says is
// true about the agent (run state, tool calls, current tool), and the plugin row drawn in the agent's pane.
import { mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import { autoCanvas, type AutoItem } from "../shared/auto.ts";
import { findNode, parseCanvas, patchCanvas, serialize, walk, type Node, type PatchOp } from "../shared/canvas.ts";
import { REANCHOR_AFTER, ROW_ID, ROW_KIND, ROW_VERSION, type CanvasView } from "../shared/contract.ts";
import type { RunState } from "../shared/honesty.ts";

type PaseoApi = PluginHandlerContext["paseo"];
type Handle = ReturnType<PaseoApi["agents"]["ref"]>;
type Page = Awaited<ReturnType<Handle["timeline"]["refetch"]>>;
type Item = Page["entries"][number]["item"];

/** What the agent wrote and when. */
type Authored = { source: Node; updatedAt: number; callsAtUpdate: number };
/** What Paseo says. */
type Live = { title: string | null; runState: RunState; callIds: Set<string>; items: AutoItem[]; currentTool: string | null; lastActivityAt: number; seq: number };

export type HubOptions = { log: (m: string) => void; stateFile: string | null; publicBase: string; localBase: string; now?: () => number };

const isRunState = (s: string): s is RunState => ["initializing", "idle", "running", "error", "closed"].includes(s);

function toolLabel(c: Extract<Item, { type: "tool_call" }>): { label: string; file?: string } {
  const d = c.detail;
  switch (d.type) {
    case "shell": return { label: `Shell: ${d.command}` };
    case "read": return { label: `Read ${d.filePath}`, file: undefined };
    case "edit": return { label: `Edit ${d.filePath}`, file: d.filePath };
    case "write": return { label: `Write ${d.filePath}`, file: d.filePath };
    case "search": return { label: `Search ${d.query}` };
    case "fetch": return { label: `Fetch ${d.url}` };
    default: return { label: c.name.replace(/^mcp__/, "").replace(/__/g, ":") };
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
  private lastRow = new Map<string, string>();
  /** Which row id currently holds the canvas, and the timeline position it was written at. */
  private anchor = new Map<string, { n: number; seq: number }>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private poller: ReturnType<typeof setInterval> | null = null;
  private busy = new Set<string>();
  private now: () => number;

  private o: HubOptions;
  /** Canvases read back from disk at start-up: dropped if their agent turns out to be gone. */
  private restored = new Set<string>();
  /** Agents archived this session: late hooks (closed, turn_ended) must not bring them back. */
  private archived = new Set<string>();
  constructor(o: HubOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.restore();
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
    for (const t of this.timers.values()) clearTimeout(t);
    this.persist();
  }

  private persist() {
    if (!this.o.stateFile) return;
    try {
      mkdirSync(dirname(this.o.stateFile), { recursive: true });
      const tmp = `${this.o.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ authored: [...this.authored], tokens: [...this.tokens] }));
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
    this.pending = this.pending.filter((p) => p.token !== token);
    this.o.log(`canvas ${token.slice(0, 6)}… bound to agent ${agentId}`);
    this.persist();
  }
  /** Fallback when the session-open hook does not carry the token: match a fresh agent by working directory. */
  bindByCwd(agentId: string, cwd: string) {
    if ([...this.tokens.values()].includes(agentId)) return;
    const hit = [...this.pending].reverse().find((p) => p.cwd === cwd && this.now() - p.at < 120_000);
    if (hit) this.bind(hit.token, agentId);
  }
  resolve(key: string): string | null {
    return this.tokens.has(key) ? this.tokens.get(key) ?? null : key;
  }
  tokenFor(agentId: string): string | null {
    for (const [t, a] of this.tokens) if (a === agentId) return t;
    return null;
  }

  // ---------- what the agent writes ----------

  /** canvas_set: replace the canvas. */
  set(agentId: string, source: string): { ok: true; ids: string[] } | { ok: false; errors: string[] } {
    const r = parseCanvas(source);
    if (!r.ok) return { ok: false, errors: r.errors.map((e) => `${e.line ? `line ${e.line}: ` : ""}${e.message}`) };
    this.authored.set(agentId, { source: r.root, updatedAt: this.now(), callsAtUpdate: this.callCount(agentId) });
    const ids: string[] = [];
    walk(r.root, (n) => ids.push(n.id));
    this.changed(agentId);
    return { ok: true, ids };
  }
  /** canvas_patch: atomic. */
  patch(agentId: string, ops: PatchOp[]): { ok: true } | { ok: false; errors: string[] } {
    const cur = this.authored.get(agentId);
    if (!cur) return { ok: false, errors: ["there is no canvas yet: call canvas_set first"] };
    const r = patchCanvas(cur.source, ops);
    if (!r.ok) return { ok: false, errors: r.errors.map((e) => e.message) };
    this.authored.set(agentId, { source: r.root, updatedAt: this.now(), callsAtUpdate: this.callCount(agentId) });
    this.changed(agentId);
    return { ok: true };
  }
  source(agentId: string): string | null {
    const a = this.authored.get(agentId);
    return a ? serialize(a.source) : null;
  }

  /** Record the human's answer on the Ask (without counting it as the agent's update) and deliver it to the agent. */
  async answer(agentId: string, askId: string, value: string): Promise<{ ok: boolean; error?: string }> {
    const cur = this.authored.get(agentId);
    const ask = cur && findNode(cur.source, askId);
    if (!cur || !ask || ask.tag !== "Ask") return { ok: false, error: "no such question on this canvas" };
    const option = ask.children.find((o) => o.attrs.value === value);
    if (!option) return { ok: false, error: `"${value}" is not one of the options` };
    if (ask.attrs.answer) return { ok: false, error: "already answered" };
    ask.attrs.answer = value;
    this.changed(agentId);
    this.persist();
    try {
      await this.send(agentId, `Canvas answer to "${ask.attrs.question}": ${value} (${option.text || value}).`);
    } catch (e) {
      delete ask.attrs.answer;
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
    if (!l) this.live.set(agentId, (l = { title: null, runState: "idle", callIds: new Set(), items: [], currentTool: null, lastActivityAt: this.now(), seq: 0 }));
    return l;
  }

  /** Agents already running when the plugin started. */
  private async discover() {
    try {
      const r = await this.api!.agents.list({ page: { limit: 100 } });
      const alive = new Set<string>();
      for (const { agent } of r.entries) if (!agent.archivedAt) { alive.add(agent.id); this.liveFor(agent.id).title = agent.title; await this.refresh(agent.id); }
      // a canvas restored from disk for an agent that is archived or gone does not belong on the board
      for (const id of this.restored) if (!alive.has(id)) this.authored.delete(id);
      this.restored.clear();
    } catch (e) { this.o.log(`discover failed: ${(e as Error).message}`); }
  }

  noteAgent(agentId: string, title?: string | null) {
    if (this.archived.has(agentId)) return;
    const l = this.liveFor(agentId);
    if (title !== undefined) l.title = title;
    void this.refresh(agentId);
  }
  /** Archived agents leave the board. */
  forget(agentId: string) {
    this.archived.add(agentId);
    this.live.delete(agentId);
    this.lastRow.delete(agentId);
    this.anchor.delete(agentId);
    if (this.authored.delete(agentId)) this.persist();
  }

  /** Pull the timeline tail and the run state for one agent. */
  async refresh(agentId: string) {
    if (!this.api || this.busy.has(agentId)) return;
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
      l.items = toAutoItems(items);
      const running = [...l.items].reverse().find((i) => i.kind === "tool" && i.status === "running");
      l.currentTool = running?.kind === "tool" ? running.label : null;
      this.changed(agentId);
    } catch (e) {
      this.o.log(`refresh ${agentId} failed: ${(e as Error).message}`);
    } finally { this.busy.delete(agentId); }
  }

  private async tick() {
    for (const [id, l] of this.live) {
      // Running agents every tick; a recently-active or errored one a few more times so the final state lands.
      if (l.runState === "running" || l.runState === "initializing" || this.now() - l.lastActivityAt < 15_000) await this.refresh(id);
    }
  }

  // ---------- the view ----------

  agents(): string[] {
    return [...new Set([...this.live.keys(), ...this.authored.keys()])];
  }

  view(agentId: string): CanvasView | null {
    const live = this.live.get(agentId);
    const a = this.authored.get(agentId);
    if (!live && !a) return null;
    const l = live ?? this.liveFor(agentId);
    const tree = a?.source ?? autoCanvas(l.title, l.items, l.runState === "running");
    return {
      agentId,
      title: a?.source.attrs.title ? String(a.source.attrs.title) : l.title ?? agentId.slice(0, 8),
      tree,
      auto: !a,
      updatedAt: a?.updatedAt ?? null,
      callsAtUpdate: a?.callsAtUpdate ?? 0,
      callsNow: l.callIds.size,
      runState: l.runState,
      currentTool: l.currentTool,
      lastActivityAt: l.lastActivityAt,
      url: `${this.o.publicBase}/a/${agentId}`,
    };
  }

  // ---------- the pane row ----------

  /** Something changed: re-publish the row, debounced so a burst of patches is one write. */
  private changed(agentId: string) {
    if (this.timers.has(agentId)) return;
    this.timers.set(agentId, setTimeout(() => { this.timers.delete(agentId); void this.publish(agentId); }, 250));
  }

  private async publish(agentId: string) {
    const v = this.view(agentId);
    if (!v || !this.api) return;
    // The row carries no clock: only real changes are written, so an idle agent costs nothing.
    // (lastActivityAt is left out: appending the row itself is activity, which would republish forever)
    const sig = JSON.stringify({ ...v, lastActivityAt: 0 });
    if (this.lastRow.get(agentId) === sig) return;
    this.lastRow.set(agentId, sig);
    try {
      const ref = this.api.agents.ref(agentId);
      const seq = this.live.get(agentId)?.seq ?? 0;
      let a = this.anchor.get(agentId);
      if (!a) this.anchor.set(agentId, (a = { n: 1, seq }));
      else if (seq - a.seq >= REANCHOR_AFTER) {
        // The agent has written a screenful since the canvas row: leave an empty stub there and put the canvas at the bottom.
        await ref.timeline.append({ type: "plugin", id: `${ROW_ID}-${a.n}`, kind: ROW_KIND, version: ROW_VERSION, data: { superseded: true } });
        a.n++;
        a.seq = seq;
      }
      await ref.timeline.append({ type: "plugin", id: `${ROW_ID}-${a.n}`, kind: ROW_KIND, version: ROW_VERSION, data: v });
    } catch (e) {
      this.lastRow.delete(agentId);
      this.o.log(`append row for ${agentId} failed: ${(e as Error).message}`);
    }
  }
}
