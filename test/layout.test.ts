// Grid and Collapse: parsing limits, the plan, and both renderers at compact and wide widths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LIMITS, parseCanvas, patchCanvas, serialize } from "../shared/canvas.ts";
import { planBlocks } from "../shared/plan.ts";
import { GRID_COMPACT_BELOW, gridColumns } from "../shared/ui-spec.ts";
import { renderBlocks } from "../server/html.ts";
import { COMPONENT_CSS } from "../server/ui-html.ts";

const ok = (src: string) => { const r = parseCanvas(src); assert.ok(r.ok, r.ok ? "" : r.errors.map((e) => e.message).join("; ")); return r.ok ? r.root : (null as never); };
const errs = (src: string) => { const r = parseCanvas(src); return r.ok ? [] : r.errors.map((e) => e.message); };

test("the depth limit is 5, counting Grid and Collapse", () => {
  assert.equal(LIMITS.depth, 5);
  // Canvas is depth 0, so a leaf may sit at depth 5: Grid1 Collapse2 Grid3 Collapse4 Bluf5
  ok(`<Canvas title="t"><Grid><Collapse title="a"><Grid><Collapse title="b"><Bluf>x</Bluf></Collapse></Grid></Collapse></Grid></Canvas>`);
  assert.ok(errs(`<Canvas title="t"><Grid><Collapse title="a"><Grid><Collapse title="b"><Steps><Step state="done">x</Step></Steps></Collapse></Grid></Collapse></Grid></Canvas>`).some((m) => /deeper than 5/.test(m)));
});

test("grid cols are 1 to 3, Collapse needs a title, layout accepts any block", () => {
  assert.ok(errs(`<Canvas title="t"><Grid cols={4}><Bluf>x</Bluf></Grid></Canvas>`).some((m) => /cols/.test(m)));
  assert.ok(errs(`<Canvas title="t"><Grid cols={0}><Bluf>x</Bluf></Grid></Canvas>`).some((m) => /cols/.test(m)));
  assert.ok(errs(`<Canvas title="t"><Collapse><Bluf>x</Bluf></Collapse></Canvas>`).some((m) => /title/.test(m)));
  assert.ok(errs(`<Canvas title="t"><Grid>loose text</Grid></Canvas>`).length > 0);
  ok(`<Canvas title="t"><Grid cols={3}><Markdown>a</Markdown><Metric label="a" value="1"/><Table cols="A|B"><Row>1|2</Row></Table></Grid></Canvas>`);
});

test("retired blocks inside a layout still become Markdown", () => {
  const root = ok(`<Canvas title="t"><Collapse id="c" title="x"><Note id="n" tone="warn">Careful</Note></Collapse></Canvas>`);
  assert.equal(root.children[0].children[0].tag, "Markdown");
});

test("a layout survives a patch round-trip and patches reach inside it", () => {
  const root = ok(`<Canvas title="t"><Grid id="g" cols={2}><Collapse id="c" title="Why" open><Markdown id="m">one</Markdown></Collapse></Grid></Canvas>`);
  const r = patchCanvas(root, [{ id: "m", text: "two" }, { parent: "c", append: `<Bluf id="b">hi</Bluf>` }]);
  assert.ok(r.ok);
  if (r.ok) { assert.match(serialize(r.root), /two[\s\S]*Bluf/); assert.equal(r.root.children[0].children[0].attrs.open, true); }
});

test("the plan nests; an open Ask forces its Collapse open; `only` hoists through layout", () => {
  const root = ok(`<Canvas title="t"><Grid id="g"><Collapse id="c" title="Q"><Ask id="q" question="?"><Option value="a">A</Option></Ask></Collapse><Steps id="s"><Step state="active">x</Step></Steps></Grid></Canvas>`);
  const [g] = planBlocks(root);
  assert.ok(g.kind === "grid" && g.cols === 2 && g.children.length === 2);
  if (g.kind === "grid") { const c = g.children[0]; assert.ok(c.kind === "collapse" && c.open); }
  assert.deepEqual(planBlocks(root, new Set(["Steps", "Ask"])).map((p) => p.kind), ["ask", "steps"]);
});

test("compact vs wide: one column below the breakpoint on both renderers", () => {
  assert.deepEqual([390, 559, 560, 1200].map((w) => gridColumns(3, w)), [1, 1, 3, 3]);
  assert.equal(gridColumns(2, 360), 1);
  // the browser reads the same constant for its media query and the same cols for the wide layout
  assert.ok(COMPONENT_CSS.includes(`@media (max-width:${GRID_COMPACT_BELOW - 1}px){.grid{grid-template-columns:minmax(0,1fr)}}`));
  const root = ok(`<Canvas title="t"><Grid cols={3}><Bluf>a</Bluf><Bluf>b</Bluf></Grid><Collapse id="c" title="More &amp; more"><Bluf>in</Bluf></Collapse></Canvas>`);
  const html = renderBlocks(root, "a1");
  assert.ok(html.includes(`class="grid" style="--cols:3"`));
  assert.equal((html.match(/class="cell"/g) ?? []).length, 2);
  assert.ok(html.includes(`<summary>More &amp; more</summary>`) && !html.includes("<details class=\"collapse\" open"));
  const native = readFileSync(join(import.meta.dirname, "../client/blocks.tsx"), "utf8");
  assert.match(native, /gridColumns\(plan\.cols, width, plan\.wide/);
  assert.match(native, /plan\.title/);
});
