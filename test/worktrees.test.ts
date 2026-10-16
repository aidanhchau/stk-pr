import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec } from "../src/exec";
import { attachBranch, resolveWorktree } from "../src/git";
import type { Worktree } from "../src/types";

const wt = (path: string, branch: string | null, head: string, bare = false): Worktree => ({ path, branch, head, bare });

describe("resolveWorktree", () => {
  const TIP = "a".repeat(40);

  test("a worktree with the branch checked out wins", () => {
    const r = resolveWorktree([wt("/repo", "main", "m"), wt("/agent", null, TIP), wt("/own", "feat", "old")], "feat", TIP);
    expect(r).toEqual({ kind: "branch", worktree: wt("/own", "feat", "old") });
  });

  test("a worktree detached exactly at the branch tip counts as having the branch", () => {
    const r = resolveWorktree([wt("/repo", "main", "m"), wt("/agent", null, TIP)], "feat", TIP);
    expect(r).toEqual({ kind: "detached", worktree: wt("/agent", null, TIP) });
  });

  test("a detached worktree at another commit, another branch at the tip, and a bare repo do not count", () => {
    const wts = [wt("/bare", null, TIP, true), wt("/stale", null, "b".repeat(40)), wt("/other", "other", TIP)];
    expect(resolveWorktree(wts, "feat", TIP)).toEqual({ kind: "none" });
  });

  test("no worktrees at all", () => {
    expect(resolveWorktree([], "feat", TIP)).toEqual({ kind: "none" });
  });
});

describe("attachBranch", () => {
  let base: string;
  let repo: string;
  let agent: string;
  const git = async (cwd: string, ...args: string[]) => {
    const r = await realExec(["git", ...args], { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };

  beforeEach(async () => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "stk-attach-")));
    repo = join(base, "repo");
    agent = join(base, "agent");
    await realExec(["git", "init", "-q", "-b", "main", repo]);
    await git(repo, "config", "user.email", "t@t");
    await git(repo, "config", "user.name", "t");
    writeFileSync(join(repo, "a.txt"), "1\n");
    await git(repo, "add", ".");
    await git(repo, "commit", "-qm", "one");
    await git(repo, "branch", "feat");
    // the agent worktree: detached at feat's tip, with a local edit that must survive
    await git(repo, "worktree", "add", "-q", "--detach", agent, "feat");
    await git(repo, "branch", "-D", "feat");
    writeFileSync(join(agent, "wip.txt"), "wip\n");
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  test("creates the branch at the detached HEAD when it does not exist locally, keeping uncommitted work", async () => {
    const tip = await git(agent, "rev-parse", "HEAD");
    await attachBranch(realExec, agent, "feat", tip);
    expect(await git(agent, "branch", "--show-current")).toBe("feat");
    expect(await git(agent, "rev-parse", "HEAD")).toBe(tip);
    expect(await git(agent, "status", "--porcelain")).toBe("?? wip.txt");
  });

  test("switches to an existing local branch that is already at the tip", async () => {
    const tip = await git(agent, "rev-parse", "HEAD");
    await git(repo, "branch", "feat", tip);
    await attachBranch(realExec, agent, "feat", tip);
    expect(await git(agent, "branch", "--show-current")).toBe("feat");
  });

  test("moves a local branch that is only behind the tip, and refuses one with commits origin does not have", async () => {
    const old = await git(agent, "rev-parse", "HEAD");
    await git(repo, "branch", "feat", old);
    writeFileSync(join(agent, "b.txt"), "2\n");
    await git(agent, "add", "b.txt");
    await git(agent, "commit", "-qm", "two");
    const tip = await git(agent, "rev-parse", "HEAD");
    await attachBranch(realExec, agent, "feat", tip);
    expect(await git(agent, "rev-parse", "feat")).toBe(tip);

    // a local branch with its own commit, detached worktree elsewhere: attaching would lose it
    await git(agent, "switch", "--detach", old);
    await git(repo, "branch", "-f", "feat", tip);
    await expect(attachBranch(realExec, agent, "feat", old)).rejects.toThrow(/has commits that are not on origin/);
  });
});
