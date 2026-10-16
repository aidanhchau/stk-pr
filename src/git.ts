import { join } from "node:path";
import { StkError, type Exec, type Worktree } from "./types";

export async function git(exec: Exec, cwd: string, args: string[]) {
  return exec(["git", ...args], { cwd });
}

export async function gitOk(exec: Exec, cwd: string, args: string[]): Promise<string> {
  const r = await git(exec, cwd, args);
  if (r.code !== 0) {
    throw new StkError(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`, "git-failed");
  }
  return r.stdout.trim();
}

/** Parse `git worktree list --porcelain`. Prunable (stale) worktrees are dropped. */
export function parseWorktrees(porcelain: string): Worktree[] {
  const out: Worktree[] = [];
  for (const block of porcelain.split(/\n\s*\n/)) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter(Boolean);
    if (lines.length === 0) continue;
    let path = "";
    let head = "";
    let branch: string | null = null;
    let bare = false;
    let prunable = false;
    for (const line of lines) {
      if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
      else if (line.startsWith("HEAD ")) head = line.slice("HEAD ".length);
      else if (line.startsWith("branch ")) branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
      else if (line === "bare") bare = true;
      else if (line === "prunable" || line.startsWith("prunable ")) prunable = true;
      // "detached" -> branch stays null; "locked [reason]" is irrelevant here.
    }
    if (!path || prunable) continue;
    out.push({ path, branch, head, bare });
  }
  return out;
}

export async function listWorktrees(exec: Exec, repoDir: string): Promise<Worktree[]> {
  return parseWorktrees(await gitOk(exec, repoDir, ["worktree", "list", "--porcelain"]));
}

export function worktreeForBranch(worktrees: Worktree[], branch: string): Worktree | null {
  return worktrees.find((w) => !w.bare && w.branch === branch) ?? null;
}

/** Where a PR branch can be worked on: checked out under its own name, or in a worktree whose detached HEAD sits at its tip. */
export type WorktreeLookup = { kind: "branch"; worktree: Worktree } | { kind: "detached"; worktree: Worktree } | { kind: "none" };

/**
 * Find a worktree holding `branch`. Agents leave worktrees on a detached HEAD, so a worktree detached exactly at `tip`
 * (the branch's current remote tip) counts as having the branch. A detached worktree at any other commit is ignored.
 */
export function resolveWorktree(worktrees: Worktree[], branch: string, tip: string): WorktreeLookup {
  const own = worktreeForBranch(worktrees, branch);
  if (own) return { kind: "branch", worktree: own };
  const detached = worktrees.find((w) => !w.bare && w.branch === null && w.head === tip);
  return detached ? { kind: "detached", worktree: detached } : { kind: "none" };
}

export async function repoRoot(exec: Exec, cwd: string): Promise<string> {
  const r = await git(exec, cwd, ["rev-parse", "--show-toplevel"]);
  if (r.code !== 0) throw new StkError(`not a git repository: ${cwd}`, "not-a-repo");
  return r.stdout.trim();
}

/** Remote tip of `branch` on origin, or null if the branch does not exist there. */
export async function remoteSha(exec: Exec, cwd: string, branch: string): Promise<string | null> {
  const ref = `refs/heads/${branch}`;
  const out = await gitOk(exec, cwd, ["ls-remote", "origin", ref]);
  for (const line of out.split("\n")) {
    const [sha, name] = line.split(/\s+/);
    if (sha && name === ref) return sha;
  }
  return null;
}

export async function isClean(exec: Exec, cwd: string): Promise<boolean> {
  return (await gitOk(exec, cwd, ["status", "--porcelain"])) === "";
}

export async function headSha(exec: Exec, cwd: string): Promise<string> {
  return gitOk(exec, cwd, ["rev-parse", "HEAD"]);
}

/** Fetch only; never checks anything out. */
export async function fetchBranches(exec: Exec, cwd: string, branches: string[]): Promise<void> {
  if (branches.length === 0) return;
  await gitOk(exec, cwd, ["fetch", "origin", ...branches]);
}

async function rebaseIn(exec: Exec, dir: string, branch: string, onto: string, upstream: string): Promise<string> {
  const r = await git(exec, dir, ["rebase", "--onto", onto, upstream, branch]);
  if (r.code !== 0) {
    const files = (await git(exec, dir, ["diff", "--name-only", "--diff-filter=U"])).stdout
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    await git(exec, dir, ["rebase", "--abort"]);
    throw new StkError(
      `rebase of ${branch} onto ${onto} conflicted (aborted); conflicted files: ${files.join(", ") || "(unknown)"}`,
      "rebase-conflict",
    );
  }
  return headSha(exec, dir);
}

/**
 * `git rebase --onto <onto> <upstream> <branch>`. If `branch` is checked out in a worktree
 * (found via `cwd`'s worktree list) it is used and must be clean; otherwise a temporary
 * worktree under `<repo>/../.stk-tmp/<branch>` is used and always removed. Returns the new tip.
 */
export async function rebaseOnto(
  exec: Exec,
  cwd: string,
  branch: string,
  onto: string,
  upstream: string,
  expectedTip: string,
): Promise<string> {
  const worktrees = await listWorktrees(exec, cwd);
  const existing = worktreeForBranch(worktrees, branch);
  if (existing) {
    if (!(await isClean(exec, existing.path))) {
      throw new StkError(`worktree ${existing.path} has uncommitted changes; refusing to rebase ${branch}`, "dirty-worktree");
    }
    const tip = await headSha(exec, existing.path);
    if (tip !== expectedTip) {
      throw new StkError(`${branch} is at ${tip} but expected ${expectedTip}; refusing to rebase`, "diverged");
    }
    return rebaseIn(exec, existing.path, branch, onto, upstream);
  }

  const main = worktrees[0]?.path ?? (await repoRoot(exec, cwd));
  const tmp = join(main, "..", ".stk-tmp", branch);
  const local = await localTip(exec, main, branch);
  if (local && local !== expectedTip && (await git(exec, main, ["merge-base", "--is-ancestor", local, expectedTip])).code !== 0) {
    throw new StkError(`local ${branch} (${local}) is not an ancestor of expected ${expectedTip}; refusing to rebase`, "diverged");
  }
  // Always start from the expected SHA; a stale local ref is reset to it by `checkout -B`.
  await gitOk(exec, main, ["worktree", "add", "--detach", tmp, expectedTip]);
  try {
    await gitOk(exec, tmp, ["checkout", "-B", branch]);
    return await rebaseIn(exec, tmp, branch, onto, upstream);
  } finally {
    await git(exec, main, ["worktree", "remove", "--force", tmp]);
  }
}

async function localTip(exec: Exec, cwd: string, branch: string): Promise<string | null> {
  const r = await git(exec, cwd, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Verify, before any plan step runs, that restacking `branch` cannot lose commits. Fetches the
 * branch; origin must still be at `expectedRemoteSha` (`lease-rejected` otherwise). The local tip
 * (the worktree's HEAD, else `refs/heads/<branch>`) must equal it, or be a strict ancestor, in
 * which case it is fast-forwarded. Ahead/diverged local state throws `diverged`. No local branch is fine.
 * `dir` is the worktree path when the branch is checked out, else the main repo dir.
 */
export async function preflightBranch(
  exec: Exec,
  dir: string,
  branch: string,
  expectedRemoteSha: string,
  worktree: string | null,
): Promise<void> {
  await fetchBranches(exec, dir, [branch]);
  const r = await git(exec, dir, ["rev-parse", "--verify", "--quiet", `refs/remotes/origin/${branch}`]);
  const remote = r.code === 0 ? r.stdout.trim() : null;
  if (remote !== expectedRemoteSha) {
    throw new StkError(
      `origin/${branch} is ${remote ?? "missing"} but the plan recorded ${expectedRemoteSha}; the PR moved since planning`,
      "lease-rejected",
    );
  }
  const tip = worktree ? await headSha(exec, worktree) : await localTip(exec, dir, branch);
  if (tip === null || tip === expectedRemoteSha) return;
  if ((await git(exec, dir, ["merge-base", "--is-ancestor", tip, expectedRemoteSha])).code !== 0) {
    throw new StkError(
      `local ${branch} (${tip}) is ahead of or diverged from origin/${branch} (${expectedRemoteSha}); push or reconcile it first`,
      "diverged",
    );
  }
  if (worktree) {
    if (!(await isClean(exec, worktree))) {
      throw new StkError(`worktree ${worktree} has uncommitted changes; refusing to restack ${branch}`, "dirty-worktree");
    }
    await gitOk(exec, worktree, ["merge", "--ff-only", expectedRemoteSha]);
  } else {
    await gitOk(exec, dir, ["update-ref", `refs/heads/${branch}`, expectedRemoteSha, tip]);
  }
}

/**
 * Push `branch` leased against `expectedRemoteSha`, then verify origin now equals the local tip.
 * The pushed ref is HEAD when `cwd` has `branch` checked out, else `refs/heads/<branch>`
 * (branches restacked in a temporary worktree). Returns the new sha.
 */
export async function leasedPush(
  exec: Exec,
  cwd: string,
  branch: string,
  expectedRemoteSha: string,
): Promise<string> {
  const current = (await git(exec, cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
  const src = current === branch ? "HEAD" : `refs/heads/${branch}`;
  const local = await gitOk(exec, cwd, ["rev-parse", src]);
  const r = await git(exec, cwd, [
    "push",
    `--force-with-lease=refs/heads/${branch}:${expectedRemoteSha}`,
    "origin",
    `${src}:refs/heads/${branch}`,
  ]);
  if (r.code !== 0) {
    throw new StkError(`push of ${branch} rejected (remote moved from ${expectedRemoteSha}?): ${r.stderr.trim()}`, "lease-rejected");
  }
  const remote = await remoteSha(exec, cwd, branch);
  if (remote !== local) {
    throw new StkError(`after push, origin/${branch} is ${remote ?? "missing"} but local is ${local}`, "lease-rejected");
  }
  return local;
}
