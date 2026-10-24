// The <Diagram lang="dot"> preprocessor: pure text work on the agent's Graphviz source before it reaches the layout engine.
// Attributes that could fetch or reference something outside the diagram are removed; tone names become colours; theme
// defaults are injected so a bare `digraph { a -> b }` already looks like the rest of the canvas. A tokenizer (not a
// regex over the whole text) is used so a label that merely contains `URL=` is left alone.

export const DOT_LIMITS = { chars: 8_000, nodes: 300 };

/** Graphviz attributes that name a URL, a file or a stylesheet. The WASM filesystem is empty, but nothing of them may reach the output either. */
const STRIPPED = new Set([
  "url", "href", "tooltip", "labeltooltip", "headtooltip", "tailtooltip", "edgetooltip", "headurl", "tailurl", "labelurl", "edgeurl", "headhref", "tailhref", "labelhref", "edgehref",
  "target", "headtarget", "tailtarget", "labeltarget", "edgetarget", "image", "shapefile", "fontpath", "imagepath", "stylesheet", "class", "id",
]);
const COLOR_KEYS = new Set(["color", "fillcolor", "fontcolor", "bgcolor", "pencolor", "labelfontcolor", "headlabelfontcolor", "taillabelfontcolor"]);

/** Tone names the agent may use as colours, mapped to hues that read on both light and dark (Paseo's own signal dots). */
export const DOT_TONES: Record<string, string> = { ok: "#299f51", run: "#268ae0", warn: "#b37824", err: "#f12e2f", idle: "#a1a1aa" };
/** The ink and surface stand-ins: Graphviz is told these hex values, and the renderer swaps them for currentColor / transparent in the SVG. */
export const INK = "#010203";
export const PAPER = "#010204";

type Tok = { t: "id" | "str" | "html" | "punct" | "ws"; v: string };

function tokenize(src: string): Tok[] | string {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { let j = i; while (j < src.length && /\s/.test(src[j])) j++; out.push({ t: "ws", v: src.slice(i, j) }); i = j; continue; }
    if (c === "/" && src[i + 1] === "/" || c === "#" && (i === 0 || src[i - 1] === "\n")) { const e = src.indexOf("\n", i); const j = e < 0 ? src.length : e; out.push({ t: "ws", v: " " }); i = j; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return "unterminated /* comment"; out.push({ t: "ws", v: " " }); i = e + 2; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1;
      if (j >= src.length) return `unterminated string starting "${src.slice(i, i + 20)}"`;
      out.push({ t: "str", v: src.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (c === "<") {
      let depth = 0, j = i;
      for (; j < src.length; j++) { if (src[j] === "<") depth++; else if (src[j] === ">" && --depth === 0) break; }
      if (j >= src.length) return "unterminated HTML label <…>";
      out.push({ t: "html", v: src.slice(i, j + 1) }); i = j + 1; continue;
    }
    if (/[A-Za-z0-9_.\u0080-￿-]/.test(c)) { let j = i; while (j < src.length && /[A-Za-z0-9_.\u0080-￿-]/.test(src[j])) j++; out.push({ t: "id", v: src.slice(i, j) }); i = j; continue; }
    out.push({ t: "punct", v: c }); i++;
  }
  return out;
}

const unquote = (v: string) => (v.startsWith('"') ? v.slice(1, -1) : v);

export type DotResult = { ok: true; dot: string; removed: string[] } | { ok: false; error: string };

/** Strip, map, inject. `removed` names what was dropped, for the note back to the agent. */
export function prepareDot(body: string): DotResult {
  if (!body.trim()) return { ok: false, error: "the diagram is empty" };
  if (body.length > DOT_LIMITS.chars) return { ok: false, error: `the DOT source is over ${DOT_LIMITS.chars} characters` };
  const toks = tokenize(body);
  if (typeof toks === "string") return { ok: false, error: toks };
  const removed: string[] = [];
  const out: Tok[] = [];
  let injected = false;
  for (let i = 0; i < toks.length; i++) {
    const tk = toks[i];
    if (tk.t === "html" && /<\s*(img|object|embed)\b/i.test(tk.v)) { removed.push("<IMG> in a label"); out.push({ t: "str", v: '""' }); continue; }
    if (tk.t === "id" || tk.t === "str") {
      // key = value
      let j = i + 1;
      while (toks[j]?.t === "ws") j++;
      if (toks[j]?.t === "punct" && toks[j].v === "=") {
        let k = j + 1;
        while (toks[k]?.t === "ws") k++;
        const val = toks[k];
        const key = unquote(tk.v).toLowerCase();
        if (val && (val.t === "id" || val.t === "str" || val.t === "html")) {
          if (STRIPPED.has(key)) {
            removed.push(key);
            i = k;
            if (toks[i + 1]?.t === "punct" && (toks[i + 1].v === "," || toks[i + 1].v === ";")) i++;
            continue;
          }
          if (COLOR_KEYS.has(key) && val.t !== "html") {
            const tone = DOT_TONES[unquote(val.v).toLowerCase()];
            if (tone) { out.push(tk, { t: "punct", v: "=" }, { t: "str", v: `"${tone}"` }); i = k; continue; }
          }
        }
      }
    }
    out.push(tk);
    if (!injected && tk.t === "punct" && tk.v === "{") {
      injected = true;
      out.push({ t: "ws", v: " " }, { t: "id", v: DEFAULTS });
    }
  }
  if (!injected) return { ok: false, error: "expected `digraph { … }` or `graph { … }`" };
  return { ok: true, dot: out.map((t) => t.v).join(""), removed: [...new Set(removed)] };
}

/** Theme defaults, first in the graph so the agent's own statements override them. */
const DEFAULTS = `graph [bgcolor="${PAPER}" fontname="Helvetica" fontsize=11 fontcolor="${INK}" pad=0.15]; node [shape=box style="rounded" color="${INK}" fontcolor="${INK}" fontname="Helvetica" fontsize=11 margin="0.14,0.07" penwidth=1]; edge [color="${INK}" fontcolor="${INK}" fontname="Helvetica" fontsize=10 arrowsize=0.7];`;
