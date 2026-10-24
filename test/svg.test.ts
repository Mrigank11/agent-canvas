// The sanitiser corpus: every hostile construct from the plan must be gone from the rebuilt SVG (or the SVG refused),
// and an honest drawing must survive.
import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeSvg } from "../shared/svg.ts";

const wrap = (inner: string, root = 'viewBox="0 0 100 50"') => `<svg xmlns="http://www.w3.org/2000/svg" ${root}>${inner}</svg>`;
const clean = (src: string) => { const r = sanitizeSvg(src); assert.ok(r.ok, r.ok ? "" : r.error); return r.ok ? r : (null as never); };

/** Nothing executable or fetchable may survive in any output. */
const SAFE_OUT = /<script|<foreignObject|<style|<image|<use|<a[ >]|<animate|<set[ >]|\son\w+=|javascript:|\bstyle=|https?:|data:|@import|url\((?!#)|xlink|<!|&[a-z]+;(?!amp;|lt;|gt;|quot;)/i;
const assertSafe = (svg: string) => assert.doesNotMatch(svg.replace(' xmlns="http://www.w3.org/2000/svg"', ""), SAFE_OUT, svg);

test("an honest drawing survives, rebuilt on the whitelist", () => {
  const r = clean(wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/><stop offset="1" stop-color="#00f"/></linearGradient></defs><rect x="2" y="2" width="40" height="20" rx="3" fill="url(#g)" stroke="#333" stroke-width="2"/><text x="5" y="40" font-size="10" font-family="Arial, sans-serif">Hi &amp; bye</text>'));
  assert.deepEqual([r.w, r.h, r.dropped], [100, 50, []]);
  assert.match(r.svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 100 50" fill="currentColor">/);
  assert.match(r.svg, /<text [^>]*>Hi &amp; bye<\/text>/);
  assert.match(r.svg, /fill="url\(#(sv\w+-g)\)"/); // local url(#id) kept, id namespaced so two SVGs on one page cannot collide
  assert.match(r.svg, /<linearGradient id="sv\w+-g">/);
});

test("script elements are removed with their content", () => {
  const r = clean(wrap('<script>alert(1)</script><rect width="5" height="5"/><script type="text/ecmascript"><![CDATA[fetch("http://evil")]]></script>'));
  assertSafe(r.svg);
  assert.doesNotMatch(r.svg, /alert|evil/);
  assert.match(r.svg, /<rect /);
  assert.ok(r.dropped.includes("<script>"));
});

test("on* event attributes are removed, in any case", () => {
  const r = clean(wrap('<rect width="5" height="5" onclick="alert(1)" onLoad="x()" ONMOUSEOVER="y()"/><g onload="z()"><circle r="2" onfocus="q()"/></g>', 'viewBox="0 0 100 50" onload="boom()"'));
  assertSafe(r.svg);
  assert.doesNotMatch(r.svg, /alert|boom|\bon\w+=/i);
  assert.match(r.svg, /<circle r="2"/);
});

test("foreignObject is removed with everything inside it", () => {
  const r = clean(wrap('<foreignObject width="50" height="50"><body xmlns="http://www.w3.org/1999/xhtml"><script>x()</script><iframe src="http://evil"></iframe>HTML</body></foreignObject><rect width="3" height="3"/>'));
  assertSafe(r.svg);
  assert.doesNotMatch(r.svg, /HTML|iframe|body/);
  assert.match(r.svg, /<rect /);
});

test("external and script hrefs are removed; only a local #id on a gradient stays", () => {
  const r = clean(wrap('<defs><linearGradient id="a"/><linearGradient id="b" href="#a"/><linearGradient id="c" href="http://evil/x.svg#a"/><linearGradient id="d" xlink:href="javascript:alert(1)"/></defs><a href="http://evil"><rect width="3" height="3"/></a><use href="#a"/><image href="http://evil/p.png" width="5" height="5"/><text><tspan href="data:text/html,x">t</tspan></text>'));
  assertSafe(r.svg);
  assert.match(r.svg, /href="#sv\w+-a"/);
  assert.equal((r.svg.match(/href=/g) ?? []).length, 1);
  assert.doesNotMatch(r.svg, /<a>|<a |<use|<image/);
});

test("url() to anything but a local #id is removed from every attribute", () => {
  const r = clean(wrap('<defs><linearGradient id="g"/></defs><rect width="3" height="3" fill="url(http://evil/x#g)" stroke="url(&quot;https://evil&quot;)"/><rect id="r" width="3" height="3" fill="url(#missing)" clip-path="url( data:image/svg+xml,x )"/><rect width="3" height="3" fill="URL(http://evil)"/><rect width="3" height="3" fill="url(#g) red"/><path d="M0 0" marker-end="url(//evil/m)"/>'));
  assertSafe(r.svg);
  assert.doesNotMatch(r.svg, /evil|missing|data/);
  assert.match(r.svg, /fill="url\(#sv\w+-g\) red"/);
});

test("xlink: attributes and the xlink namespace are removed", () => {
  const r = clean(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"><rect xlink:href="http://evil" xlink:title="t" width="3" height="3"/><linearGradient id="a" xlink:href="http://evil/g"/><svg:rect width="3" height="3"/></svg>`);
  assertSafe(r.svg);
  assert.doesNotMatch(r.svg, /xlink|svg:rect|evil/);
});

test("style elements and style attributes are removed (no CSS import, no external fonts)", () => {
  const r = clean(wrap('<style>@import url(http://evil/x.css); rect{fill:red}</style><rect width="3" height="3" style="fill:url(http://evil);behavior:url(x)" class="a"/><text style="font-family:evil">x</text>'));
  assertSafe(r.svg);
  assert.doesNotMatch(r.svg, /evil|import|class=/);
});

test("entity expansion is refused: DOCTYPE and custom entities never reach the output", () => {
  const bomb = '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY a "AAAAAAAAAA"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;">]><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><text>&c;&c;&c;</text></svg>';
  const r = sanitizeSvg(bomb);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /DOCTYPE|ENTITY/);
  const xxe = sanitizeSvg('<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg viewBox="0 0 1 1"><text>&x;</text></svg>');
  assert.equal(xxe.ok, false);
  const undeclared = sanitizeSvg(wrap("<text>&evil;</text>"));
  assert.equal(undeclared.ok, false);
  assert.match(undeclared.ok ? "" : undeclared.error, /not defined/);
  assert.equal(sanitizeSvg(wrap("<text>a & b</text>")).ok, false); // a bare & is not XML
});

test("character references decode safely, and cannot smuggle markup or control characters", () => {
  const r = clean(wrap("<text>&#60;script&#62;alert(1)&#60;/script&#62; &#x41;</text>"));
  assert.match(r.svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt; A/); // decoded to text, re-escaped
  assert.equal(sanitizeSvg(wrap("<text>&#0;</text>")).ok, false);
  assert.equal(sanitizeSvg(wrap("<text>&#x110000;</text>")).ok, false);
});

test("limits and structure: viewBox required, size and element caps, one svg root, strict nesting", () => {
  assert.match((sanitizeSvg('<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>') as { error: string }).error, /viewBox/);
  assert.match((sanitizeSvg(wrap("<rect/>", 'viewBox="0 0 0 5"')) as { error: string }).error, /viewBox/);
  assert.equal(sanitizeSvg(wrap(`<!--${"x".repeat(48_100)}-->`)).ok, false);
  assert.match((sanitizeSvg(wrap("<rect/>".repeat(2_001))) as { error: string }).error, /2000 elements/);
  assert.equal(sanitizeSvg(wrap("<rect/>".repeat(1_900))).ok, true);
  assert.equal(sanitizeSvg("<svg viewBox='0 0 1 1'></svg><svg viewBox='0 0 1 1'></svg>").ok, false);
  assert.equal(sanitizeSvg(wrap("<g><rect></g>")).ok, false);
  assert.equal(sanitizeSvg(wrap("<g>".repeat(60) + "</g>".repeat(60))).ok, false);
  assert.equal(sanitizeSvg("<html></html>").ok, false);
  assert.equal(sanitizeSvg(wrap("<rect width=5/>")).ok, false);
});

test("the rebuild is stable: sanitising the output again changes nothing that matters", () => {
  const src = wrap('<defs><linearGradient id="g"><stop offset="0" stop-color="red"/></linearGradient></defs><rect width="9" height="9" fill="url(#g)" onclick="x()"/><text x="1" y="9">t</text>');
  const once = clean(src);
  const twice = clean(once.svg);
  assert.deepEqual(twice.dropped, []);
  assert.equal(twice.svg.replace(/(sv\w+-)+/g, "P-"), once.svg.replace(/(sv\w+-)+/g, "P-"));
});

test("a long path and attribute values survive; hostile values in numeric attributes are dropped", () => {
  const d = "M0 0 " + "L1 1 ".repeat(1000) + "Z";
  assert.match(clean(wrap(`<path d="${d}" stroke-dasharray="4 2"/>`)).svg, /stroke-dasharray="4 2"/);
  const r = clean(wrap('<rect x="expression(alert(1))" width="3" height="3" fill="javascript:alert(1)" stroke-width="2;evil"/>'));
  assertSafe(r.svg);
  assert.doesNotMatch(r.svg, /expression|javascript|evil/);
});

test("a marker keeps its own viewBox (arrowheads), and a bad one is dropped", () => {
  const out = (vb: string) => { const r = sanitizeSvg(`<svg viewBox="0 0 400 160"><defs><marker id="a" viewBox="${vb}" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z"/></marker></defs><line x1="1" y1="1" x2="9" y2="9" marker-end="url(#a)"/></svg>`); assert.ok(r.ok); return r.ok ? r.svg : ""; };
  assert.match(out("0 0 10 10"), /<marker [^>]*viewBox="0 0 10 10"/);
  assert.doesNotMatch(out("0 0 x 10"), /<marker [^>]*viewBox/);
});
