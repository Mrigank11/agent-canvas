import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { networkInterfaces } from "node:os";
import type { PatchOp } from "../shared/canvas.ts";
import type { Hub } from "./hub.ts";
import { page, renderCanvas, renderIndex, esc, type RenderCtx } from "./html.ts";
import { HASH_RE } from "./render/assets.ts";
import { callTool, handleRpc } from "./mcp.ts";
import { fmCss } from "./fm-css.ts";

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

const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const header = (req: IncomingMessage, name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] ?? "" : v ?? ""; };

/** The addresses of this machine: a request from one of them (loopback, or the tailnet IP reached from the same host) is local. */
function ownAddresses(): Set<string> {
  const s = new Set<string>();
  for (const list of Object.values(networkInterfaces())) for (const a of list ?? []) s.add(a.address);
  return s;
}
export function isLocalPeer(addr: string | undefined): boolean {
  if (!addr) return false;
  const a = addr.replace(/^::ffff:/, "");
  return a === "::1" || a.startsWith("127.") || ownAddresses().has(a);
}

export type HttpOptions = {
  /** The relay key (x-canvas-key): the first mate's way to deliver a pick. Null turns key-authenticated endpoints off. */
  key?: string | null;
  /** The token the served pages carry for their own buttons (x-canvas-token). A per-process secret that only a page load reveals. */
  pageToken?: string;
};
/** One or more listeners sharing a handler. */
export type Listener = { servers: Server[]; ports: number[]; close(): void; closeAllConnections(): void };

export function startHttp(hub: Hub, port: number, hosts: string | string[], log: (m: string) => void, now: () => number = Date.now, opts: HttpOptions = {}): Promise<Listener> {
  const ctx: RenderCtx = { svg: (h) => hub.assets.inlineSvg(h) };
  const pageToken = opts.pageToken ?? "";
  const key = opts.key ?? null;
  /** Writes (agents' canvas calls, a relay delivery, the fm read API) are accepted from this machine only. */
  const local = (req: IncomingMessage, res: ServerResponse) => isLocalPeer(req.socket.remoteAddress) || (json(res, 403, { ok: false, error: "this endpoint is for the machine it runs on" }), false);
  /** The relay key, in x-canvas-key. 401 when absent, 403 when wrong. */
  const keyed = (req: IncomingMessage, res: ServerResponse) => {
    const got = header(req, "x-canvas-key");
    if (!key) return (json(res, 403, { ok: false, error: "no relay key is configured" }), false);
    if (!got) return (json(res, 401, { ok: false, error: "x-canvas-key required" }), false);
    return same(got, key) || (json(res, 403, { ok: false, error: "wrong key" }), false);
  };
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://x");
      const path = url.pathname;
      const m = (re: RegExp) => re.exec(path);

      if (req.method === "GET") {
        if (path === "/") return send(res, 200, "text/html", page("Canvases", renderIndex(hub.agents().map((a) => hub.view(a)!).filter(Boolean), now()), "/frag/index", "", pageToken));
        if (path === "/frag/index") return send(res, 200, "text/html", renderIndex(hub.agents().map((a) => hub.view(a)!).filter(Boolean), now()));
        let g = m(/^\/a\/([\w-]+)$/);
        if (g) {
          const v = hub.view(g[1]);
          return v ? send(res, 200, "text/html", page(v.title, renderCanvas(v, now(), ctx), `/frag/${g[1]}`, ` <span class="crumb">/</span> <span class="crumb">${esc(v.title)}</span>`, pageToken)) : send(res, 404, "text/plain", "no such agent");
        }
        g = m(/^\/frag\/([\w-]+)$/);
        if (g) { const v = hub.view(g[1]); return v ? send(res, 200, "text/html", renderCanvas(v, now(), ctx)) : send(res, 404, "text/plain", ""); }
        g = m(/^\/api\/canvas\/([\w-]+)$/);
        if (g) { const a = await hub.resolve(g[1]); return send(res, 200, "text/plain", (a && hub.source(a)) ?? "No canvas yet."); }
        // For the first mate's deck (this machine only): per-agent summaries, the embeddable card and its stylesheet.
        if (path === "/api/fm/summary") {
          if (!local(req, res)) return;
          const ids = url.searchParams.get("agents");
          const want = ids === null ? hub.agents() : ids.split(",").map((x) => x.trim()).filter((x) => /^[\w-]+$/.test(x));
          const t = now();
          const agents = want.map((id) => hub.summary(id, t)).filter((x): x is NonNullable<typeof x> => !!x);
          return json(res, 200, { agents, missing: want.filter((id) => !agents.some((a) => a.agentId === id)) });
        }
        if (path === "/api/fm/css") {
          if (!local(req, res)) return;
          const th = url.searchParams.get("theme");
          return send(res, 200, "text/css", fmCss(th === "light" || th === "dark" ? th : undefined));
        }
        g = m(/^\/api\/fm\/card\/([\w-]+)$/);
        if (g) {
          if (!local(req, res)) return;
          const v = url.searchParams.get("archived") === "1" ? hub.archivedView(g[1])?.view : hub.view(g[1]);
          return v ? send(res, 200, "text/html", renderCanvas(v, now(), { ...ctx, embed: true, assetBase: hub.publicBase })) : send(res, 404, "text/plain", "no such canvas");
        }
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
          if (!local(req, res)) return;
          let msg: any;
          try { msg = JSON.parse(raw); } catch { return json(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }); }
          const out = Array.isArray(msg) ? (await Promise.all(msg.map((x) => handleRpc(hub, g![1], x)))).filter(Boolean) : await handleRpc(hub, g[1], msg);
          if (out === null || (Array.isArray(out) && !out.length)) { res.writeHead(202); return void res.end(); }
          return json(res, 200, out);
        }
        // plain HTTP for agents without the MCP tool (existing agents enabled from the pill): curl --data-binary @-
        g = m(/^\/api\/canvas\/([\w-]+)(\/patch)?$/);
        if (g) {
          if (!local(req, res)) return;
          const agentId = await hub.resolve(g[1]);
          if (!agentId) return json(res, 404, { ok: false, errors: ["no such agent (or a creation token not attached to one yet)"] });
          if (g[2]) {
            let ops: PatchOp[];
            try { ops = JSON.parse(raw); } catch { return json(res, 400, { ok: false, errors: ["body must be a JSON array of ops"] }); }
            const r = await callTool(hub, agentId, "canvas_patch", { ops });
            return json(res, r.isError ? 422 : 200, { ok: !r.isError, message: r.content[0].text });
          }
          const r = await callTool(hub, agentId, "canvas_set", { source: raw });
          return json(res, r.isError ? 422 : 200, { ok: !r.isError, message: r.content[0].text });
        }
        // A pick from a served page (its token) or from anything holding the relay key. Nothing else is accepted.
        if (path === "/api/answer") {
          const tok = header(req, "x-canvas-token");
          const authed = (tok && pageToken && same(tok, pageToken)) || (key && header(req, "x-canvas-key") && same(header(req, "x-canvas-key"), key));
          if (!authed) return json(res, tok || header(req, "x-canvas-key") ? 403 : 401, { ok: false, error: "not authorised" });
          let a: any;
          try { a = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
          return json(res, 200, await hub.answer(String(a.agentId), String(a.askId), String(a.value)));
        }
        // The relay agent delivers (or declines) a pick it was sent. This machine only, and the key.
        if (path === "/api/fm/deliver") {
          if (!local(req, res) || !keyed(req, res)) return;
          let a: any;
          try { a = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: "bad json" }); }
          const agentId = typeof a.agentId === "string" ? await hub.resolve(a.agentId) : null;
          if (!agentId) return json(res, 404, { ok: false, error: "no such agent" });
          if (typeof a.askId !== "string") return json(res, 400, { ok: false, error: "askId required" });
          if (typeof a.decline === "string" && a.decline.trim()) return json(res, 200, await hub.deliver(agentId, a.askId, { decline: a.decline.trim() }));
          if (typeof a.value !== "string") return json(res, 400, { ok: false, error: "value or decline required" });
          return json(res, 200, await hub.deliver(agentId, a.askId, { value: a.value }));
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
  const list = [...new Set(Array.isArray(hosts) ? hosts : [hosts])];
  return new Promise((resolve, reject) => {
    const servers: Server[] = [];
    const ports: number[] = [];
    const listener: Listener = { servers, ports, close: () => servers.forEach((x) => x.close()), closeAllConnections: () => servers.forEach((x) => x.closeAllConnections?.()) };
    const next = (i: number) => {
      if (i === list.length) return resolve(listener);
      const srv = i === 0 ? server : createServer(server.listeners("request")[0] as any);
      srv.once("error", (e) => { listener.close(); reject(e); });
      srv.listen(i === 0 ? port : ports[0], list[i], () => {
        const p = (srv.address() as { port: number }).port;
        servers.push(srv);
        ports.push(p);
        log(`canvas HTTP on ${list[i]}:${p}`);
        next(i + 1);
      });
    };
    next(0);
  });
}
