// The <Svg> sanitiser. The agent's SVG is never stripped, it is REBUILT: a strict XML parse (no DTD, no custom
// entities), then only whitelisted elements and presentation attributes are re-emitted, with escaped text and
// namespaced ids. What comes out is the only thing a renderer ever sees, in the browser (inlined) and for the PNG.
// Pure and dependency-free, like the Markdown parser: the plugin server has no runtime node_modules.

export const SVG_LIMITS = { chars: 48_000, elements: 2_000, depth: 40, attr: 20_000 };
const ELEMENTS = new Set(["svg", "g", "rect", "circle", "ellipse", "line", "polyline", "polygon", "path", "text", "tspan", "defs", "marker", "linearGradient", "radialGradient", "stop", "clipPath"]);
const TEXTUAL = new Set(["text", "tspan"]);

const LEN = /^[\d\s.,eE+\-%a-z]*$/i;
const PAINT = /^(?:none|currentColor|inherit|transparent|#[0-9a-fA-F]{3,8}|[a-zA-Z]{3,20}|(?:rgb|rgba|hsl|hsla)\([\d\s.,%/a-z-]*\))$/;
const WORD = /^[\w\-. ]+$/;
type Kind = "len" | "path" | "points" | "transform" | "paint" | "ref" | "word" | "family" | "viewBox" | "space";
const KIND: Record<string, Kind> = {
  x: "len", y: "len", x1: "len", y1: "len", x2: "len", y2: "len", cx: "len", cy: "len", r: "len", rx: "len", ry: "len", width: "len", height: "len", dx: "len", dy: "len", fx: "len", fy: "len",
  refX: "len", refY: "len", markerWidth: "len", markerHeight: "len", "font-size": "len", "stroke-width": "len", "letter-spacing": "len", "word-spacing": "len", offset: "len",
  "stroke-dashoffset": "len", "stroke-dasharray": "len", "stroke-miterlimit": "len", opacity: "len", "fill-opacity": "len", "stroke-opacity": "len", "stop-opacity": "len",
  d: "path", points: "points", transform: "transform", gradientTransform: "transform",
  fill: "paint", stroke: "paint", "stop-color": "paint", color: "paint",
  "clip-path": "ref", "marker-start": "ref", "marker-mid": "ref", "marker-end": "ref",
  "fill-rule": "word", "clip-rule": "word", "stroke-linecap": "word", "stroke-linejoin": "word", "text-anchor": "word", "dominant-baseline": "word", "alignment-baseline": "word",
  "font-weight": "word", "font-style": "word", gradientUnits: "word", clipPathUnits: "word", markerUnits: "word", spreadMethod: "word", orient: "word", visibility: "word", display: "word",
  preserveAspectRatio: "word", "text-decoration": "word",
  "font-family": "family", viewBox: "viewBox", "xml:space": "space",
};
const ROOT_ONLY_DROP = new Set(["width", "height", "x", "y"]);

export type SvgResult = { ok: true; svg: string; w: number; h: number; dropped: string[] } | { ok: false; error: string };

type XNode = { name: string; attrs: Map<string, string>; kids: (XNode | string)[]; line: number };

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };
function decode(s: string, line: number): string {
  return s.replace(/&(?:(#x[0-9a-fA-F]+|#\d+|[A-Za-z][\w.-]*);)?/g, (m, body: string | undefined) => {
    if (body === undefined) throw new Error(`line ${line}: a bare "&" (write &amp;)`);
    if (body[0] === "#") {
      const cp = body[1] === "x" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(cp) || cp > 0x10ffff || (cp < 32 && ![9, 10, 13].includes(cp)) || (cp >= 0xd800 && cp < 0xe000)) throw new Error(`line ${line}: invalid character reference ${m}`);
      return String.fromCodePoint(cp);
    }
    const v = NAMED[body];
    if (v === undefined) throw new Error(`line ${line}: entity &${body}; is not defined (custom entities are not allowed)`);
    return v;
  });
}

/** Strict XML subset: elements, attributes, text, comments, CDATA. DOCTYPE/ENTITY and every other construct are errors. */
function parseXml(src: string): XNode {
  const text = src.replace(/^﻿/, "");
  const lineAt = (p: number) => text.slice(0, p).split("\n").length;
  let i = 0, count = 0;
  const stack: XNode[] = [];
  let root: XNode | null = null;
  const NAME = /^[A-Za-z_][\w.:-]*/;
  while (i < text.length) {
    if (text[i] !== "<") {
      const next = text.indexOf("<", i);
      const chunk = text.slice(i, next < 0 ? text.length : next);
      const top = stack[stack.length - 1];
      if (top) { top.kids.push(decode(chunk, lineAt(i))); } else if (chunk.trim()) throw new Error(`line ${lineAt(i)}: text outside the <svg> root`);
      i = next < 0 ? text.length : next;
      continue;
    }
    const line = lineAt(i);
    if (text.startsWith("<!--", i)) { const e = text.indexOf("-->", i + 4); if (e < 0) throw new Error(`line ${line}: unterminated comment`); i = e + 3; continue; }
    if (text.startsWith("<![CDATA[", i)) {
      const e = text.indexOf("]]>", i + 9);
      if (e < 0) throw new Error(`line ${line}: unterminated CDATA`);
      const top = stack[stack.length - 1];
      if (top) top.kids.push(text.slice(i + 9, e));
      i = e + 3;
      continue;
    }
    if (text.startsWith("<?", i)) { const e = text.indexOf("?>", i + 2); if (e < 0) throw new Error(`line ${line}: unterminated <? … ?>`); i = e + 2; continue; }
    if (text.startsWith("<!", i)) throw new Error(`line ${line}: <!DOCTYPE> and <!ENTITY> declarations are not allowed`);
    if (text[i + 1] === "/") {
      const m = /^<\/([A-Za-z_][\w.:-]*)\s*>/.exec(text.slice(i, i + 200));
      if (!m) throw new Error(`line ${line}: malformed closing tag`);
      const top = stack.pop();
      if (!top || top.name !== m[1]) throw new Error(`line ${line}: </${m[1]}> does not match ${top ? `<${top.name}>` : "an open tag"}`);
      i += m[0].length;
      continue;
    }
    const nm = NAME.exec(text.slice(i + 1, i + 200));
    if (!nm) throw new Error(`line ${line}: stray "<" (write &lt;)`);
    if (++count > SVG_LIMITS.elements) throw new Error(`more than ${SVG_LIMITS.elements} elements`);
    const node: XNode = { name: nm[0], attrs: new Map(), kids: [], line };
    let j = i + 1 + nm[0].length;
    let self = false;
    for (;;) {
      while (/\s/.test(text[j] ?? "")) j++;
      if (j >= text.length) throw new Error(`line ${line}: unterminated <${node.name}> tag`);
      if (text[j] === ">") { j++; break; }
      if (text.startsWith("/>", j)) { j += 2; self = true; break; }
      const an = NAME.exec(text.slice(j, j + 200));
      if (!an) throw new Error(`line ${lineAt(j)}: bad attribute in <${node.name}>`);
      j += an[0].length;
      while (/\s/.test(text[j] ?? "")) j++;
      if (text[j] !== "=") throw new Error(`line ${lineAt(j)}: attribute ${an[0]} needs ="value"`);
      j++;
      while (/\s/.test(text[j] ?? "")) j++;
      const q = text[j];
      if (q !== '"' && q !== "'") throw new Error(`line ${lineAt(j)}: attribute ${an[0]} must be quoted`);
      const e = text.indexOf(q, j + 1);
      if (e < 0) throw new Error(`line ${lineAt(j)}: unterminated value for ${an[0]}`);
      if (node.attrs.has(an[0])) throw new Error(`line ${line}: duplicate attribute ${an[0]} on <${node.name}>`);
      node.attrs.set(an[0], decode(text.slice(j + 1, e), lineAt(j)));
      j = e + 1;
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.kids.push(node);
    else if (root) throw new Error(`line ${line}: only one <svg> root is allowed`);
    else root = node;
    if (!self) { stack.push(node); if (stack.length > SVG_LIMITS.depth) throw new Error(`nesting deeper than ${SVG_LIMITS.depth} levels`); }
    i = j;
  }
  if (stack.length) throw new Error(`<${stack[stack.length - 1].name}> is never closed`);
  if (!root) throw new Error("empty SVG: expected an <svg viewBox=…> root");
  return root;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Small, stable, non-cryptographic hash for the id prefix (the content hash proper is made by the server). */
export function fnv(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(36);
}

const ID = /^[A-Za-z_][\w.-]{0,63}$/;
const URL_REF = /^url\(\s*(['"]?)#([A-Za-z_][\w.-]{0,63})\1\s*\)$/;

export function sanitizeSvg(source: string): SvgResult {
  if (source.length > SVG_LIMITS.chars) return { ok: false, error: `the SVG is over ${SVG_LIMITS.chars} characters` };
  let root: XNode;
  try { root = parseXml(source); } catch (e) { return { ok: false, error: (e as Error).message }; }
  if (root.name !== "svg") return { ok: false, error: `the root must be <svg>, not <${root.name}>` };

  const dropped = new Set<string>();
  const drop = (what: string) => { if (dropped.size < 12) dropped.add(what); };
  const prefix = `sv${fnv(source)}-`;

  // ids that survive: those on kept elements. References to anything else are dropped.
  const ids = new Set<string>();
  const collect = (n: XNode, kept: boolean) => {
    const keep = kept && ELEMENTS.has(n.name);
    const id = n.attrs.get("id");
    if (keep && id !== undefined && ID.test(id)) ids.add(id);
    for (const k of n.kids) if (typeof k !== "string") collect(k, keep);
  };
  collect(root, true);

  const vb = (root.attrs.get("viewBox") ?? "").trim().split(/[\s,]+/).map(Number);
  if (vb.length !== 4 || vb.some((v) => !Number.isFinite(v)) || vb[2] <= 0 || vb[3] <= 0 || vb[2] > 100_000 || vb[3] > 100_000) {
    return { ok: false, error: '<Svg> needs a viewBox with a positive width and height, e.g. viewBox="0 0 400 200" (width/height are ignored: the canvas sizes it)' };
  }

  const attrValue = (name: string, v: string, tag: string): string | null => {
    const kind = KIND[name];
    if (!kind) return null;
    if (v.length > SVG_LIMITS.attr) return null;
    const t = v.trim();
    switch (kind) {
      case "len": return LEN.test(t) ? t : null;
      case "path": return /^[MmLlHhVvCcSsQqTtAaZz\d\s.,eE+-]*$/.test(t) ? t : null;
      case "points": return /^[\d\s.,eE+-]*$/.test(t) ? t : null;
      case "transform": return /^[a-zA-Z\d\s.,()+\-eE]*$/.test(t) ? t : null;
      case "word": return WORD.test(t) ? t : null;
      case "family": return /^[\w\s,'"-]*$/.test(t) ? t : null;
      case "space": return t === "preserve" || t === "default" ? t : null;
      case "viewBox": return vb.join(" ");
      case "paint": {
        if (PAINT.test(t)) return t;
        // url(#id) with an optional fallback colour
        const m = /^(url\([^)]*\))(?:\s+(.+))?$/.exec(t);
        if (!m) return null;
        const u = URL_REF.exec(m[1]);
        if (!u || !ids.has(u[2]) || (m[2] && !PAINT.test(m[2]))) return null;
        return `url(#${prefix}${u[2]})${m[2] ? ` ${m[2]}` : ""}`;
      }
      case "ref": {
        if (t === "none") return t;
        const u = URL_REF.exec(t);
        return u && ids.has(u[2]) ? `url(#${prefix}${u[2]})` : null;
      }
    }
    void tag;
    return null;
  };

  const emit = (n: XNode, isRoot: boolean): string => {
    if (!ELEMENTS.has(n.name)) { drop(`<${n.name}>`); return ""; }
    const attrs: string[] = [];
    if (isRoot) attrs.push('xmlns="http://www.w3.org/2000/svg"');
    for (const [name, v] of n.attrs) {
      if (name === "id") {
        if (ID.test(v)) attrs.push(`id="${prefix}${v}"`); else drop(`id="${v.slice(0, 20)}"`);
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        const m = /^#([A-Za-z_][\w.-]{0,63})$/.exec(v.trim());
        if (m && ids.has(m[1]) && (n.name === "linearGradient" || n.name === "radialGradient")) attrs.push(`href="#${prefix}${m[1]}"`);
        else drop(`${name}="${v.slice(0, 24)}"`);
        continue;
      }
      if (isRoot && ROOT_ONLY_DROP.has(name)) continue;
      if (name.startsWith("xmlns")) continue;
      const out = attrValue(name, v, n.name);
      if (out === null) { drop(/^on/i.test(name) ? name : KIND[name] ? `${name}="${v.slice(0, 24)}"` : name); continue; }
      attrs.push(`${name}="${esc(out)}"`);
    }
    if (isRoot && !n.attrs.has("fill")) attrs.push('fill="currentColor"');
    const kids = n.kids.map((k) => {
      if (typeof k !== "string") return emit(k, false);
      return TEXTUAL.has(n.name) ? esc(k) : k.trim() ? (drop("stray text"), "") : "";
    }).join("");
    return `<${n.name}${attrs.length ? ` ${attrs.join(" ")}` : ""}>${kids}</${n.name}>`;
  };

  return { ok: true, svg: emit(root, true), w: vb[2], h: vb[3], dropped: [...dropped] };
}
