import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import type { z } from "zod";
import { summarize } from "../shared/honesty";
import { pillState } from "../shared/pill";
import type { rowData } from "../shared/contract";
import { Block } from "./blocks";
import { Button, CanvasProvider, openUrl, useNow, type Theme } from "./common";

function toneColor(theme: Theme, tone: string) {
  return tone === "hot" || tone === "run" ? theme.colors.accent : tone === "warn" ? theme.colors.statusWarning : tone === "err" ? theme.colors.statusDanger : tone === "ok" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
}

/**
 * The canvas in the chat is a one-glance card: the verdict, the bottom line, the current step and any open
 * question. The full canvas lives in the Explorer side panel (Canvas pill), so the log does not carry a page.
 */
export function CanvasRow({ item, theme }: PluginTimelineItemProps<z.output<typeof rowData>>) {
  const data = item.data;
  if ("superseded" in data) return null; // the canvas moved to a newer row below
  return (
    <CanvasProvider>
      <Card view={data} theme={theme} />
    </CanvasProvider>
  );
}

function Card({ view, theme }: { view: Exclude<z.output<typeof rowData>, { superseded: true }>; theme: Theme }) {
  const now = useNow(2000);
  const st = pillState(view, now);
  const sum = summarize(view.tree);
  const bluf = view.tree.children.find((c) => c.tag === "Bluf");
  const active = view.tree.children.flatMap((c) => c.children).find((c) => c.tag === "Step" && c.attrs.state === "active");
  const ask = view.tree.children.find((c) => c.tag === "Ask" && !c.attrs.answer);
  const flag = st.verdict.flags.find((f) => f.severity !== "info");
  const color = toneColor(theme, st.tone);
  return (
    <View style={{ gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: st.tone === "hot" || st.tone === "warn" || st.tone === "err" ? color : theme.colors.border, backgroundColor: theme.colors.surface1, opacity: st.verdict.dim ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: color }} />
        <Text style={{ color, fontWeight: "700", fontSize: 13 }}>{st.verdict.label}</Text>
        <Text style={{ color: theme.colors.foreground, fontWeight: "700", fontSize: 14, flexShrink: 1 }} numberOfLines={1}>{view.title}</Text>
        {sum.steps > 0 ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{sum.doneSteps}/{sum.steps}</Text> : null}
      </View>
      {bluf ? <Text style={{ color: theme.colors.foreground, fontSize: 14 }} numberOfLines={2}>{bluf.text}</Text> : null}
      {active ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 13 }} numberOfLines={1}>● {active.text}</Text> : null}
      {flag ? <Text style={{ color, fontSize: 12 }}>{flag.text}</Text> : null}
      {ask ? <Block n={ask} agentId={view.agentId} theme={theme} /> : null}
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>Full canvas: Canvas pill → Open side panel</Text>
        <Button theme={theme} quiet label="Browser" onPress={() => openUrl(view.url)} />
      </View>
    </View>
  );
}
