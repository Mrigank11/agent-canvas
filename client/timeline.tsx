import type { PluginTimelineItemProps } from "@getpaseo/plugin/client";
import { View } from "react-native";
import type { z } from "zod";
import { planBlocks, statusPlan } from "../shared/plan";
import type { rowData } from "../shared/contract";
import { AskPanel } from "./blocks";
import { CanvasProvider, openUrl, useNow } from "./common";
import { Button, JobChip, Meta, ProgressTicks, StatusBadge, StatusDot, Txt } from "./ui/atoms";
import { UiRoot, useT } from "./ui/tokens";

/**
 * The canvas in the chat is a one-glance card: the verdict, the bottom line, the current step and any open
 * question. The full canvas lives in the Explorer side panel (Canvas pill), so the log does not carry a page.
 * The border is always the neutral line: state shows in the badge, never in the frame.
 */
export function CanvasRow({ item, theme }: PluginTimelineItemProps<z.output<typeof rowData>>) {
  const data = item.data;
  if ("superseded" in data) return null; // the canvas moved to a newer row below
  return (
    <CanvasProvider>
      <UiRoot theme={theme}>
        <Card view={data} />
      </UiRoot>
    </CanvasProvider>
  );
}

function Card({ view }: { view: Exclude<z.output<typeof rowData>, { superseded: true }> }) {
  const t = useT();
  const now = useNow(2000);
  const plan = statusPlan(view, now);
  const blocks = planBlocks(view.tree, new Set(["Bluf", "Steps", "Ask"]));
  const bluf = blocks.find((b) => b.kind === "bluf");
  const steps = blocks.find((b) => b.kind === "steps");
  const ask = blocks.find((b) => b.kind === "ask" && b.answered === null);
  const active = steps?.kind === "steps" ? steps.rows.find((r) => r.state === "active") : undefined;
  return (
    <View style={{ gap: 8, padding: 14, borderRadius: 12, borderWidth: 1, borderColor: t.line, backgroundColor: t.bg, opacity: plan.dim ? 0.55 : 1 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <StatusBadge tone={plan.signal} label={plan.label} glyph={plan.signal === "ok" ? "check" : "dot"} />
        <View style={{ flexShrink: 1 }}><Txt role="body" weight="600" numberOfLines={1}>{view.title}</Txt></View>
        {steps?.kind === "steps" && steps.ticks.length ? (
          <>
            <ProgressTicks states={steps.ticks} max={72} />
            <Meta>{steps.count}</Meta>
          </>
        ) : null}
        <View style={{ marginLeft: "auto" }}><Button variant="ghost" label="Browser ↗" onPress={() => openUrl(view.url)} /></View>
      </View>
      {plan.background ? <View style={{ flexDirection: "row" }}><JobChip chip={plan.background.chip} /></View> : null}
      {bluf?.kind === "bluf" ? <Txt numberOfLines={2}>{bluf.text}</Txt> : null}
      {active ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
          <StatusDot tone="run" size={6} />
          <Txt role="meta" c="fg" numberOfLines={1}>{active.text}</Txt>
        </View>
      ) : null}
      {ask?.kind === "ask" ? <AskPanel plan={ask} agentId={view.agentId} variant="flat" /> : null}
    </View>
  );
}
