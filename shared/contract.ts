import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Node } from "./canvas.ts";

export const ROW_KIND = "agent-canvas";
export const ROW_VERSION = 1;
export const ROW_ID = "canvas";
/** How many timeline items may pile up under the canvas row before it is moved back to the bottom. */
export const REANCHOR_AFTER = 6;

const nodeSchema = z.custom<Node>((v) => typeof v === "object" && v !== null && typeof (v as Node).tag === "string" && Array.isArray((v as Node).children));

/** A background job the agent started and is waiting on (Claude Code only). Times are the hub's first-seen stamps. */
export const bgJob = z.object({
  /** Claude's task id, or the launching call's id for a job whose start was not recognised. */
  id: z.string(),
  kind: z.enum(["shell", "monitor", "subagent"]),
  command: z.string(),
  description: z.string().optional(),
  state: z.enum(["running", "done", "failed", "killed", "lost"]),
  exitCode: z.number().nullable().optional(),
  startedAt: z.number(),
  /** The job was already running when the plugin first looked: its age is a lower bound ("≥ 3m"). */
  approx: z.boolean().optional(),
  /** Only the end was seen (the start wording was not recognised). */
  unrecognised: z.boolean().optional(),
  endedAt: z.number().optional(),
  /** Monitor: the last event line, how many have come, and when the watch expires ("28m"). */
  lastEvent: z.string().optional(),
  events: z.number().optional(),
  expires: z.string().optional(),
});
export type BgJob = z.output<typeof bgJob>;

/** One agent's canvas as the renderers see it. The same value is the timeline row data and the RPC output. */
export const canvasView = z.object({
  agentId: z.string(),
  /** The workspace the agent lives in; the side panel shows the canvases of its own workspace. */
  workspaceId: z.string().nullable(),
  title: z.string(),
  tree: nodeSchema,
  /** True when the agent never wrote a canvas and this one was derived from its timeline. */
  auto: z.boolean(),
  /** ms epoch of the agent's last canvas.set/patch; null for an auto canvas. */
  updatedAt: z.number().nullable(),
  callsAtUpdate: z.number(),
  callsNow: z.number(),
  /** Run state when the server last looked; clients prefer the live value from Paseo. */
  runState: z.enum(["initializing", "idle", "running", "error", "closed"]),
  /** The call the agent is running right now, structured, with the time the hub first saw it running. */
  activity: z.object({ kind: z.enum(["shell", "edit", "write", "read", "search", "fetch", "other"]), name: z.string(), command: z.string().optional(), path: z.string().optional(), url: z.string().optional(), query: z.string().optional(), startedAt: z.number() }).nullable().default(null),
  /** The last three finished actions (newest first), as past-tense labels. Canvas bookkeeping is left out. */
  recent: z.array(z.object({ kind: z.enum(["shell", "edit", "write", "read", "search", "fetch", "other"]), label: z.string(), ok: z.boolean(), exitCode: z.number().nullable().optional(), endedAt: z.number() })).max(3).default([]),
  /** The background jobs the agent is waiting on, running first, then recently finished. Empty for providers that have none. */
  background: z.array(bgJob).default([]),
  /** The tool the agent is running right now, from Paseo's timeline (not from the canvas). One short line; kept for older clients. */
  currentTool: z.string().nullable(),
  /** ms epoch of the agent's last activity as Paseo reports it. */
  lastActivityAt: z.number(),
  /** Where the browser view lives, e.g. http://host:6790/a/<id>. */
  url: z.string(),
  /** The agent in the Paseo web UI (deep link), when the daemon serves one. */
  agentUrl: z.string().nullable(),
});
export type CanvasView = z.output<typeof canvasView>;

/** What a timeline row holds: the canvas, or a stub left where the canvas used to be before it moved down. */
export const rowData = z.union([canvasView, z.object({ superseded: z.literal(true) })]);

export const listRpc = defineRpc({ name: "canvas.list", input: z.object({}), output: z.object({ views: z.array(canvasView), baseUrl: z.string() }) });
export const stateSchema = z.object({
  /** The effective per-agent override (runtime, then env, then label), if any. */
  override: z.enum(["on", "off"]).nullable(),
  tools: z.boolean(),
  show: z.boolean(),
});
export const getRpc = defineRpc({ name: "canvas.get", input: z.object({ agentId: z.string() }), output: z.object({ view: canvasView.nullable(), state: stateSchema }) });
export const answerRpc = defineRpc({
  name: "canvas.answer",
  input: z.object({ agentId: z.string(), askId: z.string(), value: z.string() }),
  output: z.object({ ok: z.boolean(), error: z.string().optional() }),
});
/** The pill's runtime override: force the canvas on or off for one agent, or go back to the creation override and the global switch. */
export const overrideRpc = defineRpc({
  name: "canvas.override",
  input: z.object({ agentId: z.string(), value: z.enum(["on", "off", "default"]) }),
  output: z.object({ ok: z.boolean(), state: stateSchema }),
});

/**
 * The picture behind a hash: a PNG (or the small original) as base64, for the native Image component. The timeline row
 * carries only hashes; this is how a phone gets the bytes, over the Paseo connection rather than the plugin's HTTP port.
 * `format: "svg"` (web and desktop clients) asks for a drawing as its sanitised SVG instead; anything that is not a
 * drawing, or is gone, still answers with the PNG/original, and `mime` says which one arrived.
 */
export const assetRpc = defineRpc({
  name: "canvas.asset",
  input: z.object({ hash: z.string().regex(/^[0-9a-f]{32}$/), theme: z.enum(["light", "dark"]), width: z.number().optional(), format: z.enum(["png", "svg"]).optional() }),
  output: z.object({ asset: z.object({ mime: z.string(), base64: z.string(), w: z.number(), h: z.number() }).nullable() }),
});
