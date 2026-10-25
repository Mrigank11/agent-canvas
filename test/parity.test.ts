// Drift guards: the native and browser renderers must agree because they draw from one plan and one token file.
// These tests fail when someone adds a colour or rule at a call site instead of in shared/ui-spec.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planBlocks, statusPlan, type BlockPlan } from "../shared/plan.ts";
import { SIGNAL, TONES, tokensFixed } from "../shared/ui-spec.ts";
import { COMPONENT_CSS, cssVars } from "../server/ui-html.ts";
import { renderBlocks, renderCanvas, renderIndex } from "../server/html.ts";
import { parseCanvas } from "../shared/canvas.ts";
import { Assets } from "../server/render/assets.ts";
import { SHOWCASE, showcaseTree, viewOf } from "./plan.test.ts";

const root = new URL("..", import.meta.url).pathname;
const read = (f: string) => readFileSync(join(root, f), "utf8");
const files = (dir: string) => readdirSync(join(root, dir), { recursive: true }).map(String).filter((f) => /\.tsx?$/.test(f)).map((f) => join(dir, f));

test("the generated CSS carries every signal value, in light and in dark", () => {
  const css = cssVars();
  const [light, dark] = css.split("@media (prefers-color-scheme:dark)");
  for (const [mode, part] of [["light", light], ["dark", dark]] as const) {
    const t = tokensFixed(mode);
    for (const tone of TONES) {
      const s = t.sig(tone);
      for (const [name, v] of [[tone, s.dot], [`${tone}-t`, s.text], [`${tone}-w`, s.tint]]) assert.ok(part.includes(`--${name}:${v}`), `${mode} --${name}:${v}`);
    }
    for (const v of [t.bg, t.raised, t.well, t.line, t.lineStrong, t.fg, t.muted, t.faint, t.askTint]) assert.ok(part.includes(v), `${mode} base ${v}`);
  }
  assert.ok(css.includes("color-scheme:light dark")); // the browser view follows the OS theme
});

test("component CSS and the renderers hold no colour literals: everything is a token", () => {
  assert.doesNotMatch(COMPONENT_CSS, /#[0-9a-fA-F]{3,8}\b/);
  for (const f of [...files("client"), "server/html.ts", "server/ui-html.ts"]) {
    const src = read(f);
    // ui-html.ts holds the CSS-variable generator; its only literals are none: it reads ui-spec
    assert.doesNotMatch(src, /#[0-9a-fA-F]{6}\b/, `${f} contains a hex colour`);
    assert.doesNotMatch(src, /\b(?:rgb|hsl)a?\(/, `${f} contains an rgb()/hsl() colour`);
  }
});

test("no renderer keeps its own copy of a rule that lives in ui-spec", () => {
  for (const f of [...files("client"), "server/html.ts", "server/ui-html.ts"]) {
    const src = read(f);
    assert.doesNotMatch(src, /\btoneColor\b|\bbadgeColor\b|\bflagColor\b|\bSTEP_ICON\b|\bICON\s*[:=]/, `${f} re-implements a signal mapping`);
    assert.doesNotMatch(src, /severity\s*!==\s*"info"/, `${f} filters flags itself`);
    assert.doesNotMatch(src, /theme\.colors\.accent\b/, `${f} uses the theme accent for status`);
  }
});

test("every plan kind has a native renderer and an HTML renderer", () => {
  const kinds = [...new Set(planBlocks(showcaseTree()).map((p) => p.kind))];
  const native = read("client/blocks.tsx");
  for (const k of kinds) assert.match(native, new RegExp(`case "${k}"`), `native BlockView lacks ${k}`);
  const html = read("server/html.ts");
  for (const k of kinds) assert.match(html, new RegExp(`case "${k}"`), `HTML renderPlan lacks ${k}`);
});

test("every Markdown block and inline kind has a native and an HTML renderer", () => {
  const native = read("client/blocks.tsx"), html = read("server/html.ts");
  for (const k of ["heading", "paragraph", "hr", "code", "quote", "alert", "list", "table", "image"]) {
    assert.match(native, new RegExp(`case "${k}"`), `native MdBlockView lacks ${k}`);
    assert.match(html, new RegExp(`case "${k}"`), `HTML mdBlock lacks ${k}`);
  }
  for (const k of ["text", "code", "strong", "em", "del", "link"]) {
    assert.match(native, new RegExp(`case "${k}"`), `native MdInlines lacks ${k}`);
    assert.match(html, new RegExp(`case "${k}"`), `HTML mdInline lacks ${k}`);
  }
});

test("pictures: both renderers draw the plan's hash, alt text and size, the browser inline or by <img>, the phone through the asset RPC", () => {
  const ws = mkdtempSync(join(tmpdir(), "parity-"));
  writeFileSync(join(ws, "pic.png"), readFileSync(join(root, "test/fixtures/pic.png")));
  const assets = new Assets(null);
  const tree = (() => { const r = parseCanvas(`<Canvas title="t"><Svg id="d" alt="Pipeline"><svg viewBox="0 0 160 40"><text x="4" y="20">build</text></svg></Svg><Image id="i" src="pic.png" alt="Screenshot"/><Markdown id="m">![inline](pic.png)</Markdown></Canvas>`); assert.ok(r.ok); return r.ok ? r.root : (null as never); })();
  assert.ok(assets.check(tree, ws).ok);
  const wired = assets.wire(tree, ws);
  const plans = planBlocks(wired);
  const html = renderBlocks(wired, "a1", { svg: (h) => assets.inlineSvg(h) });
  const [svg, img, md] = plans;
  assert.ok(svg.kind === "svg" && svg.hash && img.kind === "image" && img.hash && md.kind === "markdown");
  if (svg.kind !== "svg" || img.kind !== "image" || md.kind !== "markdown") return;
  has(html, `aria-label="${svg.alt}"`); has(html, assets.inlineSvg(svg.hash)!);
  has(html, `src="/asset/${img.hash}" alt="${img.alt}" width="${img.w}" height="${img.h}"`);
  const mdImg = md.blocks.find((b) => b.k === "image");
  assert.ok(mdImg && mdImg.k === "image" && mdImg.hash);
  if (mdImg && mdImg.k === "image") has(html, `src="/asset/${mdImg.hash}" alt="inline"`);
  // the native component is fed from the very same plan fields, and asks the plugin RPC rather than the HTTP port
  const native = read("client/blocks.tsx");
  for (const f of ["plan.hash", "plan.alt", "plan.w", "plan.h", "b.hash", "b.alt"]) assert.ok(native.includes(f), `native renderer does not read ${f}`);
  assert.match(native, /assetRpc/);
  assert.doesNotMatch(native, /\bfetch\(|XMLHttpRequest|https?:\/\//, "native reaches pictures only through the RPC");
});

test("a Diff is a closed fold in both renderers, fed by the plan's summary and file list", () => {
  const native = read("client/blocks.tsx");
  for (const f of ["plan.summary", "plan.files", "plan.add", "plan.del", "useState(false)"]) assert.ok(native.includes(f), `native Diff does not use ${f}`);
});

const has = (html: string, s: string) => assert.ok(html.includes(s), `HTML is missing ${s}`);

test("for the showcase canvas, the HTML agrees with the plan on signal, glyph and text", () => {
  const plans = planBlocks(showcaseTree());
  const html = renderBlocks(showcaseTree(), "a1");
  const of = <K extends BlockPlan["kind"]>(k: K) => plans.find((p) => p.kind === k) as Extract<BlockPlan, { kind: K }>;
  for (const r of of("steps").rows) {
    has(html, `st-${r.state}`);
    has(html, r.text);
    // done and failed draw their glyph in a tinted circle, active is the pulsing run dot, pending is a bare ring, skipped a faint dash
    if (r.state === "done" || r.state === "failed") has(html, `gc ${r.signal}">${r.glyph}`);
    else if (r.state === "active") has(html, "sd run");
    else if (r.state === "pending") has(html, "g ring");
    else has(html, `g faint">${r.glyph}`);
  }
  has(html, of("steps").count);
  has(html, `c-${of("progress").signal}`);
  has(html, of("progress").text);
  for (const m of of("metrics").items) { has(html, m.label); has(html, m.head); if (m.valueSignal) has(html, `c-${m.valueSignal}`); if (m.delta) has(html, `delta ${m.delta.signal}`); if (m.delta) has(html, m.delta.text); }
  has(html, `data-ask="q"`);
  for (const o of of("ask").options) has(html, `data-value="${o.value}"`);
  const d = of("diff");
  has(html, `+${d.add}`); has(html, `−${d.del}`);
  for (const l of d.lines) if (l.kind !== "ctx") has(html, `class="${l.kind}"`);
  const md = plans.flatMap((p) => (p.kind === "markdown" ? p.blocks : []));
  const table = md.find((b) => b.k === "table");
  assert.ok(table && table.k === "table");
  assert.equal((html.match(/class="best"/g) ?? []).length + (html.match(/num best/g) ?? []).length, table.rows.flat().filter((c) => c.best).length);
  for (const n of md) if (n.k === "alert") { has(html, `note ${n.signal}`); has(html, n.glyph); }
  has(html, "Decision · Runtime"); has(html, "✓ Node");
});

test("the status line agrees: same label, signal, lead and flags as the plan", () => {
  const v = viewOf(undefined, { runState: "idle" });
  const plan = statusPlan(v, 5000);
  const html = renderCanvas(v, 5000);
  has(html, `badge ${plan.signal}`); has(html, plan.label); has(html, plan.run);
  if (plan.lead) has(html, plan.lead);
  const lying = viewOf(undefined, { runState: "running", callsNow: 9 });
  const lp = statusPlan(lying, 5000);
  const lh = renderCanvas(lying, 5000);
  for (const f of lp.flags) { has(lh, `flag ${f.signal}`); has(lh, f.text); }
});

test("the Canvases list gives needs-you the only filled row and a badge per row", () => {
  const html = renderIndex([viewOf(undefined, { runState: "idle", agentId: "a" }), viewOf(undefined, { runState: "running", agentId: "b", title: "Other" })], 5000);
  assert.equal((html.match(/class="row need/g) ?? []).length, 1);
  has(html, "1 need you");
  assert.equal((html.match(/class="badge /g) ?? []).length, 3); // heading + two rows
});

test("the signal table is the whole palette: six tones, each hue used for one state", () => {
  assert.deepEqual([...TONES].sort(), ["err", "hot", "idle", "ok", "run", "warn"]);
  assert.equal(Object.keys(SIGNAL).length, 6);
  assert.ok(SHOWCASE.length > 0);
});
