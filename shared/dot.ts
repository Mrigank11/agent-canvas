// The <Diagram lang="dot"> preprocessor: pure text work on the agent's Graphviz source before it reaches the layout engine.
// Attributes that could fetch or reference something outside the diagram are removed; tone names become colours; theme
// defaults are injected so a bare `digraph { a -> b }` already looks like the rest of the canvas. A tokenizer (not a
// regex over the whole text) is used so a label that merely contains `URL=` is left alone.

import { DIAGRAM, SIGNAL } from "./ui-spec.ts";

export const DOT_LIMITS = { chars: 8_000, nodes: 300 };

/** Graphviz attributes that name a URL, a file or a stylesheet. The WASM filesystem is empty, but nothing of them may reach the output either. */
const STRIPPED = new Set([
  "url", "href", "tooltip", "labeltooltip", "headtooltip", "tailtooltip", "edgetooltip", "headurl", "tailurl", "labelurl", "edgeurl", "headhref", "tailhref", "labelhref", "edgehref",
  "target", "headtarget", "tailtarget", "labeltarget", "edgetarget", "image", "shapefile", "fontpath", "imagepath", "stylesheet", "class", "id",
]);
const COLOR_KEYS = new Set(["color", "fillcolor", "fontcolor", "bgcolor", "pencolor", "labelfontcolor", "headlabelfontcolor", "taillabelfontcolor"]);

/** Tone names the agent may use as colours, mapped to the canvas's own signal hues (ui-spec), which read on both light and dark. */
export const DOT_TONES: Record<string, string> = { ok: SIGNAL.ok.dot!.light, run: SIGNAL.run.dot!.light, warn: SIGNAL.warn.dot!.light, err: SIGNAL.err.dot!.light, idle: "#a1a1aa" };
/** A tone's tint, as the alpha byte the canvas uses for its own tinted surfaces (idle has none: it borrows a mid value). */
const toneTint = (name: string) => `${DOT_TONES[name]}${SIGNAL[name as "ok"]?.tintAlpha?.light ?? "1a"}`;
/**
 * Stand-ins for paint that depends on the page: Graphviz is given these hex values and the renderer swaps each for
 * currentColor at an opacity (DIAGRAM in ui-spec), so one SVG serves light and dark. Distinct from any real colour an agent would pick.
 */
export const INK = "#010203";
export const PAPER = "#010204";
export const WELL = "#010205";
export const LINE = "#010206";
export const MUTED = "#010207";
export const MUTED_TEXT = "#010208";

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

/** The `[ … ]` attribute list around token i, as [open, close] token indexes, or null when i is not inside one. */
function listOf(toks: Tok[], i: number): [number, number] | null {
  let a = i;
  while (a >= 0 && !(toks[a].t === "punct" && (toks[a].v === "[" || toks[a].v === "]"))) a--;
  if (a < 0 || toks[a].v !== "[") return null;
  let b = i;
  while (b < toks.length && !(toks[b].t === "punct" && toks[b].v === "]")) b++;
  return b < toks.length ? [a, b] : null;
}
/** The (lower-cased) attribute names set in a list. */
function keysIn(toks: Tok[], [a, b]: [number, number]): Set<string> {
  const keys = new Set<string>();
  for (let i = a + 1; i < b; i++) {
    if (toks[i].t !== "id" && toks[i].t !== "str") continue;
    let j = i + 1;
    while (toks[j]?.t === "ws") j++;
    if (toks[j]?.t === "punct" && toks[j].v === "=") keys.add(unquote(toks[i].v).toLowerCase());
  }
  return keys;
}
/** Whether the statement owning the list at [a, b] is an edge or an `edge [...]` default (an `->` or `--` before the bracket). */
function isEdge(toks: Tok[], [a]: [number, number]): boolean {
  let i = a - 1;
  for (; i >= 0; i--) { const t = toks[i]; if (t.t === "punct" && (t.v === ";" || t.v === "{" || t.v === "}" || t.v === "]")) break; if (t.t === "id" && (t.v.includes("--") || (t.v.endsWith("-") && toks[i + 1]?.v === ">") || t.v.toLowerCase() === "edge")) return true; }
  return false;
}

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
          if (key === "emphasis") {
            // the house "one emphasised node": a heavier stroke, and the accent hue unless the element already has a colour
            const on = !/^(false|no|0)$/i.test(unquote(val.v));
            const list = listOf(toks, i);
            if (on) {
              out.push({ t: "id", v: "penwidth" }, { t: "punct", v: "=" }, { t: "id", v: String(DIAGRAM.emphasisStroke) });
              if (list && !keysIn(toks, list).has("color")) out.push({ t: "ws", v: " " }, { t: "id", v: "color" }, { t: "punct", v: "=" }, { t: "str", v: `"${DOT_TONES.run}"` }, ...(isEdge(toks, list) ? [] : [{ t: "ws", v: " " } as Tok, { t: "id", v: "fillcolor" } as Tok, { t: "punct", v: "=" } as Tok, { t: "str", v: `"${toneTint("run")}"` } as Tok]));
            }
            i = k; continue;
          }
          if (COLOR_KEYS.has(key) && val.t !== "html") {
            const name = unquote(val.v).toLowerCase();
            const tone = DOT_TONES[name];
            if (tone) {
              if (key === "fillcolor") { out.push(tk, { t: "punct", v: "=" }, { t: "str", v: `"${toneTint(name)}"` }); i = k; continue; }
              out.push(tk, { t: "punct", v: "=" }, { t: "str", v: `"${tone}"` });
              // a tinted card: the hue as a thin stroke, its tint as the fill (nodes and clusters, not edges, whose arrowheads would take the fill)
              const list = key === "color" ? listOf(toks, i) : null;
              if (list) {
                const keys = keysIn(toks, list);
                if (!isEdge(toks, list) && !keys.has("fillcolor")) out.push({ t: "ws", v: " " }, { t: "id", v: "fillcolor" }, { t: "punct", v: "=" }, { t: "str", v: `"${toneTint(name)}"` });
                if (!keys.has("penwidth") && !keys.has("emphasis")) out.push({ t: "ws", v: " " }, { t: "id", v: "penwidth" }, { t: "punct", v: "=" }, { t: "id", v: String(DIAGRAM.toneStroke) });
              }
              i = k; continue;
            }
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

/**
 * Theme defaults, first in the graph so the agent's own statements override them. One unit is one px (the page shows the
 * drawing at natural size): 13 px labels on rounded cards with a soft fill, thin muted connectors, room between nodes.
 */
const DEFAULTS = `graph [bgcolor="${PAPER}" fontname="Helvetica" fontsize=${DIAGRAM.fontSize} fontcolor="${INK}" pad=0.3 nodesep=0.45 ranksep=0.6 splines=spline]; node [shape=box style="rounded,filled" fillcolor="${WELL}" color="${LINE}" fontcolor="${INK}" fontname="Helvetica" fontsize=${DIAGRAM.fontSize} margin="0.24,0.12" height=0.5 penwidth=${DIAGRAM.stroke}]; edge [color="${MUTED}" fontcolor="${MUTED_TEXT}" fontname="Helvetica" fontsize=${DIAGRAM.edgeFontSize} arrowsize=0.6 penwidth=${DIAGRAM.stroke}];`;
