import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { answerRpc, assetRpc, getRpc, listRpc, overrideRpc } from "./shared/contract.ts";
import { DEFAULT_POLICY, ENV_KEY, canvasSettings, parseOverride, type CanvasPolicy } from "./shared/config.ts";
import { Hub } from "./server/hub.ts";
import { agentDeepLink } from "./shared/links.ts";
import { startHttp } from "./server/http.ts";
import { bindHosts, relayKey } from "./server/bind.ts";
import { randomBytes } from "node:crypto";
import { recipe } from "./server/recipe.ts";

const PORT = Number(process.env.AGENT_CANVAS_PORT ?? 6790);
const BIND = bindHosts(process.env.AGENT_CANVAS_BIND);
const PUBLIC = (process.env.AGENT_CANVAS_PUBLIC_URL ?? `http://manjaro.tail2e75.ts.net:${PORT}`).replace(/\/$/, "");
const APP = (process.env.AGENT_CANVAS_APP_URL ?? "http://manjaro.tail2e75.ts.net:6781").replace(/\/$/, "");
const LOCAL = `http://127.0.0.1:${PORT}`;
const KEY = "AGENT_CANVAS_KEY";

function detectHome(): string {
  if (process.env.PASEO_HOME) return process.env.PASEO_HOME;
  try {
    const v = readFileSync(`/proc/${process.ppid}/environ`, "utf8").split("\0").find((e) => e.startsWith("PASEO_HOME="));
    if (v) return v.slice("PASEO_HOME=".length);
  } catch {}
  return join(homedir(), ".paseo");
}

/** The daemon's id, which the Paseo web app uses as the host in its routes (/h/<serverId>/agent/<agentId>). */
function serverId(home: string): string | null {
  try { return readFileSync(join(home, "server-id"), "utf8").trim() || null; } catch { return null; }
}

export default function contribute(server: PluginServerContext) {
  const log = (m: string) => console.log(`[agent-canvas] ${m}`);
  const home = detectHome();
  // Host-wide defaults (Settings > Plugins > Agent canvas). Kept in memory; every change re-derives the views.
  let policy: CanvasPolicy = DEFAULT_POLICY;
  const hub = new Hub({
    log,
    stateFile: join(home, "agent-canvas", "state.json"),
    publicBase: PUBLIC,
    localBase: LOCAL,
    agentLink: (id) => agentDeepLink(APP, serverId(home), id),
    policy: () => policy,
    recipe: (id) => recipe(`${LOCAL}/api/canvas/${id}`),
  });
  const settings = server.registerSettings(canvasSettings);
  const applySettings = (st: Awaited<ReturnType<typeof settings.read>>) => {
    if (st.status !== "ready") { log(`settings invalid (${st.error}); using defaults`); policy = DEFAULT_POLICY; }
    else policy = { defaultOn: st.values.defaultOn, autoCanvas: st.values.autoCanvas };
    log(`policy: tools for all agents ${policy.defaultOn ? "ON" : "off"}, auto canvas ${policy.autoCanvas ? "on" : "OFF"}`);
    hub.policyChanged();
  };
  void settings.read().then(applySettings).catch((e) => log(`settings read failed: ${e?.message ?? e}`));
  const unsubSettings = settings.subscribe(applySettings);
  log(`starting (pid ${process.pid}, daemon home ${home})`);
  let http: Awaited<ReturnType<typeof startHttp>> | null = null;
  const key = relayKey(join(home, "agent-canvas", "relay.key"));
  startHttp(hub, PORT, BIND, log, Date.now, { key, pageToken: randomBytes(16).toString("hex") }).then((s) => (http = s)).catch((e) => log(`http failed: ${e?.message ?? e}`));

  // The canvas tools are injected at creation for agents with AGENT_CANVAS=on, or for every agent when the global switch is on
  // (AGENT_CANVAS=off keeps them out). The hook cannot see labels, so a label override is handled after creation.
  server.before("agent.create", ({ request }, ctx) => {
    hub.capture(ctx, "before agent.create");
    const ov = parseOverride(request.env?.[ENV_KEY]);
    if (!(ov === "on" || (ov === null && policy.defaultOn))) return;
    const token = hub.mintToken(request.config.cwd ?? "");
    return {
      ...request,
      env: { ...request.env, [KEY]: token },
      config: {
        ...request.config,
        mcpServers: { ...request.config.mcpServers, canvas: { type: "http", url: `${LOCAL}/mcp/${token}`, alwaysLoad: true } },
        toolPolicy: { preapproved: [...(request.config.toolPolicy?.preapproved ?? []), ...["canvas_set", "canvas_patch", "canvas_get"].map((tool) => ({ kind: "mcp" as const, server: "canvas", tool }))] },
        systemPrompt: `${request.config.systemPrompt ? `${request.config.systemPrompt}\n\n` : ""}You have a live canvas: use the canvas_set / canvas_patch tools (server "canvas") to show your work as you go. Read the tool descriptions first.`,
      },
    };
  });
  server.before("agent.session_open", ({ request }, ctx) => {
    hub.capture(ctx, "before agent.session_open");
    const token = request.env?.[KEY];
    if (token) hub.bind(token, request.agentId);
    const ov = parseOverride(request.env?.[ENV_KEY]);
    if (ov) hub.setOverride(request.agentId, ov, "env");
  });

  server.on("agent.created", (e, ctx) => {
    hub.capture(ctx, "agent.created");
    hub.bindByCwd(e.agent.id, e.agent.cwd);
    hub.noteAgent(e.agent.id, e.agent.title, e.agent.workspaceId, e.agent.cwd);
    void hub.learnLabels(e.agent.id); // a canvas=on|off label is only visible once the agent exists
  });
  for (const name of ["agent.turn_started", "agent.turn_ended", "agent.permission_requested", "agent.permission_resolved"] as const) {
    server.on(name, (e, ctx) => {
      hub.capture(ctx, name);
      if (name === "agent.turn_started") hub.turnStarted(e.agent.id);
      hub.noteAgent(e.agent.id, e.agent.title, e.agent.workspaceId, e.agent.cwd);
    });
  }
  for (const name of ["agent.archived", "agent.closed"] as const) {
    server.on(name, (e, ctx) => {
      hub.capture(ctx, name);
      if (name === "agent.archived") hub.forget(e.agent.id);
      else hub.noteAgent(e.agent.id);
    });
  }

  server.handle(listRpc, (_i, ctx) => {
    hub.capture(ctx, "rpc list");
    return { views: hub.agents().map((a) => hub.view(a)!).filter(Boolean), baseUrl: PUBLIC };
  });
  server.handle(getRpc, (i, ctx) => {
    hub.capture(ctx, "rpc get");
    return { view: hub.view(i.agentId), state: hub.stateOf(i.agentId) };
  });
  server.handle(answerRpc, async (i, ctx) => {
    hub.capture(ctx, "rpc answer");
    return hub.answer(i.agentId, i.askId, i.value);
  });
  // The picture behind a hash, for the native Image: a PNG (light or dark) or the small original, base64, over the Paseo connection.
  server.handle(assetRpc, async (i, ctx) => {
    hub.capture(ctx, "rpc asset");
    try { return { asset: await hub.assets.asset(i.hash, i.theme, i.width ?? 0, i.format) }; } catch (e) { log(`asset ${i.hash} failed: ${(e as Error).message}`); return { asset: null }; }
  });
  // The pill's runtime override. "on" for an agent without the tools also sends it the plain-HTTP recipe, once.
  server.handle(overrideRpc, (i, ctx) => {
    hub.capture(ctx, "rpc override");
    hub.setOverride(i.agentId, i.value === "default" ? null : i.value, "runtime");
    return { ok: true, state: hub.stateOf(i.agentId) };
  });

  return async () => {
    log("cleanup");
    unsubSettings();
    hub.stop();
    http?.close();
    http?.closeAllConnections?.();
  };
}
