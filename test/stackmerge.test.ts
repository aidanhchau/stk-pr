import { describe, expect, test } from "bun:test";
import type { Exec, MergeMethod, PlanStep, StepResult } from "../src/types";
import { clearRulesCache, stackMerge, type Ctx } from "../src/service";

const A = 201;
const B = 202;
const C = 203;
const CHAIN = [A, B];

interface Put {
  pr: number;
  sha?: string;
  bypass: boolean;
  method: string;
}

interface FakeOptions {
  review: "required" | "approved";
  /** Exactly these PRs need a review (and so a bypass); overrides `review`. */
  reviewRequired?: number[];
  checkingReads?: number;
  /** A merge WITHOUT bypass makes GitHub retarget B onto main and rebase it to `shaB1`; for this many reads B shows mergeability "checking". */
  githubRestacks?: number;
  /** How many reads still show B's old head after GitHub's restack (default: `githubRestacks`). */
  githubHeadReads?: number;
  /** GitHub rebases B but never changes its base. */
  githubNoRetarget?: boolean;
  /** GitHub retargets B but its head stays (what a `merge`-method stack looks like). */
  githubKeepsHeads?: boolean;
  checkingAs?: "mergeState" | "mergeable";
  /** REST `mergeable_state` stays "unknown" for this many reads of B after its base changed. */
  unknownReads?: number;
  /** The stack dissolves by itself after a bypass merge (stk did not re-link anything) and B is left based on main. */
  dissolveOnBypass?: boolean;
  unexpectedDownstack?: boolean;
  /** After the push, #203 shows as conflicting (DIRTY, stale from before its base was recomputed) for this many reads. */
  dirtyReads?: number;
  /** Closing and reopening #203 makes GitHub recompute: its stale conflict flag clears. */
  reopenClearsDirty?: boolean;
  /** What the compare API reports for a member's head against its base (default 0: the head contains the base). */
  behindBy?: number;
  staleMerged?: boolean;
  oldHeadReads?: number;
  divergedLocal?: boolean;
  originMoved?: boolean;
  cleanGroup?: boolean;
}

/**
 * Stateful fake GitHub for a native stack [A, B] (or [A, B, C] with `cleanGroup`) on main, behaving as the lab experiments
 * showed. A merge-async WITHOUT bypass makes GitHub retarget the next PR onto main and rebase the rest (`githubRestacks`);
 * with bypass GitHub does neither: B stays in the stack on A's merged branch with A's original commits, and cannot merge
 * ("cannot be merged because it has a merge conflict") until it is both rebased (local restack + leased push) and
 * retargeted. A base cannot be changed while the PR is in a stack (422): unstack, PATCH, re-create (the REST stack API).
 * Bypass is only accepted on the bottom-most unmerged PR, and a pinned `sha` must still be the PR's head. `events` is the
 * order of every mutation. `divergedLocal` gives b202 a local commit that is not on origin; `originMoved` makes
 * origin/b202 differ from the head the stack was read at.
 */
function fakeGithub(o: FakeOptions): { ctx: Ctx; puts: Put[]; pushes: string[]; git: string[]; events: string[]; rest: string[] } {
  const puts: Put[] = [];
  const pushes: string[] = [];
  const git: string[] = [];
  const events: string[] = [];
  const rest: string[] = [];
  const originalChain = o.cleanGroup ? [A, B, C] : CHAIN;
  const merged = new Set<number>();
  const bases: Record<number, string> = { [A]: "main", [B]: `b${A}`, [C]: `b${B}` };
  const heads: Record<number, string> = { [A]: "shaA", [B]: "shaB0", [C]: "sha203" };
  let members = [...originalChain];
  let checkingLeft = 0;
  let dirtyLeft = 0;
  let oldHeadLeft = 0;
  let unknownLeft = 0;
  let checkedOut = 0;
  const rebase = () => {
    heads[B] = "shaB1";
    heads[C] = "new203";
  };
  const requires = (n: number) => (o.reviewRequired ? o.reviewRequired.includes(n) : o.review === "required" && (!o.cleanGroup || n === A));
  const member = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: merged.has(n) && !o.staleMerged ? "MERGED" : "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: bases[n], headRefOid: n === B && oldHeadLeft > 0 ? "shaB0" : heads[n],
    mergeable: n === C && dirtyLeft > 0 ? "CONFLICTING" : n === B && checkingLeft > 0 && o.checkingAs === "mergeable" ? "UNKNOWN" : "MERGEABLE",
    mergeStateStatus: n === C && dirtyLeft > 0 ? "DIRTY" : n === B && checkingLeft > 0 ? (o.checkingAs === "mergeable" ? "BLOCKED" : "UNKNOWN") : "CLEAN",
    reviewDecision: requires(n) ? "REVIEW_REQUIRED" : "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const ok = (stdout: string) => ({ code: 0, stdout, stderr: "" });
  const no = () => ({ code: 1, stdout: "", stderr: "" });
  const http = (status: number, body: unknown) => ok(`HTTP/2.0 ${status} X\r\n\r\n${body === null ? "" : JSON.stringify(body)}`);
  const settle = () => {
    if (checkingLeft > 0) checkingLeft--;
    if (oldHeadLeft > 0) oldHeadLeft--;
    if (dirtyLeft > 0) dirtyLeft--;
  };
  const exec: Exec = async (argv, opts) => {
    const a = argv.join(" ");
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const n = Number(argv[argv.indexOf("-F") + 1]!.slice(2));
      if (!members.includes(n)) return ok(JSON.stringify({ data: { repository: { pullRequest: { stackEntry: null, stack: null } } } }));
      const chain = o.unexpectedDownstack && merged.has(A) ? [A, 200, B] : members;
      const nodes = chain.map((m, i) => ({ position: i + 1, pullRequest: member(m) }));
      const read = ok(JSON.stringify({ data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 2 }, stack: { size: nodes.length, entries: { nodes } } } } } }));
      settle();
      return read;
    }
    if (/pr\d+: pullRequest/.test(query)) {
      const repository: Record<string, unknown> = {};
      for (const m of query.matchAll(/pr(\d+): pullRequest/g)) repository[`pr${m[1]}`] = member(Number(m[1]));
      const read = ok(JSON.stringify({ data: { repository } }));
      settle();
      return read;
    }
    if (a.startsWith("gh pr list")) return ok(JSON.stringify(originalChain.filter((n) => !merged.has(n)).map((n) => ({ number: n, headRefName: `b${n}`, baseRefName: bases[n] }))));
    if (a.includes("merge-async")) {
      const pr = Number(/pulls\/(\d+)\//.exec(argv.find((x) => x.includes("merge-async"))!)![1]);
      const body = JSON.parse(opts?.stdin ?? "{}") as { merge_method: MergeMethod; sha?: string; bypass_rules?: boolean };
      const fail = (message: string) => ({ code: 1, stdout: `HTTP/2.0 400 Bad Request\r\n\r\n${JSON.stringify({ status: "failed", details: { message } })}`, stderr: "" });
      if (body.bypass_rules && pr !== originalChain.find((m) => !merged.has(m))) return fail("Rules can only be bypassed when merging the bottom-most unmerged pull request in the stack.");
      if (body.sha && body.sha !== heads[pr]) return fail("Head branch was modified. Review and try the merge again.");
      const parent = originalChain[originalChain.indexOf(pr) - 1];
      // a child left on its merged parent's branch conflicts with the squash commit, rebased or not
      if (parent !== undefined && merged.has(parent) && bases[pr] !== "main") return fail("Pull request cannot be merged because it has a merge conflict.");
      // a child still carrying the parent's original commits conflicts with the parent's squash commit
      if (parent !== undefined && merged.has(parent) && body.merge_method === "squash" && heads[pr] === (pr === B ? "shaB0" : "sha203")) return fail("Merge conflict detected");
      puts.push({ pr, ...(body.sha ? { sha: body.sha } : {}), bypass: body.bypass_rules === true, method: body.merge_method });
      events.push(`merge ${pr}`);
      for (const m of originalChain.filter((x) => x <= pr)) merged.add(m);
      if (pr === A && body.bypass_rules && o.dissolveOnBypass) {
        members = [];
        bases[B] = "main";
      }
      if (pr === A && !body.bypass_rules && o.githubRestacks !== undefined) {
        if (!o.githubNoRetarget) bases[B] = "main";
        if (!o.githubKeepsHeads) rebase();
        checkingLeft = o.githubRestacks;
        oldHeadLeft = o.githubKeepsHeads ? 0 : (o.githubHeadReads ?? o.githubRestacks);
      }
      return ok(`HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ status: "merged", details: {} })}`);
    }
    if (a.startsWith("gh repo view")) return ok(JSON.stringify({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } }));
    const compare = /^gh api -i repos\/o\/r\/compare\/(.+)\.\.\.(.+)$/.exec(a);
    if (compare) return http(200, { behind_by: o.behindBy ?? 0, ahead_by: 14 });
    const api = /^gh api -i (?:-X (\w+) )?repos\/o\/r\/(pulls\/(\d+)|stacks(?:\/\d+\/unstack)?)(?: |$)/.exec(a);
    if (api) {
      const input = opts?.stdin ? (JSON.parse(opts.stdin) as { base?: string; state?: string; pull_requests?: number[] }) : {};
      const n = Number(api[3]);
      if (!api[1]) {
        const state = unknownLeft > 0 ? "unknown" : "clean";
        if (unknownLeft > 0) unknownLeft--;
        return http(200, { base: { ref: bases[n] }, mergeable_state: state, stack: members.includes(n) ? { number: 4 } : null });
      }
      if (api[1] === "POST" && api[2]!.endsWith("/unstack")) {
        rest.push("unstack");
        events.push("unstack");
        members = [];
        return http(204, null);
      }
      if (api[1] === "POST") {
        rest.push(`create ${input.pull_requests!.join(",")}`);
        events.push(`create ${input.pull_requests!.join(",")}`);
        members = input.pull_requests!;
        return http(201, { number: 5, pull_requests: members });
      }
      if (api[1] === "PATCH" && input.state) {
        events.push(`${input.state === "closed" ? "close" : "reopen"} ${n}`);
        if (input.state === "open" && o.reopenClearsDirty) dirtyLeft = 0;
        return http(200, {});
      }
      if (members.includes(n)) return http(422, { message: "Cannot change the base branch because the pull request is part of a stack." });
      rest.push(`base ${n} ${input.base}`);
      events.push(`base ${n} ${input.base}`);
      bases[n] = input.base!;
      unknownLeft = o.unknownReads ?? 0;
      return http(200, {});
    }
    if (argv[0] !== "git") return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
    const g = argv.filter((x, i) => !(x === "-c" || argv[i - 1] === "-c")).slice(1).join(" ");
    git.push(g);
    if (g.startsWith("fetch ")) return ok("");
    if (g === "worktree list --porcelain") return ok(`worktree /repo\nHEAD h0\nbranch refs/heads/main\n\nworktree /wt-B\nHEAD shaB0\nbranch refs/heads/b${B}\n\n`);
    if (g === "rev-parse --verify --quiet refs/remotes/origin/main") return ok("trunk0\n");
    const remote = /^rev-parse --verify --quiet refs\/remotes\/origin\/b(\d+)$/.exec(g);
    if (remote) return ok(`${o.originMoved && Number(remote[1]) === B ? "otherB" : heads[Number(remote[1])]}\n`);
    if (g === `rev-parse --verify --quiet refs/heads/b${B}`) return o.divergedLocal ? ok("localonly\n") : no();
    if (g.startsWith("rev-parse --verify --quiet refs/heads/")) return no();
    if (g.startsWith("merge-base --is-ancestor")) return g.includes("localonly") ? no() : ok("");
    if (g.startsWith("worktree add --detach") || g.startsWith("worktree remove") || g === "worktree prune") return ok("");
    const co = /^checkout --detach (\S+)$/.exec(g);
    if (co) {
      checkedOut = co[1] === "shaB0" ? B : C;
      return ok("");
    }
    if (g.startsWith("rebase --no-autostash")) return ok("");
    // the rebased tip of the member that is checked out
    if (g === "rev-parse HEAD") return ok(`${checkedOut === B ? "shaB1" : "new203"}\n`);
    if (g.startsWith("push ")) {
      pushes.push(g);
      events.push("push");
      rebase();
      checkingLeft = o.checkingReads ?? 0;
      oldHeadLeft = o.oldHeadReads ?? 0;
      dirtyLeft = o.dirtyReads ?? 0;
      return ok("");
    }
    const ls = /^ls-remote origin refs\/heads\/b(\d+)$/.exec(g);
    if (ls) return ok(`${heads[Number(ls[1])]}\trefs/heads/b${ls[1]}\n`);
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  const ctx: Ctx = { exec, root: "/repo", slug: { owner: "o", name: "r" }, worktrees: [{ path: "/wt-B", branch: `b${B}`, head: "shaB0", bare: false }] };
  return { ctx, puts, pushes, git, events, rest };
}

const noSleep = { attempts: 3, delayMs: 0, sleep: async () => {} };

describe("stackMerge on a native stack", () => {
  test("forced squash with a review bypass on both PRs: A lands, B is rebased and retargeted, then B merges at its NEW head sha", async () => {
    clearRulesCache();
    const { ctx, puts, pushes, git, events, rest } = fakeGithub({ review: "required" });
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
    // GitHub does not retarget after a bypass merge and refuses a base change while stacked: push, unstack, PATCH base, and no re-create for a lone PR
    expect(events).toEqual(["merge 201", "push", "unstack", "base 202 main", "merge 202"]);
    expect(rest).toEqual(["unstack", "base 202 main"]);
    expect(r.results[1]!.detail).toContain("temporary checkout");
    expect(r.results[1]!.detail).toContain("unstacked, pointed #202 at main");
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
    const { ctx, puts, git, rest } = fakeGithub({ review: "approved" });
    const plans: PlanStep[][] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: false, upTo: B, onPlan: (p) => plans.push(p), replan: noSleep });
    expect(puts).toEqual([{ pr: B, sha: "shaB0", bypass: false, method: "squash" }]);
    expect(r.results[0]!.step).toMatchObject({ kind: "merge", pr: B, includes: [A, B] });
    expect(git).toEqual([]);
    expect(rest).toEqual([]);
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

  test("every remaining member is rebased in the temporary checkout and the rest of the stack is re-created, including a clean atomic group", async () => {
    clearRulesCache();
    // Initial plan: A bypass alone, then merge #203 includes=[B,203]; the rebase may reset reviews/checks and split that group.
    const { ctx, puts, pushes, git, events, rest } = fakeGithub({ review: "required", cleanGroup: true });
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: C, replan: noSleep });
    expect(r.merged).toEqual([A, B, C]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "new203"]);
    expect(pushes).toEqual(["push --atomic --force-with-lease=refs/heads/b202:shaB0 --force-with-lease=refs/heads/b203:sha203 origin shaB1:refs/heads/b202 new203:refs/heads/b203"]);
    expect(git).toContain("rebase --no-autostash --onto trunk0 shaA");
    expect(git).toContain("rebase --no-autostash --onto shaB1 shaB0");
    // two PRs remain, so the stack is re-created from them (bottom first) after the retarget
    expect(rest).toEqual(["unstack", "base 202 main", "create 202,203"]);
    expect(events).toEqual(["merge 201", "push", "unstack", "base 202 main", "create 202,203", "merge 203"]);
    expect(r.results.find((x) => x.step.kind === "rebase-stack")!.detail).toContain("re-created the stack (#202, #203 as stack 5)");
  });

  test("a member above the bottom that still shows as conflicting right after the re-link is re-read, not dropped from the plan", async () => {
    clearRulesCache();
    const { ctx, puts } = fakeGithub({ review: "required", cleanGroup: true, dirtyReads: 4 });
    const sleeps: number[] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: C, replan: { attempts: 6, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } });
    expect(sleeps.length).toBeGreaterThan(0);
    expect(r.merged).toEqual([A, B, C]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "new203"]);
  });

  test("a member that keeps showing as conflicting after the re-link stops the run with that reason instead of a silent partial merge", async () => {
    clearRulesCache();
    const { ctx, puts, events } = fakeGithub({ review: "required", cleanGroup: true, dirtyReads: 999 });
    const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: C, replan: noSleep }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("stack merge stopped at #203: GitHub still reports #203 as conflicting after the stack was re-linked");
    expect(err.message).toContain("even after closing and reopening #203");
    expect(puts.map((p) => p.pr)).toEqual([A]);
    // closed and reopened once, never twice
    expect(events.filter((e) => e.startsWith("close") || e.startsWith("reopen"))).toEqual(["close 203", "reopen 203"]);
  });

  test("a conflict flag that GitHub never recomputed (the head already contains its base) is cleared by closing and reopening the PR once, then the merge continues", async () => {
    clearRulesCache();
    const { ctx, puts, events } = fakeGithub({ review: "required", cleanGroup: true, dirtyReads: 999, reopenClearsDirty: true });
    const seen: StepResult[] = [];
    const plans: PlanStep[][] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: C, onStep: (s) => seen.push(s), onPlan: (p) => plans.push(p), replan: noSleep });
    expect(r.merged).toEqual([A, B, C]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "new203"]);
    expect(events).toEqual(["merge 201", "push", "unstack", "base 202 main", "create 202,203", "close 203", "reopen 203", "merge 203"]);
    const refresh = r.results.find((x) => x.step.kind === "refresh-mergeability")!;
    expect(refresh).toMatchObject({ ok: true, step: { kind: "refresh-mergeability", pr: C } });
    expect(refresh.detail).toContain("conflict flag on #203 was stale");
    expect(refresh.detail).toContain("closed and reopened #203");
    expect(seen).toContain(refresh);
    expect(plans.some((p) => p.some((s) => s.kind === "refresh-mergeability"))).toBe(true);
  });

  test("a conflicting member whose head is behind its base is a real conflict: stop without closing or reopening anything", async () => {
    clearRulesCache();
    const { ctx, puts, events } = fakeGithub({ review: "required", cleanGroup: true, dirtyReads: 999, behindBy: 2 });
    const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: C, replan: noSleep }).catch((e: Error) => e)) as Error;
    expect(err.message).toContain("stack merge stopped at #203: GitHub still reports #203 as conflicting after the stack was re-linked");
    expect(err.message).toContain("2 commits behind");
    expect(puts.map((p) => p.pr)).toEqual([A]);
    expect(events.some((e) => e.startsWith("close") || e.startsWith("reopen"))).toBe(false);
  });

  test("right after the push GitHub still computes mergeability: the re-plan waits instead of stopping", async () => {
    clearRulesCache();
    const { ctx, puts } = fakeGithub({ review: "required", checkingReads: 3 });
    const sleeps: number[] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 5, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } });
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "shaB1"]);
    expect(r.merged).toEqual([A, B]);
  });

  test("after the retarget REST mergeable_state is polled until it is no longer unknown", async () => {
    clearRulesCache();
    const { ctx, puts } = fakeGithub({ review: "required", unknownReads: 2 });
    const sleeps: number[] = [];
    const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 5, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } });
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.sha)).toEqual(["shaA", "shaB1"]);
    expect(r.merged).toEqual([A, B]);
  });

  describe("a merge without bypass: GitHub restacks the rest itself, stk only waits", () => {
    test("A (clean) lands, GitHub retargets B and rebases it, then B is bypass-merged at that head; nothing runs locally and the stack is not touched", async () => {
      clearRulesCache();
      const { ctx, puts, pushes, git, rest } = fakeGithub({ review: "required", reviewRequired: [B], githubRestacks: 2 });
      const sleeps: number[] = [];
      const r = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { delayMs: 7, restackWaitMs: 70, sleep: async (ms) => void sleeps.push(ms) } });
      expect(sleeps).toEqual([7, 7]);
      expect(puts).toEqual([
        { pr: A, sha: "shaA", bypass: false, method: "squash" },
        { pr: B, sha: "shaB1", bypass: true, method: "squash" },
      ]);
      expect(pushes).toEqual([]);
      expect(git).toEqual([]);
      expect(rest).toEqual([]);
      expect(r.results.map((x) => x.step.kind)).toEqual(["merge", "merge"]);
      expect(r.merged).toEqual([A, B]);
    });

    for (const checkingAs of ["mergeState", "mergeable"] as const) {
      test(`mergeability still computing after polling runs out stops with that reason instead of force-merging (${checkingAs} UNKNOWN)`, async () => {
        clearRulesCache();
        const { ctx, puts } = fakeGithub({ review: "required", reviewRequired: [B], githubRestacks: 99, githubHeadReads: 0, checkingAs });
        const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e);
        expect((err as Error).message).toBe("stack merge stopped at #202: GitHub is still checking it for conflicts after #201 landed; merge again once that settles");
        expect(puts.map((p) => p.pr)).toEqual([A]);
      });
    }

    /** A manual clock: sleeping advances it, so the wait is measured in elapsed time. */
    const clock = (extra: { delayMs: number; restackWaitMs: number }) => {
      let t = 0;
      const sleeps: number[] = [];
      return { sleeps, policy: { ...extra, now: () => t, sleep: async (ms: number) => { sleeps.push(ms); t += ms; } } };
    };

    test("a head that never changes times out with a clear message, the real waited time, and no local fallback", async () => {
      clearRulesCache();
      const { ctx, puts, pushes, git, rest } = fakeGithub({ review: "required", reviewRequired: [B], githubRestacks: 0, githubHeadReads: 999 });
      const { sleeps, policy } = clock({ delayMs: 1000, restackWaitMs: 3000 });
      const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: policy }).catch((e: Error) => e);
      expect((err as Error).message).toBe("stack merge stopped at #202: GitHub has not retargeted and rebased #202 onto main after #201 landed (waited 3s); merge again once it has, or run rebase-stack");
      expect(sleeps).toEqual([1000, 1000, 1000]);
      expect(puts.map((p) => p.pr)).toEqual([A]);
      expect(pushes).toEqual([]);
      expect(git).toEqual([]);
      expect(rest).toEqual([]);
    });

    test("the wait is a deadline, not a count of sleeps: the last sleep is cut to what is left", async () => {
      clearRulesCache();
      const { ctx } = fakeGithub({ review: "required", reviewRequired: [B], githubRestacks: 0, githubHeadReads: 999 });
      const { sleeps, policy } = clock({ delayMs: 1000, restackWaitMs: 2500 });
      const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: policy }).catch((e: Error) => e)) as Error;
      expect(sleeps).toEqual([1000, 1000, 500]);
      expect(err.message).toContain("(waited 3s)");
    });

    test("slow planning reads eat the deadline: reads that take time leave fewer sleeps", async () => {
      clearRulesCache();
      const { ctx } = fakeGithub({ review: "required", reviewRequired: [B], githubRestacks: 0, githubHeadReads: 999 });
      let t = 0;
      const sleeps: number[] = [];
      const slow: Ctx = { ...ctx, exec: async (argv, o) => { t += 400; return ctx.exec(argv, o); } };
      await stackMerge(slow, A, { method: "squash", force: true, upTo: B, replan: { delayMs: 1000, restackWaitMs: 3000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } } }).catch((e: Error) => e);
      // each read costs 400ms of the 3000ms, so fewer than three full sleeps fit
      expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThan(3000);
      expect(sleeps.length).toBeLessThanOrEqual(3);
    });

    test("a base that stays on the merged branch times out too, even once the head changed", async () => {
      clearRulesCache();
      const { ctx, puts, git, rest } = fakeGithub({ review: "required", reviewRequired: [B], githubRestacks: 0, githubNoRetarget: true });
      const { policy } = clock({ delayMs: 10, restackWaitMs: 50 });
      const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: policy }).catch((e: Error) => e);
      expect((err as Error).message).toContain("GitHub has not retargeted and rebased #202 onto main after #201 landed");
      expect(puts.map((p) => p.pr)).toEqual([A]);
      expect(git).toEqual([]);
      expect(rest).toEqual([]);
    });

    test("a merge-method stack has nothing to rewrite: once the wait is over a trunk base alone is enough", async () => {
      clearRulesCache();
      const { ctx, puts } = fakeGithub({ review: "required", reviewRequired: [B], githubRestacks: 0, githubKeepsHeads: true });
      const { sleeps, policy } = clock({ delayMs: 10, restackWaitMs: 30 });
      const r = await stackMerge(ctx, A, { method: "merge", force: true, upTo: B, replan: policy });
      expect(sleeps).toHaveLength(3);
      expect(puts.map((p) => `${p.pr}:${p.method}:${p.bypass}`)).toEqual(["201:merge:false", "202:merge:true"]);
      expect(r.merged).toEqual([A, B]);
    });

    test("a lone PR is only accepted as a plain PR after stk's own re-link: a stack that dissolves on its own stops the run", async () => {
      clearRulesCache();
      const { ctx, puts, pushes } = fakeGithub({ review: "required", dissolveOnBypass: true });
      const err = (await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: noSleep }).catch((e: Error) => e)) as Error;
      expect(err.message).toContain("native stack or trunk changed");
      expect(puts.map((p) => p.pr)).toEqual([A]);
      expect(pushes).toEqual([]);
    });
  });

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
    const { ctx, puts, pushes, rest } = fakeGithub({ review: "required", staleMerged: true });
    const sleeps: number[] = [];
    const err = await stackMerge(ctx, A, { method: "squash", force: true, upTo: B, replan: { attempts: 2, delayMs: 7, sleep: async (ms) => void sleeps.push(ms) } }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("GitHub still lists #201 as open after it merged");
    expect(sleeps).toEqual([7, 7]);
    expect(puts.map((p) => p.pr)).toEqual([A]);
    expect(pushes).toEqual([]);
    expect(rest).toEqual([]);
  });

  test("CLEAN snapshots with the old head after push are polled until the actual pushed SHA appears", async () => {
    clearRulesCache();
    const { ctx, puts } = fakeGithub({ review: "required", oldHeadReads: 3 });
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
