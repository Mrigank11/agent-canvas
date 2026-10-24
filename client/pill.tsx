import { useRpc, type PluginButtonContentProps, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { enableRpc, listRpc } from "../shared/contract";
import { Button, CanvasProvider, openUrl } from "./common";

function PillMenu({ theme, agentId, close, openPanel }: PluginButtonContentProps & { agentId: string; openPanel: () => void }) {
  const enable = useRpc(enableRpc);
  const list = useRpc(listRpc);
  const [msg, setMsg] = useState<string | null>(null);
  return (
    <View style={{ gap: 10, padding: 14, minWidth: 240, backgroundColor: theme.colors.surface1 }}>
      <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 15 }}>Canvas</Text>
      <Button theme={theme} label="Open canvas" onPress={() => { openPanel(); close(); }} />
      <Button theme={theme} quiet label="Open in browser" onPress={() => { list({}).then((r) => openUrl(`${r.baseUrl}/a/${agentId}`)).catch(() => {}); close(); }} />
      <Button
        theme={theme}
        quiet
        label="Tell this agent to use a canvas"
        onPress={() => {
          setMsg("Sending…");
          enable({ agentId }).then((r) => setMsg(r.ok ? "Sent. The agent will start writing one." : `Could not send: ${r.error}`)).catch((e) => setMsg(String(e)));
        }}
      />
      {msg ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{msg}</Text> : null}
    </View>
  );
}

/** One composer pill per agent, kept in step with the daemon's agent list. */
export function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, PluginButtonRegistration>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    pills.set(
      agentId,
      client.addComposerPill({
        id: "canvas",
        workspaceId,
        agentId,
        button: {
          title: "Canvas",
          icon: "LayoutDashboard",
          label: "Canvas",
          behavior: {
            kind: "popover",
            Content: (p) => (
              <CanvasProvider>
                <PillMenu {...p} agentId={agentId} openPanel={() => client.openPanel("canvas", { workspaceId, agentId })} />
              </CanvasProvider>
            ),
          },
        },
      }),
    );
  };
  const removeAll = () => { for (const p of pills.values()) p.remove(); pills.clear(); };
  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => { removeAll(); for (const { agent } of entries) register(agent); },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const u = message.payload;
          if (u.kind === "upsert") return register(u.agent);
          pills.get(u.agentId)?.remove();
          pills.delete(u.agentId);
        },
      });
      return undefined;
    })
    .catch((e) => { if (!lifetime.signal.aborted) console.error("[agent-canvas] agent observation failed", e); });
  return () => { lifetime.abort(); removeAll(); };
}
