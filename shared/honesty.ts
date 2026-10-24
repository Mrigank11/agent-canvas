// The honesty cross-checks. Pure functions of (what the agent wrote) x (what Paseo says is true), so the
// native renderer, the HTML renderer and the tests all agree. The agent can write the canvas but never these.
import { walk, type Node } from "./canvas.ts";
import { BG_VISIBLE_MS, jobName, type BgJobLike } from "./ui-spec.ts";

export type RunState = "initializing" | "idle" | "running" | "error" | "closed";

export type Facts = {
  runState: RunState;
  /** ms epoch of the last canvas.set/patch, null when the agent never wrote one (auto canvas). */
  canvasUpdatedAt: number | null;
  /** Tool calls the agent made since that update. */
  toolCallsSinceUpdate: number;
  now: number;
  /** The agent's background jobs (already normalised by `bgFacts`). Absent for a provider that has none. */
  background?: BgFacts;
};

/** What the verdict needs to know about background jobs. */
export type BgFacts = {
  running: number;
  /** Jobs that failed or were killed within the visible window, newest first. */
  failed: { name: string; exitCode: number | null; state: "failed" | "killed"; endedAt: number }[];
};

/** Reduce the jobs to the facts the verdict reads. A job still "running" under a dead agent is lost: no notification will come. */
export function bgFacts(jobs: readonly BgJobLike[], runState: RunState, now: number): BgFacts {
  const dead = runState === "error" || runState === "closed";
  const failed = jobs
    .filter((j) => (j.state === "failed" || j.state === "killed") && j.endedAt != null && now - j.endedAt <= BG_VISIBLE_MS)
    .sort((a, b) => b.endedAt! - a.endedAt!)
    .map((j) => ({ name: jobName(j), exitCode: j.exitCode ?? null, state: j.state as "failed" | "killed", endedAt: j.endedAt! }));
  return { running: dead ? 0 : jobs.filter((j) => j.state === "running").length, failed };
}

export type Flag = { code: "agent-error" | "agent-closed" | "done-but-running" | "job-running" | "job-failed" | "stale" | "idle-unfinished" | "needs-you" | "ask-pending"; severity: "info" | "warn" | "error"; text: string };

export type Verdict = {
  flags: Flag[];
  /** Render the canvas dimmed: the agent errored or is gone, so what it wrote can't be trusted. */
  dim: boolean;
  needsYou: boolean;
  /** Background jobs an idle agent is waiting on (the label is Waiting when this is above zero and nothing outranks it). */
  waitingOn: number;
  /** One word for badges and lists. */
  label: "Error" | "Needs you" | "Disputed" | "Waiting" | "Stale" | "Working" | "Done" | "Idle" | "Closed";
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
  if (authored && idle && !s.claimsDone && s.openSteps > 0 && s.openAsks === 0 && !(facts.background?.running)) { // an agent waiting on a job is expected to have steps left
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
  // background jobs: the agent's own canvas is checked against what the jobs actually did
  const bg = facts.background;
  const jobsRunning = bg?.running ?? 0;
  if (bg && authored && s.claimsDone && jobsRunning > 0) {
    flags.push({ code: "job-running", severity: "warn", text: `Canvas says done, but ${jobsRunning} background job${jobsRunning === 1 ? " is" : "s are"} still running.` });
  }
  // a failure the canvas has not been updated since (the agent has not acknowledged it) while the canvas does not say blocked
  const unacknowledged = bg && authored && root.attrs.status !== "blocked" ? bg.failed.filter((f) => facts.canvasUpdatedAt! < f.endedAt) : [];
  for (const f of unacknowledged.slice(0, 2)) {
    const what = f.state === "killed" ? "was killed" : f.exitCode != null ? `failed, exit ${f.exitCode}` : "failed";
    flags.push({ code: "job-failed", severity: "warn", text: `A background job (${f.name}) ${what}, but the canvas still says ${s.claimsDone ? "done" : "working"}.` });
  }
  const waitingOn = idle && !running ? jobsRunning : 0;
  const has = (c: Flag["code"]) => flags.some((f) => f.code === c);
  const dim = facts.runState === "error" || facts.runState === "closed";
  const label: Verdict["label"] = has("agent-error") ? "Error" : facts.runState === "closed" ? "Closed" : needsYou ? "Needs you" : has("done-but-running") || has("job-running") || has("job-failed") ? "Disputed" : waitingOn > 0 ? "Waiting" : has("stale") ? "Stale" : running ? "Working" : s.claimsDone ? "Done" : "Idle";
  return { flags, dim, needsYou, waitingOn, label };
}
