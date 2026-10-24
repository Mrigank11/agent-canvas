import { useRpc, type PluginButtonContentProps, type PluginButtonIconProps, type PluginButtonRegistration, type PluginClientContext } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { View } from "react-native";
import { pillState } from "../shared/pill";
import { planBlocks, statusPlan } from "../shared/plan";
import { listRpc, overrideRpc, type CanvasView } from "../shared/contract";
import { BG_CAP } from "../shared/ui-spec";
import { Blocks } from "./blocks";
import { CanvasProvider, openUrl, useNow, useView } from "./common";
import { ActivityRow, Button, JobGroup, Meta, ProgressTicks, StatusBadge, StatusDot, Txt } from "./ui/atoms";
import { UiRoot } from "./ui/tokens";
import { focusStore, pillStore, reportFocus, usePillState } from "./store";

/** The pill's icon: a lamp in the Paseo-computed signal. Mounting it also tells the side panel which agent is on screen. */
function PillDot(props: PluginButtonIconProps) {
  const st = usePillState("agentId" in props ? props.agentId : "");
  useEffect(() => {
    if ("agentId" in props) reportFocus(props.workspaceId, props.agentId);
  }, [props]);
  return (
    <UiRoot theme={props.theme}>
      <StatusDot tone={st?.tone ?? "idle"} size={8} />
    </UiRoot>
  );
}

/** The popover: a mini canvas. Header, the bottom line, steps, progress, metrics and the question: what a glance needs. */
function MiniCanvas({ theme, agentId, close, openSide }: PluginButtonContentProps & { agentId: string; openSide: () => void }) {
  const { view, state } = useView(agentId);
  const override = useRpc(overrideRpc);
  const list = useRpc(listRpc);
  const [msg, setMsg] = useState<string | null>(null);
  const now = useNow();
  const set = (value: "on" | "off" | "default") => {
    setMsg("Saving…");
    override({ agentId, value }).then(() => setMsg(value === "on" ? "On: the agent is being told how to use it." : value === "off" ? "Off for this agent." : "Back to the default.")).catch((e) => setMsg(String(e)));
  };
  return (
    <UiRoot theme={theme}>
      <View style={{ gap: 16, padding: 16, minWidth: 300, maxWidth: 380 }}>
        {!view ? (
          <View style={{ gap: 8 }}>
            <Txt role="lede" weight="600">Canvas is off for this agent</Txt>
            <Txt c="muted">{state?.override === "off" ? "It was switched off for this agent." : "The global switch is off and this agent has no override."}</Txt>
          </View>
        ) : (
          <Inner view={view} now={now} agentId={agentId} />
        )}
        <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: 8 }}>
          {view ? <Button variant="primary" label="Open side panel" onPress={() => { openSide(); close(); }} /> : <Button variant="primary" label="Turn on for this agent" onPress={() => set("on")} />}
          {view ? <Button variant="ghost" label="Browser ↗" onPress={() => { list({}).then((r) => openUrl(`${r.baseUrl}/a/${agentId}`)).catch(() => {}); close(); }} /> : null}
          {view && state?.override !== "off" ? <Button variant="ghost" label="Turn off for this agent" onPress={() => set("off")} /> : null}
          {view && state?.override ? <Button variant="ghost" label="Use the default" onPress={() => set("default")} /> : null}
          {!view && state?.override ? <Button variant="ghost" label="Use the default" onPress={() => set("default")} /> : null}
        </View>
        {msg ? <Meta>{msg}</Meta> : null}
      </View>
    </UiRoot>
  );
}

function Inner({ view, now, agentId }: { view: CanvasView; now: number; agentId: string }) {
  const plan = statusPlan(view, now, undefined, BG_CAP.popover);
  const steps = planBlocks(view.tree, new Set(["Steps"]))[0];
  const lead = plan.lead ?? plan.flags[0]?.text ?? null;
  return (
    <View style={{ gap: 16 }}>
      <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ flexShrink: 1 }}><Txt role="lede" weight="600" numberOfLines={1}>{view.title}</Txt></View>
          <StatusBadge tone={plan.signal} label={plan.label} glyph={plan.signal === "ok" ? "check" : "dot"} />
        </View>
        {steps?.kind === "steps" ? (
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <ProgressTicks states={steps.ticks} max={null} />
            <Txt role="label" c="fg">{steps.count}</Txt>
          </View>
        ) : null}
        {plan.activity ? <ActivityRow plan={plan.activity} /> : null}
        {plan.background ? <JobGroup plan={plan.background} /> : null}
        {lead ? <Meta c={plan.lead ? plan.leadSignal : plan.flags[0]?.signal}>{lead}</Meta> : null}
      </View>
      <Blocks root={view.tree} agentId={agentId} only={new Set(["Bluf", "Steps", "Progress", "Metric", "Ask"])} askVariant="panel" dense gap={16} />
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
              <MiniCanvas {...p} agentId={agentId} openSide={() => client.openPanel("canvas", { workspaceId, location: "explorer" })} />
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
