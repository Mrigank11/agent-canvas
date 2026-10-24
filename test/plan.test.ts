import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCanvas } from "../shared/canvas.ts";
import type { CanvasView } from "../shared/contract.ts";
import { planBlock, planBlocks, rowPlan, selfStatus, statusPlan } from "../shared/plan.ts";

export const SHOWCASE = `<Canvas title="Block showcase" status="working">
  <Bluf>All blocks, once.</Bluf>
  <Steps id="s" title="Plan"><Step state="done">One</Step><Step state="active">Two</Step><Step state="pending">Three</Step><Step state="failed">Four</Step><Step state="skipped">Five</Step></Steps>
  <Progress id="p" value={100} label="Upload" />
  <Metric label="Passing" value="42/42" tone="success" /><Metric label="Latency" value="480ms ▲ +12%" tone="warn" /><Metric label="Errors" value="0" />
  <Decision title="Runtime" chosen="Node">Fewer moving parts.</Decision>
  <Ask id="q" question="Which database?"><Option value="pg">Postgres</Option><Option value="ddb">DynamoDB</Option></Ask>
  <Diff file="src/a.ts">@@ -1 +1 @@
-const a = 1;
+const a = 2;
 keep</Diff>
  <Chart kind="line" title="Weekly" data="mon:3,tue:5" />
  <Svg id="pipe" alt="Pipeline"><svg viewBox="0 0 160 40"><rect x="2" y="8" width="60" height="24" rx="4" fill="none" stroke="#36c"/><text x="12" y="25">build</text></svg></Svg>
  <Image id="shot" src="out/shot.png" alt="Screenshot" />
  <Table cols="Option|Latency|Cost"><Row>Postgres|4 ms|$25/mo</Row><Row>DynamoDB|2 ms|$40/mo</Row></Table>
  <Link href="https://paseo.sh">Paseo</Link>
  <Note tone="warn">Careful.</Note><Note tone="success">Fine.</Note>
  <Code lang="sh">echo hi</Code>
  <Grid id="g" cols={2}><Metric label="Left" value="1" /><Collapse id="c" title="Details" open><Bluf>Inside</Bluf></Collapse></Grid>
</Canvas>`;

export const showcaseTree = () => { const r = parseCanvas(SHOWCASE); assert.ok(r.ok); return r.ok ? r.root : (null as never); };
export const viewOf = (tree = showcaseTree(), o: Partial<CanvasView> = {}): CanvasView => ({ agentId: "a1", workspaceId: "w1", title: "Block showcase", tree, auto: false, updatedAt: 1000, callsAtUpdate: 0, callsNow: 0, runState: "running", currentTool: null, background: [], activity: null, recent: [], lastActivityAt: 1000, url: "http://x/a/a1", agentUrl: null, ...o });

test("a canvas plans to one entry per block, with runs of metrics merged", () => {
  const plans = planBlocks(showcaseTree());
  assert.deepEqual(plans.map((p) => p.kind), ["bluf", "steps", "progress", "metrics", "decision", "ask", "diff", "svg", "svg", "image", "markdown", "markdown", "markdown", "markdown", "markdown", "grid"]);
  assert.equal(plans.find((p) => p.kind === "metrics" && p.items.length === 3) !== undefined, true);
});

test("steps carry their glyph, signal, ticks and done count", () => {
  const s = planBlocks(showcaseTree()).find((p) => p.kind === "steps");
  assert.ok(s && s.kind === "steps");
  assert.deepEqual(s.rows.map((r) => [r.glyph, r.signal]), [["✓", "ok"], ["●", "run"], ["○", "idle"], ["✕", "err"], ["–", "idle"]]);
  assert.deepEqual([s.count, s.ticks.length, s.label], ["1/5", 5, "Plan"]);
});

test("progress turns ok at 100 percent, metrics carry tone and delta, tables mark best cells", () => {
  const plans = planBlocks(showcaseTree());
  const prog = plans.find((p) => p.kind === "progress");
  assert.deepEqual(prog && prog.kind === "progress" && [prog.signal, prog.text], ["ok", "100%"]);
  const m = plans.find((p) => p.kind === "metrics");
  assert.ok(m && m.kind === "metrics");
  assert.deepEqual(m.items.map((i) => i.valueSignal), ["ok", "warn", null]);
  assert.deepEqual([m.items[1].head, m.items[1].delta?.signal], ["480ms", "err"]); // a rise on a warn metric is bad
  const t = plans.flatMap((p) => (p.kind === "markdown" ? p.blocks : [])).find((b) => b.k === "table");
  assert.ok(t && t.k === "table"); // the retired <Table> is a Markdown table now, with the same best-cell rule
  assert.deepEqual(t.rows.flatMap((r, ri) => r.flatMap((c, ci) => (c.best ? [`${ri}:${ci}`] : []))), ["0:2", "1:1"]);
  assert.deepEqual(t.numeric, [false, true, true]);
});

test("diff counts, answered asks collapse to the chosen label, notes carry glyph and signal", () => {
  const plans = planBlocks(showcaseTree());
  const d = plans.find((p) => p.kind === "diff");
  assert.deepEqual(d && d.kind === "diff" && [d.add, d.del], [1, 1]);
  const ask = plans.find((p) => p.kind === "ask");
  assert.ok(ask && ask.kind === "ask");
  assert.equal(ask.answered, null);
  const answered = planBlock({ ...showcaseTree().children.find((c) => c.tag === "Ask")!, attrs: { question: "Q?", answer: "ddb" } });
  assert.deepEqual(answered && answered.kind === "ask" && answered.answered, "DynamoDB");
  const alerts = plans.flatMap((p) => (p.kind === "markdown" ? p.blocks : [])).flatMap((b) => (b.k === "alert" ? [[b.glyph, b.signal]] : []));
  assert.deepEqual(alerts, [["!", "warn"], ["✓", "ok"]]); // <Note> became an alert
});

test("the status line leads with the question, lists facts, and gives each flag its own line", () => {
  const ask = parseCanvas(`<Canvas title="t"><Ask id="q" question="Q?"><Option value="a">A</Option></Ask></Canvas>`);
  assert.ok(ask.ok);
  const idle = statusPlan(viewOf(ask.ok ? ask.root : (null as never), { runState: "idle" }), 5000);
  assert.deepEqual([idle.signal, idle.label, idle.lead, idle.flags.length], ["hot", "Needs you", "Waiting for your answer", 0]);
  const doneTree = parseCanvas(`<Canvas title="t" status="done"><Bluf>All done.</Bluf></Canvas>`);
  assert.ok(doneTree.ok);
  const lying = statusPlan(viewOf(doneTree.ok ? doneTree.root : (null as never), { callsNow: 5, currentTool: "Shell: sleep 10" }), 5000);
  assert.deepEqual([lying.signal, lying.flags.map((f) => [f.signal, f.glyph])], ["warn", [["warn", "!"]]]);
  assert.equal(lying.facts[0].text, "running Shell: sleep 10");
  assert.equal(lying.run, "Paseo: running");
});

test("the agent's own status turns warning-coloured when the verdict contradicts it", () => {
  const done = parseCanvas(`<Canvas title="t" status="done"><Bluf>x</Bluf></Canvas>`);
  assert.ok(done.ok);
  const v = viewOf(done.ok ? done.root : (null as never));
  assert.deepEqual(selfStatus(v, "Disputed"), { text: "done", contradicted: true });
  assert.deepEqual(selfStatus(v, "Done"), { text: "done", contradicted: false });
  assert.deepEqual(selfStatus({ ...v, auto: true }, "Idle"), { text: "auto canvas", contradicted: false });
});

test("a row plan names the verdict, keeps the needs-you fill, and carries ticks", () => {
  const r = rowPlan(viewOf(undefined, { runState: "idle" }), 5000);
  assert.equal(r.ticks.length, 5);
  assert.equal(r.needsYou, true); // the showcase has an open question and the agent is idle
  assert.equal(r.signal, "hot");
  assert.equal(r.label, "Needs you");
});

test("the status line never prints more than one line, whatever the view carries", () => {
  const long = `Shell: cat > /tmp/c.tsx <<'EOF'\n${"line\n".repeat(40)}curl -s http://x`;
  const p = statusPlan(viewOf(undefined, { currentTool: long }), 5000);
  const run = p.facts.find((f) => f.signal === "run")!;
  assert.doesNotMatch(run.text, /\n/);
  assert.ok(run.text.length <= "running ".length + 80);
});
