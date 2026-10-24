// What the composer pill says and how it is coloured. Pure, so the label rules are tested.
import type { Node } from "./canvas.ts";
import { checkHonesty, summarize, type Verdict } from "./honesty.ts";
import type { CanvasView } from "./contract.ts";

export type { Tone } from "./ui-spec.ts";
import type { Tone } from "./ui-spec.ts";
import { signalFor } from "./ui-spec.ts";
export type PillState = { label: string; tone: Tone };

export function pillState(view: Pick<CanvasView, "tree" | "runState" | "updatedAt" | "callsNow" | "callsAtUpdate">, now: number): PillState & { verdict: Verdict } {
  const verdict = checkHonesty(view.tree as Node, { runState: view.runState, canvasUpdatedAt: view.updatedAt, toolCallsSinceUpdate: Math.max(0, view.callsNow - view.callsAtUpdate), now });
  const s = summarize(view.tree as Node);
  const out = (label: string, tone: Tone) => ({ label, tone, verdict });
  const tone = signalFor(verdict.label);
  if (verdict.label === "Working" && s.steps > 0) return out(`${s.doneSteps}/${s.steps}`, tone);
  if (verdict.label === "Idle") return out(s.steps > 0 && s.openSteps > 0 ? `${s.doneSteps}/${s.steps}` : "Canvas", tone);
  return out(verdict.label, tone);
}
