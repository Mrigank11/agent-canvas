import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import type { CanvasView } from "../shared/contract";
import { rowPlan, switcherPlan, type RowPlan } from "../shared/plan";
import { SPACE } from "../shared/ui-spec";
import { CanvasBody, useLiveAgent } from "./canvas";
import { CanvasProvider, openUrl, useNow, useViews } from "./common";
import { Button, FlagLine, JobChip, Meta, ProgressTicks, Switcher, StatusBadge, StatusDot, Txt } from "./ui/atoms";
import { UiRoot, useT, type Theme } from "./ui/tokens";
import { useFocusedAgent } from "./store";

export const LIST_SCREEN = "canvases";
type OpenAgent = (input: { agentId: string }) => void;

/** One agent in the list. The row that needs you is the single filled row; nothing else has a frame. */
function CanvasRow({ plan, onOpen, last }: { plan: RowPlan; onOpen: () => void; last: boolean }) {
  const t = useT();
  const hot = plan.needsYou;
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={(s) => ({ gap: 4, paddingVertical: 14, paddingHorizontal: 12, marginHorizontal: -12, borderRadius: 8, backgroundColor: hot ? t.sig("hot").tint : (s as { hovered?: boolean }).hovered ? t.raised : "transparent", borderBottomWidth: last || hot ? 0 : 1, borderBottomColor: t.line, opacity: plan.dim ? 0.55 : 1 })}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <StatusDot tone={plan.signal} />
        <View style={{ flexShrink: 1 }}><Txt weight="600" numberOfLines={1}>{plan.title}</Txt></View>
        {plan.ticks.length ? <ProgressTicks states={plan.ticks} max={120} /> : null}
        <View style={{ marginLeft: "auto" }}><StatusBadge tone={plan.signal} label={plan.label} glyph={plan.signal === "ok" ? "check" : "dot"} /></View>
      </View>
      {plan.bluf ? <View style={{ paddingLeft: 18 }}><Txt c={hot ? "fg" : "muted"} numberOfLines={1}>{plan.bluf}</Txt></View> : null}
      <View style={{ paddingLeft: 18, gap: 4 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Meta>{plan.meta}</Meta>
          {plan.jobs ? <JobChip chip={plan.jobs} /> : null}
        </View>
        {plan.flag ? <FlagLine flag={plan.flag} /> : null}
      </View>
    </Pressable>
  );
}

function ListBody({ theme, layout, navigation }: PluginScreenProps) {
  const { views, loading, unavailable } = useViews();
  const now = useNow(2000);
  const [open, setOpen] = useState<string | null>(null);
  const sel = views.find((v) => v.agentId === open) ?? null;
  const pad = layout.compact ? SPACE.panel : 28;
  const plans = views.map((v) => rowPlan(v, now));
  const need = plans.filter((p) => p.needsYou).length;
  const openAgent: OpenAgent | undefined = navigation?.openAgent;
  return (
    <UiRoot theme={theme}>
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: SPACE.block, maxWidth: 720, width: "100%", alignSelf: "center" }}>
        {sel ? (
          <>
            <Button variant="ghost" label="← All canvases" onPress={() => setOpen(null)} />
            <CanvasBody
              view={sel}
              theme={theme}
              footer={
                <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  {openAgent ? <Button variant="primary" label="Open agent" onPress={() => openAgent({ agentId: sel.agentId })} /> : null}
                  <Button variant="ghost" label="Open in browser ↗" onPress={() => openUrl(sel.url)} />
                </View>
              }
            />
          </>
        ) : (
          <>
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
                <Txt role="screenTitle">Canvases</Txt>
                {need > 0 ? <StatusBadge tone="hot" label={`${need} need you`} /> : null}
              </View>
              <Meta>Every agent's live view of its work. Tap one to open it.</Meta>
            </View>
            {unavailable ? <Txt c="warn">Unavailable right now. Retrying.</Txt> : loading ? <Txt c="muted">Loading…</Txt> : null}
            <View>{plans.map((p, i) => <CanvasRow key={p.agentId} plan={p} last={i === plans.length - 1} onOpen={() => setOpen(p.agentId)} />)}</View>
          </>
        )}
      </ScrollView>
    </UiRoot>
  );
}

export function ListScreen(props: PluginScreenProps) {
  return <CanvasProvider><ListBody {...props} /></CanvasProvider>;
}

export function ListItem({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="LayoutDashboard" label="Canvases" active={currentScreen?.screenId === LIST_SCREEN} onPress={() => openScreen({ screenId: LIST_SCREEN })} />;
}

/** The Explorer side panel: the canvas of the agent on screen in this workspace (reported by that agent's pill). */
export function SidePanelBody({ workspaceId, theme, layout }: { workspaceId: string; theme: Theme; layout: { compact: boolean } }) {
  const { views, loading } = useViews();
  const now = useNow(2000);
  const focused = useFocusedAgent(workspaceId);
  const mine = views.filter((v) => v.workspaceId === workspaceId);
  const [picked, setPicked] = useState<{ agentId: string; focusWas: string | null } | null>(null);
  // a manual pick holds until the agent on screen changes again
  const manual = picked && picked.focusWas === focused && mine.some((v) => v.agentId === picked.agentId) ? picked.agentId : null;
  const rank = (v: CanvasView) => (v.runState === "running" ? 2 : 0) + (v.auto ? 0 : 1);
  const fallback = [...mine].sort((a, b) => rank(b) - rank(a) || b.lastActivityAt - a.lastActivityAt)[0]?.agentId ?? null;
  const shownId = manual ?? (focused && mine.some((v) => v.agentId === focused) ? focused : fallback);
  const view = mine.find((v) => v.agentId === shownId) ?? null;
  const live = useLiveAgent(shownId ?? "");
  return (
    <UiRoot theme={theme}>
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? SPACE.panel : SPACE.panel, gap: SPACE.block }}>
        {mine.length > 1 ? <Switcher plan={switcherPlan(mine, shownId, now)} onChange={(id) => setPicked({ agentId: id, focusWas: focused })} /> : null}
        {view ? (
          <CanvasBody view={view} theme={theme} live={shownId === view.agentId ? live : null} footer={<Button variant="ghost" label="Open in browser ↗" onPress={() => openUrl(view.url)} />} />
        ) : (
          <Txt c="muted">{loading ? "Loading…" : "No agent in this workspace has a canvas yet."}</Txt>
        )}
      </ScrollView>
    </UiRoot>
  );
}
