import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { answerRpc, enableRpc, getRpc, listRpc } from "./shared/contract.ts";
import { Hub } from "./server/hub.ts";
import { agentDeepLink } from "./shared/links.ts";
import { startHttp } from "./server/http.ts";
import { VOCAB_DOC } from "./server/vocab-doc.ts";

const PORT = Number(process.env.AGENT_CANVAS_PORT ?? 6790);
const BIND = process.env.AGENT_CANVAS_BIND ?? "0.0.0.0";
const PUBLIC = (process.env.AGENT_CANVAS_PUBLIC_URL ?? `http://manjaro.tail2e75.ts.net:${PORT}`).replace(/\/$/, "");
const APP = (process.env.AGENT_CANVAS_APP_URL ?? "http://manjaro.tail2e75.ts.net:6781").replace(/\/$/, "");
const LOCAL = `http://127.0.0.1:${PORT}`;
const OPT_IN = "AGENT_CANVAS";
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

const INSTRUCTIONS = (url: string) => `You have a live canvas the human watches instead of your chat. This session has no canvas tool, so use plain HTTP with curl:
  set:   curl -s -X POST ${url} --data-binary @canvas.tsx
  patch: curl -s -X POST ${url}/patch -H 'content-type: application/json' -d '[{"id":"build","set":{"state":"done"}}]'
  read:  curl -s ${url}
Errors come back as JSON; fix them and retry.\n\n${VOCAB_DOC}`;

export default function contribute(server: PluginServerContext) {
  const log = (m: string) => console.log(`[agent-canvas] ${m}`);
  const home = detectHome();
  const hub = new Hub({ log, stateFile: join(home, "agent-canvas", "state.json"), publicBase: PUBLIC, localBase: LOCAL, agentLink: (id) => agentDeepLink(APP, serverId(home), id) });
  log(`starting (pid ${process.pid}, daemon home ${home})`);
  let http: Awaited<ReturnType<typeof startHttp>> | null = null;
  startHttp(hub, PORT, BIND, log).then((s) => (http = s)).catch((e) => log(`http failed: ${e?.message ?? e}`));

  // Opt-in at creation: AGENT_CANVAS=on in the agent's environment gives it the canvas tools.
  server.before("agent.create", ({ request }, ctx) => {
    hub.capture(ctx, "before agent.create");
    if (request.env?.[OPT_IN] !== "on") return;
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
  });

  server.on("agent.created", (e, ctx) => {
    hub.capture(ctx, "agent.created");
    hub.bindByCwd(e.agent.id, e.agent.cwd);
    hub.noteAgent(e.agent.id, e.agent.title, e.agent.workspaceId);
  });
  for (const name of ["agent.turn_started", "agent.turn_ended", "agent.permission_requested", "agent.permission_resolved"] as const) {
    server.on(name, (e, ctx) => {
      hub.capture(ctx, name);
      hub.noteAgent(e.agent.id, e.agent.title, e.agent.workspaceId);
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
    return { view: hub.view(i.agentId) };
  });
  server.handle(answerRpc, async (i, ctx) => {
    hub.capture(ctx, "rpc answer");
    return hub.answer(i.agentId, i.askId, i.value);
  });
  // The pill's "turn it on" for an agent that was created without the tools: hand it the plain-HTTP recipe.
  server.handle(enableRpc, async (i, ctx) => {
    hub.capture(ctx, "rpc enable");
    const url = `${LOCAL}/api/canvas/${i.agentId}`;
    try {
      await hub.send(i.agentId, INSTRUCTIONS(url));
      return { ok: true, url: `${PUBLIC}/a/${i.agentId}` };
    } catch (e) {
      return { ok: false, url: `${PUBLIC}/a/${i.agentId}`, error: (e as Error).message };
    }
  });

  return async () => {
    log("cleanup");
    hub.stop();
    http?.close();
    http?.closeAllConnections?.();
  };
}
