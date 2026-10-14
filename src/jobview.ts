/** Sheet-independent mapping from a merge job's plan and results to what the stack sheet shows. */
import type { PlanStep, StepResult } from "./types";

export type StepStatus = "done" | "failed" | "running" | "pending";

/** A step's identity: what it does and to which PR/branch, never its position. */
export const stepKey = (s: PlanStep): string => `${s.kind}:${"pr" in s ? s.pr : s.branch}`;

/**
 * Status of each planned step from the job's results, matched by identity (each result settles one step). The first
 * unsettled step is `running` while the job runs; the rest stay `pending`.
 */
export function stepStatuses(plan: PlanStep[], results: StepResult[], running: boolean): StepStatus[] {
  const left = [...results];
  let runningGiven = false;
  return plan.map((s) => {
    const at = left.findIndex((r) => stepKey(r.step) === stepKey(s));
    if (at >= 0) return left.splice(at, 1)[0]!.ok ? "done" : "failed";
    if (running && !runningGiven) {
      runningGiven = true;
      return "running";
    }
    return "pending";
  });
}

/** PRs that have landed: those a completed (not merely queued) merge step included, plus the job's own `merged` list. */
export function mergedPrs(results: StepResult[], merged: number[] = []): Set<number> {
  const out = new Set(merged);
  for (const r of results) {
    if (r.ok && !r.enqueued && r.step.kind === "merge") for (const n of r.step.includes ?? [r.step.pr]) out.add(n);
  }
  return out;
}
