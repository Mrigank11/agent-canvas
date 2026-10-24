// The canvas document model: a whitelisted, TSX-shaped vocabulary that is PARSED, never executed.
// Every consumer (native renderer, HTML renderer, honesty checks, patching) works on the Node tree
// this file produces, so nothing downstream ever sees agent-supplied code.

import { codeToMarkdown, linkToMarkdown, noteToMarkdown, parseMarkdown, tableToMarkdown } from "./markdown.ts";

export type AttrValue = string | number | boolean;
export type Node = {
  tag: string;
  id: string;
  attrs: Record<string, AttrValue>;
  /** Direct text content, whitespace-normalised (raw tags keep their line breaks). */
  text: string;
  children: Node[];
};

type AttrSpec =
  | { type: "string"; required?: boolean; max?: number }
  | { type: "number"; required?: boolean }
  | { type: "boolean"; required?: boolean }
  | { type: "enum"; values: readonly string[]; required?: boolean };

type TagSpec = {
  attrs: Record<string, AttrSpec>;
  /** Tags allowed as direct children; empty = leaf. */
  children: readonly string[];
  /** Text is meaningful (otherwise stray text is an error). */
  text: boolean;
  /** Content is taken verbatim up to the closing tag, so `<` and `{` need no escaping. */
  raw?: boolean;
  /** Overrides LIMITS.text for this tag. */
  maxText?: number;
  /** May appear only inside one of these parents. */
  parents?: readonly string[];
};

export const BLOCKS = ["Bluf", "Steps", "Progress", "Metric", "Decision", "Ask", "Markdown", "Diff", "Chart", "Table", "Link", "Note", "Code"] as const;
/** Retired in v3: still parsed for one release, then converted to a Markdown node (see `convertRetired`). */
export const RETIRED = ["Table", "Link", "Note", "Code"] as const;
export const TONES = ["info", "warn", "error", "success"] as const;
export const STEP_STATES = ["pending", "active", "done", "failed", "skipped"] as const;
export type StepState = (typeof STEP_STATES)[number];
export const CANVAS_STATUS = ["working", "done", "blocked", "waiting"] as const;

export const VOCABULARY: Record<string, TagSpec> = {
  Canvas: {
    attrs: { title: { type: "string", required: true, max: 120 }, status: { type: "enum", values: CANVAS_STATUS } },
    children: BLOCKS,
    text: false,
  },
  Bluf: { attrs: {}, children: [], text: true },
  Steps: { attrs: { title: { type: "string", max: 80 } }, children: ["Step"], text: false },
  Step: { attrs: { state: { type: "enum", values: STEP_STATES, required: true } }, children: [], text: true, parents: ["Steps"] },
  Progress: { attrs: { value: { type: "number", required: true }, max: { type: "number" }, label: { type: "string", max: 80 } }, children: [], text: false },
  Metric: { attrs: { label: { type: "string", required: true, max: 40 }, value: { type: "string", required: true, max: 40 }, tone: { type: "enum", values: TONES } }, children: [], text: false },
  Decision: { attrs: { title: { type: "string", required: true, max: 120 }, chosen: { type: "string", max: 120 } }, children: [], text: true },
  Ask: { attrs: { question: { type: "string", required: true, max: 300 }, blocking: { type: "boolean" }, answer: { type: "string", max: 300 } }, children: ["Option"], text: false },
  Option: { attrs: { value: { type: "string", required: true, max: 80 } }, children: [], text: true, parents: ["Ask"] },
  Markdown: { attrs: {}, children: [], text: true, raw: true, maxText: 8_000 },
  Diff: { attrs: { file: { type: "string", max: 200 } }, children: [], text: true, raw: true },
  Chart: { attrs: { kind: { type: "enum", values: ["bar", "line"] }, title: { type: "string", max: 80 }, data: { type: "string", required: true, max: 2000 } }, children: [], text: false },
  Table: { attrs: { cols: { type: "string", required: true, max: 400 } }, children: ["Row"], text: false },
  Row: { attrs: {}, children: [], text: true, parents: ["Table"] },
  Link: { attrs: { href: { type: "string", required: true, max: 500 } }, children: [], text: true },
  Note: { attrs: { tone: { type: "enum", values: TONES } }, children: [], text: true },
  Code: { attrs: { lang: { type: "string", max: 20 } }, children: [], text: true, raw: true },
};

export const LIMITS = { source: 32_000, nodes: 300, depth: 4, text: 4_000 };
const ID_RE = /^[a-z][a-z0-9_-]{0,31}$/i;
const ENTITIES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&apos;": "'" };
const unescape = (s: string) => s.replace(/&(lt|gt|amp|quot|apos);/g, (m) => ENTITIES[m] ?? m);

export type Problem = { message: string; line?: number; id?: string };
export type ParseResult = { ok: true; root: Node } | { ok: false; errors: Problem[] };

type RawNode = { tag: string; attrs: Record<string, AttrValue>; text: string; children: RawNode[]; line: number };

const lineOf = (src: string, pos: number) => src.slice(0, pos).split("\n").length;

/** Tokenise and build the raw tree. Collects problems rather than throwing. */
function build(src: string, errors: Problem[]): RawNode | null {
  const stack: RawNode[] = [];
  let root: RawNode | null = null;
  let i = 0;
  const textBuf = (n: RawNode, s: string) => {
    const t = unescape(s);
    n.text = n.text ? `${n.text} ${t}` : t;
  };
  const push = (n: RawNode, selfClose: boolean) => {
    const top = stack[stack.length - 1];
    if (top) top.children.push(n);
    else if (root) errors.push({ message: "only one root <Canvas> is allowed", line: n.line });
    else root = n;
    if (!selfClose) stack.push(n);
  };
  while (i < src.length) {
    if (src.startsWith("<!--", i)) {
      const end = src.indexOf("-->", i);
      if (end < 0) { errors.push({ message: "unterminated comment", line: lineOf(src, i) }); return null; }
      i = end + 3;
      continue;
    }
    if (src[i] === "<") {
      const line = lineOf(src, i);
      if (src[i + 1] === "/") {
        const m = /^<\/([A-Za-z][A-Za-z0-9]*)\s*>/.exec(src.slice(i));
        if (!m) { errors.push({ message: "malformed closing tag", line }); return null; }
        const top = stack.pop();
        if (!top || top.tag !== m[1]) { errors.push({ message: `closing </${m[1]}> does not match ${top ? `<${top.tag}>` : "an open tag"}`, line }); return null; }
        i += m[0].length;
        continue;
      }
      const open = /^<([A-Za-z][A-Za-z0-9]*)/.exec(src.slice(i));
      if (!open) { errors.push({ message: 'stray "<" (write &lt; for a literal)', line }); return null; }
      const tag = open[1];
      let j = i + open[0].length;
      const attrs: Record<string, AttrValue> = {};
      for (;;) {
        while (/\s/.test(src[j] ?? "")) j++;
        if (j >= src.length) { errors.push({ message: `unterminated <${tag}> tag`, line }); return null; }
        if (src[j] === ">") { j++; break; }
        if (src.startsWith("/>", j)) { j += 2; break; }
        const am = /^([A-Za-z][A-Za-z0-9-]*)/.exec(src.slice(j));
        if (!am) { errors.push({ message: `bad attribute in <${tag}>`, line: lineOf(src, j) }); return null; }
        const name = am[1];
        j += name.length;
        if (src[j] !== "=") { attrs[name] = true; continue; }
        j++;
        const q = src[j];
        if (q === '"' || q === "'") {
          const end = src.indexOf(q, j + 1);
          if (end < 0) { errors.push({ message: `unterminated string for ${name}=`, line: lineOf(src, j) }); return null; }
          attrs[name] = unescape(src.slice(j + 1, end));
          j = end + 1;
        } else if (q === "{") {
          const end = src.indexOf("}", j);
          const expr = end < 0 ? "" : src.slice(j + 1, end).trim();
          if (end < 0 || !/^(-?\d+(\.\d+)?|true|false|"[^"\n]*"|'[^'\n]*')$/.test(expr)) {
            errors.push({ message: `${name}={…} accepts only a number, true/false or a string literal; expressions are never evaluated`, line: lineOf(src, j) });
            return null;
          }
          attrs[name] = expr === "true" ? true : expr === "false" ? false : /^-?\d/.test(expr) ? Number(expr) : unescape(expr.slice(1, -1));
          j = end + 1;
        } else { errors.push({ message: `${name}= needs a quoted string or {value}`, line: lineOf(src, j) }); return null; }
      }
      const selfClose = src[j - 2] === "/" && src[j - 1] === ">";
      const node: RawNode = { tag, attrs, text: "", children: [], line };
      push(node, selfClose);
      i = j;
      if (!selfClose && VOCABULARY[tag]?.raw) {
        const close = src.indexOf(`</${tag}>`, i);
        if (close < 0) { errors.push({ message: `<${tag}> is never closed`, line }); return null; }
        node.text = src.slice(i, close).replace(/^\n/, "").replace(/\s+$/, "");
        stack.pop();
        i = close + tag.length + 3;
      }
      continue;
    }
    const next = src.indexOf("<", i);
    const chunk = src.slice(i, next < 0 ? src.length : next);
    const trimmed = chunk.replace(/\s+/g, " ").trim();
    if (trimmed) {
      const top = stack[stack.length - 1];
      if (!top) { errors.push({ message: "text outside the root <Canvas>", line: lineOf(src, i) }); return null; }
      textBuf(top, trimmed);
    }
    i = next < 0 ? src.length : next;
  }
  if (stack.length) { errors.push({ message: `<${stack[stack.length - 1].tag}> is never closed`, line: stack[stack.length - 1].line }); return null; }
  if (!root) errors.push({ message: "empty canvas: expected a <Canvas title=…> root" });
  return root;
}

function checkAttrs(spec: TagSpec, tag: string, attrs: Record<string, AttrValue>, errors: Problem[], where: { line?: number; id?: string }) {
  for (const [name, v] of Object.entries(attrs)) {
    if (name === "id") {
      if (typeof v !== "string" || !ID_RE.test(v)) errors.push({ message: `<${tag}> id must be letters/digits/-/_ starting with a letter (max 32)`, ...where });
      continue;
    }
    const a = spec.attrs[name];
    if (!a) { errors.push({ message: `<${tag}> has no attribute "${name}" (allowed: ${["id", ...Object.keys(spec.attrs)].join(", ")})`, ...where }); continue; }
    if (a.type === "number" && typeof v !== "number") errors.push({ message: `<${tag}> ${name} must be a number, write ${name}={3}`, ...where });
    else if (a.type === "boolean" && typeof v !== "boolean") errors.push({ message: `<${tag}> ${name} must be a boolean, write ${name} or ${name}={true}`, ...where });
    else if (a.type === "string" && (typeof v !== "string" || (a.max && v.length > a.max))) errors.push({ message: `<${tag}> ${name} must be a string${a.max ? ` of at most ${a.max} characters` : ""}`, ...where });
    else if (a.type === "enum" && !a.values.includes(String(v))) errors.push({ message: `<${tag}> ${name}="${v}" is not one of ${a.values.join(" | ")}`, ...where });
  }
  for (const [name, a] of Object.entries(spec.attrs)) if (a.required && !(name in attrs)) errors.push({ message: `<${tag}> needs ${name}`, ...where });
}

function finish(raw: RawNode, parent: string | null, depth: number, ids: Set<string>, counts: Map<string, number>, total: { n: number }, errors: Problem[]): Node {
  const where = { line: raw.line };
  const spec = VOCABULARY[raw.tag];
  total.n++;
  const n = (counts.get(raw.tag) ?? 0) + 1;
  counts.set(raw.tag, n);
  let id = typeof raw.attrs.id === "string" ? raw.attrs.id : `${raw.tag.toLowerCase()}${n}`;
  if (typeof raw.attrs.id !== "string") for (let k = n; ids.has(id); ) id = `${raw.tag.toLowerCase()}${++k}`;
  const node: Node = { tag: raw.tag, id, attrs: {}, text: raw.text, children: [] };
  if (!spec) {
    errors.push({ message: `<${raw.tag}> is not in the vocabulary (allowed: ${Object.keys(VOCABULARY).join(", ")})`, ...where });
    return node;
  }
  if (depth > LIMITS.depth) errors.push({ message: `nesting deeper than ${LIMITS.depth} levels`, ...where });
  if (raw.tag === "Canvas" ? parent !== null : parent === null) errors.push({ message: raw.tag === "Canvas" ? "<Canvas> must be the root" : "root must be <Canvas>", ...where });
  else if (spec.parents && !spec.parents.includes(parent ?? "")) errors.push({ message: `<${raw.tag}> must be inside <${spec.parents.join(" or ")}>`, ...where });
  else if (parent && VOCABULARY[parent] && !VOCABULARY[parent].children.includes(raw.tag)) errors.push({ message: `<${raw.tag}> is not allowed inside <${parent}>`, ...where });
  if (ids.has(id)) { errors.push({ message: `duplicate id "${id}"`, ...where, id }); id = `${id}~${total.n}`; node.id = id; }
  ids.add(id);
  checkAttrs(spec, raw.tag, raw.attrs, errors, { ...where, id });
  for (const [k, v] of Object.entries(raw.attrs)) if (k !== "id") node.attrs[k] = v;
  if (raw.text && !spec.text) errors.push({ message: `<${raw.tag}> cannot contain text ("${raw.text.slice(0, 30)}…")`, ...where, id });
  const maxText = spec.maxText ?? LIMITS.text;
  if (raw.text.length > maxText) errors.push({ message: `<${raw.tag}> text is over ${maxText} characters`, ...where, id });
  if (raw.tag === "Markdown") { const md = parseMarkdown(raw.text); if (!md.ok) errors.push({ message: `<Markdown>: ${md.error}`, ...where, id }); }
  if (raw.tag === "Link" && !/^https?:\/\//i.test(String(raw.attrs.href ?? ""))) errors.push({ message: "<Link> href must start with http:// or https://", ...where, id });
  for (const c of raw.children) node.children.push(finish(c, raw.tag, depth + 1, ids, counts, total, errors));
  if (raw.tag === "Ask" && node.children.length < 1) errors.push({ message: "<Ask> needs at least one <Option>", ...where, id });
  if (raw.tag === "Chart" && chartPoints(String(raw.attrs.data ?? "")) === null) errors.push({ message: 'Chart data must look like "a:1,b:2.5"', ...where, id });
  return node;
}

export function parseCanvas(source: string): ParseResult {
  const errors: Problem[] = [];
  if (source.length > LIMITS.source) return { ok: false, errors: [{ message: `canvas source is over ${LIMITS.source} characters` }] };
  const raw = build(source, errors);
  if (errors.length || !raw) return { ok: false, errors: errors.length ? errors : [{ message: "could not parse the canvas" }] };
  const total = { n: 0 };
  const root = finish(raw, null, 0, new Set(), new Map(), total, errors);
  if (total.n > LIMITS.nodes) errors.push({ message: `more than ${LIMITS.nodes} elements` });
  if (!errors.length) convertRetired(root, errors);
  return errors.length ? { ok: false, errors } : { ok: true, root };
}

/**
 * Table, Link, Note and Code are retired: they validate as before, then become the equivalent <Markdown> node
 * (same id), so every tree downstream, including patch round-trips, only ever sees the new vocabulary.
 */
function convertRetired(root: Node, errors: Problem[]) {
  const markdown = (n: Node, text: string): Node => {
    const md = parseMarkdown(text);
    if (!md.ok) errors.push({ message: `<${n.tag}> id "${n.id}": ${md.error}`, id: n.id });
    return { tag: "Markdown", id: n.id, attrs: {}, text, children: [] };
  };
  root.children = root.children.map((n) => {
    switch (n.tag) {
      case "Table": return markdown(n, tableToMarkdown(String(n.attrs.cols), n.children.map((r) => r.text)));
      case "Note": return markdown(n, noteToMarkdown(n.attrs.tone as string | undefined, n.text));
      case "Link": return markdown(n, linkToMarkdown(String(n.attrs.href), n.text));
      case "Code": return markdown(n, codeToMarkdown(n.attrs.lang as string | undefined, n.text));
      default: return n;
    }
  });
}

/** "a:1,b:2" → points; null when malformed. */
export function chartPoints(data: string): { label: string; value: number }[] | null {
  const out: { label: string; value: number }[] = [];
  for (const part of data.split(",")) {
    const k = part.lastIndexOf(":");
    const label = part.slice(0, k).trim();
    const value = Number(part.slice(k + 1));
    if (k < 1 || !label || !Number.isFinite(value)) return null;
    out.push({ label, value });
  }
  return out.length ? out : null;
}

// ---------- serialise (canvas_get, tests) ----------

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const escText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

export function serialize(n: Node, indent = ""): string {
  const attrs = [`id="${n.id}"`, ...Object.entries(n.attrs).map(([k, v]) => (typeof v === "string" ? `${k}="${esc(v)}"` : `${k}={${v}}`))].join(" ");
  const spec = VOCABULARY[n.tag];
  if (!n.children.length && !n.text) return `${indent}<${n.tag} ${attrs} />`;
  const open = `${indent}<${n.tag} ${attrs}>`;
  if (!n.children.length) return spec?.raw ? `${open}\n${n.text}\n${indent}</${n.tag}>` : `${open}${escText(n.text)}</${n.tag}>`;
  return `${open}\n${n.children.map((c) => serialize(c, indent + "  ")).join("\n")}\n${indent}</${n.tag}>`;
}

// ---------- patching ----------

export type PatchOp =
  | { id: string; set?: Record<string, AttrValue | null>; text?: string; remove?: boolean }
  | { parent: string; append: string };

export function findNode(root: Node, id: string): Node | null {
  if (root.id === id) return root;
  for (const c of root.children) { const f = findNode(c, id); if (f) return f; }
  return null;
}
function findParent(root: Node, id: string): Node | null {
  for (const c of root.children) { if (c.id === id) return root; const f = findParent(c, id); if (f) return f; }
  return null;
}
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** Apply every op to a copy and re-validate the whole tree through the same parser; all or nothing. */
export function patchCanvas(root: Node, ops: PatchOp[]): ParseResult {
  if (!ops.length) return { ok: false, errors: [{ message: "no patch operations given" }] };
  const work = clone(root);
  const errors: Problem[] = [];
  for (const [i, op] of ops.entries()) {
    const at = `op ${i + 1}`;
    if ("append" in op) {
      const parent = findNode(work, op.parent);
      if (!parent) { errors.push({ message: `${at}: no element with id "${op.parent}"` }); continue; }
      const frag = parseFragment(op.append, work);
      if (!frag.ok) { errors.push(...frag.errors.map((e) => ({ ...e, message: `${at}: ${e.message}` }))); continue; }
      parent.children.push(frag.node);
      continue;
    }
    const target = findNode(work, op.id);
    if (!target) { errors.push({ message: `${at}: no element with id "${op.id}"` }); continue; }
    if (op.remove) {
      const p = findParent(work, op.id);
      if (!p) { errors.push({ message: `${at}: the root <Canvas> cannot be removed` }); continue; }
      p.children = p.children.filter((c) => c.id !== op.id);
      continue;
    }
    for (const [k, v] of Object.entries(op.set ?? {})) {
      if (k === "id") { errors.push({ message: `${at}: ids cannot be changed` }); continue; }
      if (v === null) delete target.attrs[k]; else target.attrs[k] = v;
    }
    if (op.text !== undefined) target.text = op.text;
  }
  if (errors.length) return { ok: false, errors };
  // Round-trip through the parser so a patch can never produce a tree a set could not.
  const again = parseCanvas(serialize(work));
  return again.ok ? again : { ok: false, errors: again.errors.map((e) => ({ ...e, message: `after patch: ${e.message}` })) };
}

function parseFragment(src: string, existing: Node): { ok: true; node: Node } | { ok: false; errors: Problem[] } {
  const errors: Problem[] = [];
  const raw = build(src, errors);
  if (errors.length || !raw) return { ok: false, errors: errors.length ? errors : [{ message: "empty fragment" }] };
  const ids = new Set<string>();
  walk(existing, (n) => ids.add(n.id));
  // Context, attribute and duplicate-id rules are enforced by the full re-parse after the append;
  // here the fragment only needs ids that cannot collide with the canvas it joins.
  const node = finish(raw, "__fragment__", 1, ids, new Map(), { n: 0 }, []);
  return { ok: true, node };
}

/** Walk every node. */
export function walk(n: Node, f: (n: Node) => void) { f(n); n.children.forEach((c) => walk(c, f)); }
