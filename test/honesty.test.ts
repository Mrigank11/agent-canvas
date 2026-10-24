import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCanvas } from "../shared/canvas.ts";
import { checkHonesty, summarize, type Facts } from "../shared/honesty.ts";
import { autoCanvas } from "../shared/auto.ts";

const canvas = (inner: string, status = "working") => {
  const r = parseCanvas(`<Canvas title="t" status="${status}">${inner}</Canvas>`);
  assert.ok(r.ok);
  return r.ok ? r.root : (null as never);
};
const NOW = 1_000_000_000;
const facts = (o: Partial<Facts> = {}): Facts => ({ runState: "running", canvasUpdatedAt: NOW - 5_000, toolCallsSinceUpdate: 0, now: NOW, ...o });
const codes = (v: ReturnType<typeof checkHonesty>) => v.flags.map((f) => f.code);

const DONE = canvas(`<Bluf>Shipped.</Bluf><Steps><Step state="done">a</Step></Steps>`, "done");
const WORKING = canvas(`<Bluf>Building.</Bluf><Steps><Step state="done">a</Step><Step state="active">b</Step></Steps>`);

test("says done but still running: flagged once the agent keeps working", () => {
  assert.deepEqual(codes(checkHonesty(DONE, facts())), []); // grace: just wrote it
  assert.deepEqual(codes(checkHonesty(DONE, facts({ toolCallsSinceUpdate: 2 }))), ["done-but-running"]);
  assert.deepEqual(codes(checkHonesty(DONE, facts({ canvasUpdatedAt: NOW - 11_000 }))), ["done-but-running"]);
  assert.equal(checkHonesty(DONE, facts({ toolCallsSinceUpdate: 3 })).label, "Disputed");
});

test("done and idle is simply Done", () => {
  const v = checkHonesty(DONE, facts({ runState: "idle", toolCallsSinceUpdate: 9 }));
  assert.deepEqual(codes(v), []);
  assert.equal(v.label, "Done");
});

test("claims of done come from status, all-steps-done, or the Bluf", () => {
  assert.ok(summarize(canvas(`<Steps><Step state="done">a</Step></Steps>`)).claimsDone === false); // status=working wins
  assert.ok(summarize(canvas(`<Steps><Step state="done">a</Step></Steps>`, "waiting")).claimsDone);
  assert.ok(summarize(canvas(`<Bluf>All done, PR is up.</Bluf>`)).claimsDone);
  assert.ok(!summarize(canvas(`<Bluf>Not done yet.</Bluf>`)).claimsDone);
  assert.ok(!summarize(canvas(`<Bluf>Abandoned.</Bluf><Steps><Step state="active">a</Step></Steps>`, "waiting")).claimsDone);
});

test("stale: running with many calls or minutes since the last update", () => {
  assert.deepEqual(codes(checkHonesty(WORKING, facts({ toolCallsSinceUpdate: 8 }))), ["stale"]);
  assert.deepEqual(codes(checkHonesty(WORKING, facts({ canvasUpdatedAt: NOW - 181_000 }))), ["stale"]);
  assert.deepEqual(codes(checkHonesty(WORKING, facts({ toolCallsSinceUpdate: 7 }))), []);
  assert.equal(checkHonesty(WORKING, facts({ toolCallsSinceUpdate: 9 })).label, "Stale");
});

test("error and closed dim the canvas", () => {
  const e = checkHonesty(WORKING, facts({ runState: "error" }));
  assert.ok(e.dim);
  assert.equal(e.label, "Error");
  assert.deepEqual(codes(e), ["agent-error"]);
  assert.ok(checkHonesty(DONE, facts({ runState: "closed" })).dim);
});

test("idle with unfinished steps is flagged", () => {
  assert.deepEqual(codes(checkHonesty(WORKING, facts({ runState: "idle" }))), ["idle-unfinished"]);
});

test("an open Ask is Needs you only when the agent is idle", () => {
  const ASK = canvas(`<Ask id="q" question="Which?"><Option value="a">A</Option></Ask>`);
  const running = checkHonesty(ASK, facts());
  assert.equal(running.needsYou, false);
  assert.deepEqual(codes(running), ["ask-pending"]);
  const idle = checkHonesty(ASK, facts({ runState: "idle" }));
  assert.equal(idle.needsYou, true);
  assert.equal(idle.label, "Needs you");
  assert.deepEqual(codes(idle), ["needs-you"]); // and no idle-unfinished noise
  const answered = canvas(`<Ask id="q" question="Which?" answer="a"><Option value="a">A</Option></Ask>`);
  assert.equal(checkHonesty(answered, facts({ runState: "idle" })).needsYou, false);
});

test("an auto canvas is never accused of lying", () => {
  const auto = autoCanvas("Agent", [{ kind: "tool", label: "Shell: ls", status: "running" }], true);
  assert.deepEqual(codes(checkHonesty(auto, facts({ canvasUpdatedAt: null, toolCallsSinceUpdate: 50 }))), []);
});

test("auto canvas from a timeline: todo wins, else recent tools", () => {
  const withTodo = autoCanvas("A", [
    { kind: "user", text: "do it" },
    { kind: "todo", items: [{ text: "one", status: "completed" }, { text: "two", status: "in_progress" }, { text: "three", status: "pending" }] },
  ], true);
  assert.deepEqual(withTodo.children.find((c) => c.tag === "Steps")!.children.map((s) => s.attrs.state), ["done", "active", "pending"]);
  assert.match(withTodo.children[0].text, /Task: do it/);
  const tools = autoCanvas("A", [
    { kind: "tool", label: "Edit a.ts", status: "completed", file: "a.ts" },
    { kind: "tool", label: "Shell: npm test", status: "running" },
    { kind: "assistant", text: "Running the tests now" },
  ], true);
  assert.deepEqual(tools.children.find((c) => c.tag === "Steps")!.children.map((s) => s.attrs.state), ["done", "active"]);
  assert.equal(tools.children[0].text, "Running the tests now");
  assert.equal(tools.children.find((c) => c.id === "auto-files")!.attrs.value, "1");
  assert.equal(autoCanvas(null, [], false).children[0].text, "No activity yet.");
});
