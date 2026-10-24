import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, firstOverride, parseOverride, resolveCanvas, type Override } from "../shared/config.ts";

test("override values: on/off in their usual spellings, anything else is none", () => {
  for (const v of ["on", "ON", " true ", "1", "yes"]) assert.equal(parseOverride(v), "on", v);
  for (const v of ["off", "Off", "false", "0", "no"]) assert.equal(parseOverride(v), "off", v);
  for (const v of ["", "maybe", "auto", undefined, null, 1, true]) assert.equal(parseOverride(v), null, String(v));
});

test("the latest explicit source wins; unusable ones are skipped", () => {
  assert.equal(firstOverride("on", "off"), "on");
  assert.equal(firstOverride(undefined, "off", "on"), "off");
  assert.equal(firstOverride("auto", undefined, "on"), "on");
  assert.equal(firstOverride(undefined, "nonsense"), null);
});

// every combination of override x defaultOn x autoCanvas
const table: [Override | null, boolean, boolean, { tools: boolean; show: boolean; auto: boolean }][] = [
  ["on", false, false, { tools: true, show: true, auto: true }],
  ["on", false, true, { tools: true, show: true, auto: true }],
  ["on", true, false, { tools: true, show: true, auto: true }],
  ["on", true, true, { tools: true, show: true, auto: true }],
  ["off", false, false, { tools: false, show: false, auto: false }],
  ["off", false, true, { tools: false, show: false, auto: false }],
  ["off", true, false, { tools: false, show: false, auto: false }],
  ["off", true, true, { tools: false, show: false, auto: false }],
  [null, false, false, { tools: false, show: false, auto: false }], // everything off: no canvas of any kind
  [null, false, true, { tools: false, show: true, auto: true }], // default: auto canvas only
  [null, true, false, { tools: true, show: true, auto: true }], // tools for all (auto until they write)
  [null, true, true, { tools: true, show: true, auto: true }],
];
for (const [o, defaultOn, autoCanvas, want] of table) {
  test(`override ${o ?? "none"}, defaultOn ${defaultOn}, autoCanvas ${autoCanvas}`, () => {
    assert.deepEqual(resolveCanvas(o, { defaultOn, autoCanvas }), want);
  });
}

test("a per-agent override beats the global switch in both directions", () => {
  assert.equal(resolveCanvas("on", { defaultOn: false, autoCanvas: false }).tools, true);
  assert.equal(resolveCanvas("off", { defaultOn: true, autoCanvas: true }).show, false);
});

test("the shipped defaults: opt-in tools, auto canvas for everyone", () => {
  assert.deepEqual(DEFAULT_POLICY, { defaultOn: false, autoCanvas: true });
  assert.deepEqual(resolveCanvas(null, DEFAULT_POLICY), { tools: false, show: true, auto: true });
});
