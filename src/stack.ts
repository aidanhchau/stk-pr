import { fetchBranches, isClean, leasedPush, preflightBranch, rebaseOnto, worktreeForBranch } from "./git";
import {
  StkError,
  type Blocker,
  type Exec,
  type MergeMethod,
  type RepoRules,
  type MergeProgress,
  type PlanStep,
  type PullRequest,
  type Stack,
  type StepResult,
  type Worktree,
} from "./types";

/** A PR with more than one open child PR stacked on its head branch. */
export interface Fork {
  parent: number;
  children: number[];
}

/** Minimum a PR needs to take part in stack detection (light `listPrRefs` results qualify). */
export type StackRef = Pick<PullRequest, "number" | "state" | "headRef" | "baseRef">;

interface Graph<T extends StackRef> {
  roots: T[];
  childrenOf: Map<number, T[]>;
  parentOf: Map<number, T>;
}

function graph<T extends StackRef>(prs: T[], trunk: string): Graph<T> {
  const open = prs.filter((p) => p.state === "OPEN" && p.headRef !== trunk);
  const byHead = new Map(open.map((p) => [p.headRef, p]));
  const childrenOf = new Map<number, T[]>();
  const parentOf = new Map<number, T>();
  const roots: T[] = [];
  for (const pr of open) {
    const parent = pr.baseRef === trunk ? undefined : byHead.get(pr.baseRef);
    if (parent && parent.number !== pr.number) {
      parentOf.set(pr.number, parent);
      childrenOf.set(parent.number, [...(childrenOf.get(parent.number) ?? []), pr]);
    } else if (pr.baseRef === trunk) {
      roots.push(pr);
    }
  }
  return { roots, childrenOf, parentOf };
}

/** Every root-to-leaf path of open PRs, bottom first. A forked parent appears in each path through it. */
export function buildStacks(prs: PullRequest[], trunk: string): Stack[] {
  const { roots, childrenOf } = graph(prs, trunk);
  const stacks: Stack[] = [];
  const walk = (path: PullRequest[]) => {
    const kids = (childrenOf.get(path[path.length - 1]!.number) ?? []).filter((k) => !path.includes(k));
    if (kids.length === 0) stacks.push({ trunk, prs: path });
    for (const k of kids) walk([...path, k]);
  };
  for (const r of roots) walk([r]);
  return stacks;
}

export function findForks<T extends StackRef>(prs: T[], trunk: string): Fork[] {
  const { childrenOf } = graph(prs, trunk);
  const forks: Fork[] = [];
  for (const [parent, kids] of childrenOf) {
    if (kids.length > 1) forks.push({ parent, children: kids.map((k) => k.number) });
  }
  return forks;
}

/**
 * The chain through `prNumber`: its open ancestors down to the trunk, the PR, then descendants while each has exactly one child.
 * `forks` names every PR on that chain with 2+ stacked children (where the chain stops being one line).
 */
export function chainThrough<T extends StackRef>(prs: T[], trunk: string, prNumber: number): { trunk: string; prs: T[]; forks: Fork[] } {
  const { childrenOf, parentOf } = graph(prs, trunk);
  const start = prs.find((p) => p.number === prNumber && p.state === "OPEN");
  if (!start) throw new StkError(`PR #${prNumber} is not an open PR`, "usage");

  const chain: T[] = [start];
  const seen = new Set([start.number]);
  for (let p = parentOf.get(start.number); p && !seen.has(p.number); p = parentOf.get(p.number)) {
    chain.unshift(p);
    seen.add(p.number);
  }
  for (let kids = childrenOf.get(start.number); kids && kids.length === 1 && !seen.has(kids[0]!.number); ) {
    chain.push(kids[0]!);
    seen.add(kids[0]!.number);
    kids = childrenOf.get(kids[0]!.number);
  }
  const forks = chain.flatMap((pr) => {
    const kids = childrenOf.get(pr.number) ?? [];
    return kids.length > 1 ? [{ parent: pr.number, children: kids.map((k) => k.number) }] : [];
  });
  return { trunk, prs: chain, forks };
}

/** One PR of a forked tree in display order: the PR it is stacked on (null = the trunk) and its branch depth. */
export interface TreeRow<T> {
  pr: T;
  parent: number | null;
  depth: number;
}

/**
 * Every open PR of the tree containing `prNumber` (all descendants of its root), bottom first, depth first. Children go in PR
 * number order: the first continues its parent's line (same depth), each later one starts a branch one level deeper. The order
 * depends only on the tree, so every member shows the same picture. `forks` lists each PR with 2+ children.
 */
export function treeOf<T extends StackRef>(prs: T[], trunk: string, prNumber: number): { rows: TreeRow<T>[]; forks: Fork[] } {
  const { childrenOf, parentOf } = graph(prs, trunk);
  let root = prs.find((p) => p.number === prNumber && p.state === "OPEN");
  if (!root) throw new StkError(`PR #${prNumber} is not an open PR`, "usage");
  const up = new Set([root.number]);
  for (let p = parentOf.get(root.number); p && !up.has(p.number); p = parentOf.get(p.number)) {
    up.add(p.number);
    root = p;
  }
  const rows: TreeRow<T>[] = [];
  const forks: Fork[] = [];
  const seen = new Set<number>();
  const walk = (pr: T, parent: number | null, depth: number) => {
    if (seen.has(pr.number)) return;
    seen.add(pr.number);
    rows.push({ pr, parent, depth });
    const kids = [...(childrenOf.get(pr.number) ?? [])].sort((a, b) => a.number - b.number);
    if (kids.length > 1) forks.push({ parent: pr.number, children: kids.map((k) => k.number) });
    kids.forEach((k, i) => walk(k, pr.number, depth + (i > 0 ? 1 : 0)));
  };
  walk(root, null, 0);
  return { rows, forks };
}

/** The linear chain containing `prNumber`. Throws `not-linear` if any PR on that chain has multiple children. */
export function stackFor<T extends StackRef>(prs: T[], trunk: string, prNumber: number): { trunk: string; prs: T[] } {
  const { prs: chain, forks } = chainThrough(prs, trunk, prNumber);
  const fork = forks[0];
  if (fork) {
    throw new StkError(
      `PR #${fork.parent} has ${fork.children.length} stacked children (${fork.children.map((k) => `#${k}`).join(", ")}); stack is not linear`,
      "not-linear",
    );
  }
  return { trunk, prs: chain };
}

export function blockers(pr: PullRequest, trunk: string, rules?: RepoRules | null): Blocker[] {
  const out: Blocker[] = [];
  const failing = pr.checks.filter((c) => c.state === "fail").map((c) => c.name);
  const pending = pr.checks.filter((c) => c.state === "pending").map((c) => c.name);
  if (failing.length || pending.length) out.push({ kind: "checks", failing, pending });
  // GitHub leaves reviewDecision null when the base requires no review, so only an explicit decision blocks
  if (pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED") {
    out.push({ kind: "review", decision: pr.reviewDecision });
  }
  if (pr.unresolvedThreads > 0) out.push({ kind: "threads", count: pr.unresolvedThreads });
  if (pr.isDraft) out.push({ kind: "draft" });
  if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") out.push({ kind: "conflict", base: pr.baseRef });
  // either field still unresolved means GitHub hasn't finished the conflict check (BLOCKED can come back alongside it)
  else if (pr.mergeable === "UNKNOWN" || pr.mergeState === "UNKNOWN") out.push({ kind: "checking" });
  else if (pr.mergeState === "BEHIND") out.push({ kind: "behind", count: pr.behindBy ?? null, base: pr.baseRef });
  for (const context of rules?.requiredChecks ?? []) {
    if (!pr.checks.some((c) => c.name === context)) out.push({ kind: "required-check", context });
  }
  // BLOCKED never reads as ready: when no specific reason above explains it, it is the repository rules
  if (pr.mergeState === "BLOCKED" && !out.some((b) => b.kind !== "base-not-trunk")) {
    out.push({ kind: "blocked", ...(rules?.codeOwnerReview ? { codeOwner: true } : {}) });
  }
  if (pr.baseRef !== trunk) out.push({ kind: "base-not-trunk", base: pr.baseRef });
  return out;
}

/** Blockers a hard stop for the merge itself: conflicts and drafts can never be bypassed. */
export const isHardBlocker = (b: Blocker): boolean => b.kind === "conflict" || b.kind === "draft";

/** Queue admission can wait on these conditions, but a known failing check still blocks enqueueing. */
export const isQueueDeferrableBlocker = (b: Blocker): boolean =>
  b.kind === "checks" ? b.failing.length === 0 : b.kind === "required-check" || b.kind === "blocked" || b.kind === "checking";

/**
 * Blockers of a stack member judged as if based on the trunk. A member with a parent is only ever
 * "behind" its parent's branch, which restacking/native landing resolves, so that note is dropped.
 */
export function memberBlockers(pr: PullRequest, trunk: string, hasParent: boolean, rules?: RepoRules | null): Blocker[] {
  const bs = blockers(hasParent ? { ...pr, baseRef: trunk } : pr, trunk, rules);
  return hasParent ? bs.filter((b) => b.kind !== "behind") : bs;
}

export interface PlanOptions {
  method: MergeMethod;
  force: boolean;
  /** Stop after merging this PR number (inclusive). */
  upTo?: number;
  /** Base-branch rules of the repo, including required checks and merge queue policy, when known. */
  rules?: RepoRules | null;
  /** Repo dir used for restacks/pushes of branches without a worktree. Defaults to the first worktree. */
  repoDir?: string;
}

/**
 * Bottom-up merge plan. Children are evaluated as if already retargeted to the trunk. Their check
 * blockers are ignored in normal mode because a `wait-checks` step gates them after the restack; in
 * force mode there is no wait, and the child's merge is `--admin` with a `checks` bypass. The plan
 * ends (without a step for the offending PR) at the first PR that is blocked, or that has a
 * non-bypassable blocker (conflict, draft) even with `force`; callers report `blockers()`.
 * Queue plans defer pending checks and transient mergeability to GitHub, use the queue's method without
 * a pinned head or bypass, and still stop for failing checks/review/threads even when force was requested.
 */
export function planStackMerge(stack: Stack, opts: PlanOptions, worktrees: Worktree[]): PlanStep[] {
  const { trunk, prs } = stack;
  const repoDir = opts.repoDir ?? worktrees[0]?.path ?? ".";
  const queue = opts.rules?.mergeQueue;
  const method = queue?.method ?? opts.method;
  const force = opts.force && !queue;
  const plan: PlanStep[] = [];

  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i]!;
    const parent = i > 0 ? prs[i - 1]! : null;
    const all = memberBlockers(pr, trunk, parent !== null, opts.rules);
    // Outside queues, a restacked child's checks are re-run on its new head: normal mode gates on
    // `wait-checks`, so old-head blockers are dropped. Queues still stop for known failing checks.
    const restacked = parent !== null && method !== "merge";
    const afterRestack = restacked && !force && !queue ? all.filter((b) => b.kind !== "checks") : all;
    const bypass = queue ? afterRestack.filter((b) => !isQueueDeferrableBlocker(b)) : afterRestack;
    if (bypass.length > 0 && !force) break;
    if (bypass.some(isHardBlocker)) break;
    if (restacked && force) {
      const known = bypass.find((b) => b.kind === "checks");
      const unverified: Blocker = {
        kind: "checks",
        failing: known?.kind === "checks" ? known.failing : [],
        pending: [...(known?.kind === "checks" ? known.pending : []), "checks on the restacked head (not yet verified)"],
      };
      if (known) bypass.splice(bypass.indexOf(known), 1);
      bypass.unshift(unverified);
    }

    if (parent) {
      plan.push({ kind: "retarget", pr: pr.number, from: parent.headRef, to: trunk });
      if (method !== "merge") {
        const wt = worktreeForBranch(worktrees, pr.headRef);
        plan.push({
          kind: "restack",
          pr: pr.number,
          branch: pr.headRef,
          onto: `origin/${trunk}`,
          upstream: parent.headSha,
          expectedRemoteSha: pr.headSha,
          worktree: wt?.path ?? null,
        });
        plan.push({ kind: "push", branch: pr.headRef, expectedRemoteSha: pr.headSha, cwd: wt?.path ?? repoDir });
        if (!force) plan.push({ kind: "wait-checks", pr: pr.number });
      }
    }
    // Queue requests cannot pin a head; restacked children also move before their merge.
    const sha = queue || restacked ? undefined : pr.headSha;
    plan.push({ kind: "merge", pr: pr.number, method, admin: force && bypass.length > 0, bypass, ...(sha ? { sha } : {}) });
    if (opts.upTo === pr.number) break;
  }
  return plan;
}

/**
 * Native (GitHub-tracked) stack plan: ONE merge-async call that lands the chosen PR plus every open PR
 * downstack of it, so each included PR's blockers must clear (children are judged as if based on the trunk).
 * `stack.prs` is the open native stack, bottom first; `upTo` (default: the top) is the highest PR to land.
 * Like the classic plan it stops at the first blocked PR, merging only the unblocked prefix; empty when
 * even the bottom PR is blocked. Callers report `blockers()`.
 * Queue plans follow the same enqueue policy as classic plans: queue-evaluated blockers are deferred,
 * but remaining blockers cannot be bypassed, and merge steps use the queue method without a pinned head.
 */
export function planNativeStackMerge(stack: Stack, opts: Pick<PlanOptions, "method" | "force" | "upTo" | "rules">): PlanStep[] {
  const { trunk, prs } = stack;
  const queue = opts.rules?.mergeQueue;
  const method = queue?.method ?? opts.method;
  const force = opts.force && !queue;
  const own: Blocker[][] = [];
  let last = -1;
  for (let i = 0; i < prs.length; i++) {
    const pr = prs[i]!;
    // a native stack lands on its trunk whatever each member's own base says (a stale base is flagged by the service)
    const all = memberBlockers(pr, trunk, i > 0, opts.rules).filter(
      (b) => b.kind !== "base-not-trunk" && (!queue || !isQueueDeferrableBlocker(b)),
    );
    if (all.length > 0 && !force) break;
    if (all.some(isHardBlocker)) break;
    own.push(all);
    last = i;
    if (opts.upTo === pr.number) break;
  }
  if (last < 0) return [];
  // GitHub only lets rules be bypassed on the bottom-most unmerged PR of a stack, so a PR that needs a bypass is merged
  // alone, once everything below it has landed. Runs of clean PRs between bypasses still land as one merge of their top.
  const plan: PlanStep[] = [];
  let run: number[] = [];
  const flush = () => {
    if (run.length === 0) return;
    const top = prs[run[run.length - 1]!]!;
    plan.push({ kind: "merge", pr: top.number, method, admin: false, bypass: [], ...(!queue ? { sha: top.headSha } : {}), includes: [...run].map((i) => prs[i]!.number) });
    run = [];
  };
  for (let i = 0; i <= last; i++) {
    const needs = own[i]!;
    if (needs.length === 0) {
      run.push(i);
      continue;
    }
    flush();
    const pr = prs[i]!;
    plan.push({ kind: "merge", pr: pr.number, method, admin: true, bypass: needs, sha: pr.headSha, includes: [pr.number] });
  }
  flush();
  return plan;
}

export interface GitOps {
  fetchBranches: typeof fetchBranches;
  rebaseOnto: typeof rebaseOnto;
  preflightBranch: typeof preflightBranch;
  leasedPush: typeof leasedPush;
  isClean: typeof isClean;
}

export interface GhOps {
  /** Resolves when GitHub's merge request is final; `enqueued` means only added to a merge queue. */
  merge(
    pr: number,
    method: MergeMethod,
    admin: boolean,
    extra?: { sha?: string; onProgress?: (p: MergeProgress) => void },
  ): Promise<{ status: "merged" | "enqueued"; sha?: string }>;
  retarget(pr: number, base: string): Promise<void>;
  /** Resolves when checks pass; rejects if they fail or time out. */
  waitChecks(pr: number): Promise<void>;
  /** Native stack: rebase every open PR from `pr` up onto the trunk in a temporary checkout and push with leases. Resolves to a note for the step output (local checkouts left behind), if any. */
  rebaseStack(pr: number): Promise<string | void>;
  /** Close and reopen `pr` so GitHub recomputes its (stale) mergeability. */
  refreshMergeability(pr: number): Promise<void>;
}

export interface ExecuteDeps {
  exec: Exec;
  /** Main repo dir, used for restacking branches that have no worktree. */
  repoDir: string;
  gh: GhOps;
  git?: GitOps;
  onStep?: (result: StepResult) => void;
  onProgress?: (p: MergeProgress) => void;
}

const realGit: GitOps = { fetchBranches, rebaseOnto, preflightBranch, leasedPush, isClean };

async function runStep(step: PlanStep, deps: ExecuteDeps, git: GitOps): Promise<Omit<StepResult, "step">> {
  const { exec, repoDir, gh } = deps;
  switch (step.kind) {
    case "merge": {
      const out = await gh.merge(step.pr, step.method, step.admin, {
        ...(step.sha ? { sha: step.sha } : {}),
        ...(deps.onProgress ? { onProgress: deps.onProgress } : {}),
      });
      const what = step.includes && step.includes.length > 1 ? `#${step.pr} with downstack ${step.includes.slice(0, -1).map((n) => `#${n}`).join(", ")}` : `#${step.pr}`;
      const bypassed = step.admin ? `, bypassing: ${step.bypass.map((b) => b.kind).join(", ")}` : "";
      if (out.status === "enqueued") return { ok: true, enqueued: true, detail: `enqueued ${what} in the merge queue (not merged yet)${bypassed}` };
      return {
        ok: true,
        ...(out.sha ? { sha: out.sha } : {}),
        detail: step.admin ? `force-merged ${what}${bypassed}` : `merged ${what}`,
      };
    }
    case "retarget":
      await gh.retarget(step.pr, step.to);
      return { ok: true, detail: `retargeted #${step.pr}: ${step.from} -> ${step.to}` };
    case "restack": {
      const dir = step.worktree ?? repoDir;
      if (step.worktree && !(await git.isClean(exec, step.worktree))) {
        throw new StkError(`worktree ${step.worktree} has uncommitted changes; refusing to restack ${step.branch}`, "dirty-worktree");
      }
      const remoteOnto = step.onto.replace(/^origin\//, "");
      await git.fetchBranches(exec, dir, [remoteOnto, step.branch]);
      const sha = await git.rebaseOnto(exec, dir, step.branch, step.onto, step.upstream, step.expectedRemoteSha);
      return { ok: true, detail: `restacked ${step.branch} onto ${step.onto}`, sha };
    }
    case "push": {
      const sha = await git.leasedPush(exec, step.cwd, step.branch, step.expectedRemoteSha);
      return { ok: true, detail: `pushed ${step.branch} (${sha.slice(0, 9)})`, sha };
    }
    case "wait-checks":
      await gh.waitChecks(step.pr);
      return { ok: true, detail: `checks passed on #${step.pr}` };
    case "rebase-stack": {
      const note = await gh.rebaseStack(step.pr);
      return { ok: true, detail: `rebased the stack from #${step.pr} onto the trunk in a temporary checkout and pushed with leases${note ? `; ${note}` : ""}` };
    }
    case "refresh-mergeability":
      await gh.refreshMergeability(step.pr);
      return { ok: true, detail: `GitHub's conflict flag on #${step.pr} was stale (its head already contains its base); closed and reopened #${step.pr} to make GitHub recompute it` };
  }
}

/** Runs steps in order, stopping at the first failure. */
export async function executePlan(plan: PlanStep[], deps: ExecuteDeps): Promise<StepResult[]> {
  const git = deps.git ?? realGit;
  const results: StepResult[] = [];
  // Preflight every restack before anything is merged, so a bad branch can't leave a half-merged stack.
  for (const step of plan) {
    if (step.kind !== "restack") continue;
    try {
      await git.preflightBranch(deps.exec, step.worktree ?? deps.repoDir, step.branch, step.expectedRemoteSha, step.worktree);
    } catch (e) {
      const result: StepResult = { step, ok: false, detail: e instanceof Error ? e.message : String(e) };
      deps.onStep?.(result);
      return [result];
    }
  }
  for (const step of plan) {
    let result: StepResult;
    try {
      result = { step, ...(await runStep(step, deps, git)) };
    } catch (e) {
      result = { step, ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
    results.push(result);
    deps.onStep?.(result);
    // A queued merge hasn't landed, so later steps (retarget/restack of its child) would be premature.
    if (!result.ok || result.enqueued) break;
  }
  return results;
}
