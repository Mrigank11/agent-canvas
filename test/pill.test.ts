import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCanvas } from "../shared/canvas.ts";
import { pillState } from "../shared/pill.ts";

const NOW = 1_000_000_000;
const view = (inner: string, o: Record<string, unknown> = {}) => {
  const r = parseCanvas(`<Canvas title="t" status="${o.status ?? "working"}">${inner}</Canvas>`);
  assert.ok(r.ok);
  return { tree: r.ok ? r.root : (null as never), runState: "running" as const, updatedAt: NOW - 5000, callsNow: 0, callsAtUpdate: 0, ...o };
};
const STEPS = `<Steps><Step state="done">a</Step><Step state="done">b</Step><Step state="active">c</Step></Steps>`;

test("a running canvas with steps shows progress as done/total", () => {
  const s = pillState(view(STEPS), NOW);
  assert.deepEqual([s.label, s.tone], ["2/3", "run"]);
});
test("running without steps says Working", () => {
  assert.equal(pillState(view(`<Bluf>x</Bluf>`), NOW).label, "Working");
});
test("an open question on an idle agent says Needs you", () => {
  const s = pillState(view(`<Ask id="q" question="Q?"><Option value="a">A</Option></Ask>`, { runState: "idle" }), NOW);
  assert.deepEqual([s.label, s.tone], ["Needs you", "hot"]);
});
test("a canvas that says done while the agent keeps running says Disputed", () => {
  const s = pillState(view(`<Bluf>All done.</Bluf>`, { status: "done", callsNow: 5 }), NOW);
  assert.deepEqual([s.label, s.tone], ["Disputed", "warn"]);
});
test("stale, error, done and idle-unfinished", () => {
  assert.equal(pillState(view(STEPS, { callsNow: 9 }), NOW).label, "Stale");
  assert.deepEqual([pillState(view(STEPS, { runState: "error" }), NOW).label, pillState(view(STEPS, { runState: "error" }), NOW).tone], ["Error", "err"]);
  assert.equal(pillState(view(`<Bluf>Shipped.</Bluf>`, { status: "done", runState: "idle" }), NOW).label, "Done");
  assert.equal(pillState(view(STEPS, { runState: "idle" }), NOW).label, "2/3"); // idle but unfinished: progress, with the idle-unfinished flag
  assert.ok(pillState(view(STEPS, { runState: "idle" }), NOW).verdict.flags.some((f) => f.code === "idle-unfinished"));
});
test("an auto canvas with nothing to say is just Canvas", () => {
  assert.equal(pillState(view(`<Bluf>x</Bluf>`, { runState: "idle", updatedAt: null }), NOW).label, "Canvas");
});
