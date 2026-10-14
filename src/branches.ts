/** Local branch topology for creating PRs and stacks: nearest parent, commit subjects, push state, empty retrigger commit. */
import { remoteSha, headSha, leasedPush } from "./git";
import { StkError, type Exec } from "./types";

const git = (exec: Exec, cwd: string, args: string[]) => exec(["git", ...args], { cwd });

async function gitOk(exec: Exec, cwd: string, args: string[]): Promise<string> {
  const r = await git(exec, cwd, args);
  if (r.code !== 0) throw new StkError(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`, "git-failed");
  return r.stdout.trim();
}

/** Short name of the checked-out branch in `dir`; null when detached. */
export async function currentBranch(exec: Exec, dir: string): Promise<string | null> {
  const r = await git(exec, dir, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

async function refSha(exec: Exec, dir: string, ref: string): Promise<string | null> {
  const r = await git(exec, dir, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** Tip of a branch as the user has it: the local branch, else `origin/<name>`. */
export async function localTipOf(exec: Exec, dir: string, name: string): Promise<string | null> {
  return (await refSha(exec, dir, `refs/heads/${name}`)) ?? (await refSha(exec, dir, `refs/remotes/origin/${name}`));
}

/** Tip of a branch as GitHub has it (last fetch): `origin/<name>`, else the local branch. */
export async function remoteTipOf(exec: Exec, dir: string, name: string): Promise<string | null> {
  return (await refSha(exec, dir, `refs/remotes/origin/${name}`)) ?? (await refSha(exec, dir, `refs/heads/${name}`));
}

export async function localBranches(exec: Exec, dir: string): Promise<string[]> {
  const out = await gitOk(exec, dir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

async function isAncestor(exec: Exec, dir: string, ancestor: string, of: string): Promise<boolean> {
  return (await git(exec, dir, ["merge-base", "--is-ancestor", ancestor, of])).code === 0;
}

/**
 * The branch `branch` was cut from: among `candidates` the one whose tip is the nearest strict ancestor of `branch`'s
 * tip (fewest commits between). Candidates already merged into the trunk or at the branch's own tip never count.
 * Null when none qualifies: the branch sits directly on the trunk. Ties go to `prefer`red names, then alphabetical.
 */
export async function nearestParent(
  exec: Exec,
  dir: string,
  branch: string,
  trunk: string,
  candidates: { name: string; prefer?: boolean }[],
): Promise<string | null> {
  const tip = await localTipOf(exec, dir, branch);
  if (!tip) throw new StkError(`no such branch: ${branch}`, "usage");
  const trunkTip = await remoteTipOf(exec, dir, trunk);
  let best: { name: string; count: number; prefer: boolean } | null = null;
  for (const c of candidates) {
    if (c.name === branch || c.name === trunk) continue;
    const cTip = await localTipOf(exec, dir, c.name);
    if (!cTip || cTip === tip) continue;
    if (!(await isAncestor(exec, dir, cTip, tip))) continue;
    if (trunkTip && (await isAncestor(exec, dir, cTip, trunkTip))) continue;
    const count = Number(await gitOk(exec, dir, ["rev-list", "--count", `${cTip}..${tip}`]));
    const prefer = c.prefer === true;
    const better = !best || count < best.count || (count === best.count && (prefer && !best.prefer || (prefer === best.prefer && c.name < best.name)));
    if (better) best = { name: c.name, count, prefer };
  }
  return best?.name ?? null;
}

/** Commit subjects of `base..branch`, oldest first; `base` is read as GitHub has it (origin first). */
export async function commitSubjects(exec: Exec, dir: string, base: string, branch: string): Promise<string[]> {
  const baseTip = await remoteTipOf(exec, dir, base);
  const tip = await localTipOf(exec, dir, branch);
  if (!baseTip || !tip) throw new StkError(`cannot compare ${base} with ${branch}: unknown branch`, "usage");
  const out = await gitOk(exec, dir, ["log", "--reverse", "--format=%s", `${baseTip}..${tip}`]);
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

export type PushKind = "none" | "new" | "update";

/** Whether origin lacks `branch` (`new`), is behind it (`update`, fast-forward) or matches it (`none`). Diverged throws. */
export async function pushKind(exec: Exec, dir: string, branch: string): Promise<PushKind> {
  const local = await localTipOf(exec, dir, branch);
  if (!local) throw new StkError(`no such branch: ${branch}`, "usage");
  const remote = await remoteSha(exec, dir, branch);
  if (remote === null) return "new";
  if (remote === local) return "none";
  if (await isAncestor(exec, dir, remote, local)) return "update";
  throw new StkError(`origin/${branch} has commits ${branch} does not (or is not fetched); reconcile before creating a PR`, "diverged");
}

/** `git push -u origin <branch>` (fast-forward only). */
export async function pushBranch(exec: Exec, dir: string, branch: string): Promise<void> {
  const ref = `refs/heads/${branch}`;
  await gitOk(exec, dir, ["push", "-u", "origin", `${ref}:${ref}`]);
}

export const RETRIGGER_MESSAGE = "ci: retrigger checks";

/**
 * Commit an empty "ci: retrigger checks" on `branch` in its worktree and push it with a lease on `expectedSha`.
 * Refuses unless the worktree has `branch` checked out at exactly `expectedSha` (the PR head) with nothing staged.
 */
export async function pushEmptyCommit(exec: Exec, worktree: string, branch: string, expectedSha: string): Promise<string> {
  const cur = await currentBranch(exec, worktree);
  if (cur !== branch) throw new StkError(`${worktree} has ${cur ?? "a detached HEAD"} checked out, not ${branch}`, "not-a-repo");
  const head = await headSha(exec, worktree);
  if (head !== expectedSha) {
    throw new StkError(`local ${branch} (${head.slice(0, 9)}) is not the PR head (${expectedSha.slice(0, 9)}); push or pull it first`, "diverged");
  }
  if ((await git(exec, worktree, ["diff", "--cached", "--quiet"])).code !== 0) {
    throw new StkError(`${worktree} has staged changes; commit or unstage them first`, "dirty-worktree");
  }
  await gitOk(exec, worktree, ["commit", "--allow-empty", "-m", RETRIGGER_MESSAGE]);
  return leasedPush(exec, worktree, branch, expectedSha);
}
