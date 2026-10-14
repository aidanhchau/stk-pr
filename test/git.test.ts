import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "../src/exec";
import {
  fetchBranches,
  headSha,
  isClean,
  leasedPush,
  listWorktrees,
  parseWorktrees,
  preflightBranch,
  rebaseOnto,
  remoteSha,
  repoRoot,
  worktreeForBranch,
} from "../src/git";
import { executePlan, planStackMerge } from "../src/stack";
import { StkError, type Exec, type PullRequest } from "../src/types";

const PORCELAIN = `worktree /code/app
HEAD aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
branch refs/heads/dev

worktree /code/app-feature
HEAD bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
branch refs/heads/feat/login
locked because reasons

worktree /code/app-detached
HEAD cccccccccccccccccccccccccccccccccccccccc
detached

worktree /code/app-gone
HEAD dddddddddddddddddddddddddddddddddddddddd
branch refs/heads/gone
prunable gitdir file points to non-existent location

worktree /code/app.git
bare
`;

function fakeExec(handler: (argv: readonly string[]) => { code?: number; stdout?: string; stderr?: string }): Exec {
  return async (argv) => ({ code: 0, stdout: "", stderr: "", ...handler(argv) });
}

describe("worktree parsing", () => {
  test("parses branch, detached, locked, bare; drops prunable", () => {
    const wts = parseWorktrees(PORCELAIN);
    expect(wts).toEqual([
      { path: "/code/app", branch: "dev", head: "a".repeat(40), bare: false },
      { path: "/code/app-feature", branch: "feat/login", head: "b".repeat(40), bare: false },
      { path: "/code/app-detached", branch: null, head: "c".repeat(40), bare: false },
      { path: "/code/app.git", branch: null, head: "", bare: true },
    ]);
  });

  test("worktreeForBranch finds existing worktree, ignores bare/detached", () => {
    const wts = parseWorktrees(PORCELAIN);
    expect(worktreeForBranch(wts, "feat/login")?.path).toBe("/code/app-feature");
    expect(worktreeForBranch(wts, "gone")).toBeNull();
    expect(worktreeForBranch(wts, "nope")).toBeNull();
  });

  test("listWorktrees runs the porcelain command in repoDir", async () => {
    const calls: { argv: readonly string[]; cwd?: string }[] = [];
    const fake: Exec = async (argv, opts) => {
      calls.push({ argv, cwd: opts?.cwd });
      return { code: 0, stdout: PORCELAIN, stderr: "" };
    };
    const wts = await listWorktrees(fake, "/code/app");
    expect(wts).toHaveLength(4);
    expect(calls[0]).toEqual({ argv: ["git", "worktree", "list", "--porcelain"], cwd: "/code/app" });
  });

  test("listWorktrees throws git-failed on nonzero", async () => {
    const fake = fakeExec(() => ({ code: 128, stderr: "fatal" }));
    await expect(listWorktrees(fake, "/x")).rejects.toMatchObject({ code: "git-failed" });
  });
});

describe("remoteSha / fetch with fake exec", () => {
  test("remoteSha parses ls-remote and returns null when absent", async () => {
    const sha = "1".repeat(40);
    const present = fakeExec(() => ({ stdout: `${sha}\trefs/heads/feat\n` }));
    expect(await remoteSha(present, "/x", "feat")).toBe(sha);
    const absent = fakeExec(() => ({ stdout: "" }));
    expect(await remoteSha(absent, "/x", "feat")).toBeNull();
  });

  test("fetchBranches only fetches", async () => {
    const seen: string[][] = [];
    const fake = fakeExec((argv) => {
      seen.push([...argv]);
      return {};
    });
    await fetchBranches(fake, "/x", ["dev", "b"]);
    await fetchBranches(fake, "/x", []);
    expect(seen).toEqual([["git", "fetch", "origin", "dev", "b"]]);
  });

  test("repoRoot throws not-a-repo", async () => {
    const fake = fakeExec(() => ({ code: 128, stderr: "fatal: not a git repository" }));
    await expect(repoRoot(fake, "/x")).rejects.toMatchObject({ code: "not-a-repo" });
  });
});

// ---------------------------------------------------------------------------
// Real git integration
// ---------------------------------------------------------------------------

let root: string;
let repo: string;
let origin: string;

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const r = await exec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

async function commitFile(cwd: string, file: string, content: string, msg: string) {
  writeFileSync(join(cwd, file), content);
  await sh(cwd, "add", file);
  await sh(cwd, "commit", "-m", msg);
}

async function configure(cwd: string) {
  await sh(cwd, "config", "user.name", "stk test");
  await sh(cwd, "config", "user.email", "stk@example.com");
  await sh(cwd, "config", "commit.gpgsign", "false");
}

interface Fixture {
  aHead: string;
  bHead: string;
}

/**
 * origin (bare), trunk `dev`, A (from dev) -> B (from A). `bFile` lets a test make B touch
 * shared.txt to provoke conflicts. A is then squash-merged into dev manually and pushed.
 * `repo` is left checked out on dev, so B has no worktree.
 */
async function setup(opts: { bTouchesShared?: boolean; devTouchesShared?: boolean } = {}): Promise<Fixture> {
  root = realpathSync(mkdtempSync(join(tmpdir(), "stk-git-")));
  origin = join(root, "origin.git");
  repo = join(root, "repo");
  mkdirSync(origin);
  await sh(origin, "init", "--bare", "-b", "dev");
  mkdirSync(repo);
  await sh(repo, "init", "-b", "dev");
  await configure(repo);
  await sh(repo, "remote", "add", "origin", origin);
  await commitFile(repo, "shared.txt", "base\n", "base");
  await sh(repo, "push", "origin", "dev");

  await sh(repo, "checkout", "-b", "A");
  await commitFile(repo, "a.txt", "a\n", "A work");
  await sh(repo, "push", "origin", "A");
  const aHead = await sh(repo, "rev-parse", "HEAD");

  await sh(repo, "checkout", "-b", "B");
  await commitFile(repo, opts.bTouchesShared ? "shared.txt" : "b.txt", "b\n", "B work");
  await sh(repo, "push", "origin", "B");
  const bHead = await sh(repo, "rev-parse", "HEAD");

  // Squash-merge A into dev, as GitHub would.
  await sh(repo, "checkout", "dev");
  await sh(repo, "merge", "--squash", "A");
  await sh(repo, "commit", "-m", "A (#1)");
  if (opts.devTouchesShared) await commitFile(repo, "shared.txt", "dev\n", "dev edits shared");
  await sh(repo, "push", "origin", "dev");
  return { aHead, bHead };
}

beforeEach(() => {
  root = "";
});
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

describe("git integration (real git)", () => {
  test("restacks B onto squashed dev in a temp worktree and leased-pushes", async () => {
    const { aHead, bHead } = await setup();
    await fetchBranches(exec, repo, ["dev", "B"]);
    const recorded = await remoteSha(exec, repo, "B");
    expect(recorded).toBe(bHead);

    const newSha = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, bHead);
    expect(newSha).not.toBe(bHead);
    // B is now exactly one commit on top of dev's tip; A's old commit is gone.
    expect(await sh(repo, "rev-parse", "B~1")).toBe(await sh(repo, "rev-parse", "origin/dev"));
    expect(await sh(repo, "log", "--format=%s", "origin/dev..B")).toBe("B work");
    // Temp worktree was removed.
    expect(await listWorktrees(exec, repo)).toHaveLength(1);

    const pushed = await leasedPush(exec, repo, "B", recorded!);
    expect(pushed).toBe(newSha);
    expect(await remoteSha(exec, repo, "B")).toBe(newSha);
  });

  test("uses the existing worktree when the branch is checked out", async () => {
    const { aHead, bHead } = await setup();
    await sh(repo, "checkout", "B");
    const newSha = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, bHead);
    expect(await headSha(exec, repo)).toBe(newSha);
    expect(await isClean(exec, repo)).toBe(true);
    const pushed = await leasedPush(exec, repo, "B", bHead);
    expect(pushed).toBe(newSha);
  });

  test("refuses a dirty worktree", async () => {
    const { aHead, bHead } = await setup();
    await sh(repo, "checkout", "B");
    writeFileSync(join(repo, "b.txt"), "dirty\n");
    const err = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, bHead).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("dirty-worktree");
  });

  test("lease-rejected when the remote moved after recording", async () => {
    const { aHead, bHead } = await setup();
    await rebaseOnto(exec, repo, "B", "origin/dev", aHead, bHead);

    // Someone else pushes to B after we recorded bHead.
    const other = join(root, "other");
    await sh(root, "clone", "-b", "B", origin, other);
    await configure(other);
    await commitFile(other, "c.txt", "c\n", "someone else");
    await sh(other, "push", "origin", "B");
    const moved = await sh(other, "rev-parse", "HEAD");

    const err = await leasedPush(exec, repo, "B", bHead).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("lease-rejected");
    expect(await remoteSha(exec, repo, "B")).toBe(moved);
  });

  test("conflict aborts the rebase and leaves a temp-worktree restack clean", async () => {
    const { aHead, bHead } = await setup({ bTouchesShared: true, devTouchesShared: true });
    const err = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, bHead).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("rebase-conflict");
    expect(err.message).toContain("shared.txt");
    expect(await listWorktrees(exec, repo)).toHaveLength(1);
    expect(await isClean(exec, repo)).toBe(true);
  });

  test("conflict in an existing worktree is aborted and left clean", async () => {
    const { aHead, bHead } = await setup({ bTouchesShared: true, devTouchesShared: true });
    await sh(repo, "checkout", "B");
    const err = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, bHead).catch((e) => e);
    expect(err.code).toBe("rebase-conflict");
    expect(await isClean(exec, repo)).toBe(true);
    expect(await headSha(exec, repo)).toBe(bHead);
    const state = await exec(["git", "rev-parse", "--git-path", "rebase-merge"], { cwd: repo });
    const exists = await exec(["test", "-d", join(repo, state.stdout.trim())]);
    expect(exists.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Stale / diverged local branches must never lead to overwriting remote commits
// ---------------------------------------------------------------------------

/** Push a commit to origin/B from a separate clone; returns the new remote tip. */
async function pushRemoteOnlyCommit(): Promise<string> {
  const other = join(root, "other");
  await sh(root, "clone", "-b", "B", origin, other);
  await configure(other);
  await commitFile(other, "remote-only.txt", "r\n", "remote only");
  await sh(other, "push", "origin", "B");
  return sh(other, "rev-parse", "HEAD");
}

function ghRecorder() {
  const calls: string[] = [];
  return {
    calls,
    gh: {
      merge: async (n: number) => (calls.push(`merge ${n}`), { status: "merged" as const }),
      retarget: async (n: number) => void calls.push(`retarget ${n}`),
      waitChecks: async (n: number) => void calls.push(`wait ${n}`),
      rebaseStack: async (n: number) => void calls.push(`rebase-stack ${n}`),
    },
  };
}

async function planFor(aHead: string, bSha: string) {
  const mk = (n: number, head: string, base: string, headSha: string): PullRequest => ({
    number: n,
    title: `PR ${n}`,
    body: "",
    url: `https://example.com/${n}`,
    author: "octo-dev",
    state: "OPEN",
    isDraft: false,
    headRef: head,
    baseRef: base,
    headSha,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    checks: [{ name: "ci", state: "pass", url: null }],
    unresolvedThreads: 0,
    worktree: null,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-01T00:00:00Z",
  });
  return planStackMerge(
    { trunk: "dev", prs: [mk(1, "A", "dev", aHead), mk(2, "B", "A", bSha)] },
    { method: "squash", force: false, repoDir: repo },
    await listWorktrees(exec, repo),
  );
}

describe("restack safety against stale local branches", () => {
  test("stale clean worktree behind origin is fast-forwarded; restack+push keeps the remote-only commit", async () => {
    const { aHead } = await setup();
    const bwt = join(root, "bwt");
    await sh(repo, "worktree", "add", bwt, "B");
    const moved = await pushRemoteOnlyCommit();
    const { calls, gh } = ghRecorder();

    const results = await executePlan(await planFor(aHead, moved), { exec, repoDir: repo, gh });
    expect(results.every((r) => r.ok)).toBe(true);
    const pushedSha = await remoteSha(exec, repo, "B");
    expect(pushedSha).not.toBe(moved);
    await fetchBranches(exec, repo, ["B"]);
    const subjects = (await sh(repo, "log", "--format=%s", "origin/dev..origin/B")).split("\n");
    expect(subjects).toEqual(["remote only", "B work"]);
    expect(calls).toEqual(["merge 1", "retarget 2", "wait 2", "merge 2"]);
  });

  test("local worktree ahead of origin -> diverged, no merge/gh call", async () => {
    const { aHead, bHead } = await setup();
    const bwt = join(root, "bwt");
    await sh(repo, "worktree", "add", bwt, "B");
    await commitFile(bwt, "local.txt", "l\n", "local only");
    const localTipSha = await sh(bwt, "rev-parse", "HEAD");
    const { calls, gh } = ghRecorder();

    const results = await executePlan(await planFor(aHead, bHead), { exec, repoDir: repo, gh });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain(localTipSha);
    expect(results[0]!.detail).toContain(bHead);
    expect(calls).toEqual([]);
    expect(await remoteSha(exec, repo, "B")).toBe(bHead);
    const err = await preflightBranch(exec, bwt, "B", bHead, bwt).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("diverged");
  });

  test("diverged local ref (no worktree) -> diverged, no gh call", async () => {
    const { aHead, bHead } = await setup();
    // Local B gets its own commit; remote B gets a different one.
    await sh(repo, "checkout", "B");
    await commitFile(repo, "local.txt", "l\n", "local only");
    await sh(repo, "checkout", "dev");
    const moved = await pushRemoteOnlyCommit();
    const { calls, gh } = ghRecorder();

    const results = await executePlan(await planFor(aHead, moved), { exec, repoDir: repo, gh });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain(moved);
    expect(calls).toEqual([]);
    expect(await remoteSha(exec, repo, "B")).toBe(moved);
    expect(bHead).not.toBe(moved);
    const err = await preflightBranch(exec, repo, "B", moved, null).catch((e) => e);
    expect(err.code).toBe("diverged");
  });

  test("remote moved after planning fails preflight before any merge", async () => {
    const { aHead, bHead } = await setup();
    const plan = await planFor(aHead, bHead);
    const moved = await pushRemoteOnlyCommit();
    const { calls, gh } = ghRecorder();

    const results = await executePlan(plan, { exec, repoDir: repo, gh });
    expect(results).toHaveLength(1);
    expect(results[0]!.ok).toBe(false);
    expect(results[0]!.detail).toContain(moved);
    expect(calls).toEqual([]);
    const err = await preflightBranch(exec, repo, "B", bHead, null).catch((e) => e);
    expect(err.code).toBe("lease-rejected");
  });

  test("stale local ref without a worktree is fast-forwarded by preflight", async () => {
    await setup();
    const moved = await pushRemoteOnlyCommit();
    await preflightBranch(exec, repo, "B", moved, null);
    expect(await sh(repo, "rev-parse", "refs/heads/B")).toBe(moved);
  });

  test("temp-worktree restack starts from the expected SHA, not a stale refs/heads/<b>", async () => {
    const { aHead, bHead } = await setup();
    const moved = await pushRemoteOnlyCommit();
    await fetchBranches(exec, repo, ["dev", "B"]);
    expect(await sh(repo, "rev-parse", "refs/heads/B")).toBe(bHead); // stale

    const newSha = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, moved);
    expect(await sh(repo, "log", "--format=%s", `origin/dev..${newSha}`)).toBe("remote only\nB work");
    expect(await listWorktrees(exec, repo)).toHaveLength(1);
  });

  test("rebaseOnto refuses when the branch tip differs from expectedTip", async () => {
    const { aHead, bHead } = await setup();
    // Existing worktree at a different tip.
    await sh(repo, "checkout", "B");
    const wtErr = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, aHead).catch((e) => e);
    expect(wtErr.code).toBe("diverged");
    // Temp path: local ref ahead of the expected tip.
    await sh(repo, "checkout", "dev");
    const tmpErr = await rebaseOnto(exec, repo, "B", "origin/dev", aHead, aHead).catch((e) => e);
    expect(tmpErr.code).toBe("diverged");
    expect(await sh(repo, "rev-parse", "refs/heads/B")).toBe(bHead);
  });
});
