import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec } from "../src/exec";
import { recordProvenance } from "../src/provenance";
import { preflightRestack, restackAndPush } from "../src/restack";
import { rebaseStack, type Ctx } from "../src/service";
import type { Exec, StkError } from "../src/types";

/**
 * Real git: a bare `origin`, a `seed` clone that builds the scenario (and later plays "someone else pushing"), and the
 * `clone` the code under test works in. Only `gh` is faked.
 *
 * Scenario: main has `shared.txt` + `conflict.txt`. b101 (PR #101) adds two files; b102 (#102) sits on b101 and adds
 * `f102.txt`; b103 (#103) sits on b102 and adds `f103.txt`. #101 is then squash-merged into main as ONE new commit, followed
 * by an unrelated main commit, so b102/b103 still contain b101's original commits.
 */
// every test builds several repos and runs real fetch/rebase/push
setDefaultTimeout(60_000);

let base: string;
let origin: string;
let seed: string;
let clone: string;
let expectedWorktrees: string;
let tmpDirsBefore: string[];

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

const commitFile = async (cwd: string, file: string, content: string, msg: string) => {
  writeFileSync(join(cwd, file), content);
  await git(cwd, "add", file);
  await git(cwd, "commit", "-qm", msg);
};

const tempCheckouts = () => readdirSync(tmpdir()).filter((d) => d.startsWith("stk-rebase-"));
const worktreeList = () => git(clone, "worktree", "list", "--porcelain");
const originSha = (branch: string) => git(origin, "rev-parse", `refs/heads/${branch}`);
const show = (rev: string, file: string) => git(origin, "show", `${rev}:${file}`);
const ahead = async (upstream: string, tip: string) => Number(await git(origin, "rev-list", "--count", `${upstream}..${tip}`));
const isAncestor = async (a: string, b: string) => (await realExec(["git", "merge-base", "--is-ancestor", a, b], { cwd: origin })).code === 0;

/** Add a worktree to the clone and remember it as expected, so the afterEach leak check ignores it. */
const addWorktree = async (...args: string[]) => {
  await git(clone, "worktree", "add", "-q", ...args);
  expectedWorktrees = await worktreeList();
};

interface Scenario {
  /** b102 edits the line of conflict.txt that the extra main commit also edits. */
  conflict?: boolean;
}

async function build({ conflict = false }: Scenario = {}) {
  base = realpathSync(mkdtempSync(join(tmpdir(), "stk-restack-test-")));
  origin = join(base, "origin.git");
  seed = join(base, "seed");
  clone = join(base, "clone");
  await realExec(["git", "init", "-q", "--bare", "-b", "main", origin]);
  await realExec(["git", "clone", "-q", origin, seed]);
  await git(seed, "config", "user.email", "t@t");
  await git(seed, "config", "user.name", "t");
  await git(seed, "checkout", "-qB", "main");
  await commitFile(seed, "shared.txt", "base\n", "init");
  await commitFile(seed, "conflict.txt", "one\ntwo\nthree\n", "conflict base");
  await git(seed, "push", "-q", "origin", "main");

  await git(seed, "checkout", "-qb", "b101");
  await commitFile(seed, "f101.txt", "101\n", "b101 first");
  await commitFile(seed, "f101b.txt", "101b\n", "b101 second");
  await git(seed, "checkout", "-qb", "b102");
  await commitFile(seed, "f102.txt", "102\n", "b102 own");
  if (conflict) await commitFile(seed, "conflict.txt", "one\nb102\nthree\n", "b102 edits conflict.txt");
  await git(seed, "checkout", "-qb", "b103");
  await commitFile(seed, "f103.txt", "103\n", "b103 own");

  // squash-merge b101 into main: one new commit with its content, then an unrelated main commit
  await git(seed, "checkout", "-q", "main");
  writeFileSync(join(seed, "f101.txt"), "101\n");
  writeFileSync(join(seed, "f101b.txt"), "101b\n");
  await git(seed, "add", ".");
  await git(seed, "commit", "-qm", "squash b101 (#101)");
  if (conflict) await commitFile(seed, "conflict.txt", "one\nmain\nthree\n", "main edits conflict.txt");
  else await commitFile(seed, "extra.txt", "extra\n", "unrelated main commit");
  await git(seed, "push", "-q", "origin", "main", "b101", "b102", "b103");
  // origin's own conflict-free extra commit on a line the stack does not touch is what b102 must land on top of
  await realExec(["git", "clone", "-q", origin, clone]);
  await git(clone, "config", "user.email", "t@t");
  await git(clone, "config", "user.name", "t");
  expectedWorktrees = await worktreeList();
}

type Heads = { b101: string; b102: string; b103: string };
const allHeads = async (): Promise<Heads> => ({ b101: await originSha("b101"), b102: await originSha("b102"), b103: await originSha("b103") });

/** A ctx whose gh answers with the stack [#101 MERGED, #102 OPEN, #103 OPEN] at `heads`; everything else is real. */
function ctxWith(heads: Heads, opts: { open?: number[]; wrap?: (argv: string[]) => Promise<void>; log?: string[][] } = {}): Ctx {
  const open = opts.open ?? [102, 103];
  const numbers = heads.b101 ? [101, 102, 103] : open;
  const baseOf = (n: number) => (n === 101 ? "main" : n === 102 ? (heads.b101 ? "b101" : "main") : "b102");
  const member = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: open.includes(n) ? "OPEN" : "MERGED", isDraft: false,
    headRefName: `b${n}`, baseRefName: baseOf(n),
    headRefOid: heads[`b${n}` as keyof Heads], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const exec: Exec = async (argv, o) => {
    if (argv[0] !== "gh") {
      opts.log?.push([...argv]);
      await opts.wrap?.([...argv]);
      return realExec(argv, o);
    }
    const a = argv.join(" ");
    if (a.startsWith("gh repo view")) return { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r" }), stderr: "" };
    // the re-link after the rebase (pull state, unstack, retarget, re-create): all succeed
    if (argv[1] === "api" && argv[2] === "-i") return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ number: 1, base: { ref: "main" }, mergeable_state: "clean", stack: { number: 1 } })}`, stderr: "" };
    if (argv.some((x) => x.startsWith("query="))) {
      const nodes = numbers.map((n, i) => ({ position: i + 1, pullRequest: member(n) }));
      const repository = { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 1 }, stack: { size: numbers.length, entries: { nodes } } } };
      return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, root: clone, slug: { owner: "o", name: "r" }, worktrees: [] };
}

const errorOf = async (p: Promise<unknown>): Promise<StkError> => {
  try {
    await p;
  } catch (e) {
    return e as StkError;
  }
  throw new Error("expected a rejection");
};

/** Run `fn` the first time a `git push` goes through exec: someone else pushes an extra commit to b103 first. */
const interfereOnPush = () => {
  let done = false;
  return async (argv: string[]) => {
    if (done || !argv.includes("push")) return;
    done = true;
    await git(seed, "checkout", "-q", "b103");
    await commitFile(seed, "intruder.txt", "x\n", "someone else pushed to b103");
    await git(seed, "push", "-q", "origin", "b103");
  };
};

beforeEach(() => {
  tmpDirsBefore = tempCheckouts();
});

afterEach(async () => {
  try {
    // the temporary worktree is always gone: only the worktrees the test itself created remain, and prune finds nothing to do
    expect(await worktreeList()).toBe(expectedWorktrees);
    expect((await git(clone, "worktree", "prune", "-v")).trim()).toBe("");
    expect(tempCheckouts().filter((d) => !tmpDirsBefore.includes(d))).toEqual([]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

describe("rebaseStack with real git", () => {
  test("happy path: members are rebased onto the trunk and pushed with leases", async () => {
    await build();
    const old = await allHeads();
    const log: string[][] = [];
    const r = await rebaseStack(ctxWith(old, { log }), 102);

    expect(r.prs).toEqual([102, 103]);
    const n102 = await originSha("b102");
    const n103 = await originSha("b103");
    expect(n102).not.toBe(old.b102);
    expect(n103).not.toBe(old.b103);
    expect(r.heads).toEqual({ 102: n102, 103: n103 });
    expect(r.note).toBeUndefined(); // no local checkout of either branch

    expect(await ahead("main", "b102")).toBe(1);
    expect(await ahead("refs/heads/b102", "refs/heads/b103")).toBe(1);
    expect(await isAncestor(await originSha("main"), n102)).toBe(true);
    expect(await isAncestor(n102, n103)).toBe(true);
    // b101 is untouched
    expect(await originSha("b101")).toBe(old.b101);
    // contents: trunk's files plus each member's own
    expect(await show("b102", "f102.txt")).toBe("102");
    expect(await show("b102", "extra.txt")).toBe("extra");
    expect(await show("b102", "f101.txt")).toBe("101");
    expect(await show("b103", "f103.txt")).toBe("103");
    expect(await show("b103", "f102.txt")).toBe("102");

    const push = log.find((a) => a.includes("push"))!;
    expect(push).toContain("--atomic");
    expect(push).toContain(`--force-with-lease=refs/heads/b102:${old.b102}`);
    expect(push).toContain(`--force-with-lease=refs/heads/b103:${old.b103}`);
    expect(log.filter((a) => a.includes("push"))).toHaveLength(1);
  });

  test("dirty user worktrees are untouched and reported as behind", async () => {
    await build();
    const wtA = join(base, "wt-a");
    const wtD = join(base, "wt-d");
    const old = await allHeads();
    await addWorktree("-b", "b102", wtA, "origin/b102");
    await addWorktree("--detach", wtD, old.b103);
    writeFileSync(join(wtA, "f102.txt"), "dirty edit\n");
    mkdirSync(join(wtA, "__pycache__"));
    writeFileSync(join(wtA, "__pycache__", "x.pyc"), "junk");
    const statusBefore = await git(wtA, "status", "--porcelain", "--untracked-files=all");
    const tipBefore = await git(wtA, "rev-parse", "HEAD");
    expect(statusBefore).toContain("__pycache__/x.pyc");

    const r = await rebaseStack(ctxWith(old), 102);

    expect(await git(wtA, "status", "--porcelain", "--untracked-files=all")).toBe(statusBefore);
    expect(await git(wtA, "rev-parse", "HEAD")).toBe(tipBefore);
    expect(await git(wtA, "rev-parse", "refs/heads/b102")).toBe(old.b102);
    expect(readFileSync(join(wtA, "f102.txt"), "utf8")).toBe("dirty edit\n");
    expect(readFileSync(join(wtA, "__pycache__", "x.pyc"), "utf8")).toBe("junk");
    expect(await git(wtD, "rev-parse", "HEAD")).toBe(old.b103);
    expect(await git(clone, "stash", "list")).toBe("");
    expect(r.note).toContain(wtA);
    expect(r.note).toContain(wtD);
    expect(await originSha("b102")).not.toBe(old.b102);
  });

  test("a member with no local worktree and no local branch works", async () => {
    await build();
    expect(await git(clone, "branch", "--list", "b10*")).toBe("");
    const old = await allHeads();
    const r = await rebaseStack(ctxWith(old), 103 as number);
    expect(r.prs).toEqual([102, 103]);
    expect(await ahead("main", "b103")).toBe(2);
    expect(await show("b103", "f103.txt")).toBe("103");
  });

  test("a local branch that is merely behind origin is fine", async () => {
    await build();
    const old = await allHeads();
    await git(clone, "branch", "b102", old.b101); // an ancestor of origin/b102
    const r = await rebaseStack(ctxWith(old), 102);
    expect(r.prs).toEqual([102, 103]);
    expect(await ahead("main", "b102")).toBe(1);
    expect(await git(clone, "rev-parse", "refs/heads/b102")).toBe(old.b101);
  });

  test("a conflict aborts, names the PR and file, and pushes nothing", async () => {
    await build({ conflict: true });
    const old = await allHeads();
    const err = await errorOf(rebaseStack(ctxWith(old), 102));
    expect(err.code).toBe("rebase-conflict");
    expect(err.message).toContain("#102");
    expect(err.message).toContain("conflict.txt");
    expect(await allHeads()).toEqual(old);
  });

  test("stale stack data (origin/b103 moved after it was read) is refused by the preflight", async () => {
    await build();
    const old = await allHeads();
    await git(seed, "checkout", "-q", "b103");
    await commitFile(seed, "intruder.txt", "x\n", "someone else pushed to b103");
    await git(seed, "push", "-q", "origin", "b103");
    const moved = await allHeads();

    const err = await errorOf(rebaseStack(ctxWith(old), 102)); // the fake GraphQL still reports the old b103 head
    expect(err.code).toBe("lease-rejected");
    expect(err.message).toContain("#103");
    expect(await allHeads()).toEqual(moved);
  });

  test("a remote that moves between the preflight and the push is rejected atomically", async () => {
    await build();
    const old = await allHeads();
    const err = await errorOf(rebaseStack(ctxWith(old, { wrap: interfereOnPush() }), 102));
    expect(err.code).toBe("lease-rejected");
    const now = await allHeads();
    expect(now.b102).toBe(old.b102); // atomic: the b102 rewrite did not land either
    expect(now.b103).not.toBe(old.b103); // the intruder's commit is intact
    expect(await show("b103", "intruder.txt")).toBe("x");
  });

  test("unpushed local commits on a member checked out in a worktree are refused with `diverged`", async () => {
    await build();
    const old = await allHeads();
    const wtA = join(base, "wt-a");
    await addWorktree("-b", "b102", wtA, "origin/b102");
    await commitFile(wtA, "local-only.txt", "mine\n", "unpushed work");
    expectedWorktrees = await worktreeList(); // the worktree's HEAD moved: that is the test's own doing

    const err = await errorOf(rebaseStack(ctxWith(old), 102));
    expect(err.code).toBe("diverged");
    expect(err.message).toContain(wtA);
    expect(err.message).toContain("b102");
    expect(await allHeads()).toEqual(old);
  });

  test("unpushed local commits on a branch with no worktree are refused with `diverged`", async () => {
    await build();
    const old = await allHeads();
    await git(clone, "branch", "b102", old.b102);
    await git(clone, "-c", "core.hooksPath=/dev/null", "commit-tree", "-p", "b102", "-m", "unpushed", `${old.b102}^{tree}`).then((sha) => git(clone, "update-ref", "refs/heads/b102", sha));

    const err = await errorOf(rebaseStack(ctxWith(old), 102));
    expect(err.code).toBe("diverged");
    expect(err.message).toContain("b102");
    expect(await allHeads()).toEqual(old);
  });

  test("nothing to rebase: a stack already on the trunk pushes nothing", async () => {
    await build();
    // b102 and b103 re-created straight on the current trunk tip, no merged PR below them
    await git(seed, "checkout", "-q", "main");
    await git(seed, "checkout", "-qB", "b102");
    await commitFile(seed, "f102.txt", "102\n", "b102 own");
    await git(seed, "checkout", "-qB", "b103");
    await commitFile(seed, "f103.txt", "103\n", "b103 own");
    await git(seed, "push", "-qf", "origin", "b102", "b103");
    const heads = { b101: "", b102: await originSha("b102"), b103: await originSha("b103") };
    const before = await allHeads();
    const log: string[][] = [];

    const r = await rebaseStack(ctxWith(heads, { log }), 102);

    expect(r.prs).toEqual([102, 103]);
    expect(r.heads).toEqual({ 102: heads.b102, 103: heads.b103 });
    expect(r.note).toBeUndefined();
    expect(log.some((a) => a.includes("push"))).toBe(false);
    expect(await allHeads()).toEqual(before);
  });
});

describe("rebaseStack hardening", () => {
  test("user config rebase.updateRefs cannot move an unchecked-out local member branch", async () => {
    await build();
    const old = await allHeads();
    await git(clone, "config", "rebase.updateRefs", "true");
    await git(clone, "config", "rebase.autoSquash", "true");
    await git(clone, "branch", "b102", old.b102);
    await git(clone, "branch", "b103", old.b103);

    await rebaseStack(ctxWith(old), 102);

    expect(await originSha("b102")).not.toBe(old.b102);
    expect(await git(clone, "rev-parse", "refs/heads/b102")).toBe(old.b102);
    expect(await git(clone, "rev-parse", "refs/heads/b103")).toBe(old.b103);
  });

  test("an amended parent is refused: its superseded commits are not resurrected in the child", async () => {
    await build();
    // b102 is amended and force-pushed while b103 still sits on the previous b102
    await git(seed, "checkout", "-q", "b102");
    await git(seed, "reset", "-q", "--hard", "b101");
    await commitFile(seed, "f102.txt", "102 amended\n", "b102 amended");
    await git(seed, "push", "-qf", "origin", "b102");
    const before = await allHeads();

    const err = await errorOf(rebaseStack(ctxWith(before), 102));

    expect(err.code).toBe("not-linear");
    expect(err.message).toContain("#103");
    expect(err.message).toContain("#102");
    expect(await allHeads()).toEqual(before);
  });

  test("a bottom member that does not contain the merged PR's head is refused", async () => {
    await build();
    // b101 (the merged PR) was force-pushed after b102 was based on it
    await git(seed, "checkout", "-q", "b101");
    await git(seed, "reset", "-q", "--hard", "HEAD~1");
    await commitFile(seed, "f101b.txt", "101b amended\n", "b101 amended");
    await git(seed, "push", "-qf", "origin", "b101");
    const before = await allHeads();

    const err = await errorOf(rebaseStack(ctxWith(before), 102));

    expect(err.code).toBe("not-linear");
    expect(err.message).toContain("#102");
    expect(await allHeads()).toEqual(before);
  });

  test("A, B, C merged one by one with local branches: the second restack does not take the old local tips for unpushed work", async () => {
    await build();
    const old = await allHeads();
    await git(clone, "branch", "b102", old.b102);
    await git(clone, "branch", "b103", old.b103);
    const knownHeads: Record<string, string[]> = {};

    // #101 is merged: the first restack rewrites #102 and #103 and leaves the local branches at their old tips
    await rebaseStack(ctxWith(old), 102, { knownHeads });
    expect(knownHeads).toEqual({ b102: [old.b102], b103: [old.b103] });
    expect(await git(clone, "rev-parse", "refs/heads/b103")).toBe(old.b103);
    const afterFirst = await allHeads();

    // then #102 lands (squash) on main
    await git(seed, "checkout", "-q", "main");
    await git(seed, "pull", "-q", "origin", "main");
    await commitFile(seed, "f102.txt", "102\n", "squash b102 (#102)");
    await git(seed, "push", "-q", "origin", "main");

    // without the run's memory, persisted provenance or reflog evidence the stale local b103 looks like unpublished work
    const savedState = process.env.STK_STATE_DIR;
    process.env.STK_STATE_DIR = join(base, "empty-state");
    rmSync(join(clone, ".git", "logs"), { recursive: true, force: true });
    const stale = await errorOf(rebaseStack(ctxWith(afterFirst, { open: [103] }), 103));
    if (savedState === undefined) delete process.env.STK_STATE_DIR;
    else process.env.STK_STATE_DIR = savedState;
    expect(stale.code).toBe("diverged");

    const r = await rebaseStack(ctxWith(afterFirst, { open: [103] }), 103, { knownHeads });
    expect(r.prs).toEqual([103]);
    expect(await ahead("main", "b103")).toBe(1);
    expect(knownHeads.b103).toEqual([old.b103, afterFirst.b103]);
    expect(await git(clone, "rev-parse", "refs/heads/b103")).toBe(old.b103);
  });

  test("real unpushed work on top of a known old tip is still refused", async () => {
    await build();
    const old = await allHeads();
    const wt = join(base, "wt-c");
    await addWorktree("-b", "b103", wt, old.b103);
    await commitFile(wt, "mine.txt", "mine\n", "unpushed work on b103");
    expectedWorktrees = await worktreeList();

    const err = await errorOf(rebaseStack(ctxWith(old), 102, { knownHeads: { b103: [old.b103] } }));

    expect(err.code).toBe("diverged");
    expect(err.message).toContain(wt);
    expect(await allHeads()).toEqual(old);
  });
});

describe("restackAndPush / preflightRestack directly", () => {
  const input = async () => {
    const old = await allHeads();
    return {
      old,
      input: {
        trunk: "main",
        members: [
          { number: 102, branch: "b102", headSha: old.b102 },
          { number: 103, branch: "b103", headSha: old.b103 },
        ],
        mergedBaseSha: old.b101,
        baseRef: "b101",
      },
    };
  };

  test("restackAndPush reports pushed members, steps and local checkouts that are behind", async () => {
    await build();
    const { old, input: inp } = await input();
    const wtB = join(base, "wt-b");
    await addWorktree("-b", "b103", wtB, "origin/b103");
    const steps: string[] = [];

    const r = await restackAndPush(realExec, clone, inp, (s) => steps.push(s));

    expect(r.pushed).toEqual([102, 103]);
    expect(r.heads[102]).toBe(await originSha("b102"));
    expect(r.heads[103]).toBe(await originSha("b103"));
    expect(r.behind).toEqual([{ path: wtB, branch: "b103" }]);
    expect(steps).toEqual(["fetching", "rebasing #102", "rebasing #103", "pushing"]);
    expect(await git(wtB, "rev-parse", "HEAD")).toBe(old.b103);
  });

  test("preflightRestack passes on a clean stack and changes nothing", async () => {
    await build();
    const { old, input: inp } = await input();
    await preflightRestack(realExec, clone, inp);
    expect(await allHeads()).toEqual(old);
    expect(existsSync(join(clone, ".git"))).toBe(true);
  });
});

describe("published-tip provenance across jobs", () => {
  let savedState: string | undefined;
  beforeEach(() => {
    savedState = process.env.STK_STATE_DIR;
  });
  afterEach(() => {
    if (savedState === undefined) delete process.env.STK_STATE_DIR;
    else process.env.STK_STATE_DIR = savedState;
  });

  const stateFile = () => join(process.env.STK_STATE_DIR!, "restack-provenance.json");

  /** Job 1: restack #102/#103 (local branches present, left at their old tips); then #102 lands on main. Returns the heads job 2 reads. */
  async function firstJob() {
    await build();
    process.env.STK_STATE_DIR = join(base, "state");
    const old = await allHeads();
    await git(clone, "branch", "b102", old.b102);
    await git(clone, "branch", "b103", old.b103);
    await rebaseStack(ctxWith(old), 102);
    const afterFirst = await allHeads();
    expect(afterFirst.b103).not.toBe(old.b103);
    await git(seed, "checkout", "-q", "main");
    await git(seed, "pull", "-q", "origin", "main");
    await commitFile(seed, "f102.txt", "102\n", "squash b102 (#102)");
    await git(seed, "push", "-q", "origin", "main");
    return { old, afterFirst };
  }

  test("a second job succeeds on the untouched old local tips, from persisted provenance alone (no knownHeads)", async () => {
    const { old, afterFirst } = await firstJob();
    const saved = JSON.parse(readFileSync(stateFile(), "utf8")) as { repos: Record<string, Record<string, { sha: string }[]>> };
    expect(Object.values(saved.repos)[0]!.b103!.map((h) => h.sha)).toEqual([old.b103]);

    const r = await rebaseStack(ctxWith(afterFirst, { open: [103] }), 103);

    expect(r.prs).toEqual([103]);
    expect(await ahead("main", "b103")).toBe(1);
    expect(await git(clone, "rev-parse", "refs/heads/b103")).toBe(old.b103);
    // and the second job's own replaced head is remembered too
    const again = JSON.parse(readFileSync(stateFile(), "utf8")) as typeof saved;
    expect(Object.values(again.repos)[0]!.b103!.map((h) => h.sha)).toEqual([old.b103, afterFirst.b103]);
  });

  test("without the persisted file, the remote-tracking reflog still shows the old head", async () => {
    const { old, afterFirst } = await firstJob();
    rmSync(stateFile());

    const r = await rebaseStack(ctxWith(afterFirst, { open: [103] }), 103);

    expect(r.prs).toEqual([103]);
    expect(await git(clone, "rev-parse", "refs/heads/b103")).toBe(old.b103);
  });

  test("a corrupt provenance file is empty: no crash, and the reflog evidence still applies", async () => {
    const { afterFirst } = await firstJob();
    writeFileSync(stateFile(), '{"repos": {"x": [1,');

    const r = await rebaseStack(ctxWith(afterFirst, { open: [103] }), 103);

    expect(r.prs).toEqual([103]);
    expect((JSON.parse(readFileSync(stateFile(), "utf8")) as { version: number }).version).toBe(1);
  });

  test("with neither persisted provenance nor reflog evidence an old tip is refused, naming the branch", async () => {
    const { afterFirst } = await firstJob();
    rmSync(stateFile());
    // forget everything git remembers about origin/b103's earlier values
    await git(clone, "reflog", "expire", "--expire=now", "--all");

    const err = await errorOf(rebaseStack(ctxWith(afterFirst, { open: [103] }), 103));

    expect(err.code).toBe("diverged");
    expect(err.message).toContain("b103");
    expect(err.message).toContain("unpushed commits");
  });

  test("a stack merge that stops after its first restack leaves a fresh run able to continue (preflight via provenance)", async () => {
    const { afterFirst } = await firstJob();
    const rest = [{ number: 103, branch: "b103", headSha: afterFirst.b103 }];
    // knownHeads died with job 1's process; the stack merge's preflight must still pass
    await preflightRestack(realExec, clone, { trunk: "main", members: rest, mergedBaseSha: afterFirst.b102, baseRef: "b102", provenanceKey: "o/r@" + clone });
    // another repo's (or clone's) provenance vouches for nothing here
    rmSync(join(clone, ".git", "logs"), { recursive: true, force: true });
    const stranger = { trunk: "main", members: rest, mergedBaseSha: afterFirst.b102, baseRef: "b102", provenanceKey: "o/other@" + clone };
    expect((await errorOf(preflightRestack(realExec, clone, stranger))).code).toBe("diverged");
  });

  test("real unpushed commits on top of a known old tip are refused, with the worktree and the commit count", async () => {
    const { afterFirst } = await firstJob();
    const wt = join(base, "wt-mine");
    await addWorktree(wt, "b103");
    await commitFile(wt, "mine.txt", "mine\n", "unpushed 1");
    await commitFile(wt, "mine2.txt", "mine2\n", "unpushed 2");
    expectedWorktrees = await worktreeList();

    const err = await errorOf(rebaseStack(ctxWith(afterFirst, { open: [103] }), 103));

    expect(err.code).toBe("diverged");
    expect(err.message).toContain(wt);
    expect(err.message).toContain("b103");
    expect(err.message).toContain("2 unpublished");
    expect(await allHeads()).toEqual(afterFirst);
  });

  test("a patch-equivalent local commit is NOT evidence of publication: it is refused", async () => {
    await build();
    process.env.STK_STATE_DIR = join(base, "state");
    const old = await allHeads();
    // someone else pushes X to b103; the clone has the same change committed locally under another hash, never pushed
    await git(seed, "checkout", "-q", "b103");
    await commitFile(seed, "extra-x.txt", "x\n", "X");
    await git(seed, "push", "-q", "origin", "b103");
    await git(clone, "branch", "b103", old.b103);
    const wt = join(base, "wt-x");
    await addWorktree(wt, "b103");
    await commitFile(wt, "extra-x.txt", "x\n", "X (local copy)");
    expectedWorktrees = await worktreeList();

    const err = await errorOf(rebaseStack(ctxWith(await allHeads()), 102));

    expect(err.code).toBe("diverged");
    expect(err.message).toContain(wt);
    expect(err.message).toContain("1 unpublished");
  });

  test("a branch named `constructor` is looked up as a plain key in provenance and knownHeads", async () => {
    await build();
    process.env.STK_STATE_DIR = join(base, "state");
    const old = await allHeads();
    // origin/constructor was rewritten after the clone's local `constructor` was made at its previous tip
    await git(seed, "checkout", "-qb", "constructor", "b102");
    await commitFile(seed, "c1.txt", "1\n", "c first");
    await git(seed, "push", "-q", "origin", "constructor");
    const prev = await git(seed, "rev-parse", "HEAD");
    // brought in without a remote-tracking ref, so the reflog never saw `prev`
    await git(clone, "fetch", "-q", origin, "constructor:refs/stk-tmp/prev");
    await git(clone, "branch", "constructor", prev);
    await git(clone, "update-ref", "-d", "refs/stk-tmp/prev");
    await git(seed, "reset", "-q", "--hard", "b102");
    await commitFile(seed, "c2.txt", "2\n", "c rewritten");
    await git(seed, "push", "-qf", "origin", "constructor");
    const head = await git(seed, "rev-parse", "HEAD");
    const input = { trunk: "main", members: [{ number: 9, branch: "constructor", headSha: head }], mergedBaseSha: null, baseRef: "main", provenanceKey: "o/r@" + clone };

    expect((await errorOf(preflightRestack(realExec, clone, input))).code).toBe("diverged");

    recordProvenance(input.provenanceKey, [{ branch: "constructor", sha: prev }]);
    await preflightRestack(realExec, clone, input);

    rmSync(join(process.env.STK_STATE_DIR, "restack-provenance.json"));
    await preflightRestack(realExec, clone, { ...input, knownHeads: Object.assign(Object.create(null), { constructor: [prev] }) });
    expect(old.b102).toBeDefined();
  });
});
