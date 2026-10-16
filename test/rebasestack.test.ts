import { describe, expect, test } from "bun:test";
import { StkError, mergeOutcomeText, type Exec } from "../src/types";
import { jobStatusText } from "../src/jobs";
import { rebaseStack, stackInfo, type Ctx } from "../src/service";

const CHAIN = [101, 102, 103];

/** Fake gh/git for a native stack whose #101 already merged (so #102's base is the merged branch b101). */
function fake(o: { ext?: boolean; rebase?: "ok" | "conflict" | "refuse"; dirty?: boolean; popFails?: boolean; wt?: "branch" | "detached" | "stale" | "none" } = {}): { ctx: Ctx; calls: { argv: string[]; cwd?: string }[] } {
  const calls: { argv: string[]; cwd?: string }[] = [];
  const member = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: n === 101 ? "MERGED" : "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: n === 101 ? "main" : `b${n - 1}`, headRefOid: `sha${n}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const kind = o.wt ?? "branch";
  const wtBlock = kind === "none" ? "" : kind === "branch" ? "worktree /wt-102\nHEAD sha102\nbranch refs/heads/b102\n\n" : `worktree /wt-102\nHEAD ${kind === "stale" ? "old000" : "sha102"}\ndetached\n\n`;
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv: [...argv], ...(opts?.cwd ? { cwd: opts.cwd } : {}) });
    const a = argv.join(" ");
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const nodes = CHAIN.map((n, i) => ({ position: i + 1, pullRequest: member(n) }));
      const repository = { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 3 }, stack: { size: 3, entries: { nodes } } } };
      return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
    }
    if (a.startsWith("gh repo view")) return { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } }), stderr: "" };
    if (a === "gh stack --version") return o.ext === false ? { code: 1, stdout: "", stderr: "unknown command" } : { code: 0, stdout: "gh stack 0.2.1", stderr: "" };
    if (a === "git worktree list --porcelain") return { code: 0, stdout: `worktree /repo\nHEAD h0\nbranch refs/heads/main\n\n${wtBlock}`, stderr: "" };
    if (a === "git rev-parse --verify --quiet refs/heads/b102") return { code: 1, stdout: "", stderr: "" };
    if (a.startsWith("git switch") || a.startsWith("git branch --set-upstream-to")) return { code: 0, stdout: "", stderr: "" };
    if (a === "git status --porcelain") return { code: 0, stdout: o.dirty ? " M bun.lock\n?? notes.txt\n" : "", stderr: "" };
    if (a.startsWith("git stash push")) return { code: 0, stdout: "", stderr: "" };
    if (a === "git rev-parse stash@{0}") return { code: 0, stdout: "deadbeef\n", stderr: "" };
    if (a.startsWith("git stash list")) return { code: 0, stdout: "cafe0000 stash@{1}\ndeadbeef stash@{0}\n", stderr: "" };
    if (a === "git stash apply --index deadbeef") return o.popFails ? { code: 1, stdout: "", stderr: "CONFLICT (content)" } : { code: 0, stdout: "", stderr: "" };
    if (a === "git stash drop stash@{0}") return { code: 0, stdout: "", stderr: "" };
    if (a === "gh stack rebase") return o.rebase === "conflict" ? { code: 1, stdout: "", stderr: "CONFLICT in a.ts" } : o.rebase === "refuse" ? { code: 1, stdout: "", stderr: "✗ some other failure" } : { code: 0, stdout: "", stderr: "" };
    if (a.startsWith("gh stack ")) return { code: 0, stdout: "", stderr: "" };
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  const ctx: Ctx = {
    exec,
    root: "/repo",
    slug: { owner: "o", name: "r" },
    worktrees: kind === "none" ? [] : [{ path: "/wt-102", branch: kind === "branch" ? "b102" : null, head: kind === "stale" ? "old000" : "sha102", bare: false }],
  };
  return { ctx, calls };
}

const ghStack = (calls: { argv: string[]; cwd?: string }[]) => calls.filter((c) => c.argv[1] === "stack").map((c) => `${c.argv.slice(2).join(" ")}@${c.cwd}`);
/** gh stack and git stash calls in the order they ran. */
const ops = (calls: { argv: string[]; cwd?: string }[]) =>
  calls.filter((c) => c.argv[1] === "stack" || c.argv[1] === "stash").map((c) => `${c.argv.slice(c.argv[0] === "gh" ? 2 : 1, c.argv[0] === "gh" ? undefined : 3).join(" ")}@${c.cwd}`);

describe("rebaseStack", () => {
  test("checks the stack out, rebases and pushes in the worktree of the PR's branch", async () => {
    const { ctx, calls } = fake();
    const steps: string[] = [];
    const r = await rebaseStack(ctx, 102, { onStep: (s) => steps.push(s) });
    expect(r.prs).toEqual([102, 103]);
    expect(ghStack(calls)).toEqual(["--version@/repo", "checkout 102@/wt-102", "rebase@/wt-102", "push@/wt-102"]);
    expect(steps).toEqual(["tracking the stack", "rebasing", "pushing"]);
  });

  test("a missing gh-stack extension names the install command and runs nothing else", async () => {
    const { ctx, calls } = fake({ ext: false });
    const e = (await rebaseStack(ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.message).toContain("gh extension install github/gh-stack");
    expect(ghStack(calls)).toEqual(["--version@/repo"]);
  });

  test("a conflict aborts the rebase and never pushes", async () => {
    const { ctx, calls } = fake({ rebase: "conflict" });
    const e = (await rebaseStack(ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("rebase-conflict");
    expect(ghStack(calls)).toEqual(["--version@/repo", "checkout 102@/wt-102", "rebase@/wt-102", "rebase --abort@/wt-102"]);
  });

  test("preflight: dirty worktrees fail fast with their files, before any gh stack call beyond the version check", async () => {
    const f = fake({ dirty: true });
    const e = (await rebaseStack(f.ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("dirty-worktree");
    expect(e.message).toBe("Rebase stack didn't start: /wt-102 has uncommitted changes (bun.lock, notes.txt)");
    expect(e.data).toEqual({ worktrees: [{ path: "/wt-102", files: ["bun.lock", "notes.txt"] }] });
    expect(ghStack(f.calls)).toEqual(["--version@/repo"]);
  });

  test("a PR with no worktree is refused", async () => {
    const none = fake();
    expect(((await rebaseStack(none.ctx, 103).catch((x: unknown) => x)) as StkError).message).toContain("no worktree has #103");
  });

  test("no worktree at all fails with a no-worktree error naming the PR and branch, before any gh stack call beyond the version check", async () => {
    const f = fake({ wt: "none" });
    const e = (await rebaseStack(f.ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("no-worktree");
    expect(e.message).toBe("no worktree has #102's branch (b102) checked out; open one with: stk worktree 102");
    expect(e.data).toEqual({ worktrees: [{ pr: 102, branch: "b102" }] });
    expect(ghStack(f.calls)).toEqual(["--version@/repo"]);
  });

  test("a worktree detached at the branch tip is switched to the branch, then used", async () => {
    const f = fake({ wt: "detached" });
    await rebaseStack(f.ctx, 102);
    const git = f.calls.filter((c) => c.argv[1] === "switch").map((c) => `${c.argv.slice(1).join(" ")}@${c.cwd}`);
    expect(git).toEqual(["switch -c b102@/wt-102"]);
    expect(ghStack(f.calls)).toEqual(["--version@/repo", "checkout 102@/wt-102", "rebase@/wt-102", "push@/wt-102"]);
    // the branch is attached before gh stack touches anything
    const order = f.calls.map((c) => c.argv.slice(0, 3).join(" "));
    expect(order.indexOf("git switch -c")).toBeLessThan(order.indexOf("gh stack checkout"));
  });

  test("a worktree detached at some other commit is not the branch", async () => {
    const f = fake({ wt: "stale" });
    const e = (await rebaseStack(f.ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("no-worktree");
    expect(f.calls.some((c) => c.argv[1] === "switch")).toBe(false);
  });

  test("stackInfo says where the rebase would run: the branch's worktree, a detached one, or none", async () => {
    const where = async (wt: "branch" | "detached" | "none") => (await stackInfo(fake({ wt }).ctx, 103, { method: "squash", force: false })).rebaseWorktrees;
    expect(await where("branch")).toEqual([{ pr: 102, branch: "b102", kind: "branch", path: "/wt-102" }]);
    expect(await where("detached")).toEqual([{ pr: 102, branch: "b102", kind: "detached", path: "/wt-102" }]);
    expect(await where("none")).toEqual([{ pr: 102, branch: "b102", kind: "none" }]);
  });

  test("stash: dirty worktrees are stashed first, then rebased and pushed, then restored", async () => {
    const f = fake({ dirty: true });
    await rebaseStack(f.ctx, 102, { stash: true, label: "j1" });
    expect(ops(f.calls)).toEqual([
      "--version@/repo",
      "stash push@/wt-102",
      "checkout 102@/wt-102",
      "rebase@/wt-102",
      "push@/wt-102",
      "stash apply@/wt-102",
      "stash list@/wt-102",
      "stash drop@/wt-102",
    ]);
    expect(f.calls.find((c) => c.argv[1] === "stash" && c.argv[2] === "push")?.argv).toEqual(["git", "stash", "push", "-u", "-m", "stk rebase-stack j1 /wt-102"]);
  });

  test("stash: changes are restored even when the rebase conflicts", async () => {
    const f = fake({ dirty: true, rebase: "conflict" });
    const e = (await rebaseStack(f.ctx, 102, { stash: true, label: "j1" }).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("rebase-conflict");
    expect(ops(f.calls).slice(-4)).toEqual(["rebase --abort@/wt-102", "stash apply@/wt-102", "stash list@/wt-102", "stash drop@/wt-102"]);
  });

  test("stash: a pop that conflicts leaves the stash and names it", async () => {
    const f = fake({ dirty: true, popFails: true });
    const e = (await rebaseStack(f.ctx, 102, { stash: true, label: "j1" }).catch((x: unknown) => x)) as StkError;
    expect(e.message).toContain("/wt-102 (stash deadbeef, kept in git stash)");
    expect(ops(f.calls)).not.toContain("stash drop@/wt-102");
  });

  test("only a real conflict is reported as one; other gh failures pass through", async () => {
    const f = fake({ rebase: "refuse" });
    const e = (await rebaseStack(f.ctx, 102).catch((x: unknown) => x)) as StkError;
    expect(e.code).toBe("gh-failed");
    expect(e.message).toBe("Rebase stack failed: some other failure");
    expect(ghStack(f.calls)).not.toContain("rebase --abort@/wt-102");
  });

  test("the plan flags the stale base with the rebase action", async () => {
    const { ctx } = fake();
    const info = await stackInfo(ctx, 103, { method: "squash", force: false, upTo: "top" });
    expect(info.notes).toEqual([expect.objectContaining({ pr: 102, action: "rebase-stack" })]);
  });
});

describe("rebase-stack job text", () => {
  const job = { kind: "rebase-stack" as const, pr: 102, prs: [102, 103] };
  test("done and running texts", () => {
    expect(mergeOutcomeText(job)).toBe("Stack rebased · #102, #103");
    const running = { ...job, id: "j", repo: { owner: "o", name: "r" }, method: "squash" as const, force: false, status: "running" as const, steps: [], pid: 1, startedAt: 0, updatedAt: 0, progress: { pr: 102, phase: "pending" as const, message: "rebasing" } };
    expect(jobStatusText(running)).toBe("rebasing stack #102… · rebasing");
  });
});
