import { describe, expect, test } from "bun:test";
import { mergedPrs, stepStatuses } from "../src/jobview";
import type { PlanStep, StepResult } from "../src/types";

const merge = (pr: number, includes: number[], admin = false): PlanStep => ({ kind: "merge", pr, method: "squash", admin, bypass: [], includes });
const ok = (step: PlanStep, extra: Partial<StepResult> = {}): StepResult => ({ step, ok: true, detail: "merged", ...extra });

describe("job view", () => {
  // the job planned two merges; the sheet's own earlier plan had four steps
  const plan = [merge(2391, [2391], true), merge(2388, [2389, 2390, 2388])];
  const results = [ok(plan[0]!), ok(plan[1]!)];

  test("steps are settled by identity, never by index", () => {
    expect(stepStatuses(plan, results, false)).toEqual(["done", "done"]);
    // results arriving in another order still settle the right steps
    expect(stepStatuses(plan, [results[1]!, results[0]!], false)).toEqual(["done", "done"]);
    expect(stepStatuses(plan, [results[0]!], true)).toEqual(["done", "running"]);
    expect(stepStatuses(plan, [], true)).toEqual(["running", "pending"]);
    expect(stepStatuses(plan, [{ ...results[0]!, ok: false }], false)).toEqual(["failed", "pending"]);
  });

  test("every PR a completed merge included is merged; queued and failed ones are not", () => {
    expect([...mergedPrs(results)].sort()).toEqual([2388, 2389, 2390, 2391]);
    expect([...mergedPrs([ok(plan[1]!, { enqueued: true })])]).toEqual([]);
    expect([...mergedPrs([{ ...results[1]!, ok: false }])]).toEqual([]);
    expect([...mergedPrs([], [5])]).toEqual([5]);
    // partial: only the first step landed, the others keep their blockers
    expect([...mergedPrs([results[0]!])]).toEqual([2391]);
  });
});
