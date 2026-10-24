// Native block renderer: composes the shared primitives from the shared plan. No colours or rules live here.
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { planBlocks, type BlockPlan } from "../shared/plan";
import { answerRpc } from "../shared/contract";
import { Bar, Button, Chip, DeltaChip, GlyphCircle, Meta, Region, Section, SectionLabel, Sheet, StatusDot, StepRow, Txt, Well } from "./ui/atoms";
import { ink, typeStyle, useT } from "./ui/tokens";
import { openUrl } from "./common";
import type { Node } from "../shared/canvas";

/**
 * The open question. `panel` is the one tinted region of a surface; `flat` sits inside a card that is already the
 * container (the timeline), so it only gets a hairline above it. Answered, it collapses to the chosen option.
 */
export function AskPanel({ plan, agentId, variant = "panel" }: { plan: Extract<BlockPlan, { kind: "ask" }>; agentId: string; variant?: "panel" | "flat" }) {
  const t = useT();
  const answer = useRpc(answerRpc);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pick = async (value: string) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await answer({ agentId, askId: plan.id, value });
      if (!r.ok) setErr(r.error ?? "failed");
    } catch (e) { setErr((e as Error).message); }
    setBusy(false);
  };
  if (plan.answered !== null) {
    return (
      <Section>
        <SectionLabel text="Answered" />
        <Txt c="muted">{plan.question}</Txt>
        <Chip tone="ok" glyph="✓" text={plan.answered} />
      </Section>
    );
  }
  const body = (
    <View style={{ gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <StatusDot tone="hot" size={6} halo={false} />
        <Txt role="label" c="hot">Question</Txt>
      </View>
      <Txt role="ledeStrong">{plan.question}</Txt>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        {plan.options.map((o) => <Button key={o.value} label={o.label} disabled={busy} onPress={() => void pick(o.value)} />)}
      </View>
      {err ? <Txt role="meta" c="err">{err}</Txt> : null}
    </View>
  );
  if (variant === "flat") return <View style={{ gap: 10, paddingTop: 12, borderTopWidth: 1, borderTopColor: t.line }}>{body}</View>;
  return <View style={{ backgroundColor: t.askTint, borderRadius: 10, padding: 14 }}>{body}</View>;
}

function Metrics({ plan }: { plan: Extract<BlockPlan, { kind: "metrics" }> }) {
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 28, rowGap: 12 }}>
      {plan.items.map((m) => (
        <View key={m.id}>
          <Meta>{m.label}</Meta>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Txt role="screenTitle" c={m.valueSignal ?? "fg"} weight="600">{m.head}</Txt>
            {m.delta ? <DeltaChip delta={m.delta} /> : null}
          </View>
        </View>
      ))}
    </View>
  );
}

function Table({ plan }: { plan: Extract<BlockPlan, { kind: "table" }> }) {
  const t = useT();
  const cell = (num: boolean) => ({ flex: 1, textAlign: num ? ("right" as const) : ("left" as const) });
  return (
    <View>
      <View style={{ flexDirection: "row", backgroundColor: t.well, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 }}>
        {plan.cols.map((c, i) => <Text key={i} style={[typeStyle("label"), cell(plan.numeric[i]), { color: t.muted }]}>{c}</Text>)}
      </View>
      {plan.rows.map((r, ri) => (
        <View key={ri} style={{ flexDirection: "row", paddingVertical: 7, paddingHorizontal: 8, borderBottomWidth: ri === plan.rows.length - 1 ? 0 : 1, borderBottomColor: t.line }}>
          {r.map((c, ci) => <Text key={ci} style={[typeStyle("body", c.best ? "500" : "400"), cell(plan.numeric[ci]), { color: c.best ? ink(t, "ok") : t.fg }]}>{c.text}</Text>)}
        </View>
      ))}
    </View>
  );
}

function Diff({ plan }: { plan: Extract<BlockPlan, { kind: "diff" }> }) {
  const t = useT();
  const row = (k: string) => (k === "add" ? { c: ink(t, "ok"), bg: t.sig("ok").tint } : k === "del" ? { c: ink(t, "err"), bg: t.sig("err").tint } : k === "hunk" ? { c: ink(t, "run"), bg: "transparent" } : { c: t.muted, bg: "transparent" });
  return (
    <Section>
      {plan.file ? (
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          <Txt role="mono" c="fg">{plan.file}</Txt>
          <Text style={[typeStyle("mono", "500")]}>
            <Text style={{ color: ink(t, "ok") }}>+{plan.add}</Text>
            <Text style={{ color: t.muted }}> </Text>
            <Text style={{ color: ink(t, "err") }}>−{plan.del}</Text>
          </Text>
        </View>
      ) : null}
      <Well>
        {plan.lines.map((l, i) => {
          const r = row(l.kind);
          return <Text key={i} style={[typeStyle("mono"), { color: r.c, backgroundColor: r.bg, paddingHorizontal: 12, opacity: l.kind === "hunk" ? 0.8 : 1 }]}>{l.text || " "}</Text>;
        })}
      </Well>
    </Section>
  );
}

function Chart({ plan }: { plan: Extract<BlockPlan, { kind: "chart" }> }) {
  // No SVG in the plugin UI kit: both kinds draw as labelled bars natively (the browser view draws the real line).
  const max = Math.max(...plan.points.map((p) => p.value), 1);
  return (
    <Section>
      {plan.label ? <SectionLabel text={plan.label} /> : null}
      {plan.points.map((p, i) => (
        <View key={i} style={{ gap: 4 }}>
          <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
            <Meta>{p.label}</Meta>
            <Txt role="label" c="fg">{p.value}</Txt>
          </View>
          <Bar pct={(p.value / max) * 100} tone="run" height={6} />
        </View>
      ))}
    </Section>
  );
}

export function BlockView({ plan, agentId, askVariant, dense }: { plan: BlockPlan; agentId: string; askVariant?: "panel" | "flat"; /** steps without their tick strip (the popover shows it in its header) */ dense?: boolean }) {
  const t = useT();
  switch (plan.kind) {
    case "bluf": return <Txt role="lede">{plan.text}</Txt>;
    case "steps":
      return (
        <Section>
          <SectionLabel text={plan.label} ticks={dense ? undefined : plan.ticks} count={dense ? undefined : plan.count} />
          <View style={{ gap: 2 }}>{plan.rows.map((r) => <StepRow key={r.id} state={r.state} text={r.text} />)}</View>
        </Section>
      );
    case "progress":
      return (
        <Section>
          <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" }}>
            <Meta>{plan.label}</Meta>
            <Txt role="label" c={plan.signal} weight="600">{plan.text}</Txt>
          </View>
          <Bar pct={plan.pct} tone={plan.signal} ticks />
        </Section>
      );
    case "metrics": return <Metrics plan={plan} />;
    case "decision":
      return (
        <Section>
          <SectionLabel text={plan.label} />
          {plan.chosen ? <Chip tone="ok" glyph="✓" text={plan.chosen} /> : null}
          {plan.reason ? <Txt c="muted">{plan.reason}</Txt> : null}
        </Section>
      );
    case "ask": return <AskPanel plan={plan} agentId={agentId} variant={askVariant} />;
    case "diff": return <Diff plan={plan} />;
    case "code": return <Well>{plan.text.split("\n").map((l, i) => <Text key={i} style={[typeStyle("mono"), { color: t.fg, paddingHorizontal: 12 }]}>{l || " "}</Text>)}</Well>;
    case "chart": return <Chart plan={plan} />;
    case "table": return <Table plan={plan} />;
    case "link":
      return (
        <Pressable accessibilityRole="link" onPress={() => openUrl(plan.href)} style={{ alignSelf: "flex-start" }}>
          <Txt c="run">{plan.text} ↗</Txt>
        </Pressable>
      );
    case "note":
      return (
        <Region tone={plan.signal} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
          <GlyphCircle size={18} tone={plan.signal} glyph={plan.glyph} solid weight="700" />
          <View style={{ flex: 1 }}><Txt>{plan.text}</Txt></View>
        </Region>
      );
  }
}

/** The blocks of a canvas as one sheet. */
export function Blocks({ root, agentId, only, askVariant, dense, gap }: { root: Node; agentId: string; only?: ReadonlySet<string>; askVariant?: "panel" | "flat"; dense?: boolean; gap?: number }) {
  return <Sheet gap={gap}>{planBlocks(root, only).map((p) => <BlockView key={p.id} plan={p} agentId={agentId} askVariant={askVariant} dense={dense} />)}</Sheet>;
}
