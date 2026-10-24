import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Hub } from "../server/hub.ts";
import { handleRpc } from "../server/mcp.ts";
import { renderCanvas, renderIndex, esc } from "../server/html.ts";
import { REANCHOR_AFTER } from "../shared/contract.ts";

type Row = { id: string; data: any };
function fake(opts: { status?: string; items?: any[]; maxSeq?: number } = {}) {
  const st = { status: opts.status ?? "running", items: opts.items ?? [], maxSeq: opts.maxSeq ?? 1, rows: [] as Row[], sent: [] as string[] };
  const api: any = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        send: async (text: string) => { st.sent.push(text); },
        timeline: {
          append: async (item: any) => { st.rows.push({ id: item.id, data: item.data }); return {}; },
          refetch: async () => ({ agent: { id, status: st.status, title: "Agent", updatedAt: new Date().toISOString() }, window: { maxSeq: st.maxSeq }, entries: st.items.map((item, i) => ({ item, seqStart: i })) }),
        },
      }),
    },
  };
  return { api, st };
}
const wait = (ms = 320) => new Promise((r) => setTimeout(r, ms));
const hub = (extra = {}) => new Hub({ log: () => {}, stateFile: null, publicBase: "http://h:1", localBase: "http://127.0.0.1:1", policy: () => ({ defaultOn: true, autoCanvas: true }), ...extra });
const CANVAS = `<Canvas title="T" status="working"><Steps id="s"><Step id="a" state="active">a</Step></Steps><Ask id="q" question="Q?"><Option value="y">Yes</Option></Ask></Canvas>`;
const tool = async (h: Hub, key: string, name: string, args: unknown) => (await handleRpc(h, key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;

test("a creation token binds to the agent id and the MCP tools then act on that agent", async () => {
  const h = hub();
  const token = h.mintToken("/work/x");
  assert.equal(await h.resolve(token), null);
  assert.match((await tool(h, token, "canvas_set", { source: CANVAS })).content[0].text, /not attached/);
  h.bind(token, "agent-1");
  assert.equal(await h.resolve(token), "agent-1");
  const r = (await tool(h, token, "canvas_set", { source: CANVAS }));
  assert.equal(r.isError, false);
  assert.match(r.content[0].text, /Element ids: .*s, a, q/);
  assert.equal((await tool(h, token, "canvas_patch", { ops: [{ id: "a", set: { state: "done" } }] })).isError, false);
  assert.match((await tool(h, token, "canvas_get", {})).content[0].text, /state="done"/);
});

test("the cwd fallback binds a fresh agent to the newest pending token", async () => {
  const h = hub();
  const t = h.mintToken("/work/y");
  h.bindByCwd("agent-2", "/other");
  assert.equal(await h.resolve(t), null);
  h.bindByCwd("agent-2", "/work/y");
  assert.equal(await h.resolve(t), "agent-2");
});

test("validation errors come back to the agent and change nothing", async () => {
  const h = hub();
  const token = h.mintToken("/");
  h.bind(token, "a1");
  const r = (await tool(h, token, "canvas_set", { source: `<Canvas title="x"><script>1</script></Canvas>` }));
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /not in the vocabulary/);
  assert.equal(h.source("a1"), null);
  assert.match((await tool(h, token, "canvas_patch", { ops: [{ id: "x", set: {} }] })).content[0].text, /no canvas yet/);
});

test("MCP protocol: initialize, tools/list, notifications and unknown methods", async () => {
  const h = hub();
  const init = (await handleRpc(h, "k", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })) as any;
  assert.equal(init.result.protocolVersion, "2025-06-18");
  const list = (await handleRpc(h, "k", { jsonrpc: "2.0", id: 2, method: "tools/list" })) as any;
  assert.deepEqual(list.result.tools.map((t: any) => t.name), ["canvas_set", "canvas_patch", "canvas_get"]);
  assert.match(list.result.tools[0].description, /<Steps/);
  assert.equal((await handleRpc(h, "k", { jsonrpc: "2.0", method: "notifications/initialized" })), null);
  assert.equal(((await handleRpc(h, "k", { jsonrpc: "2.0", id: 3, method: "nope" })) as any).error.code, -32601);
});

test("answering an Ask records it, tells the agent, and refuses a second answer or a bad option", async () => {
  const { api, st } = fake();
  const h = hub();
  h.capture({ paseo: api }, "test");
  h.set("a1", CANVAS);
  assert.deepEqual(await h.answer("a1", "q", "nope"), { ok: false, error: '"nope" is not one of the options' });
  assert.deepEqual(await h.answer("a1", "q", "y"), { ok: true });
  assert.match(st.sent[0], /Q\?.*: y/);
  assert.match(h.source("a1")!, /answer="y"/);
  assert.equal((await h.answer("a1", "q", "y")).error, "already answered");
  assert.equal((await h.answer("a1", "zzz", "y")).ok, false);
  h.stop();
});

test("an answer that cannot be delivered is rolled back so the human can retry", async () => {
  const { api } = fake();
  api.agents.ref = () => ({ send: async () => { throw new Error("daemon down"); }, timeline: { append: async () => ({}), refetch: async () => ({ entries: [], window: {} }) } });
  const h = hub();
  h.capture({ paseo: api }, "test");
  h.set("a1", CANVAS);
  const r = await h.answer("a1", "q", "y");
  assert.equal(r.ok, false);
  assert.match(r.error!, /daemon down/);
  assert.doesNotMatch(h.source("a1")!, /answer=/);
  h.stop();
});

test("tool calls since the canvas was written are counted from Paseo's timeline, not the agent", async () => {
  const tc = (n: number) => ({ type: "tool_call", callId: `c${n}`, name: "Bash", status: "completed", detail: { type: "shell", command: `echo ${n}` } });
  const { api, st } = fake({ items: [tc(1)] });
  const h = hub();
  h.capture({ paseo: api }, "test");
  h.noteAgent("a1");
  await wait(50);
  h.set("a1", CANVAS);
  assert.equal(h.view("a1")!.callsAtUpdate, 1);
  st.items = [tc(1), tc(2), tc(3), { type: "tool_call", callId: "x", name: "mcp__canvas__canvas_patch", status: "completed", detail: { type: "unknown" } }];
  await h.refresh("a1");
  const v = h.view("a1")!;
  assert.equal(v.callsNow - v.callsAtUpdate, 2); // canvas tool calls are bookkeeping and do not count
  assert.equal(v.auto, false);
  h.stop();
});

test("an agent with no canvas gets an auto canvas from its timeline", async () => {
  const { api } = fake({ items: [{ type: "user_message", text: "fix the bug" }, { type: "tool_call", callId: "c1", name: "Edit", status: "completed", detail: { type: "edit", filePath: "a.ts" } }] });
  const h = hub();
  h.capture({ paseo: api }, "test");
  h.noteAgent("a1");
  await wait(50);
  const v = h.view("a1")!;
  assert.equal(v.auto, true);
  assert.equal(v.updatedAt, null);
  assert.match(JSON.stringify(v.tree), /Task: fix the bug/);
  assert.match(JSON.stringify(v.tree), /Files touched/);
  h.stop();
});

test("the pane row is replaced in place, then moved to the bottom once the agent has written a screenful", async () => {
  const { api, st } = fake();
  const h = hub();
  h.capture({ paseo: api }, "test");
  h.set("a1", CANVAS);
  await wait();
  assert.deepEqual(st.rows.map((r) => r.id), ["canvas-1"]);
  h.patch("a1", [{ id: "a", set: { state: "done" } }]);
  await wait();
  assert.deepEqual(st.rows.map((r) => r.id), ["canvas-1", "canvas-1"]); // same id: replaced in place
  st.maxSeq = 1 + REANCHOR_AFTER;
  await h.refresh("a1");
  h.patch("a1", [{ id: "a", text: "moved" }]);
  await wait();
  assert.deepEqual(st.rows.slice(2).map((r) => r.id), ["canvas-1", "canvas-2"]);
  assert.deepEqual(st.rows[2].data, { superseded: true });
  assert.equal(st.rows[3].data.title, "T");
  h.stop();
});

test("a canvas restored from disk is dropped when its agent is gone, but a live one is kept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "canvas-"));
  const file = join(dir, "state.json");
  const first = hub({ stateFile: file });
  first.set("gone", CANVAS);
  first.set("alive", CANVAS);
  first.stop();
  const { api } = fake();
  api.agents.list = async () => ({ entries: [{ agent: { id: "alive", title: "A", archivedAt: null } }] });
  const second = hub({ stateFile: file });
  second.capture({ paseo: api }, "test");
  await wait(80);
  assert.equal(second.view("gone"), null);
  assert.ok(second.view("alive"));
  second.stop();
});

test("archiving forgets the agent", async () => {
  const h = hub();
  h.set("a1", CANVAS);
  assert.ok(h.view("a1"));
  h.forget("a1");
  assert.equal(h.view("a1"), null);
});

test("HTML escapes everything the agent wrote and has no script", async () => {
  const h = hub();
  const evil = `<Canvas title="&lt;img src=x onerror=alert(1)&gt;"><Bluf>&lt;script&gt;alert(1)&lt;/script&gt;</Bluf><Link href="https://e.com/?a=1&amp;b=&quot;x">&lt;b&gt;x</Link><Code></pre><script>1</script></Code></Canvas>`;
  const r = h.set("a1", evil);
  assert.ok(r.ok, JSON.stringify(r));
  const html = renderCanvas(h.view("a1")!, Date.now()) + renderIndex([h.view("a1")!], Date.now());
  assert.doesNotMatch(html, /<script|<img|<b>x|<\/pre><script/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.equal(esc(`"<&>`), "&quot;&lt;&amp;&gt;");
});

test("the strip in the browser view comes from Paseo, so a canvas that lies is flagged there", async () => {
  const h = hub();
  h.set("a1", `<Canvas title="T" status="done"><Bluf>All done.</Bluf></Canvas>`);
  const v = { ...h.view("a1")!, runState: "running" as const, callsNow: 5 };
  const html = renderCanvas(v, Date.now());
  assert.match(html, /Disputed/);
  assert.match(html, /Canvas says done, but Paseo shows the agent still running/);
});
