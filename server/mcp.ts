// A minimal MCP server over streamable HTTP (JSON responses only): enough for an agent to call canvas tools.
import type { PatchOp } from "../shared/canvas.ts";
import type { Hub } from "./hub.ts";
import { VOCAB_DOC } from "./vocab-doc.ts";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method: string; params?: any };

const TOOLS = [
  {
    name: "canvas_set",
    description: `Replace your live canvas. Call it first, then keep it current with canvas_patch.\n\n${VOCAB_DOC}`,
    inputSchema: { type: "object", properties: { source: { type: "string", description: "The whole <Canvas>…</Canvas> document." } }, required: ["source"] },
  },
  {
    name: "canvas_patch",
    description: "Change parts of your canvas by element id, atomically: every op applies or none does, and validation errors come back to you. Ops: {id, set:{attr:value|null}}, {id, text:'…'}, {id, remove:true}, {parent, append:'<Step …>…</Step>'}.",
    inputSchema: {
      type: "object",
      properties: { ops: { type: "array", items: { type: "object", properties: { id: { type: "string" }, set: { type: "object" }, text: { type: "string" }, remove: { type: "boolean" }, parent: { type: "string" }, append: { type: "string" } } } } },
      required: ["ops"],
    },
  },
  { name: "canvas_get", description: "Read back your current canvas source, with every element id.", inputSchema: { type: "object", properties: {} } },
];

const notes = (n: string[]) => (n.length ? `\nNote:\n- ${n.join("\n- ")}` : "");
const text = (t: string, isError = false) => ({ content: [{ type: "text", text: t }], isError });

export async function callTool(hub: Hub, agentId: string, name: string, args: any) {
  if (name === "canvas_set") {
    const source = String(args?.source ?? "");
    const pre = await hub.prepare(agentId, { source });
    if (!pre.ok) return text(`Canvas rejected, nothing changed:\n- ${pre.errors.join("\n- ")}`, true);
    const r = hub.set(agentId, source);
    return r.ok ? text(`Canvas updated. Element ids: ${r.ids.join(", ")}${notes([...r.notes, ...pre.notes])}`) : text(`Canvas rejected, nothing changed:\n- ${r.errors.join("\n- ")}`, true);
  }
  if (name === "canvas_patch") {
    const ops = Array.isArray(args?.ops) ? (args.ops as PatchOp[]) : [];
    const pre = await hub.prepare(agentId, { ops });
    if (!pre.ok) return text(`Patch rejected, nothing changed:\n- ${pre.errors.join("\n- ")}`, true);
    const r = hub.patch(agentId, ops);
    return r.ok ? text(`Patched.${notes([...r.notes, ...pre.notes])}`) : text(`Patch rejected, nothing changed:\n- ${r.errors.join("\n- ")}`, true);
  }
  if (name === "canvas_get") return text(hub.source(agentId) ?? "No canvas yet.");
  return text(`unknown tool ${name}`, true);
}

/** Handle one JSON-RPC message; null means "no response" (a notification). */
export async function handleRpc(hub: Hub, key: string, msg: Rpc) {
  const reply = (result: unknown) => ({ jsonrpc: "2.0" as const, id: msg.id ?? null, result });
  const fail = (code: number, message: string) => ({ jsonrpc: "2.0" as const, id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null;
  switch (msg.method) {
    case "initialize": return reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "agent-canvas", version: "0.0.0" } });
    case "ping": return reply({});
    case "tools/list": return reply({ tools: TOOLS });
    case "tools/call": {
      const agentId = hub.resolve(key);
      if (!agentId) return reply(text("This canvas is not attached to an agent yet. Try again in a moment.", true));
      return reply(await callTool(hub, agentId, String(msg.params?.name), msg.params?.arguments));
    }
    default: return fail(-32601, `method not found: ${msg.method}`);
  }
}
