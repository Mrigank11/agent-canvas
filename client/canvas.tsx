import { useAgent } from "@getpaseo/plugin/client";
import { View } from "react-native";
import type { RunState } from "../shared/honesty";
import type { CanvasView } from "../shared/contract";
import { selfStatus, statusPlan, type StatusPlan } from "../shared/plan";
import { SPACE } from "../shared/ui-spec";
import { Blocks } from "./blocks";
import { useNow } from "./common";
import { Hairline, Sheet, StatusLine, Txt } from "./ui/atoms";
import { UiRoot, type Theme } from "./ui/tokens";

/** Paseo's own live snapshot of an agent. Only a workspace panel may call it (the host throws elsewhere). */
export type Live = { status: RunState; at: number } | null;
export function useLiveAgent(agentId: string): Live {
  return useAgent(agentId, (a) => ({ status: a.status, at: Date.parse(a.lastActivityAt) || 0 }));
}

/** The facts: Paseo's live snapshot where the host offers one (panels), else what the daemon last saw (about 2 s old). */
export function useStatus(view: CanvasView, live: Live = null): { plan: StatusPlan; now: number } {
  const now = useNow();
  const plan = statusPlan({ ...view, lastActivityAt: live?.at || view.lastActivityAt }, now, live?.status ?? view.runState);
  return { plan, now };
}

/** One canvas as a sheet: status line, title, blocks, then whatever footer the surface wants. Used by the side panel and the Canvases detail. */
export function CanvasBody({ view, theme, live = null, footer }: { view: CanvasView; theme: Theme; live?: Live; footer?: React.ReactNode }) {
  const { plan } = useStatus(view, live);
  const me = selfStatus(view, plan.label);
  return (
    <UiRoot theme={theme}>
      <Sheet>
        <StatusLine plan={plan} />
        <View style={{ gap: SPACE.inner, opacity: plan.dim ? 0.55 : 1 }}>
          <View style={{ flexDirection: "row", alignItems: "baseline", gap: 6, flexWrap: "wrap" }}>
            <Txt role="title">{view.title}</Txt>
            <Txt role="meta" c={me.contradicted ? "warn" : "muted"}>· {me.text}</Txt>
          </View>
        </View>
        <View style={{ opacity: plan.dim ? 0.55 : 1 }}>
          <Blocks root={view.tree} agentId={view.agentId} askVariant="panel" />
          {view.tree.children.length === 0 ? <Txt c="muted">Nothing yet.</Txt> : null}
        </View>
        {footer ? <View style={{ gap: 8 }}><Hairline />{footer}</View> : null}
      </Sheet>
    </UiRoot>
  );
}
