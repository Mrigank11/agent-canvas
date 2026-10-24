import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ACTIVITY_ICONS, LAST_VISIBLE_MS, classifyActivity, type ActivityCall } from "../shared/ui-spec.ts";
import { activityPlan, statusPlan } from "../shared/plan.ts";
import { ICON_SVG, activityRow } from "../server/ui-html.ts";
import { Hub, rawCall } from "../server/hub.ts";
import { viewOf } from "./plan.test.ts";

const sh = (command: string) => classifyActivity({ kind: "shell", name: "Bash", command });
const heredoc = (n: number) => `python3 - <<'EOF'\n${"print(1)\n".repeat(n)}EOF`;

test("the rules table: first match wins, with the icon, label, past tense and target", () => {
  assert.deepEqual(sh(heredoc(23)), { icon: "SquareTerminal", label: "Running a Python script", past: "Ran a Python script", target: "python3 · 23 lines", bookkeeping: false });
  assert.equal(sh("node - <<'EOF'\nconsole.log(1)\nEOF").target, "node · 1 line");
  assert.deepEqual([sh("npm test").icon, sh("npm test").label], ["FlaskConical", "Running tests"]);
  assert.equal(sh("npm run test:unit -- --watch=false").label, "Running tests");
  assert.equal(sh("pytest -q tests/").label, "Running tests");
  assert.deepEqual([sh("git commit -m x").label, sh("git commit -m x").target], ["Git: commit", "-m x"]);
  assert.deepEqual([sh("cat > /tmp/out/c.tsx <<'EOF'\nx\nEOF").label, sh("cat > /tmp/out/c.tsx <<'EOF'\nx\nEOF").target], ["Writing c.tsx", "/tmp/out"]);
  assert.equal(sh("npm install zod").label, "Installing packages");
  assert.deepEqual([sh("sleep 7").icon, sh("sleep 7").label, sh("sleep 7").target], ["Hourglass", "Waiting 7s", null]);
});

test("unrecognised commands read 'Running <first word>' with the raw first line as the chip", () => {
  const c = sh("FOO=1 ffmpeg -i in.mov -vf scale=640:-1 out.mp4\nsecond line");
  assert.equal(c.label, "Running ffmpeg");
  assert.equal(c.target, "ffmpeg -i in.mov -vf scale=640:-1 out.mp4");
  assert.equal(sh("sleep 10; echo done").label, "Running sleep"); // sleep is only 'Waiting' when it is the whole command
  assert.equal(sh("cd /repo && make build").label, "Running make");
  assert.ok((sh("x".repeat(200)).target ?? "").length <= 60);
});

test("the agent's own canvas calls are bookkeeping, whichever way they are made", () => {
  const curl = sh(`cat > /tmp/c.tsx <<'EOF'\n<Canvas title="x"/>\nEOF\ncurl -s -X POST http://127.0.0.1:6790/api/canvas/abc --data-binary @/tmp/c.tsx`);
  assert.deepEqual([curl.label, curl.bookkeeping, curl.icon], ["Updating canvas", true, "LayoutDashboard"]);
  assert.equal(classifyActivity({ kind: "other", name: "mcp__canvas__canvas_patch" }).bookkeeping, true);
  assert.equal(sh("ls /tmp").bookkeeping, false);
});

test("file, search, fetch and other tools", () => {
  assert.deepEqual([classifyActivity({ kind: "edit", name: "Edit", path: "/r/client/ui/atoms.tsx" }).label, classifyActivity({ kind: "edit", name: "Edit", path: "/r/client/ui/atoms.tsx" }).target], ["Editing atoms.tsx", "/r/client/ui"]);
  assert.equal(classifyActivity({ kind: "write", name: "Write", path: "/r/a.ts" }).past, "Wrote a.ts");
  assert.equal(classifyActivity({ kind: "read", name: "Read", path: "/r/a.ts" }).icon, "Eye");
  assert.deepEqual([classifyActivity({ kind: "search", name: "Grep", query: "useAgent" }).label, classifyActivity({ kind: "search", name: "Grep", query: "useAgent" }).target], ["Searching", "useAgent"]);
  const f = classifyActivity({ kind: "fetch", name: "WebFetch", url: "https://paseo.sh/docs/plugins.md?x=1" });
  assert.deepEqual([f.label, f.target, f.icon], ["Fetching paseo.sh", "/docs/plugins.md?x=1", "Globe"]);
  assert.deepEqual([classifyActivity({ kind: "other", name: "mcp__paseo__create_agent" }).label, classifyActivity({ kind: "other", name: "mcp__paseo__create_agent" }).icon], ["paseo: create_agent", "Wrench"]);
});

test("every icon a rule can return is a declared one, and the browser carries an SVG for each", () => {
  const samples = [sh(heredoc(3)), sh("npm test"), sh("git status"), sh("cat > a <<'E'\nx\nE"), sh("npm i x"), sh("sleep 1"), sh("ls"), sh("curl /api/canvas/x"),
    classifyActivity({ kind: "edit", name: "e", path: "/a" }), classifyActivity({ kind: "read", name: "r", path: "/a" }), classifyActivity({ kind: "search", name: "s" }), classifyActivity({ kind: "fetch", name: "f", url: "https://a.b" }), classifyActivity({ kind: "other", name: "x" })];
  for (const s of samples) assert.ok((ACTIVITY_ICONS as readonly string[]).includes(s.icon), s.icon);
  for (const i of ACTIVITY_ICONS) assert.ok(ICON_SVG[i] && ICON_SVG[i].length > 20, i);
});

const NOW = 100_000_000;
const call = (o: Partial<ActivityCall> = {}): ActivityCall => ({ kind: "shell", name: "Bash", command: heredoc(23), startedAt: NOW - 12_000, ...o });

test("the Now row: a live call ticks from its start time and keeps the full command for the expanded state", () => {
  const p = activityPlan({ activity: call(), recent: [] }, NOW)!;
  assert.deepEqual([p.live, p.tone, p.label, p.target, p.elapsed], [true, "run", "Running a Python script", "python3 · 23 lines", "12s"]);
  assert.match(p.full!, /^python3 - <<'EOF'/);
  assert.equal(activityPlan({ activity: call(), recent: [] }, NOW + 60_000)!.elapsed, "1m 12s");
});

test("bookkeeping is grey: the idle tone, not the running blue", () => {
  const p = activityPlan({ activity: call({ command: "curl -s -X POST http://x/api/canvas/a" }), recent: [] }, NOW)!;
  assert.deepEqual([p.tone, p.bookkeeping, p.label], ["idle", true, "Updating canvas"]);
});

test("when idle it says 'Last: …' for ten minutes, then the row goes away", () => {
  const recent = [{ kind: "edit" as const, label: "Edited atoms.tsx", ok: true, endedAt: NOW - 120_000 }];
  const p = activityPlan({ activity: null, recent }, NOW)!;
  assert.deepEqual([p.live, p.tone, p.label, p.elapsed], [false, "idle", "Last: Edited atoms.tsx", "2m 0s ago"]);
  assert.equal(activityPlan({ activity: null, recent }, NOW - 120_000 + LAST_VISIBLE_MS + 1000), null);
  assert.equal(activityPlan({ activity: null, recent: [] }, NOW), null);
});

test("the trail carries the last three actions with failures marked", () => {
  const recent = [1, 2, 3].map((i) => ({ kind: "shell" as const, label: `Ran ${i}`, ok: i !== 2, exitCode: i === 2 ? 1 : 0, endedAt: NOW - i * 1000 }));
  assert.deepEqual(activityPlan({ activity: call(), recent }, NOW)!.recent, [{ label: "Ran 1", ok: true, exitCode: 0 }, { label: "Ran 2", ok: false, exitCode: 1 }, { label: "Ran 3", ok: true, exitCode: 0 }]);
});

test("line 2 loses its 'running …' fact once the Now row carries it, and keeps it for a view with no structured activity", () => {
  const withRow = statusPlan(viewOf(undefined, { currentTool: "Shell: x", activity: call(), recent: [] }), NOW);
  assert.ok(!withRow.facts.some((f) => f.text.startsWith("running")));
  assert.ok(withRow.activity);
  const old = statusPlan(viewOf(undefined, { currentTool: "Shell: x" }), NOW);
  assert.ok(old.facts.some((f) => f.text === "running Shell: x"));
});

test("the browser draws the same row: icon, label, chip, elapsed, and a disclosure with the command and the trail", () => {
  const plan = activityPlan({ activity: call(), recent: [{ kind: "shell", label: "Ran tests", ok: false, exitCode: 2, endedAt: NOW - 5000 }] }, NOW)!;
  const html = activityRow(plan);
  for (const s of ["<details", 'class="now run"', "<svg", "Running a Python script", "python3 · 23 lines", ">12s<", "Ran tests · exit 2", "print(1)"]) assert.ok(html.includes(s), s);
  const last = activityRow(activityPlan({ activity: null, recent: [{ kind: "edit", label: "Edited a.ts", ok: true, endedAt: NOW - 3000 }] }, NOW)!);
  assert.ok(last.includes("tg ring") && last.includes("Last: Edited a.ts") && last.includes("3s ago"));
  assert.ok(!activityRow({ ...plan, full: null, recent: [] }).includes("<details")); // nothing to open
});

test("the native client has the same row from the same plan", () => {
  const atoms = readFileSync(new URL("../client/ui/atoms.tsx", import.meta.url).pathname, "utf8");
  for (const s of ["export function ActivityRow", "export function ToolGlyph", "export function MonoChip", "plan.activity", "Icon name={icon}"]) assert.ok(atoms.includes(s), s);
});

// ---------- the hub stamps the times ----------

const tc = (callId: string, status: string, detail: unknown, name = "Bash") => ({ type: "tool_call", callId, name, status, detail });
function stubApi(st: { items: unknown[] }) {
  const refetch = async () => ({ agent: { status: "running", title: "A", updatedAt: new Date(1000).toISOString() }, window: { maxSeq: 1 }, entries: st.items.map((item, i) => ({ item, seqStart: i })) });
  const ref = (id: string) => ({ send: async () => {}, current: () => ({ id, labels: {} }), timeline: { append: async () => ({}), refetch } });
  return { agents: { list: async () => ({ entries: [] }), ref } } as never;
}
test("the hub stamps startedAt the first time it sees a call running, and keeps it", async () => {
  const st = { items: [tc("c1", "running", { type: "shell", command: heredoc(5) })] as unknown[] };
  const clock = { t: 5000 };
  const h = new Hub({ log: () => {}, stateFile: null, publicBase: "http://h", localBase: "http://l", policy: () => ({ defaultOn: true, autoCanvas: true }), now: () => clock.t });
  h.capture({ paseo: stubApi(st) }, "t");
  h.noteAgent("a1", "x");
  await h.refresh("a1");
  assert.equal(h.view("a1")!.activity!.startedAt, 5000);
  clock.t = 9000;
  await h.refresh("a1");
  assert.equal(h.view("a1")!.activity!.startedAt, 5000); // not restarted
  assert.match(h.view("a1")!.activity!.command!, /^python3 - <<'EOF'/);
  h.stop();
});

test("finished calls become the trail: three newest first, canvas bookkeeping left out, endedAt stamped", async () => {
  const st = { items: [
    tc("c1", "completed", { type: "edit", filePath: "/r/a.tsx" }, "Edit"),
    tc("c2", "completed", { type: "shell", command: "curl -s -X POST http://x/api/canvas/a", exitCode: 0 }),
    tc("c3", "failed", { type: "shell", command: "npm test", exitCode: 1 }),
    tc("c4", "completed", { type: "read", filePath: "/r/b.ts" }, "Read"),
    tc("c5", "completed", { type: "shell", command: "ls", exitCode: 0 }),
  ] as unknown[] };
  const clock = { t: 50_000 };
  const h = new Hub({ log: () => {}, stateFile: null, publicBase: "http://h", localBase: "http://l", policy: () => ({ defaultOn: true, autoCanvas: true }), now: () => clock.t });
  h.capture({ paseo: stubApi(st) }, "t");
  h.noteAgent("a1", "x");
  await h.refresh("a1");
  const v = h.view("a1")!;
  assert.equal(v.activity, null);
  assert.deepEqual(v.recent.map((r) => [r.label, r.ok]), [["Ran ls", true], ["Read b.ts", true], ["Ran tests", false]]);
  assert.equal(v.recent[2].exitCode, 1);
  assert.ok(v.recent.every((r) => r.endedAt <= 50_000));
  h.stop();
});

test("task notifications are not shown as actions", async () => {
  const st = { items: [tc("n1", "completed", { type: "plain_text" }, "task_notification"), tc("c1", "completed", { type: "shell", command: "ls", exitCode: 0 })] as unknown[] };
  const h = new Hub({ log: () => {}, stateFile: null, publicBase: "http://h", localBase: "http://l", policy: () => ({ defaultOn: true, autoCanvas: true }), now: () => 5000 });
  h.capture({ paseo: stubApi(st) }, "t");
  h.noteAgent("a1", "x");
  await h.refresh("a1");
  assert.deepEqual(h.view("a1")!.recent.map((r) => r.label), ["Ran ls"]);
  h.stop();
});

test("rawCall keeps the structured fields and caps a huge command", () => {
  const r = rawCall(tc("c", "running", { type: "shell", command: "x".repeat(10_000) }) as never);
  assert.equal(r.kind, "shell");
  assert.equal(r.command!.length, 4000);
  assert.deepEqual(rawCall(tc("c", "running", { type: "fetch", url: "https://a.b/c" }, "WebFetch") as never), { kind: "fetch", name: "WebFetch", url: "https://a.b/c" });
});
