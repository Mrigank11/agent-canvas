// The auto canvas: what an agent that never wrote one still shows, derived from its timeline.
import { type Node } from "./canvas.ts";

export type AutoItem =
  | { kind: "todo"; items: { text: string; status: "pending" | "in_progress" | "completed" }[] }
  | { kind: "tool"; label: string; status: "running" | "completed" | "failed" | "canceled"; file?: string }
  | { kind: "assistant"; text: string }
  | { kind: "user"; text: string }
  | { kind: "error"; text: string };

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const node = (tag: string, id: string, attrs: Node["attrs"] = {}, text = "", children: Node[] = []): Node => ({ tag, id, attrs, text, children });

export function autoCanvas(title: string | null, items: AutoItem[], running: boolean): Node {
  const kids: Node[] = [];
  const lastAssistant = [...items].reverse().find((i) => i.kind === "assistant");
  const firstUser = items.find((i) => i.kind === "user");
  const bluf = lastAssistant?.kind === "assistant" ? lastAssistant.text : firstUser?.kind === "user" ? `Task: ${firstUser.text}` : "No activity yet.";
  kids.push(node("Bluf", "auto-bluf", {}, clip(bluf.replace(/\s+/g, " ").trim(), 280)));

  const todo = [...items].reverse().find((i) => i.kind === "todo");
  const tools = items.filter((i) => i.kind === "tool");
  if (todo?.kind === "todo" && todo.items.length) {
    kids.push(node("Steps", "auto-steps", { title: "Plan" }, "", todo.items.slice(0, 12).map((t, i) => node("Step", `auto-step${i}`, { state: t.status === "completed" ? "done" : t.status === "in_progress" ? "active" : "pending" }, clip(t.text, 140)))));
  } else if (tools.length) {
    const recent = tools.slice(-6);
    kids.push(node("Steps", "auto-steps", { title: "Recent activity" }, "", recent.map((t, i) => node("Step", `auto-step${i}`, { state: t.status === "running" ? "active" : t.status === "completed" ? "done" : t.status === "failed" ? "failed" : "skipped" }, clip(t.label, 140)))));
  }
  const files = new Set(tools.map((t) => t.file).filter((f): f is string => !!f));
  kids.push(node("Metric", "auto-calls", { label: "Tool calls", value: String(tools.length) }));
  if (files.size) kids.push(node("Metric", "auto-files", { label: "Files touched", value: String(files.size) }));
  const err = [...items].reverse().find((i) => i.kind === "error");
  if (err?.kind === "error") kids.push(node("Note", "auto-error", { tone: "error" }, clip(err.text, 200)));
  return node("Canvas", "auto", { title: title ?? "Agent", status: running ? "working" : "waiting" }, "", kids);
}
