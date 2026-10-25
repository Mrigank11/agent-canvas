import { test } from "node:test";
import assert from "node:assert/strict";
import { Hub } from "../server/hub.ts";
import type { CanvasPolicy } from "../shared/config.ts";

const CANVAS = `<Canvas title="T"><Bluf>x</Bluf></Canvas>`;
type Row = { id: string; data: unknown };
function fake(labels: Record<string, string> = {}) {
  const st = { rows: [] as Row[], sent: [] as string[], labels };
  const api: any = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        send: async (text: string) => { st.sent.push(text); },
        current: () => ({ id, labels: st.labels }),
        refresh: async () => ({ agent: { id, labels: st.labels } }),
        timeline: {
          append: async (item: any) => { st.rows.push({ id: item.id, data: item.data }); return {}; },
          refetch: async () => ({ agent: { id, status: "idle", title: "A", updatedAt: new Date().toISOString() }, window: { maxSeq: 1 }, entries: [] }),
        },
      }),
    },
  };
  return { api, st };
}
const wait = (ms = 320) => new Promise((r) => setTimeout(r, ms));
const make = (policy: CanvasPolicy, api?: unknown) => {
  const p = { ...policy };
  const h = new Hub({ log: () => {}, stateFile: null, publicBase: "http://h", localBase: "http://l", policy: () => p, recipe: (id) => `RECIPE ${id}` });
  if (api) h.capture({ paseo: api as never }, "test");
  return { h, p };
};

test("everything off: an agent with no override has no canvas, cannot write one, and is not listed", async () => {
  const { h } = make({ defaultOn: false, autoCanvas: false }, fake().api);
  h.noteAgent("a1", "Plain");
  await wait(60);
  assert.equal(h.view("a1"), null);
  assert.deepEqual(h.set("a1", CANVAS), { ok: false, errors: ["the canvas is off for this agent (if it was only just created with canvas=on, wait a few seconds and retry)"] });
  assert.deepEqual(h.stateOf("a1"), { override: null, tools: false, show: false });
  h.stop();
});

test("an override on beats the global switch off: tools, shown, and it can write", async () => {
  const { h } = make({ defaultOn: false, autoCanvas: false }, fake().api);
  h.noteAgent("a1", "Chosen");
  h.setOverride("a1", "on", "env");
  assert.ok(h.set("a1", CANVAS).ok);
  assert.equal(h.view("a1")?.auto, false);
  assert.deepEqual(h.stateOf("a1"), { override: "on", tools: true, show: true });
  h.stop();
});

test("an override off beats the global switch on: hidden and read-only", async () => {
  const { h } = make({ defaultOn: true, autoCanvas: true }, fake().api);
  h.noteAgent("a1", "Quiet");
  h.setOverride("a1", "off", "env");
  assert.equal(h.view("a1"), null);
  assert.equal(h.set("a1", CANVAS).ok, false);
  h.stop();
});

test("auto canvas only: the default shows a timeline canvas but gives no tools", async () => {
  const { h } = make({ defaultOn: false, autoCanvas: true }, fake().api);
  h.noteAgent("a1", "Auto");
  await wait(60);
  assert.equal(h.view("a1")?.auto, true);
  assert.equal(h.set("a1", CANVAS).ok, false);
  h.stop();
});

test("the latest explicit source wins: pill, then env, then label; clearing the pill falls back", async () => {
  const { h } = make({ defaultOn: false, autoCanvas: false }, fake().api);
  h.noteAgent("a1", "x");
  h.setOverride("a1", "on", "label");
  assert.equal(h.override("a1"), "on");
  h.setOverride("a1", "off", "env");
  assert.equal(h.override("a1"), "off");
  h.setOverride("a1", "on", "runtime");
  assert.equal(h.override("a1"), "on");
  h.setOverride("a1", null, "runtime");
  assert.equal(h.override("a1"), "off");
  h.stop();
});

test("a label is read from Paseo after creation and an agent without tools gets the recipe exactly once", async () => {
  const { api, st } = fake({ canvas: "on" });
  const { h } = make({ defaultOn: false, autoCanvas: false }, api);
  h.noteAgent("a1", "Labelled");
  await h.learnLabels("a1");
  await wait(60);
  assert.equal(h.override("a1"), "on");
  assert.deepEqual(st.sent, []); // the initial prompt goes first: nothing is sent before the first turn has started
  h.turnStarted("a1");
  await wait(60);
  assert.deepEqual(st.sent, ["RECIPE a1"]);
  await h.learnLabels("a1");
  h.setOverride("a1", "on", "runtime");
  h.turnStarted("a1");
  await wait(60);
  assert.equal(st.sent.length, 1);
  h.stop();
});

test("an agent that already has the MCP tools is not sent the recipe", async () => {
  const { api, st } = fake();
  const { h } = make({ defaultOn: false, autoCanvas: false }, api);
  h.bind(h.mintToken("/x"), "a1");
  h.noteAgent("a1", "Tools");
  h.setOverride("a1", "on", "env");
  await wait(60);
  assert.deepEqual(st.sent, []);
  h.stop();
});

test("switching the global setting re-derives the view; the view goes when the canvas goes off", async () => {
  const { api, st } = fake();
  const { h, p } = make({ defaultOn: true, autoCanvas: true }, api);
  h.set("a1", CANVAS);
  await wait();
  assert.equal(st.rows.length, 0);
  p.defaultOn = false; p.autoCanvas = false;
  h.policyChanged();
  await wait();
  assert.equal(h.view("a1"), null);
  assert.equal(st.rows.length, 0);
  h.stop();
});

test("the recipe waits for a turn that has not started, but a runtime choice sends at once", async () => {
  const { api, st } = fake();
  const { h } = make({ defaultOn: false, autoCanvas: false }, api);
  h.noteAgent("a1", "x");
  h.setOverride("a1", "on", "runtime");
  await wait(60);
  assert.deepEqual(st.sent, ["RECIPE a1"]);
  h.stop();
});

test("a turn that started before the label was read still gets the recipe", async () => {
  const { api, st } = fake({ canvas: "on" });
  const { h } = make({ defaultOn: false, autoCanvas: false }, api);
  h.noteAgent("a1", "x");
  h.turnStarted("a1");
  await h.learnLabels("a1");
  await wait(60);
  assert.deepEqual(st.sent, ["RECIPE a1"]);
  h.stop();
});

// ---------- polling discipline and one-line tool labels ----------

function counting(opts: { fail?: boolean; items?: unknown[] } = {}) {
  const st = { refetch: 0, fail: !!opts.fail, items: opts.items ?? [], logs: [] as string[] };
  const api: any = {
    agents: {
      list: async () => ({ entries: [] }),
      ref: (id: string) => ({
        send: async () => {},
        current: () => ({ id, labels: {} }),
        timeline: {
          append: async () => ({}),
          refetch: async () => {
            st.refetch++;
            if (st.fail) throw new Error("OpenCode 2.0.8 is too old");
            return { agent: { id, status: "running", title: "A", updatedAt: new Date().toISOString() }, window: { maxSeq: 1 }, entries: st.items.map((item, i) => ({ item, seqStart: i })) };
          },
        },
      }),
    },
  };
  return { api, st };
}
const makeNow = (policy: CanvasPolicy, api: unknown, log: (m: string) => void, clock: { t: number }) => {
  const h = new Hub({ log, stateFile: null, publicBase: "http://h", localBase: "http://l", policy: () => policy, now: () => clock.t });
  h.capture({ paseo: api as never }, "test");
  return h;
};

test("an agent with no canvas, no override and no auto canvas is never read", async () => {
  const { api, st } = counting();
  const h = makeNow({ defaultOn: false, autoCanvas: false }, api, () => {}, { t: 1000 });
  for (let i = 0; i < 5; i++) h.noteAgent("a1", "Opencode agent", "w1");
  await h.refresh("a1");
  await (h as any).tick();
  assert.equal(st.refetch, 0);
  h.stop();
});

test("it starts reading as soon as the agent gets an override, and stops when it is switched off", async () => {
  const { api, st } = counting();
  const h = makeNow({ defaultOn: false, autoCanvas: false }, api, () => {}, { t: 1000 });
  h.noteAgent("a1", "x");
  h.setOverride("a1", "on", "env");
  await wait(40);
  assert.equal(st.refetch, 0); // an env override arrives while the agent is still being created: not read yet
  h.noteAgent("a1", "x"); // agent.created
  await wait(40);
  assert.ok(st.refetch >= 1);
  const before = st.refetch;
  h.setOverride("a1", "off", "runtime");
  await h.refresh("a1");
  assert.equal(st.refetch, before);
  h.stop();
});

test("a failing agent backs off and is logged once, not on every attempt", async () => {
  const { api, st } = counting({ fail: true });
  const logs: string[] = [];
  const clock = { t: 1_000_000 };
  const h = makeNow({ defaultOn: true, autoCanvas: true }, api, (m) => logs.push(m), clock);
  h.noteAgent("a1", "Old opencode");
  await wait(40);
  const first = st.refetch;
  for (let i = 0; i < 20; i++) await h.refresh("a1"); // hooks and ticks keep asking
  assert.equal(st.refetch, first); // inside the backoff window: no call
  assert.equal(logs.filter((l) => l.includes("failed")).length, 1);
  clock.t += 31_000;
  await h.refresh("a1");
  assert.equal(st.refetch, first + 1); // retried after the window
  await h.refresh("a1");
  assert.equal(st.refetch, first + 1); // and the window doubled
  assert.equal(logs.filter((l) => l.includes("failed")).length, 1);
  st.fail = false;
  clock.t += 3_600_000;
  await h.refresh("a1");
  assert.equal(h.view("a1")?.runState, "running"); // recovers
  h.stop();
});

test("a 40-line shell command becomes one short line in the status", async () => {
  const heredoc = `cat > /tmp/c.tsx <<'EOF'\n${"<Step>line</Step>\n".repeat(40)}EOF\ncurl -s -X POST http://127.0.0.1:6790/api/canvas/x --data-binary @/tmp/c.tsx`;
  const { api } = counting({ items: [{ type: "tool_call", callId: "c1", name: "Bash", status: "running", detail: { type: "shell", command: heredoc } }] });
  const h = makeNow({ defaultOn: true, autoCanvas: true }, api, () => {}, { t: 1000 });
  h.noteAgent("a1", "x");
  await wait(40);
  const tool = h.view("a1")!.currentTool!;
  assert.doesNotMatch(tool, /\n/);
  assert.ok(tool.length <= 80, `${tool.length}`);
  assert.match(tool, /^Shell: cat > \/tmp\/c\.tsx <<'EOF/);
  assert.ok(tool.endsWith("…") || tool.length < 80);
  h.stop();
});

import { briefSnippet, recipe } from "../server/recipe.ts";
test("the brief snippet takes the agent id from its shell, so a brief can carry it from the first turn", () => {
  const s = briefSnippet(6790);
  assert.match(s, /http:\/\/127\.0\.0\.1:6790\/api\/canvas\/\$PASEO_AGENT_ID/);
  assert.match(s, /<Canvas title=/); // the vocabulary is in it
  assert.match(recipe("http://x/api/canvas/abc"), /curl -s -X POST http:\/\/x\/api\/canvas\/abc --data-binary/);
});
