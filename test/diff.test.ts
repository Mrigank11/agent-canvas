// <Diff> is a closed fold with a one-line summary; <Collapse> is closed unless it says open; folds are keyed so the browser keeps them open.
import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { parseCanvas } from "../shared/canvas.ts";
import { diffFiles, diffSummary, planBlocks, type BlockPlan } from "../shared/plan.ts";
import { renderBlocks } from "../server/html.ts";
import { VOCAB_DOC } from "../server/vocab-doc.ts";

const tree = (body: string) => { const r = parseCanvas(`<Canvas title="t" status="working">${body}</Canvas>`); assert.ok(r.ok, r.ok ? "" : String((r as any).errors)); return (r as any).tree ?? (r as any).root; };
const html = (body: string) => renderBlocks(tree(body), "a1");
const D2 = `diff --git a/x.ts b/x.ts
--- a/x.ts
+++ b/x.ts
@@ -1 +1 @@
-a
+b
diff --git a/y.ts b/y.ts
--- /dev/null
+++ b/y.ts
@@ -0,0 +1 @@
+c`;

test("diffSummary: one file, several files, none", () => {
  assert.equal(diffSummary(["src/app.ts"], 5, 2), "src/app.ts · +5 −2");
  assert.equal(diffSummary(["a", "b", "c"], 40, 12), "3 files · +40 −12");
  assert.equal(diffSummary([], 5, 2), "Diff · +5 −2");
  assert.equal(diffSummary([], 0, 0), "Diff · +0 −0");
});

test("diffFiles reads diff --git and +++ lines, de-duplicated, skipping /dev/null", () => {
  assert.deepEqual(diffFiles(D2), ["x.ts", "y.ts"]);
  assert.deepEqual(diffFiles("--- a/q.ts\n+++ b/q.ts\n@@ -1 +1 @@\n-a\n+b"), ["q.ts"]);
  assert.deepEqual(diffFiles("--- a/gone.ts\n+++ /dev/null\n-a"), []);
  assert.deepEqual(diffFiles("@@ -1 +1 @@\n-a\n+b"), []);
});

test("the Diff plan: the file attribute is the fallback, the body wins", () => {
  const plan = (b: string) => planBlocks(tree(b))[0] as Extract<BlockPlan, { kind: "diff" }>;
  assert.equal(plan(`<Diff file="src/a.ts">@@ -1 +1 @@\n-a\n+b\n+c</Diff>`).summary, "src/a.ts · +2 −1");
  assert.equal(plan(`<Diff file="ignored.ts">${D2}</Diff>`).summary, "2 files · +2 −1");
  assert.equal(plan(`<Diff>@@ -1 +1 @@\n+b</Diff>`).summary, "Diff · +1 −0");
});

test("a Diff renders closed, with the summary in its header and a key", () => {
  const h = html(`<Diff id="d1" file="src/a.ts">@@ -1 +1 @@\n-a\n+b</Diff>`);
  assert.match(h, /<details class="diff" data-k="d-d1"><summary>/);
  assert.doesNotMatch(h, /<details[^>]* open/);
  assert.match(h, /src\/a\.ts/);
  assert.match(h, /<span class="a">\+1<\/span> <span class="d">−1<\/span>/);
  assert.match(html(`<Diff id="d2">${D2}</Diff>`), /2 files[\s\S]*x\.ts<br>y\.ts/);
});

test("a Collapse is closed unless it says open or holds an unanswered Ask, and is keyed", () => {
  const c = (attrs: string, inner = `<Bluf>x</Bluf>`) => html(`<Collapse id="c1" title="T"${attrs}>${inner}</Collapse>`);
  assert.match(c(""), /<details class="collapse" data-k="c-c1">/);
  assert.match(c(" open"), /<details class="collapse" data-k="c-c1" open>/);
  assert.match(c("", `<Ask id="q" question="?"><Option value="a">A</Option></Ask>`), /data-k="c-c1" open>/);
  assert.match(c("", `<Ask id="q" question="?" answer="a"><Option value="a">A</Option></Ask>`), /data-k="c-c1"><summary>/);
});

test("the vocabulary no longer teaches agents to write open", () => {
  assert.doesNotMatch(VOCAB_DOC, /<Collapse title="…" open>/);
  assert.match(VOCAB_DOC, /one-line summary/);
});

const skill = readFileSync(new URL("../skill/agent-canvas/SKILL.md", import.meta.url).pathname, "utf8");

test("both docs lead with Metric, Decision and Ask, and recast Diff as code-review evidence inside a closed Collapse", () => {
  for (const doc of [VOCAB_DOC, skill]) {
    const at = (s: string) => doc.indexOf(s);
    for (const lead of ["<Metric", "<Decision", "<Ask"]) assert.ok(at(lead) > 0 && at(lead) < at("<Steps"), `${lead} comes before Steps`);
    assert.match(doc, /<Diff [^\n]*code-review evidence only, inside a <Collapse>/);
    assert.match(doc, /never in the Bluf, Steps or Metrics/);
    assert.doesNotMatch(doc, /<Collapse title="[^"]*" open>/);
  }
});

test("the SKILL.md vocabulary is VOCAB_DOC verbatim, so the two cannot drift", () => {
  assert.ok(skill.includes(VOCAB_DOC));
});

test("the example in the guidance parses and plans as a Diff inside a closed Collapse", () => {
  const [c] = planBlocks(tree(`<Collapse title="Code: the key change"><Diff file="src/app.ts">@@ -1 +1 @@\n-a\n+b</Diff></Collapse>`));
  assert.ok(c.kind === "collapse" && !c.open && c.children[0].kind === "diff");
});
