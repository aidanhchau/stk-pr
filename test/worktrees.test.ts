import { describe, expect, test } from "bun:test";
import { resolveWorktree } from "../src/git";
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
