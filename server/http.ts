import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { PatchOp } from "../shared/canvas.ts";
import type { Hub } from "./hub.ts";
import { page, renderCanvas, renderIndex, esc, type RenderCtx } from "./html.ts";
import { HASH_RE } from "./render/assets.ts";
import { callTool, handleRpc } from "./mcp.ts";

const MAX_BODY = 256_000;

function body(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => { n += c.length; if (n > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
const send = (res: ServerResponse, code: number, type: string, data: string) => { res.writeHead(code, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" }); res.end(data); };
const json = (res: ServerResponse, code: number, v: unknown) => send(res, code, "application/json", JSON.stringify(v));

export function startHttp(hub: Hub, port: number, host: string, log: (m: string) => void, now: () => number = Date.now): Promise<Server> {
  const ctx: RenderCtx = { svg: (h) => hub.assets.inlineSvg(h) };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const m = (re: RegExp) => re.exec(path);

      if (req.method === "GET") {
        if (path === "/") return send(res, 200, "text/html", page("Canvases", renderIndex(hub.agents().map((a) => hub.view(a)!).filter(Boolean), now()), "/frag/index"));
        if (path === "/frag/index") return send(res, 200, "text/html", renderIndex(hub.agents().map((a) => hub.view(a)!).filter(Boolean), now()));
        let g = m(/^\/a\/([\w-]+)$/);
        if (g) {
          const v = hub.view(g[1]);
          return v ? send(res, 200, "text/html", page(v.title, renderCanvas(v, now(), ctx), `/frag/${g[1]}`, ` <span class="crumb">/</span> <span class="crumb">${esc(v.title)}</span>`)) : send(res, 404, "text/plain", "no such agent");
        }
        g = m(/^\/frag\/([\w-]+)$/);
        if (g) { const v = hub.view(g[1]); return v ? send(res, 200, "text/html", renderCanvas(v, now(), ctx)) : send(res, 404, "text/plain", ""); }
        g = m(/^\/api\/canvas\/([\w-]+)$/);
        if (g) { const a = hub.resolve(g[1]); return send(res, 200, "text/plain", (a && hub.source(a)) ?? "No canvas yet."); }
        // A checked image the canvas shows, as the bytes that were checked. Drawings are inlined in the page, never served.
        g = m(/^\/asset\/([0-9a-f]{32})$/);
        if (g && HASH_RE.test(g[1])) {
          const f = hub.assets.file(g[1]);
          if (!f) return send(res, 404, "text/plain", "no such image");
          res.writeHead(200, { "content-type": f.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox" });
          return void res.end(f.bytes);
        }
        if (path === "/api/health") return json(res, 200, { ok: true, agents: hub.agents().length });
        if (m(/^\/mcp\//)) return send(res, 405, "text/plain", "POST only");
        return send(res, 404, "text/plain", "not found");
      }

      if (req.method === "POST" || req.method === "PUT") {
        const raw = await body(req);
        let g = m(/^\/mcp\/([\w-]+)$/);
        if (g) {
          let msg: any;
          try { msg = JSON.parse(raw); } catch { return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
          const out = Array.isArray(msg) ? msg.map((x) => handleRpc(hub, g![1], x)).filter(Boolean) : handleRpc(hub, g[1], msg);
          if (out === null || (Array.isArray(out) && !out.length)) { res.writeHead(202); return void res.end(); }
          return json(res, 200, out);
        }
        // plain HTTP for agents without the MCP tool (existing agents enabled from the pill): curl --data-binary @-
        g = m(/^\/api\/canvas\/([\w-]+)(\/patch)?$/);
        if (g) {
          const agentId = hub.resolve(g[1]);
          if (!agentId) return json(res, 409, { ok: false, errors: ["not attached to an agent yet"] });
          if (g[2]) {
            let ops: PatchOp[];
            try { ops = JSON.parse(raw); } catch { return json(res, 400, { ok: false, errors: ["body must be a JSON array of ops"] }); }
            const r = callTool(hub, agentId, "canvas_patch", { ops });
            return json(res, r.isError ? 422 : 200, { ok: !r.isError, message: r.content[0].text });
          }
          const r = callTool(hub, agentId, "canvas_set", { source: raw });
          return json(res, r.isError ? 422 : 200, { ok: !r.isError, message: r.content[0].text });
        }
        if (path === "/api/answer") {
          let a: any;
          try { a = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
          return json(res, 200, await hub.answer(String(a.agentId), String(a.askId), String(a.value)));
        }
        return send(res, 404, "text/plain", "not found");
      }
      if (req.method === "DELETE" && m(/^\/mcp\//)) { res.writeHead(200); return void res.end(); }
      send(res, 405, "text/plain", "method not allowed");
    } catch (e) {
      log(`http error: ${(e as Error).message}`);
      if (!res.headersSent) send(res, 500, "text/plain", "error");
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => { log(`canvas HTTP on ${host}:${port}`); resolve(server); });
  });
}
