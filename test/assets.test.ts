// S2: the workspace image checks, the render pipeline (artefacts, PNGs, the disk cache), and what reaches the clients.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseCanvas } from "../shared/canvas.ts";
import { planBlocks } from "../shared/plan.ts";
import { assetFormat, assetKey } from "../shared/asset-format.ts";
import { assetRpc } from "../shared/contract.ts";
import { Hub } from "../server/hub.ts";
import { handleRpc } from "../server/mcp.ts";
import { Assets } from "../server/render/assets.ts";
import { IMAGE_LIMITS, readWorkspaceImage } from "../server/render/images.ts";
import { rasterize } from "../server/render/raster.ts";
import { renderCanvas } from "../server/html.ts";
import { viewOf } from "./plan.test.ts";

const fx = (f: string) => readFileSync(new URL(`./fixtures/${f}`, import.meta.url).pathname);
const tmp = () => mkdtempSync(join(tmpdir(), "canvas-s2-"));
const workspace = () => {
  const ws = tmp();
  for (const f of ["pic.png", "pic.jpg", "pic.webp", "pic-ll.webp", "pic.gif"]) writeFileSync(join(ws, f), fx(f));
  return ws;
};
const SVG = (extra = "") => `<svg viewBox="0 0 120 60"><rect x="4" y="4" width="50" height="30" fill="#c33"/><text x="60" y="40" font-size="14">Diagram ${extra}</text></svg>`;
const PNG_MAGIC = "89504e47";
const dims = (b: Buffer) => [b.readUInt32BE(16), b.readUInt32BE(20)];
const canvas = (inner: string) => `<Canvas title="t">${inner}</Canvas>`;
const parse = (inner: string) => { const r = parseCanvas(canvas(inner)); assert.ok(r.ok, r.ok ? "" : r.errors.map((e) => e.message).join()); return r.ok ? r.root : (null as never); };

/** A header that claims a size (enough for the sniffer, not a decodable file). */
const fakePng = (w: number, h: number, pad = 0) => {
  const b = Buffer.alloc(33 + pad);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};

// ---------- <Image> and Markdown images: the workspace rules ----------

test("png, jpeg, webp (lossy and lossless) and gif inside the workspace are accepted, by their bytes", async () => {
  const ws = workspace();
  for (const [f, mime] of [["pic.png", "image/png"], ["pic.jpg", "image/jpeg"], ["pic.webp", "image/webp"], ["pic-ll.webp", "image/webp"], ["pic.gif", "image/gif"]] as const) {
    const r = readWorkspaceImage(ws, f);
    assert.ok(r.ok, `${f}: ${r.ok ? "" : r.error}`);
    if (r.ok) assert.deepEqual([r.mime, r.w, r.h], [mime, 48, 30], f);
  }
  writeFileSync(join(ws, "renamed.txt"), fx("pic.png")); // the name is not what decides
  assert.ok(readWorkspaceImage(ws, "renamed.txt").ok);
  mkdirSync(join(ws, "out"));
  writeFileSync(join(ws, "out", "c.png"), fx("pic.png"));
  assert.ok(readWorkspaceImage(ws, "out/c.png").ok);
  assert.ok(readWorkspaceImage(ws, join(ws, "out", "c.png")).ok); // an absolute path inside the workspace is fine
});

test("paths that leave the workspace, symlink out of it, or are URLs are refused", async () => {
  const outer = tmp();
  const ws = join(outer, "ws");
  mkdirSync(ws);
  writeFileSync(join(outer, "secret.png"), fx("pic.png"));
  writeFileSync(join(ws, "ok.png"), fx("pic.png"));
  symlinkSync(join(outer, "secret.png"), join(ws, "link.png"));
  symlinkSync(join(ws, "ok.png"), join(ws, "inside.png"));
  symlinkSync(outer, join(ws, "dirlink"));
  const why = (src: string) => { const r = readWorkspaceImage(ws, src); assert.equal(r.ok, false, src); return r.ok ? "" : r.error; };
  assert.match(why("../secret.png"), /outside the workspace/);
  assert.match(why(join(outer, "secret.png")), /outside the workspace/);
  assert.match(why("link.png"), /outside the workspace/);
  assert.match(why("dirlink/secret.png"), /outside the workspace/);
  assert.match(why("ok/../../secret.png"), /no such file|outside/);
  assert.ok(readWorkspaceImage(ws, "inside.png").ok); // a symlink that stays inside is fine
  for (const url of ["http://169.254.169.254/x.png", "https://example.com/a.png", "file:///etc/passwd", "data:image/png;base64,AAAA", "//evil/a.png", "ftp://x/y.png"]) assert.match(why(url), /is a URL/);
  assert.match(why("/etc/passwd"), /outside the workspace/);
  assert.match(why("missing.png"), /no such file/);
  assert.match(why(""), /empty/);
  assert.match(why("."), /outside the workspace|not a file/);
  assert.equal(readWorkspaceImage(null, "ok.png").ok, false);
});

test("only the four raster types: text, SVG and mislabelled files are refused", async () => {
  const ws = workspace();
  writeFileSync(join(ws, "fake.png"), "TOKEN=abc123\n");
  writeFileSync(join(ws, "pic.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"/>');
  writeFileSync(join(ws, "x.bmp"), Buffer.concat([Buffer.from("BM"), Buffer.alloc(60)]));
  mkdirSync(join(ws, "d"));
  const why = (src: string) => { const r = readWorkspaceImage(ws, src); assert.equal(r.ok, false, src); return r.ok ? "" : r.error; };
  assert.match(why("fake.png"), /not a PNG, JPEG, WebP or GIF/);
  assert.match(why("pic.svg"), /<Svg>/);
  assert.match(why("x.bmp"), /not a PNG/);
  assert.match(why("d"), /not a file/);
});

test("size limits: 3 MB, 4096 px a side, decided from the file and its header", async () => {
  const ws = tmp();
  writeFileSync(join(ws, "wide.png"), fakePng(IMAGE_LIMITS.side + 1, 10));
  writeFileSync(join(ws, "tall.png"), fakePng(10, IMAGE_LIMITS.side + 1));
  writeFileSync(join(ws, "edge.png"), fakePng(IMAGE_LIMITS.side, IMAGE_LIMITS.side));
  writeFileSync(join(ws, "zero.png"), fakePng(0, 10));
  writeFileSync(join(ws, "big.png"), fakePng(10, 10, IMAGE_LIMITS.bytes));
  const why = (src: string) => { const r = readWorkspaceImage(ws, src); assert.equal(r.ok, false, src); return r.ok ? "" : r.error; };
  assert.match(why("wide.png"), /4097×10.*4096 px/);
  assert.match(why("tall.png"), /4096 px/);
  assert.match(why("big.png"), /MB.*limit is 3 MB/);
  assert.match(why("zero.png"), /size/);
  assert.ok(readWorkspaceImage(ws, "edge.png").ok);
});

// ---------- the canvas-level checks (what canvas_set sees) ----------

test("canvas_set refuses a canvas whose image is missing, outside the workspace or a URL, naming the block", async () => {
  const ws = workspace();
  const a = new Assets(null);
  const bad = a.check(parse('<Image id="i1" src="nope.png" alt="x" /><Image id="i2" src="https://x.y/a.png" /><Markdown id="m">![out](../../etc/passwd) and ![ok](pic.png)</Markdown>'), ws);
  assert.ok(!bad.ok);
  if (!bad.ok) {
    assert.equal(bad.errors.length, 3);
    assert.match(bad.errors[0], /<Image id="i1">.*no such file/);
    assert.match(bad.errors[1], /<Image id="i2">.*is a URL/);
    assert.match(bad.errors[2], /<Markdown id="m">.*\.\.\/\.\.\/etc\/passwd.*(outside|no such file)/);
  }
  const ok = a.check(parse('<Image src="pic.png" alt="a" /><Markdown>![b](pic.jpg)</Markdown><Svg alt="d">' + SVG() + "</Svg>"), ws);
  assert.ok(ok.ok);
});

test("the Svg and Image tags validate: viewBox, size, attributes, and at most eight pictures", async () => {
  const bad = (src: string) => { const r = parseCanvas(canvas(src)); assert.ok(!r.ok, src); return r.ok ? "" : r.errors.map((e) => e.message).join(); };
  assert.match(bad("<Svg><svg><rect/></svg></Svg>"), /viewBox/);
  assert.match(bad('<Svg><svg viewBox="0 0 9 9"><script>x</script><!DOCTYPE x></svg></Svg>'), /DOCTYPE|not allowed|Svg/);
  assert.match(bad("<Image />"), /needs src/);
  assert.match(bad('<Image src="a.png" width="3" />'), /no attribute "width"/);
  assert.match(bad(`<Svg>${SVG()}</Svg>`.repeat(5) + '<Image src="a.png"/>'.repeat(4)), /more than 8 images and SVG drawings/);
  assert.ok(parseCanvas(canvas(`<Svg id="a">${SVG()}</Svg>`.repeat(1) + '<Image src="a.png"/>'.repeat(7))).ok);
  assert.ok(parseCanvas(canvas(`<Svg>${SVG()}</Svg>`)).ok);
});

// ---------- what the clients get ----------

test("the wire tree carries hashes and sizes, never the drawing, and stays far under the 64 KiB row cap", async () => {
  const ws = workspace();
  const a = new Assets(null);
  const big = (n: number) => SVG().replace("</svg>", "<g>" + `<rect x="1" y="1" width="2" height="2"/>`.repeat(n) + "</g></svg>");
  const tree = parse(`<Svg id="d1" alt="one">${big(900)}</Svg><Svg id="d2" alt="two">${big(901)}</Svg><Image id="im" src="pic.png" alt="p" /><Markdown id="md">hello ![j](pic.jpg)</Markdown>`);
  assert.ok(JSON.stringify(tree).length > 40_000); // the raw tree is big
  assert.ok(a.check(tree, ws).ok);
  const wire = a.wire(tree, ws);
  const json = JSON.stringify(wire);
  assert.ok(json.length < 4_000, `wire is ${json.length} bytes`);
  const [d1, d2, im, md] = wire.children;
  assert.deepEqual([d1.text, d2.text], ["", ""]);
  assert.match(String(d1.attrs.hash), /^[0-9a-f]{32}$/);
  assert.notEqual(d1.attrs.hash, d2.attrs.hash);
  assert.deepEqual([d1.attrs.w, d1.attrs.h, im.attrs.w, im.attrs.h], [120, 60, 48, 30]);
  assert.equal(JSON.parse(String(md.attrs.assets))["pic.jpg"].w, 48);
  assert.ok(tree.children[0].text.length > 10_000); // the authored tree is untouched
  // and the plan reads them
  const plans = planBlocks(wire);
  assert.deepEqual(plans.map((p) => p.kind), ["svg", "svg", "image", "markdown"]);
  const svg = plans[0], mdp = plans[3];
  assert.ok(svg.kind === "svg" && svg.hash === d1.attrs.hash && svg.alt === "one" && svg.w === 120);
  assert.ok(mdp.kind === "markdown" && mdp.blocks.some((b) => b.k === "image" && b.hash && b.w === 48));
});

test("without a server-made hash a picture is drawn as its alt text, in the plan and in the HTML", async () => {
  const tree = parse(`<Svg alt="the pipeline">${SVG()}</Svg><Image src="x.png" alt="a chart" />`);
  const html = renderCanvas(viewOf(tree), 5000);
  assert.ok(html.includes("Drawing: the pipeline") && html.includes("Image: a chart"), html);
  assert.ok(!html.includes("<svg") && !html.includes("<img"));
});

test("the browser gets the rebuilt SVG inline and an <img> by hash for images; hostile SVG never reaches the page", async () => {
  const ws = workspace();
  const a = new Assets(null);
  const hostile = `<svg viewBox="0 0 100 50" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><image href="http://evil/x.png"/><rect width="10" height="10" fill="url(http://evil/g)" onclick="x()"/><text x="1" y="9">safe &amp; sound</text></svg>`;
  const tree = parse(`<Svg id="h" alt="hostile">${hostile}</Svg><Image id="i" src="pic.png" alt="pic" />`);
  assert.ok(a.check(tree, ws).ok);
  const view = viewOf(a.wire(tree, ws));
  const html = renderCanvas(view, 5000, { svg: (h) => a.inlineSvg(h) });
  assert.match(html, /<div class="svgwrap" role="img" aria-label="hostile"><svg xmlns=/);
  assert.match(html, /safe &amp; sound/);
  assert.doesNotMatch(html.replace(/<script>[\s\S]*<\/script>/, ""), /<script|alert|foreignObject|evil|onload|onclick/); // (the page's own poller script is the only script)
  const hash = String(view.tree.children[1].attrs.hash);
  assert.match(html, new RegExp(`<img src="/asset/${hash}" alt="pic" width="48" height="30"`));
});

// ---------- rasterising ----------

test("an SVG becomes a PNG at the asked width, light and dark differ, and the result is cached", async () => {
  const a = new Assets(null);
  const v = a.svg.validate(SVG(), { cwd: null });
  assert.ok(v.ok);
  if (!v.ok) return;
  const light = await a.asset(v.art.hash, "light", 600);
  const dark = await a.asset(v.art.hash, "dark", 600);
  assert.ok(light && dark);
  const lb = Buffer.from(light.base64, "base64"), db = Buffer.from(dark.base64, "base64");
  assert.equal(lb.toString("hex", 0, 4), PNG_MAGIC);
  assert.deepEqual(dims(lb), [600, 300]); // 120×60 viewBox at 600 wide
  assert.equal(light.mime, "image/png");
  assert.ok(!lb.equals(db), "the dark PNG draws currentColor in the dark ink");
  assert.ok(lb.length > 400);
  const again = await a.asset(v.art.hash, "light", 600);
  assert.equal(again?.base64, light.base64);
  assert.deepEqual(dims(Buffer.from((await a.asset(v.art.hash, "light", 100_000))!.base64, "base64")), [1600, 800]); // clamped
  assert.equal(await a.asset("0".repeat(32), "light", 600), null);
  assert.equal(await a.asset("../../etc/passwd", "light", 600), null);
});

test("text in a drawing is really drawn (the embedded font works with no system fonts)", async () => {
  const withText = (await rasterize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 40" fill="currentColor"><text x="4" y="28" font-size="24" font-family="Helvetica, sans-serif">Hello world</text></svg>', "light", 400)).png;
  const empty = (await rasterize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 40" fill="currentColor"></svg>', "light", 400)).png;
  assert.ok(withText.length > empty.length * 3, `${withText.length} vs ${empty.length}`);
});

test("images: a small file goes out as it is; a gif, or anything wider than asked, as a downscaled PNG", async () => {
  const ws = workspace();
  const a = new Assets(null);
  const hashOf = (f: string) => { const v = a.image.validate(f, { cwd: ws }); assert.ok(v.ok, f); return v.ok ? v.art.hash : ""; };
  const png = await a.asset(hashOf("pic.png"), "light", 720);
  assert.equal(png?.mime, "image/png");
  assert.ok(Buffer.from(png!.base64, "base64").equals(fx("pic.png")));
  const jpg = await a.asset(hashOf("pic.jpg"), "light", 720);
  assert.equal(jpg?.mime, "image/jpeg");
  const gif = await a.asset(hashOf("pic.gif"), "dark", 720);
  assert.equal(gif?.mime, "image/png"); // first frame, as a PNG
  assert.equal(Buffer.from(gif!.base64, "base64").toString("hex", 0, 4), PNG_MAGIC);
  // wider than asked: resvg decodes jpeg and webp (both flavours) and resizes
  for (const f of ["wide.jpg", "wide.webp", "wide-ll.webp"]) {
    writeFileSync(join(ws, f), fx(f));
    const r = await a.asset(hashOf(f), "light", 400);
    assert.equal(r?.mime, "image/png", f);
    assert.deepEqual(dims(Buffer.from(r!.base64, "base64")), [400, 200], f);
  }
  const big = (await rasterize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2000 1000"><rect width="2000" height="1000" fill="#36c"/><circle cx="1000" cy="500" r="400" fill="#fc3"/></svg>', "light", 1600)).png;
  writeFileSync(join(ws, "big.png"), big);
  const down = await a.asset(hashOf("big.png"), "light", 400);
  assert.equal(down?.mime, "image/png");
  assert.deepEqual(dims(Buffer.from(down!.base64, "base64")), [400, 200]);
  assert.ok(Buffer.from(down!.base64, "base64").length < big.length);
});

test("the disk cache: renders and images survive a restart, and the original file may be gone", async () => {
  const ws = workspace();
  const dir = join(tmp(), "cache");
  const a = new Assets(dir);
  const sv = a.svg.validate(SVG("cached"), { cwd: null });
  const im = a.image.validate("pic.png", { cwd: ws });
  assert.ok(sv.ok && im.ok);
  if (!sv.ok || !im.ok) return;
  const first = await a.asset(sv.art.hash, "light", 480);
  assert.ok(first);
  assert.ok(readdirSync(join(dir, "png")).some((f) => f.startsWith(sv.art.hash)));
  assert.ok(readdirSync(join(dir, "img")).some((f) => f.startsWith(im.art.hash)));
  rmSync(join(ws, "pic.png"));
  const b = new Assets(dir); // a fresh process
  assert.deepEqual(b.file(im.art.hash)?.bytes, fx("pic.png"));
  assert.equal((await b.asset(im.art.hash, "light", 720))?.mime, "image/png");
  b.svg.validate(SVG("cached"), { cwd: null }); // the next view registers the drawing again
  assert.equal((await b.asset(sv.art.hash, "light", 480))?.base64, first.base64);
});

// ---------- end to end through the hub and the tools ----------

const tool = async (h: Hub, key: string, name: string, args: unknown) => (await handleRpc(h, key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) as any).result;
const newHub = () => new Hub({ log: () => {}, stateFile: null, publicBase: "http://h:1", localBase: "http://127.0.0.1:1", policy: () => ({ defaultOn: true, autoCanvas: true }) });

test("canvas_set and canvas_patch take pictures from the agent's workspace and refuse the rest, atomically", async () => {
  const ws = workspace();
  const h = newHub();
  const token = h.mintToken(ws);
  h.bind(token, "a1");
  assert.equal(h.cwdOf("a1"), ws);
  const ok = (await tool(h, token, "canvas_set", { source: canvas(`<Svg id="d" alt="x">${SVG("<!-- c -->").replace("<rect", '<rect onclick="x()"')}</Svg><Image id="i" src="pic.png" alt="p"/><Markdown id="m">![j](pic.jpg)</Markdown>`) }));
  assert.equal(ok.isError, false, ok.content[0].text);
  assert.match(ok.content[0].text, /Note:\n- <Svg id="d"> removed onclick/);
  const v = h.view("a1")!;
  assert.equal(v.tree.children[0].text, "");
  assert.ok(JSON.stringify(v).length < 5_000);
  // a patch that points at a file outside the workspace changes nothing
  const before = h.source("a1");
  const bad = (await tool(h, token, "canvas_patch", { ops: [{ id: "i", set: { src: "../outside.png" } }] }));
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /<Image id="i">.*(outside|no such file)/);
  assert.equal(h.source("a1"), before);
  assert.equal((await tool(h, token, "canvas_patch", { ops: [{ id: "i", set: { src: "pic.webp" } }] })).isError, false);
  assert.equal((await tool(h, token, "canvas_patch", { ops: [{ id: "d", text: `<svg viewBox="0 0 10 10"><script>x</script></svg>` }] })).isError, false); // script is removed, not fatal
  assert.equal((await tool(h, token, "canvas_patch", { ops: [{ id: "d", text: "<svg>no viewBox</svg>" }] })).isError, true);
  const noCwd = newHub();
  const t2 = noCwd.mintToken("");
  noCwd.bind(t2, "a2");
  assert.match((await tool(noCwd, t2, "canvas_set", { source: canvas('<Image src="pic.png"/>') })).content[0].text, /workspace is not known/);
});

// ---------- the web / desktop branch: a drawing as sanitised SVG, a phone as PNG ----------

const decodeSvg = (b64: string) => Buffer.from(b64, "base64").toString("utf8");

test("web format: a drawing comes back as the rebuilt SVG, themed, never the agent's source", async () => {
  const a = new Assets(null);
  const hostile = `<svg viewBox="0 0 100 50" onload="alert(1)"><script>alert(2)</script><foreignObject><div>x</div></foreignObject><a href="javascript:alert(3)"><rect width="1" height="1"/></a><rect width="9" height="9" fill="currentColor" onclick="x()"/><text x="5" y="20">hi</text></svg>`;
  const v = a.svg.validate(hostile, { cwd: null });
  assert.ok(v.ok);
  if (!v.ok) return;
  const light = await a.asset(v.art.hash, "light", 600, "svg");
  const dark = await a.asset(v.art.hash, "dark", 600, "svg");
  assert.ok(light && dark);
  assert.equal(light.mime, "image/svg+xml");
  assert.deepEqual([light.w, light.h], [100, 50]);
  const ls = decodeSvg(light.base64), ds = decodeSvg(dark.base64);
  assert.match(ls, /^<svg [^>]*color="#/);
  assert.notEqual(ls, ds, "the ink follows the theme");
  assert.ok(ls.includes("hi") && ls.includes("<rect"));
  for (const bad of [/<script/i, /foreignObject/i, /onload/i, /onclick/i, /javascript:/i, /alert/, /<a[ >]/, /href/i]) assert.ok(!bad.test(ls), `${bad} must not survive`);
  // the vector is exactly the sanitiser's output plus the ink, nothing else
  assert.equal(ls.replace(/ color="#[0-9a-fA-F]+"/, "").replace(/ font-family="[^"]*"/, ""), a.inlineSvg(v.art.hash));
  assert.match(ls, /^<svg [^>]*font-family="Helvetica/, "an image has no page font: sans-serif like the PNG");
  // a root that sets its own font keeps it (no duplicate attribute)
  const own = a.svg.validate(`<svg viewBox="0 0 10 10" font-family="Georgia"><text x="1" y="5">x</text></svg>`, { cwd: null });
  assert.ok(own.ok);
  if (own.ok) assert.equal((decodeSvg((await a.asset(own.art.hash, "light", 100, "svg"))!.base64).match(/font-family=/g) ?? []).length, 1);
});

test("web format: only drawings are vectors; images and unknown hashes keep the PNG path", async () => {
  const ws = workspace();
  const a = new Assets(null);
  const im = a.image.validate("pic.png", { cwd: ws });
  assert.ok(im.ok);
  if (!im.ok) return;
  const r = await a.asset(im.art.hash, "light", 720, "svg");
  assert.equal(r?.mime, "image/png");
  assert.equal(await a.asset("0".repeat(32), "light", 720, "svg"), null);
  const sv = a.svg.validate(SVG(), { cwd: null });
  assert.ok(sv.ok);
  if (!sv.ok) return;
  assert.equal((await a.asset(sv.art.hash, "light", 600))?.mime, "image/png", "no format asked: today's PNG");
  assert.equal((await a.asset(sv.art.hash, "light", 600, "png"))?.mime, "image/png");
});

test("the asset RPC takes an optional format and nothing else", () => {
  const ok = assetRpc.input.safeParse({ hash: "a".repeat(32), theme: "dark", format: "svg" });
  assert.ok(ok.success);
  assert.ok(assetRpc.input.safeParse({ hash: "a".repeat(32), theme: "dark" }).success, "old clients omit it");
  assert.ok(!assetRpc.input.safeParse({ hash: "a".repeat(32), theme: "dark", format: "html" }).success);
});

test("asset-format: only the web platform draws vectors, and a vector has no width bucket", () => {
  assert.equal(assetFormat("web", true), "svg");
  assert.equal(assetFormat("web", false), "png");
  for (const os of ["ios", "android", "native", "windows"]) assert.equal(assetFormat(os, true), "png");
  assert.equal(assetKey("h", true, 480, "svg"), assetKey("h", true, 960, "svg"));
  assert.notEqual(assetKey("h", true, 480, "png"), assetKey("h", true, 960, "png"));
  assert.notEqual(assetKey("h", true, 480, "svg"), assetKey("h", true, 480, "png"));
  assert.notEqual(assetKey("h", true, 480, "svg"), assetKey("h", false, 480, "svg"));
});
