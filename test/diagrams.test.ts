// S3 + S4: <Diagram lang="dot"> (Graphviz wasm in a worker) and <Chart lang="vega-lite"> (vega, no DOM) through the render pipeline.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chartPoints, parseCanvas, patchCanvas, serialize } from "../shared/canvas.ts";
import { DOT_LIMITS, prepareDot } from "../shared/dot.ts";
import { planBlocks } from "../shared/plan.ts";
import { checkVegaSpec, legacyChartSpec } from "../shared/vegaspec.ts";
import { Hub } from "../server/hub.ts";
import { handleRpc } from "../server/mcp.ts";
import { renderCanvas } from "../server/html.ts";
import { Assets } from "../server/render/assets.ts";
import { renderDot, stopDotWorker } from "../server/render/dot.ts";
import { renderVega, stopVegaWorker } from "../server/render/vega.ts";
import { viewOf } from "./plan.test.ts";

after(() => { stopDotWorker(); stopVegaWorker(); });

const canvas = (inner: string) => `<Canvas title="t">${inner}</Canvas>`;
const parse = (inner: string) => { const r = parseCanvas(canvas(inner)); assert.ok(r.ok, r.ok ? "" : r.errors.map((e) => e.message).join()); return r.ok ? r.root : (null as never); };
const errs = (inner: string) => { const r = parseCanvas(canvas(inner)); assert.ok(!r.ok); return r.ok ? [] : r.errors.map((e) => e.message); };
/** Nothing executable or fetchable in any rendered output. */
const SAFE_OUT = /<script|<foreignObject|<style|<image|<use|<a[ >]|\son\w+=|javascript:|\bstyle=|https?:|data:|url\((?!#)|xlink|<!|<title/i;

// ---------- DOT ----------

const FLOW = `digraph G { rankdir=LR; start [label="Start" shape=ellipse]; build [label="Build" color=ok]; test [label="Test" color=warn]; start -> build -> test; test -> deploy [label="pass"]; test -> build [label="fail" color=err style=dashed]; deploy [label="Deploy"] }`;
const DEPS = `digraph deps { app -> {api web}; api -> {db cache}; web -> api; web -> cdn; subgraph cluster_infra { label="infra"; db; cache } }`;
const STATES = `digraph fsm { rankdir=LR; node [shape=circle]; idle -> running [label="start"]; running -> idle [label="stop"]; running -> failed [label="error"]; failed -> idle [label="reset"]; idle [shape=doublecircle] }`;

test("flowchart, dependency graph and state machine fixtures lay out to a safe, themed SVG", async () => {
  for (const [name, src, labels] of [["flow", FLOW, ["Start", "Build", "Deploy", "pass"]], ["deps", DEPS, ["app", "cache", "infra"]], ["fsm", STATES, ["idle", "running", "reset"]]] as const) {
    const r = await renderDot(src);
    assert.ok(r.ok, r.ok ? "" : `${name}: ${r.error}`);
    if (!r.ok) return;
    assert.match(r.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 [\d.]+ [\d.]+"/, name);
    for (const l of labels) assert.ok(r.svg.includes(`>${l}</text>`), `${name}: ${l}`);
    assert.doesNotMatch(r.svg.replace(' xmlns="http://www.w3.org/2000/svg"', ""), SAFE_OUT, name);
    assert.ok(r.svg.includes('"currentColor"'), "ink follows the page, so one artefact serves light and dark");
    assert.ok(r.w > 20 && r.h > 20);
  }
  const flow = await renderDot(FLOW);
  assert.ok(flow.ok && flow.svg.includes("#299f51") && flow.svg.includes("#b37824") && flow.svg.includes("#f12e2f"), "tone names become the theme's signal colours");
});

test("URL, href, tooltip, image, shapefile, fontpath, imagepath and stylesheet are removed; labels that merely mention them are not", async () => {
  const src = `digraph { stylesheet="http://evil/x.css"; imagepath="/etc"; fontpath="/usr"; a [label="URL=x href=y" URL="http://evil" tooltip="t" image="/etc/passwd" shapefile="/x" target=_blank]; a -> b [href="http://evil" labeltooltip=z, color=ok]; c [label=<<IMG SRC="/etc/passwd"/>>] }`;
  const pre = prepareDot(src);
  assert.ok(pre.ok);
  if (!pre.ok) return;
  for (const k of ["stylesheet", "imagepath", "fontpath", "URL", "image", "shapefile"]) assert.ok(!new RegExp(`${k.toLowerCase()}\\s*=`, "i").test(pre.dot.replace(/"[^"]*"/g, '""')), k);
  assert.ok(pre.dot.includes('"URL=x href=y"'), "label text untouched");
  const r = await renderDot(src);
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.doesNotMatch(r.svg.replace(' xmlns="http://www.w3.org/2000/svg"', ""), SAFE_OUT);
  assert.ok(r.svg.includes(">URL=x href=y</text>"));
  assert.match(r.notes.join(), /removed .*url.*tooltip.*image.*href/i);
});

test("a Graphviz error comes back to the agent with its message", async () => {
  const r = await renderDot("digraph { a -> }");
  assert.ok(!r.ok && /syntax error/.test(r.error), JSON.stringify(r));
  assert.ok(!(await renderDot("not a graph")).ok);
  assert.match((await renderDot("digraph { a [label=\"x }")).ok ? "" : "bad", /bad/);
  const big = await renderDot(`digraph { ${Array.from({ length: 301 }, (_, i) => `n${i}`).join(";")} }`);
  assert.ok(!big.ok && /more than 300 nodes/.test(big.error), JSON.stringify(big));
  assert.ok(!(await renderDot("x".repeat(DOT_LIMITS.chars + 1))).ok);
});

test("a pathological graph fails within the 3 s timeout, the worker is replaced and the next render works", async () => {
  let src = "digraph{splines=ortho; ";
  for (let i = 0; i < 44; i++) for (let j = 0; j < 44; j++) if (i !== j && (i * 7 + j * 3) % 5 < 2) src += `a${i}->a${j}; `;
  src += "}";
  assert.ok(src.length < DOT_LIMITS.chars);
  const t = Date.now();
  const r = await renderDot(src);
  const took = Date.now() - t;
  assert.ok(!r.ok && /longer than 3 s/.test(r.error), JSON.stringify(r).slice(0, 200));
  assert.ok(took < 4_500, `took ${took} ms`);
  assert.ok((await renderDot("digraph { a -> b }")).ok);
  assert.ok((await renderDot("digraph { c -> d }")).ok);
});

// ---------- Vega-Lite ----------

const rows = [{ a: "A", b: 28, c: "x" }, { a: "B", b: 55, c: "y" }, { a: "C", b: 43, c: "x" }, { a: "D", b: 91, c: "y" }];
const spec = (mark: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ title: "Sales", data: { values: rows }, mark, encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } }, ...extra });

test("bar, line, area and scatter fixtures render to a safe SVG", async () => {
  for (const [name, body] of [
    ["bar", spec("bar")],
    ["line", spec({ type: "line", point: true })],
    ["area", spec("area", { encoding: { x: { field: "b", type: "quantitative" }, y: { field: "b", type: "quantitative" } } })],
    ["scatter", JSON.stringify({ data: { values: rows }, mark: "point", encoding: { x: { field: "b", type: "quantitative" }, y: { field: "b", type: "quantitative" }, color: { field: "c", type: "nominal" } } })],
    ["pie", JSON.stringify({ data: { values: rows }, mark: "arc", encoding: { theta: { field: "b", type: "quantitative" }, color: { field: "a", type: "nominal" } } })],
    ["gantt", JSON.stringify({ data: { values: [{ t: "build", s: 0, e: 3 }, { t: "test", s: 3, e: 5 }] }, mark: "bar", encoding: { y: { field: "t", type: "nominal" }, x: { field: "s", type: "quantitative" }, x2: { field: "e" } } })],
  ] as const) {
    const r = await renderVega(body);
    assert.ok(r.ok, r.ok ? "" : `${name}: ${r.error}`);
    if (!r.ok) return;
    assert.doesNotMatch(r.svg.replace(' xmlns="http://www.w3.org/2000/svg"', ""), SAFE_OUT, name);
    assert.ok(r.w > 100 && r.h > 100, name);
    assert.ok(r.svg.includes("currentColor"), `${name}: text and axes follow the page colour`);
  }
  const bar = await renderVega(spec("bar"));
  assert.ok(bar.ok && bar.svg.includes(">Sales</text>") && bar.svg.includes(">A</text>"));
});

test("data.url, links, images, metadata, big data and unknown properties are refused with a reason", async () => {
  const bad: [string, RegExp][] = [
    ['{"data":{"url":"http://x/y.csv"},"mark":"bar"}', /"url" is not allowed/],
    ['{"data":{"values":[{"a":1}]},"mark":"bar","encoding":{"href":{"value":"http://evil"}}}', /"href" is not allowed/],
    ['{"data":{"values":[{"a":1}]},"mark":"image","encoding":{}}', /mark "image" is not allowed/],
    ['{"data":{"values":[{"a":1}]},"mark":"bar","usermeta":{"a":1}}', /unknown top-level property "usermeta"/],
    ['{"data":{"values":[{"a":1}]},"mark":"bar","config":{"customFormatTypes":true,"x":{"usermeta":1}}}', /"usermeta" is not allowed/],
    ['{"data":{"sequence":{"start":0,"stop":9999999}},"mark":"bar"}', /"sequence" is not allowed/],
    ['{"data":{"values":[{"a":1}]},"mark":"text","encoding":{"text":{"value":"x"}},"title":"ok","config":{"font":"https://evil/f.woff"}}', /looks like a URL/],
    ['{"mark":"bar"}', /needs inline data/],
    ['{"data":{"values":[]},"mark":"bar","colour":1}', /unknown top-level property "colour"/],
    ['{"data":{"values":[]},"mark":"bar","width":99999}', /width must be/],
    ['{"$schema":"http://evil/s.json","data":{"values":[]},"mark":"bar"}', /\$schema/],
    ["not json", /not valid JSON/],
    ["[1]", /JSON object/],
    [JSON.stringify({ data: { values: Array.from({ length: 5001 }, (_, i) => ({ i })) }, mark: "bar" }), /over 16000 characters|5000 inline/],
  ];
  for (const [body, re] of bad) { const r = await renderVega(body); assert.ok(!r.ok && re.test(r.error), `${body.slice(0, 60)} → ${JSON.stringify(r).slice(0, 160)}`); }
  const many = checkVegaSpec(JSON.stringify({ data: { values: Array.from({ length: 5001 }, () => 1) }, mark: "bar" }));
  assert.ok(many.ok === false && /5000 inline data rows/.test(many.error));
  const compile = await renderVega('{"data":{"values":[{"a":1}]},"mark":"bar","encoding":{"x":{"field":"a","type":"zzz"}}}');
  assert.ok(!compile.ok && /^Vega-Lite: Invalid field type/.test(compile.error), JSON.stringify(compile));
});

test("Vega runs in a worker with a timeout: an overrun is stopped and reported, and the next chart still renders", async () => {
  const r = await renderVega(spec("bar"), { timeoutMs: 1 }); // a compile plus a layout cannot finish in 1 ms
  assert.ok(!r.ok && /Vega-Lite took longer than 0\.001 s/.test(r.error), JSON.stringify(r).slice(0, 200));
  assert.ok((await renderVega(spec("line"))).ok);
});

test("an expression cannot reach the host: Vega runs with the AST interpreter", async () => {
  const body = JSON.stringify({ data: { values: rows }, transform: [{ calculate: "constructor.constructor('return process')().pid", as: "x" }], mark: "bar", encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" } } });
  const r = await renderVega(body);
  assert.ok(!r.ok || !r.svg.includes(String(process.pid)));
  assert.equal(typeof (globalThis as any).__pwned, "undefined");
});

// ---------- the retired Chart form ----------

test("the old Chart kind/data form is accepted and becomes a Vega-Lite Chart node with the same id", () => {
  const tree = parse(`<Chart id="c1" kind="line" title="Weekly" data="mon:3,tue:5" /><Chart id="c2" data="a:1,b:2" />`);
  const [c1, c2] = tree.children;
  assert.deepEqual([c1.tag, c1.id, c1.attrs.lang, c1.attrs.alt], ["Chart", "c1", "vega-lite", "Weekly"]);
  const s = JSON.parse(c1.text);
  assert.deepEqual([s.mark, s.title, s.data.values], [{ type: "line", point: true }, "Weekly", [{ label: "mon", value: 3 }, { label: "tue", value: 5 }]]);
  assert.equal(JSON.parse(c2.text).mark, "bar");
  assert.ok(checkVegaSpec(c1.text).ok);
  assert.deepEqual(chartPoints("a:1"), [{ label: "a", value: 1 }]);
  assert.ok(checkVegaSpec(legacyChartSpec("bar", undefined, [{ label: "x", value: 1 }])).ok);
  // the converted tree survives serialise → parse (patch round-trips)
  const again = parseCanvas(serialize(tree));
  assert.ok(again.ok && again.root.children[0].text === c1.text);
  assert.match(errs('<Chart data="nope" />').join(), /Chart data/);
  assert.match(errs("<Chart>{}</Chart>").join(), /needs lang/);
  assert.match(errs('<Chart lang="vega-lite" data="a:1">{"data":{"values":[]},"mark":"bar"}</Chart>').join(), /not data=/);
});

test("the parser checks what it can without rendering: bad DOT and bad specs fail canvas_set before any layout", () => {
  assert.match(errs('<Diagram lang="dot">digraph { a [label="x }</Diagram>').join(), /unterminated string/);
  assert.match(errs('<Diagram>digraph{}</Diagram>').join(), /needs lang/);
  assert.match(errs('<Diagram lang="mermaid">graph TD</Diagram>').join(), /not one of dot/);
  assert.match(errs('<Chart lang="vega-lite">{"data":{"url":"x"},"mark":"bar"}</Chart>').join(), /"url" is not allowed/);
  const nine = Array.from({ length: 9 }, (_, i) => `<Diagram id="d${i}" lang="dot">digraph{a->b}</Diagram>`).join("");
  assert.match(errs(nine).join(), /more than 8 images and SVG drawings/);
});

// ---------- end to end ----------

const newHub = () => new Hub({ log: () => {}, stateFile: null, publicBase: "http://h:1", localBase: "http://127.0.0.1:1", policy: () => ({ defaultOn: true, autoCanvas: true }) });
const tool = async (h: Hub, key: string, name: string, args: unknown) => (await handleRpc(h, key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
const BODY = `<Diagram id="flow" lang="dot" alt="the pipeline">${FLOW}</Diagram><Chart id="sales" lang="vega-lite" alt="sales by region">${spec("bar")}</Chart><Chart id="old" kind="bar" data="a:1,b:2" />`;

test("canvas_set lays out diagrams and charts; browser and native read the same artefact; patches replace the body; failures change nothing", async () => {
  const h = newHub();
  const token = h.mintToken("/tmp");
  h.bind(token, "a1");
  const ok = await tool(h, token, "canvas_set", { source: canvas(BODY) });
  assert.equal(ok.isError, false, ok.content[0].text);
  const v = h.view("a1")!;
  assert.deepEqual(planBlocks(v.tree).map((p) => p.kind), ["svg", "svg", "svg"]);
  assert.ok(JSON.stringify(v).length < 5_000, "the row carries hashes, not drawings");
  const plans = planBlocks(v.tree);
  for (const p of plans) assert.ok(p.kind === "svg" && p.hash && p.w > 0 && p.h > 0);
  // browser: inline svg for every one; native: a PNG per theme, from the same hash
  const html = renderCanvas(v, 5000, { svg: (x) => h.assets.inlineSvg(x) });
  assert.equal((html.match(/class="svgwrap" style="--w:\d+px"/g) ?? []).length, 3);
  assert.ok(html.includes('aria-label="the pipeline"') && html.includes(">Build</text>"));
  for (const p of plans) {
    if (p.kind !== "svg" || !p.hash) continue;
    for (const theme of ["light", "dark"] as const) {
      const a = await h.assets.asset(p.hash, theme, 480);
      assert.ok(a && a.mime === "image/png" && Buffer.from(a.base64, "base64").subarray(1, 4).toString() === "PNG", `${p.id} ${theme}`);
    }
  }
  // a broken diagram is refused whole
  const before = h.source("a1");
  const bad = await tool(h, token, "canvas_patch", { ops: [{ id: "flow", text: "digraph { a -> }" }] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /<Diagram id="flow">: syntax error/);
  assert.equal(h.source("a1"), before);
  const badChart = await tool(h, token, "canvas_patch", { ops: [{ id: "sales", text: '{"data":{"url":"http://x"},"mark":"bar"}' }] });
  assert.equal(badChart.isError, true);
  assert.equal(h.source("a1"), before);
  // a good one replaces the body and the hash moves
  const old = (plans[0] as any).hash;
  assert.equal((await tool(h, token, "canvas_patch", { ops: [{ id: "flow", text: "digraph { x -> y }" }] })).isError, false);
  const now = planBlocks(h.view("a1")!.tree)[0] as any;
  assert.notEqual(now.hash, old);
  assert.ok(h.assets.inlineSvg(now.hash)!.includes(">x</text>"));
  // a diagram with URL= is accepted, with a note
  const note = await tool(h, token, "canvas_patch", { ops: [{ id: "flow", text: 'digraph { a [URL="http://evil"] }' }] });
  assert.equal(note.isError, false);
  assert.match(note.content[0].text, /<Diagram id="flow"> removed url/i);
});

test("renders are cached on disk: a fresh Assets wires a saved canvas without laying it out again", async () => {
  const dir = join(mkdtempSync(join(tmpdir(), "canvas-s34-")), "cache");
  const a = new Assets(dir);
  const tree = parse(BODY);
  const p = await a.prepare(tree);
  assert.ok(p.ok, p.ok ? "" : p.errors.join());
  assert.ok(a.check(tree, null).ok);
  const before = planBlocks(a.wire(tree, null)).map((x: any) => x.hash);
  assert.ok(readdirSync(join(dir, "svg")).length >= 3);
  const b = new Assets(dir); // a restarted daemon: no prepare()
  assert.ok(b.check(tree, null).ok);
  assert.deepEqual(planBlocks(b.wire(tree, null)).map((x: any) => x.hash), before);
  assert.equal((await b.asset(before[0], "dark", 300))?.mime, "image/png");
  assert.ok(b.inlineSvg(before[1])!.startsWith("<svg "));
  // without prepare and without the cache the block is refused, never half-drawn
  const c = new Assets(null);
  assert.match((c.check(tree, null) as any).errors.join(), /not been rendered/);
});

test("a patch is validated against the canvas it will join: ids stay stable through convert and round-trip", () => {
  const tree = parse(BODY);
  const r = patchCanvas(tree, [{ id: "old", text: spec("line") }]);
  assert.ok(r.ok, r.ok ? "" : r.errors.map((e) => e.message).join());
});

// ---------- house style ----------

import { DIAGRAM, DIAGRAM_FONT, CHART_PALETTE, DRAWING_MIN_SCALE, SIGNAL, drawingWidth, tokensFixed } from "../shared/ui-spec.ts";
import { INK, LINE, MUTED, MUTED_TEXT, PAPER, WELL } from "../shared/dot.ts";
import { VOCAB_DOC } from "../server/vocab-doc.ts";
import { readFileSync } from "node:fs";
const src = (rel: string) => readFileSync(join(import.meta.dirname, rel), "utf8");

test("DOT house style: soft-filled rounded cards, muted edges, page font, no stand-in paint left over", async () => {
  const r = await renderDot("digraph { a -> b [label=go] }");
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  for (const hex of [INK, PAPER, WELL, LINE, MUTED, MUTED_TEXT]) assert.ok(!r.svg.includes(hex), `${hex} was swapped`);
  assert.ok(r.svg.includes(`fill="currentColor" fill-opacity="${DIAGRAM.well}"`), "card fill is ink at the well opacity");
  assert.ok(r.svg.includes(`stroke-opacity="${DIAGRAM.line}"`) && r.svg.includes(`stroke-opacity="${DIAGRAM.muted}"`), "outline and connector are ink at low opacity");
  assert.ok(r.svg.includes(`fill="currentColor" fill-opacity="${DIAGRAM.muted}"`), "the arrowhead is muted like its edge");
  assert.ok(r.svg.includes(`fill-opacity="${DIAGRAM.mutedText}"`), "edge labels are muted text");
  assert.ok(r.svg.includes('stroke-linecap="round"'));
  assert.ok(r.svg.includes(`font-family="${DIAGRAM_FONT}"`) && !r.svg.includes("Liberation"));
  assert.ok(r.svg.includes(`font-size="${DIAGRAM.fontSize}.00"`), "natural size: 13 units is 13 px");
});

test("tones are tinted cards, emphasis is the heavier stroke, and neither overrides what the agent set", () => {
  const dot = (src: string) => { const r = prepareDot(src); assert.ok(r.ok); return r.ok ? r.dot : ""; };
  const ok = SIGNAL.ok.dot!.light, run = SIGNAL.run.dot!.light;
  const tone = dot('digraph { a [color=ok] }');
  assert.ok(tone.includes(`color="${ok}" fillcolor="${ok}${SIGNAL.ok.tintAlpha!.light}" penwidth=${DIAGRAM.toneStroke}`), tone);
  const own = dot('digraph { a [color=ok fillcolor=warn penwidth=3] }');
  assert.ok(own.includes(`fillcolor="${SIGNAL.warn.dot!.light}${SIGNAL.warn.tintAlpha!.light}"`) && !own.includes("penwidth=1.6") && !own.includes(`fillcolor="${ok}`), own);
  const edge = dot('digraph { a -> b [color=err] }');
  assert.ok(edge.includes(`color="${SIGNAL.err.dot!.light}"`) && !/b \[[^\]]*fillcolor/.test(edge), "an edge keeps the hue only: its arrowhead would take the fill");
  assert.ok(!dot("digraph { edge [color=warn]; a -> b }").match(/edge \[[^\]]*fillcolor/), "edge defaults too");
  const emph = dot('digraph { a [emphasis=true] }');
  assert.ok(emph.includes(`penwidth=${DIAGRAM.emphasisStroke}`) && emph.includes(`color="${run}"`) && !emph.includes("emphasis"), emph);
  const both = dot('digraph { a [color=warn emphasis=true] }');
  assert.ok(both.includes(`penwidth=${DIAGRAM.emphasisStroke}`) && !both.includes(`penwidth=${DIAGRAM.toneStroke}`) && !both.includes(run), both);
  assert.ok(!dot('digraph { a [emphasis=false] }').includes("penwidth=2.4"));
  assert.ok(dot('digraph { a [label="color=ok emphasis=true"] }').includes('"color=ok emphasis=true"'), "label text untouched");
});

test("a tone renders as a tinted fill plus a hue stroke; a two-line HTML label renders", async () => {
  const r = await renderDot('digraph { a [color=warn emphasis=true label=<<b>Test</b><br/><font point-size="11" color="gray">2 flaky</font>>] }');
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.match(r.svg, /fill="#b37824" fill-opacity="0\.1\d+" stroke="#b37824" stroke-width="2\.4"/);
  assert.ok(r.svg.includes(">Test</text>") && r.svg.includes(">2 flaky</text>"));
  assert.doesNotMatch(r.svg.replace(' xmlns="http://www.w3.org/2000/svg"', ""), SAFE_OUT);
});

test("the neutral card fill matches the well token in both modes, to within a few levels", () => {
  for (const mode of ["light", "dark"] as const) {
    const t = tokensFixed(mode);
    const ch = (hex: string, i: number) => parseInt(hex.slice(1 + 2 * i, 3 + 2 * i), 16);
    for (let i = 0; i < 3; i++) {
      const blended = ch(t.fg, i) * DIAGRAM.well + ch(t.bg, i) * (1 - DIAGRAM.well);
      assert.ok(Math.abs(blended - ch(t.well, i)) <= 6, `${mode} channel ${i}: ${blended} vs ${ch(t.well, i)}`);
    }
  }
});

test("Vega-Lite theme: signal hues for series, the page font, no frame or ticks, dashed quiet grid, natural 11 px labels", async () => {
  const r = await renderVega(JSON.stringify({ data: { values: rows }, mark: "bar", encoding: { x: { field: "a", type: "nominal" }, y: { field: "b", type: "quantitative" }, color: { field: "c", type: "nominal" } } }));
  assert.ok(r.ok, r.ok ? "" : r.error);
  if (!r.ok) return;
  assert.ok(r.svg.includes(CHART_PALETTE[0]) && r.svg.includes(CHART_PALETTE[1]), "the first series are run and ok");
  assert.ok(!r.svg.includes("#4c78a8"), "not Vega's stock blue");
  assert.ok(r.svg.includes(`font-family="${DIAGRAM_FONT}"`) && r.svg.includes('font-size="11px"'));
  assert.ok(r.svg.includes('stroke-dasharray="2,3"'), "dashed grid");
  assert.ok(!/rotate\(270\)/.test(r.svg), "category labels stay horizontal");
  const single = await renderVega(spec("bar"));
  assert.ok(single.ok && single.svg.includes(SIGNAL.run.dot!.light), "a single series is the run hue");
});

test("drawings keep natural size: the browser sets --w and the CSS floors the scale; native uses the same rule", () => {
  assert.equal(drawingWidth(640, 800), 640, "never upscaled");
  assert.equal(drawingWidth(640, 600), 600, "shrinks a little to fit");
  assert.equal(drawingWidth(640, 300), 640 * DRAWING_MIN_SCALE, "then stops shrinking (the container scrolls)");
  const css = src("../server/ui-html.ts");
  assert.ok(css.includes("overflow-x:auto") && css.includes("max(min(100%,var(--w,100%))"));
  assert.ok(src("../client/blocks.tsx").includes("drawingWidth(w, avail)"));
});

test("the vocab doc and the skill send explanatory figures to hand-written Svg, and the skill's template is a valid, safe drawing", () => {
  const skill = src("../skill/agent-canvas/SKILL.md");
  for (const doc of [VOCAB_DOC, skill]) {
    assert.match(doc, /figure that explains|figure that EXPLAINS/);
    assert.match(doc, /Use DOT only when the graph is big/);
    assert.match(doc, /emphasis=true/);
  }
  const tmpl = skill.match(/```\n(<Svg[\s\S]*?<\/Svg>)\n```/)?.[1];
  assert.ok(tmpl, "template present");
  const tree = parse(tmpl!);
  const svg = planBlocks(tree)[0] as any;
  assert.equal(svg.kind, "svg");
  const a = new Assets(null);
  return a.prepare(tree).then((p) => { assert.ok(p.ok, p.ok ? "" : p.errors.join()); });
});
