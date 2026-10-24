// The single source of the canvas's look and its signalling rules (design v2, section 4).
// Pure data and pure functions: no React, no DOM. The native renderer, the browser renderer and the tests all
// read this file, so a colour, glyph or verdict-to-signal rule exists in exactly one place.
import type { Flag, Verdict } from "./honesty.ts";
import type { StepState } from "./canvas.ts";

// ---------- signals ----------

export type Tone = "hot" | "run" | "ok" | "idle" | "warn" | "err";
export const TONES: readonly Tone[] = ["hot", "run", "ok", "idle", "warn", "err"];

type Pair = { light: string; dark: string };
type SignalSpec = { dot: Pair | null; text: Pair | null; tintAlpha: Pair | null; /** hollow ring instead of a filled dot */ ring?: boolean; halo: boolean; pulse?: boolean };

/**
 * One hue per state. `dot` values are Paseo's own statusDot* colours (read from the web bundle: the plugin theme prop
 * does not expose them, so this is a deliberate local copy). `text` is the same hue shifted to pass 4.5:1 on surface0.
 * `idle` has no hue of its own: it borrows `faint`, `muted` and `well` from the base tokens.
 */
export const SIGNAL: Record<Tone, SignalSpec> = {
  hot: { dot: { light: "#299f51", dark: "#35c264" }, text: { light: "#1d7a3e", dark: "#5fd187" }, tintAlpha: { light: "1a", dark: "26" }, halo: true },
  run: { dot: { light: "#268ae0", dark: "#5caaf6" }, text: { light: "#1a6bb5", dark: "#7cbaf8" }, tintAlpha: { light: "1a", dark: "26" }, halo: true, pulse: true },
  ok: { dot: { light: "#299f51", dark: "#35c264" }, text: { light: "#1d7a3e", dark: "#5fd187" }, tintAlpha: { light: "1a", dark: "26" }, halo: false },
  idle: { dot: null, text: null, tintAlpha: null, ring: true, halo: false },
  warn: { dot: { light: "#b37824", dark: "#db932e" }, text: { light: "#8a5a12", dark: "#e8ac57" }, tintAlpha: { light: "1f", dark: "26" }, halo: true },
  err: { dot: { light: "#f12e2f", dark: "#f7796d" }, text: { light: "#c22526", dark: "#f7897f" }, tintAlpha: { light: "17", dark: "24" }, halo: true },
};

// ---------- base tokens ----------

export type BaseColors = { bg: string; raised: string; well: string; line: string; fg: string; muted: string };
/** Paseo's zinc light and dark values, used by the browser (no theme prop there) and as the fixtures for the native mapping. */
export const BASE: Record<"light" | "dark", BaseColors & { lineStrong: string; faint: string; askAlpha: string }> = {
  light: { bg: "#ffffff", raised: "#fafafa", well: "#f4f4f5", line: "#e4e4e7", lineStrong: "#e4e4e7", fg: "#1a1a1e", muted: "#71717a", faint: "#a1a1aa", askAlpha: "14" },
  dark: { bg: "#18181b", raised: "#1f1f22", well: "#27272a", line: "#27272a", lineStrong: "#3f3f46", fg: "#fafafa", muted: "#a1a1aa", faint: "#71717a", askAlpha: "1f" },
};

/** Relative luminance of a #rrggbb or #rgb colour below 0.5. Anything unparseable counts as light. */
export function isDark(bg: string): boolean {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(bg.trim());
  if (!m) return false;
  const h = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5;
}

/** hex + alpha when hex is #rrggbb, else the fallback (the `well` colour). */
export function tint(hex: string | null, alpha: string | null, fallback: string): string {
  return hex && alpha && /^#[0-9a-f]{6}$/i.test(hex) ? `${hex}${alpha}` : fallback;
}

export type Resolved = { dot: string; text: string; tint: string; halo: string; ring: boolean; pulse: boolean; showHalo: boolean };
export type Tokens = BaseColors & { dark: boolean; lineStrong: string; faint: string; askTint: string; sig: (t: Tone) => Resolved };

/** Native: build the tokens from the host theme's colours. `lineStrong`, `faint` and the signals are constants. */
export function tokensFromTheme(c: { surface0: string; surface1: string; surface2: string; border: string; foreground: string; foregroundMuted: string }): Tokens {
  const dark = isDark(c.surface0);
  const k = BASE[dark ? "dark" : "light"];
  return makeTokens({ bg: c.surface0, raised: c.surface1, well: c.surface2, line: c.border, fg: c.foreground, muted: c.foregroundMuted }, dark, k.lineStrong === k.line ? c.border : k.lineStrong, k.faint, k.askAlpha);
}
/** Browser or test: the fixed light or dark set. */
export function tokensFixed(mode: "light" | "dark"): Tokens {
  const k = BASE[mode];
  return makeTokens(k, mode === "dark", k.lineStrong, k.faint, k.askAlpha);
}

function makeTokens(b: BaseColors, dark: boolean, lineStrong: string, faint: string, askAlpha: string): Tokens {
  const col = dark ? "dark" : "light";
  const sig = (t: Tone): Resolved => {
    const s = SIGNAL[t];
    const dot = s.dot ? s.dot[col] : faint;
    return { dot, text: s.text ? s.text[col] : b.muted, tint: s.dot ? tint(dot, s.tintAlpha![col], b.well) : b.well, halo: s.dot ? tint(dot, s.tintAlpha![col], b.well) : "transparent", ring: !!s.ring, pulse: !!s.pulse, showHalo: s.halo };
  };
  const hot = sig("hot");
  return { ...b, dark, lineStrong, faint, askTint: tint(hot.dot, askAlpha, b.well), sig };
}

// ---------- type, space, radius ----------

export type TypeRole = { size: number; line: number; weight: "400" | "500" | "600" };
export const TYPE: Record<"meta" | "label" | "body" | "lede" | "ledeStrong" | "title" | "screenTitle" | "mono", TypeRole> = {
  meta: { size: 12, line: 16, weight: "400" },
  label: { size: 12, line: 16, weight: "500" },
  body: { size: 14, line: 20, weight: "400" },
  lede: { size: 15, line: 22, weight: "400" },
  ledeStrong: { size: 15, line: 22, weight: "500" },
  title: { size: 17, line: 24, weight: "600" },
  screenTitle: { size: 20, line: 28, weight: "600" },
  mono: { size: 12, line: 18, weight: "400" },
};
export const SPACE = { panel: 16, block: 20, inner: 8, ask: 14 } as const;
/** Below this width (px) a <Grid> is one column on every surface; the browser's media query and the native `gridColumns` both read it. */
export const GRID_COMPACT_BELOW = 560;
export const GRID_GAP = 12;
export const gridColumns = (cols: number, width: number): number => (width < GRID_COMPACT_BELOW ? 1 : Math.max(1, Math.min(3, Math.floor(cols))));
export const RADIUS = { control: 8, chip: 6, region: 10, card: 12 } as const;

// ---------- glyphs and signal mappings ----------

/** One table for step glyphs; the native and browser renderers both read it. */
export const STEP_GLYPH: Record<StepState, string> = { done: "✓", active: "●", pending: "○", failed: "✕", skipped: "–" };
export function stepSignal(state: StepState): Tone {
  return state === "done" ? "ok" : state === "active" ? "run" : state === "failed" ? "err" : "idle";
}

export const NOTE_GLYPH: Record<string, string> = { info: "i", warn: "!", error: "✕", success: "✓" };
export function noteSignal(tone: string | undefined): Tone {
  return tone === "warn" ? "warn" : tone === "error" ? "err" : tone === "success" ? "ok" : "run";
}
export function metricSignal(tone: string | undefined): Tone | null {
  return tone === "success" ? "ok" : tone === "warn" ? "warn" : tone === "error" ? "err" : null;
}

/** The verdict word to its signal. This is where Paseo's six states are decided; the pill re-exports it. */
export function signalFor(label: Verdict["label"]): Tone {
  switch (label) {
    case "Error": return "err";
    case "Needs you": return "hot";
    case "Disputed": case "Stale": return "warn";
    case "Working": case "Waiting": return "run";
    case "Done": return "ok";
    default: return "idle"; // Idle, Closed
  }
}

/** The run state alone (an agent's own status chip in a list). */
export function runSignal(run: string): Tone {
  return run === "running" || run === "initializing" ? "run" : run === "error" ? "err" : "idle";
}

/** The one copy of "which flags get a line of their own". The needs-you flag is shown by the status line instead. */
export function visibleFlags(flags: readonly Flag[]): Flag[] {
  return flags.filter((f) => f.severity !== "info" && f.code !== "needs-you");
}
export function flagSignal(f: Flag): "warn" | "err" {
  return f.severity === "error" ? "err" : "warn";
}
export const FLAG_GLYPH = { warn: "!", err: "✕" } as const;

// ---------- formatting ----------

/** One line of at most `max` characters: the first non-empty line, whitespace collapsed, an ellipsis when cut. */
export function oneLine(s: string, max = 80): string {
  const first = s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
  const flat = first.replace(/\s+/g, " ");
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.floor(s / 3600)}h`;
}

// ---------- metric deltas ----------

export type Delta = { text: string; dir: "up" | "down"; signal: "ok" | "err" };
/** Split "480ms ▲ +12%" or "+3.2%" into the plain value and a delta chip. A rise is good unless the metric itself is warn/error. */
export function parseDelta(value: string, tone?: string): { head: string; delta: Delta | null } {
  const m = /(?:[▲▼]\s*[+−-]?\s*\d[\d.,]*%?|[+−-]\d[\d.,]*%?)/.exec(value);
  if (!m) return { head: value, delta: null };
  const text = m[0].replace(/\s+/g, " ").trim();
  const down = text.startsWith("▼") || (!text.startsWith("▲") ? /^[−-]/.test(text) : /^▲\s*[−-]/.test(text));
  const dir: "up" | "down" = down ? "down" : "up";
  const bad = tone === "warn" || tone === "error";
  const good = dir === "up" ? !bad : bad;
  const head = (value.slice(0, m.index) + value.slice(m.index + m[0].length)).replace(/\s+/g, " ").trim();
  return { head, delta: { text: /^[▲▼]/.test(text) ? text : `${dir === "up" ? "▲" : "▼"} ${text.replace(/^[+−-]/, "")}`, dir, signal: good ? "ok" : "err" } };
}

// ---------- tables ----------

const NUM = /^[-+−]?\s*[$€£]?\s*\d[\d,]*(\.\d+)?\s*[a-zA-Z%/]*$/;
const LOWER = /cost|price|latency|time|ms|error/i;
const HIGHER = /score|pass|uptime|throughput/i;
const num = (s: string) => Number(s.replace(/[$€£,\s]/g, "").replace("−", "-").replace(/[a-zA-Z%/].*$/, ""));
export function isNumericColumn(rows: string[][], c: number): boolean {
  return rows.length > 0 && rows.every((r) => NUM.test((r[c] ?? "").trim()));
}
/** "r:c" keys of the best cell in each numeric column whose header says which way is better. Ties and unknown headers mark nothing. */
export function bestCells(cols: string[], rows: string[][]): Set<string> {
  const best = new Set<string>();
  cols.forEach((header, c) => {
    const lower = LOWER.test(header), higher = HIGHER.test(header);
    if ((!lower && !higher) || (lower && higher) || !isNumericColumn(rows, c) || rows.length < 2) return;
    const vals = rows.map((r) => num(r[c]));
    const target = lower ? Math.min(...vals) : Math.max(...vals);
    const hits = vals.flatMap((v, r) => (v === target ? [r] : []));
    if (hits.length === 1) best.add(`${hits[0]}:${c}`);
  });
  return best;
}

// ---------- activity: what the agent is doing right now (the Now row) ----------

export type ActivityKind = "shell" | "edit" | "write" | "read" | "search" | "fetch" | "other";
/** What the hub knows about a tool call. `startedAt` is stamped by the hub the first time it sees the call running. */
export type ActivityCall = { kind: ActivityKind; name: string; command?: string; path?: string; url?: string; query?: string; startedAt: number };
export type RecentCall = { kind: ActivityKind; /** past tense: "Edited atoms.tsx" */ label: string; ok: boolean; exitCode?: number | null; endedAt: number };
export type Classified = { icon: string; label: string; past: string; target: string | null; bookkeeping: boolean };
/** How long "Last: …" stays after the agent's last action. */
export const LAST_VISIBLE_MS = 10 * 60_000;
/** Lucide names the Now row can use. The browser carries an SVG for each (server/ui-html.ts). */
export const ACTIVITY_ICONS = ["LayoutDashboard", "FlaskConical", "GitBranch", "SquareTerminal", "FilePen", "Package", "Hourglass", "Pencil", "Eye", "Search", "Globe", "Wrench"] as const;

const base = (p: string) => p.replace(/\/+$/, "").split("/").pop() || p;
const dir = (p: string) => { const i = p.replace(/\/+$/, "").lastIndexOf("/"); return i > 0 ? p.slice(0, i) : null; };
const shortTarget = (s: string) => oneLine(s, 60);

/** First meaningful line of a shell command, with leading `VAR=x` assignments and `cd dir &&` dropped. */
function shellHead(command: string): { line: string; words: string[] } {
  let line = oneLine(command, 400);
  const cd = /^cd\s+\S+\s*&&\s*(.+)$/.exec(line);
  if (cd) line = cd[1];
  const words = line.split(" ").filter(Boolean);
  while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) words.shift();
  return { line: words.join(" "), words };
}

const BOOKKEEPING = /\/api\/canvas\/|canvas_(set|patch|get)\b/;

/**
 * The rules table, first match wins. The fallback is always the raw first line, so a wrong guess never hides the truth.
 * Each rule gives the present-tense label (running), the past tense (for "Last: …") and the muted target chip.
 */
export function classifyActivity(a: { kind: ActivityKind; name: string; command?: string; path?: string; url?: string; query?: string }): Classified {
  const mk = (icon: string, label: string, past: string, target: string | null = null, bookkeeping = false): Classified => ({ icon, label, past, target, bookkeeping });
  if ((a.command && BOOKKEEPING.test(a.command)) || BOOKKEEPING.test(a.name)) return mk("LayoutDashboard", "Updating canvas", "Updated canvas", "POST /api/canvas/…", true);
  switch (a.kind) {
    case "shell": {
      const command = a.command ?? "";
      const { line, words } = shellHead(command);
      const w0 = words[0] ?? "", w1 = words[1] ?? "";
      if (/^(npm|pnpm|yarn|bun)$/.test(w0) && (w1 === "test" || (w1 === "run" && /^test/.test(words[2] ?? ""))) || /^(pytest|vitest|jest)$/.test(w0) || (/^(go|cargo)$/.test(w0) && w1 === "test") || (w0 === "node" && w1 === "--test")) return mk("FlaskConical", "Running tests", "Ran tests", shortTarget(line));
      if (w0 === "git" || w0 === "gh") return mk("GitBranch", `Git: ${w1 || w0}`, `Git: ${w1 || w0}`, shortTarget(words.slice(2).join(" ")) || null);
      const interp = /^(python3?|node|bun|bash|sh)$/.test(w0) && /^-?$/.test(w1) && /<<-?\s*['"]?\w+/.test(line + " " + command.split("\n")[0]) ? w0 : null;
      if (interp) {
        const lines = command.split("\n");
        const body = Math.max(1, lines.length - (/^\s*\w+\s*$/.test(lines[lines.length - 1]) ? 2 : 1));
        const kind = interp.startsWith("python") ? "Python" : interp === "node" || interp === "bun" ? "Node" : "shell";
        return mk("SquareTerminal", `Running a ${kind} script`, `Ran a ${kind} script`, `${interp} · ${body} line${body === 1 ? "" : "s"}`);
      }
      const wf = /^(?:cat\s*>>?\s*(\S+)|tee\s+(?:-a\s+)?(\S+))/.exec(line);
      if (wf && /<<-?/.test(command.split("\n")[0])) { const f = (wf[1] ?? wf[2]).replace(/^['"]|['"]$/g, ""); return mk("FilePen", `Writing ${base(f)}`, `Wrote ${base(f)}`, dir(f)); }
      if ((/^(npm|pnpm|yarn|bun)$/.test(w0) && /^(install|i|add)$/.test(w1)) || (/^pip3?$/.test(w0) && w1 === "install")) return mk("Package", "Installing packages", "Installed packages", shortTarget(line));
      const sl = /^sleep\s+(\d+(?:\.\d+)?)$/.exec(line);
      if (sl && !command.trim().includes("\n")) return mk("Hourglass", `Waiting ${sl[1]}s`, `Waited ${sl[1]}s`);
      return mk("SquareTerminal", `Running ${w0 || "a command"}`, `Ran ${w0 || "a command"}`, shortTarget(line) || null);
    }
    case "edit": return mk("Pencil", `Editing ${base(a.path ?? "")}`, `Edited ${base(a.path ?? "")}`, dir(a.path ?? ""));
    case "write": return mk("Pencil", `Writing ${base(a.path ?? "")}`, `Wrote ${base(a.path ?? "")}`, dir(a.path ?? ""));
    case "read": return mk("Eye", `Reading ${base(a.path ?? "")}`, `Read ${base(a.path ?? "")}`, dir(a.path ?? ""));
    case "search": return mk("Search", "Searching", "Searched", a.query ? shortTarget(a.query) : null);
    case "fetch": {
      let host = a.url ?? "", rest: string | null = null;
      try { const u = new URL(a.url ?? ""); host = u.host; rest = `${u.pathname}${u.search}` === "/" ? null : shortTarget(`${u.pathname}${u.search}`); } catch { /* keep the raw url */ }
      return mk("Globe", `Fetching ${host}`, `Fetched ${host}`, rest);
    }
    default: {
      const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(a.name);
      const label = m ? `${m[1]}: ${m[2]}` : oneLine(a.name, 40);
      return mk("Wrench", label, label);
    }
  }
}

// ---------- background jobs: what an agent is waiting on ----------

/**
 * Claude Code's English result text is the only "a job started" signal Paseo 0.12 exposes (there is no structured flag), so the
 * two patterns live here, pinned by fixture tests. A wording change degrades to an unrecognised, finished-only job (see hub.ts), never to a crash.
 */
export const BG_SHELL_STARTED = /running in background with ID: (\w+)/;
export const BG_MONITOR_STARTED = /Monitor started \(task (\w+)(?:, expires in ([^)]*?)(?: unless[^)]*)?)?\)/;
/** "… completed (exit code 0)" in a task notification's summary: the only place an exit code appears. */
export const BG_EXIT_CODE = /\(exit code (-?\d+)\)/;
export const parseExitCode = (summary: string | undefined | null): number | null => { const m = BG_EXIT_CODE.exec(summary ?? ""); return m ? Number(m[1]) : null; };
/** A finished job stays on the canvas this long. */
export const BG_VISIBLE_MS = 10 * 60_000;
/** Rows shown before "+n more": the side panel and browser, a phone, the pill popover. */
export const BG_CAP = { wide: 3, phone: 2, popover: 3 } as const;

export type BgKind = "shell" | "monitor" | "subagent";
export type BgState = "running" | "done" | "failed" | "killed" | "lost";
/** The fields of a job the display rules read (the view's BgJob satisfies it). */
export type BgJobLike = { id: string; kind: BgKind; command: string; description?: string; state: BgState; exitCode?: number | null; startedAt: number; approx?: boolean; endedAt?: number; lastEvent?: string; events?: number; expires?: string };

const quoted = (s: string) => `\u201c${oneLine(s, 40)}\u201d`;
/** A short name for a job in a flag or a chip: the description, else the command's first word. */
export function jobName(j: Pick<BgJobLike, "kind" | "command" | "description">): string {
  if (j.description) return oneLine(j.description, 40);
  const { words } = shellHead(j.command);
  return words[0] ?? (j.kind === "monitor" ? "monitor" : "job");
}
/** The row for one job: the same icon and label rules as the Now row, with the past tense for a finished one. */
export function classifyJob(j: Pick<BgJobLike, "kind" | "command" | "description">): Classified {
  if (j.kind === "monitor") {
    const what = j.description ? quoted(j.description) : "a source";
    return { icon: "Eye", label: `Watching ${what}`, past: `Watched ${what}`, target: j.command ? shortTarget(j.command) : null, bookkeeping: false };
  }
  return classifyActivity({ kind: "shell", name: "Bash", command: j.command });
}

/** The jobs worth showing, in order: running (oldest first), then finished within 10 minutes (newest first). The agent's own canvas curls are bookkeeping and never listed. */
export function visibleJobs(view: { background?: readonly BgJobLike[]; runState: string }, now: number): BgJobLike[] {
  const dead = view.runState === "error" || view.runState === "closed";
  const jobs = (view.background ?? []).map((j): BgJobLike => (j.state === "running" && dead ? { ...j, state: "lost", endedAt: j.endedAt ?? now } : j));
  const shown = jobs.filter((j) => (j.state === "running" || now - (j.endedAt ?? j.startedAt) <= BG_VISIBLE_MS) && !classifyJob(j).bookkeeping);
  const run = shown.filter((j) => j.state === "running").sort((a, b) => a.startedAt - b.startedAt);
  const done = shown.filter((j) => j.state !== "running").sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  return [...run, ...done];
}
