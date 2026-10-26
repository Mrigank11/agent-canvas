import { readFileSync } from "node:fs";
import { join } from "node:path";

export const LOCAL_CONFIG = "agent-canvas.local.json";

/** The two URLs clients are sent to: env vars first, then `agent-canvas.local.json` in the plugin dir, then localhost. */
export function resolveUrls(env: Record<string, string | undefined>, dir: string, port: number): { publicUrl: string; appUrl: string } {
  let local: { publicUrl?: unknown; appUrl?: unknown } = {};
  try { local = JSON.parse(readFileSync(join(dir, LOCAL_CONFIG), "utf8")) ?? {}; } catch {}
  const pick = (...v: unknown[]) => v.find((x): x is string => typeof x === "string" && x !== "");
  const strip = (s: string) => s.replace(/\/$/, "");
  return {
    publicUrl: strip(pick(env.AGENT_CANVAS_PUBLIC_URL, local.publicUrl) ?? `http://127.0.0.1:${port}`),
    appUrl: strip(pick(env.AGENT_CANVAS_APP_URL, local.appUrl) ?? "http://127.0.0.1:6781"),
  };
}
