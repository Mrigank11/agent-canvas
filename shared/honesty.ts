// The honesty cross-checks. Pure functions of (what the agent wrote) x (what Paseo says is true), so the
// native renderer, the HTML renderer and the tests all agree. The agent can write the canvas but never these.
import { walk, type Node } from "./canvas.ts";

export type RunState = "initializing" | "idle" | "running" | "error" | "closed";

export type Facts = {
  runState: RunState;
  /** ms epoch of the last canvas.set/patch, null when the agent never wrote one (auto canvas). */
  canvasUpdatedAt: number | null;
  /** Tool calls the agent made since that update. */
  toolCallsSinceUpdate: number;
  now: number;
};

export type Flag = { code: "agent-error" | "agent-closed" | "done-but-running" | "stale" | "idle-unfinished" | "needs-you" | "ask-pending"; severity: "info" | "warn" | "error"; text: string };

export type Verdict = {
  flags: Flag[];
  /** Render the canvas dimmed: the agent errored or is gone, so what it wrote can't be trusted. */
  dim: boolean;
  needsYou: boolean;
  /** One word for badges and lists. */
  label: "Error" | "Needs you" | "Disputed" | "Stale" | "Working" | "Done" | "Idle" | "Closed";
};

/** Thresholds, exported so tests and the demo can read them. */
export const THRESHOLDS = { doneButRunningSeconds: 10, doneButRunningCalls: 2, staleCalls: 8, staleSeconds: 180 };

const DONE_WORD = /(^|[^a-z])(?<!not )(done|completed?|finished|shipped)([^a-z]|$)/i;

export function summarize(root: Node) {
  let steps = 0, open = 0, active = 0, openAsks = 0, done = 0;
  let bluf = "";
  walk(root, (n) => {
    if (n.tag === "Step") {
      steps++;
      if (n.attrs.state === "done") done++;
      if (n.attrs.state === "pending" || n.attrs.state === "active") open++;
      if (n.attrs.state === "active") active++;
    }
    if (n.tag === "Ask" && !n.attrs.answer) openAsks++;
    if (n.tag === "Bluf" && !bluf) bluf = n.text;
  });
  const claimsDone =
    root.attrs.status === "done" ||
    (steps > 0 && open === 0 && root.attrs.status !== "blocked" && root.attrs.status !== "working") ||
    DONE_WORD.test(bluf);
  return { steps, doneSteps: done, openSteps: open, activeSteps: active, openAsks, claimsDone };
}

export function checkHonesty(root: Node, facts: Facts): Verdict {
  const s = summarize(root);
  const flags: Flag[] = [];
  const secs = facts.canvasUpdatedAt == null ? 0 : Math.max(0, (facts.now - facts.canvasUpdatedAt) / 1000);
  const calls = facts.toolCallsSinceUpdate;
  const running = facts.runState === "running";
  const idle = facts.runState === "idle";

  if (facts.runState === "error") flags.push({ code: "agent-error", severity: "error", text: "The agent errored. Treat this canvas as unreliable." });
  if (facts.runState === "closed") flags.push({ code: "agent-closed", severity: "info", text: "The agent is closed. This is its last canvas." });

  const authored = facts.canvasUpdatedAt != null;
  if (authored && s.claimsDone && running && (calls >= THRESHOLDS.doneButRunningCalls || secs >= THRESHOLDS.doneButRunningSeconds)) {
    flags.push({ code: "done-but-running", severity: "warn", text: `Canvas says done, but Paseo shows the agent still running (${calls} tool call${calls === 1 ? "" : "s"}, ${Math.round(secs)}s since the last update).` });
  } else if (authored && running && !s.claimsDone && (calls >= THRESHOLDS.staleCalls || secs >= THRESHOLDS.staleSeconds)) {
    flags.push({ code: "stale", severity: "warn", text: `May be stale: ${calls} tool calls and ${Math.round(secs / 60)} min since the last update.` });
  }
  if (authored && idle && !s.claimsDone && s.openSteps > 0 && s.openAsks === 0) {
    flags.push({ code: "idle-unfinished", severity: "warn", text: "The agent is idle but the canvas still shows unfinished steps." });
  }
  let needsYou = false;
  if (s.openAsks > 0) {
    if (idle) {
      needsYou = true;
      flags.push({ code: "needs-you", severity: "info", text: s.openAsks === 1 ? "The agent is idle and waiting for your answer." : `The agent is idle and waiting on ${s.openAsks} answers.` });
    } else if (running) {
      flags.push({ code: "ask-pending", severity: "info", text: "A question is open but the agent is still working. It becomes Needs you once the agent is idle." });
    }
  }
  const has = (c: Flag["code"]) => flags.some((f) => f.code === c);
  const dim = facts.runState === "error" || facts.runState === "closed";
  const label: Verdict["label"] = has("agent-error") ? "Error" : facts.runState === "closed" ? "Closed" : needsYou ? "Needs you" : has("done-but-running") ? "Disputed" : has("stale") ? "Stale" : running ? "Working" : s.claimsDone ? "Done" : "Idle";
  return { flags, dim, needsYou, label };
}
