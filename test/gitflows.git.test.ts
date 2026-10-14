import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec } from "../src/exec";
import { clearRulesCache, createPullRequest, planCreatePr, planStackSubmit, rerunRequired, stackSubmit, describeSubmitEntry, type Ctx } from "../src/service";
import { StkError, type Exec } from "../src/types";

setDefaultTimeout(60_000);

let base: string;
let repo: string;
let origin: string;

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = async (cwd: string, file: string, msg: string) => {
  writeFileSync(join(cwd, file), `${msg}\n`);
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-qm", msg);
};

interface FakePr { number: number; head: string; base: string }
interface Gh {
  prs: FakePr[];
  created: { argv: string[]; stdin?: string }[];
  calls: string[];
  /** Body of `POST /stacks`. */
  stacks: number[][];
  checkRuns: unknown[];
}

/** git is real; gh is a small in-memory GitHub of PRs. */
function world(initial: FakePr[] = []) {
  const gh: Gh = { prs: [...initial], created: [], calls: [], stacks: [], checkRuns: [] };
  const ghExec = async (argv: readonly string[], stdin?: string) => {
    const a = argv.join(" ");
    gh.calls.push(a);
    const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
    if (a.startsWith("gh repo view") && a.includes("defaultBranchRef")) return ok({ defaultBranchRef: { name: "main" } });
    if (a.startsWith("gh repo view")) return ok({ owner: { login: "o" }, name: "r" });
    if (a.startsWith("gh pr list")) return ok(gh.prs.map((p) => ({ number: p.number, headRefName: p.head, baseRefName: p.base })));
    if (a.startsWith("gh pr create")) {
      gh.created.push({ argv: [...argv], ...(stdin !== undefined ? { stdin } : {}) });
      const at = (f: string) => argv[argv.indexOf(f) + 1]!;
      const number = 100 + gh.prs.length;
      gh.prs.push({ number, head: at("--head"), base: at("--base") });
      return { code: 0, stdout: `https://github.com/o/r/pull/${number}\n`, stderr: "" };
    }
    if (a.startsWith("gh pr edit")) {
      const p = gh.prs.find((x) => x.number === Number(argv[3]))!;
      p.base = argv[argv.indexOf("--base") + 1]!;
      return { code: 0, stdout: "", stderr: "" };
    }
    const q = argv.find((x) => x.startsWith("query="));
    if (q) {
      const repository: Record<string, unknown> = {};
      for (const m of q.matchAll(/pr(\d+): pullRequest/g)) {
        const p = gh.prs.find((x) => x.number === Number(m[1]))!;
        repository[`pr${m[1]}`] = { number: p.number, title: "t", url: "", author: { login: "me" }, state: "OPEN", isDraft: false, headRefName: p.head, baseRefName: p.base, headRefOid: "s", mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] } };
      }
      return ok({ data: { repository } });
    }
    if (a.includes("repos/o/r/stacks")) {
      gh.stacks.push((JSON.parse(stdin ?? "{}") as { pull_requests: number[] }).pull_requests);
      return { code: 0, stdout: `HTTP/2.0 201 X\r\n\r\n${JSON.stringify({ number: 9, pull_requests: gh.stacks.at(-1)!.map(() => ({})) })}`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${a}` };
  };
  const exec: Exec = (argv, opts) => (argv[0] === "gh" ? ghExec(argv, opts?.stdin) : realExec(argv, opts));
  const ctx: Ctx = { exec, root: repo, worktrees: [] };
  return { gh, ctx };
}

beforeEach(async () => {
  clearRulesCache();
  base = realpathSync(mkdtempSync(join(tmpdir(), "stk-flows-")));
  repo = join(base, "repo");
  origin = join(base, "origin.git");
  await realExec(["git", "init", "-q", "--bare", "-b", "main", origin]);
  await realExec(["git", "init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  await git(repo, "remote", "add", "origin", origin);
  await commit(repo, "init.txt", "init");
  await git(repo, "push", "-q", "-u", "origin", "main");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

/** main <- a (2 commits) <- b (1) <- c (1), all local. */
async function chain() {
  await git(repo, "checkout", "-q", "-b", "a");
  await commit(repo, "a1.txt", "feat: a one");
  await commit(repo, "a2.txt", "feat: a two");
  await git(repo, "checkout", "-q", "-b", "b");
  await commit(repo, "b1.txt", "feat: b one");
  await git(repo, "checkout", "-q", "-b", "c");
  await commit(repo, "c1.txt", "feat: c one");
}

describe("planCreatePr / createPullRequest", () => {
  test("a branch cut from trunk: base trunk, title = first subject, body = bullets", async () => {
    await git(repo, "checkout", "-q", "-b", "solo");
    await commit(repo, "s1.txt", "fix: first");
    await commit(repo, "s2.txt", "fix: second");
    const { ctx } = world();
    const plan = await planCreatePr(ctx);
    expect(plan).toMatchObject({ branch: "solo", base: "main", baseIsPr: null, title: "fix: first", body: "- fix: first\n- fix: second", push: "new", draft: false });
  });

  test("stack-aware: cut from a branch with an open PR targets that branch", async () => {
    await chain();
    const { ctx } = world([{ number: 5, head: "a", base: "main" }]);
    const plan = await planCreatePr(ctx, { branch: "b" });
    expect(plan).toMatchObject({ branch: "b", base: "a", baseIsPr: 5, commits: ["feat: b one"] });
    // c is cut from b, which has no PR (nearest *PR* branch is a, so the commits since a are listed)
    expect((await planCreatePr(ctx, { branch: "c" })).base).toBe("a");
  });

  test("a parent branch without an open PR is not a base", async () => {
    await chain();
    const { ctx } = world();
    expect((await planCreatePr(ctx, { branch: "b" })).base).toBe("main");
  });

  test("falls back to the branch name when no commit is ahead is an error; trunk and existing PRs are refused", async () => {
    await git(repo, "checkout", "-q", "-b", "empty");
    const { ctx } = world([{ number: 3, head: "other", base: "main" }]);
    expect(((await planCreatePr(ctx).catch((x: unknown) => x)) as StkError).message).toBe("empty has no commits ahead of main");
    await git(repo, "checkout", "-q", "main");
    expect(((await planCreatePr(ctx).catch((x: unknown) => x)) as StkError).message).toContain("is the trunk");
    expect(((await planCreatePr(ctx, { branch: "other" }).catch((x: unknown) => x)) as StkError).message).toBe("other already has PR #3");
  });

  test("pushes the branch, then gh pr create with title, base, draft and the body on stdin", async () => {
    await git(repo, "checkout", "-q", "-b", "solo");
    await commit(repo, "s1.txt", "fix: first");
    const { ctx, gh } = world();
    const plan = await planCreatePr(ctx, { draft: true });
    const r = await createPullRequest(ctx, { ...plan, title: "Edited title" });
    expect(r).toMatchObject({ number: 100, url: "https://github.com/o/r/pull/100", branch: "solo", base: "main" });
    expect(gh.created[0]!.argv).toEqual(["gh", "pr", "create", "--head", "solo", "--base", "main", "--title", "Edited title", "--body-file", "-", "--draft"]);
    expect(gh.created[0]!.stdin).toBe("- fix: first");
    expect(await git(repo, "ls-remote", "origin", "refs/heads/solo")).toContain("refs/heads/solo");
    expect(await git(repo, "rev-parse", "solo@{upstream}")).toBe(await git(repo, "rev-parse", "solo"));
  });

  test("an already pushed branch is not pushed again; a diverged one is refused", async () => {
    await git(repo, "checkout", "-q", "-b", "solo");
    await commit(repo, "s1.txt", "fix: first");
    await git(repo, "push", "-q", "origin", "solo");
    const { ctx } = world();
    expect((await planCreatePr(ctx)).push).toBe("none");
    await commit(repo, "s2.txt", "fix: second");
    expect((await planCreatePr(ctx)).push).toBe("update");
    await git(repo, "reset", "-q", "--hard", "main");
    await commit(repo, "other.txt", "diverge");
    expect(((await planCreatePr(ctx).catch((x: unknown) => x)) as StkError).code).toBe("diverged");
  });
});

describe("planStackSubmit / stackSubmit", () => {
  test("detects the chain by ancestry, bottom first, with bases", async () => {
    await chain();
    const { ctx } = world();
    const plan = await planStackSubmit(ctx);
    expect(plan.entries.map((e) => [e.branch, e.base, e.pr, e.push, e.commits.length])).toEqual([
      ["a", "main", null, "new", 2],
      ["b", "a", null, "new", 1],
      ["c", "b", null, "new", 1],
    ]);
    expect(plan.entries[1]!.title).toBe("feat: b one");
    expect(describeSubmitEntry(plan.entries[0]!)).toBe("new a → main (push): feat: a one");
  });

  test("existing PRs are kept; one targeting the wrong branch is flagged for retarget", async () => {
    await chain();
    const { ctx } = world([{ number: 5, head: "a", base: "main" }, { number: 6, head: "b", base: "old-base" }]);
    const plan = await planStackSubmit(ctx);
    expect(plan.entries.map((e) => [e.branch, e.base, e.pr, e.retargetFrom, e.push])).toEqual([
      ["a", "main", 5, null, "none"],
      ["b", "a", 6, "old-base", "none"],
      ["c", "b", null, null, "new"],
    ]);
    expect(describeSubmitEntry(plan.entries[1]!)).toBe("#6 b (retarget old-base → a)");
  });

  test("a branch cut straight from trunk has no chain", async () => {
    await git(repo, "checkout", "-q", "-b", "solo");
    await commit(repo, "s1.txt", "x");
    const { ctx } = world();
    expect(((await planStackSubmit(ctx).catch((x: unknown) => x)) as StkError).message).toContain("no chain to stack");
  });

  test("a merged branch under the chain is not part of it", async () => {
    await chain();
    await git(repo, "checkout", "-q", "main");
    await git(repo, "merge", "-q", "--ff-only", "a");
    await git(repo, "push", "-q", "origin", "main");
    await git(repo, "checkout", "-q", "c");
    const { ctx } = world();
    const plan = await planStackSubmit(ctx);
    expect(plan.entries.map((e) => [e.branch, e.base])).toEqual([["b", "main"], ["c", "b"]]);
  });

  test("creates the missing PRs bottom-up with correct bases, then the stack", async () => {
    await chain();
    const { ctx, gh } = world();
    const plan = await planStackSubmit(ctx, { draft: true });
    const r = await stackSubmit(ctx, plan);
    expect(r.created.map((c) => [c.branch, c.number])).toEqual([["a", 100], ["b", 101], ["c", 102]]);
    expect(gh.created.map((c) => [c.argv[c.argv.indexOf("--head") + 1], c.argv[c.argv.indexOf("--base") + 1], c.argv.includes("--draft")])).toEqual([
      ["a", "main", true],
      ["b", "a", true],
      ["c", "b", true],
    ]);
    expect(gh.stacks).toEqual([[100, 101, 102]]);
    expect(r.stack).toEqual({ stack: 9, prs: [100, 101, 102] });
    for (const b of ["a", "b", "c"]) expect(await git(repo, "ls-remote", "origin", `refs/heads/${b}`)).toContain(`refs/heads/${b}`);
  });

  test("reuses an existing PR and retargets a wrong base before stacking", async () => {
    await chain();
    const { ctx, gh } = world([{ number: 5, head: "a", base: "main" }, { number: 6, head: "b", base: "old-base" }]);
    const r = await stackSubmit(ctx, await planStackSubmit(ctx));
    expect(gh.prs.find((p) => p.number === 6)!.base).toBe("a");
    expect(r.created.map((c) => c.branch)).toEqual(["c"]);
    expect(gh.stacks).toEqual([[5, 6, 100 + 2]]);
  });

  test("a failed stack creation names the PRs already created", async () => {
    await chain();
    const { ctx, gh } = world();
    const plan = await planStackSubmit(ctx);
    const inner = ctx.exec;
    const failing: Exec = (argv, opts) => (argv.join(" ").includes("/stacks") ? Promise.resolve({ code: 1, stdout: `HTTP/2.0 422 X\r\n\r\n{"message":"nope"}`, stderr: "" }) : inner(argv, opts));
    const e = (await stackSubmit({ ...ctx, exec: failing }, plan).catch((x: unknown) => x)) as StkError;
    expect(e.message).toBe("GitHub cannot make these PRs a stack: nope (already created: #100, #101, #102)");
    expect(gh.prs).toHaveLength(3);
  });
});

describe("empty-commit retrigger", () => {
  test("commits and pushes with a lease from the branch's worktree", async () => {
    await git(repo, "checkout", "-q", "-b", "feat");
    await commit(repo, "f.txt", "feat: f");
    await git(repo, "push", "-q", "-u", "origin", "feat");
    await git(repo, "checkout", "-q", "main");
    const wt = join(base, "wt");
    await git(repo, "worktree", "add", "-q", wt, "feat");
    const head = await git(wt, "rev-parse", "HEAD");
    const { ctx } = world();
    const plan = { number: 7, headSha: head, contexts: ["build"], steps: [{ kind: "empty-commit" as const, branch: "feat", worktree: wt, contexts: ["build"] }] };
    await rerunRequired(ctx, plan);
    expect(await git(wt, "log", "-1", "--format=%s")).toBe("ci: retrigger checks");
    expect(await git(repo, "rev-parse", "origin/feat")).not.toBe(head);
    expect((await git(origin, "rev-parse", "feat"))).toBe(await git(wt, "rev-parse", "HEAD"));
    expect(await git(wt, "rev-list", "--count", `${head}..HEAD`)).toBe("1");
  });

  test("refuses when the worktree is not at the PR head or has staged changes", async () => {
    await git(repo, "checkout", "-q", "-b", "feat");
    await commit(repo, "f.txt", "feat: f");
    await git(repo, "push", "-q", "-u", "origin", "feat");
    const head = await git(repo, "rev-parse", "HEAD");
    const { ctx } = world();
    const step = { kind: "empty-commit" as const, branch: "feat", worktree: repo, contexts: ["build"] };
    const stale = (await rerunRequired(ctx, { number: 7, headSha: "0".repeat(40), contexts: ["build"], steps: [step] }).catch((x: unknown) => x)) as StkError;
    expect(stale.code).toBe("diverged");
    writeFileSync(join(repo, "staged.txt"), "x");
    await git(repo, "add", "staged.txt");
    const staged = (await rerunRequired(ctx, { number: 7, headSha: head, contexts: ["build"], steps: [step] }).catch((x: unknown) => x)) as StkError;
    expect(staged.code).toBe("dirty-worktree");
  });
});
