import { describe, expect, test } from "bun:test";
import { StkError, mergeOutcomeText, type Exec } from "../src/types";
import { jobStatusText } from "../src/jobs";
import { rebaseStack, stackInfo, type Ctx } from "../src/service";

const CHAIN = [101, 102, 103];
type Call = { argv: string[]; cwd?: string };

/**
 * Fake gh/git for a native stack whose #101 already merged (so #102's base is the merged branch b101). Origin heads are
 * `sha<n>`, the trunk is at `trunk0`, and rebasing in the temporary worktree yields `new<n>` for the member checked out.
 */
function fake(o: { rebase?: "ok" | "conflict" | "refuse"; localB102?: string; push?: "ok" | "reject"; wt?: boolean; restacked?: boolean; stackGrows?: boolean; unknownForever?: boolean; unstack?: "conflict" } = {}): { ctx: Ctx; calls: Call[]; git: () => string[]; rest: string[] } {
  const calls: Call[] = [];
  const rest: string[] = [];
  let unstacked = false;
  let retargeted = false;
  const member = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: n === 101 ? "MERGED" : "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: n === 101 ? "main" : `b${n - 1}`, headRefOid: `sha${n}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const no = (stderr = "") => ({ code: 1, stdout: "", stderr });
  let checkedOut = 0;
  let pushed = false;
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv: [...argv], ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    const a = argv.join(" ");
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const nodes = (pushed && o.stackGrows ? [...CHAIN, 104] : CHAIN).map((n, i) => ({ position: i + 1, pullRequest: member(n) }));
      const repository = { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 3 }, stack: { size: 3, entries: { nodes } } } };
      return ok(JSON.stringify({ data: { repository } }));
    }
    if (a.startsWith("gh repo view")) return ok(JSON.stringify({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } }));
    // the stack API: GitHub refuses a base change until the stack is dissolved
    const api = /^gh api -i (?:-X (\w+) )?repos\/o\/r\/(pulls\/(\d+)|stacks(?:\/\d+\/unstack)?)(?: |$)/.exec(a);
    if (api) {
      const http = (status: number, body: unknown) => ok(`HTTP/2.0 ${status} X\r\n\r\n${body === null ? "" : JSON.stringify(body)}`);
      const input = opts?.stdin ? (JSON.parse(opts.stdin) as { base?: string; pull_requests?: number[] }) : {};
      if (!api[1]) return http(200, { base: { ref: retargeted ? "main" : "b101" }, mergeable_state: o.unknownForever ? "unknown" : "clean", stack: unstacked ? null : { number: 7 }, merge_commit_sha: api[3] === "101" && o.restacked ? "mc101" : null });
      if (api[1] === "POST" && api[2]!.endsWith("/unstack")) {
        if (o.unstack === "conflict") return http(409, { message: "stack is being modified" });
        rest.push("unstack");
        unstacked = true;
        return http(200, {});
      }
      if (api[1] === "POST") {
        rest.push(`create ${input.pull_requests!.join(",")}`);
        return http(201, { number: 8, pull_requests: input.pull_requests });
      }
      if (!unstacked) return http(422, { message: "Cannot change the base branch because the pull request is part of a stack." });
      rest.push(`base ${api[3]} ${input.base}`);
      retargeted = true;
      return http(200, {});
    }
    if (argv[0] !== "git") return no(`unexpected: ${a}`);
    const g = argv.filter((x, i) => !(x === "-c" || argv[i - 1] === "-c")).slice(1).join(" ");
    if (g.startsWith("fetch ")) return ok();
    if (g.startsWith("cat-file -e ")) return ok();
    if (g === "worktree list --porcelain") {
      return ok(`worktree /repo\nHEAD h0\nbranch refs/heads/main\n\n${o.wt === false ? "" : "worktree /wt-102\nHEAD sha102\nbranch refs/heads/b102\n\n"}`);
    }
    if (g === "rev-parse --verify --quiet refs/remotes/origin/main") return ok("trunk0\n");
    const remote = /^rev-parse --verify --quiet refs\/remotes\/origin\/b(\d+)$/.exec(g);
    if (remote) return ok(`sha${remote[1]}\n`);
    if (g === "rev-parse --verify --quiet refs/heads/b102") return o.localB102 ? ok(`${o.localB102}\n`) : no();
    if (g.startsWith("rev-parse --verify --quiet refs/heads/")) return no();
    if (g.startsWith("merge-base --is-ancestor")) return g.includes("localonly") ? no() : ok("");
    if (g.startsWith("worktree add --detach")) return ok();
    const co = /^checkout --detach sha(\d+)$/.exec(g);
    if (co) {
      checkedOut = Number(co[1]);
      return ok();
    }
    if (g.startsWith("rebase --no-autostash")) {
      if (o.rebase === "conflict") return no("CONFLICT in a.ts");
      if (o.rebase === "refuse") return no("fatal: bad revision");
      return ok();
    }
    if (g === "diff --name-only --diff-filter=U") return ok("a.ts\nb.ts\n");
    if (g === "rebase --abort") return ok();
    if (g === "rev-parse HEAD") return ok(`new${checkedOut}\n`);
    if (g.startsWith("push ")) {
      if (o.push === "reject") return no("! [rejected] (stale info)");
      pushed = true;
      return ok();
    }
    const ls = /^ls-remote origin refs\/heads\/b(\d+)$/.exec(g);
    if (ls) return ok(`${pushed ? "new" : "sha"}${ls[1]}\trefs/heads/b${ls[1]}\n`);
    if (g.startsWith("worktree remove") || g === "worktree prune") return ok();
    return no(`unexpected: ${a}`);
  };
  const ctx: Ctx = { exec, root: "/repo", slug: { owner: "o", name: "r" }, worktrees: [{ path: "/wt-102", branch: "b102", head: "sha102", bare: false }] };
  return { ctx, calls, rest, git: () => calls.filter((c) => c.argv[0] === "git").map((c) => c.argv.slice(1).filter((x, i, all) => !(x === "-c" || all[i - 1] === "-c")).join(" ")) };
}

/** The temporary worktree path the run created. */
const tmpOf = (calls: Call[]) => {
  const add = calls.find((c) => c.argv.includes("worktree") && c.argv.includes("--detach") && c.argv.includes("add"))!;
  return add.argv[add.argv.indexOf("--detach") + 1]!;
};

describe("rebaseStack", () => {
  test("rebases every open member bottom-up in a temporary worktree and pushes once, atomically with leases", async () => {
    const { ctx, calls, git } = fake();
    const steps: string[] = [];
    const r = await rebaseStack(ctx, 102, { onStep: (s) => steps.push(s) });
    expect(r.prs).toEqual([102, 103]);
    expect(r.heads).toEqual({ 102: "new102", 103: "new103" });
    expect(steps).toEqual(["fetching", "rebasing #102", "rebasing #103", "pushing", "unstacked, pointed #102 at main and re-created the stack (#102, #103 as stack 8)"]);
    const tmp = tmpOf(calls);
    expect(git()).toEqual([
      "fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main +refs/heads/b102:refs/remotes/origin/b102 +refs/heads/b103:refs/remotes/origin/b103",
      "worktree list --porcelain",
      "rev-parse --verify --quiet refs/remotes/origin/b102",
      "merge-base --is-ancestor sha101 sha102",
      "rev-parse --verify --quiet refs/heads/b102",
      "rev-parse --verify --quiet refs/remotes/origin/b103",
      "merge-base --is-ancestor sha102 sha103",
      "rev-parse --verify --quiet refs/heads/b103",
      "rev-parse --verify --quiet refs/remotes/origin/main",
      `worktree add --detach ${tmp} trunk0`,
      "checkout --detach sha102",
      // the merged #101's head is where #102's own commits start; #103 then sits on #102's old head and goes on its new tip
      "rebase --no-autostash --onto trunk0 sha101",
      "rev-parse HEAD",
      "checkout --detach sha103",
      "rebase --no-autostash --onto new102 sha102",
      "rev-parse HEAD",
      "push --atomic --force-with-lease=refs/heads/b102:sha102 --force-with-lease=refs/heads/b103:sha103 origin new102:refs/heads/b102 new103:refs/heads/b103",
      `worktree remove --force ${tmp}`,
      "worktree prune",
      "ls-remote origin refs/heads/b102",
      "ls-remote origin refs/heads/b103",
      "worktree list --porcelain",
    ]);
  });

  test("a stack left on a merged branch is also re-linked: unstack, retarget, re-create, in that order and after the push", async () => {
    const { ctx, calls, rest } = fake();
    const r = await rebaseStack(ctx, 102);
    expect(rest).toEqual(["unstack", "base 102 main", "create 102,103"]);
    expect(r.relinked).toBe("unstacked, pointed #102 at main and re-created the stack (#102, #103 as stack 8)");
    const order = calls.map((c) => c.argv.join(" ")).filter((s) => s.includes("push --atomic") || s.includes("unstack") || s.includes("PATCH") || /-X POST \S+\/stacks /.test(s));
    expect(order.map((s) => (s.includes("push") ? "push" : s.includes("unstack") ? "unstack" : s.includes("PATCH") ? "patch" : "create"))).toEqual(["push", "unstack", "patch", "create"]);
    expect(calls.some((c) => c.argv.some((x) => x.includes("DELETE") || x.includes("git/refs")))).toBe(false);
  });

  test("resumable: a bottom PR that already contains its parent's merge commit is not rebased again, only re-linked", async () => {
    const { ctx, git, rest } = fake({ restacked: true });
    const steps: string[] = [];
    const r = await rebaseStack(ctx, 102, { onStep: (s) => steps.push(s) });
    expect(git()).toContain("merge-base --is-ancestor mc101 sha102");
    expect(git().some((c) => c.startsWith("worktree add") || c.startsWith("push") || c.startsWith("rebase"))).toBe(false);
    expect(steps[0]).toBe("#102 is already rebased onto the merge of #101; only re-linking");
    expect(rest).toEqual(["unstack", "base 102 main", "create 102,103"]);
    expect(r.heads).toEqual({ 102: "sha102", 103: "sha103" });
  });

  test("a failed unstack leaves the branches rewritten and says so; nothing is retargeted", async () => {
    const { ctx, rest } = fake({ unstack: "conflict" });
    const e = (await rebaseStack(ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.message).toContain("GitHub is modifying stack 7");
    expect(rest).toEqual([]);
  });

  test("a PR added to the stack while it was rebased stops before anything is unstacked", async () => {
    const { ctx, rest } = fake({ stackGrows: true });
    const e = (await rebaseStack(ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.message).toBe("the stack changed while it was rebased (rebased #102, #103, now #102, #103, #104); nothing was unstacked, review it and run rebase-stack again");
    expect(rest).toEqual([]);
  });

  test("mergeability that stays unknown after the re-link is reported, naming the PR, not treated as settled", async () => {
    const { ctx, rest } = fake({ unknownForever: true });
    const e = (await rebaseStack(ctx, 102, { replan: { attempts: 2, delayMs: 5, sleep: async () => {} } }).catch((x: unknown) => x)) as StkError;
    expect(e.message).toContain("re-linked onto main, but GitHub is still computing whether #102 can merge");
    expect(rest).toEqual(["unstack", "base 102 main", "create 102,103"]);
  });

  test("every mutating git call pins config so the user's settings cannot change it", async () => {
    const { ctx, calls } = fake();
    await rebaseStack(ctx, 102);
    const sub = (argv: string[]) => argv.filter((x, i) => !(x === "-c" || argv[i - 1] === "-c"))[1] ?? "";
    const mutating = calls.filter((c) => c.argv[0] === "git" && ["checkout", "rebase", "push"].includes(sub(c.argv)) || (sub(c.argv) === "worktree" && c.argv.includes("add")));
    expect(mutating.length).toBeGreaterThanOrEqual(5);
    for (const c of mutating) {
      for (const cfg of ["core.hooksPath=/dev/null", "rebase.updateRefs=false", "rebase.autoSquash=false", "rebase.autoStash=false", "commit.gpgSign=false"]) {
        expect(c.argv).toContain(cfg);
      }
    }
  });

  test("never calls gh stack and never runs anything in a user worktree", async () => {
    const { ctx, calls } = fake();
    await rebaseStack(ctx, 102);
    expect(calls.some((c) => c.argv[0] === "gh" && c.argv[1] === "stack")).toBe(false);
    const tmp = tmpOf(calls);
    const cwds = new Set(calls.filter((c) => c.argv[0] === "git").map((c) => c.cwd));
    expect([...cwds].sort()).toEqual(["/repo", tmp].sort());
    // the rebase itself runs only in the temporary worktree
    expect(calls.filter((c) => c.argv.includes("rebase") || c.argv.includes("checkout")).every((c) => c.cwd === tmp)).toBe(true);
  });

  test("the user's local checkout of a rebased branch is reported as behind, not touched", async () => {
    const { ctx } = fake();
    const r = await rebaseStack(ctx, 102);
    expect(r.note).toContain("/wt-102 (b102)");
    expect(r.note).toContain("left untouched");
    const none = fake({ wt: false });
    expect((await rebaseStack(none.ctx, 102)).note).toBeUndefined();
  });

  test("a conflict aborts the rebase, removes the temporary worktree and never pushes", async () => {
    const { ctx, calls, git } = fake({ rebase: "conflict" });
    const e = (await rebaseStack(ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("rebase-conflict");
    expect(e.message).toContain("#102");
    expect(e.message).toContain("b102");
    expect(e.message).toContain("a.ts, b.ts");
    const tmp = tmpOf(calls);
    const g = git();
    expect(g.some((c) => c.startsWith("push"))).toBe(false);
    expect(g.slice(-4)).toEqual(["diff --name-only --diff-filter=U", "rebase --abort", `worktree remove --force ${tmp}`, "worktree prune"]);
    expect(calls.find((c) => c.argv.includes("--abort"))!.cwd).toBe(tmp);
  });

  test("a failed rebase without conflicted files is a git failure, still aborted and cleaned up", async () => {
    const f = fake({ rebase: "refuse" });
    const orig = f.ctx.exec;
    f.ctx.exec = async (argv, opts) => (argv.join(" ").includes("diff --name-only") ? { code: 0, stdout: "", stderr: "" } : orig(argv, opts));
    const e = (await rebaseStack(f.ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("git-failed");
    expect(e.message).toContain("fatal: bad revision");
    expect(f.git()).toContain("rebase --abort");
    expect(f.git().some((c) => c.startsWith("push"))).toBe(false);
    expect(f.git().at(-1)).toBe("worktree prune");
  });

  test("unpushed local commits are refused as diverged before any worktree is created", async () => {
    const { ctx, git } = fake({ localB102: "localonly" });
    const e = (await rebaseStack(ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("diverged");
    expect(e.message).toContain("/wt-102");
    expect(e.message).toContain("b102");
    const g = git();
    expect(g.some((c) => c.startsWith("worktree add"))).toBe(false);
    expect(g.some((c) => c.startsWith("push"))).toBe(false);
    expect(g).toContain("merge-base --is-ancestor localonly sha102");
  });

  test("a rejected lease push surfaces as lease-rejected and the temporary worktree is still removed", async () => {
    const { ctx, git, calls } = fake({ push: "reject" });
    const e = (await rebaseStack(ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("lease-rejected");
    expect(git().slice(-2)).toEqual([`worktree remove --force ${tmpOf(calls)}`, "worktree prune"]);
  });

  test("a PR that is not an open member is refused before any git call", async () => {
    const { ctx, git } = fake();
    const e = (await rebaseStack(ctx, 101).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("usage");
    expect(git()).toEqual([]);
  });

  test("the plan flags the stale base with the rebase action", async () => {
    const { ctx } = fake();
    const info = await stackInfo(ctx, 103, { method: "squash", force: false, upTo: "top" });
    expect(info.notes).toEqual([
      expect.objectContaining({
        pr: 102,
        action: "rebase-stack",
        fix: "GitHub did not retarget it and refuses a base change while it is stacked; stk's rebase-stack rebases it onto main, unstacks, points it at main and re-creates the stack.",
      }),
    ]);
  });
});

describe("rebase-stack job text", () => {
  const job = { kind: "rebase-stack" as const, pr: 102, prs: [102, 103] };
  test("done and running texts", () => {
    expect(mergeOutcomeText(job)).toBe("Stack rebased · #102, #103");
    const running = { ...job, id: "j", repo: { owner: "o", name: "r" }, method: "squash" as const, force: false, status: "running" as const, steps: [], pid: 1, startedAt: 0, updatedAt: 0, progress: { pr: 102, phase: "pending" as const, message: "rebasing" } };
    expect(jobStatusText(running)).toBe("rebasing stack #102… · rebasing");
  });
  test("a note about left-behind checkouts is appended", () => {
    expect(mergeOutcomeText({ ...job, note: "local checkouts now behind origin" })).toBe("Stack rebased · #102, #103 · local checkouts now behind origin");
  });
});
