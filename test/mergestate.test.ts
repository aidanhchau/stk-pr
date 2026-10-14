import { afterEach, describe, expect, test } from "bun:test";
import type { Exec } from "../src/types";
import { describeBlocker, prAction, prReadiness, slugCtx } from "../src/service";

const base = { state: "OPEN" as const, isDraft: false, reviewDecision: null, checks: [], unresolvedThreads: 0 };

describe("describeBlocker", () => {
  test("names the base and the commit count", () => {
    expect(describeBlocker({ kind: "conflict", base: "main" })).toBe("conflicts with main");
    expect(describeBlocker({ kind: "behind", count: 1, base: "main" })).toBe("1 commit behind main");
    expect(describeBlocker({ kind: "behind", count: 5, base: "main" })).toBe("5 commits behind main");
    expect(describeBlocker({ kind: "checking" })).toBe("checking for conflicts…");
  });
});

describe("prReadiness with mergeStateStatus", () => {
  test("DIRTY is conflicts, UNKNOWN is not ready, BEHIND is behind, CLEAN is ready", () => {
    expect(prReadiness({ ...base, mergeable: "MERGEABLE", mergeState: "DIRTY" })).toBe("conflicts");
    expect(prReadiness({ ...base, mergeable: "CONFLICTING", mergeState: "DIRTY" })).toBe("conflicts");
    expect(prReadiness({ ...base, mergeable: "MERGEABLE", mergeState: "UNKNOWN" })).toBe("unknown");
    expect(prReadiness({ ...base, mergeable: "MERGEABLE", mergeState: "BEHIND" })).toBe("behind");
    expect(prReadiness({ ...base, mergeable: "MERGEABLE", mergeState: "CLEAN" })).toBe("ready");
  });
});

function github(view: Record<string, unknown>, update: { status: number; body: string } = { status: 202, body: "{}" }) {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv: [...argv], stdin: opts?.stdin });
    if (argv[1] === "pr" && argv[2] === "view") return { code: 0, stdout: JSON.stringify(view), stderr: "" };
    if (argv.includes("query=") || argv.some((a) => a.startsWith("query="))) return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }), stderr: "" };
    if (argv.includes("PUT")) return { code: 0, stdout: `HTTP/2.0 ${update.status} X\r\n\r\n${update.body}`, stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  };
  return { exec, calls };
}
const view = (over: Record<string, unknown>) => ({
  number: 7, title: "t", url: "u", author: { login: "a" }, state: "OPEN", isDraft: false, headRefName: "h", baseRefName: "main", headRefOid: "sha7",
  mergeable: "MERGEABLE", mergeStateStatus: "BEHIND", reviewDecision: null, statusCheckRollup: [], createdAt: "", updatedAt: "", ...over,
});

describe("prAction update-branch", () => {
  test("PUTs update-branch pinned to the viewed head sha", async () => {
    const { exec, calls } = github(view({}));
    const r = await prAction(slugCtx(exec, { owner: "o", name: "r" }), 7, "update-branch");
    expect(r).toEqual({ number: 7, action: "update-branch" });
    const put = calls.find((c) => c.argv.includes("PUT"))!;
    expect(put.argv).toContain("repos/o/r/pulls/7/update-branch");
    expect(JSON.parse(put.stdin!)).toEqual({ expected_head_sha: "sha7" });
  });

  test("refuses a conflicting PR without calling update-branch", async () => {
    const { exec, calls } = github(view({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }));
    await expect(prAction(slugCtx(exec, { owner: "o", name: "r" }), 7, "update-branch")).rejects.toThrow(/conflicts with main/);
    expect(calls.some((c) => c.argv.includes("PUT"))).toBe(false);
  });
});

import { blockers } from "../src/stack";
import { branchRules } from "../src/github";
import { clearRulesCache, rulesFor } from "../src/service";
import { nativeUpTo, type PullRequest } from "../src/types";

const RULES_JSON = JSON.stringify([
  { type: "pull_request", parameters: { require_code_owner_review: true, required_approving_review_count: 1 } },
  { type: "required_status_checks", parameters: { required_status_checks: [{ context: "Depot PR tests / test" }] } },
  { type: "deletion" },
]);
const rulesExec = (calls: string[][] = []): Exec => async (argv) => {
  calls.push([...argv]);
  return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${RULES_JSON}`, stderr: "" };
};
const SLUG = { owner: "o", name: "r" };
const pr = (over: Partial<PullRequest> = {}): PullRequest => ({
  number: 1, title: "t", url: "", author: "a", state: "OPEN", isDraft: false, headRef: "h", baseRef: "main", headSha: "s",
  mergeable: "MERGEABLE", reviewDecision: "APPROVED", checks: [{ name: "lint", state: "pass", url: null }], unresolvedThreads: 0,
  body: "", worktree: null, createdAt: "", updatedAt: "", ...over,
});

// the cache is process-wide; other test files use the same o/r slug
afterEach(() => clearRulesCache());

describe("branch rules", () => {
  test("branchRules maps required checks and code owner review from one call", async () => {
    const calls: string[][] = [];
    expect(await branchRules(rulesExec(calls), SLUG, "main")).toEqual({ requiredChecks: ["Depot PR tests / test"], codeOwnerReview: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.at(-1)).toBe("repos/o/r/rules/branches/main");
  });

  test("rulesFor caches per (repo, branch)", async () => {
    clearRulesCache();
    const calls: string[][] = [];
    const exec = rulesExec(calls);
    await rulesFor(exec, SLUG, "main");
    await rulesFor(exec, SLUG, "main");
    expect(calls).toHaveLength(1);
    await rulesFor(exec, SLUG, "dev");
    expect(calls).toHaveLength(2);
  });

  test("a required check that never reported is a blocker; a reported one is not", () => {
    const rules = { requiredChecks: ["Depot PR tests / test"], codeOwnerReview: true };
    expect(blockers(pr(), "main", rules)).toEqual([{ kind: "required-check", context: "Depot PR tests / test" }]);
    expect(blockers(pr({ checks: [{ name: "Depot PR tests / test", state: "pass", url: null }] }), "main", rules)).toEqual([]);
  });
});

describe("BLOCKED never reads as ready", () => {
  test("BLOCKED with no specific reason is 'blocked' (code owner hint from the rules)", () => {
    expect(blockers(pr({ mergeState: "BLOCKED" }), "main")).toEqual([{ kind: "blocked" }]);
    expect(blockers(pr({ mergeState: "BLOCKED" }), "main", { requiredChecks: [], codeOwnerReview: true })).toEqual([{ kind: "blocked", codeOwner: true }]);
    expect(describeBlocker({ kind: "blocked" })).toBe("blocked by repository rules");
  });

  test("a specific reason replaces the generic one", () => {
    expect(blockers(pr({ mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED" }), "main").map((b) => b.kind)).toEqual(["review"]);
    const rules = { requiredChecks: ["x"], codeOwnerReview: false };
    expect(blockers(pr({ mergeState: "BLOCKED" }), "main", rules).map((b) => b.kind)).toEqual(["required-check"]);
  });

  test("readiness is blocked, not ready", () => {
    expect(prReadiness({ ...base, reviewDecision: "APPROVED", mergeable: "MERGEABLE", mergeState: "BLOCKED" })).toBe("blocked");
  });
});

describe("nativeUpTo", () => {
  const entries = [1, 2, 3].map((number) => ({ number, state: "OPEN" }));
  const prs = [1, 2, 3];
  test("only native members above the bottom open PR", () => {
    expect(nativeUpTo({ native: true, prs, entries }, 1)).toBeNull();
    expect(nativeUpTo({ native: true, prs, entries }, 3)).toBe(3);
    expect(nativeUpTo({ native: true, prs: [0, ...prs], entries: [{ number: 0, state: "MERGED" }, ...entries] }, 2)).toBe(2);
    expect(nativeUpTo({ native: false, prs, entries }, 3)).toBeNull();
    expect(nativeUpTo(null, 3)).toBeNull();
  });

  test("a classic sibling shown in a forked tree is not counted in the native merge", () => {
    // native stack [1, 3]; classic PR 2 is also based on 1, so the page lists the tree [1, 2, 3]
    expect(nativeUpTo({ native: true, prs: [1, 3], entries }, 3)).toBe(2);
  });
});

import { planNativeStackMerge } from "../src/stack";
describe("stack plan with rules", () => {
  test("a missing required check stops the plan unless forced (bypassable)", () => {
    const stack = { trunk: "main", native: true, prs: [pr({ number: 1 }), pr({ number: 2, baseRef: "h" })] };
    const rules = { requiredChecks: ["ci/req"], codeOwnerReview: false };
    expect(planNativeStackMerge(stack, { method: "squash", force: false, rules })).toEqual([]);
    const [s] = planNativeStackMerge(stack, { method: "squash", force: true, rules });
    expect(s).toMatchObject({ kind: "merge", admin: true });
    expect(JSON.stringify(s)).toContain("required-check");
  });
});
