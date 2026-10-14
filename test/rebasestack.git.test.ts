import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec } from "../src/exec";
import { rebaseStack, type Ctx } from "../src/service";
import type { Exec, StkError } from "../src/types";

/** Real git in a temp repo with two linked worktrees (the branches of PR #102 and #103); gh is faked. */
let base: string;
let repo: string;
let wtA: string;
let wtB: string;

const git = async (cwd: string, ...args: string[]) => {
  const r = await realExec(["git", ...args], { cwd });
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

beforeEach(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "stk-rebase-")));
  repo = join(base, "repo");
  wtA = join(base, "wt-a");
  wtB = join(base, "wt-b");
  await realExec(["git", "init", "-q", "-b", "main", repo]);
  await git(repo, "config", "user.email", "t@t");
  await git(repo, "config", "user.name", "t");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "worktree", "add", "-q", "-b", "b102", wtA);
  await git(repo, "worktree", "add", "-q", "-b", "b103", wtB);
  // both worktrees dirty: a tracked edit of the same file plus an untracked file of their own
  writeFileSync(join(wtA, "shared.txt"), "A edit\n");
  writeFileSync(join(wtA, "a-only.txt"), "a\n");
  writeFileSync(join(wtB, "shared.txt"), "B edit\n");
  writeFileSync(join(wtB, "b-only.txt"), "b\n");
});

afterEach(() => rmSync(base, { recursive: true, force: true }));

function ctxWith(onRebase: () => { code: number; stderr: string }): Ctx {
  const member = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: n === 102 ? "main" : "b102", headRefOid: `sha${n}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const exec: Exec = async (argv, opts) => {
    if (argv[0] !== "gh") return realExec(argv, opts);
    const a = argv.join(" ");
    if (a.startsWith("gh repo view")) return { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r" }), stderr: "" };
    if (argv.some((x) => x.startsWith("query="))) {
      const nodes = [102, 103].map((n, i) => ({ position: i + 1, pullRequest: member(n) }));
      const repository = { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 1 }, stack: { size: 2, entries: { nodes } } } };
      return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
    }
    if (a === "gh stack rebase") {
      const r = onRebase();
      return { code: r.code, stdout: "", stderr: r.stderr };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { exec, root: repo, slug: { owner: "o", name: "r" }, worktrees: [] };
}

const stashShas = async () => (await git(repo, "stash", "list", "--format=%H")).split("\n").filter(Boolean);
const read = (dir: string, f: string) => readFileSync(join(dir, f), "utf8");

describe("rebaseStack stash/restore with real git", () => {
  test("each worktree gets only its own changes back, and its stash is dropped", async () => {
    await rebaseStack(ctxWith(() => ({ code: 0, stderr: "" })), 102, { stash: true, label: "j1" });
    expect(read(wtA, "shared.txt")).toBe("A edit\n");
    expect(existsSync(join(wtA, "a-only.txt"))).toBe(true);
    expect(existsSync(join(wtA, "b-only.txt"))).toBe(false);
    expect(read(wtB, "shared.txt")).toBe("B edit\n");
    expect(existsSync(join(wtB, "b-only.txt"))).toBe(true);
    expect(existsSync(join(wtB, "a-only.txt"))).toBe(false);
    expect(await stashShas()).toEqual([]);
  });

  test("a restore that conflicts is left in place by sha, the others are still restored, nothing crosses worktrees", async () => {
    // the rebase "moves" B's file after it was stashed, so applying B's stash is refused
    const ctx = ctxWith(() => {
      writeFileSync(join(wtB, "shared.txt"), "changed during rebase\n");
      return { code: 0, stderr: "" };
    });
    const e = (await rebaseStack(ctx, 102, { stash: true, label: "j1" }).catch((x: unknown) => x)) as StkError;
    const sha = /stash ([0-9a-f]{40}), kept in git stash/.exec(e.message)?.[1];
    expect(e.message).toContain(`${wtB} (stash ${sha}`);
    expect(e.message).not.toContain(wtA);
    // B: its own stash is still stashed and its tracked edit was not applied; nothing of A's leaked in
    expect(await stashShas()).toEqual([sha!]);
    expect(read(wtB, "shared.txt")).toBe("changed during rebase\n");
    // (git restores a stash's untracked files before it refuses the tracked ones: B's own file, never A's)
    expect(existsSync(join(wtB, "a-only.txt"))).toBe(false);
    // A: restored with only its own changes
    expect(read(wtA, "shared.txt")).toBe("A edit\n");
    expect(existsSync(join(wtA, "a-only.txt"))).toBe(true);
    // the kept stash is B's: it holds B's file content
    expect(await git(repo, "show", `${sha}:shared.txt`)).toBe("B edit");
  });

  test("a failed rebase still restores every worktree", async () => {
    const e = (await rebaseStack(ctxWith(() => ({ code: 1, stderr: "✗ boom" })), 102, { stash: true, label: "j1" }).catch((x: unknown) => x)) as StkError;
    expect(e.message).toBe("Rebase stack failed: boom");
    expect(read(wtA, "shared.txt")).toBe("A edit\n");
    expect(read(wtB, "shared.txt")).toBe("B edit\n");
    expect(await stashShas()).toEqual([]);
  });
});
