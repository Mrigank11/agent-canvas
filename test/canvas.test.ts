import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCanvas, patchCanvas, serialize, findNode, chartPoints } from "../shared/canvas.ts";

const GOOD = `<Canvas title="Deploy" status="working">
  <Bluf>Archive signed. Uploading.</Bluf>
  <Steps id="s">
    <Step id="a" state="done">Project</Step>
    <Step id="b" state="active">Upload</Step>
  </Steps>
  <Progress value={40} max={100} label="upload" />
  <Ask id="q" question="Ship it?" blocking><Option value="yes">Yes</Option><Option value="no">No</Option></Ask>
  <Diff file="a.ts">
-const x = 1 < 2;
+const x = {y: 1};
  </Diff>
  <Chart kind="bar" data="a:1,b:2" />
  <Table cols="k|v"><Row>a|1</Row></Table>
  <Link href="https://example.com">docs</Link>
</Canvas>`;

const errs = (src: string) => { const r = parseCanvas(src); assert.equal(r.ok, false); return r.ok ? [] : r.errors.map((e) => e.message); };

test("parses a full canvas into a tree", () => {
  const r = parseCanvas(GOOD);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.root.attrs.title, "Deploy");
  assert.equal(findNode(r.root, "b")?.attrs.state, "active");
  assert.equal(findNode(r.root, "q")?.children.length, 2);
  assert.equal(findNode(r.root, "progress1")?.attrs.value, 40);
  assert.match(findNode(r.root, "diff1")!.text, /1 < 2/); // raw tag: no escaping needed
});

test("rejects tags outside the vocabulary, including script and html", () => {
  assert.match(errs(`<Canvas title="x"><script>alert(1)</script></Canvas>`).join(), /not in the vocabulary/);
  assert.match(errs(`<Canvas title="x"><div>hi</div></Canvas>`).join(), /not in the vocabulary/);
});

test("never evaluates expressions", () => {
  assert.match(errs(`<Canvas title="x"><Progress value={process.exit()} /></Canvas>`).join(), /expressions are never evaluated/);
  assert.match(errs(`<Canvas title={a + b}></Canvas>`).join(), /never evaluated/);
});

test("rejects bad attributes, enums, nesting, text and links", () => {
  assert.match(errs(`<Canvas title="x"><Step state="done">a</Step></Canvas>`).join(), /must be inside <Steps>|not allowed inside/);
  assert.match(errs(`<Canvas title="x"><Steps><Step state="bogus">a</Step></Steps></Canvas>`).join(), /not one of/);
  assert.match(errs(`<Canvas title="x"><Steps><Step>a</Step></Steps></Canvas>`).join(), /needs state/);
  assert.match(errs(`<Canvas title="x"><Bluf onClick="x">a</Bluf></Canvas>`).join(), /no attribute "onClick"/);
  assert.match(errs(`<Canvas title="x"><Steps>loose text</Steps></Canvas>`).join(), /cannot contain text/);
  assert.match(errs(`<Canvas title="x"><Link href="javascript:alert(1)">x</Link></Canvas>`).join(), /http/);
  assert.match(errs(`<Canvas title="x"><Chart data="nope" /></Canvas>`).join(), /Chart data/);
  assert.match(errs(`<Canvas title="x"><Ask question="q"></Ask></Canvas>`).join(), /at least one <Option>/);
});

test("structural errors: root, unclosed, mismatch, duplicate ids, limits", () => {
  assert.match(errs(`<Bluf>x</Bluf>`).join(), /root must be <Canvas>/);
  assert.match(errs(`<Canvas title="x"><Bluf>x</Canvas>`).join(), /does not match/);
  assert.match(errs(`<Canvas title="x"><Bluf>x</Bluf>`).join(), /never closed/);
  assert.match(errs(`<Canvas title="x"><Bluf id="a">x</Bluf><Note id="a">y</Note></Canvas>`).join(), /duplicate id/);
  assert.match(errs(`<Canvas title="x"><Bluf>a < b</Bluf></Canvas>`).join(), /stray "<"/);
  assert.match(errs("x".repeat(100_000)).join(), /over 96000/);
  const many = `<Canvas title="x">${"<Note>a</Note>".repeat(310)}</Canvas>`;
  assert.match(errs(many).join(), /more than 300 elements/);
  assert.match(errs(`<Canvas title="x"><Steps><Step state="done">a</Step></Steps></Canvas><Canvas title="y"></Canvas>`).join(), /only one root/);
});

test("error messages carry line numbers", () => {
  const r = parseCanvas(`<Canvas title="x">\n<Bluf>ok</Bluf>\n<Nope/>\n</Canvas>`);
  assert.ok(!r.ok);
  if (!r.ok) assert.equal(r.errors[0].line, 3);
});

test("entities and html comments", () => {
  const r = parseCanvas(`<Canvas title="a &amp; b"><!-- hi --><Bluf>x &lt; y</Bluf></Canvas>`);
  assert.ok(r.ok);
  if (r.ok) { assert.equal(r.root.attrs.title, "a & b"); assert.equal(r.root.children[0].text, "x < y"); }
});

test("serialize round-trips", () => {
  const r = parseCanvas(GOOD);
  assert.ok(r.ok);
  if (!r.ok) return;
  const again = parseCanvas(serialize(r.root));
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.root, r.root);
});

test("patch: set attrs, text, append, remove — atomically", () => {
  const r = parseCanvas(GOOD);
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = patchCanvas(r.root, [
    { id: "b", set: { state: "done" } },
    { id: "a", text: "Project created" },
    { parent: "s", append: `<Step state="active">Verify</Step>` },
    { id: "progress1", set: { value: 100 } },
    { id: "table1", remove: true },
  ]);
  assert.ok(p.ok, JSON.stringify(!p.ok && p.errors));
  if (!p.ok) return;
  assert.equal(findNode(p.root, "b")?.attrs.state, "done");
  assert.equal(findNode(p.root, "a")?.text, "Project created");
  assert.equal(findNode(p.root, "s")?.children.length, 3);
  assert.equal(findNode(p.root, "table1"), null);
  // the original is untouched
  assert.equal(findNode(r.root, "b")?.attrs.state, "active");
});

test("patch: invalid ops change nothing and say why", () => {
  const r = parseCanvas(GOOD);
  assert.ok(r.ok);
  if (!r.ok) return;
  const bad = (ops: Parameters<typeof patchCanvas>[1]) => { const p = patchCanvas(r.root, ops); assert.ok(!p.ok); return p.ok ? "" : p.errors.map((e) => e.message).join("; "); };
  assert.match(bad([{ id: "nope", set: { state: "done" } }]), /no element with id "nope"/);
  assert.match(bad([{ id: "b", set: { state: "wat" } }]), /not one of/);
  assert.match(bad([{ id: "b", set: { id: "z" } }]), /ids cannot be changed/);
  assert.match(bad([{ parent: "s", append: `<script>x</script>` }]), /not in the vocabulary/);
  assert.match(bad([{ parent: "s", append: `<Note>x</Note>` }]), /not allowed inside <Steps>/);
  assert.match(bad([{ id: "canvas1", remove: true }]), /root/);
  assert.match(bad([]), /no patch operations/);
  assert.match(bad([{ id: "a", set: { state: "done" } }, { id: "b", set: { state: "wat" } }]), /not one of/);
});

test("chartPoints", () => {
  assert.deepEqual(chartPoints("a:1,b:2.5"), [{ label: "a", value: 1 }, { label: "b", value: 2.5 }]);
  assert.equal(chartPoints("a:x"), null);
  assert.equal(chartPoints(""), null);
});
