/** Deep link to an agent in the Paseo web UI the daemon serves: /h/<serverId>/agent/<agentId>. */
export function agentDeepLink(appBase: string, serverId: string | null, agentId: string): string | null {
  if (!serverId) return null;
  return `${appBase.replace(/\/$/, "")}/h/${encodeURIComponent(serverId)}/agent/${encodeURIComponent(agentId)}`;
}
