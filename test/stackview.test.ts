import { describe, expect, test } from "bun:test";
import { planItems, prStatus, stackSummary, withExpectedRebases } from "../src/stackview";
import type { Blocker, PlanStep } from "../src/types";

const review: Blocker = { kind: "review", decision: "REVIEW_REQUIRED" };
const merge = (pr: number, bypass: Blocker[] = [], includes?: number[]): PlanStep => ({ kind: "merge", pr, method: "squash", admin: bypass.length > 0, bypass, ...(includes ? { includes } : {}) });

describe("prStatus", () => {
  test("approved, ready, and needs-review are different, honest states", () => {
    expect(prStatus({ reviewDecision: "APPROVED" }, [], false)).toMatchObject({ kind: "approved", label: "approved", bypass: false });
    expect(prStatus({ reviewDecision: null }, [], false)).toMatchObject({ kind: "ready", label: "ready" });
    expect(prStatus({ reviewDecision: "REVIEW_REQUIRED" }, [review], false)).toMatchObject({ kind: "needs-review", label: "needs review", bypass: false, hard: false });
  });

  test("force marks soft blockers as bypassed, never conflicts or drafts", () => {
    expect(prStatus({ reviewDecision: "REVIEW_REQUIRED" }, [review], true)).toMatchObject({ kind: "needs-review", bypass: true });
    expect(prStatus({ reviewDecision: null }, [{ kind: "conflict", base: "main" }], true)).toMatchObject({ kind: "conflict", bypass: false, hard: true });
    expect(prStatus({ reviewDecision: null }, [{ kind: "draft" }], true)).toMatchObject({ kind: "draft", bypass: false, hard: true });
  });

  test("the worst blocker names the row; failing checks beat missing review; extra blockers are counted", () => {
    const s = prStatus({ reviewDecision: "REVIEW_REQUIRED" }, [review, { kind: "checks", failing: ["ci"], pending: [] }], false);
    expect(s).toMatchObject({ kind: "failing", label: "failing checks +1" });
    expect(prStatus({ reviewDecision: null }, [{ kind: "checks", failing: [], pending: ["ci"] }], false)).toMatchObject({ kind: "pending", label: "checks running" });
  });

  test("a base that is not the trunk is not a status in a stack", () => {
    expect(prStatus({ reviewDecision: "APPROVED" }, [{ kind: "base-not-trunk", base: "b1" }], false).kind).toBe("approved");
  });
});

describe("stackSummary", () => {
  const base = { trunk: "main", method: "squash" as const, stop: null, above: [] };

  test("two PRs that each need a review bypass: bottom first, then top", () => {
    expect(stackSummary({ ...base, plan: [merge(2462, [review]), merge(2463, [review])] })).toBe("Merges #2462 into main, then #2463, squashing each; bypasses review on both.");
  });

  test("a clean run lands together; a bypass on one PR names only that PR", () => {
    expect(stackSummary({ ...base, plan: [merge(2, [], [1, 2]), merge(3, [review])] })).toBe("Merges #1 and #2 together into main, then #3, squashing each; bypasses review on #3.");
  });

  test("different bypasses are listed per PR", () => {
    const checks: Blocker = { kind: "checks", failing: ["ci"], pending: [] };
    expect(stackSummary({ ...base, plan: [merge(1, [review]), merge(2, [checks])] })).toBe("Merges #1 into main, then #2, squashing each; bypasses review on #1, failing checks on #2.");
  });

  test("a single PR, and the PRs that stay open", () => {
    expect(stackSummary({ ...base, plan: [merge(1)], above: [2, 3] })).toBe("Merges #1 into main, squashing it. #2 and #3 stay open.");
    expect(stackSummary({ ...base, plan: [merge(1)], stop: { pr: 2, reason: "#2 is blocked: needs review" }, above: [] })).toBe("Merges #1 into main, squashing it. #2 stays open (needs review).");
  });

  test("nothing to merge says why", () => {
    expect(stackSummary({ ...base, plan: [], stop: { pr: 1, reason: "#1 has merge conflicts" }, above: [] })).toBe("Nothing can merge yet: #1 has merge conflicts.");
  });
});

describe("plan lines", () => {
  test("the rebase sits after the first merge, with the reason, and only when a later merge needs it", () => {
    const plan = [merge(2462, [review]), merge(2463, [review])];
    const shown = withExpectedRebases(plan, true);
    expect(shown.map((s) => `${s.kind}:${"pr" in s ? s.pr : ""}`)).toEqual(["merge:2462", "rebase-stack:2463", "merge:2463"]);
    expect(planItems(shown, "main", "squash")).toEqual([
      { steps: [0], text: "Merge #2462 into main (squash)", why: "bypasses review" },
      { steps: [1], text: "Rebase #2463 onto main and everything above it", why: "after #2462 lands; GitHub leaves it on the merged branch; runs in a temporary checkout" },
      { steps: [2], text: "Merge #2463 into main (squash)", why: "bypasses review" },
    ]);
  });

  test("one merge request needs no rebase, and a classic stack is left as planned", () => {
    expect(withExpectedRebases([merge(2, [], [1, 2])], true)).toEqual([merge(2, [], [1, 2])]);
    const plan: PlanStep[] = [merge(1), merge(2)];
    expect(withExpectedRebases(plan, false)).toBe(plan);
  });

  test("a rebase that is already in the plan is not doubled", () => {
    const plan: PlanStep[] = [merge(1, [review]), { kind: "rebase-stack", pr: 2 }, merge(2, [review])];
    expect(withExpectedRebases(plan, true)).toEqual(plan);
  });

  test("a classic plan explains each retarget, rebase and wait", () => {
    const plan: PlanStep[] = [
      merge(1),
      { kind: "retarget", pr: 2, from: "b1", to: "main" },
      { kind: "restack", pr: 2, branch: "b2", onto: "origin/main", upstream: "s1", expectedRemoteSha: "s2", worktree: null },
      { kind: "push", branch: "b2", expectedRemoteSha: "s2", cwd: "/r" },
      { kind: "wait-checks", pr: 2 },
      merge(2),
    ];
    expect(planItems(plan, "main", "squash").map((i) => i.text)).toEqual([
      "Merge #1 into main (squash)",
      "Retarget #2 from b1 to main",
      "Rebase #2 onto main, push with lease",
      "Wait for #2 checks to pass",
      "Merge #2 into main (squash)",
    ]);
  });
});
