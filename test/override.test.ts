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
  assert.deepEqual(h.set("a1", CANVAS), { ok: false, errors: ["the canvas is off for this agent"] });
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

test("switching the global setting re-derives the view; a shown card is blanked when the canvas goes off", async () => {
  const { api, st } = fake();
  const { h, p } = make({ defaultOn: true, autoCanvas: true }, api);
  h.set("a1", CANVAS);
  await wait();
  assert.equal(st.rows.length, 1);
  p.defaultOn = false; p.autoCanvas = false;
  h.policyChanged();
  await wait();
  assert.equal(h.view("a1"), null);
  assert.deepEqual(st.rows.at(-1)?.data, { superseded: true });
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
