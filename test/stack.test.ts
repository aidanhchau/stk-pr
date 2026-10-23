import { describe, expect, test } from "bun:test";
import {
  blockers,
  buildStacks,
  executePlan,
  findForks,
  planNativeStackMerge,
  planStackMerge,
  stackFor,
  chainThrough,
  type GitOps,
} from "../src/stack";
import { StkError, type Exec, type PlanStep, type PullRequest, type RepoRules, type Worktree } from "../src/types";

function pr(n: number, head: string, base: string, over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: n,
    title: `PR ${n}`,
    body: "",
    url: `https://github.com/o/r/pull/${n}`,
    author: "octo-dev",
    state: "OPEN",
    isDraft: false,
    headRef: head,
    baseRef: base,
    headSha: `${head}-sha`,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    checks: [{ name: "ci", state: "pass", url: null }],
    unresolvedThreads: 0,
    worktree: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
    ...over,
  };
}

const TRUNK = "dev";
const wt = (branch: string, path: string): Worktree => ({ path, branch, head: "x", bare: false });
const queueRules: RepoRules = { requiredChecks: [], codeOwnerReview: false, mergeQueue: { method: "squash" } };

describe("buildStacks", () => {
  test("builds a linear chain bottom first", () => {
    const prs = [pr(3, "c", "b"), pr(1, "a", TRUNK), pr(2, "b", "a")];
    const stacks = buildStacks(prs, TRUNK);
    expect(stacks).toHaveLength(1);
    expect(stacks[0]!.prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(stacks[0]!.trunk).toBe(TRUNK);
    expect(findForks(prs, TRUNK)).toEqual([]);
  });

  test("standalone PRs are single-PR stacks; closed PRs ignored", () => {
    const prs = [pr(1, "a", TRUNK), pr(2, "b", TRUNK), pr(3, "c", "b", { state: "MERGED" })];
    const stacks = buildStacks(prs, TRUNK);
    expect(stacks.map((s) => s.prs.map((p) => p.number)).sort()).toEqual([[1], [2]]);
  });

  test("forks: reports each path plus a fork entry", () => {
    const prs = [pr(1, "a", TRUNK), pr(2, "b", "a"), pr(3, "c", "a")];
    const stacks = buildStacks(prs, TRUNK);
    expect(stacks.map((s) => s.prs.map((p) => p.number))).toEqual([
      [1, 2],
      [1, 3],
    ]);
    expect(findForks(prs, TRUNK)).toEqual([{ parent: 1, children: [2, 3] }]);
  });

  test("stackFor returns the chain from any member", () => {
    const prs = [pr(1, "a", TRUNK), pr(2, "b", "a"), pr(3, "c", "b")];
    expect(stackFor(prs, TRUNK, 2).prs.map((p) => p.number)).toEqual([1, 2, 3]);
  });

  test("stackFor throws not-linear when the chain forks", () => {
    const prs = [pr(1, "a", TRUNK), pr(2, "b", "a"), pr(3, "c", "a")];
    for (const n of [1, 2, 3]) {
      try {
        stackFor(prs, TRUNK, n);
        throw new Error("expected throw");
      } catch (e) {
        expect(e).toBeInstanceOf(StkError);
        expect((e as StkError).code).toBe("not-linear");
      }
    }
  });

  test("chainThrough shows a forked tree as the line through the PR and names where it splits", () => {
    // 1 -> 2, then 2 forks into 3 -> 4 and 5
    const prs = [pr(1, "a", TRUNK), pr(2, "b", "a"), pr(3, "c", "b"), pr(4, "d", "c"), pr(5, "e", "b")];
    const at = (n: number) => {
      const c = chainThrough(prs, TRUNK, n);
      return { prs: c.prs.map((p) => p.number), forks: c.forks };
    };
    const fork = [{ parent: 2, children: [3, 5] }];
    // at or below the fork: ancestors and the PR, stopping at the split
    expect(at(1)).toEqual({ prs: [1, 2], forks: fork });
    expect(at(2)).toEqual({ prs: [1, 2], forks: fork });
    // on a branch: the whole line from the trunk through that branch
    expect(at(3)).toEqual({ prs: [1, 2, 3, 4], forks: fork });
    expect(at(5)).toEqual({ prs: [1, 2, 5], forks: fork });
    expect(chainThrough([pr(1, "a", TRUNK), pr(2, "b", "a")], TRUNK, 2).forks).toEqual([]);
  });

  test("stackFor on unknown/closed PR is a usage error", () => {
    expect(() => stackFor([pr(1, "a", TRUNK, { state: "CLOSED" })], TRUNK, 1)).toThrow(StkError);
    expect(() => stackFor([], TRUNK, 9)).toThrow(StkError);
  });
});

describe("blockers", () => {
  test("clean PR has none", () => {
    expect(blockers(pr(1, "a", TRUNK), TRUNK)).toEqual([]);
  });

  test("collects every blocker kind", () => {
    const p = pr(1, "a", "other", {
      isDraft: true,
      mergeable: "CONFLICTING",
      reviewDecision: "CHANGES_REQUESTED",
      unresolvedThreads: 2,
      checks: [
        { name: "lint", state: "fail", url: null },
        { name: "test", state: "pending", url: null },
        { name: "ok", state: "pass", url: null },
      ],
    });
    expect(blockers(p, TRUNK)).toEqual([
      { kind: "checks", failing: ["lint"], pending: ["test"] },
      { kind: "review", decision: "CHANGES_REQUESTED" },
      { kind: "threads", count: 2 },
      { kind: "draft" },
      { kind: "conflict", base: "other" },
      { kind: "base-not-trunk", base: "other" },
    ]);
  });

  test("CONFLICTING and DIRTY are conflict blockers naming the base", () => {
    expect(blockers(pr(1, "a", TRUNK, { mergeable: "CONFLICTING" }), TRUNK)).toEqual([{ kind: "conflict", base: TRUNK }]);
    expect(blockers(pr(1, "a", TRUNK, { mergeState: "DIRTY" }), TRUNK)).toEqual([{ kind: "conflict", base: TRUNK }]);
  });

  test("BEHIND is a behind blocker with the count (null when unknown); an unrequired lag is no blocker", () => {
    expect(blockers(pr(1, "a", TRUNK, { mergeState: "BEHIND", behindBy: 3 }), TRUNK)).toEqual([{ kind: "behind", count: 3, base: TRUNK }]);
    expect(blockers(pr(1, "a", TRUNK, { mergeState: "BEHIND" }), TRUNK)).toEqual([{ kind: "behind", count: null, base: TRUNK }]);
    expect(blockers(pr(1, "a", TRUNK, { mergeState: "CLEAN", behindBy: 3 }), TRUNK)).toEqual([]);
  });

  test("UNKNOWN mergeStateStatus or mergeable is a checking blocker, also when GitHub already says BLOCKED", () => {
    expect(blockers(pr(1, "a", TRUNK, { mergeState: "UNKNOWN" }), TRUNK)).toEqual([{ kind: "checking" }]);
    expect(blockers(pr(1, "a", TRUNK, { mergeable: "UNKNOWN", mergeState: "BLOCKED" }), TRUNK)).toEqual([{ kind: "checking" }]);
  });

  test("missing required approval is a review blocker; no review policy (null decision) is not", () => {
    expect(blockers(pr(1, "a", TRUNK, { reviewDecision: "REVIEW_REQUIRED" }), TRUNK)).toEqual([{ kind: "review", decision: "REVIEW_REQUIRED" }]);
    expect(blockers(pr(1, "a", TRUNK, { reviewDecision: null }), TRUNK)).toEqual([]);
    expect(blockers(pr(1, "a", TRUNK, { reviewDecision: null, mergeState: "BLOCKED" }), TRUNK)).toEqual([{ kind: "blocked" }]);
  });
});

describe("planStackMerge", () => {
  const stack3 = () => ({ trunk: TRUNK, prs: [pr(1, "a", TRUNK), pr(2, "b", "a"), pr(3, "c", "b")] });
  const wts = [wt(TRUNK, "/r"), wt("b", "/r-b")];

  test("3-PR squash stack: retarget, restack, push, wait, merge per child", () => {
    const plan = planStackMerge(stack3(), { method: "squash", force: false }, wts);
    expect(plan).toEqual([
      { kind: "merge", pr: 1, method: "squash", admin: false, bypass: [], sha: "a-sha" },
      { kind: "retarget", pr: 2, from: "a", to: TRUNK },
      {
        kind: "restack",
        pr: 2,
        branch: "b",
        onto: "origin/dev",
        upstream: "a-sha",
        expectedRemoteSha: "b-sha",
        worktree: "/r-b",
      },
      { kind: "push", branch: "b", expectedRemoteSha: "b-sha", cwd: "/r-b" },
      { kind: "wait-checks", pr: 2 },
      { kind: "merge", pr: 2, method: "squash", admin: false, bypass: [] },
      { kind: "retarget", pr: 3, from: "b", to: TRUNK },
      {
        kind: "restack",
        pr: 3,
        branch: "c",
        onto: "origin/dev",
        upstream: "b-sha",
        expectedRemoteSha: "c-sha",
        worktree: null,
      },
      { kind: "push", branch: "c", expectedRemoteSha: "c-sha", cwd: "/r" },
      { kind: "wait-checks", pr: 3 },
      { kind: "merge", pr: 3, method: "squash", admin: false, bypass: [] },
    ]);
  });

  test("upTo stops after that PR", () => {
    const plan = planStackMerge(stack3(), { method: "squash", force: false, upTo: 2 }, wts);
    expect(plan.flatMap((s) => (s.kind === "merge" ? [s.pr] : []))).toEqual([1, 2]);
    expect(plan[plan.length - 1]).toMatchObject({ kind: "merge", pr: 2 });
  });

  test("blocked bottom PR without force yields an empty plan", () => {
    const stack = stack3();
    stack.prs[0] = pr(1, "a", TRUNK, { reviewDecision: "REVIEW_REQUIRED" });
    expect(planStackMerge(stack, { method: "squash", force: false }, wts)).toEqual([]);
  });

  test("blocked middle PR without force ends the plan after the parent merge", () => {
    const stack = stack3();
    stack.prs[1] = pr(2, "b", "a", { unresolvedThreads: 1 });
    const plan = planStackMerge(stack, { method: "squash", force: false }, wts);
    expect(plan).toEqual([{ kind: "merge", pr: 1, method: "squash", admin: false, bypass: [], sha: "a-sha" }]);
  });

  test("child check blockers are deferred to wait-checks", () => {
    const stack = stack3();
    stack.prs[1] = pr(2, "b", "a", { checks: [{ name: "ci", state: "fail", url: null }] });
    const plan = planStackMerge(stack, { method: "squash", force: false }, wts);
    expect(plan.some((s) => s.kind === "wait-checks" && s.pr === 2)).toBe(true);
    expect(plan.find((s) => s.kind === "merge" && s.pr === 2)).toMatchObject({ admin: false, bypass: [] });
  });

  test("force: child whose only blocker is failing checks gets admin merge, no wait-checks", () => {
    const stack = stack3();
    stack.prs[1] = pr(2, "b", "a", { checks: [{ name: "ci", state: "fail", url: null }] });
    const plan = planStackMerge(stack, { method: "squash", force: true, upTo: 2 }, wts);
    expect(plan.some((s) => s.kind === "wait-checks")).toBe(false);
    expect(plan.map((s) => s.kind)).toEqual(["merge", "retarget", "restack", "push", "merge"]);
    const merge = plan.find((s) => s.kind === "merge" && s.pr === 2);
    expect(merge).toMatchObject({ admin: true });
    const checks = (merge as Extract<PlanStep, { kind: "merge" }>).bypass.find((b) => b.kind === "checks");
    expect(checks).toMatchObject({ kind: "checks", failing: ["ci"] });
    expect(JSON.stringify(checks)).toContain("not yet verified");
  });

  test("force: clean child still gets admin merge with an unverified-checks bypass", () => {
    const plan = planStackMerge(stack3(), { method: "squash", force: true, upTo: 2 }, wts);
    expect(plan.some((s) => s.kind === "wait-checks")).toBe(false);
    expect(plan.find((s) => s.kind === "merge" && s.pr === 2)).toMatchObject({
      admin: true,
      bypass: [{ kind: "checks", failing: [] }],
    });
  });

  test("force bypasses blockers with --admin and lists them", () => {
    const stack = stack3();
    stack.prs[0] = pr(1, "a", TRUNK, {
      reviewDecision: "REVIEW_REQUIRED",
      unresolvedThreads: 3,
      checks: [{ name: "ci", state: "fail", url: null }],
    });
    const plan = planStackMerge(stack, { method: "squash", force: true, upTo: 1 }, wts);
    expect(plan).toEqual([
      {
        kind: "merge",
        pr: 1,
        method: "squash",
        admin: true,
        bypass: [
          { kind: "checks", failing: ["ci"], pending: [] },
          { kind: "review", decision: "REVIEW_REQUIRED" },
          { kind: "threads", count: 3 },
        ],
        sha: "a-sha",
      },
    ]);
  });

  test("force never bypasses conflict or draft", () => {
    for (const over of [{ mergeable: "CONFLICTING" as const }, { isDraft: true }]) {
      const stack = stack3();
      stack.prs[0] = pr(1, "a", TRUNK, over);
      expect(planStackMerge(stack, { method: "squash", force: true }, wts)).toEqual([]);
    }
    const stack = stack3();
    stack.prs[1] = pr(2, "b", "a", { mergeable: "CONFLICTING" });
    const plan = planStackMerge(stack, { method: "squash", force: true }, wts);
    expect(plan).toEqual([{ kind: "merge", pr: 1, method: "squash", admin: false, bypass: [], sha: "a-sha" }]);
  });

  test("merge method only retargets (no restack/push/wait)", () => {
    const plan = planStackMerge(stack3(), { method: "merge", force: false }, wts);
    expect(plan.map((s) => s.kind)).toEqual(["merge", "retarget", "merge", "retarget", "merge"]);
  });

  test("queue plans enqueue pending checks with the queue method, without a pinned head or bypass", () => {
    const stack = stack3();
    stack.prs[0]!.checks = [{ name: "ci", state: "pending", url: null }];
    stack.prs[1]!.checks = [{ name: "ci", state: "fail", url: null }];
    const plan = planStackMerge(stack, { method: "merge", force: false, rules: queueRules }, wts);
    expect(plan.filter((s) => s.kind === "merge")).toEqual([
      { kind: "merge", pr: 1, method: "squash", admin: false, bypass: [] },
      { kind: "merge", pr: 2, method: "squash", admin: false, bypass: [] },
      { kind: "merge", pr: 3, method: "squash", admin: false, bypass: [] },
    ]);
    expect(plan.filter((s) => s.kind === "restack").map((s) => s.pr)).toEqual([2, 3]);
    expect(plan.filter((s) => s.kind === "wait-checks").map((s) => s.pr)).toEqual([2, 3]);
  });

  test("queue plans defer missing required checks, unexplained BLOCKED, and checking to GitHub", () => {
    for (const over of [{ checks: [] }, { mergeState: "BLOCKED" as const }, { mergeState: "UNKNOWN" as const }, { mergeable: "UNKNOWN" as const }]) {
      const stack = { trunk: TRUNK, prs: [pr(1, "a", TRUNK, over)] };
      const rules = over.checks ? { ...queueRules, requiredChecks: ["ci"] } : queueRules;
      expect(planStackMerge(stack, { method: "rebase", force: false, rules }, wts)).toEqual([
        { kind: "merge", pr: 1, method: "squash", admin: false, bypass: [] },
      ]);
    }
  });

  test("queue plans retain review, threads, draft, conflict, and bottom BEHIND blockers even with force", () => {
    for (const force of [false, true]) {
      for (const over of [
        { reviewDecision: "REVIEW_REQUIRED" as const },
        { unresolvedThreads: 1 },
        { isDraft: true },
        { mergeable: "CONFLICTING" as const },
        { mergeState: "BEHIND" as const },
      ]) {
        const stack = { trunk: TRUNK, prs: [pr(1, "a", TRUNK, over)] };
        expect(planStackMerge(stack, { method: "squash", force, rules: queueRules }, wts)).toEqual([]);
      }
      const stack = stack3();
      stack.prs[1]!.mergeable = "CONFLICTING";
      expect(planStackMerge(stack, { method: "squash", force, rules: queueRules }, wts)).toEqual([
        { kind: "merge", pr: 1, method: "squash", admin: false, bypass: [] },
      ]);
    }
  });

  test("queue plans never synthesize force bypasses or pin unmoved merge-method heads", () => {
    for (const method of ["squash", "merge", "rebase"] as const) {
      const rules = { ...queueRules, mergeQueue: { method } };
      const plan = planStackMerge(stack3(), { method: "squash", force: true, rules }, wts);
      expect(plan.filter((s) => s.kind === "merge")).toEqual([1, 2, 3].map((pr) => ({
        kind: "merge", pr, method, admin: false, bypass: [],
      })));
      expect(plan.filter((s) => s.kind === "wait-checks")).toHaveLength(method === "merge" ? 0 : 2);
    }
  });
});

describe("executePlan", () => {
  const fakeExec: Exec = async () => ({ code: 0, stdout: "", stderr: "" });
  function harness(over: { dirty?: boolean; failMerge?: number; enqueue?: number; failPush?: boolean; failPreflight?: boolean } = {}) {
    const log: string[] = [];
    const git: GitOps = {
      fetchBranches: async (_e, cwd, b) => void log.push(`fetch ${cwd} ${b.join(",")}`),
      preflightBranch: async (_e, cwd, b, sha, w) => {
        log.push(`preflight ${cwd} ${b} ${sha} ${w}`);
        if (over.failPreflight) throw new StkError("diverged!", "diverged");
      },
      isClean: async () => !over.dirty,
      rebaseOnto: async (_e, cwd, b, onto, up, tip) => {
        log.push(`rebase ${cwd} ${b} ${onto} ${up} ${tip}`);
        return `${b}-new`;
      },
      leasedPush: async (_e, cwd, b, exp) => {
        if (over.failPush) throw new StkError("rejected", "lease-rejected");
        log.push(`push ${cwd} ${b} ${exp}`);
        return `${b}-new`;
      },
    };
    const gh = {
      merge: async (n: number, m: string, admin: boolean, extra?: { sha?: string }) => {
        if (over.failMerge === n) throw new Error("merge failed");
        log.push(`merge ${n} ${m} ${admin}${extra?.sha ? ` @${extra.sha}` : ""}`);
        return { status: over.enqueue === n ? ("enqueued" as const) : ("merged" as const) };
      },
      retarget: async (n: number, base: string) => void log.push(`retarget ${n} ${base}`),
      waitChecks: async (n: number) => void log.push(`wait ${n}`),
      rebaseStack: async () => {},
      refreshMergeability: async () => {},
    };
    const seen: boolean[] = [];
    return { log, seen, deps: { exec: fakeExec, repoDir: "/r", git, gh, onStep: (r: { ok: boolean }) => seen.push(r.ok) } };
  }

  const plan = (): PlanStep[] =>
    planStackMerge(
      { trunk: TRUNK, prs: [pr(1, "a", TRUNK), pr(2, "b", "a")] },
      { method: "squash", force: false },
      [wt(TRUNK, "/r"), wt("b", "/r-b")],
    );

  const failingChild = (force: boolean): PlanStep[] =>
    planStackMerge(
      { trunk: TRUNK, prs: [pr(1, "a", TRUNK), pr(2, "b", "a", { checks: [{ name: "ci", state: "fail", url: null }] })] },
      { method: "squash", force },
      [wt(TRUNK, "/r"), wt("b", "/r-b")],
    );

  test("force: failing child checks are bypassed with merge(child, method, true) and no waitChecks", async () => {
    const h = harness();
    const results = await executePlan(failingChild(true), h.deps);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(h.log).toContain("merge 2 squash true");
    expect(h.log.some((l) => l.startsWith("wait"))).toBe(false);
  });

  test("normal mode still waits and stops when child checks fail", async () => {
    const h = harness();
    h.deps.gh.waitChecks = async (n: number) => {
      h.log.push(`wait ${n}`);
      throw new StkError("checks failed", "gh-failed");
    };
    const results = await executePlan(failingChild(false), h.deps);
    expect(h.log).toContain("wait 2");
    expect(h.log.some((l) => l.startsWith("merge 2"))).toBe(false);
    expect(results.at(-1)).toMatchObject({ ok: false });
  });

  test("runs steps in order and reports each", async () => {
    const h = harness();
    const results = await executePlan(plan(), h.deps);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(h.log).toEqual([
      "preflight /r-b b b-sha /r-b",
      "merge 1 squash false @a-sha",
      "retarget 2 dev",
      "fetch /r-b dev,b",
      "rebase /r-b b origin/dev a-sha b-sha",
      "push /r-b b b-sha",
      "wait 2",
      "merge 2 squash false",
    ]);
    expect(h.seen).toHaveLength(6);
    expect(results[3]!.sha).toBe("b-new");
  });

  test("restack refuses a dirty worktree and stops", async () => {
    const h = harness({ dirty: true });
    const results = await executePlan(plan(), h.deps);
    expect(results.map((r) => r.ok)).toEqual([true, true, false]);
    expect(results[2]!.detail).toContain("uncommitted");
    expect(h.log.some((l) => l.startsWith("rebase"))).toBe(false);
  });

  test("preflight failure stops everything before the first merge", async () => {
    const h = harness({ failPreflight: true });
    const results = await executePlan(plan(), h.deps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false, detail: "diverged!" });
    expect(results[0]!.step.kind).toBe("restack");
    expect(h.log).toEqual(["preflight /r-b b b-sha /r-b"]);
    expect(h.seen).toEqual([false]);
  });

  test("stops at first failure", async () => {
    const h = harness({ failPush: true });
    const results = await executePlan(plan(), h.deps);
    expect(results[results.length - 1]).toMatchObject({ ok: false, detail: "rejected" });
    expect(h.log.some((l) => l.startsWith("wait") || l.startsWith("merge 2"))).toBe(false);
  });

  test("a failing merge stops the plan", async () => {
    const h = harness({ failMerge: 1 });
    const results = await executePlan(plan(), h.deps);
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
  });

  test("force merge detail lists bypassed blockers", async () => {
    const h = harness();
    const p = planStackMerge(
      { trunk: TRUNK, prs: [pr(1, "a", TRUNK, { reviewDecision: "REVIEW_REQUIRED" })] },
      { method: "squash", force: true },
      [],
    );
    const [r] = await executePlan(p, h.deps);
    expect(r!.detail).toContain("force-merged");
    expect(r!.detail).toContain("review");
    expect(h.log).toEqual(["merge 1 squash true @a-sha"]);
  });
});

describe("planStackMerge conflicts", () => {
  test("the plan ends before a conflicting member", () => {
    const stack = { trunk: TRUNK, prs: [pr(1, "a", TRUNK), pr(2, "b", "a", { mergeable: "CONFLICTING" })] };
    const plan = planStackMerge(stack, { method: "squash", force: true }, []);
    expect(plan.filter((s) => s.kind === "merge").map((s) => (s as { pr: number }).pr)).toEqual([1]);
  });
});

describe("planNativeStackMerge", () => {
  // native stacks are judged as if every PR targets the trunk; the stack is the open entries, bottom first
  const native = (...over: Partial<PullRequest>[]) => ({
    trunk: TRUNK,
    native: true,
    prs: [pr(1, "a", TRUNK), pr(2, "b", "a"), pr(3, "c", "b")].map((p, i) => ({ ...p, ...over[i] })),
  });

  test("one merge step on the top PR listing every included PR, pinned to its head", () => {
    expect(planNativeStackMerge(native(), { method: "squash", force: false })).toEqual([
      { kind: "merge", pr: 3, method: "squash", admin: false, bypass: [], sha: "c-sha", includes: [1, 2, 3] },
    ]);
  });

  test("stops at a conflicting member: only the prefix below it lands, and force cannot pass it", () => {
    const stack = native({}, { mergeable: "CONFLICTING" });
    expect(planNativeStackMerge(stack, { method: "squash", force: false })).toMatchObject([{ pr: 1, includes: [1] }]);
    expect(planNativeStackMerge(stack, { method: "squash", force: true })).toMatchObject([{ pr: 1, includes: [1] }]);
    expect(planNativeStackMerge(native({ mergeState: "DIRTY" }), { method: "squash", force: true })).toEqual([]);
  });

  test("a child's BEHIND (relative to its parent) does not stop the stack; the bottom one's does", () => {
    expect(planNativeStackMerge(native({}, { mergeState: "BEHIND" }), { method: "squash", force: false })).toMatchObject([{ includes: [1, 2, 3] }]);
    expect(planNativeStackMerge(native({ mergeState: "BEHIND" }), { method: "squash", force: false })).toEqual([]);
  });

  test("upTo lands only that PR and its downstack", () => {
    const [s] = planNativeStackMerge(native(), { method: "rebase", force: false, upTo: 2 });
    expect(s).toMatchObject({ pr: 2, method: "rebase", sha: "b-sha", includes: [1, 2] });
  });

  test("children's checks are NOT deferred: a failing downstack check blocks the prefix", () => {
    const failing = { checks: [{ name: "ci", state: "fail" as const, url: null }] };
    const [s] = planNativeStackMerge(native({}, failing), { method: "squash", force: false });
    expect(s).toMatchObject({ pr: 1, includes: [1] });
  });

  test("blocked bottom PR -> empty plan; no restack/retarget/push steps ever", () => {
    expect(planNativeStackMerge(native({ reviewDecision: "REVIEW_REQUIRED" }), { method: "squash", force: false })).toEqual([]);
    const kinds = planNativeStackMerge(native(), { method: "squash", force: true }).map((s) => s.kind);
    expect(kinds).toEqual(["merge"]);
  });

  test("force merges a PR that needs a bypass alone (GitHub bypasses only the bottom-most unmerged PR); clean runs stay one merge", () => {
    const plan = planNativeStackMerge(native({ reviewDecision: "REVIEW_REQUIRED" }, { unresolvedThreads: 2 }), { method: "squash", force: true }) as Extract<PlanStep, { kind: "merge" }>[];
    expect(plan.map((s) => [s.pr, s.admin, s.includes])).toEqual([
      [1, true, [1]],
      [2, true, [2]],
      [3, false, [3]],
    ]);
    expect(plan[0]!.bypass).toEqual([{ kind: "review", decision: "REVIEW_REQUIRED" }]);
    expect(plan[1]!.bypass).toEqual([{ kind: "threads", count: 2 }]);
  });

  test("force still never bypasses conflict/draft: the prefix stops before it", () => {
    const [s] = planNativeStackMerge(native({}, { isDraft: true }), { method: "squash", force: true });
    expect(s).toMatchObject({ pr: 1, includes: [1] });
  });

  test("queue plans enqueue a pending-check stack as one unpinned merge using the queue method", () => {
    const stack = native({ checks: [{ name: "ci", state: "pending", url: null }] }, { checks: [{ name: "ci", state: "fail", url: null }] });
    for (const force of [false, true]) {
      expect(planNativeStackMerge(stack, { method: "rebase", force, rules: queueRules })).toEqual([
        { kind: "merge", pr: 3, method: "squash", admin: false, bypass: [], includes: [1, 2, 3] },
      ]);
    }
  });

  test("queue plans defer missing required checks, unexplained BLOCKED, and checking to GitHub", () => {
    for (const over of [{ checks: [] }, { mergeState: "BLOCKED" as const }, { mergeState: "UNKNOWN" as const }, { mergeable: "UNKNOWN" as const }]) {
      const rules = over.checks ? { ...queueRules, requiredChecks: ["ci"] } : queueRules;
      expect(planNativeStackMerge(native(over), { method: "rebase", force: false, rules })).toEqual([
        { kind: "merge", pr: 3, method: "squash", admin: false, bypass: [], includes: [1, 2, 3] },
      ]);
    }
  });

  test("queue plans retain review, threads, draft, conflict, and bottom BEHIND blockers even with force", () => {
    for (const force of [false, true]) {
      for (const over of [
        { reviewDecision: "REVIEW_REQUIRED" as const },
        { unresolvedThreads: 1 },
        { isDraft: true },
        { mergeable: "CONFLICTING" as const },
        { mergeState: "BEHIND" as const },
      ]) {
        expect(planNativeStackMerge(native(over), { method: "squash", force, rules: queueRules })).toEqual([]);
      }
      expect(planNativeStackMerge(native({}, { mergeable: "CONFLICTING" }), { method: "squash", force, rules: queueRules })).toEqual([
        { kind: "merge", pr: 1, method: "squash", admin: false, bypass: [], includes: [1] },
      ]);
    }
  });

  test("queue method and upTo are respected without pinning the included top head", () => {
    const rules: RepoRules = { ...queueRules, mergeQueue: { method: "merge" } };
    expect(planNativeStackMerge(native(), { method: "squash", force: true, upTo: 2, rules })).toEqual([
      { kind: "merge", pr: 2, method: "merge", admin: false, bypass: [], includes: [1, 2] },
    ]);
  });

  test("executePlan: native step is one merge call; enqueued is reported and halts", async () => {
    const calls: string[] = [];
    const gh = {
      merge: async (n: number, m: string, admin: boolean, extra?: { sha?: string }) => {
        calls.push(`merge ${n} ${m} ${admin} ${extra?.sha}`);
        return { status: "enqueued" as const };
      },
      retarget: async () => {},
      waitChecks: async () => {},
      rebaseStack: async () => {},
      refreshMergeability: async () => {},
    };
    const results = await executePlan(planNativeStackMerge(native(), { method: "squash", force: false }), {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      repoDir: "",
      gh,
    });
    expect(calls).toEqual(["merge 3 squash false c-sha"]);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: true, enqueued: true });
    expect(results[0]!.detail).toContain("#3 with downstack #1, #2");
  });

  test("executePlan: merged native step names the downstack PRs it landed", async () => {
    const gh = { merge: async () => ({ status: "merged" as const, sha: "m1" }), retarget: async () => {}, waitChecks: async () => {}, rebaseStack: async () => {}, refreshMergeability: async () => {} };
    const [r] = await executePlan(planNativeStackMerge(native(), { method: "squash", force: false }), {
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      repoDir: "",
      gh,
    });
    expect(r).toMatchObject({ ok: true, sha: "m1", detail: "merged #3 with downstack #1, #2" });
  });

  test("executePlan: rebase-stack appends the note the rebase returned after `; `", async () => {
    const gh = { merge: async () => ({ status: "merged" as const }), retarget: async () => {}, waitChecks: async () => {}, rebaseStack: async () => "local checkouts left untouched", refreshMergeability: async () => {} };
    const deps = { exec: async () => ({ code: 0, stdout: "", stderr: "" }), repoDir: "", gh };
    const [withNote] = await executePlan([{ kind: "rebase-stack", pr: 2 }], deps);
    expect(withNote).toMatchObject({ ok: true, detail: "rebased the stack from #2 onto the trunk in a temporary checkout and pushed with leases; local checkouts left untouched" });
    const [plain] = await executePlan([{ kind: "rebase-stack", pr: 2 }], { ...deps, gh: { ...gh, rebaseStack: async () => {} } });
    expect(plain!.detail).toBe("rebased the stack from #2 onto the trunk in a temporary checkout and pushed with leases");
  });
});
