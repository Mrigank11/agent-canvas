// Markdown for the <Markdown> block: a small, dependency-free CommonMark/GFM subset parsed to a plan-ready tree.
// The plugin has no runtime node_modules, so this is our own parser. It is safe by construction: raw HTML is never
// interpreted (it comes out as text), links keep only http(s)/mailto, and an image is only a *reference*: the server
// resolves it against the agent's workspace (server/render/images.ts) and nothing is ever fetched from a URL. Both renderers
// (server/html.ts, client/blocks.tsx) draw this tree; neither parses Markdown itself.
//
// Subset: ATX headings, paragraphs, fenced code, block quotes, GitHub alerts (> [!NOTE]), bullet/ordered/task lists
// (nested by indentation), GFM tables with alignment, thematic breaks; inline code, **strong**, *em*, ~~del~~,
// [links](url), <autolinks>, bare http(s) URLs, backslash escapes. Not supported: setext headings, reference links,
// indented code, HTML blocks (shown as text).
import { NOTE_GLYPH, bestCells, isNumericColumn, noteSignal, type Tone } from "./ui-spec.ts";

export type Inline =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "strong" | "em" | "del"; c: Inline[] }
  | { t: "link"; href: string; c: Inline[] };

export const ALERTS = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
export type AlertKind = (typeof ALERTS)[number];
/** An alert's look reuses the Note tones: one place decides which signal and glyph each means. */
const ALERT_TONE: Record<AlertKind, string> = { NOTE: "info", TIP: "success", IMPORTANT: "info", WARNING: "warn", CAUTION: "error" };
export const alertLook = (k: AlertKind): { signal: Tone; glyph: string; title: string } => ({
  signal: noteSignal(ALERT_TONE[k]),
  glyph: NOTE_GLYPH[ALERT_TONE[k]],
  title: k[0] + k.slice(1).toLowerCase(),
});

export type MdCell = { c: Inline[]; best: boolean };
export type MdBlock =
  | { k: "heading"; level: number; c: Inline[] }
  | { k: "paragraph"; c: Inline[] }
  | { k: "code"; lang: string; text: string }
  | { k: "quote"; blocks: MdBlock[] }
  | { k: "alert"; alert: AlertKind; signal: Tone; glyph: string; title: string; blocks: MdBlock[] }
  | { k: "list"; ordered: boolean; start: number; items: { checked: boolean | null; blocks: MdBlock[] }[] }
  | { k: "table"; head: Inline[][]; align: ("left" | "right" | "center" | null)[]; numeric: boolean[]; rows: MdCell[][] }
  | { k: "hr" }
  /** `![alt](path)` on its own line. `hash`/`w`/`h` are filled by the plan from what the server resolved; without them it is drawn as its alt text. */
  | { k: "image"; src: string; alt: string; hash?: string; w?: number; h?: number };

export type MdResult = { ok: true; blocks: MdBlock[] } | { ok: false; error: string };

// ---------- inline ----------

const SAFE_HREF = /^(https?:\/\/|mailto:)/i;
export const safeHref = (h: string) => SAFE_HREF.test(h.trim());
const ESCAPABLE = "\\`*_{}[]()#+-.!|~<>&\"'";

/** Plain text of inlines (for table-cell analysis, aria labels, tests). */
export function inlineText(c: Inline[]): string {
  return c.map((i) => (i.t === "text" || i.t === "code" ? i.v : inlineText(i.c))).join("");
}

/** An image found while parsing inlines; only a paragraph accepts one (it splits there), anywhere else it is its alt text. */
type Rich = Inline | { t: "image"; src: string; alt: string };

function closer(s: string, from: number, mark: string): number {
  // the next unescaped `mark` that is not part of a longer run of the same character
  for (let i = from; i < s.length; i++) {
    if (s[i] === "\\") { i++; continue; }
    if (s[i] === "`") { const e = s.indexOf("`", i + 1); if (e < 0) continue; i = e; continue; }
    if (s.startsWith(mark, i)) {
      if (mark.length === 1 && s[i + 1] === mark) { while (s[i + 1] === mark) i++; continue; }
      return i;
    }
  }
  return -1;
}

function inline(s: string): Inline[];
function inline(s: string, img: true): Rich[];
function inline(s: string, img = false): Rich[] {
  const out: Rich[] = [];
  let buf = "";
  const flush = () => { if (buf) { out.push({ t: "text", v: buf }); buf = ""; } };
  for (let i = 0; i < s.length; ) {
    const ch = s[i];
    if (ch === "\\" && i + 1 < s.length && ESCAPABLE.includes(s[i + 1])) { buf += s[i + 1]; i += 2; continue; }
    if (ch === "\\" && s[i + 1] === "\n") { flush(); buf = "\n"; i += 2; continue; }
    if (ch === "`") {
      let n = 1; while (s[i + n] === "`") n++;
      const fence = "`".repeat(n);
      const end = s.indexOf(fence, i + n);
      if (end > 0) { flush(); let v = s.slice(i + n, end).replace(/\n/g, " "); if (/^ .*[^ ].* $/.test(v)) v = v.slice(1, -1); out.push({ t: "code", v }); i = end + n; continue; }
      buf += fence; i += n; continue;
    }
    if (ch === "!" && s[i + 1] === "[") {
      const close = closer(s, i + 2, "]");
      if (close > 0 && s[close + 1] === "(") {
        const end = s.indexOf(")", close + 2);
        if (end > 0) {
          const src = (s.slice(close + 2, end).trim().match(/^(?:<([^>]*)>|(\S+))/)?.slice(1).find(Boolean) ?? "").trim();
          const alt = inlineText(inline(s.slice(i + 2, close)));
          flush();
          if (img) out.push({ t: "image", src, alt }); else if (alt) out.push({ t: "text", v: alt });
          i = end + 1; continue;
        }
      }
    }
    if (ch === "[") {
      const close = closer(s, i + 1, "]");
      if (close > 0 && s[close + 1] === "(") {
        const end = s.indexOf(")", close + 2);
        if (end > 0) {
          const href = s.slice(close + 2, end).trim().split(/\s+/)[0] ?? "";
          const label = inline(s.slice(i + 1, close));
          flush();
          // an unsafe scheme (javascript:, data:, relative) keeps the words and drops the link
          if (safeHref(href)) out.push({ t: "link", href, c: label }); else out.push(...label);
          i = end + 1; continue;
        }
      }
    }
    if (ch === "<") {
      const m = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/i.exec(s.slice(i));
      if (m) { flush(); out.push({ t: "link", href: m[1], c: [{ t: "text", v: m[1] }] }); i += m[0].length; continue; }
    }
    if ((ch === "h" || ch === "H") && !isWord(s[i - 1])) {
      const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i));
      if (m) {
        const url = m[0].replace(/[.,;:!?'")\]]+$/, "");
        flush(); out.push({ t: "link", href: url, c: [{ t: "text", v: url }] }); i += url.length; continue;
      }
    }
    const em = emphasis(s, i);
    if (em) { flush(); out.push(em.node); i = em.next; continue; }
    buf += ch; i++;
  }
  flush();
  return out;
}

const MARKS = [["**", "strong"], ["~~", "del"], ["__", "strong"], ["*", "em"], ["_", "em"]] as const;
const isWord = (ch: string | undefined) => !!ch && /[\p{L}\p{N}]/u.test(ch);
function emphasis(s: string, i: number): { node: Inline; next: number } | null {
  for (const [mark, t] of MARKS) {
    if (!s.startsWith(mark, i)) continue;
    if (mark[0] === "_" && isWord(s[i - 1])) continue; // snake_case stays text
    if (/\s/.test(s[i + mark.length] ?? " ")) continue;
    const end = closer(s, i + mark.length, mark);
    if (end < 0 || end === i + mark.length || /\s/.test(s[end - 1]) || (mark[0] === "_" && isWord(s[end + mark.length]))) continue;
    return { node: { t, c: inline(s.slice(i + mark.length, end)) }, next: end + mark.length };
  }
  return null;
}

// ---------- blocks ----------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?(?:\s+#+)?\s*$/;
const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
const BULLET = /^( {0,3})([-*+])( +|$)(.*)$/;
const ORDERED = /^( {0,3})(\d{1,9})[.)]( +|$)(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\" && s[i + 1] === "|") { cur += "|"; i++; }
    else if (s[i] === "`") { const e = s.indexOf("`", i + 1); if (e > 0) { cur += s.slice(i, e + 1); i = e; } else cur += s[i]; }
    else if (s[i] === "|") { cells.push(cur.trim()); cur = ""; }
    else cur += s[i];
  }
  cells.push(cur.trim());
  return cells;
}

const startsBlock = (l: string) => FENCE.test(l) || HEADING.test(l) || HR.test(l) || /^ {0,3}>/.test(l) || BULLET.test(l) || ORDERED.test(l);

function blocks(lines: string[]): MdBlock[] {
  const out: MdBlock[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const mark = fence[1];
      const body: string[] = [];
      i++;
      while (i < lines.length && !new RegExp(`^ {0,3}${mark[0]}{${mark.length},}\\s*$`).test(lines[i])) body.push(lines[i++]);
      i++; // the closing fence (an unclosed fence runs to the end, as in CommonMark)
      out.push({ k: "code", lang: fence[2].slice(0, 20), text: body.join("\n") });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) { out.push({ k: "heading", level: h[1].length, c: inline(h[2] ?? "") }); i++; continue; }
    if (HR.test(line)) { out.push({ k: "hr" }); i++; continue; }

    if (/^ {0,3}>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && lines[i].trim() && (/^ {0,3}>/.test(lines[i]) || !startsBlock(lines[i]))) body.push(lines[i++].replace(/^ {0,3}> ?/, ""));
      const alert = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i.exec(body[0] ?? "");
      if (alert) {
        const kind = alert[1].toUpperCase() as AlertKind;
        out.push({ k: "alert", alert: kind, ...alertLook(kind), blocks: blocks(body.slice(1)) });
      } else out.push({ k: "quote", blocks: blocks(body) });
      continue;
    }

    const li = BULLET.exec(line) ?? ORDERED.exec(line);
    if (li) {
      const ordered = !!ORDERED.exec(line) && !BULLET.exec(line);
      const items: { checked: boolean | null; blocks: MdBlock[] }[] = [];
      const start = ordered ? Number(ORDERED.exec(line)![2]) : 1;
      while (i < lines.length) {
        const m = (ordered ? ORDERED : BULLET).exec(lines[i]);
        if (!m) break;
        const width = m[1].length + (ordered ? m[2].length + 1 : 1) + Math.min(Math.max(m[3].length, 1), 4);
        const body = [m[4]];
        i++;
        while (i < lines.length) {
          const l = lines[i];
          if (!l.trim()) {
            // a blank line stays in the item only if an indented line follows
            const nx = lines.slice(i + 1).find((x) => x.trim());
            if (nx !== undefined && /^\s{2,}\S/.test(nx) && !(ordered ? ORDERED : BULLET).exec(nx)) { body.push(""); i++; continue; }
            break;
          }
          if (/^\s{2,}\S/.test(l)) { body.push(l.slice(Math.min(width, l.length - l.trimStart().length))); i++; continue; }
          if (startsBlock(l)) break;
          body.push(l); i++; // lazy continuation
        }
        let checked: boolean | null = null;
        const task = /^\[([ xX])\](?:\s+|$)/.exec(body[0]);
        if (task) { checked = task[1] !== " "; body[0] = body[0].slice(task[0].length); }
        items.push({ checked, blocks: blocks(body) });
        while (i < lines.length && !lines[i].trim() && (ordered ? ORDERED : BULLET).exec(lines[i + 1] ?? "")) i++; // loose list
      }
      out.push({ k: "list", ordered, start, items });
      continue;
    }

    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && TABLE_SEP.test(lines[i + 1])) {
      const head = splitRow(line);
      const seps = splitRow(lines[i + 1]);
      if (seps.length === head.length) {
        const align = seps.map((s) => (s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : s.startsWith(":") ? "left" : null)) as ("left" | "right" | "center" | null)[];
        i += 2;
        const raw: string[][] = [];
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) {
          const cells = splitRow(lines[i++]);
          raw.push(head.map((_, c) => cells[c] ?? "")); // short rows are padded, long rows truncated (GFM)
        }
        const best = bestCells(head, raw);
        out.push({
          k: "table",
          head: head.map((c) => inline(c)),
          align,
          numeric: head.map((_, c) => isNumericColumn(raw, c)),
          rows: raw.map((r, ri) => r.map((c, ci) => ({ c: inline(c), best: best.has(`${ri}:${ci}`) }))),
        });
        continue;
      }
    }

    const para: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !startsBlock(lines[i]) && !(lines[i].includes("|") && TABLE_SEP.test(lines[i + 1] ?? "x"))) para.push(lines[i++].trim());
    out.push(...paragraph(inline(para.join("\n"), true)));
  }
  return out;
}

/** A paragraph that holds images becomes text runs and image blocks, in order. */
function paragraph(c: Rich[]): MdBlock[] {
  const out: MdBlock[] = [];
  let cur: Inline[] = [];
  const flush = () => { if (cur.some((x) => x.t !== "text" || x.v.trim())) out.push({ k: "paragraph", c: cur }); cur = []; };
  for (const x of c) {
    if (x.t === "image") { flush(); out.push({ k: "image", src: x.src, alt: x.alt }); } else cur.push(x);
  }
  flush();
  return out.length ? out : [{ k: "paragraph", c: [] }];
}

/** Every image in a parsed body, in document order. */
export function imagesOf(bs: MdBlock[]): Extract<MdBlock, { k: "image" }>[] {
  return bs.flatMap((b): Extract<MdBlock, { k: "image" }>[] =>
    b.k === "image" ? [b] : b.k === "quote" || b.k === "alert" ? imagesOf(b.blocks) : b.k === "list" ? b.items.flatMap((it) => imagesOf(it.blocks)) : []);
}

/** Copy of the blocks with each image block passed through `f` (the plan attaches resolved assets this way). */
export function mapImages(bs: MdBlock[], f: (b: Extract<MdBlock, { k: "image" }>) => MdBlock): MdBlock[] {
  return bs.map((b): MdBlock =>
    b.k === "image" ? f(b)
    : b.k === "quote" ? { ...b, blocks: mapImages(b.blocks, f) }
    : b.k === "alert" ? { ...b, blocks: mapImages(b.blocks, f) }
    : b.k === "list" ? { ...b, items: b.items.map((it) => ({ ...it, blocks: mapImages(it.blocks, f) })) }
    : b);
}

/** Parse a Markdown body. Nothing in Markdown itself fails (the result type keeps the door open); image paths are checked by the server. */
export function parseMarkdown(text: string): MdResult {
  return { ok: true, blocks: blocks(text.replace(/\r\n?/g, "\n").replace(/\t/g, "    ").split("\n")) };
}

// ---------- the retired tags, as Markdown ----------

const cell = (s: string) => s.trim().replace(/\|/g, "\\|");

/** `<Table cols="A|B"><Row>x|y</Row></Table>` as a GFM table. */
export function tableToMarkdown(cols: string, rows: string[]): string {
  const head = cols.split("|").map(cell);
  const body = rows.map((r) => { const c = r.split("|").map(cell); return `| ${head.map((_, i) => c[i] ?? "").join(" | ")} |`; });
  return [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...body].join("\n");
}
const ALERT_OF_TONE: Record<string, AlertKind> = { info: "NOTE", warn: "WARNING", error: "CAUTION", success: "TIP" };
/** `<Note tone="warn">x</Note>` as a GitHub alert. */
export const noteToMarkdown = (tone: string | undefined, text: string) =>
  [`> [!${ALERT_OF_TONE[tone ?? "info"] ?? "NOTE"}]`, ...text.split("\n").map((l) => `> ${l}`)].join("\n");
/** `<Link href="…">text</Link>` as an inline link. */
export const linkToMarkdown = (href: string, text: string) => `[${(text || href).replace(/[\[\]\\]/g, "\\$&")}](${href.replace(/\)/g, "%29")})`;
/** `<Code lang="sh">…</Code>` as a fenced block whose fence outruns any backticks inside. */
export function codeToMarkdown(lang: string | undefined, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(longest + 1);
  return `${f}${lang ?? ""}\n${text}\n${f}`;
}
