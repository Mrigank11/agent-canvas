import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BG_EXIT_CODE, BG_MONITOR_STARTED, BG_SHELL_STARTED, classifyJob, parseExitCode } from "../shared/ui-spec.ts";
import { backgroundPlan, rowPlan, statusPlan } from "../shared/plan.ts";
import { pillState } from "../shared/pill.ts";
import type { BgJob, CanvasView } from "../shared/contract.ts";
import { renderCanvas, renderIndex } from "../server/html.ts";
import { Hub, parseJobStart, parseNotification } from "../server/hub.ts";
import { parseCanvas } from "../shared/canvas.ts";
import { viewOf } from "./plan.test.ts";

const src = (f: string) => readFileSync(new URL(`../${f}`, import.meta.url).pathname, "utf8");
const MIN = 60_000;
const NOW = 100 * MIN;

// ---------- Claude Code's wording, pinned ----------

const SHELL_RESULT = "Command running in background with ID: bzevfms0z. Output is being written to: /tmp/claude-1000/-home-x/abc/tasks/bzevfms0z.output";
const MONITOR_RESULT = "Monitor started (task bcjdw4r2l, expires in 30m unless the source ends first; you get one notice at expiry — re-arm if you still need the watch). You will be notified on each event. Keep working — do not poll or sleep.";

test("the two start patterns and the exit-code pattern match Claude Code's real result text", () => {
  assert.equal(BG_SHELL_STARTED.exec(SHELL_RESULT)?.[1], "bzevfms0z");
  assert.equal(BG_MONITOR_STARTED.exec(MONITOR_RESULT)?.[1], "bcjdw4r2l");
  assert.equal(BG_MONITOR_STARTED.exec(MONITOR_RESULT)?.[2], "30m");
  assert.equal(BG_MONITOR_STARTED.exec("Monitor started (task bvqa5c1eg, expires in 28m 20s)")?.[2], "28m 20s");
  assert.equal(BG_SHELL_STARTED.exec("Command finished with exit code 0"), null);
  assert.equal(parseExitCode('Background command "npm test" completed (exit code 0)'), 0);
  assert.equal(parseExitCode('Background command "pytest" failed with exit code 1 (exit code 1)'), 1);
  assert.equal(parseExitCode('Background command "x" was stopped'), null);
  assert.equal(parseExitCode(undefined), null);
  assert.ok(BG_EXIT_CODE.test("(exit code -9)"));
});

// ---------- the hub reads jobs from the timeline ----------

type Item = Record<string, unknown>;
const launch = (callId: string, command: string, output = SHELL_RESULT): Item => ({ type: "tool_call", callId, name: "Bash", status: "completed", detail: { type: "shell", command, output, exitCode: 0 } });
const monitor = (callId: string, description: string, output = MONITOR_RESULT): Item => ({ type: "tool_call", callId, name: "Monitor", status: "completed", detail: { type: "unknown", input: { description, command: "tail -f deploy.log" }, output } });
const note = (callId: string, toolUseId: string | undefined, taskId: string, status: string | undefined, summary: string, text?: string): Item => ({
  type: "tool_call", callId, name: "task_notification", status: status === "failed" ? "failed" : "completed", error: null,
  detail: { type: "plain_text", label: summary, icon: "wrench", ...(text ? { text } : {}) },
  metadata: { synthetic: true, source: "claude_task_notification", taskId, ...(toolUseId ? { toolUseId } : {}), ...(status ? { status } : {}) },
});
const done = (callId: string, toolUseId: string, taskId: string, command: string, code: number, status = "completed") => note(callId, toolUseId, taskId, status, `Background command "${command}" ${status === "completed" ? "completed" : "failed"} (exit code ${code})`);

function setup(items: Item[], runState = "idle", at = NOW) {
  const st = { items, runState, clock: at };
  const api = { agents: { list: async () => ({ entries: [] }), ref: (id: string) => ({ send: async () => {}, current: () => ({ id, labels: {} }), timeline: { append: async () => ({}), refetch: async () => ({ agent: { status: st.runState, title: "A", updatedAt: new Date(st.clock - 30_000).toISOString() }, window: { maxSeq: 1 }, entries: st.items.map((item, i) => ({ item, seqStart: i })) }) } }) } } as never;
  const h = new Hub({ log: () => {}, stateFile: null, publicBase: "http://h", localBase: "http://l", policy: () => ({ defaultOn: true, autoCanvas: true }), now: () => st.clock });
  h.capture({ paseo: api }, "t");
  h.noteAgent("a1", "x");
  return { st, h };
}
const jobs = (h: Hub) => h.view("a1")!.background;

test("a launch opens a job, stamped first-seen; a lower bound when the agent was already running it", async () => {
  const { h } = setup([launch("c1", "npm test -- --run")]);
  await h.refresh("a1");
  const [j] = jobs(h);
  assert.deepEqual([j.id, j.kind, j.state, j.command, j.startedAt, j.approx], ["bzevfms0z", "shell", "running", "npm test -- --run", NOW, true]);
  h.stop();
});

test("a job launched after the first read is exact, and keeps its start time", async () => {
  const { h, st } = setup([]);
  await h.refresh("a1");
  st.items.push(launch("c1", "make build"));
  st.clock += 5000;
  await h.refresh("a1");
  st.clock += 20_000;
  await h.refresh("a1");
  const [j] = jobs(h);
  assert.equal(j.startedAt, NOW + 5000);
  assert.equal(j.approx, undefined);
  h.stop();
});

test("the notification closes the job by toolUseId, with the exit code from the summary", async () => {
  const { h, st } = setup([]);
  await h.refresh("a1");
  st.items.push(launch("c1", "pytest tests/"), launch("c2", "npm test"));
  st.clock += 1000;
  await h.refresh("a1");
  st.clock += 4 * MIN;
  st.items.push(done("n1", "c1", "bzevfms0z", "pytest tests/", 1, "failed"));
  await h.refresh("a1");
  const j = jobs(h).find((x) => x.command === "pytest tests/")!;
  assert.deepEqual([j.state, j.exitCode, j.endedAt], ["failed", 1, st.clock]);
  assert.equal(jobs(h).find((x) => x.command === "npm test")!.state, "running"); // the other job is untouched
  h.stop();
});

test("a clean exit is done, a non-zero exit under 'completed' is failed, killed and stopped are killed", async () => {
  const { h, st } = setup([]);
  await h.refresh("a1");
  const mk = (n: number) => launch(`c${n}`, `cmd${n}`, `Command running in background with ID: t${n}. Output`);
  st.items.push(mk(1), mk(2), mk(3), mk(4));
  await h.refresh("a1");
  st.items.push(done("n1", "c1", "t1", "cmd1", 0), done("n2", "c2", "t2", "cmd2", 2), note("n3", "c3", "t3", "killed", 'Background command "cmd3" was stopped'), note("n4", "c4", "t4", "stopped", 'Background command "cmd4" was stopped'));
  await h.refresh("a1");
  const by = Object.fromEntries(jobs(h).map((j) => [j.command, j]));
  assert.deepEqual([by.cmd1.state, by.cmd1.exitCode], ["done", 0]);
  assert.deepEqual([by.cmd2.state, by.cmd2.exitCode], ["failed", 2]);
  assert.deepEqual([by.cmd3.state, by.cmd3.exitCode], ["killed", undefined]);
  assert.equal(by.cmd4.state, "killed");
  h.stop();
});

test("a Monitor counts its events (notifications with no status), is idempotent over refetches, and closes on a status", async () => {
  const { h, st } = setup([]);
  await h.refresh("a1");
  st.items.push(monitor("m1", "deploy logs"));
  await h.refresh("a1");
  st.items.push(note("e1", "m1", "bcjdw4r2l", undefined, 'Monitor event: "deploy logs"', "<task-notification>\n<event>build 812 queued</event>\n</task-notification>"), note("e2", "m1", "bcjdw4r2l", undefined, 'Monitor event: "deploy logs"', "<event>build 812 started</event>"));
  await h.refresh("a1");
  await h.refresh("a1");
  let [j] = jobs(h);
  assert.deepEqual([j.kind, j.description, j.expires, j.state, j.events, j.lastEvent], ["monitor", "deploy logs", "30m", "running", 2, "build 812 started"]);
  st.items.push(note("e3", "m1", "bcjdw4r2l", "completed", 'Monitor "deploy logs" ended'));
  await h.refresh("a1");
  [j] = jobs(h);
  assert.equal(j.state, "done");
  h.stop();
});

test("a finish whose start was not recognised still shows, as a finished job, with the command recovered from the summary", async () => {
  const { h } = setup([note("n1", "toolu_x", "tz9", "completed", 'Background command "make deploy" completed (exit code 0)')]);
  await h.refresh("a1");
  const [j] = jobs(h);
  assert.deepEqual([j.unrecognised, j.state, j.command, j.exitCode], [true, "done", "make deploy", 0]);
  h.stop();
});

test("a changed start wording opens nothing and breaks nothing", async () => {
  const { h } = setup([launch("c1", "make", "Started task bzevfms0z in the background")]);
  await h.refresh("a1");
  assert.deepEqual(jobs(h), []);
  h.stop();
});

test("jobs still running when the agent errors or closes are lost: no notification will come", async () => {
  const { h, st } = setup([launch("c1", "make")]);
  await h.refresh("a1");
  st.runState = "error";
  st.clock += 1000;
  await h.refresh("a1");
  assert.equal(jobs(h)[0].state, "lost");
  h.stop();
});

test("only Claude's wording is read: a plain shell result, the canvas's own calls and a running call open no job", () => {
  assert.equal(parseJobStart({ type: "tool_call", callId: "c", name: "Bash", status: "completed", error: null, detail: { type: "shell", command: "ls", output: "a b" } } as never), null);
  assert.equal(parseJobStart({ ...launch("c", "x"), status: "running" } as never), null);
  assert.deepEqual(parseJobStart(launch("c", "sleep 99") as never), { id: "bzevfms0z", kind: "shell", command: "sleep 99", description: undefined });
  assert.equal(parseNotification(note("n", "t", "k", "failed", "s") as never).status, "failed");
});

test("an idle agent with a running job is still polled, so the finish is seen", async () => {
  const { h, st } = setup([launch("c1", "make")]);
  await h.refresh("a1");
  const seen: number[] = [];
  const refetch = (h as unknown as { refresh: (id: string) => Promise<void> }).refresh.bind(h);
  (h as unknown as { refresh: (id: string) => Promise<void> }).refresh = async (id) => { seen.push(1); await refetch(id); };
  st.clock += 10 * MIN; // long past "recently active"
  await (h as unknown as { tick: () => Promise<void> }).tick();
  assert.equal(seen.length, 1);
  h.stop();
});

// ---------- the rows and the chip ----------

const job = (o: Partial<BgJob> = {}): BgJob => ({ id: "j1", kind: "shell", command: "npm test -- --run", state: "running", startedAt: NOW - 48_000, ...o });
const withJobs = (background: BgJob[], o: Partial<CanvasView> = {}) => viewOf(undefined, { runState: "idle", lastActivityAt: NOW - MIN, background, ...o });

test("running jobs come first, oldest first; finished ones follow, newest first, and drop off after ten minutes", () => {
  const v = withJobs([job({ id: "d1", state: "done", exitCode: 0, endedAt: NOW - 2 * MIN, command: "make build" }), job({ id: "r2", startedAt: NOW - 10_000 }), job({ id: "r1", startedAt: NOW - 90_000 }), job({ id: "old", state: "done", endedAt: NOW - 11 * MIN })]);
  const p = backgroundPlan(v, NOW, 9)!;
  assert.deepEqual(p.rows.map((r) => r.id), ["r1", "r2", "d1"]);
  assert.equal(p.count, "2 running");
  assert.deepEqual([p.rows[0].elapsed, p.rows[0].tone, p.rows[0].label], ["1m 30s", "run", "Running tests"]);
  assert.deepEqual([p.rows[2].elapsed, p.rows[2].tone, p.rows[2].label], ["exit 0 · 2m 0s ago", "ok", "Ran make"]);
  assert.equal(backgroundPlan(withJobs([job({ state: "done", endedAt: NOW - 11 * MIN })]), NOW), null);
  assert.equal(backgroundPlan(withJobs([]), NOW), null);
});

test("the cap folds the rest into '+n more'", () => {
  const v = withJobs([job({ id: "a" }), job({ id: "b", startedAt: NOW - 5000 }), job({ id: "c", kind: "monitor", command: "tail -f x", description: "deploy logs", startedAt: NOW - 4000 })]);
  assert.equal(backgroundPlan(v, NOW, 3)!.more, null);
  const two = backgroundPlan(v, NOW, 2)!;
  assert.equal(two.rows.length, 2);
  assert.equal(two.more, "+1 more · deploy logs");
});

test("a job that is a lower bound reads '≥', a failure is the err row with its exit code, a lost job is quiet", () => {
  const p = backgroundPlan(withJobs([job({ approx: true, startedAt: NOW - 3 * MIN }), job({ id: "f", state: "failed", exitCode: 1, endedAt: NOW - 5 * MIN, command: "pytest tests/", startedAt: 0 }), job({ id: "l", state: "lost", endedAt: NOW - MIN, command: "sleep 99" })]), NOW, 9)!;
  assert.equal(p.rows[0].elapsed, "≥ 3m 0s");
  const f = p.rows.find((r) => r.id === "f")!;
  assert.deepEqual([f.tone, f.elapsed], ["err", "exit 1 · 5m 0s ago"]);
  assert.deepEqual([p.rows.find((r) => r.id === "l")!.tone, p.rows.find((r) => r.id === "l")!.elapsed], ["idle", "lost · 1m 0s ago"]);
});

test("a Monitor row says what it watches, when it expires and how many events came", () => {
  const r = backgroundPlan(withJobs([job({ kind: "monitor", command: "tail -f deploy.log", description: "deploy logs", expires: "26m", events: 2, lastEvent: "build 812 started" })]), NOW)!.rows[0];
  assert.deepEqual([r.label, r.target, r.extra, r.lastEvent, r.icon], ["Watching “deploy logs”", "Monitor · expires in 26m", "2 events", "build 812 started", "Eye"]);
  assert.equal(classifyJob({ kind: "monitor", command: "", description: "x" }).past, "Watched “x”");
});

test("the agent's own canvas curl is bookkeeping and is not listed as a job", () => {
  assert.equal(backgroundPlan(withJobs([job({ command: "curl -s -X POST http://127.0.0.1:6790/api/canvas/a1 --data-binary @c.tsx" })]), NOW), null);
});

test("the compact chip: failed beats running beats lost beats done", () => {
  const chip = (b: BgJob[]) => backgroundPlan(withJobs(b), NOW)!.chip;
  assert.deepEqual(chip([job(), job({ id: "b" })]), { tone: "run", glyph: "⟳", text: "2 in background" });
  assert.deepEqual(chip([job({ state: "done", endedAt: NOW - MIN })]), { tone: "ok", glyph: "✓", text: "1 job done" });
  assert.deepEqual(chip([job(), job({ id: "f", state: "failed", endedAt: NOW - MIN })]), { tone: "err", glyph: "✕", text: "1 job failed" });
  assert.equal(chip([job({ state: "lost", endedAt: NOW })]).text, "1 job lost");
});

// ---------- the verdict ----------

const verdict = (v: CanvasView) => statusPlan(v, NOW);
const WORKING = `<Canvas title="t" status="working"><Bluf>Building.</Bluf></Canvas>`;
const DONE = `<Canvas title="t" status="done"><Bluf>All done.</Bluf></Canvas>`;
const tree = (s: string) => { const r = parseCanvas(s); assert.ok(r.ok); return r.ok ? r.root : (null as never); };

test("an idle agent with a running job is Waiting, never Stale, and the pill says so", () => {
  const v = withJobs([job(), job({ id: "b", kind: "monitor", command: "", description: "deploy logs" })], { updatedAt: NOW - 20 * MIN, callsNow: 30, tree: tree(WORKING) });
  const p = verdict(v);
  assert.deepEqual([p.label, p.signal, p.lead, p.leadSignal], ["Waiting", "run", "Waiting on 2 background jobs", "run"]);
  assert.equal(pillState(v, NOW).label, "Waiting · 2");
  assert.equal(statusPlan(withJobs([job()], { tree: tree(WORKING) }), NOW).lead, "Waiting on 1 background job");
});

test("waiting on a job is not 'idle but unfinished': the open steps are expected", () => {
  const p = verdict(withJobs([job()], { tree: tree(`<Canvas title="t" status="working"><Steps title="s"><Step state="active">Build</Step><Step state="pending">Report</Step></Steps></Canvas>`) }));
  assert.deepEqual([p.label, p.flags], ["Waiting", []]);
});

test("a running agent with a job is simply Working; Needs you outranks Waiting", () => {
  assert.equal(verdict(withJobs([job()], { runState: "running", tree: tree(WORKING), updatedAt: NOW - MIN })).label, "Working");
  const ask = tree(`<Canvas title="t" status="working"><Ask id="q" question="Which?"><Option value="a">A</Option></Ask></Canvas>`);
  assert.deepEqual([verdict(withJobs([job()], { tree: ask })).label, verdict(withJobs([job()], { tree: ask })).leadSignal], ["Needs you", "hot"]);
});

test("a canvas that says done while a job runs is Disputed, with a flag", () => {
  const p = verdict(withJobs([job()], { tree: tree(DONE) }));
  assert.equal(p.label, "Disputed");
  assert.deepEqual(p.flags.map((f) => f.text), ["Canvas says done, but 1 background job is still running."]);
});

test("a failed or killed job the canvas has not caught up with is Disputed, naming the job and its exit code", () => {
  const failed = job({ id: "f", state: "failed", exitCode: 1, command: "pytest tests/", endedAt: NOW - 5 * MIN });
  const p = verdict(withJobs([failed], { tree: tree(WORKING), updatedAt: NOW - 6 * MIN }));
  assert.equal(p.label, "Disputed");
  assert.deepEqual([p.flags[0].signal, p.flags[0].text], ["warn", "A background job (pytest) failed, exit 1, but the canvas still says working."]);
  assert.match(verdict(withJobs([{ ...failed, state: "killed", exitCode: undefined }], { tree: tree(DONE), updatedAt: NOW - 6 * MIN })).flags[0].text, /\(pytest\) was killed, but the canvas still says done/);
});

test("once the agent updates its canvas after the failure, or says blocked, the failure is no longer disputed", () => {
  const failed = job({ id: "f", state: "failed", exitCode: 1, command: "pytest tests/", endedAt: NOW - 5 * MIN });
  assert.equal(verdict(withJobs([failed], { tree: tree(WORKING), updatedAt: NOW - MIN })).label, "Idle");
  assert.equal(verdict(withJobs([failed], { tree: tree(`<Canvas title="t" status="blocked"/>`), updatedAt: NOW - 6 * MIN })).label, "Idle");
});

test("a job that finished while the agent was idle is said once, until the agent wakes", () => {
  const fin = job({ state: "done", exitCode: 0, endedAt: NOW - 2 * MIN });
  const p = verdict(withJobs([fin], { tree: tree(WORKING), lastActivityAt: NOW - 3 * MIN }));
  assert.equal(p.label, "Idle");
  assert.equal(p.facts[0].text, "Background job finished 2m 0s ago · agent will pick it up");
  assert.ok(!verdict(withJobs([fin], { tree: tree(WORKING), lastActivityAt: NOW - MIN })).facts.some((f) => /pick it up/.test(f.text)));
});

test("an agent that errors or closes with jobs open: Error or Closed, and the jobs read as lost", () => {
  const v = withJobs([job()], { runState: "error", tree: tree(WORKING) });
  assert.equal(verdict(v).label, "Error");
  assert.equal(verdict(v).background!.rows[0].state, "lost");
  assert.equal(verdict(withJobs([job()], { runState: "closed" })).label, "Closed");
  assert.equal(statusPlan(withJobs([job()], { runState: "idle" }), NOW, "error").background!.rows[0].state, "lost"); // the live value from Paseo wins
});

test("a canvas with no jobs behaves exactly as before", () => {
  const p = verdict(withJobs([], { tree: tree(WORKING) }));
  assert.deepEqual([p.label, p.background, p.lead], ["Idle", null, null]);
});

// ---------- one plan, two renderers ----------

const has = (html: string, s: string) => assert.ok(html.includes(s), `HTML is missing ${s}`);

test("the browser draws the same rows, group, lead, flag and chip as the plan", () => {
  const v = withJobs([job(), job({ id: "m", kind: "monitor", command: "tail", description: "deploy logs", events: 2, expires: "26m", startedAt: NOW - 5000 }), job({ id: "f", state: "failed", exitCode: 1, command: "pytest tests/", endedAt: NOW - 5 * MIN })], { tree: tree(WORKING), updatedAt: NOW - 6 * MIN });
  const plan = statusPlan(v, NOW);
  const html = renderCanvas(v, NOW);
  for (const r of plan.background!.rows) { has(html, `now job ${r.tone}`); has(html, r.label.replace("“", "“")); has(html, r.elapsed); if (r.extra) has(html, r.extra); if (r.target) has(html, r.target.replace(/&/g, "&amp;")); }
  has(html, 'class="bg"'); has(html, "Background"); has(html, plan.background!.count);
  has(html, "sd spin run"); // the running rows spin
  assert.equal((html.match(/sd spin run/g) ?? []).length, 2);
  has(html, plan.lead ?? "—"); has(html, `badge ${plan.signal}`); has(html, plan.label);
  for (const f of plan.flags) { has(html, `flag ${f.signal}`); has(html, f.text); }
});

test("the browser folds the cap into '+n more', and the Canvases list carries the chip", () => {
  const many = withJobs([job({ id: "a" }), job({ id: "b", startedAt: NOW - 5000 }), job({ id: "c", startedAt: NOW - 4000 }), job({ id: "d", startedAt: NOW - 3000 })], { tree: tree(WORKING) });
  const html = renderCanvas(many, NOW);
  has(html, "+1 more"); has(html, "+2 more"); // wide and phone
  const idx = renderIndex([many], NOW);
  const chip = rowPlan(many, NOW).jobs!;
  has(idx, `chip ${chip.tone} jobchip`); has(idx, chip.text);
  assert.ok(!renderIndex([withJobs([], { tree: tree(WORKING) })], NOW).includes("jobchip"));
});

test("a failed row shows the exit code and opens to the full command", () => {
  const v = withJobs([job({ id: "f", state: "failed", exitCode: 1, command: "pytest tests/\n--maxfail=1", endedAt: NOW - 5 * MIN })]);
  const html = renderCanvas(v, NOW);
  has(html, "exit 1 · 5m 0s ago"); has(html, "now job err"); has(html, "<details"); has(html, "--maxfail=1");
});

test("the native client has the same rows, group, chip and spinner from the same plan", () => {
  const atoms = src("client/ui/atoms.tsx");
  for (const s of ['variant="job"', "function JobRow", "export function JobGroup", "export function JobChip", "export function Spinner", "plan.background", "plan.leadSignal"]) assert.ok(atoms.includes(s), s);
  assert.ok(src("client/pill.tsx").includes("<JobGroup plan={plan.background}"), "popover");
  assert.ok(src("client/pill.tsx").includes("BG_CAP.popover"), "popover cap");
  assert.ok(src("client/timeline.tsx").includes("<JobChip chip={plan.background.chip}"), "timeline card chip");
  assert.ok(src("client/screens.tsx").includes("<JobChip chip={plan.jobs}"), "Canvases list chip");
  assert.ok(src("client/canvas.tsx").includes("BG_CAP.phone"), "phone cap");
  for (const f of ["client/ui/atoms.tsx", "server/ui-html.ts"]) assert.ok(src(f).includes("spin"), `${f} spinner`);
});
