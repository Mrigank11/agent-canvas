import { test } from "node:test";
import assert from "node:assert/strict";
import type { Flag } from "../shared/honesty.ts";
import { SIGNAL, STEP_GLYPH, TONES, bestCells, isDark, isNumericColumn, metricSignal, noteSignal, parseDelta, signalFor, stepSignal, tint, tokensFixed, tokensFromTheme, visibleFlags } from "../shared/ui-spec.ts";

test("the six signals carry the spec's colours in light and dark", () => {
  const light = tokensFixed("light"), dark = tokensFixed("dark");
  assert.deepEqual([light.sig("hot").dot, light.sig("hot").text, light.sig("hot").tint], ["#299f51", "#1d7a3e", "#299f511a"]);
  assert.deepEqual([dark.sig("hot").dot, dark.sig("hot").text, dark.sig("hot").tint], ["#35c264", "#5fd187", "#35c26426"]);
  assert.equal(light.sig("run").dot, "#268ae0");
  assert.equal(dark.sig("run").text, "#7cbaf8");
  assert.equal(light.sig("warn").tint, "#b378241f");
  assert.equal(dark.sig("err").tint, "#f7796d24");
  assert.equal(light.sig("err").tint, "#f12e2f17");
  assert.equal(light.askTint, "#299f5114");
  assert.equal(dark.askTint, "#35c2641f");
  assert.equal(dark.lineStrong, "#3f3f46");
});

test("idle borrows faint, muted and well from the base tokens; halo and pulse follow the signal spec", () => {
  const l = tokensFixed("light");
  assert.deepEqual([l.sig("idle").dot, l.sig("idle").text, l.sig("idle").tint, l.sig("idle").ring], [l.faint, l.muted, l.well, true]);
  assert.deepEqual(TONES.filter((t) => SIGNAL[t].halo), ["hot", "run", "warn", "err"]);
  assert.deepEqual(TONES.filter((t) => SIGNAL[t].pulse), ["run"]);
});

test("native tokens built from Paseo's zinc theme equal the fixed sets the browser uses", () => {
  const dark = tokensFromTheme({ surface0: "#18181b", surface1: "#1f1f22", surface2: "#27272a", border: "#27272a", foreground: "#fafafa", foregroundMuted: "#a1a1aa" });
  const light = tokensFromTheme({ surface0: "#ffffff", surface1: "#fafafa", surface2: "#f4f4f5", border: "#e4e4e7", foreground: "#1a1a1e", foregroundMuted: "#71717a" });
  for (const [a, b] of [[dark, tokensFixed("dark")], [light, tokensFixed("light")]] as const) {
    assert.equal(a.dark, b.dark);
    assert.deepEqual([a.bg, a.well, a.line, a.lineStrong, a.fg, a.muted, a.faint, a.askTint], [b.bg, b.well, b.line, b.lineStrong, b.fg, b.muted, b.faint, b.askTint]);
    for (const t of TONES) assert.deepEqual(a.sig(t), b.sig(t));
  }
});

test("status colours do not depend on the theme accent, so a grey-accent theme still gets a green lamp", () => {
  const t = tokensFromTheme({ surface0: "#18181b", surface1: "#1f1f22", surface2: "#27272a", border: "#27272a", foreground: "#fafafa", foregroundMuted: "#a1a1aa" });
  assert.equal(t.sig("hot").dot, "#35c264");
});

test("isDark and tint", () => {
  assert.ok(isDark("#18181b"));
  assert.ok(!isDark("#ffffff"));
  assert.ok(!isDark("rgb(0,0,0)")); // unparseable counts as light
  assert.equal(tint("#299f51", "1a", "#eee"), "#299f511a");
  assert.equal(tint("blue", "1a", "#eee"), "#eee");
});

test("verdict words map to the six signals, once", () => {
  assert.deepEqual((["Error", "Needs you", "Disputed", "Stale", "Working", "Done", "Idle", "Closed"] as const).map(signalFor), ["err", "hot", "warn", "warn", "run", "ok", "idle", "idle"]);
  assert.deepEqual((["done", "active", "pending", "failed", "skipped"] as const).map(stepSignal), ["ok", "run", "idle", "err", "idle"]);
  assert.equal(STEP_GLYPH.done, "✓");
  assert.deepEqual([noteSignal("warn"), noteSignal("error"), noteSignal("success"), noteSignal(undefined)], ["warn", "err", "ok", "run"]);
  assert.deepEqual([metricSignal("success"), metricSignal("info"), metricSignal(undefined)], ["ok", null, null]);
});

test("only warn and error flags get a line; needs-you belongs to the status line", () => {
  const f = (code: Flag["code"], severity: Flag["severity"]): Flag => ({ code, severity, text: code });
  assert.deepEqual(visibleFlags([f("needs-you", "info"), f("ask-pending", "info"), f("stale", "warn"), f("agent-error", "error")]).map((x) => x.code), ["stale", "agent-error"]);
});

test("deltas: a rise is good unless the metric is warn or error; a fall is the reverse", () => {
  assert.deepEqual(parseDelta("480ms ▲ +12%"), { head: "480ms", delta: { text: "▲ +12%", dir: "up", signal: "ok" } });
  assert.deepEqual(parseDelta("480ms ▲ +12%", "warn").delta, { text: "▲ +12%", dir: "up", signal: "err" });
  assert.deepEqual(parseDelta("98%  ▼ 3%"), { head: "98%", delta: { text: "▼ 3%", dir: "down", signal: "err" } });
  assert.equal(parseDelta("98% ▼ 3%", "error").delta?.signal, "ok");
  const plain = parseDelta("12 +3.2%");
  assert.deepEqual([plain.head, plain.delta?.dir, plain.delta?.text], ["12", "up", "▲ 3.2%"]);
  assert.equal(parseDelta("-4 ms").delta?.dir, "down");
  assert.deepEqual(parseDelta("42/42"), { head: "42/42", delta: null });
});

test("tables mark the best value only where the header says which way is better", () => {
  const best = bestCells(["Option", "Latency", "Cost"], [["Postgres", "4 ms", "$25/mo"], ["DynamoDB", "2 ms", "$40/mo"]]);
  assert.deepEqual([...best].sort(), ["0:2", "1:1"]); // Postgres is cheapest, DynamoDB is fastest
  assert.equal(bestCells(["Name", "Count"], [["a", "3"], ["b", "5"]]).size, 0); // unknown header
  assert.equal(bestCells(["Latency"], [["2 ms"], ["2 ms"]]).size, 0); // a tie marks nothing
  assert.equal(bestCells(["Latency"], [["fast"], ["slow"]]).size, 0); // not numeric
  assert.deepEqual([...bestCells(["Score"], [["80"], ["95"], ["70"]])], ["1:0"]);
  assert.ok(isNumericColumn([["$25/mo"], ["1,200 ms"]], 0));
  assert.ok(!isNumericColumn([["abc"]], 0));
});
