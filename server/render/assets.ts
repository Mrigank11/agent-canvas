// The render pipeline. Each rich block (an <Svg>, an <Image>, a Markdown image) goes through one RichRenderer: it
// validates the agent's input (atomically, errors go back to the agent), makes a content-addressed artefact, and can
// later give the browser safe markup/bytes or the phone a PNG. Artefacts are keyed by sha256 of what was checked and
// cached on disk, so the timeline row only ever carries hashes, never the drawing.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { walk, type Node } from "../../shared/canvas.ts";
import { imagesOf, parseMarkdown } from "../../shared/markdown.ts";
import { sanitizeSvg } from "../../shared/svg.ts";
import { readWorkspaceImage, sniffImage, type Mime } from "./images.ts";
import { clampWidth, rasterize, type Theme } from "./raster.ts";

export const HASH_RE = /^[0-9a-f]{32}$/;
const hashOf = (...parts: (string | Buffer)[]) => { const h = createHash("sha256"); for (const p of parts) { h.update(p); h.update("\0"); } return h.digest("hex").slice(0, 32); };

/** What a renderer makes from one block's input. `w`/`h` are the natural size, for layout before the bytes arrive. */
export type Artefact = { hash: string; w: number; h: number };
export type Ctx = { cwd: string | null };
export type Validated = { ok: true; art: Artefact; notes: string[] } | { ok: false; error: string };

/**
 * One rich format. `validate` is synchronous because canvas_set is: a block that cannot render fails the tool call.
 * `inline` is the browser form, `raster` the native one; DOT (S3) and Vega-Lite (S4) will be two more of these,
 * both ending in SVG, so they reuse `rasterize` and the svg renderer's `inline`.
 */
export interface RichRenderer<In> {
  readonly name: string;
  validate(input: In, ctx: Ctx): Validated;
  /** Markup safe to place in the page, or null when the artefact is gone. */
  inline(hash: string): string | null;
  raster(hash: string, theme: Theme, width: number): Promise<{ mime: string; bytes: Buffer; w: number; h: number } | null>;
}

const MIME_EXT: Record<Mime, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

export type WireAsset = { hash: string; w: number; h: number };

export class Assets {
  private svgs = new Map<string, { svg: string; w: number; h: number }>();
  private images = new Map<string, { bytes: Buffer; mime: Mime; w: number; h: number }>();
  private pngs = new Map<string, Promise<{ bytes: Buffer; w: number; h: number }>>();
  /** workspace image lookups, by cwd + path: a hot path (every view), refreshed at most every few seconds */
  private memo = new Map<string, { at: number; res: ReturnType<typeof readWorkspaceImage>; hash?: string }>();

  private dir: string | null;
  private now: () => number;

  constructor(dir: string | null = null, now: () => number = Date.now) {
    this.dir = dir;
    this.now = now;
    if (dir) this.prune();
  }

  // ---------- disk cache ----------

  private path(...p: string[]) { return join(this.dir!, ...p); }
  private put(sub: string, name: string, data: Buffer | string) {
    if (!this.dir) return;
    try {
      mkdirSync(this.path(sub), { recursive: true });
      const tmp = `${this.path(sub, name)}.${process.pid}.tmp`;
      writeFileSync(tmp, data);
      renameSync(tmp, this.path(sub, name));
    } catch { /* a cache that cannot be written is only slower */ }
  }
  private get(sub: string, name: string): Buffer | null {
    if (!this.dir) return null;
    try { return readFileSync(this.path(sub, name)); } catch { return null; }
  }
  /** Drop cached files not touched for a week, once at start-up. */
  private prune() {
    const cutoff = this.now() - 7 * 86_400_000;
    for (const sub of ["png", "img"]) {
      try {
        for (const f of readdirSync(this.path(sub))) {
          try { if (statSync(this.path(sub, f)).mtimeMs < cutoff) unlinkSync(this.path(sub, f)); } catch { /* raced */ }
        }
      } catch { /* no cache yet */ }
    }
  }

  // ---------- the two renderers ----------

  readonly svg: RichRenderer<string> = {
    name: "svg",
    validate: (body) => {
      const r = sanitizeSvg(body);
      if (!r.ok) return { ok: false, error: r.error };
      const hash = hashOf("svg1", body);
      this.svgs.set(hash, { svg: r.svg, w: r.w, h: r.h });
      return { ok: true, art: { hash, w: r.w, h: r.h }, notes: r.dropped.length ? [`removed ${r.dropped.join(", ")}`] : [] };
    },
    inline: (hash) => this.svgs.get(hash)?.svg ?? null,
    raster: async (hash, theme, width) => {
      const e = this.svgs.get(hash);
      if (!e) return null;
      const w = clampWidth(width);
      const r = await this.cachedPng(`${hash}-${theme}-${w}`, () => rasterize(e.svg, theme, w));
      return { mime: "image/png", bytes: r.bytes, w: r.w, h: r.h };
    },
  };

  readonly image: RichRenderer<string> = {
    name: "image",
    validate: (src, ctx) => {
      const m = this.workspaceImage(ctx.cwd, src);
      const r = m.res;
      if (!r.ok) return { ok: false, error: r.error };
      // hashed and copied once per look at the file: wire() asks on every view
      if (!m.hash) {
        m.hash = hashOf("img1", r.bytes);
        if (!this.images.has(m.hash)) this.put("img", `${m.hash}.${MIME_EXT[r.mime]}`, r.bytes);
      }
      this.images.set(m.hash, { bytes: r.bytes, mime: r.mime, w: r.w, h: r.h });
      return { ok: true, art: { hash: m.hash, w: r.w, h: r.h }, notes: [] };
    },
    inline: () => null,
    raster: async (hash, theme, width) => {
      const im = this.images.get(hash);
      if (!im) return null;
      const w = clampWidth(width);
      // small enough and not animated: hand the phone the file as it is
      if (im.mime !== "image/gif" && im.bytes.length <= 300_000 && im.w <= w) return { mime: im.mime, bytes: im.bytes, w: im.w, h: im.h };
      const wrapper = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${im.w} ${im.h}"><image width="${im.w}" height="${im.h}" xlink:href="data:${im.mime};base64,${im.bytes.toString("base64")}"/></svg>`;
      const out = Math.min(w, im.w);
      const r = await this.cachedPng(`${hash}-${out}`, () => rasterize(wrapper, theme, out));
      return { mime: "image/png", bytes: r.bytes, w: r.w, h: r.h };
    },
  };

  private cachedPng(key: string, make: () => Promise<{ png: Buffer; w: number; h: number }>) {
    let p = this.pngs.get(key);
    if (!p) {
      p = (async () => {
        const disk = this.get("png", `${key}.png`);
        if (disk && disk.length > 24) return { bytes: disk, w: disk.readUInt32BE(16), h: disk.readUInt32BE(20) };
        const r = await make();
        this.put("png", `${key}.png`, r.png);
        return { bytes: r.png, w: r.w, h: r.h };
      })();
      this.pngs.set(key, p);
      p.catch(() => this.pngs.delete(key));
      if (this.pngs.size > 64) this.pngs.delete(this.pngs.keys().next().value!);
    }
    return p;
  }

  private workspaceImage(cwd: string | null, src: string) {
    const key = `${cwd}\0${src}`;
    const hit = this.memo.get(key);
    if (hit && this.now() - hit.at < 3000) return hit;
    const entry: { at: number; res: ReturnType<typeof readWorkspaceImage>; hash?: string } = { at: this.now(), res: readWorkspaceImage(cwd, src) };
    this.memo.set(key, entry);
    if (this.memo.size > 200) this.memo.delete(this.memo.keys().next().value!);
    return entry;
  }

  // ---------- over a whole canvas ----------

  /** After `parseCanvas`: every image must resolve inside the workspace. (Svg is validated by the parser itself; this registers it and reports what was removed.) */
  check(root: Node, cwd: string | null): { ok: true; notes: string[] } | { ok: false; errors: string[] } {
    const errors: string[] = [], notes: string[] = [];
    walk(root, (n) => {
      if (n.tag === "Svg") {
        const v = this.svg.validate(n.text, { cwd });
        if (!v.ok) errors.push(`<Svg id="${n.id}">: ${v.error}`); else for (const x of v.notes) notes.push(`<Svg id="${n.id}"> ${x}`);
      } else if (n.tag === "Image") {
        this.memo.delete(`${cwd}\0${String(n.attrs.src)}`); // a write is the moment to look at the file afresh
        const v = this.image.validate(String(n.attrs.src), { cwd });
        if (!v.ok) errors.push(`<Image id="${n.id}">: ${v.error}`);
      } else if (n.tag === "Markdown") {
        const md = parseMarkdown(n.text);
        if (md.ok) for (const im of imagesOf(md.blocks)) {
          this.memo.delete(`${cwd}\0${im.src}`);
          const v = this.image.validate(im.src, { cwd });
          if (!v.ok) errors.push(`<Markdown id="${n.id}"> image ![${im.alt.slice(0, 30)}](${im.src.slice(0, 80)}): ${v.error}`);
        }
      }
    });
    return errors.length ? { ok: false, errors } : { ok: true, notes };
  }

  /**
   * The tree as the clients get it: drawings and images carry hashes and sizes instead of bodies, so the timeline row
   * stays small whatever the canvas holds. A tree is never changed in place.
   */
  wire(root: Node, cwd: string | null): Node {
    const one = (n: Node): Node => {
      const children = n.children.map(one);
      if (n.tag === "Svg") {
        const v = this.svg.validate(n.text, { cwd });
        return { ...n, text: "", children, attrs: v.ok ? { ...n.attrs, hash: v.art.hash, w: v.art.w, h: v.art.h } : { ...n.attrs } };
      }
      if (n.tag === "Image") {
        const v = this.image.validate(String(n.attrs.src), { cwd });
        return { ...n, children, attrs: v.ok ? { ...n.attrs, hash: v.art.hash, w: v.art.w, h: v.art.h } : { ...n.attrs } };
      }
      if (n.tag === "Markdown") {
        const md = parseMarkdown(n.text);
        const found: Record<string, WireAsset> = {};
        if (md.ok) for (const im of imagesOf(md.blocks)) { const v = this.image.validate(im.src, { cwd }); if (v.ok) found[im.src] = v.art; }
        return Object.keys(found).length ? { ...n, children, attrs: { ...n.attrs, assets: JSON.stringify(found) } } : { ...n, children };
      }
      return children.length ? { ...n, children } : n;
    };
    return one(root);
  }

  // ---------- serving ----------

  /** A cached original, for the browser's <img>. */
  file(hash: string): { mime: Mime; bytes: Buffer } | null {
    if (!HASH_RE.test(hash)) return null;
    const m = this.images.get(hash);
    if (m) return { mime: m.mime, bytes: m.bytes };
    for (const [mime, ext] of Object.entries(MIME_EXT) as [Mime, string][]) {
      const b = this.get("img", `${hash}.${ext}`);
      if (b) return { mime, bytes: b };
    }
    return null;
  }
  inlineSvg(hash: string): string | null { return HASH_RE.test(hash) ? this.svg.inline(hash) : null; }

  /** What the phone shows for a hash: a PNG (or the small original) as base64. */
  async asset(hash: string, theme: Theme, width: number): Promise<{ mime: string; base64: string; w: number; h: number } | null> {
    if (!HASH_RE.test(hash)) return null;
    if (!this.images.has(hash) && !this.svgs.has(hash)) {
      // after a restart the in-memory entry is gone: images come back from the disk cache, drawings from the next wire()
      const f = this.file(hash);
      const s = f && sniff(f.bytes);
      if (f && s) this.images.set(hash, { bytes: f.bytes, mime: f.mime, w: s.w, h: s.h });
    }
    const r = this.svgs.has(hash) ? await this.svg.raster(hash, theme, width) : await this.image.raster(hash, theme, width);
    return r ? { mime: r.mime, base64: r.bytes.toString("base64"), w: r.w, h: r.h } : null;
  }
}

const sniff = (b: Buffer) => { const s = sniffImage(b); return s.mime ? s : null; };
