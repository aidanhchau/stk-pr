import { describe, expect, test } from "bun:test";
import type { Exec, PlanStep, StepResult, StkError } from "../src/types";
import { clearRulesCache, stackMerge, type Ctx } from "../src/service";

const A = 201;
const B = 202;
const CHAIN = [A, B];

interface Put {
  pr: number;
  sha?: string;
  bypass: boolean;
  method: string;
}

/**
 * Stateful fake GitHub for a native stack [A, B] on main, with B's branch in the worktree /wt-B. Squash-merging A leaves
 * B on A's (merged) branch with A's original commits, like GitHub; `gh stack push` moves B's head to `shaB1` and its
 * base to main. With `githubRestacks`, GitHub itself moves B onto main and to `shaB1` when A lands, and for that many
 * reads still shows the old head with mergeability "checking": `mergeStateStatus` UNKNOWN, or with `checkingAs:
 * "mergeable"` `mergeable` UNKNOWN beside a BLOCKED state. merge-async enforces what GitHub does: bypass only on the
 * bottom-most unmerged PR, and a pinned `sha` must still be the PR's head.
 */
function fakeGithub(o: { review: "required" | "approved"; dirty?: boolean; checkingReads?: number; githubRestacks?: number; checkingAs?: "mergeState" | "mergeable"; unexpectedDownstack?: boolean; staleMerged?: boolean; oldHeadReads?: number; missingWorktree?: number; detachedWorktree?: boolean; divergedLocal?: boolean; extensionMissing?: boolean; cleanGroup?: boolean }): { ctx: Ctx; puts: Put[]; ghStack: string[]; git: string[] } {
  const puts: Put[] = [];
  const ghStack: string[] = [];
  const git: string[] = [];
  const originalChain = o.cleanGroup ? [A, B, 203] : CHAIN;
  const merged = new Set<number>();
  let rebased = false;
  let checkingLeft = 0;
  let oldHeadLeft = 0;
  const head = (n: number) => (n === B && rebased ? "shaB1" : n === B ? "shaB0" : "shaA");
  const member = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: merged.has(n) && !o.staleMerged ? "MERGED" : "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: n === A || rebased ? "main" : `b${A}`, headRefOid: n === B && oldHeadLeft > 0 ? "shaB0" : head(n),
    mergeable: n === B && checkingLeft > 0 && o.checkingAs === "mergeable" ? "UNKNOWN" : "MERGEABLE",
    mergeStateStatus: n === B && checkingLeft > 0 ? (o.checkingAs === "mergeable" ? "BLOCKED" : "UNKNOWN") : "CLEAN",
    reviewDecision: o.review === "required" && (!o.cleanGroup || n === A) ? "REVIEW_REQUIRED" : "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const exec: Exec = async (argv, opts) => {
    const a = argv.join(" ");
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const chain = o.unexpectedDownstack && merged.has(A) ? [A, 200, B] : originalChain;
      const nodes = chain.map((n, i) => ({ position: i + 1, pullRequest: member(n) }));
      const read = ok(JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 2 }, stack: { size: 2, entries: { nodes } } } } } }));
      if (checkingLeft > 0) checkingLeft--;
      if (oldHeadLeft > 0) oldHeadLeft--;
      return read;
    }
    if (a.includes("merge-async")) {
      const pr = Number(/pulls\/(\d+)\//.exec(argv.find((x) => x.includes("merge-async"))!)![1]);
      const body = JSON.parse(opts?.stdin ?? "{}") as { merge_method: string; sha?: string; bypass_rules?: boolean };
      const fail = (message: string) => ({ code: 1, stdout: `HTTP/2.0 400 Bad Request\r\n\r\n${JSON.stringify({ status: "failed", details: { message } })}`, stderr: "" });
      if (body.bypass_rules && pr !== originalChain.find((m) => !merged.has(m))) return fail("Rules can only be bypassed when merging the bottom-most unmerged pull request in the stack.");
      if (body.sha && body.sha !== head(pr)) return fail("Head branch was modified. Review and try the merge again.");
      // B still carries A's original commits until it is rebased, so it cannot merge after A's squash
      if (pr === B && merged.has(A) && !rebased) return fail("Merge conflict detected");
      puts.push({ pr, ...(body.sha ? { sha: body.sha } : {}), bypass: body.bypass_rules === true, method: body.merge_method });
      for (const m of originalChain.filter((x) => x <= pr)) merged.add(m);
      if (pr === A && o.githubRestacks !== undefined) {
        rebased = true;
        checkingLeft = oldHeadLeft = o.githubRestacks;
      }
      return ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ status: "merged", details: {} })}`);
    }
    if (a.startsWith("gh repo view")) return ok(JSON.stringify({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } }));
    if (a.startsWith("gh stack ")) {
      ghStack.push(argv.slice(2).join(" "));
      if (a === "gh stack --version" && o.extensionMissing) return { code: 1, stdout: "", stderr: "unknown command" };
      if (a === "gh stack push") {
        rebased = true;
        checkingLeft = o.checkingReads ?? 0;
        oldHeadLeft = o.oldHeadReads ?? 0;
      }
      return ok("");
    }
    if (a === "git worktree list --porcelain") {
      const wt = (n: number) => (o.detachedWorktree && n === B ? `worktree /wt-${n}\nHEAD ${head(n)}\ndetached\n\n` : `worktree /wt-${n}\nHEAD sha${n}\nbranch refs/heads/b${n}\n\n`);
      return ok(`worktree /repo\nHEAD h0\nbranch refs/heads/main\n\n${originalChain.filter((n) => n !== A && n !== o.missingWorktree).map(wt).join("")}`);
    }
    // attaching a detached worktree to its branch: no local branch yet, so it is created where HEAD is
    if (a === `git rev-parse --verify --quiet refs/heads/b${B}`) return o.divergedLocal ? ok("localonly\n") : { code: 1, stdout: "", stderr: "" };
    if (a.startsWith("git merge-base --is-ancestor")) return { code: 1, stdout: "", stderr: "" };
    if (a.startsWith("git switch") || a.startsWith("git branch --set-upstream-to")) {
      git.push(`${a}@${opts?.cwd}`);
      return ok("");
    }
    if (a === "git status --porcelain") return ok(o.dirty ? " M bun.lock\n" : "");
    if (a.startsWith("git rev-parse --verify refs/heads/")) return ok(head(Number(argv[3]!.replace("refs/heads/b", ""))));
    if (a.startsWith("git ls-remote origin refs/heads/")) return ok(`${head(Number(argv[3]!.replace("refs/heads/b", "")))}\t${argv[3]}\n`);
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  const ctx: Ctx = { exec, root: "/repo", slug: { owner: "o", name: "r" }, worktrees: [{ path: "/wt-B", branch: `b${B}`, head: "shaB0", bare: false }] };
  return { ctx, puts, ghStack, git };
}

const noSleep = { attempts: 3, delayMs: 0, sleep: async () => {} };

describe("stackMerge on a native stack", () => {
  test("forced squash with a review bypass on both PRs: A lands, B is rebased, then B merges at its NEW head sha", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack } = fakeGithub({ review: "required" });
    const seen: StepResult[] = [];
    const plans: PlanStep[][] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, onStep: (s) => seen.push(s), onPlan: (p) => plans.push(p), replan: noSleep });
    expect(puts).toEqual([
      { pr: A, sha: "shaA", bypass: true, method: "squash" },
      { pr: B, sha: "shaB1", bypass: true, method: "squash" },
    ]);
    expect(ghStack).toEqual(["--version", "--version", "checkout 202", "rebase", "push"]);
    expect(r.results.map((x) => `${x.step.kind}:${"pr" in x.step ? x.step.pr : ""}`)).toEqual([`merge:${A}`, `rebase-stack:${B}`, `merge:${B}`]);
    expect(seen).toEqual(r.results);
    expect(r.merged).toEqual([A, B]);
    expect(r.remaining).toEqual([]);
    // the job's plan shows the rebase once it is known, and ends as exactly what ran
    expect(plans[0]!.map((s) => s.kind)).toEqual(["merge", "rebase-stack", "merge"]);
    expect(plans.at(-1)!.map((s) => s.kind)).toEqual(["merge", "rebase-stack", "merge"]);
  });

  test("a non-forced clean native stack is one merge call landing both PRs, with no rebase", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack } = fakeGithub({ review: "approved" });
    const plans: PlanStep[][] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: false, upTo: B, onPlan: (p) => plans.push(p), replan: noSleep });
    expect(puts).toEqual([{ pr: B, sha: "shaB0", bypass: false, method: "squash" }]);
    expect(r.results[0]!.step).toMatchObject({ kind: "merge", pr: B, includes: [A, B] });
    expect(ghStack).toEqual([]);
    expect(plans).toEqual([]);
    expect(r.merged).toEqual([A, B]);
  });

  test("a dirty child worktree stops the forced run before any merge", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack } = fakeGithub({ review: "required", dirty: true });
    const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e) => e)) as Error & { data?: { results: StepResult[] } };
    expect(err.message).toContain("stack merge stopped at #202: Rebase stack didn't start");
    expect(err.message).toContain("uncommitted changes (bun.lock)");
    expect(puts).toEqual([]);
    expect(ghStack).toEqual(["--version"]);
    expect(err.data!.results.map((x) => x.ok)).toEqual([false]);
  });

  test("a missing child worktree stops before the first forced merge, names how to open it, and says which branch needs one", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack } = fakeGithub({ review: "required", missingWorktree: B });
    const plans: PlanStep[][] = [];
    const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, onPlan: (p) => plans.push(p), replan: noSleep }).catch((e: Error) => e)) as StkError;
    expect(err.message).toBe("stack merge stopped at #202: no worktree has #202's branch (b202) checked out; open one with: stk worktree 202");
    expect(err.data).toMatchObject({ worktrees: [{ pr: 202, branch: "b202" }] });
    // the rebase is shown where it runs: after the first merge lands, not before anything merged
    expect(plans[0]!.map((s) => `${s.kind}:${"pr" in s ? s.pr : ""}`)).toEqual(["merge:201", "rebase-stack:202", "merge:202"]);
    expect(puts).toEqual([]);
    expect(ghStack).toEqual(["--version"]);
  });

  test("a detached worktree whose local branch has unpushed commits stops before the first merge, not after it", async () => {
    clearRulesCache();
    const { ctx, puts, git } = fakeGithub({ review: "required", detachedWorktree: true, divergedLocal: true });
    const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("has commits that are not on origin");
    expect(puts).toEqual([]);
    expect(git).toEqual([]);
  });

  test("a worktree detached at the branch tip counts: it is switched to the branch and the stack merges", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack, git } = fakeGithub({ review: "required", detachedWorktree: true });
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep });
    expect(r.merged).toEqual([A, B]);
    expect(git).toEqual([`git switch -c b${B}@/wt-${B}`, `git branch --set-upstream-to origin/b${B}@/wt-${B}`]);
    expect(ghStack).toContain("checkout 202");
    expect(puts.map((p) => p.pr)).toEqual([A, B]);
  });

  test("a missing extension stops before any forced merge or rebase mutation", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack } = fakeGithub({ review: "required", extensionMissing: true });
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e);
    expect((err as Error).message).toContain("gh extension install github/gh-stack");
    expect(puts).toEqual([]);
    expect(ghStack).toEqual(["--version"]);
  });

  test("every remaining selected branch needs a worktree even if it initially lands in a clean atomic group", async () => {
    clearRulesCache();
    // Initial plan: A bypass alone, then merge #203 includes=[B,203]. Rebase may reset reviews/checks and split that group.
    const { ctx, puts, ghStack } = fakeGithub({ review: "required", cleanGroup: true, missingWorktree: 203 });
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: 203, replan: noSleep }).catch((e: Error) => e);
    expect((err as Error).message).toContain("stk worktree 203");
    expect(puts).toEqual([]);
    expect(ghStack).toEqual(["--version"]);
  });

  test("right after the push GitHub still computes mergeability: the re-plan waits instead of stopping", async () => {
    clearRulesCache();
    const { ctx, puts } = fakeGithub({ review: "required", checkingReads: 2 });
    const sleeps: number[] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 5, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } });
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "shaB1"]);
    expect(r.merged).toEqual([A, B]);
  });

  for (const checkingAs of ["mergeState", "mergeable"] as const) {
    test(`when GitHub restacks B itself after A lands, B merges at the new head once its mergeability settles (${checkingAs} UNKNOWN)`, async () => {
      clearRulesCache();
      const { ctx, puts, ghStack } = fakeGithub({ review: "required", githubRestacks: 2, checkingAs });
      const sleeps: number[] = [];
      const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 5, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } });
      expect(sleeps).toEqual([7, 7]);
      expect(puts.map((p) => p.sha)).toEqual(["shaA", "shaB1"]);
      expect(r.merged).toEqual([A, B]);
      expect(ghStack).toEqual(["--version"]);
    });

    test(`mergeability still computing after polling runs out stops with that reason instead of force-merging (${checkingAs} UNKNOWN)`, async () => {
      clearRulesCache();
      const { ctx, puts } = fakeGithub({ review: "required", githubRestacks: 99, checkingAs });
      const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e);
      expect((err as Error).message).toBe("stack merge stopped at #202: GitHub is still checking it for conflicts after #201 landed; merge again once that settles");
      expect(puts.map((p) => p.pr)).toEqual([A]);
    });
  }

  test("an unexpected downstack PR after A lands stops before any rebase or merge of the changed stack", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack } = fakeGithub({ review: "required", unexpectedDownstack: true });
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("native stack membership or order changed");
    expect(puts.map((p) => p.pr)).toEqual([A]);
    expect(ghStack).toEqual(["--version"]);
  });

  test("exhausted stale-state polling stops before any rebase mutation", async () => {
    clearRulesCache();
    const { ctx, puts, ghStack } = fakeGithub({ review: "required", staleMerged: true });
    const sleeps: number[] = [];
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 2, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GitHub still lists #201 as open after it merged");
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.pr)).toEqual([A]);
    expect(ghStack).toEqual(["--version"]);
  });

  test("CLEAN snapshots with the old head after push are polled until the actual pushed SHA appears", async () => {
    clearRulesCache();
    const { ctx, puts } = fakeGithub({ review: "required", oldHeadReads: 2 });
    const sleeps: number[] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 3, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } });
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "shaB1"]);
    expect(r.merged).toEqual([A, B]);
  });

  test("old heads after push that outlast polling stop before B is merged", async () => {
    clearRulesCache();
    const { ctx, puts } = fakeGithub({ review: "required", oldHeadReads: 99 });
    const sleeps: number[] = [];
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 2, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GitHub has not reflected the pushed head of #202 (shaB1)");
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.pr)).toEqual([A]);
  });
});
