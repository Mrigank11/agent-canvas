import { test } from "node:test";
import { mkdtempSync, existsSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import { Hub } from "../server/hub.ts";
import { renderCanvas } from "../server/html.ts";
import { startHttp, isLocalPeer, type Listener } from "../server/http.ts";
import { bindHosts, isTailnetIp, relayKey } from "../server/bind.ts";
import { fmCss, scopeCss } from "../server/fm-css.ts";

const CANVAS = `<Canvas title="Crew" status="working"><Bluf id="b">Picking a database</Bluf><Steps id="s"><Step id="a" state="done">read</Step><Step id="c" state="active">choose</Step></Steps><Ask id="db" question="Which database?" blocking><Option value="pg">Postgres</Option><Option value="lite">SQLite</Option></Ask></Canvas>`;

/** A fake Paseo: the agents in `known` exist; everything sent is recorded by target. */
function fake(known: string[], status = "idle") {
  const agents = new Map(known.map((id) => [id, { id, title: `T-${id}`, status, cwd: "/w", workspaceId: "ws", labels: {} as Record<string, string> }]));
  const sent: { to: string; text: string }[] = [];
  const api: any = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        current: () => agents.get(id) ?? null,
        refresh: async () => { if (!agents.has(id)) throw new Error("not found"); return { agent: agents.get(id) }; },
        send: async (text: string) => { sent.push({ to: id, text }); },
        timeline: { append: async () => ({}), refetch: async () => ({ agent: agents.get(id), window: { maxSeq: 1 }, entries: [] }) },
      }),
    },
  };
  return { api, agents, sent };
}
const mk = (stateFile: string | null = null) => new Hub({ log: () => {}, stateFile, publicBase: "http://pub:1", localBase: "http://127.0.0.1:1", policy: () => ({ defaultOn: true, autoCanvas: true }) });
const dir = () => mkdtempSync(join(tmpdir(), "ac-relay-"));
const wait = (ms = 320) => new Promise((r) => setTimeout(r, ms));

/** A hub whose crew "crew-1" relays picks to "mate". */
async function relayed(stateFile: string | null = null) {
  const f = fake(["crew-1", "mate"]);
  f.agents.get("crew-1")!.labels = { "canvas.relay": "mate", "fm.task": "p5-demo" };
  const h = mk(stateFile);
  h.capture({ paseo: f.api }, "test");
  await h.learnLabels("crew-1");
  h.set("crew-1", CANVAS);
  return { ...f, h };
}

// ---------- relay ----------

test("relay: a pick is recorded as pending and sent to the relay agent, not to the crew", async () => {
  const { h, sent } = await relayed();
  const r = await h.answer("crew-1", "db", "pg");
  assert.deepEqual(r, { ok: true, pending: true });
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, "mate");
  assert.match(sent[0].text, /^## Canvas answer · p5-demo · ask db: pg \(Postgres\)\nagent crew-1 · question "Which database\?"/);
  assert.match(h.source("crew-1")!, /pending="pg"/);
  assert.doesNotMatch(h.source("crew-1")!, /answer=/);
  const s = h.summary("crew-1")!;
  assert.equal(s.openAsks.length, 1);
  assert.equal(s.openAsks[0].pending, "pg");
  const html = renderCanvas(h.view("crew-1")!, Date.now());
  assert.match(html, /Sent to the first mate: Postgres/);
  assert.doesNotMatch(html, /data-ask=/);
  h.stop();
});

test("relay: a second pick while one is pending is refused, and a bad option never reaches the relay", async () => {
  const { h, sent } = await relayed();
  assert.equal((await h.answer("crew-1", "db", "nope")).ok, false);
  assert.equal(sent.length, 0);
  await h.answer("crew-1", "db", "pg");
  const again = await h.answer("crew-1", "db", "lite");
  assert.equal(again.ok, false);
  assert.match(again.error!, /already pending/);
  assert.equal(sent.length, 1);
  h.stop();
});

test("relay: deliver answers the Ask for good and tells the crew; decline closes it with the reason", async () => {
  const a = await relayed();
  await a.h.answer("crew-1", "db", "pg");
  assert.deepEqual(await a.h.deliver("crew-1", "db", { value: "pg" }), { ok: true });
  assert.equal(a.sent[1].to, "crew-1");
  assert.match(a.sent[1].text, /Which database\?.*: pg \(Postgres\)/);
  assert.match(a.h.source("crew-1")!, /answer="pg"/);
  assert.doesNotMatch(a.h.source("crew-1")!, /pending=/);
  assert.equal((await a.h.deliver("crew-1", "db", { value: "pg" })).error, "already answered");
  assert.equal(a.h.summary("crew-1")!.openAsks.length, 0);
  a.h.stop();

  const b = await relayed();
  await b.h.answer("crew-1", "db", "lite");
  assert.equal((await b.h.deliver("crew-1", "db", { decline: "not in scope" })).ok, true);
  assert.match(b.sent[1].text, /closed without an answer: not in scope/);
  assert.equal(b.h.summary("crew-1")!.openAsks.length, 0);
  assert.doesNotMatch(b.h.source("crew-1")!, /pending=/);
  b.h.stop();
});

test("relay: a delivery that cannot reach the crew is rolled back to pending", async () => {
  const a = await relayed();
  await a.h.answer("crew-1", "db", "pg");
  const ref = a.api.agents.ref;
  a.api.agents.ref = (id: string) => ({ ...ref(id), send: async () => { throw new Error("daemon down"); } });
  const r = await a.h.deliver("crew-1", "db", { value: "pg" });
  assert.equal(r.ok, false);
  assert.match(a.h.source("crew-1")!, /pending="pg"/);
  assert.doesNotMatch(a.h.source("crew-1")!, /answer=/);
  a.h.stop();
});

test("relay: if the relay agent is gone the pick goes straight to the crew", async () => {
  const a = await relayed();
  a.agents.delete("mate");
  assert.deepEqual(await a.h.answer("crew-1", "db", "pg"), { ok: true });
  assert.deepEqual(a.sent.map((s) => s.to), ["crew-1"]);
  assert.match(a.h.source("crew-1")!, /answer="pg"/);
  a.h.stop();
});

test("relay: an agent without the label answers as before", async () => {
  const f = fake(["crew-2"]);
  const h = mk();
  h.capture({ paseo: f.api }, "test");
  h.set("crew-2", CANVAS);
  assert.deepEqual(await h.answer("crew-2", "db", "pg"), { ok: true });
  assert.equal(f.sent[0].to, "crew-2");
  h.stop();
});

test("relay: the label survives a restart, and the pending state shows in both renderers' plan", async () => {
  const d = join(dir(), "state.json");
  const a = await relayed(d);
  await a.h.answer("crew-1", "db", "pg");
  a.h.stop();
  const f = fake(["crew-1", "mate"]);
  const h2 = mk(d);
  h2.capture({ paseo: f.api }, "test");
  assert.equal(h2.relayOf("crew-1"), "mate");
  assert.equal(h2.summary("crew-1")!.openAsks[0].pending, "pg");
  h2.stop();
});

// ---------- summary and card ----------

test("summary: verdict, BLUF, steps, open asks and a rev that moves on every change", async () => {
  const { h } = await relayed();
  const s1 = h.summary("crew-1", Date.now())!;
  assert.equal(s1.title, "Crew");
  assert.equal(s1.bluf, "Picking a database");
  assert.deepEqual(s1.steps, { done: 1, total: 2, current: "choose" });
  assert.equal(s1.verdict.label, "Needs you");
  assert.equal(s1.verdict.needsYou, true);
  assert.deepEqual(s1.openAsks[0], { id: "db", question: "Which database?", options: [{ value: "pg", label: "Postgres" }, { value: "lite", label: "SQLite" }], blocking: true });
  assert.equal(s1.archived, false);
  await h.answer("crew-1", "db", "pg");
  assert.ok(h.summary("crew-1")!.rev > s1.rev);
  assert.equal(h.summary("nobody"), null);
  h.stop();
});

test("fm HTTP: summary, card (embed: no script, no buttons) and css are served to this machine", async () => {
  const { h } = await relayed();
  const l = await startHttp(h, 0, "127.0.0.1", () => {}, Date.now, { key: "k".repeat(40), pageToken: "tok" });
  const base = `http://127.0.0.1:${l.ports[0]}`;
  try {
    const sum = await (await fetch(`${base}/api/fm/summary?agents=crew-1,ghost`)).json() as any;
    assert.equal(sum.agents.length, 1);
    assert.deepEqual(sum.missing, ["ghost"]);
    const card = await (await fetch(`${base}/api/fm/card/crew-1`)).text();
    assert.match(card, /^<div class="acv">/);
    assert.doesNotMatch(card, /<script|<button|data-ask/);
    assert.match(card, /Which database\?/);
    assert.match(card, /Answer on the card/);
    const css = await fetch(`${base}/api/fm/css?theme=dark`);
    assert.match(css.headers.get("content-type")!, /text\/css/);
    const text = await css.text();
    assert.match(text, /\.acv/);
    assert.equal((await fetch(`${base}/api/fm/card/ghost`)).status, 404);
    // the normal page still has its buttons and its token
    const full = await (await fetch(`${base}/a/crew-1`)).text();
    assert.match(full, /data-ask="db"/);
    assert.match(full, /name="canvas-token" content="tok"/);
  } finally { l.close(); l.closeAllConnections(); h.stop(); }
});

test("css scoping: rules are prefixed, :root/body become the scope, dark media follows an explicit theme", () => {
  const css = ":root{--a:1}@media (prefers-color-scheme:dark){:root{--a:2}.x{color:red}}body{margin:0}*{box-sizing:border-box}a:hover,.b>i{c:d}@keyframes k{50%{o:1}}";
  assert.equal(scopeCss(css, ".s"), ".s{--a:1}@media (prefers-color-scheme:dark){.s{--a:2}.s .x{color:red}}.s{margin:0}.s,.s *{box-sizing:border-box}.s a:hover,.s .b>i{c:d}@keyframes k{50%{o:1}}");
  assert.equal(scopeCss(css, ".s", "dark"), ".s{--a:1}.s{--a:2}.s .x{color:red}.s{margin:0}.s,.s *{box-sizing:border-box}.s a:hover,.s .b>i{c:d}@keyframes k{50%{o:1}}");
  assert.doesNotMatch(scopeCss(css, ".s", "light"), /--a:2|color:red/);
  const real = fmCss();
  assert.doesNotMatch(real, /(^|\})(body|nav|main|a)\{/);
});

// ---------- write hardening ----------

test("resolve: only a real agent (or a bound token) is a write target", async () => {
  const f = fake(["real"]);
  const h = mk();
  h.capture({ paseo: f.api }, "test");
  assert.equal(await h.resolve("real"), "real");
  assert.equal(await h.resolve("ghost"), null);
  const t = h.mintToken("/w");
  assert.equal(await h.resolve(t), null);
  h.bind(t, "real");
  assert.equal(await h.resolve(t), "real");
  f.agents.get("real")!.labels = {};
  (f.agents.get("real") as any).archivedAt = "2026-01-01";
  assert.equal(await h.resolve("real-archived"), null);
  h.forget("real");
  assert.equal(await h.resolve("real"), null);
  h.stop();
});

test("HTTP writes: an unknown agent id is refused; a real one is written", async () => {
  const f = fake(["real"]);
  const h = mk();
  h.capture({ paseo: f.api }, "test");
  const l = await startHttp(h, 0, "127.0.0.1", () => {});
  const base = `http://127.0.0.1:${l.ports[0]}`;
  try {
    const bad = await fetch(`${base}/api/canvas/ghost`, { method: "POST", body: CANVAS });
    assert.equal(bad.status, 404);
    assert.equal(h.source("ghost"), null);
    assert.equal((await fetch(`${base}/api/canvas/ghost/patch`, { method: "POST", body: "[]" })).status, 404);
    const ok = await fetch(`${base}/api/canvas/real`, { method: "POST", body: CANVAS });
    assert.equal(ok.status, 200);
    assert.match(h.source("real")!, /Which database/);
    assert.equal((await fetch(`${base}/mcp/ghost`, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "canvas_set", arguments: { source: CANVAS } } }) })).status, 200);
    assert.equal(h.source("ghost"), null);
  } finally { l.close(); l.closeAllConnections(); h.stop(); }
});

test("/api/answer: refused without the page token or the relay key, accepted with either", async () => {
  const { h, sent } = await relayed();
  const key = "k".repeat(40);
  const l = await startHttp(h, 0, "127.0.0.1", () => {}, Date.now, { key, pageToken: "page-token" });
  const base = `http://127.0.0.1:${l.ports[0]}`;
  const post = (headers: Record<string, string>, ask = "db", value = "pg") =>
    fetch(`${base}/api/answer`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ agentId: "crew-1", askId: ask, value }) });
  try {
    assert.equal((await post({})).status, 401);
    assert.equal((await post({ "x-canvas-token": "wrong" })).status, 403);
    assert.equal((await post({ "x-canvas-key": "wrong" })).status, 403);
    assert.equal(sent.length, 0);
    const ok = await (await post({ "x-canvas-token": "page-token" })).json() as any;
    assert.equal(ok.ok, true);
    assert.equal(sent[0].to, "mate");
  } finally { l.close(); l.closeAllConnections(); h.stop(); }
});

test("/api/fm/deliver: needs the relay key (401 without, 403 with a wrong one), then delivers", async () => {
  const { h, sent } = await relayed();
  const key = "k".repeat(40);
  const l = await startHttp(h, 0, "127.0.0.1", () => {}, Date.now, { key, pageToken: "page-token" });
  const base = `http://127.0.0.1:${l.ports[0]}`;
  const deliver = (headers: Record<string, string>, body: object) => fetch(`${base}/api/fm/deliver`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    await h.answer("crew-1", "db", "pg");
    assert.equal((await deliver({}, { agentId: "crew-1", askId: "db", value: "pg" })).status, 401);
    assert.equal((await deliver({ "x-canvas-key": "wrong" }, { agentId: "crew-1", askId: "db", value: "pg" })).status, 403);
    assert.equal((await deliver({ "x-canvas-token": "page-token" }, { agentId: "crew-1", askId: "db", value: "pg" })).status, 401);
    assert.match(h.source("crew-1")!, /pending="pg"/);
    assert.equal((await deliver({ "x-canvas-key": key }, { agentId: "ghost", askId: "db", value: "pg" })).status, 404);
    assert.equal((await deliver({ "x-canvas-key": key }, { agentId: "crew-1", askId: "db" })).status, 400);
    const ok = await (await deliver({ "x-canvas-key": key }, { agentId: "crew-1", askId: "db", value: "pg" })).json() as any;
    assert.equal(ok.ok, true);
    assert.equal(sent.at(-1)!.to, "crew-1");
    const none = await (await fetch(`${base}/api/fm/deliver`, { method: "POST", headers: { "x-canvas-key": "k" } , body: "{}" })).status;
    assert.equal(none, 403);
  } finally { l.close(); l.closeAllConnections(); h.stop(); }
});

test("with no relay key configured, deliver is off", async () => {
  const { h } = await relayed();
  const l = await startHttp(h, 0, "127.0.0.1", () => {});
  try {
    const r = await fetch(`http://127.0.0.1:${l.ports[0]}/api/fm/deliver`, { method: "POST", headers: { "x-canvas-key": "anything" }, body: JSON.stringify({ agentId: "crew-1", askId: "db", value: "pg" }) });
    assert.equal(r.status, 403);
  } finally { l.close(); l.closeAllConnections(); h.stop(); }
});

// ---------- archive snapshot ----------

test("archive: the final canvas outlives the agent and is readable as a summary and a card", async () => {
  const d = dir();
  const { h } = await relayed(join(d, "state.json"));
  await h.answer("crew-1", "db", "pg");
  assert.ok(h.view("crew-1"));
  h.forget("crew-1");
  assert.equal(h.view("crew-1"), null);
  assert.ok(existsSync(join(d, "archive", "crew-1.json")));
  const s = h.summary("crew-1")!;
  assert.equal(s.archived, true);
  assert.equal(s.bluf, "Picking a database");
  assert.equal(s.runState, "closed");
  assert.equal(s.verdict.label, "Closed");
  const l = await startHttp(h, 0, "127.0.0.1", () => {});
  const base = `http://127.0.0.1:${l.ports[0]}`;
  try {
    assert.equal((await fetch(`${base}/api/fm/card/crew-1`)).status, 404);
    const card = await fetch(`${base}/api/fm/card/crew-1?archived=1`);
    assert.equal(card.status, 200);
    assert.match(await card.text(), /Picking a database/);
    const sum = await (await fetch(`${base}/api/fm/summary?agents=crew-1`)).json() as any;
    assert.equal(sum.agents[0].archived, true);
  } finally { l.close(); l.closeAllConnections(); }
  // and it survives a restart of the plugin
  const h2 = mk(join(d, "state.json"));
  assert.equal(h2.summary("crew-1")!.archived, true);
  h2.stop(); h.stop();
});

test("archive: snapshots are pruned after 30 days; an agent with no canvas leaves none", async () => {
  const d = dir();
  const { h } = await relayed(join(d, "state.json"));
  h.forget("crew-1");
  const file = join(d, "archive", "crew-1.json");
  assert.ok(existsSync(file));
  const old = new Date(Date.now() - 31 * 24 * 3600_000);
  utimesSync(file, old, old);
  h.pruneArchive();
  assert.equal(existsSync(file), false);
  h.forget("never-had-one");
  assert.equal(existsSync(join(d, "archive", "never-had-one.json")), false);
  assert.equal(h.archivedView("../state"), null);
  h.stop();
});

// ---------- bind ----------

test("bind: loopback plus the tailnet address by default, never every interface", () => {
  const ifs: any = {
    lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
    eth0: [{ address: "192.168.1.5", family: "IPv4", internal: false }],
    tailscale0: [{ address: "100.64.0.10", family: "IPv4", internal: false }, { address: "fd7a::1", family: "IPv6", internal: false }],
  };
  assert.deepEqual(bindHosts(undefined, ifs), ["127.0.0.1", "100.64.0.10"]);
  assert.deepEqual(bindHosts("", ifs), ["127.0.0.1", "100.64.0.10"]);
  assert.deepEqual(bindHosts(undefined, { lo: ifs.lo, eth0: ifs.eth0 }), ["127.0.0.1"]);
  assert.deepEqual(bindHosts("0.0.0.0", ifs), ["0.0.0.0"]);
  assert.deepEqual(bindHosts("127.0.0.1, 100.64.0.11", ifs), ["127.0.0.1", "100.64.0.11"]);
  assert.equal(isTailnetIp("100.64.0.1"), true);
  assert.equal(isTailnetIp("100.128.0.1"), false);
  assert.equal(isTailnetIp("192.168.1.1"), false);
});

test("bind: two addresses share one port and one handler; peers off this machine are not local", async () => {
  const { h } = await relayed();
  const l = await startHttp(h, 0, ["127.0.0.1", "127.0.0.2"], () => {});
  try {
    assert.equal(l.servers.length, 2);
    assert.equal(l.ports[0], l.ports[1]);
    assert.equal((await fetch(`http://127.0.0.2:${l.ports[0]}/api/health`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${l.ports[0]}/api/health`)).status, 200);
  } finally { l.close(); l.closeAllConnections(); h.stop(); }
  assert.equal(isLocalPeer("127.0.0.1"), true);
  assert.equal(isLocalPeer("::1"), true);
  assert.equal(isLocalPeer("::ffff:127.0.0.1"), true);
  assert.equal(isLocalPeer("203.0.113.9"), false);
  assert.equal(isLocalPeer(undefined), false);
});

test("the relay key is minted once, owner-only, and read back", () => {
  const f = join(dir(), "sub", "relay.key");
  const k = relayKey(f);
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.equal(statSync(f).mode & 0o777, 0o600);
  assert.equal(relayKey(f), k);
  assert.equal(readFileSync(f, "utf8").trim(), k);
});
