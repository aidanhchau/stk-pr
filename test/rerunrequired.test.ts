import { beforeEach, describe, expect, test } from "bun:test";
import { StkError, type Exec } from "../src/types";
import { clearRulesCache, describeRerunStep, planRerunRequired, rerunRequired, slugCtx, type Ctx } from "../src/service";

interface World {
  checkRuns?: unknown[];
  suites?: unknown[];
  runs?: unknown[];
  jobs?: Record<number, string[]>;
  required?: string[];
}

const http = (status: number, body: unknown) => ({ code: status < 300 ? 0 : 1, stdout: `HTTP/2.0 ${status} X\r\n\r\n${JSON.stringify(body)}`, stderr: "" });
const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });

/** gh answering for PR #7 (head sha1, branch feat, base main) in o/r; every call is recorded. */
function fake(w: World = {}, worktrees: Ctx["worktrees"] = []) {
  const calls: string[] = [];
  const exec: Exec = async (argv) => {
    const a = argv.join(" ");
    calls.push(a);
    if (a.startsWith("gh repo view") && a.includes("defaultBranchRef")) return ok({ defaultBranchRef: { name: "main" } });
    if (a.startsWith("gh pr view 7")) {
      return ok({ number: 7, title: "t", url: "", author: { login: "me" }, state: "OPEN", isDraft: false, headRefName: "feat", baseRefName: "main", headRefOid: "sha1", mergeable: "MERGEABLE", mergeStateStatus: "BLOCKED", reviewDecision: "APPROVED", statusCheckRollup: [], createdAt: "", updatedAt: "" });
    }
    if (argv.some((x) => x.startsWith("query="))) return ok({ data: { repository: { pr7: { reviewThreads: { nodes: [] } } } } });
    if (a.includes("/rules/branches/")) return http(200, [{ type: "required_status_checks", parameters: { required_status_checks: (w.required ?? ["build"]).map((context) => ({ context })) } }]);
    if (a.includes("commits/sha1/check-runs")) return http(200, { check_runs: w.checkRuns ?? [] });
    if (a.includes("commits/sha1/check-suites")) return http(200, { check_suites: w.suites ?? [] });
    if (a.includes("actions/runs?head_sha=sha1")) return http(200, { workflow_runs: w.runs ?? [] });
    const jobs = /actions\/runs\/(\d+)\/jobs/.exec(a);
    if (jobs) return http(200, { jobs: (w.jobs?.[Number(jobs[1])] ?? []).map((name) => ({ name })) });
    if (a.startsWith("gh run rerun")) return { code: 0, stdout: "", stderr: "" };
    if (a.includes("/rerequest")) return http(201, {});
    return { code: 1, stdout: "", stderr: `unexpected ${a}` };
  };
  return { ctx: { ...slugCtx(exec, { owner: "o", name: "r" }), worktrees } as Ctx, calls };
}

beforeEach(() => clearRulesCache());

describe("planRerunRequired", () => {
  test("re-runs the workflow run that holds the job", async () => {
    const { ctx, calls } = fake({ runs: [{ id: 11, name: "CI", status: "completed", conclusion: "skipped" }], jobs: { 11: ["build", "lint"] } });
    const plan = await planRerunRequired(ctx, 7);
    expect(plan.contexts).toEqual(["build"]);
    expect(plan.steps).toEqual([{ kind: "rerun-run", runId: 11, name: "CI", failedOnly: false, contexts: ["build"] }]);
    expect(describeRerunStep(plan.steps[0]!)).toContain("workflow “CI”");
    await rerunRequired(ctx, plan);
    expect(calls).toContain("gh run rerun 11 -R o/r");
  });

  test("a failed run is re-run with --failed; `workflow / job` contexts match", async () => {
    const { ctx, calls } = fake({ required: ["CI / build"], runs: [{ id: 12, name: "CI", status: "completed", conclusion: "failure" }], jobs: { 12: ["build"] } });
    await rerunRequired(ctx, await planRerunRequired(ctx, 7));
    expect(calls).toContain("gh run rerun 12 --failed -R o/r");
  });

  test("a run still in progress is not re-run", async () => {
    const { ctx } = fake({ runs: [{ id: 11, name: "CI", status: "in_progress", conclusion: null }], jobs: { 11: ["build"] } });
    const e = (await planRerunRequired(ctx, 7).catch((x: unknown) => x)) as StkError;
    expect(e.message).toContain("still in progress");
  });

  test("a third-party suite that never produced a run is re-requested", async () => {
    const { ctx, calls } = fake({ suites: [{ id: 55, app: { slug: "depot" }, status: "completed", conclusion: null, latest_check_runs_count: 0 }, { id: 56, app: { slug: "github-actions" }, status: "completed", conclusion: "success", latest_check_runs_count: 2 }] });
    const plan = await planRerunRequired(ctx, 7);
    expect(plan.steps).toEqual([{ kind: "rerequest-suite", suiteId: 55, app: "depot", contexts: ["build"] }]);
    await rerunRequired(ctx, plan);
    expect(calls).toContain("gh api -i -X POST repos/o/r/check-suites/55/rerequest");
  });

  test("an existing non-Actions check run re-requests its own suite", async () => {
    const { ctx } = fake({ checkRuns: [{ name: "build", status: "completed", conclusion: "neutral", app: { slug: "depot" }, check_suite: { id: 77 }, details_url: "https://depot.dev/x" }] });
    expect((await planRerunRequired(ctx, 7)).steps).toEqual([{ kind: "rerequest-suite", suiteId: 77, app: "depot", contexts: ["build"] }]);
  });

  test("nothing to re-run: one empty-commit step from the branch's worktree", async () => {
    const { ctx } = fake({}, [{ path: "/wt/feat", branch: "feat", head: "sha1", bare: false }]);
    const plan = await planRerunRequired(ctx, 7);
    expect(plan.steps).toEqual([{ kind: "empty-commit", branch: "feat", worktree: "/wt/feat", contexts: ["build"] }]);
    expect(describeRerunStep(plan.steps[0]!)).toContain("empty commit");
  });

  test("an unresolved context falls back to the empty commit for everything", async () => {
    const { ctx } = fake({ required: ["build", "deploy"], runs: [{ id: 11, name: "CI", status: "completed", conclusion: "success" }], jobs: { 11: ["build"] } }, [{ path: "/wt/feat", branch: "feat", head: "sha1", bare: false }]);
    const plan = await planRerunRequired(ctx, 7);
    expect(plan.steps.map((s) => s.kind)).toEqual(["empty-commit"]);
    expect(plan.steps[0]!.contexts).toEqual(["deploy"]);
  });

  test("no worktree and nothing to re-run says so", async () => {
    const { ctx } = fake();
    const e = (await planRerunRequired(ctx, 7).catch((x: unknown) => x)) as StkError;
    expect(e.message).toContain("no worktree has feat");
  });
});

describe("palette availability", () => {
  test("rerun-required needs the blocker; create-pr and stack-submit need no PR", async () => {
    const { COMMANDS, available } = await import("../src/commands");
    const f = { state: "OPEN" as const, isDraft: false, failingChecks: false, behind: false, baseMerged: false, inStack: false, nativeStack: false, hasWorktree: false, onPage: false };
    const by = (id: string) => COMMANDS.find((c) => c.id === id)!;
    expect(available(by("rerun-required"), f)).toBe(false);
    expect(available(by("rerun-required"), { ...f, requiredCheckMissing: true })).toBe(true);
    expect(available(by("create-pr"), null)).toBe(true);
    expect(available(by("stack-submit"), null)).toBe(true);
  });
});
