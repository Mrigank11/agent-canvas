import type { PluginScreenProps, PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { ScrollView } from "@getpaseo/plugin/client/react-native";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { checkHonesty } from "../shared/honesty";
import { CanvasBody, useLiveAgent } from "./canvas";
import { useFocusedAgent } from "./store";
import { Button, CanvasProvider, useNow, useView, useViews, type Theme } from "./common";
import type { CanvasView } from "../shared/contract";

export const LIST_SCREEN = "canvases";

function useVerdictFor(v: CanvasView, now: number) {
  return checkHonesty(v.tree, { runState: v.runState, canvasUpdatedAt: v.updatedAt, toolCallsSinceUpdate: Math.max(0, v.callsNow - v.callsAtUpdate), now });
}

function Tile({ v, theme, onOpen }: { v: CanvasView; theme: Theme; onOpen: () => void }) {
  const now = useNow(2000);
  const verdict = useVerdictFor(v, now);
  const bluf = v.tree.children.find((c) => c.tag === "Bluf");
  const hot = verdict.label === "Needs you";
  const warn = verdict.label === "Disputed" || verdict.label === "Stale";
  const color = verdict.label === "Error" ? theme.colors.statusDanger : warn ? theme.colors.statusWarning : hot ? theme.colors.accent : theme.colors.foregroundMuted;
  return (
    <Pressable accessibilityRole="button" onPress={onOpen} style={{ gap: 4, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: hot || warn || verdict.label === "Error" ? color : theme.colors.border, backgroundColor: theme.colors.surface1, opacity: verdict.dim ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", justifyContent: "space-between", gap: 8 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 16, fontWeight: "700", flexShrink: 1 }}>{v.title}</Text>
        <Text style={{ color, fontSize: 12, fontWeight: "700" }}>{verdict.label}</Text>
      </View>
      {bluf ? <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={2}>{bluf.text}</Text> : null}
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{v.auto ? "auto canvas" : "agent canvas"} · {v.runState}{v.currentTool ? ` · ${v.currentTool.slice(0, 40)}` : ""}</Text>
      {verdict.flags.filter((f) => f.severity !== "info" || f.code === "needs-you").map((f) => <Text key={f.code} style={{ color, fontSize: 12 }}>{f.text}</Text>)}
    </Pressable>
  );
}

function ListBody({ theme, layout, navigation }: PluginScreenProps) {
  return <Inner theme={theme} compact={layout.compact} openAgent={navigation?.openAgent} />;
}
type OpenAgent = (input: { agentId: string }) => void;
function Inner({ theme, compact, openAgent }: { theme: Theme; compact: boolean; openAgent?: OpenAgent }) {
  const { views, loading, unavailable } = useViews();
  const [open, setOpen] = useState<string | null>(null);
  const sel = views.find((v) => v.agentId === open) ?? null;
  const pad = compact ? 16 : 28;
  if (sel) {
    return (
      <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 14 }}>
        <Button theme={theme} quiet label="← All canvases" onPress={() => setOpen(null)} />
        <CanvasBody view={sel} theme={theme} withBrowserLink onOpenAgent={openAgent ? () => openAgent({ agentId: sel.agentId }) : undefined} />
      </ScrollView>
    );
  }
  const need = views.filter((v) => v.runState === "idle" && JSON.stringify(v.tree).includes('"tag":"Ask"') && !JSON.stringify(v.tree).includes('"answer"')).length;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: pad, gap: 12 }}>
      <Text style={{ color: theme.colors.foreground, fontSize: 22, fontWeight: "700" }}>Canvases{need ? ` · ${need} need you` : ""}</Text>
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }}>Every agent's live view of its work. Tap one to open it.</Text>
      {unavailable ? <Text style={{ color: theme.colors.statusWarning }}>Unavailable right now. Retrying.</Text> : loading ? <Text style={{ color: theme.colors.foregroundMuted }}>Loading…</Text> : null}
      {views.map((v) => <Tile key={v.agentId} v={v} theme={theme} onOpen={() => setOpen(v.agentId)} />)}
    </ScrollView>
  );
}
export function ListScreen(props: PluginScreenProps) {
  return <CanvasProvider><ListBody {...props} /></CanvasProvider>;
}

export function ListItem({ openScreen, currentScreen }: PluginSidebarItemProps) {
  return <SidebarRow icon="LayoutDashboard" label="Canvases" active={currentScreen?.screenId === LIST_SCREEN} onPress={() => openScreen({ screenId: LIST_SCREEN })} />;
}

/** The Explorer side panel: the canvas of the agent on screen in this workspace (reported by that agent's pill). */
export function SidePanelBody({ workspaceId, theme, layout, navigation }: { workspaceId: string; theme: Theme; layout: { compact: boolean }; navigation?: { openAgent: (i: { agentId: string }) => void } }) {
  const { views, loading } = useViews();
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
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 14 : 16, gap: 12 }}>
      {mine.length > 1 ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {mine.map((v) => (
            <Pressable key={v.agentId} accessibilityRole="button" onPress={() => setPicked({ agentId: v.agentId, focusWas: focused })} style={{ paddingHorizontal: 10, paddingVertical: 4, borderRadius: 99, borderWidth: 1, borderColor: v.agentId === shownId ? theme.colors.accent : theme.colors.border, backgroundColor: v.agentId === shownId ? theme.colors.accent : "transparent" }}>
              <Text style={{ fontSize: 12, color: v.agentId === shownId ? theme.colors.accentForeground : theme.colors.foregroundMuted }} numberOfLines={1}>{v.title}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {view ? <CanvasBody view={view} theme={theme} withBrowserLink live={shownId === view.agentId ? live : null} onOpenAgent={navigation ? () => navigation.openAgent({ agentId: view.agentId }) : undefined} /> : <Text style={{ color: theme.colors.foregroundMuted }}>{loading ? "Loading…" : "No agent in this workspace has a canvas yet."}</Text>}
    </ScrollView>
  );
}
