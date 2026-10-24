// SVG to PNG with resvg compiled to wasm: no browser, no native addon (Paseo bundles the server with esbuild, which
// cannot load a .node file, and the plugin has no node_modules). The wasm and the font travel inside the bundle.
import { gunzipSync } from "node:zlib";
import { initWasm, Resvg } from "../vendor/resvg-wasm.ts";
import { RESVG_WASM_GZ_B64 } from "../vendor/resvg-wasm-bin.ts";
import { FONTS_GZ_B64, FONT_FAMILY } from "../vendor/fonts.ts";
import { tokensFixed } from "../../shared/ui-spec.ts";

export type Theme = "light" | "dark";
export const THEMES: readonly Theme[] = ["light", "dark"];
export const WIDTH = { min: 64, max: 1600, default: 720 };

let ready: Promise<Uint8Array[]> | null = null;
function init() {
  return (ready ??= (async () => {
    await initWasm(gunzipSync(Buffer.from(RESVG_WASM_GZ_B64, "base64")));
    return FONTS_GZ_B64.map((f) => new Uint8Array(gunzipSync(Buffer.from(f, "base64"))));
  })().catch((e) => { ready = null; throw e; }));
}

export const clampWidth = (w: number | undefined) => Math.max(WIDTH.min, Math.min(WIDTH.max, Math.round(w || WIDTH.default)));

/** `svg` is trusted markup (our own rebuild, or the wrapper around a checked raster). `currentColor` becomes the theme's ink. */
export async function rasterize(svg: string, theme: Theme, width: number): Promise<{ png: Buffer; w: number; h: number }> {
  const fonts = await init();
  const ink = tokensFixed(theme).fg;
  const colored = svg.replace(/^<svg /, `<svg color="${ink}" `);
  const r = new Resvg(colored, { fitTo: { mode: "width", value: clampWidth(width) }, font: { fontBuffers: fonts, defaultFontFamily: FONT_FAMILY, sansSerifFamily: FONT_FAMILY, serifFamily: FONT_FAMILY, monospaceFamily: FONT_FAMILY, cursiveFamily: FONT_FAMILY, fantasyFamily: FONT_FAMILY }, shapeRendering: 2, textRendering: 1, imageRendering: 0 });
  try {
    const out = r.render();
    try { return { png: Buffer.from(out.asPng()), w: out.width, h: out.height }; } finally { out.free(); }
  } finally { r.free(); }
}
