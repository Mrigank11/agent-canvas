import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCanvas, patchCanvas, serialize, findNode } from "../shared/canvas.ts";
import { inlineText, parseMarkdown, type MdBlock } from "../shared/markdown.ts";
import { planBlocks } from "../shared/plan.ts";
import { renderBlocks } from "../server/html.ts";

const FIXTURE = [
  "# Result",
  "",
  "All **green**, ~~mostly~~ _really_, see `npm test` and [docs](https://paseo.sh).",
  "",
  "| Option | Latency | Cost |",
  "|:--|--:|--:|",
  "| Postgres | 4 ms | $25/mo |",
  "| DynamoDB | 2 ms | $40/mo |",
  "",
  "> [!WARNING]",
  "> Migration is **not** reversible.",
  "",
  "```sh",
  "echo \"<b>\" && ls",
  "```",
  "",
  "- [x] build",
  "- [ ] deploy",
  "  - nested item",
  "",
  "1. one",
  "2. two",
].join("\n");

const canvas = (body: string, tag = "Markdown") => `<Canvas title="t"><${tag} id="m">\n${body}\n</${tag}></Canvas>`;
const blocksOf = (src: string): MdBlock[] => { const r = parseMarkdown(src); assert.ok(r.ok); return r.ok ? r.blocks : []; };

test("GFM fixture parses to table, alert, code, task list and ordered list", () => {
  const b = blocksOf(FIXTURE);
  assert.deepEqual(b.map((x) => x.k), ["heading", "paragraph", "table", "alert", "code", "list", "list"]);
  const table = b[2];
  assert.ok(table.k === "table");
  assert.deepEqual(table.align, ["left", "right", "right"]);
  assert.deepEqual(table.numeric, [false, true, true]);
  assert.equal(inlineText(table.rows[1][0].c), "DynamoDB");
  const alert = b[3];
  assert.ok(alert.k === "alert");
  assert.deepEqual([alert.alert, alert.signal, alert.glyph], ["WARNING", "warn", "!"]);
  const code = b[4];
  assert.ok(code.k === "code");
  assert.deepEqual([code.lang, code.text], ["sh", 'echo "<b>" && ls']);
  const tasks = b[5];
  assert.ok(tasks.k === "list");
  assert.deepEqual(tasks.items.map((i) => i.checked), [true, false]);
  assert.equal(tasks.items[1].blocks[1].k, "list"); // nested
  const para = b[1];
  assert.ok(para.k === "paragraph");
  assert.deepEqual(para.c.map((i) => i.t), ["text", "strong", "text", "del", "text", "em", "text", "code", "text", "link", "text"]);
});

test("the fixture renders the same facts in the plan and in the browser HTML", () => {
  const r = parseCanvas(canvas(FIXTURE));
  assert.ok(r.ok);
  if (!r.ok) return;
  const plan = planBlocks(r.root)[0];
  assert.ok(plan.kind === "markdown");
  const html = renderBlocks(r.root, "a1");
  for (const s of ["<h2", "<strong>green</strong>", "<del>mostly</del>", "<code>npm test</code>", 'href="https://paseo.sh"', '<table class="tbl">', "note warn", "<ol>", "<ul>", 'aria-label="done"', 'aria-label="not done"']) assert.ok(html.includes(s), `HTML lacks ${s}`);
  assert.ok(html.includes("echo &quot;&lt;b&gt;&quot;"), "code is escaped");
  assert.equal((html.match(/class="[^"]*best/g) ?? []).length, 2);
});

test("raw HTML is text, unsafe links lose their href, images are rejected with a clear error", () => {
  const html = renderBlocks((parseCanvas(canvas('<script>alert(1)</script> and <img src=x onerror=y> [x](javascript:alert(1)) [y](/rel) [z](data:text/html,hi)')) as any).root, "a");
  assert.ok(!html.includes("<script"), html);
  assert.ok(!html.includes("<img"), html);
  assert.ok(!/href="(javascript|data|\/rel)/.test(html), html);
  assert.ok(html.includes("&lt;script&gt;"));
  const img = parseCanvas(canvas("look ![chart](chart.png)"));
  assert.ok(!img.ok);
  if (!img.ok) assert.match(img.errors.map((e) => e.message).join(), /images are not supported yet/);
  assert.ok(!parseCanvas(canvas("x".repeat(8001))).ok);
});

test("inline edge cases: snake_case, bare URLs, escapes, backticks", () => {
  const p = blocksOf("snake_case_name costs 2*3 \\*no\\* see https://a.b/c). `a``b` ``x`y``")[0];
  assert.ok(p.k === "paragraph");
  assert.deepEqual(p.c.filter((i) => i.t === "link").map((i) => i.t === "link" && i.href), ["https://a.b/c"]);
  const text = inlineText(p.c);
  assert.ok(text.startsWith("snake_case_name costs 2*3 *no* see https://a.b/c)."), text);
  assert.ok(text.includes("x`y"));
});

test("the retired tags still parse and become Markdown with the same ids", () => {
  const src = `<Canvas title="t">
  <Table id="t1" cols="Name|Ms"><Row>a|1</Row><Row>b|2</Row></Table>
  <Note id="n1" tone="error">Broke \`x\`</Note>
  <Link id="l1" href="https://paseo.sh">Paseo</Link>
  <Code id="c1" lang="sh">echo \`hi\`</Code>
</Canvas>`;
  const r = parseCanvas(src);
  assert.ok(r.ok, JSON.stringify(!r.ok && r.errors));
  if (!r.ok) return;
  assert.deepEqual(r.root.children.map((c) => [c.tag, c.id]), [["Markdown", "t1"], ["Markdown", "n1"], ["Markdown", "l1"], ["Markdown", "c1"]]);
  assert.deepEqual(planBlocks(r.root).flatMap((p) => (p.kind === "markdown" ? p.blocks.map((b) => b.k) : [])), ["table", "alert", "paragraph", "code"]);
  const again = parseCanvas(serialize(r.root)); // a live canvas round-trips
  assert.ok(again.ok);
  if (again.ok) assert.deepEqual(again.root, r.root);
  assert.ok(!parseCanvas(`<Canvas title="t"><Link href="javascript:x">x</Link></Canvas>`).ok); // still validated first
});

test("a Markdown block patches by id and re-validates", () => {
  const r = parseCanvas(canvas("old"));
  assert.ok(r.ok);
  if (!r.ok) return;
  const p = patchCanvas(r.root, [{ id: "m", text: "| a |\n|---|\n| 1 |" }]);
  assert.ok(p.ok);
  if (p.ok) assert.equal(blocksOf(findNode(p.root, "m")!.text)[0].k, "table");
  const bad = patchCanvas(r.root, [{ id: "m", text: "![x](y.png)" }]);
  assert.ok(!bad.ok);
});
