import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { chartPoints, type Node } from "../shared/canvas";
import { answerRpc } from "../shared/contract";
import { Button, openUrl, type Theme } from "./common";

const STEP_ICON: Record<string, string> = { done: "✓", active: "●", pending: "○", failed: "✕", skipped: "–" };

function Card({ theme, children, accent }: { theme: Theme; children: React.ReactNode; accent?: boolean }) {
  return <View style={{ gap: 6, padding: 12, borderRadius: 12, borderWidth: 1, borderColor: accent ? theme.colors.accent : theme.colors.border, backgroundColor: theme.colors.surface1 }}>{children}</View>;
}
function Label({ theme, children }: { theme: Theme; children: string }) {
  return <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, fontWeight: "700", letterSpacing: 0.6 }}>{children.toUpperCase()}</Text>;
}
function toneColor(theme: Theme, tone: unknown) {
  return tone === "warn" ? theme.colors.statusWarning : tone === "error" ? theme.colors.statusDanger : tone === "success" ? theme.colors.statusSuccess : theme.colors.accent;
}

function AskBlock({ n, agentId, theme }: { n: Node; agentId: string; theme: Theme }) {
  const answer = useRpc(answerRpc);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const answered = n.attrs.answer ? String(n.attrs.answer) : null;
  const pick = async (value: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await answer({ agentId, askId: n.id, value });
      if (!r.ok) setErr(r.error ?? "failed");
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  return (
    <Card theme={theme} accent={answered === null}>
      <Label theme={theme}>{answered === null ? "Question" : "Answered"}</Label>
      <Text style={{ color: theme.colors.foreground, fontSize: 16 }}>{String(n.attrs.question)}</Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {n.children.map((o) => {
          const v = String(o.attrs.value);
          if (answered !== null) {
            const picked = answered === v;
            return (
              <View key={o.id} style={{ paddingHorizontal: 14, paddingVertical: 8, borderRadius: 99, borderWidth: 1, borderColor: picked ? theme.colors.statusSuccess : theme.colors.border, backgroundColor: picked ? theme.colors.statusSuccess : "transparent", opacity: picked ? 1 : 0.5 }}>
                <Text style={{ color: picked ? theme.colors.surface0 : theme.colors.foregroundMuted }}>{o.text || v}</Text>
              </View>
            );
          }
          return <Button key={o.id} theme={theme} label={o.text || v} disabled={busy} onPress={() => void pick(v)} />;
        })}
      </View>
      {err ? <Text style={{ color: theme.colors.statusDanger, fontSize: 13 }}>{err}</Text> : null}
    </Card>
  );
}

export function Block({ n, agentId, theme }: { n: Node; agentId: string; theme: Theme }) {
  const fg = { color: theme.colors.foreground } as const;
  const muted = { color: theme.colors.foregroundMuted } as const;
  switch (n.tag) {
    case "Bluf": return <Text style={{ ...fg, fontSize: 17, lineHeight: 24 }}>{n.text}</Text>;
    case "Steps":
      return (
        <Card theme={theme}>
          <Label theme={theme}>{String(n.attrs.title ?? "Steps")}</Label>
          {n.children.map((s) => {
            const st = String(s.attrs.state);
            const color = st === "done" ? theme.colors.statusSuccess : st === "active" ? theme.colors.accent : st === "failed" ? theme.colors.statusDanger : theme.colors.foregroundMuted;
            return (
              <View key={s.id} style={{ flexDirection: "row", gap: 10 }}>
                <Text style={{ color, width: 18, textAlign: "center", fontSize: 15 }}>{STEP_ICON[st]}</Text>
                <Text style={{ flex: 1, fontSize: 15, color: st === "pending" || st === "skipped" ? theme.colors.foregroundMuted : theme.colors.foreground, fontWeight: st === "active" ? "700" : "400" }}>{s.text}</Text>
              </View>
            );
          })}
        </Card>
      );
    case "Progress": {
      const max = Number(n.attrs.max ?? 100) || 100;
      const pct = Math.max(0, Math.min(100, (Number(n.attrs.value) / max) * 100));
      return (
        <View style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Text style={{ ...muted, fontSize: 13 }}>{String(n.attrs.label ?? "")}</Text>
            <Text style={{ ...fg, fontSize: 13, fontWeight: "700" }}>{Math.round(pct)}%</Text>
          </View>
          <View style={{ height: 8, borderRadius: 4, backgroundColor: theme.colors.border, overflow: "hidden" }}>
            <View style={{ width: `${pct}%`, height: 8, backgroundColor: theme.colors.accent }} />
          </View>
        </View>
      );
    }
    case "Metric":
      return (
        <View style={{ alignSelf: "flex-start", paddingHorizontal: 14, paddingVertical: 8, borderRadius: 12, borderWidth: 1, borderColor: theme.colors.border, backgroundColor: theme.colors.surface1 }}>
          <Text style={{ ...muted, fontSize: 12 }}>{String(n.attrs.label)}</Text>
          <Text style={{ color: n.attrs.tone ? toneColor(theme, n.attrs.tone) : theme.colors.foreground, fontSize: 20, fontWeight: "700" }}>{String(n.attrs.value)}</Text>
        </View>
      );
    case "Decision":
      return (
        <Card theme={theme}>
          <Label theme={theme}>{`Decision · ${n.attrs.title}`}</Label>
          {n.attrs.chosen ? <Text style={{ ...fg, fontWeight: "700" }}>→ {String(n.attrs.chosen)}</Text> : null}
          <Text style={{ ...muted, fontSize: 14 }}>{n.text}</Text>
        </Card>
      );
    case "Ask": return <AskBlock n={n} agentId={agentId} theme={theme} />;
    case "Diff":
      return (
        <Card theme={theme}>
          {n.attrs.file ? <Label theme={theme}>{String(n.attrs.file)}</Label> : null}
          {n.text.split("\n").map((l, i) => (
            <Text key={i} style={{ fontFamily: "monospace", fontSize: 12, color: l.startsWith("+") ? theme.colors.statusSuccess : l.startsWith("-") ? theme.colors.statusDanger : theme.colors.foregroundMuted }}>{l || " "}</Text>
          ))}
        </Card>
      );
    case "Chart": {
      // No SVG in the plugin UI kit, so both chart kinds draw as labelled bars on native; the browser view draws a real line.
      const pts = chartPoints(String(n.attrs.data)) ?? [];
      const max = Math.max(...pts.map((p) => p.value), 1);
      return (
        <Card theme={theme}>
          {n.attrs.title ? <Label theme={theme}>{String(n.attrs.title)}</Label> : null}
          {pts.map((p, i) => (
            <View key={i} style={{ gap: 2 }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
                <Text style={{ ...muted, fontSize: 12 }}>{p.label}</Text>
                <Text style={{ ...fg, fontSize: 12 }}>{p.value}</Text>
              </View>
              <View style={{ height: 6, borderRadius: 3, backgroundColor: theme.colors.border }}>
                <View style={{ width: `${(p.value / max) * 100}%`, height: 6, borderRadius: 3, backgroundColor: theme.colors.accent }} />
              </View>
            </View>
          ))}
        </Card>
      );
    }
    case "Table": {
      const cols = String(n.attrs.cols).split("|").map((c) => c.trim());
      return (
        <Card theme={theme}>
          <View style={{ flexDirection: "row" }}>{cols.map((c, i) => <Text key={i} style={{ flex: 1, ...muted, fontSize: 12, fontWeight: "700" }}>{c}</Text>)}</View>
          {n.children.map((r) => (
            <View key={r.id} style={{ flexDirection: "row" }}>{r.text.split("|").map((c, i) => <Text key={i} style={{ flex: 1, ...fg, fontSize: 14 }}>{c.trim()}</Text>)}</View>
          ))}
        </Card>
      );
    }
    case "Link": return <Text accessibilityRole="link" onPress={() => openUrl(String(n.attrs.href))} style={{ color: theme.colors.accent, fontSize: 15 }}>{n.text || String(n.attrs.href)}</Text>;
    case "Note":
      return <Text style={{ ...fg, fontSize: 14, padding: 10, borderLeftWidth: 3, borderLeftColor: toneColor(theme, n.attrs.tone), backgroundColor: theme.colors.surface1, borderRadius: 6 }}>{n.text}</Text>;
    case "Code":
      return <Text style={{ fontFamily: "monospace", fontSize: 12, color: theme.colors.foreground, padding: 10, backgroundColor: theme.colors.surface1, borderRadius: 8 }}>{n.text}</Text>;
    default: return null;
  }
}
