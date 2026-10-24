import { useRpc, type PluginButtonContentProps, type PluginButtonIconProps, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { checkHonesty, summarize } from "../shared/honesty";
import { pillState, type Tone } from "../shared/pill";
import { enableRpc, listRpc } from "../shared/contract";
import { Block } from "./blocks";
import { Button, CanvasProvider, openUrl, useView, type Theme } from "./common";
import { focusStore, pillStore, reportFocus, usePillState } from "./store";

function toneColor(theme: Theme, tone: Tone | undefined) {
  return tone === "hot" ? theme.colors.accent : tone === "warn" ? theme.colors.statusWarning : tone === "err" ? theme.colors.statusDanger : tone === "ok" ? theme.colors.statusSuccess : tone === "run" ? theme.colors.accent : theme.colors.foregroundMuted;
}

/** The pill's icon: a dot coloured by the Paseo-computed verdict. Mounting it also tells the side panel which agent is on screen. */
function PillDot(props: PluginButtonIconProps) {
  const st = usePillState("agentId" in props ? props.agentId : "");
  useEffect(() => {
    if ("agentId" in props) reportFocus(props.workspaceId, props.agentId);
  }, [props]);
  return <View style={{ width: props.size * 0.6, height: props.size * 0.6, borderRadius: props.size, backgroundColor: toneColor(props.theme, st?.tone) }} />;
}

/** The popover: a mini canvas. Bluf, steps, progress and the Ask buttons, which is what a glance needs. */
function MiniCanvas({ theme, agentId, workspaceId, close, openSide }: PluginButtonContentProps & { agentId: string; workspaceId: string; openSide: () => void }) {
  const { view } = useView(agentId);
  const enable = useRpc(enableRpc);
  const list = useRpc(listRpc);
  const [msg, setMsg] = useState<string | null>(null);
  if (!view) return <View style={{ padding: 14, minWidth: 260 }}><Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text></View>;
  const st = pillState(view, Date.now());
  const kinds = new Set(["Bluf", "Steps", "Progress", "Ask", "Metric"]);
  const blocks = view.tree.children.filter((c) => kinds.has(c.tag));
  void checkHonesty; void summarize; void workspaceId;
  return (
    <View style={{ gap: 10, padding: 14, minWidth: 300, maxWidth: 420, backgroundColor: theme.colors.surface1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: toneColor(theme, st.tone) }} />
        <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 15, flexShrink: 1 }}>{view.title}</Text>
        <Text style={{ color: toneColor(theme, st.tone), fontSize: 12, fontWeight: "700" }}>{st.label}</Text>
      </View>
      {st.verdict.flags.filter((f) => f.severity !== "info" || f.code === "needs-you").map((f) => (
        <Text key={f.code} style={{ color: toneColor(theme, f.severity === "error" ? "err" : f.severity === "warn" ? "warn" : "hot"), fontSize: 12 }}>{f.text}</Text>
      ))}
      {blocks.map((b) => <Block key={b.id} n={b} agentId={agentId} theme={theme} />)}
      {blocks.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Nothing on the canvas yet.</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <Button theme={theme} label="Open side panel" onPress={() => { openSide(); close(); }} />
        <Button theme={theme} quiet label="Browser" onPress={() => { list({}).then((r) => openUrl(`${r.baseUrl}/a/${agentId}`)).catch(() => {}); close(); }} />
      </View>
      {view.auto ? (
        <Button
          theme={theme}
          quiet
          label="Ask this agent to write a canvas"
          onPress={() => { setMsg("Sending…"); enable({ agentId }).then((r) => setMsg(r.ok ? "Sent." : `Could not send: ${r.error}`)).catch((e) => setMsg(String(e))); }}
        />
      ) : null}
      {msg ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{msg}</Text> : null}
    </View>
  );
}

/** One composer pill per agent, kept in step with the daemon's agent list; its label follows the canvas verdict. */
export function contributePills(client: PluginClientContext): () => void {
  const pills = new Map<string, { reg: PluginButtonRegistration; label: string }>();
  const lifetime = new AbortController();
  const register = (agent: { id: string; workspaceId?: string | null }) => {
    if (lifetime.signal.aborted || !agent.workspaceId || pills.has(agent.id)) return;
    const agentId = agent.id;
    const workspaceId = agent.workspaceId;
    const reg = client.addComposerPill({
      id: "canvas",
      workspaceId,
      agentId,
      button: {
        title: "Canvas",
        icon: PillDot,
        label: "Canvas",
        behavior: {
          kind: "popover",
          Content: (p) => (
            <CanvasProvider>
              <MiniCanvas {...p} agentId={agentId} workspaceId={workspaceId} openSide={() => client.openPanel("canvas", { workspaceId, location: "explorer" })} />
            </CanvasProvider>
          ),
        },
      },
    });
    pills.set(agentId, { reg, label: "Canvas" });
  };
  const removeAll = () => { for (const p of pills.values()) p.reg.remove(); pills.clear(); };

  // The label is Paseo's verdict, not the agent's words: poll the daemon's views and push changes into the pills.
  let polling = false;
  const poll = async () => {
    if (polling || lifetime.signal.aborted) return;
    polling = true;
    try {
      const { views } = await client.rpc(listRpc, {});
      const next: Record<string, ReturnType<typeof pillState>> = {};
      const now = Date.now();
      for (const v of views) {
        const st = pillState(v, now);
        next[v.agentId] = st;
        const p = pills.get(v.agentId);
        if (p && p.label !== st.label) { p.label = st.label; p.reg.update({ label: st.label }); }
      }
      const prev = pillStore.get();
      if (JSON.stringify(Object.fromEntries(Object.entries(next).map(([k, s]) => [k, [s.label, s.tone]]))) !== JSON.stringify(Object.fromEntries(Object.entries(prev).map(([k, s]) => [k, [s.label, s.tone]])))) {
        pillStore.set(Object.fromEntries(Object.entries(next).map(([k, s]) => [k, { label: s.label, tone: s.tone }])));
      }
    } catch { /* daemon busy: keep the last label */ } finally { polling = false; }
  };
  const timer = setInterval(() => void poll(), 2000);

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ subscription }) => {
      subscription.subscribe({
        snapshot: ({ entries }) => { removeAll(); for (const { agent } of entries) register(agent); void poll(); },
        update: (message) => {
          if (message.type !== "agent_update") return;
          const u = message.payload;
          if (u.kind === "upsert") return register(u.agent);
          pills.get(u.agentId)?.reg.remove();
          pills.delete(u.agentId);
        },
      });
      return undefined;
    })
    .catch((e) => { if (!lifetime.signal.aborted) console.error("[agent-canvas] agent observation failed", e); });
  return () => { lifetime.abort(); clearInterval(timer); removeAll(); focusStore.set({}); };
}
