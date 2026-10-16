/**
 * Rebase the open members of a native stack onto the trunk in a throwaway detached checkout, and push them with leases.
 *
 * GitHub exposes no API for "Rebase stack", so it is done locally with plain git, never in a checkout the user (or an
 * agent) owns: a temporary worktree under the OS temp dir is created detached, every member's remote head is rebased in
 * it bottom-up, and the new tips are pushed atomically with `--force-with-lease` against the heads the stack was read at.
 * The user's worktrees, branches and stashes are never touched.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git, gitOk, listWorktrees, remoteSha, resolveWorktree, worktreeForBranch } from "./git";
import { loadProvenance, recordProvenance } from "./provenance";
import { StkError, type Exec } from "./types";

/** An open stack member as the stack was read: its remote head is what the rebase starts from and the push is leased against. */
export interface RestackMember {
  number: number;
  branch: string;
  headSha: string;
}

export interface RestackInput {
  trunk: string;
  /** Open members, bottom to top. */
  members: RestackMember[];
  /**
   * What the bottom member sits on: the head SHA of the merged PR below it (a squash merge leaves its commits in the
   * bottom's history), or `null` when it is based on a live branch (`baseRef`, fetched from origin).
   */
  mergedBaseSha: string | null;
  baseRef: string;
  /** Heads these branches had on origin before earlier restacks of the same run: local tips at or below them are published, not unpushed work. */
  knownHeads?: Record<string, string[]>;
  /** Repo key (see `provenanceKey`): heads replaced by a restack are remembered under it, and later preflights trust them. */
  provenanceKey?: string;
}

/** A local checkout of a member's branch that is now behind origin. */
export interface BehindCheckout {
  path: string;
  branch: string;
}

export interface RestackResult {
  /** The head of every member after the rebase (unchanged for a member that needed nothing). */
  heads: Record<number, string>;
  /** Members whose branch was rewritten and pushed. */
  pushed: number[];
  /** Local worktrees holding a pushed branch: they were left alone and now differ from origin. */
  behind: BehindCheckout[];
}

/**
 * Config pinned for every git command run in the temporary checkout, so the user's own settings cannot change what it does:
 * no hooks, no `rebase.updateRefs` (it would move local branches pointing at replayed commits), no autosquash/autostash,
 * no commit signing.
 */
const GIT_CONFIG = [
  "-c", "core.hooksPath=/dev/null",
  "-c", "rebase.updateRefs=false",
  "-c", "rebase.autoSquash=false",
  "-c", "rebase.autoStash=false",
  "-c", "commit.gpgSign=false",
];
const remoteRef = (branch: string) => `refs/remotes/origin/${branch}`;

async function revParse(exec: Exec, cwd: string, rev: string): Promise<string | null> {
  const r = await git(exec, cwd, ["rev-parse", "--verify", "--quiet", rev]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

async function fetchRefs(exec: Exec, root: string, branches: string[]): Promise<void> {
  await gitOk(exec, root, ["fetch", "--no-tags", "origin", ...[...new Set(branches)].map((b) => `+refs/heads/${b}:${remoteRef(b)}`)]);
}

/**
 * Read-only prerequisites, checked before anything merges or is rewritten: fetch the refs, every member's origin head must
 * still be the one the stack was read at (`lease-rejected`), and no local branch of a member may hold commits that are not
 * on that head (`diverged`): force-pushing would orphan them. Dirty or live worktrees are none of its business.
 */
export async function preflightRestack(exec: Exec, root: string, input: RestackInput): Promise<void> {
  await fetchRefs(exec, root, [input.trunk, ...input.members.map((m) => m.branch), ...(input.mergedBaseSha ? [] : [input.baseRef])]);
  const worktrees = await listWorktrees(exec, root);
  const provenance = input.provenanceKey ? loadProvenance(input.provenanceKey) : new Map<string, string[]>();
  for (const [i, m] of input.members.entries()) {
    const remote = await revParse(exec, root, remoteRef(m.branch));
    if (remote !== m.headSha) {
      throw new StkError(`origin/${m.branch} is ${remote ?? "missing"} but the stack was read at ${m.headSha}; #${m.number} moved, so nothing was rebased`, "lease-rejected");
    }
    // the rebase replays only what sits above the old parent tip: the member must really contain it, or superseded
    // parent commits (an amended or force-pushed parent) would be resurrected in the member
    const below = i === 0 ? { what: "the merged PR below it", sha: input.mergedBaseSha } : { what: `#${input.members[i - 1]!.number}`, sha: input.members[i - 1]!.headSha };
    if (below.sha && (await git(exec, root, ["merge-base", "--is-ancestor", below.sha, m.headSha])).code !== 0) {
      throw new StkError(
        `#${m.number} (${m.branch}) does not contain the current head of ${below.what} (${below.sha.slice(0, 9)}): that branch was amended or force-pushed after #${m.number} was based on it; rebase #${m.number} onto it manually first`,
        "not-linear",
      );
    }
    const local = await revParse(exec, root, `refs/heads/${m.branch}`);
    if (local === null || local === m.headSha) continue;
    // a local tip that is (an ancestor of) the origin head is published history, not unpushed work
    if ((await git(exec, root, ["merge-base", "--is-ancestor", local, m.headSha])).code === 0) continue;
    const unpublished = await unpublishedCommits(exec, root, input, m, local, provenance.get(m.branch) ?? []);
    if (unpublished !== 0) {
      const wt = worktreeForBranch(worktrees, m.branch);
      const count = unpublished === null ? "" : `${unpublished} unpublished, `;
      throw new StkError(
        `${wt ? `worktree ${wt.path}` : "this repo"} has unpushed commits on ${m.branch} (${count}local ${local.slice(0, 9)}, origin ${m.headSha.slice(0, 9)}); push or move them first, rebasing #${m.number} would orphan them`,
        "diverged",
      );
    }
  }
}

/**
 * Every value the remote-tracking ref has had according to its reflog. `git reflog` prints only the new value of each
 * entry, which misses the one a first fetch overwrote, so the log file's old values are read as well.
 */
async function reflogHeads(exec: Exec, root: string, ref: string): Promise<string[]> {
  const shown = await git(exec, root, ["reflog", "--format=%H", ref]);
  const heads = shown.code === 0 ? shown.stdout.split("\n").map((s) => s.trim()) : [];
  const path = await git(exec, root, ["rev-parse", "--path-format=absolute", "--git-path", `logs/${ref}`]);
  if (path.code === 0 && path.stdout.trim()) {
    try {
      for (const line of readFileSync(path.stdout.trim(), "utf8").split("\n")) heads.push(...line.split(/\s+/, 2));
    } catch {
      /* no log: nothing more to learn */
    }
  }
  return heads;
}

/** The candidates that exist as commits here: one `git cat-file --batch-check` for all of them. */
async function existingCommits(exec: Exec, root: string, candidates: string[]): Promise<string[]> {
  const shas = [...new Set(candidates.filter((s) => /^[0-9a-f]{40,64}$/.test(s)))];
  if (shas.length === 0) return [];
  const r = await exec(["git", "cat-file", "--batch-check"], { cwd: root, stdin: `${shas.join("\n")}\n` });
  if (r.code !== 0) return [];
  return r.stdout.split("\n").map((l) => l.split(" ")).filter((p) => p[1] === "commit" && p[0] !== undefined).map((p) => p[0]!);
}

/** Local commits not reachable from any of `tips`, or `null` when git cannot say. */
async function commitsOutside(exec: Exec, root: string, local: string, tips: string[]): Promise<string[] | null> {
  const r = await git(exec, root, ["rev-list", local, "--not", ...tips]);
  return r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : null;
}

/**
 * How many commits of the local branch are not verifiably published, or `null` when that cannot be told. Only reachability
 * clears a commit: it must be in the history of a head this branch had on origin (this run's `knownHeads`, the persisted
 * provenance of earlier jobs, or, only when those are not enough, the remote-tracking ref's reflog). Patch equivalence
 * is deliberately not evidence: it can match unpublished work.
 */
async function unpublishedCommits(exec: Exec, root: string, input: RestackInput, m: RestackMember, local: string, persisted: string[]): Promise<number | null> {
  const known = Object.hasOwn(input.knownHeads ?? {}, m.branch) ? input.knownHeads![m.branch]! : [];
  const tips = [m.headSha, ...(await existingCommits(exec, root, [...known, ...persisted]))];
  const left = await commitsOutside(exec, root, local, tips);
  if (left === null || left.length === 0) return left === null ? null : 0;
  const fromReflog = (await existingCommits(exec, root, await reflogHeads(exec, root, remoteRef(m.branch)))).filter((s) => !tips.includes(s));
  if (fromReflog.length === 0) return left.length;
  return (await commitsOutside(exec, root, local, [...tips, ...fromReflog]))?.length ?? left.length;
}

async function conflictedFiles(exec: Exec, cwd: string): Promise<string[]> {
  const r = await git(exec, cwd, ["diff", "--name-only", "--diff-filter=U"]);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** Text for the places that report a finished rebase: which local checkouts now differ from origin. */
export function behindText(behind: BehindCheckout[]): string | undefined {
  if (behind.length === 0) return undefined;
  return `local checkouts now behind origin (left untouched): ${behind.map((b) => `${b.path} (${b.branch})`).join(", ")}; update them with git pull --rebase`;
}

/**
 * Rebase every member onto the trunk's tip in a temporary detached worktree, then push the changed ones with one atomic
 * leased push. A conflict aborts the rebase and throws `rebase-conflict` with nothing pushed; a moved remote makes the
 * push fail (`lease-rejected`) with nothing overwritten. The temporary worktree is always removed.
 */
export async function restackAndPush(exec: Exec, root: string, input: RestackInput, onStep?: (what: string) => void): Promise<RestackResult> {
  onStep?.("fetching");
  await preflightRestack(exec, root, input);
  const trunkTip = await revParse(exec, root, remoteRef(input.trunk));
  if (!trunkTip) throw new StkError(`origin/${input.trunk} is missing`, "git-failed");
  const bottomBase = input.mergedBaseSha ?? (await revParse(exec, root, remoteRef(input.baseRef)));
  if (!bottomBase) throw new StkError(`origin/${input.baseRef} is missing`, "git-failed");

  const heads: Record<number, string> = {};
  const changed: { member: RestackMember; sha: string }[] = [];
  const tmp = mkdtempSync(join(tmpdir(), "stk-rebase-"));
  try {
    await gitOk(exec, root, [...GIT_CONFIG, "worktree", "add", "--detach", tmp, trunkTip]);
    let newBase = trunkTip;
    let oldBase = bottomBase;
    for (const m of input.members) {
      onStep?.(`rebasing #${m.number}`);
      await gitOk(exec, tmp, [...GIT_CONFIG, "checkout", "--detach", m.headSha]);
      const r = await git(exec, tmp, [...GIT_CONFIG, "rebase", "--no-autostash", "--onto", newBase, oldBase]);
      if (r.code !== 0) {
        const files = await conflictedFiles(exec, tmp);
        await git(exec, tmp, ["rebase", "--abort"]);
        if (files.length === 0) throw new StkError(`rebase of #${m.number} (${m.branch}) failed: ${r.stderr.trim() || r.stdout.trim()}`, "git-failed");
        throw new StkError(`rebase of #${m.number} (${m.branch}) conflicted and was aborted; conflicted files: ${files.join(", ")}`, "rebase-conflict");
      }
      const tip = await gitOk(exec, tmp, ["rev-parse", "HEAD"]);
      heads[m.number] = tip;
      if (tip !== m.headSha) changed.push({ member: m, sha: tip });
      // the next member sat on this one's old head and now goes on its new tip
      oldBase = m.headSha;
      newBase = tip;
    }

    if (changed.length > 0) {
      onStep?.("pushing");
      const push = await git(exec, root, [
        ...GIT_CONFIG,
        "push",
        "--atomic",
        ...changed.map((c) => `--force-with-lease=refs/heads/${c.member.branch}:${c.member.headSha}`),
        "origin",
        ...changed.map((c) => `${c.sha}:refs/heads/${c.member.branch}`),
      ]);
      if (push.code !== 0) {
        throw new StkError(`push rejected, nothing was overwritten (a branch moved since the stack was read?): ${push.stderr.trim() || push.stdout.trim()}`, "lease-rejected");
      }
    }
  } finally {
    await git(exec, root, ["worktree", "remove", "--force", tmp]);
    rmSync(tmp, { recursive: true, force: true });
    await git(exec, root, ["worktree", "prune"]);
  }

  // verify what landed on origin before anyone trusts eventually-consistent API reads
  for (const c of changed) {
    const remote = await remoteSha(exec, root, c.member.branch);
    if (remote !== c.sha) throw new StkError(`after the push, origin/${c.member.branch} is ${remote ?? "missing"} but the rebased head is ${c.sha}`, "lease-rejected");
  }
  // the heads just replaced are published history: remember them for later jobs (see provenance.ts)
  if (input.provenanceKey) recordProvenance(input.provenanceKey, changed.map((c) => ({ branch: c.member.branch, sha: c.member.headSha })));
  const worktrees = await listWorktrees(exec, root);
  const behind: BehindCheckout[] = [];
  for (const c of changed) {
    const found = resolveWorktree(worktrees, c.member.branch, c.member.headSha);
    if (found.kind !== "none") behind.push({ path: found.worktree.path, branch: c.member.branch });
  }
  return { heads, pushed: changed.map((c) => c.member.number), behind };
}
