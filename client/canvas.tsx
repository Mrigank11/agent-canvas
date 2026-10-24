import { useAgent } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { checkHonesty, type Flag, type RunState, type Verdict } from "../shared/honesty";
import type { Node } from "../shared/canvas";
import type { CanvasView } from "../shared/contract";
import { Block } from "./blocks";
import { Button, openUrl, useNow, type Theme } from "./common";

const ago = (ms: number) => { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`; };

/** Paseo's own live snapshot of an agent. Only a workspace panel may call it (the host throws elsewhere). */
export type Live = { status: RunState; at: number } | null;
export function useLiveAgent(agentId: string): Live {
  return useAgent(agentId, (a) => ({ status: a.status, at: Date.parse(a.lastActivityAt) || 0 }));
}

/** The facts: Paseo's live snapshot where the host offers one (panels), else what the daemon last saw (never older than ~2 s). */
export function useVerdict(view: CanvasView, live: Live = null): { verdict: Verdict; run: RunState; lastActivityAt: number; now: number } {
  const now = useNow();
  const run: RunState = live?.status ?? view.runState;
  const verdict = checkHonesty(view.tree, { runState: run, canvasUpdatedAt: view.updatedAt, toolCallsSinceUpdate: Math.max(0, view.callsNow - view.callsAtUpdate), now });
  return { verdict, run, lastActivityAt: live?.at || view.lastActivityAt, now };
}

function badgeColor(theme: Theme, label: Verdict["label"]) {
  return label === "Error" ? theme.colors.statusDanger : label === "Disputed" || label === "Stale" ? theme.colors.statusWarning : label === "Needs you" ? theme.colors.accent : label === "Done" ? theme.colors.statusSuccess : theme.colors.foregroundMuted;
}
function flagColor(theme: Theme, f: Flag) {
  return f.severity === "error" ? theme.colors.statusDanger : f.severity === "warn" ? theme.colors.statusWarning : theme.colors.accent;
}

/** Paseo-owned: built only from Paseo facts and the verdict. The agent has no way to write into it. */
export function LiveStrip({ view, theme, live }: { view: CanvasView; theme: Theme; live: Live }) {
  const { verdict, run, lastActivityAt, now } = useVerdict(view, live);
  const calls = Math.max(0, view.callsNow - view.callsAtUpdate);
  const color = badgeColor(theme, verdict.label);
  const muted = { color: theme.colors.foregroundMuted, fontSize: 12 } as const;
  return (
    <View style={{ gap: 6 }}>
      <View style={{ gap: 2, padding: 10, borderRadius: 10, borderWidth: 1, borderStyle: "dashed", borderColor: theme.colors.border }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <View style={{ width: 9, height: 9, borderRadius: 5, backgroundColor: run === "running" ? theme.colors.accent : run === "error" ? theme.colors.statusDanger : theme.colors.statusSuccess }} />
          <Text style={{ color, fontWeight: "700", fontSize: 13 }}>{verdict.label}</Text>
          <Text style={muted}>Paseo: {run}</Text>
        </View>
        <Text style={muted}>{view.currentTool ? `running ${view.currentTool}` : "no tool running"} · active {ago(now - lastActivityAt)} ago</Text>
        <Text style={muted}>{view.updatedAt == null ? "canvas never written (auto canvas)" : `canvas updated ${ago(now - view.updatedAt)} ago`} · {calls} tool call{calls === 1 ? "" : "s"} since</Text>
      </View>
      {verdict.flags.filter((f) => f.severity !== "info" || f.code === "needs-you").map((f) => (
        <Text key={f.code} style={{ color: flagColor(theme, f), fontSize: 13, padding: 8, borderRadius: 8, borderWidth: 1, borderColor: flagColor(theme, f) }}>
          {f.severity === "error" ? "⛔ " : f.severity === "warn" ? "⚠️ " : "🔔 "}{f.text}
        </Text>
      ))}
    </View>
  );
}

/** Runs of Metrics sit side by side; everything else stays one block per row. */
function groupMetrics(nodes: Node[]): (Node | Node[])[] {
  const out: (Node | Node[])[] = [];
  for (const n of nodes) {
    const last = out[out.length - 1];
    if (n.tag === "Metric" && Array.isArray(last)) last.push(n);
    else if (n.tag === "Metric") out.push([n]);
    else out.push(n);
  }
  return out;
}

export function CanvasBody({ view, theme, withBrowserLink, live = null }: { view: CanvasView; theme: Theme; withBrowserLink?: boolean; live?: Live }) {
  const { verdict } = useVerdict(view, live);
  const t = view.tree;
  return (
    <View style={{ gap: 10 }}>
      <LiveStrip view={view} theme={theme} live={live} />
      <View style={{ gap: 10, opacity: verdict.dim ? 0.45 : 1 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text style={{ color: theme.colors.foreground, fontSize: 20, fontWeight: "700", flexShrink: 1 }}>{view.title}</Text>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, borderWidth: 1, borderColor: theme.colors.border, borderRadius: 99, paddingHorizontal: 8, paddingVertical: 1 }}>
            {view.auto ? "auto canvas" : String(t.attrs.status ?? "working")}
          </Text>
        </View>
        {groupMetrics(t.children).map((g) =>
          Array.isArray(g) ? (
            <View key={g[0].id} style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {g.map((c) => <Block key={c.id} n={c} agentId={view.agentId} theme={theme} />)}
            </View>
          ) : (
            <Block key={g.id} n={g} agentId={view.agentId} theme={theme} />
          ),
        )}
        {t.children.length === 0 ? <Text style={{ color: theme.colors.foregroundMuted }}>Nothing yet.</Text> : null}
      </View>
      {withBrowserLink ? <Button theme={theme} quiet label="Open in browser" onPress={() => openUrl(view.url)} /> : null}
    </View>
  );
}
