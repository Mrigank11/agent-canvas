// Native tokens: built once from the host theme and handed down by context, so no primitive takes a theme prop.
import type { PluginHostProps } from "@getpaseo/plugin/client";
import { createContext, useContext, useMemo, type ReactNode } from "react";
import { tokensFromTheme, TYPE, type Tokens, type Tone, type TypeRole } from "../../shared/ui-spec";

export type Theme = PluginHostProps["theme"];
const Ctx = createContext<Tokens | null>(null);

export function UiRoot({ theme, children }: { theme: Theme; children: ReactNode }) {
  const t = useMemo(() => tokensFromTheme(theme.colors), [theme]);
  return <Ctx.Provider value={t}>{children}</Ctx.Provider>;
}
export function useT(): Tokens {
  const t = useContext(Ctx);
  if (!t) throw new Error("agent-canvas: UI primitive used outside <UiRoot>");
  return t;
}

export type Ink = "fg" | "muted" | "faint" | Tone;
/** Text colour for an ink: a base token, or the readable `text` shade of a signal. */
export function ink(t: Tokens, c: Ink): string {
  return c === "fg" ? t.fg : c === "muted" ? t.muted : c === "faint" ? t.faint : t.sig(c).text;
}
export function typeStyle(role: keyof typeof TYPE, weight?: TypeRole["weight"]) {
  const r = TYPE[role];
  return { fontSize: r.size, lineHeight: r.line, fontWeight: weight ?? r.weight, fontVariant: ["tabular-nums" as const], ...(role === "mono" ? { fontFamily: "monospace" } : {}) };
}
