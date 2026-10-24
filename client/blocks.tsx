// Native block renderer: composes the shared primitives from the shared plan. No colours or rules live here.
import { useRpc } from "@getpaseo/plugin/client";
import { useState } from "react";
import { Text, View } from "react-native";
import { planBlocks, type BlockPlan } from "../shared/plan";
import { answerRpc } from "../shared/contract";
import { Bar, Button, Chip, DeltaChip, GlyphCircle, Hairline, Meta, Region, Section, SectionLabel, Sheet, StatusDot, StepRow, Txt, Well } from "./ui/atoms";
import { ink, typeStyle, useT } from "./ui/tokens";
import { openUrl } from "./common";
import type { Node } from "../shared/canvas";
import type { Inline, MdBlock } from "../shared/markdown";

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

function MdInlines({ c, base }: { c: Inline[]; base?: object }) {
  const t = useT();
  return (
    <>
      {c.map((i, k) => {
        switch (i.t) {
          case "text": return <Text key={k} style={base}>{i.v}</Text>;
          case "code": return <Text key={k} style={[typeStyle("mono"), { color: t.fg, backgroundColor: t.well }]}>{i.v}</Text>;
          case "strong": return <Text key={k} style={{ fontWeight: "600" }}><MdInlines c={i.c} base={base} /></Text>;
          case "em": return <Text key={k} style={{ fontStyle: "italic" }}><MdInlines c={i.c} base={base} /></Text>;
          case "del": return <Text key={k} style={{ textDecorationLine: "line-through", color: t.muted }}><MdInlines c={i.c} base={base} /></Text>;
          case "link": return <Text key={k} accessibilityRole="link" onPress={() => openUrl(i.href)} style={{ color: ink(t, "run") }}><MdInlines c={i.c} base={base} /></Text>;
        }
      })}
    </>
  );
}

function MdTable({ b }: { b: Extract<MdBlock, { k: "table" }> }) {
  const t = useT();
  const cell = (i: number) => ({ flex: 1, textAlign: b.numeric[i] || b.align[i] === "right" ? ("right" as const) : b.align[i] === "center" ? ("center" as const) : ("left" as const) });
  return (
    <View>
      <View style={{ flexDirection: "row", backgroundColor: t.well, borderRadius: 6, paddingVertical: 5, paddingHorizontal: 8 }}>
        {b.head.map((c, i) => <Text key={i} style={[typeStyle("label"), cell(i), { color: t.muted }]}><MdInlines c={c} /></Text>)}
      </View>
      {b.rows.map((r, ri) => (
        <View key={ri} style={{ flexDirection: "row", paddingVertical: 7, paddingHorizontal: 8, borderBottomWidth: ri === b.rows.length - 1 ? 0 : 1, borderBottomColor: t.line }}>
          {r.map((c, ci) => <Text key={ci} style={[typeStyle("body", c.best ? "500" : "400"), cell(ci), { color: c.best ? ink(t, "ok") : t.fg }]}><MdInlines c={c.c} /></Text>)}
        </View>
      ))}
    </View>
  );
}

const HEADING_ROLE = ["screenTitle", "ledeStrong", "ledeStrong", "body", "body", "body"] as const;

function MdBlockView({ b }: { b: MdBlock }) {
  const t = useT();
  switch (b.k) {
    case "heading": return <Text style={[typeStyle(HEADING_ROLE[b.level - 1], "600"), { color: t.fg }]}><MdInlines c={b.c} /></Text>;
    case "paragraph": return <Text style={[typeStyle("body"), { color: t.fg }]}><MdInlines c={b.c} /></Text>;
    case "hr": return <Hairline />;
    case "code": return <Well>{b.text.split("\n").map((l, i) => <Text key={i} style={[typeStyle("mono"), { color: t.fg, paddingHorizontal: 12 }]}>{l || " "}</Text>)}</Well>;
    case "quote": return <View style={{ borderLeftWidth: 2, borderLeftColor: t.lineStrong, paddingLeft: 12, gap: 6 }}>{b.blocks.map((x, i) => <MdBlockView key={i} b={x} />)}</View>;
    case "alert":
      return (
        <Region tone={b.signal} style={{ flexDirection: "row", gap: 10, alignItems: "flex-start" }}>
          <GlyphCircle size={18} tone={b.signal} glyph={b.glyph} solid weight="700" />
          <View style={{ flex: 1, gap: 4 }}>
            <Txt role="label" c={b.signal}>{b.title}</Txt>
            {b.blocks.map((x, i) => <MdBlockView key={i} b={x} />)}
          </View>
        </Region>
      );
    case "list":
      return (
        <View style={{ gap: 4 }}>
          {b.items.map((it, i) => (
            <View key={i} style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
              {it.checked === null ? (
                <Text style={[typeStyle("body"), { color: t.muted, minWidth: 18 }]}>{b.ordered ? `${b.start + i}.` : "•"}</Text>
              ) : (
                <Text accessibilityLabel={it.checked ? "done" : "not done"} style={[typeStyle("body"), { color: it.checked ? ink(t, "ok") : t.faint, minWidth: 18 }]}>{it.checked ? "☑" : "☐"}</Text>
              )}
              <View style={{ flex: 1, gap: 4 }}>{it.blocks.map((x, k) => <MdBlockView key={k} b={x} />)}</View>
            </View>
          ))}
        </View>
      );
    case "table": return <MdTable b={b} />;
  }
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
    case "chart": return <Chart plan={plan} />;
    case "markdown": return <View style={{ gap: 8 }}>{plan.blocks.map((b, i) => <MdBlockView key={i} b={b} />)}</View>;
  }
}

/** The blocks of a canvas as one sheet. */
export function Blocks({ root, agentId, only, askVariant, dense, gap }: { root: Node; agentId: string; only?: ReadonlySet<string>; askVariant?: "panel" | "flat"; dense?: boolean; gap?: number }) {
  return <Sheet gap={gap}>{planBlocks(root, only).map((p) => <BlockView key={p.id} plan={p} agentId={agentId} askVariant={askVariant} dense={dense} />)}</Sheet>;
}
