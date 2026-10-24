// Who gets a canvas. One resolver, used by the daemon hooks, the hub and the settings screen.
//
//   per-agent override  >  global switch  >  default
//
// The override is set per agent: by env `AGENT_CANVAS=on|off` at creation (CLI, SDK), by label `canvas=on|off`
// (the only thing the MCP create_agent tool can set), or later from the Canvas pill. The latest explicit one wins.
import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const ENV_KEY = "AGENT_CANVAS";
export const LABEL_KEY = "canvas";

/** Host-wide defaults, editable under Settings > Plugins > Agent canvas. */
export const canvasSettings = defineSettings({
  id: "canvas",
  scope: "host",
  version: 1,
  schema: z.object({
    /** Give every new agent the canvas tools. Off by default: a canvas is opt-in per agent. */
    defaultOn: z.boolean().default(false),
    /** Show a canvas built from the timeline for agents that never write one (and have no override). */
    autoCanvas: z.boolean().default(true),
  }),
});
export type CanvasPolicy = z.output<typeof canvasSettings.schema>;
export const DEFAULT_POLICY: CanvasPolicy = { defaultOn: false, autoCanvas: true };

export type Override = "on" | "off";

/** "on"/"true"/"1"/"yes" and "off"/"false"/"0"/"no" (any case); anything else is no override. */
export function parseOverride(raw: unknown): Override | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return "on";
  if (["off", "false", "0", "no"].includes(v)) return "off";
  return null;
}

/** The first explicit override among the sources, latest first. */
export function firstOverride(...sources: unknown[]): Override | null {
  for (const s of sources) {
    const o = parseOverride(s);
    if (o) return o;
  }
  return null;
}

export type Resolved = {
  /** The agent is given canvas_set / canvas_patch (at creation, or the curl recipe afterwards). */
  tools: boolean;
  /** The agent appears anywhere (pane card, side panel, Canvases list, browser). */
  show: boolean;
  /** While it has written nothing, show a canvas built from its timeline. */
  auto: boolean;
};

/**
 *  override on   -> tools, shown, auto until it writes
 *  override off  -> nothing at all: no tools, no auto canvas, hidden
 *  no override   -> tools follow `defaultOn`; the auto canvas follows `autoCanvas` (and is implied by `defaultOn`)
 * "Off" therefore means: no tools and, unless the auto toggle is on, no canvas of any kind for the agent.
 */
export function resolveCanvas(override: Override | null, policy: CanvasPolicy): Resolved {
  if (override === "on") return { tools: true, show: true, auto: true };
  if (override === "off") return { tools: false, show: false, auto: false };
  const auto = policy.defaultOn || policy.autoCanvas;
  return { tools: policy.defaultOn, show: auto, auto };
}
