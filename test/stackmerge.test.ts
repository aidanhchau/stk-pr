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
 * Stateful fake GitHub for a native stack [A, B] on main. Squash-merging A leaves B on A's (merged) branch with A's
 * original commits, like GitHub; the restack (rebase in a temporary worktree, then an atomic leased push) moves B's head
 * to `shaB1` and its base to main. With `githubRestacks`, GitHub itself moves B onto main and to `shaB1` when A lands,
 * and for that many reads still shows the old head with mergeability "checking": `mergeStateStatus` UNKNOWN, or with
 * `checkingAs: "mergeable"` `mergeable` UNKNOWN beside a BLOCKED state. merge-async enforces what GitHub does: bypass
 * only on the bottom-most unmerged PR, and a pinned `sha` must still be the PR's head. `divergedLocal` gives b202 a
 * local commit that is not on origin; `originMoved` makes origin/b202 differ from the head the stack was read at.
 */
function fakeGithub(o: { review: "required" | "approved"; checkingReads?: number; githubRestacks?: number; checkingAs?: "mergeState" | "mergeable"; unexpectedDownstack?: boolean; staleMerged?: boolean; oldHeadReads?: number; divergedLocal?: boolean; originMoved?: boolean; cleanGroup?: boolean }): { ctx: Ctx; puts: Put[]; pushes: string[]; git: string[] } {
  const puts: Put[] = [];
  const pushes: string[] = [];
  const git: string[] = [];
  const originalChain = o.cleanGroup ? [A, B, 203] : CHAIN;
  const merged = new Set<number>();
  let rebased = false;
  let checkingLeft = 0;
  let oldHeadLeft = 0;
  let checkedOut = 0;
  const head = (n: number) => (n === B ? (rebased ? "shaB1" : "shaB0") : n === 203 ? (rebased ? "new203" : "sha203") : "shaA");
  const member = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: merged.has(n) && !o.staleMerged ? "MERGED" : "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: n === A || rebased ? "main" : `b${originalChain[originalChain.indexOf(n) - 1]}`, headRefOid: n === B && oldHeadLeft > 0 ? "shaB0" : head(n),
    mergeable: n === B && checkingLeft > 0 && o.checkingAs === "mergeable" ? "UNKNOWN" : "MERGEABLE",
    mergeStateStatus: n === B && checkingLeft > 0 ? (o.checkingAs === "mergeable" ? "BLOCKED" : "UNKNOWN") : "CLEAN",
    reviewDecision: o.review === "required" && (!o.cleanGroup || n === A) ? "REVIEW_REQUIRED" : "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const no = () => ({ code: 1, stdout: "", stderr: "" });
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
    if (argv[0] !== "git") return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
    const g = argv.filter((x, i) => !(x === "-c" || argv[i - 1] === "-c")).slice(1).join(" ");
    git.push(g);
    if (g.startsWith("fetch ")) return ok("");
    if (g === "worktree list --porcelain") return ok(`worktree /repo\nHEAD h0\nbranch refs/heads/main\n\nworktree /wt-B\nHEAD shaB0\nbranch refs/heads/b${B}\n\n`);
    if (g === "rev-parse --verify --quiet refs/remotes/origin/main") return ok("trunk0\n");
    const remote = /^rev-parse --verify --quiet refs\/remotes\/origin\/b(\d+)$/.exec(g);
    if (remote) return ok(`${o.originMoved && Number(remote[1]) === B ? "otherB" : head(Number(remote[1]))}\n`);
    if (g === `rev-parse --verify --quiet refs/heads/b${B}`) return o.divergedLocal ? ok("localonly\n") : no();
    if (g.startsWith("rev-parse --verify --quiet refs/heads/")) return no();
    if (g.startsWith("merge-base --is-ancestor")) return no();
    if (g.startsWith("worktree add --detach") || g.startsWith("worktree remove") || g === "worktree prune") return ok("");
    const co = /^checkout --detach (\S+)$/.exec(g);
    if (co) {
      checkedOut = co[1] === "shaB0" ? B : 203;
      return ok("");
    }
    if (g.startsWith("rebase --no-autostash")) return ok("");
    // the rebased tip of the member that is checked out
    if (g === "rev-parse HEAD") return ok(`${checkedOut === B ? "shaB1" : "new203"}\n`);
    if (g.startsWith("push ")) {
      pushes.push(g);
      rebased = true;
      checkingLeft = o.checkingReads ?? 0;
      oldHeadLeft = o.oldHeadReads ?? 0;
      return ok("");
    }
    const ls = /^ls-remote origin refs\/heads\/b(\d+)$/.exec(g);
    if (ls) return ok(`${head(Number(ls[1]))}\trefs/heads/b${ls[1]}\n`);
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  const ctx: Ctx = { exec, root: "/repo", slug: { owner: "o", name: "r" }, worktrees: [{ path: "/wt-B", branch: `b${B}`, head: "shaB0", bare: false }] };
  return { ctx, puts, pushes, git };
}

const noSleep = { attempts: 3, delayMs: 0, sleep: async () => {} };

describe("stackMerge on a native stack", () => {
  test("forced squash with a review bypass on both PRs: A lands, B is rebased, then B merges at its NEW head sha", async () => {
    clearRulesCache();
    const { ctx, puts, pushes, git } = fakeGithub({ review: "required" });
    const seen: StepResult[] = [];
    const plans: PlanStep[][] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, onStep: (s) => seen.push(s), onPlan: (p) => plans.push(p), replan: noSleep });
    expect(puts).toEqual([
      { pr: A, sha: "shaA", bypass: true, method: "squash" },
      { pr: B, sha: "shaB1", bypass: true, method: "squash" },
    ]);
    // A's head (what a squash leaves in B's history) is where B's own commits start; B lands on the trunk tip
    expect(git).toContain("checkout --detach shaB0");
    expect(git).toContain("rebase --no-autostash --onto trunk0 shaA");
    expect(pushes).toEqual(["push --atomic --force-with-lease=refs/heads/b202:shaB0 origin shaB1:refs/heads/b202"]);
    expect(git).toContain("ls-remote origin refs/heads/b202");
    expect(git.some((c) => c.includes("stack"))).toBe(false);
    expect(r.results[1]!.detail).toContain("temporary checkout");
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
    const { ctx, puts, git } = fakeGithub({ review: "approved" });
    const plans: PlanStep[][] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: false, upTo: B, onPlan: (p) => plans.push(p), replan: noSleep });
    expect(puts).toEqual([{ pr: B, sha: "shaB0", bypass: false, method: "squash" }]);
    expect(r.results[0]!.step).toMatchObject({ kind: "merge", pr: B, includes: [A, B] });
    expect(git).toEqual([]);
    expect(plans).toEqual([]);
    expect(r.merged).toEqual([A, B]);
  });

  test("unpushed local commits on a member branch stop the forced run before any merge, naming the branch", async () => {
    clearRulesCache();
    const { ctx, puts, pushes, git } = fakeGithub({ review: "required", divergedLocal: true });
    const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e)) as Error & { data?: { results: StepResult[] } };
    expect(err.message).toContain("stack merge stopped at #202");
    expect(err.message).toContain("unpushed commits on b202");
    expect(err.message).toContain("/wt-B");
    expect(puts).toEqual([]);
    expect(pushes).toEqual([]);
    expect(git.some((c) => c.startsWith("worktree add"))).toBe(false);
    expect(git).toContain("merge-base --is-ancestor localonly shaB0");
    expect(err.data!.results.map((x) => x.ok)).toEqual([false]);
  });

  test("an origin head that differs from the planned one is a lease-rejected stop before any merge", async () => {
    clearRulesCache();
    const { ctx, puts, pushes } = fakeGithub({ review: "required", originMoved: true });
    const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("origin/b202 is otherB but the stack was read at shaB0");
    expect(puts).toEqual([]);
    expect(pushes).toEqual([]);
  });

  test("every remaining member is rebased in the temporary checkout, including those of a clean atomic group", async () => {
    clearRulesCache();
    // Initial plan: A bypass alone, then merge #203 includes=[B,203]; the rebase may reset reviews/checks and split that group.
    const { ctx, puts, pushes, git } = fakeGithub({ review: "required", cleanGroup: true });
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: 203, replan: noSleep });
    expect(r.merged).toEqual([A, B, 203]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "new203"]);
    expect(pushes).toEqual(["push --atomic --force-with-lease=refs/heads/b202:shaB0 --force-with-lease=refs/heads/b203:sha203 origin shaB1:refs/heads/b202 new203:refs/heads/b203"]);
    expect(git).toContain("rebase --no-autostash --onto trunk0 shaA");
    expect(git).toContain("rebase --no-autostash --onto shaB1 shaB0");
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
      const { ctx, puts, pushes } = fakeGithub({ review: "required", githubRestacks: 2, checkingAs });
      const sleeps: number[] = [];
      const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 5, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } });
      expect(sleeps).toEqual([7, 7]);
      expect(puts.map((p) => p.sha)).toEqual(["shaA", "shaB1"]);
      expect(r.merged).toEqual([A, B]);
      expect(pushes).toEqual([]);
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
    const { ctx, puts, pushes } = fakeGithub({ review: "required", unexpectedDownstack: true });
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("native stack membership or order changed");
    expect(puts.map((p) => p.pr)).toEqual([A]);
    expect(pushes).toEqual([]);
  });

  test("exhausted stale-state polling stops before any rebase mutation", async () => {
    clearRulesCache();
    const { ctx, puts, pushes } = fakeGithub({ review: "required", staleMerged: true });
    const sleeps: number[] = [];
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 2, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GitHub still lists #201 as open after it merged");
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.pr)).toEqual([A]);
    expect(pushes).toEqual([]);
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
