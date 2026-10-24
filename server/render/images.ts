// <Image> and Markdown images: a file in the agent's own workspace, checked by what its bytes are, never by its name.
// The path is resolved with realpath (so a symlink out of the workspace is refused), the type is read from magic bytes,
// the size from the header, and the bytes that were checked are the bytes that get cached and served. No URLs: the
// daemon never fetches anything on an agent's behalf, so a canvas cannot make it reach the tailnet.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const IMAGE_LIMITS = { bytes: 3 * 1024 * 1024, side: 4096 };
export type Mime = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type WorkspaceImage = { bytes: Buffer; mime: Mime; w: number; h: number };
export type ImageResult = ({ ok: true } & WorkspaceImage) | { ok: false; error: string };

const u16 = (b: Buffer, o: number) => b.readUInt16LE(o);

/** Type and pixel size from the header alone; null when the bytes are not one of the four formats. */
export function sniffImage(b: Buffer): { mime: Mime; w: number; h: number } | { mime: null; why: string } {
  const bad = (why: string) => ({ mime: null, why }) as const;
  if (b.length >= 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    if (b.toString("latin1", 12, 16) !== "IHDR") return bad("a damaged PNG");
    return { mime: "image/png", w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
  }
  if (b.length >= 10 && (b.toString("latin1", 0, 6) === "GIF87a" || b.toString("latin1", 0, 6) === "GIF89a")) return { mime: "image/gif", w: u16(b, 6), h: u16(b, 8) };
  if (b.length >= 30 && b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") {
    const kind = b.toString("latin1", 12, 16);
    if (kind === "VP8 ") return { mime: "image/webp", w: u16(b, 26) & 0x3fff, h: u16(b, 28) & 0x3fff };
    if (kind === "VP8L") { const v = b.readUInt32LE(21); return { mime: "image/webp", w: (v & 0x3fff) + 1, h: ((v >> 14) & 0x3fff) + 1 }; }
    if (kind === "VP8X") return { mime: "image/webp", w: b.readUIntLE(24, 3) + 1, h: b.readUIntLE(27, 3) + 1 };
    return bad("a damaged WebP");
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) { i++; continue; }
      const m = b[i + 1];
      if (m === 0xff) { i++; continue; }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
      const len = b.readUInt16BE(i + 2);
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { mime: "image/jpeg", h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
      i += 2 + len;
    }
    return bad("a JPEG whose size could not be read");
  }
  const head = b.toString("utf8", 0, 256).trimStart();
  if (/^(<\?xml|<svg)/i.test(head)) return bad("an SVG (draw it with <Svg>, which is checked and rebuilt)");
  return bad("not a PNG, JPEG, WebP or GIF");
}

/** Read `src` (relative to the workspace, or absolute inside it) as an image the canvas may show. */
export function readWorkspaceImage(cwd: string | null, src: string): ImageResult {
  if (!src) return { ok: false, error: "the image path is empty" };
  if (!cwd) return { ok: false, error: "this agent's workspace is not known yet, try again in a moment" };
  if (/^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//")) return { ok: false, error: `"${src.slice(0, 60)}" is a URL: images must be files in your workspace (save it there and use its path)` };
  let root: string, real: string;
  try { root = realpathSync(cwd); } catch { return { ok: false, error: "this agent's workspace folder is not readable" }; }
  try { real = realpathSync(resolve(root, src)); } catch { return { ok: false, error: `no such file in the workspace: ${src}` }; }
  const rel = relative(root, real);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return { ok: false, error: `${src} is outside the workspace: only files inside it can be shown` };
  let st;
  try { st = statSync(real); } catch { return { ok: false, error: `cannot read ${src}` }; }
  if (!st.isFile()) return { ok: false, error: `${src} is not a file` };
  if (st.size > IMAGE_LIMITS.bytes) return { ok: false, error: `${src} is ${(st.size / 1048576).toFixed(1)} MB: the limit is ${IMAGE_LIMITS.bytes / 1048576} MB` };
  let bytes: Buffer;
  try { bytes = readFileSync(real); } catch { return { ok: false, error: `cannot read ${src}` }; }
  if (bytes.length > IMAGE_LIMITS.bytes) return { ok: false, error: `${src} is over ${IMAGE_LIMITS.bytes / 1048576} MB` };
  const s = sniffImage(bytes);
  if (s.mime === null) return { ok: false, error: `${src} is ${s.why}` };
  if (!(s.w > 0 && s.h > 0)) return { ok: false, error: `${src}: could not read the image size` };
  if (s.w > IMAGE_LIMITS.side || s.h > IMAGE_LIMITS.side) return { ok: false, error: `${src} is ${s.w}×${s.h}: the limit is ${IMAGE_LIMITS.side} px a side` };
  return { ok: true, bytes, mime: s.mime, w: s.w, h: s.h };
}
