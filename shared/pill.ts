// What the composer pill says and how it is coloured. Pure, so the label rules are tested.
import type { Node } from "./canvas.ts";
import { checkHonesty, summarize, type Verdict } from "./honesty.ts";
import type { CanvasView } from "./contract.ts";

export type Tone = "hot" | "warn" | "err" | "run" | "ok" | "idle";
export type PillState = { label: string; tone: Tone };

export function pillState(view: Pick<CanvasView, "tree" | "runState" | "updatedAt" | "callsNow" | "callsAtUpdate">, now: number): PillState & { verdict: Verdict } {
  const verdict = checkHonesty(view.tree as Node, { runState: view.runState, canvasUpdatedAt: view.updatedAt, toolCallsSinceUpdate: Math.max(0, view.callsNow - view.callsAtUpdate), now });
  const s = summarize(view.tree as Node);
  const out = (label: string, tone: Tone) => ({ label, tone, verdict });
  switch (verdict.label) {
    case "Error": return out("Error", "err");
    case "Closed": return out("Closed", "idle");
    case "Needs you": return out("Needs you", "hot");
    case "Disputed": return out("Disputed", "warn");
    case "Stale": return out("Stale", "warn");
    case "Working": return s.steps > 0 ? out(`${s.doneSteps}/${s.steps}`, "run") : out("Working", "run");
    case "Done": return out("Done", "ok");
    default: return out(s.steps > 0 && s.openSteps > 0 ? `${s.doneSteps}/${s.steps}` : "Canvas", "idle");
  }
}
