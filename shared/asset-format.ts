// Which form of a picture a client asks for. Phones get PNGs rasterised on the server. The browser UI and the desktop
// app (the same web bundle, react-native-web underneath) can draw a vector, so a drawing arrives as the sanitised SVG
// and is shown through an <img>-style data URI: never inlined into the host page, so nothing in it can run or reach the app.

export type AssetFormat = "png" | "svg";

/** `os` is react-native's Platform.OS; only "web" (browser and Electron) draws vectors. `vector` is false for rasters (Image, Markdown images). */
export function assetFormat(os: string, vector: boolean): AssetFormat {
  return vector && os === "web" ? "svg" : "png";
}

/** One request per hash, theme and size bucket; a vector has no size bucket, it is the same bytes at any width. */
export function assetKey(hash: string, dark: boolean, width: number, format: AssetFormat): string {
  return format === "svg" ? `${hash}:svg:${dark ? "d" : "l"}` : `${hash}:${dark ? "d" : "l"}:${width}`;
}
