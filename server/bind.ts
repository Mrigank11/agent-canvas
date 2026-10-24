// Where the canvas HTTP server listens. Default: loopback (agents and the first mate's deck) plus the tailnet address
// (browsers, phones), not every interface. AGENT_CANVAS_BIND overrides it with a comma-separated list ("0.0.0.0" for all).
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";

type Ifaces = ReturnType<typeof networkInterfaces>;

/** Tailscale hands out 100.64.0.0/10. */
export const isTailnetIp = (a: string) => { const p = a.split(".").map(Number); return p.length === 4 && p[0] === 100 && p[1] >= 64 && p[1] <= 127; };

export function bindHosts(env: string | undefined, ifaces: Ifaces = networkInterfaces()): string[] {
  const set = env?.split(",").map((x) => x.trim()).filter(Boolean);
  if (set?.length) return set;
  const tail = Object.values(ifaces).flatMap((l) => l ?? []).filter((a) => a.family === "IPv4" && !a.internal && isTailnetIp(a.address)).map((a) => a.address);
  return ["127.0.0.1", ...new Set(tail)];
}

/** The relay key: minted on first start, then read back. Owner-only (0600). */
export function relayKey(file: string): string {
  try { const k = readFileSync(file, "utf8").trim(); if (k.length >= 32) return k; } catch {}
  const k = randomBytes(32).toString("hex");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${k}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return k;
}
