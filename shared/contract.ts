import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import type { Node } from "./canvas.ts";

export const ROW_KIND = "agent-canvas";
export const ROW_VERSION = 1;
export const ROW_ID = "canvas";
/** How many timeline items may pile up under the canvas row before it is moved back to the bottom. */
export const REANCHOR_AFTER = 6;

const nodeSchema = z.custom<Node>((v) => typeof v === "object" && v !== null && typeof (v as Node).tag === "string" && Array.isArray((v as Node).children));

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
