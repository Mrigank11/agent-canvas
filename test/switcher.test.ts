// The one-line canvas switcher: its grouping plan, and the native component it drives (StatusDot included).
import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createElement as h, type ReactElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import ts from "typescript";
import { switcherPlan } from "../shared/plan.ts";
import { viewOf } from "./plan.test.ts";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const NOW = 1_000_000_000;
const view = (agentId: string, title: string, runState: "running" | "idle", o: Record<string, unknown> = {}) =>
  viewOf(undefined, { agentId, title, runState, lastActivityAt: NOW - 1000, ...o } as never);

test("the plan names the shown canvas, counts all, and groups running before done", () => {
  const views = [view("a", "Alpha", "idle"), view("b", "Beta", "running"), view("c", "Gamma", "idle", { lastActivityAt: NOW }), view("d", "Delta", "running", { lastActivityAt: NOW })];
  const p = switcherPlan(views, "c", NOW);
  assert.equal(p.current?.title, "Gamma");
  assert.equal(p.count, 4);
  assert.deepEqual(p.groups.map((g) => g.key), ["running", "done"]);
  assert.deepEqual(p.groups[0].items.map((i) => i.title), ["Delta", "Beta"]);
  assert.deepEqual(p.groups[1].items.map((i) => i.title), ["Gamma", "Alpha"]);
});

test("an empty group is left out and an unknown shown id has no current", () => {
  const p = switcherPlan([view("a", "A", "idle"), view("b", "B", "idle")], "zzz", NOW);
  assert.equal(p.current, null);
  assert.deepEqual(p.groups.map((g) => g.key), ["done"]);
});

// ---- the native component: transpile the .tsx (node cannot run JSX) and mock the host-only react-native modules ----
const out = new URL("../.tmp/switcher", import.meta.url).pathname; // inside the package so react resolves; .tmp/ is gitignored
mkdirSync(out, { recursive: true });
const src = (f: string) => new URL(`../client/ui/${f}`, import.meta.url).pathname;
const emit = (f: string) => {
  let js = ts.transpileModule(readFileSync(src(f), "utf8"), { compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  js = js.replace(/from "\.\.\/\.\.\/shared\/([\w-]+)"/g, (_, n) => `from "${pathToFileURL(new URL(`../shared/${n}.ts`, import.meta.url).pathname).href}"`).replace(/from "\.\/tokens"/, 'from "./tokens.mjs"');
  writeFileSync(join(out, f.replace(/\.tsx$/, ".mjs")), js);
};
const prim = (tag: string) => (p: Record<string, unknown>) => h(tag as never, p);
const animated = { View: prim("animated"), Value: class { v: number; constructor(v: number) { this.v = v; } setValue(v: number) { this.v = v; } interpolate() { return "0deg"; } }, loop: () => ({ start() {}, stop() {} }), sequence: () => ({}), timing: () => ({}) };
mock.module("react-native", { exports: { AccessibilityInfo: { isReduceMotionEnabled: () => Promise.resolve(false) }, Animated: animated, Pressable: prim("pressable"), ScrollView: prim("scroll"), Text: prim("text"), View: prim("view") } });
mock.module("@getpaseo/plugin/client/react-native", { exports: { Icon: prim("icon") } });
mock.module("@getpaseo/plugin/client", { exports: {} });
emit("tokens.tsx");
emit("atoms.tsx");
const atoms = await import(pathToFileURL(join(out, "atoms.mjs")).href);
const tokens = await import(pathToFileURL(join(out, "tokens.mjs")).href);
const theme = { colors: { surface0: "#ffffff", surface1: "#f6f6f6", surface2: "#eeeeee", border: "#dddddd", foreground: "#111111", foregroundMuted: "#666666" } };
const root = (el: ReactElement): ReactElement => h(tokens.UiRoot, { theme }, el);

test("a StatusDot switched idle → run → ok renders each time without throwing a hooks error", async () => {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(root(h(atoms.StatusDot, { tone: "idle" }))); });
  for (const tone of ["run", "ok", "idle", "run"]) {
    await act(async () => { r.update(root(h(atoms.StatusDot, { tone }))); });
    assert.ok(r.toJSON(), `rendered as ${tone}`);
  }
  await act(async () => r.unmount());
});

test("the switcher shows one line, opens to the grouped list, and a pick closes it and reports the id", async () => {
  const plan = switcherPlan([view("a", "Alpha", "idle"), view("b", "Beta", "running")], "a", NOW);
  const picked: string[] = [];
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => { r = TestRenderer.create(root(h(atoms.Switcher, { plan, onChange: (id: string) => picked.push(id) }))); });
  const text = () => JSON.stringify(r.toJSON());
  assert.match(text(), /Alpha/);
  assert.doesNotMatch(text(), /Beta/, "closed: only the current canvas shows");
  await act(async () => { r.root.findAllByType("pressable" as never)[0].props.onPress(); });
  assert.match(text(), /Running · 1/);
  assert.match(text(), /Done · 1/);
  assert.match(text(), /Beta/);
  const beta = r.root.findAllByType("pressable" as never).find((p) => p.findAllByType("text" as never).some((x) => x.props.children === "Beta"))!;
  await act(async () => { beta.props.onPress(); });
  assert.deepEqual(picked, ["b"]);
  assert.doesNotMatch(text(), /Running · 1/, "closed after a pick");
  await act(async () => r.unmount());
});
