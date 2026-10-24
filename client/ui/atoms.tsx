// The reusable native primitives (design v2, section 4.3). Each reads the tokens by context and the rules from shared/.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { AccessibilityInfo, Animated, Pressable, ScrollView, Text, View, type StyleProp, type TextStyle, type ViewStyle } from "react-native";
import type { StepState } from "../../shared/canvas";
import type { ActivityPlan, BackgroundPlan, FlagPlan, JobChipPlan, JobRowPlan, StatusPlan } from "../../shared/plan";
import { FLAG_GLYPH, RADIUS, STEP_GLYPH, stepSignal, type Delta, type Tone } from "../../shared/ui-spec";
import { ink, typeStyle, useT, type Ink } from "./tokens";

/** Text in a type role and an ink. */
export function Txt({ role = "body", c = "fg", weight, style, children, numberOfLines, strike }: { role?: Parameters<typeof typeStyle>[0]; c?: Ink; weight?: "400" | "500" | "600"; style?: StyleProp<TextStyle>; children: ReactNode; numberOfLines?: number; strike?: boolean }) {
  const t = useT();
  return <Text numberOfLines={numberOfLines} style={[typeStyle(role, weight), { color: ink(t, c) }, strike ? { textDecorationLine: "line-through" } : null, style]}>{children}</Text>;
}

function useReducedMotion(): boolean {
  const [r, setR] = useState(false);
  useEffect(() => { AccessibilityInfo.isReduceMotionEnabled().then(setR).catch(() => {}); }, []);
  return r;
}

/** A state lamp: a filled dot with a halo for live states, a check-free dot for ok, a hollow ring for idle. */
export function StatusDot({ tone, size = 8, halo, pulse }: { tone: Tone; size?: 6 | 7 | 8; halo?: boolean; pulse?: boolean }) {
  const t = useT();
  const s = t.sig(tone);
  const showHalo = halo ?? s.showHalo;
  const doPulse = (pulse ?? s.pulse) && !useReducedMotion();
  const o = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    if (!doPulse) { o.setValue(1); return; }
    const loop = Animated.loop(Animated.sequence([Animated.timing(o, { toValue: 0.55, duration: 700, useNativeDriver: true }), Animated.timing(o, { toValue: 1, duration: 700, useNativeDriver: true })]));
    loop.start();
    return () => loop.stop();
  }, [doPulse, o]);
  const pad = showHalo ? 3 : 0;
  const dot: ViewStyle = s.ring ? { width: size, height: size, borderRadius: size, borderWidth: 1.5, borderColor: s.dot } : { width: size, height: size, borderRadius: size, backgroundColor: s.dot };
  return (
    <Animated.View style={{ width: size + pad * 2, height: size + pad * 2, borderRadius: size, alignItems: "center", justifyContent: "center", backgroundColor: showHalo ? s.halo : "transparent", margin: -pad, opacity: o }}>
      <View style={dot} />
    </Animated.View>
  );
}

/** A spinning ring for a running job: an arc in the run colour that turns. Still (a three-quarter ring) under reduced motion. */
export function Spinner({ size = 14 }: { size?: number }) {
  const t = useT();
  const s = t.sig("run");
  const reduced = useReducedMotion();
  const r = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduced) { r.setValue(0); return; }
    const loop = Animated.loop(Animated.timing(r, { toValue: 1, duration: 900, easing: (x) => x, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [reduced, r]);
  const spin = r.interpolate({ inputRange: [0, 1], outputRange: ["0deg", "360deg"] });
  return <Animated.View accessibilityLabel="running" style={{ width: size, height: size, borderRadius: size, borderWidth: 2, borderColor: s.tint, borderTopColor: s.dot, ...(reduced ? { borderRightColor: s.dot } : null), transform: [{ rotate: spin }] }} />;
}

/** Tinted, borderless badge: the one place a verdict is spelled out. */
export function StatusBadge({ tone, label, glyph = "dot" }: { tone: Tone; label: string; glyph?: "dot" | "check" | "none" }) {
  const t = useT();
  const s = t.sig(tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 22, paddingLeft: 7, paddingRight: 8, borderRadius: RADIUS.chip, backgroundColor: s.tint, alignSelf: "flex-start" }}>
      {glyph === "dot" ? <StatusDot tone={tone} size={6} halo={false} pulse={false} /> : glyph === "check" ? <Text style={{ color: s.text, fontSize: 11 }}>✓</Text> : null}
      <Text style={{ color: s.text, fontSize: 12, lineHeight: 16, fontWeight: "500" }} numberOfLines={1}>{label}</Text>
    </View>
  );
}

export function Meta({ children, c = "muted", numberOfLines }: { children: ReactNode; c?: Ink; numberOfLines?: number }) {
  return <Txt role="meta" c={c} numberOfLines={numberOfLines}>{children}</Txt>;
}

/** One segment per step, coloured by that step's state. */
export function ProgressTicks({ states, max = 120 }: { states: readonly StepState[]; max?: number | null }) {
  const t = useT();
  if (!states.length) return null;
  const color = (s: StepState) => (s === "done" ? t.sig("ok").dot : s === "active" ? t.sig("run").dot : s === "failed" ? t.sig("err").dot : s === "skipped" ? t.line : t.dark ? t.lineStrong : t.well);
  return (
    <View style={{ flexDirection: "row", gap: 2, height: 4, flex: 1, minWidth: 40, ...(max ? { maxWidth: max } : {}) }}>
      {states.map((s, i) => <View key={i} style={{ flex: 1, borderRadius: 1, backgroundColor: color(s) }} />)}
    </View>
  );
}

export function SectionLabel({ text, ticks, count, tone }: { text: string; ticks?: readonly StepState[]; count?: string; tone?: Tone }) {
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
      {tone ? <StatusDot tone={tone} size={6} halo={false} pulse={false} /> : null}
      <Txt role="label" c={tone ?? "muted"}>{text}</Txt>
      {ticks ? <ProgressTicks states={ticks} max={null} /> : <View style={{ flex: 1 }} />}
      {count ? <Txt role="label" c="fg">{count}</Txt> : null}
    </View>
  );
}

/** A flat bar. Fill is the run signal, switching to ok when complete; quarter gaps are optional. */
export function Bar({ pct, tone = "run", height = 6, ticks }: { pct: number; tone?: Tone; height?: 4 | 6; ticks?: boolean }) {
  const t = useT();
  return (
    <View style={{ height, borderRadius: height / 2, overflow: "hidden", backgroundColor: t.dark ? t.lineStrong : t.well }}>
      <View style={{ width: `${Math.max(0, Math.min(100, pct))}%`, height, backgroundColor: t.sig(tone).dot, borderRadius: height / 2 }} />
      {ticks ? [25, 50, 75].map((p) => <View key={p} style={{ position: "absolute", left: `${p}%`, top: 0, bottom: 0, width: 1, backgroundColor: t.bg }} />) : null}
    </View>
  );
}

/** A tinted circle holding a glyph: step ticks, flag marks, note icons. */
export function GlyphCircle({ size, tone, glyph, solid, weight = "600" }: { size: number; tone: Tone; glyph: string; solid?: boolean; weight?: "600" | "700" }) {
  const t = useT();
  const s = t.sig(tone);
  return (
    <View style={{ width: size, height: size, borderRadius: size, alignItems: "center", justifyContent: "center", backgroundColor: solid ? s.dot : s.tint }}>
      <Text style={{ color: solid ? t.bg : s.text, fontSize: size <= 16 ? 10 : 11, fontWeight: weight, lineHeight: size <= 16 ? 12 : 14 }}>{glyph}</Text>
    </View>
  );
}

export function StepGlyph({ state }: { state: StepState }) {
  const t = useT();
  const box = { width: 16, height: 16, alignItems: "center" as const, justifyContent: "center" as const };
  if (state === "active") return <View style={box}><StatusDot tone="run" size={7} /></View>;
  if (state === "done" || state === "failed") return <GlyphCircle size={16} tone={stepSignal(state)} glyph={STEP_GLYPH[state]} />;
  if (state === "pending") return <View style={{ ...box, borderRadius: 8, borderWidth: 1.5, borderColor: t.line }} />;
  return <View style={box}><Text style={{ color: t.faint, fontSize: 12 }}>{STEP_GLYPH.skipped}</Text></View>;
}

export function StepRow({ state, text }: { state: StepState; text: string }) {
  const t = useT();
  const active = state === "active";
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 26, marginHorizontal: -8, paddingHorizontal: 8, borderRadius: RADIUS.chip, backgroundColor: active ? t.sig("run").tint : "transparent" }}>
      <StepGlyph state={state} />
      <View style={{ flex: 1 }}>
        <Txt c={state === "failed" ? "err" : state === "pending" ? "muted" : state === "skipped" ? "faint" : "fg"} weight={active ? "500" : "400"} strike={state === "skipped"}>{text}</Txt>
      </View>
    </View>
  );
}

export function Chip({ tone = "ok", text, glyph }: { tone?: Tone; text: string; glyph?: string }) {
  const t = useT();
  const s = t.sig(tone);
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 5, height: 22, paddingHorizontal: 8, borderRadius: RADIUS.chip, backgroundColor: s.tint, alignSelf: "flex-start" }}>
      {glyph ? <Text style={{ color: s.text, fontSize: 13 }}>{glyph}</Text> : null}
      <Text style={{ color: s.text, fontSize: 13, fontWeight: "500" }}>{text}</Text>
    </View>
  );
}

export function DeltaChip({ delta }: { delta: Delta }) {
  const t = useT();
  const s = t.sig(delta.signal);
  return (
    <View style={{ height: 18, paddingHorizontal: 5, borderRadius: 4, backgroundColor: s.tint, justifyContent: "center" }}>
      <Text style={{ color: s.text, fontSize: 11, fontWeight: "600" }}>{delta.text}</Text>
    </View>
  );
}

export function Button({ label, onPress, variant = "secondary", disabled }: { label: string; onPress: () => void; variant?: "primary" | "secondary" | "ghost"; disabled?: boolean }) {
  const t = useT();
  const hot = t.sig("hot");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        alignSelf: "flex-start",
        height: 32,
        paddingHorizontal: variant === "ghost" ? 4 : 12,
        borderRadius: RADIUS.control,
        justifyContent: "center",
        borderWidth: variant === "secondary" ? 1 : 0,
        borderColor: pressed ? "transparent" : t.dark ? t.lineStrong : t.line,
        backgroundColor: variant === "primary" ? t.fg : variant === "secondary" ? (pressed ? hot.tint : t.bg) : "transparent",
        opacity: disabled ? 0.5 : 1,
      })}
    >
      {({ pressed }) => <Text style={{ fontSize: 13, fontWeight: "500", color: variant === "primary" ? t.bg : variant === "ghost" ? t.muted : pressed ? hot.text : t.fg }}>{label}</Text>}
    </Pressable>
  );
}

/** A bare tinted region (a note, the needs-you row). At most one per surface. */
export function Region({ tone, children, style }: { tone: Tone; children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const t = useT();
  return <View style={[{ backgroundColor: t.sig(tone).tint, borderRadius: RADIUS.region, paddingVertical: 10, paddingHorizontal: 12 }, style]}>{children}</View>;
}
export function Well({ children }: { children: ReactNode }) {
  const t = useT();
  return <View style={{ backgroundColor: t.well, borderRadius: RADIUS.region, paddingVertical: 8, overflow: "hidden" }}>{children}</View>;
}
export function Section({ children, gap = 8 }: { children: ReactNode; gap?: number }) {
  return <View style={{ gap }}>{children}</View>;
}
export function Sheet({ children, gap = 20 }: { children: ReactNode; gap?: number }) {
  return <View style={{ gap }}>{children}</View>;
}
export function Hairline() {
  const t = useT();
  return <View style={{ height: 1, backgroundColor: t.line }} />;
}

export function FlagLine({ flag }: { flag: FlagPlan }) {
  return (
    <View style={{ flexDirection: "row", gap: 8, alignItems: "flex-start" }}>
      <GlyphCircle size={16} tone={flag.signal} glyph={FLAG_GLYPH[flag.signal]} />
      <View style={{ flex: 1 }}><Txt role="meta" c={flag.signal}>{flag.text}</Txt></View>
    </View>
  );
}

/** A 24px tinted square holding Paseo's own icon for the tool. "Last: …" uses a bare ring instead: nothing is running. */
export function ToolGlyph({ icon, tone, ring }: { icon: string; tone: "run" | "idle"; ring?: boolean }) {
  const t = useT();
  const s = t.sig(tone);
  if (ring) return <View style={{ width: 12, height: 12, borderRadius: 6, borderWidth: 1.5, borderColor: t.lineStrong, marginHorizontal: 6 }} />;
  return (
    <View style={{ width: 24, height: 24, borderRadius: RADIUS.chip, alignItems: "center", justifyContent: "center", backgroundColor: tone === "run" ? s.tint : t.well }}>
      <Icon name={icon} size={14} color={tone === "run" ? s.text : t.muted} />
    </View>
  );
}

export function MonoChip({ text }: { text: string }) {
  return <Txt role="mono" c="muted" numberOfLines={1} style={{ fontSize: 11.5, lineHeight: 16 }}>{text}</Txt>;
}

/**
 * The Now row: what the agent is doing this second. Icon, humanised label, the target as a muted mono chip and a ticking
 * elapsed time. Tap it for the full command and the last three actions. Quiet "Last: …" when nothing is running.
 */
export function ActivityRow(props: { plan: ActivityPlan; variant?: "now" } | { plan: JobRowPlan; variant: "job" }) {
  return props.variant === "job" ? <JobRow plan={props.plan} /> : <NowRow plan={props.plan} />;
}

/** variant="job": the same row for one background job. A spinner and timer while it runs, a quiet check and the exit code when done, the one red-tinted row on failure. */
function JobRow({ plan }: { plan: JobRowPlan }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const expandable = !!plan.full || !!plan.lastEvent;
  const s = t.sig(plan.tone);
  const row = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingVertical: 4, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: RADIUS.control, backgroundColor: plan.tone === "err" ? s.tint : open ? t.raised : "transparent" }}>
      <View style={{ width: 24, height: 24, borderRadius: RADIUS.chip, alignItems: "center", justifyContent: "center", backgroundColor: plan.tone === "idle" ? t.well : s.tint }}>
        <Icon name={plan.icon} size={14} color={plan.tone === "idle" ? t.muted : s.text} />
      </View>
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt role="body" weight={plan.state === "running" ? "500" : "400"} c={plan.tone === "idle" ? "muted" : plan.state === "running" ? "fg" : plan.tone === "err" ? "err" : "muted"} numberOfLines={1} style={{ lineHeight: 18 }}>{plan.label}</Txt>
        {plan.target ? <MonoChip text={plan.target} /> : null}
      </View>
      {plan.extra ? <Txt role="meta" c="muted">{plan.extra}</Txt> : null}
      {plan.state === "running" ? <Spinner /> : null}
      <Txt role="label" c={plan.tone === "run" ? "run" : plan.tone === "err" ? "err" : plan.tone === "ok" ? "ok" : "faint"}>{plan.elapsed}</Txt>
      {expandable ? <Text style={{ color: t.faint, fontSize: 16, lineHeight: 16, width: 10, textAlign: "center", transform: [{ rotate: open ? "90deg" : "0deg" }] }}>›</Text> : null}
    </View>
  );
  return (
    <View>
      {expandable ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${plan.label}, ${plan.elapsed}`} onPress={() => setOpen(!open)}>{row}</Pressable> : row}
      {open ? (
        <View style={{ gap: 8, paddingTop: 6 }}>
          {plan.full ? <Well><ScrollView style={{ maxHeight: 8 * 17 + 4 }} nestedScrollEnabled>{plan.full.split("\n").map((l, i) => <Text key={i} style={[typeStyle("mono"), { fontSize: 11.5, lineHeight: 17, color: t.fg, paddingHorizontal: 12 }]}>{l || " "}</Text>)}</ScrollView></Well> : null}
          {plan.lastEvent ? <Meta>Last event: {plan.lastEvent}</Meta> : null}
        </View>
      ) : null}
    </View>
  );
}

/** The Background group: a label with the running count, one row per job, and "+n more" past the cap. */
export function JobGroup({ plan }: { plan: BackgroundPlan }) {
  return (
    <View style={{ gap: 2, paddingTop: 2 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
        <Txt role="label" c="muted">{plan.heading}</Txt>
        <View style={{ flex: 1 }} />
        <Txt role="label" c={plan.running ? "run" : "faint"}>{plan.count}</Txt>
      </View>
      {plan.rows.map((r) => <ActivityRow key={r.id} plan={r} variant="job" />)}
      {plan.more ? <Meta>{plan.more}</Meta> : null}
    </View>
  );
}

/** B's compact form of the same jobs: one tinted chip. */
export function JobChip({ chip }: { chip: JobChipPlan }) {
  return <Chip tone={chip.tone} glyph={chip.glyph} text={chip.text} />;
}

function NowRow({ plan }: { plan: ActivityPlan }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const expandable = !!plan.full || plan.recent.length > 0;
  const idleLast = !plan.live;
  const row = (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, minHeight: 32, paddingVertical: 4, paddingHorizontal: 8, marginHorizontal: -8, borderRadius: RADIUS.control, backgroundColor: open ? t.raised : "transparent" }}>
      <ToolGlyph icon={plan.icon} tone={plan.tone} ring={idleLast} />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Txt role="body" weight={plan.tone === "run" ? "500" : "400"} c={plan.tone === "run" ? "fg" : "muted"} numberOfLines={1} style={{ lineHeight: 18 }}>{plan.label}</Txt>
        {plan.target ? <MonoChip text={plan.target} /> : null}
      </View>
      <Txt role="label" c={plan.tone === "run" ? "run" : "faint"} style={{ marginLeft: "auto" }}>{plan.elapsed}</Txt>
      {expandable ? <Text style={{ color: t.faint, fontSize: 16, lineHeight: 16, width: 10, textAlign: "center", transform: [{ rotate: open ? "90deg" : "0deg" }] }}>›</Text> : null}
    </View>
  );
  return (
    <View>
      {expandable ? <Pressable accessibilityRole="button" accessibilityState={{ expanded: open }} accessibilityLabel={`${plan.label}, ${plan.elapsed}`} onPress={() => setOpen(!open)}>{row}</Pressable> : row}
      {open ? (
        <View style={{ gap: 10, paddingTop: 6 }}>
          {plan.full ? (
            <Well>
              <ScrollView style={{ maxHeight: 8 * 17 + 4 }} nestedScrollEnabled>
                {plan.full.split("\n").map((l, i) => <Text key={i} style={[typeStyle("mono"), { fontSize: 11.5, lineHeight: 17, color: t.fg, paddingHorizontal: 12 }]}>{l || " "}</Text>)}
              </ScrollView>
            </Well>
          ) : null}
          {plan.recent.length ? (
            <View style={{ gap: 0 }}>
              {plan.recent.map((r, i) => (
                <View key={i} style={{ flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 3 }}>
                  <View style={{ width: 8, height: 8, borderRadius: 4, ...(r.ok ? { backgroundColor: t.sig("ok").tint, borderWidth: 1.5, borderColor: t.sig("ok").dot } : { backgroundColor: t.sig("err").dot }) }} />
                  <Txt role="meta" c={r.ok ? "muted" : "err"}>{r.label}{!r.ok && r.exitCode != null ? ` · exit ${r.exitCode}` : ""}</Txt>
                </View>
              ))}
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

/** Paseo's own line: badge and run state, then the facts. The agent cannot write into it. */
export function StatusLine({ plan, hairline = true }: { plan: StatusPlan; hairline?: boolean }) {
  const t = useT();
  return (
    <View style={{ gap: 6, paddingBottom: hairline ? 12 : 0, borderBottomWidth: hairline ? 1 : 0, borderBottomColor: t.line }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <StatusBadge tone={plan.signal} label={plan.label} glyph={plan.signal === "ok" ? "check" : "dot"} />
        <Meta>{plan.run}</Meta>
      </View>
      {plan.activity ? <ActivityRow plan={plan.activity} /> : null}
      {plan.background ? <JobGroup plan={plan.background} /> : null}
      <Text style={typeStyle("meta")}>
        {plan.lead ? <Text style={{ color: ink(t, plan.leadSignal), fontWeight: "500" }}>{plan.lead}{" · "}</Text> : null}
        {plan.facts.map((f, i) => (
          <Text key={i} style={{ color: ink(t, f.signal ?? "muted") }}>{i > 0 ? " · " : ""}{f.text}</Text>
        ))}
      </Text>
      {plan.flags.map((f, i) => <FlagLine key={i} flag={f} />)}
    </View>
  );
}

/** The agent switcher: one segment per agent, each with its own status dot. */
export function Segmented({ items, value, onChange }: { items: { id: string; label: string; tone: Tone }[]; value: string | null; onChange: (id: string) => void }) {
  const t = useT();
  return (
    <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 2 }}>
      {items.map((it) => {
        const on = it.id === value;
        return (
          <Pressable key={it.id} accessibilityRole="button" onPress={() => onChange(it.id)} style={{ flexDirection: "row", alignItems: "center", gap: 6, height: 28, paddingHorizontal: 10, borderRadius: RADIUS.chip, maxWidth: "62%", backgroundColor: on ? t.well : "transparent" }}>
            <StatusDot tone={it.tone} size={6} />
            <Text numberOfLines={1} style={{ fontSize: 13, fontWeight: "500", color: on ? t.fg : t.muted, flexShrink: 1 }}>{it.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}
