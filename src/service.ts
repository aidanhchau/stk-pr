/**
 * Command data logic shared by the CLI and the TUI. Every function returns plain
 * data (the CLI's JSON `data` shapes) and throws StkError on failure.
 */
import { join } from "node:path";
import type { PaletteItem } from "./fuzzy";
import { GH_ENV, formatGhOutput, planGh, type GhResult } from "./ghproxy";
import { attachBranch, isClean, planAttach, listWorktrees, remoteSha, repoRoot, resolveWorktree, worktreeForBranch } from "./git";
import { commitSubjects, currentBranch, localBranches, nearestParent, pushBranch, pushEmptyCommit, pushKind, RETRIGGER_MESSAGE, type PushKind } from "./branches";
import {
  closePr,
  commitCheckRuns,
  commitCheckSuites,
  createPr,
  commitHistory,
  headWorkflowRuns,
  rerequestCheckSuite,
  rerunWorkflowRun,
  workflowRunJobs,
  markReady,
  reopenPr,
  rerunFailedChecks,
  updateBranch,
  behindBy,
  branchRules,
  fetchSessionPrs,
  getPr,
  listPrs,
  mergeAsync,
  nativeStack,
  listPrRefs,
  prDetails,
  createPrStack,
  prDiff,
  repoSlug,
  nativeStackDetail,
  type NativeStackDetail,
  searchPrs,
  prSummaries,
  viewPr,
  replyToThread,
  resolveThread,
  retargetPr,
  prDiscussion,
  splitDiffByFile,
  submitReview,
  trunkFor,
  unresolvedThreadCounts,
  waitChecks,
  withThreads,
  type FileDiff,
  type PrFileInfo,
  type PrSummary,
  type ReviewThread,
} from "./github";
import { blockers, chainThrough, executePlan, findForks, isHardBlocker, memberBlockers, planNativeStackMerge, planStackMerge, stackFor, treeOf, type ExecuteDeps, type Fork } from "./stack";
import { resolveRepo } from "./repos";
import { roleRank, sessionPrRefs } from "./session";
import {
  type RepoSlug,
  StkError,
  type Blocker,
  type ConversationEntry,
  type Exec,
  type MergeMethod,
  type MergeProgress,
  type PlanStep,
  type PullRequest,
  type PrCommit,
  type RepoRules,
  type Stack,
  type StepResult,
  type Worktree,
} from "./types";

export interface Ctx {
  exec: Exec;
  /** Local checkout; null when operating repo-less via `slug`. */
  root: string | null;
  slug?: RepoSlug;
  worktrees: Worktree[];
}

export type BoardScope = "mine" | "review" | "all";
export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export type BoardPr = PullRequest & { blockers: Blocker[] };
export type { RepoSlug, MergeProgress };
export interface Board {
  repo: RepoSlug;
  trunk: string;
  prs: BoardPr[];
}
export type { PrFileInfo as FileSummary, FileStatus } from "./github";
export interface PrDetail {
  repo: RepoSlug;
  pr: PullRequest;
  blockers: Blocker[];
  threads: ReviewThread[];
  conversation: ConversationEntry[];
  files: PrFileInfo[];
  /**
   * `prs`: the line through this PR (merge/parent semantics). `entries`: what the page lists, bottom first: the same line, or for a
   * forked tree every PR of the tree (each with `tree`), identical from any member. `forks`: PRs with 2+ stacked children.
   */
  stack: { trunk: string; prs: number[]; entries: StackEntry[]; native: boolean; forks: Fork[] } | null;
}
/** One PR of the stack shown on the PR page. */
export interface StackEntry {
  number: number;
  title: string;
  state: PullRequest["state"];
  isDraft: boolean;
  /** Checks roll-up: any failure wins, then pending, else pass; `none` when it has no checks. */
  checks: "pass" | "fail" | "pending" | "none";
  /** Conflicts with its base, or mergeability still being computed. */
  mergeIssue?: "conflict" | "checking" | "blocked";
  /** Forked trees only: the PR this one is stacked on (null = the trunk) and its branch depth (0 = the first line). */
  tree?: { parent: number | null; depth: number };
}
export interface PrFiles {
  files: FileDiff[];
}
export interface OpenResult {
  branch: string;
  worktree: string | null;
  created: boolean;
}
export interface ReviewResult {
  number: number;
  event: ReviewEvent;
}
export interface ThreadResult {
  threadId: string;
}
export interface MergeDryRun {
  wouldMerge: boolean;
  admin: boolean;
  bypass: Blocker[];
  blockers: Blocker[];
  note?: string;
}
export interface MergeResult {
  number: number;
  method: MergeMethod;
  admin: boolean;
  bypassed: Blocker[];
  /** `enqueued` = only added to a merge queue; it has not merged yet. */
  status: "merged" | "enqueued";
  /** Merge commit, when GitHub reports it. */
  sha?: string;
  /** The merge-async request id. */
  uuid?: string;
  note?: string;
}
export interface StackInfo {
  stack: Stack;
  forks: Fork[];
  plan: PlanStep[];
  blockers: Record<number, Blocker[]>;
  /** The PR the plan lands up to (a stack's open PRs at and below it). */
  target: number;
  /** Set when a PR at or below `target` is not in the plan: which one, and why, in words. */
  stop: { pr: number; reason: string } | null;
  notes: StackNote[];
  /** PRs the merge rebases in a worktree: where each would run (`detached` = a detached HEAD at the tip, switched to the branch first). */
  rebaseWorktrees: RebaseWorktree[];
}

/** A PR the rebase step runs for, and the worktree it would use. */
export interface RebaseWorktree {
  pr: number;
  branch: string;
  kind: "branch" | "detached" | "none";
  path?: string;
}

/** `StkError` data of a `no-worktree` failure. */
export interface MissingWorktrees {
  worktrees: { pr: number; branch: string }[];
}
export interface StackMergeResult {
  results: StepResult[];
  /** PR numbers in the stack. */
  total: number[];
  merged: number[];
  remaining: number[];
}

// ---------- helpers ----------

export function describeBlocker(b: Blocker): string {
  switch (b.kind) {
    case "checks": {
      const parts: string[] = [];
      if (b.failing.length) parts.push(`failing: ${b.failing.join(", ")}`);
      if (b.pending.length) parts.push(`pending: ${b.pending.join(", ")}`);
      return `checks (${parts.join("; ")})`;
    }
    case "review":
      return `review (${b.decision ?? "none"})`;
    case "threads":
      return `${b.count} unresolved thread${b.count === 1 ? "" : "s"}`;
    case "draft":
      return "draft";
    case "conflict":
      return `conflicts with ${b.base ?? "base"}`;
    case "behind":
      return b.count === null ? `behind ${b.base}` : `${b.count} commit${b.count === 1 ? "" : "s"} behind ${b.base}`;
    case "checking":
      return "checking for conflicts…";
    case "required-check":
      return `required check '${b.context}' hasn't run`;
    case "blocked":
      return b.codeOwner ? "blocked by repository rules (code owner review may be missing)" : "blocked by repository rules";
    case "base-not-trunk":
      if (b.owner?.state === "MERGED") return `base #${b.owner.number} merged; rebase the stack`;
      if (b.owner?.state === "OPEN") return `waiting on #${b.owner.number}`;
      return `base is ${b.base}, not trunk`;
  }
}

export const describeBlockers = (bs: Blocker[]) => bs.map(describeBlocker).join(", ");

function fillWorktrees(prs: PullRequest[], worktrees: Worktree[]): PullRequest[] {
  return prs.map((p) => ({ ...p, worktree: worktreeForBranch(worktrees, p.headRef)?.path ?? null }));
}

export async function openCtx(exec: Exec, repoDir: string): Promise<Ctx> {
  const root = await repoRoot(exec, repoDir);
  return { exec, root, worktrees: await listWorktrees(exec, root) };
}

/** Repo-less ctx for owner/name: gh runs with `-R`, git-dependent actions throw not-a-repo. */
export const slugCtx = (exec: Exec, slug: RepoSlug): Ctx => ({ exec, root: null, slug, worktrees: [] });

/** Ctx for a GitHub repo: the local checkout when resolveRepo finds one, otherwise repo-less. */
export async function openCtxForSlug(exec: Exec, owner: string, name: string): Promise<Ctx> {
  const dir = await resolveRepo(exec, owner, name);
  if (dir) {
    try {
      return { ...(await openCtx(exec, dir)), slug: { owner, name } };
    } catch (e) {
      if (!(e instanceof StkError)) throw e;
    }
  }
  return slugCtx(exec, { owner, name });
}

/** Where gh runs: the checkout when there is one, else the repo slug. */
const RULES_TTL_MS = 10 * 60_000;
const rulesCache = new Map<string, { at: number; rules: Promise<RepoRules | null> }>();

/**
 * Branch rules of `branch`, one REST call per (repo, branch) cached ~10 min and shared by every PR/board row. A
 * failure (no access, ...) is cached as null: blockers then rely on GitHub's mergeStateStatus alone. Rate limits surface.
 */
export async function rulesFor(exec: Exec, where: string | RepoSlug, branch: string): Promise<RepoRules | null> {
  const slug = typeof where === "string" ? await repoSlug(exec, where) : where;
  const key = `${slug.owner}/${slug.name}@${branch}`.toLowerCase();
  const hit = rulesCache.get(key);
  if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit.rules;
  const rules = branchRules(exec, slug, branch).catch((e) => {
    if (!(e instanceof StkError) || e.code === "rate-limited") {
      rulesCache.delete(key);
      throw e;
    }
    return null;
  });
  rulesCache.set(key, { at: Date.now(), rules });
  return rules;
}

/** Test hook: forget cached rules. */
export const clearRulesCache = () => rulesCache.clear();

export function at(ctx: Ctx): string | RepoSlug {
  const where = ctx.root ?? ctx.slug;
  if (!where) throw new StkError("no repository: neither a checkout nor an owner/name is known", "not-a-repo");
  return where;
}

/** Loaded on demand by the PR's collapsed history section, never as part of prDetail. */
export async function prCommits(ctx: Ctx, n: number): Promise<PrCommit[]> {
  return commitHistory(ctx.exec, at(ctx), n);
}

function requireRoot(ctx: Ctx, what: string): string {
  if (ctx.root) return ctx.root;
  const repo = ctx.slug ? `${ctx.slug.owner}/${ctx.slug.name}` : "this repository";
  throw new StkError(`cannot ${what}: no local checkout of ${repo} was found (set STK_ROOTS or clone it under ~/projects)`, "not-a-repo");
}

// ---------- commands ----------

export async function listBoard(ctx: Ctx, scope: BoardScope): Promise<Board> {
  const filter = scope === "review" ? { search: "review-requested:@me" } : scope === "all" ? {} : { author: "@me" };
  const [trunk, repo, raw] = await Promise.all([
    trunkFor(ctx.exec, at(ctx)),
    repoSlug(ctx.exec, at(ctx)),
    listPrs(ctx.exec, at(ctx), { ...filter, state: "open" }),
  ]);
  const [rules, counts] = await Promise.all([
    rulesFor(ctx.exec, repo, trunk),
    unresolvedThreadCounts(ctx.exec, at(ctx), raw.map((p) => p.number)),
  ]);
  const prs = fillWorktrees(withThreads(raw, counts), ctx.worktrees);
  return { trunk, repo, prs: prs.map((p) => ({ ...p, blockers: blockers(p, trunk, rules) })) };
}

/** Everything except patches (those come from prFiles on demand): `pr view`, discussion, native stack and the light ref list, plus one aliased query when stack members lack a native summary. */
const blockerIssue = (bs: Blocker[]): StackEntry["mergeIssue"] =>
  bs.some((b) => b.kind === "conflict")
    ? "conflict"
    : bs.some((b) => b.kind === "checking")
      ? "checking"
      : bs.some((b) => b.kind === "required-check" || b.kind === "blocked")
        ? "blocked"
        : undefined;

export async function prDetail(ctx: Ctx, n: number): Promise<PrDetail> {
  const refsP = listPrRefs(ctx.exec, at(ctx)).catch((e) => {
    if (!(e instanceof StkError) || e.code === "rate-limited") throw e;
    return null;
  });
  const [trunk, repo, view, discussion, refs, native] = await Promise.all([
    trunkFor(ctx.exec, at(ctx)),
    repoSlug(ctx.exec, at(ctx)),
    viewPr(ctx.exec, at(ctx), n),
    prDiscussion(ctx.exec, at(ctx), n),
    refsP,
    nativeStackOrNull(ctx, n),
  ]);
  const rules = await rulesFor(ctx.exec, repo, trunk);
  const { threads } = discussion;
  const unresolvedThreads = threads.filter((t) => !t.isResolved).length;
  // one REST compare call, only for the opened PR; a failure just omits the count (rate limits still surface)
  const behind =
    view.pr.state === "OPEN"
      ? await behindBy(ctx.exec, at(ctx), view.pr.baseRef, view.pr.headRef).catch((e) => {
          if (!(e instanceof StkError) || e.code === "rate-limited") throw e;
          return undefined;
        })
      : undefined;
  const pr = fillWorktrees([{ ...view.pr, unresolvedThreads, ...(behind !== undefined ? { behindBy: behind } : {}) }], ctx.worktrees)[0]!;
  let stack: PrDetail["stack"] = null;
  if (pr.state !== "OPEN" && native) {
    // GitHub keeps `stack` for merged/closed PRs, so merged members stay listed; the ref chain only knows open PRs
    const entries = native.entries.map((e): StackEntry => (e.number === n ? { number: n, title: pr.title, state: pr.state, isDraft: pr.isDraft, checks: e.checks } : { number: e.number, title: e.title, state: e.state, isDraft: e.isDraft, checks: e.checks, ...(e.mergeIssue ? { mergeIssue: e.mergeIssue } : {}) }));
    stack = { trunk, prs: entries.map((e) => e.number), entries, native: true, forks: [] };
  }
  if (!stack && pr.state === "OPEN" && refs) {
    try {
      // merging needs a line (`prs`); the page shows a forked tree whole, the same from every member (`entries`, `forks`)
      const s = chainThrough(refs, trunk, n);
      const tree = s.forks.length > 0 ? treeOf(refs, trunk, n) : null;
      const shown = tree ? tree.rows : s.prs.map((pr) => ({ pr, parent: null, depth: 0 }));
      if (shown.length > 1) {
        // refs carry only topology; titles, state and checks come from the native stack query, or one aliased query
        const known = new Map((native?.entries ?? []).map((e) => [e.number, e]));
        const missing = shown.map((r) => r.pr.number).filter((m) => m !== n && !known.has(m));
        const extra: Map<number, PrSummary> = await prSummaries(ctx.exec, at(ctx), missing).catch((e) => {
          if (!(e instanceof StkError) || e.code === "rate-limited") throw e;
          return new Map<number, PrSummary>();
        });
        const entries = shown.map(({ pr: r, parent, depth }): StackEntry => {
          const place = tree ? { tree: { parent, depth } } : {};
          if (r.number === n) {
            const cs = pr.checks.filter((c) => c.state !== "skipped");
            const checks = !cs.length ? "none" : cs.some((c) => c.state === "fail") ? "fail" : cs.some((c) => c.state === "pending") ? "pending" : "pass";
            const mergeIssue = blockerIssue(blockers(pr, trunk, rules));
            return { number: n, title: pr.title, state: pr.state, isDraft: pr.isDraft, checks, ...(mergeIssue ? { mergeIssue } : {}), ...place };
          }
          const p = known.get(r.number) ?? extra.get(r.number);
          return p
            ? { number: p.number, title: p.title, state: p.state, isDraft: p.isDraft, checks: p.checks, ...(p.mergeIssue ? { mergeIssue: p.mergeIssue } : {}), ...place }
            : { number: r.number, title: "", state: "OPEN", isDraft: false, checks: "none", ...place };
        });
        stack = { trunk, prs: s.prs.map((p) => p.number), entries, native: native !== null, forks: tree?.forks ?? [] };
      }
    } catch (e) {
      if (!(e instanceof StkError) || e.code === "rate-limited") throw e;
    }
  }
  let bl = blockers(pr, trunk, rules);
  if (bl.some((b) => b.kind === "base-not-trunk")) {
    // the PR owning the base branch: native stack members carry their head refs, open PRs come from the ref list
    const hit = native?.entries.find((e) => e.headRef === pr.baseRef && e.number !== n) ?? refs?.find((r) => r.headRef === pr.baseRef && r.number !== n);
    const owner = hit ? { number: hit.number, state: hit.state } : undefined;
    if (owner) bl = bl.map((b) => (b.kind === "base-not-trunk" ? { ...b, owner } : b));
  }
  return { repo, pr, blockers: bl, threads, conversation: discussion.conversation, files: view.files, stack };
}

export async function prFiles(ctx: Ctx, n: number, file?: string): Promise<PrFiles> {
  let files = splitDiffByFile(await prDiff(ctx.exec, at(ctx), n));
  if (file) {
    files = files.filter((f) => f.path === file || f.oldPath === file);
    if (files.length === 0) throw new StkError(`no file ${file} in PR #${n}`, "usage");
  }
  return { files };
}

export async function openWorktree(ctx: Ctx, n: number, opts: { create?: boolean } = {}): Promise<OpenResult> {
  const pr = await getPr(ctx.exec, at(ctx), n);
  const branch = pr.headRef;
  const existing = resolveWorktree(ctx.worktrees, branch, pr.headSha);
  if (existing.kind !== "none") return { branch, worktree: existing.worktree.path, created: false };
  if (!opts.create) return { branch, worktree: null, created: false };
  const root = requireRoot(ctx, "create a worktree");
  const git = async (args: string[]) => {
    const r = await ctx.exec(["git", ...args], { cwd: root });
    if (r.code !== 0) {
      throw new StkError(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`, "git-failed");
    }
  };
  await git(["fetch", "origin", branch]);
  const path = join(root, "..", ".stk-worktrees", branch.replace(/\//g, "-"));
  // git DWIM creates a local branch tracking origin/<branch> when none exists.
  await git(["worktree", "add", path, branch]);
  return { branch, worktree: path, created: true };
}

export async function review(ctx: Ctx, n: number, event: ReviewEvent, body = ""): Promise<ReviewResult> {
  if (event !== "APPROVE" && !body.trim()) throw new StkError(`${event} needs -m BODY`, "usage");
  await submitReview(ctx.exec, at(ctx), n, { event, body });
  return { number: n, event };
}

export async function reply(ctx: Ctx, threadId: string, body: string): Promise<ThreadResult> {
  if (!body.trim()) throw new StkError("reply needs -m BODY", "usage");
  await replyToThread(ctx.exec, at(ctx), threadId, body);
  return { threadId };
}

export async function resolve(ctx: Ctx, threadId: string): Promise<ThreadResult> {
  await resolveThread(ctx.exec, at(ctx), threadId);
  return { threadId };
}

type MergeOpts = { method: MergeMethod; force: boolean; onProgress?: (p: MergeProgress) => void };
export function merge(ctx: Ctx, n: number, opts: MergeOpts & { dryRun: true }): Promise<MergeDryRun>;
export function merge(ctx: Ctx, n: number, opts: MergeOpts & { dryRun?: false }): Promise<MergeResult>;
export function merge(ctx: Ctx, n: number, opts: MergeOpts & { dryRun?: boolean }): Promise<MergeDryRun | MergeResult>;
/**
 * Merge one PR via GitHub's merge-async API, resolving once the request is final (merged or enqueued).
 * Throws StkError("blocked", data: {blockers}) when blocked (never for dry runs), "merge-timeout" if
 * GitHub is still working after 10 minutes. `force` sends bypass_rules.
 */
export async function merge(
  ctx: Ctx,
  n: number,
  opts: MergeOpts & { dryRun?: boolean },
): Promise<MergeDryRun | MergeResult> {
  const { method, force } = opts;
  const trunk = await trunkFor(ctx.exec, at(ctx));
  const [pr, rules] = await Promise.all([getPr(ctx.exec, at(ctx), n), rulesFor(ctx.exec, at(ctx), trunk)]);
  if (pr.state !== "OPEN") throw new StkError(`PR #${n} is ${pr.state.toLowerCase()}, not open`, "usage");

  let bs = blockers(pr, trunk, rules);
  let note: string | undefined;
  let nativeDownstack = false;
  const baseBlocker = bs.find((b) => b.kind === "base-not-trunk");
  if (baseBlocker) {
    const open = await listPrs(ctx.exec, at(ctx), { state: "open" });
    const parent = open.find((p) => p.headRef === pr.baseRef && p.number !== n);
    if (parent) {
      const ns = await nativeStackOrNull(ctx, n);
      nativeDownstack = !!ns && ns.entries.some((e) => e.position < ns.position && e.state === "OPEN");
      if (nativeDownstack) {
        // GitHub would land every open downstack PR with this one, skipping their blocker checks here
        note = `#${n} is part of a GitHub stack: merging it also merges #${parent.number} and the PRs below it; merge the stack (stk stack ${n} --merge)`;
      } else {
        bs = bs.filter((b) => b !== baseBlocker);
        note = `base ${pr.baseRef} is the head of #${parent.number}; merge the stack (stk stack ${n} --merge)`;
      }
    }
  }
  const unbypassable = bs.filter(isHardBlocker);
  const mayMerge = !nativeDownstack && (force ? unbypassable.length === 0 : bs.length === 0);

  if (opts.dryRun) {
    return {
      wouldMerge: mayMerge,
      admin: force && mayMerge,
      bypass: force && mayMerge ? bs : [],
      blockers: bs,
      ...(note ? { note } : {}),
    };
  }
  if (nativeDownstack) {
    throw new StkError(`${note} (not merged: it would also land unchecked downstack PRs)`, "blocked", { blockers: bs });
  }
  if (!mayMerge) {
    const why = force ? unbypassable : bs;
    throw new StkError(
      `#${n} ${force ? "cannot be force-merged" : "is blocked"}: ${describeBlockers(why)}${force ? "" : " (use --force to bypass)"}`,
      "blocked",
      { blockers: why },
    );
  }
  const out = await mergeAsync(ctx.exec, at(ctx), n, {
    method,
    bypass: force,
    sha: pr.headSha,
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  return {
    number: n,
    method,
    admin: force,
    bypassed: force ? bs : [],
    status: out.status,
    ...(out.sha ? { sha: out.sha } : {}),
    ...(out.uuid ? { uuid: out.uuid } : {}),
    ...(note ? { note } : {}),
  };
}

/** Native stack membership, or null when the PR isn't in one (or the host has no stacked-PR API). */
async function nativeStackOrNull(ctx: Ctx, n: number) {
  try {
    return await nativeStack(ctx.exec, at(ctx), n);
  } catch (e) {
    if (!(e instanceof StkError) || e.code === "rate-limited") throw e;
    return null;
  }
}

interface PlanOpts {
  method: MergeMethod;
  force: boolean;
  /** Highest PR to land (the stack's open PRs up to and including it); "top" = the whole stack. Default: `n` for a native stack, the whole chain for a classic one. */
  upTo?: number | "top";
}

/** A heads-up about one stack member that does not block the plan (see `StackInfo.notes`). */
export interface StackNote {
  pr: number;
  text: string;
  fix: string;
  /** Set when stk can apply the fix itself (`rebaseStack`). */
  action?: "rebase-stack";
}

/** What `planFor` read and planned for a stack merge. */
export interface PlanForResult {
  trunk: string;
  stack: Stack;
  forks: Fork[];
  /** The PR the plan lands up to. */
  target: number;
  notes: StackNote[];
  rules: RepoRules | null;
  plan: PlanStep[];
}

async function planFor(ctx: Ctx, n: number, opts: PlanOpts): Promise<PlanForResult> {
  // A native stack plans from ONE GraphQL call: members' fields, thread counts and the trunk all come back together.
  let detail: NativeStackDetail | null = null;
  try {
    detail = await nativeStackDetail(ctx.exec, at(ctx), n);
  } catch (e) {
    if (!(e instanceof StkError) || e.code === "rate-limited") throw e;
  }
  if (detail) {
    const { trunk, members } = detail;
    if (members.find((m) => m.pr.number === n)?.pr.state !== "OPEN") throw new StkError(`PR #${n} is not an open PR`, "usage");
    const prs = fillWorktrees(members.map((m) => m.pr).filter((p) => p.state === "OPEN"), ctx.worktrees);
    const target = opts.upTo === "top" ? prs[prs.length - 1]!.number : (opts.upTo ?? n);
    if (!prs.some((p) => p.number === target)) throw new StkError(`PR #${target} is not an open member of this stack`, "usage");
    const stack: Stack = { trunk, prs, native: true };
    // GitHub does not retarget a stacked PR whose base PR merged, and refuses to let it be edited: flag it, with the manual fix
    const notes: StackNote[] = [];
    const bottom = prs[0]!;
    const mergedBase = members.find((m) => m.pr.state === "MERGED" && m.pr.headRef === bottom.baseRef);
    if (mergedBase) {
      notes.push({
        pr: bottom.number,
        text: `#${bottom.number}'s base is a merged branch (${bottom.baseRef})`,
        fix: `GitHub does not allow changing the base of a stacked PR; the stack needs a rebase (GitHub's "Rebase stack", or \`gh stack rebase\` then \`gh stack push\`).`,
        action: "rebase-stack",
      });
    }
    // a native stack is linear; forks elsewhere in the repo do not affect it
    const rules = await rulesFor(ctx.exec, at(ctx), trunk);
    return { trunk, stack, forks: findForks(prs, trunk), target, notes, rules, plan: planNativeStackMerge(stack, { method: opts.method, force: opts.force, upTo: target, rules }) };
  }
  // classic chain: branch topology only (light list), then ONE aliased query for just the chain's members
  const [trunk, refs] = await Promise.all([trunkFor(ctx.exec, at(ctx)), listPrRefs(ctx.exec, at(ctx))]);
  const forks = findForks(refs, trunk);
  const repoDir = requireRoot(ctx, "plan a stack merge");
  const chainRefs = stackFor(refs, trunk, n);
  const [details, rules] = await Promise.all([prDetails(ctx.exec, at(ctx), chainRefs.prs.map((p) => p.number)), rulesFor(ctx.exec, at(ctx), trunk)]);
  const chain = { trunk, prs: fillWorktrees(details, ctx.worktrees) };
  const stack: Stack = { ...chain, native: false };
  const target = opts.upTo === "top" || opts.upTo === undefined ? stack.prs[stack.prs.length - 1]!.number : opts.upTo;
  if (!stack.prs.some((p) => p.number === target)) throw new StkError(`PR #${target} is not in this stack`, "usage");
  const upTo = typeof opts.upTo === "number" ? opts.upTo : undefined;
  const plan = planStackMerge(stack, { method: opts.method, force: opts.force, repoDir, rules, ...(upTo !== undefined ? { upTo } : {}) }, ctx.worktrees);
  return { trunk, stack, forks, target, notes: [] as StackNote[], rules, plan };
}

/** Why the plan stops before `target`: names the first member at or below it that no merge step covers. */
function stopReason(stack: Stack, plan: PlanStep[], target: number, perPr: Record<number, Blocker[]>, force: boolean): { pr: number; reason: string } | null {
  const included = new Set(plan.flatMap((s) => (s.kind === "merge" ? (s.includes ?? [s.pr]) : [])));
  const end = stack.prs.findIndex((p) => p.number === target);
  const pr = stack.prs.slice(0, end + 1).find((p) => !included.has(p.number));
  if (!pr) return null;
  const bs = perPr[pr.number] ?? [];
  const use = force ? bs.filter(isHardBlocker) : bs;
  if (use.length === 0) return { pr: pr.number, reason: `#${pr.number} is blocked` };
  if (use.every(isHardBlocker)) {
    return { pr: pr.number, reason: `#${pr.number} ${use.map((b) => (b.kind === "draft" ? "is a draft" : describeBlocker(b))).join(" and ")}` };
  }
  return { pr: pr.number, reason: `#${pr.number} is blocked: ${describeBlockers(use)}` };
}

export async function stackInfo(
  ctx: Ctx,
  n: number,
  opts: PlanOpts,
): Promise<StackInfo> {
  const { trunk, stack, forks, plan, target, notes, rules } = await planFor(ctx, n, opts);
  const perPr = blockersByPr(stack, trunk, rules);
  // the sheet's own rebase (stale base) runs from the PR it was opened on
  const rebasing = notes.some((x) => x.action === "rebase-stack") ? [stack.prs.find((p) => p.number === n) ?? stack.prs[0]!] : nativeRebaseBottoms(stack, plan, target);
  // read fresh: a worktree made since this ctx was opened (here or in another shell) must count
  const worktrees = ctx.root ? await listWorktrees(ctx.exec, ctx.root).catch(() => ctx.worktrees) : ctx.worktrees;
  const rebaseWorktrees = rebasing.map((p): RebaseWorktree => {
    const found = resolveWorktree(worktrees, p.headRef, p.headSha);
    return { pr: p.number, branch: p.headRef, kind: found.kind, ...(found.kind === "none" ? {} : { path: found.worktree.path }) };
  });
  return { stack, forks, plan, blockers: perPr, target, stop: stopReason(stack, plan, target, perPr, opts.force), notes, rebaseWorktrees };
}

/** The PRs a native plan with several merge steps rebases (each bottom after the first merge lands): the ones that need a worktree. */
function nativeRebaseBottoms(stack: Stack, plan: PlanStep[], target: number): PullRequest[] {
  const merges = plan.filter((s) => s.kind === "merge");
  if (!stack.native || merges.length <= 1) return [];
  const first = merges[0]!.includes ?? [merges[0]!.pr];
  return stack.prs.slice(0, stack.prs.findIndex((p) => p.number === target) + 1).filter((p) => !first.includes(p.number));
}

/** Per-member blockers of a stack: a native stack lands on the trunk, so no member is judged by its own base. */
function blockersByPr(stack: Stack, trunk: string, rules: RepoRules | null): Record<number, Blocker[]> {
  const perPr: Record<number, Blocker[]> = {};
  for (const [i, p] of stack.prs.entries()) {
    perPr[p.number] = i === 0 && !stack.native ? blockers(p, trunk, rules) : memberBlockers(p, trunk, true, rules);
  }
  return perPr;
}

/** How a native stack merge re-reads GitHub between steps (injectable so tests need not wait). */
export interface ReplanPolicy {
  /** Extra reads while GitHub still shows a landed PR as open, or mergeability as "checking". Default 6. */
  attempts?: number;
  /** Delay between those reads. Default 2000ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Re-read a native stack from GitHub and plan again. Right after a merge GitHub may still list the landed PR as open, and
 * right after a merge or a push it reports the new bottom's mergeability as "checking" or still exposes the old heads:
 * poll briefly while any holds. `stale` names a landed PR still open, `staleHead` a pushed head not reflected, and
 * `checking` a bottom PR whose mergeability GitHub is still computing, after attempts run out.
 */
async function replanNative(ctx: Ctx, target: number, opts: PlanOpts, landed: Set<number>, policy: ReplanPolicy, expectedHeads: Record<number, string>): Promise<{ fresh: PlanForResult; stale: number | null; staleHead: number | null; checking: number | null }> {
  const attempts = policy.attempts ?? 6;
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let i = 0; ; i++) {
    const fresh = await planFor(ctx, target, { ...opts, upTo: target });
    const stale = fresh.stack.prs.find((p) => landed.has(p.number))?.number ?? null;
    const staleHead = Object.entries(expectedHeads).find(([n, sha]) => !landed.has(Number(n)) && fresh.stack.prs.find((p) => p.number === Number(n))?.headSha !== sha);
    const bottom = fresh.stack.prs[0];
    // a bottom still on the merged branch is rebased next, and its mergeability only matters after that push
    const rebaseNext = fresh.notes.some((x) => x.action === "rebase-stack");
    const checking = !rebaseNext && !!bottom && memberBlockers(bottom, fresh.trunk, false, fresh.rules).some((b) => b.kind === "checking") ? bottom.number : null;
    if ((stale === null && checking === null && !staleHead) || i >= attempts) return { fresh, stale, staleHead: staleHead ? Number(staleHead[0]) : null, checking };
    await sleep(policy.delayMs ?? 2000);
  }
}

/**
 * Execute the stack merge plan. Throws StkError("step-failed", data: {results}) if a step fails.
 *
 * A native plan with several merge steps (each bypass lands alone, GitHub only allows it on the bottom-most unmerged PR)
 * runs one merge at a time: after each, the stack is re-read, the remaining PRs are rebased with `gh stack` when GitHub
 * left them on the merged branch, and the plan is made again so the next merge pins the head SHA the rebase produced.
 * `onPlan` receives the steps that ran plus the current plan whenever it changes.
 */
export async function stackMerge(
  ctx: Ctx,
  n: number,
  opts: PlanOpts & { onStep?: (r: StepResult) => void; onProgress?: (p: MergeProgress) => void; onPlan?: (plan: PlanStep[]) => void; replan?: ReplanPolicy },
): Promise<StackMergeResult> {
  const first = await planFor(ctx, n, opts);
  const { stack } = first;
  let expectedHeads: Record<number, string> = {};
  const deps: ExecuteDeps = {
    exec: ctx.exec,
    // a native stack is one API call and never touches a checkout
    repoDir: stack.native ? (ctx.root ?? "") : requireRoot(ctx, "restack/merge a stack"),
    gh: {
      merge: (pr, m, admin, extra) =>
        mergeAsync(ctx.exec, at(ctx), pr, { method: m, bypass: admin, ...(extra?.sha ? { sha: extra.sha } : {}), ...(extra?.onProgress ? { onProgress: extra.onProgress } : {}) }),
      retarget: (pr, base) => retargetPr(ctx.exec, at(ctx), pr, base),
      waitChecks: async (pr) => {
        const expectedHeadSha = expectedHeads[pr] ?? (await getPr(ctx.exec, at(ctx), pr)).headSha;
        const checks = await waitChecks(ctx.exec, at(ctx), pr, {
          timeoutMs: 30 * 60_000,
          expectedHeadSha,
          requiredChecks: first.rules?.requiredChecks ?? [],
        });
        const failing = checks.filter((c) => c.state === "fail").map((c) => c.name);
        if (failing.length) throw new StkError(`checks failed on #${pr}: ${failing.join(", ")}`, "gh-failed");
      },
      rebaseStack: async (pr) => {
        const rebased = await rebaseStack(ctx, pr);
        const cwd = requireRoot(ctx, "verify the rebased stack");
        const heads: Record<number, string> = {};
        // gh stack push succeeded; verify exactly what landed on origin before trusting eventual GraphQL updates.
        for (const n of rebased.prs) {
          const member = stack.prs.find((p) => p.number === n);
          if (!member) throw new StkError(`native stack gained unexpected PR #${n}; review the stack`, "gh-failed");
          const local = await ctx.exec(["git", "rev-parse", "--verify", `refs/heads/${member.headRef}`], { cwd });
          const sha = local.stdout.trim();
          if (local.code !== 0 || !sha) throw new StkError(`could not read the rebased head of #${n}: ${local.stderr.trim()}`, "git-failed");
          const remote = await remoteSha(ctx.exec, cwd, member.headRef);
          if (remote !== sha) throw new StkError(`after gh stack push, origin/${member.headRef} is ${remote ?? "missing"} but local is ${sha}`, "lease-rejected");
          heads[n] = sha;
        }
        expectedHeads = heads;
      },
    },
    onStep: (r) => {
      if (r.ok && r.step.kind === "push" && r.sha) {
        const branch = r.step.branch;
        const member = stack.prs.find((p) => p.headRef === branch);
        if (member) expectedHeads[member.number] = r.sha;
      }
      opts.onStep?.(r);
    },
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  };
  const results: StepResult[] = [];
  const landed = new Set<number>();
  const landedBy = (rs: StepResult[]) => {
    for (const r of rs) if (r.ok && r.step.kind === "merge" && !r.enqueued) for (const m of r.step.includes ?? [r.step.pr]) landed.add(m);
  };
  const stopped = (reason: string, pr: number, extra: object = {}): never => {
    throw new StkError(`stack merge stopped at #${pr}: ${reason}`, "step-failed", { results, ...extra });
  };
  const selected = stack.prs.slice(0, stack.prs.findIndex((p) => p.number === first.target) + 1);
  const validateReplan = (fresh: PlanForResult, stale: number | null) => {
    // Exhausted stale-state polling must never trigger a local mutation.
    if (stale !== null) stopped(`GitHub still lists #${stale} as open after it merged`, stale);
    if (!fresh.stack.native || fresh.trunk !== first.trunk) {
      stopped("native stack or trunk changed; review the stack and start a new merge", first.target);
    }
    const expected = stack.prs.filter((p) => !landed.has(p.number));
    // Keep the whole original stack's order/branch identity, including unchanged members above the selected target.
    if (fresh.stack.prs.length !== expected.length || fresh.stack.prs.some((p, i) => p.number !== expected[i]?.number || p.headRef !== expected[i]?.headRef)) {
      stopped("native stack membership or order changed; review the stack and start a new merge", first.target);
    }
    const remainingSelected = selected.filter((p) => !landed.has(p.number));
    const prefix = fresh.stack.prs.slice(0, fresh.stack.prs.findIndex((p) => p.number === first.target) + 1);
    if (prefix.length !== remainingSelected.length || prefix.some((p, i) => p.number !== remainingSelected[i]?.number)) {
      stopped("selected native stack prefix changed; review the stack and start a new merge", first.target);
    }
  };

  const initialMerges = first.plan.filter((s) => s.kind === "merge");
  if (stack.native && initialMerges.length > 1) {
    const firstIncludes = initialMerges[0]!.includes ?? [initialMerges[0]!.pr];
    const remaining = stack.prs.filter((p) => !firstIncludes.includes(p.number));
    // A rebase can reset checks/reviews and split a formerly atomic clean group into individual bypass merges.
    const bottoms = selected.filter((p) => !firstIncludes.includes(p.number));
    try {
      await preflightNativeRebase(ctx, remaining, bottoms);
    } catch (e) {
      const failed: StepResult = { step: { kind: "rebase-stack", pr: bottoms[0]!.number }, ok: false, detail: e instanceof Error ? e.message : String(e) };
      // the rebase runs after the first merge lands, so that is where it sits in the plan
      opts.onPlan?.([first.plan[0]!, failed.step, ...first.plan.slice(1)]);
      results.push(failed);
      opts.onStep?.(failed);
      stopped(failed.detail, bottoms[0]!.number, e instanceof StkError && e.code === "no-worktree" ? { worktrees: (e.data as MissingWorktrees).worktrees } : {});
    }
  }

  let cur = first;
  for (;;) {
    const merges = cur.plan.filter((s) => s.kind === "merge");
    // one merge call (or a classic stack) runs as planned; only a plan with later merges is re-planned between them
    if (!stack.native || merges.length <= 1) {
      results.push(...(await executePlan(cur.plan, deps)));
      break;
    }
    const run = await executePlan([merges[0]!], deps);
    results.push(...run);
    landedBy(run);
    if (run.some((r) => !r.ok || r.enqueued) || landed.has(first.target)) break;

    // The landed merge changes the next PR's base (GitHub retargets it, and may rebase it): wait for GitHub to recompute
    // its mergeability rather than force-merge the head it had a moment ago.
    let { fresh, stale, staleHead, checking } = await replanNative(ctx, first.target, opts, landed, opts.replan ?? {}, expectedHeads);
    validateReplan(fresh, stale);
    if (staleHead !== null) stopped(`GitHub has not reflected the pushed head of #${staleHead} (${expectedHeads[staleHead]}); refusing to merge a stale head`, staleHead);
    const note = fresh.notes.find((x) => x.action === "rebase-stack");
    if (note) {
      const rebase: PlanStep = { kind: "rebase-stack", pr: note.pr };
      opts.onPlan?.([...results.map((r) => r.step), rebase, ...fresh.plan]);
      const rebased = await executePlan([rebase], deps);
      results.push(...rebased);
      if (rebased.some((r) => !r.ok)) break;
      ({ fresh, stale, staleHead, checking } = await replanNative(ctx, first.target, opts, landed, opts.replan ?? {}, expectedHeads));
      validateReplan(fresh, stale);
      if (staleHead !== null) stopped(`GitHub has not reflected the pushed head of #${staleHead} (${expectedHeads[staleHead]}); refusing to merge a stale head`, staleHead);
    }
    if (checking !== null) stopped(`GitHub is still checking it for conflicts after #${[...landed].at(-1)} landed; merge again once that settles`, checking);
    opts.onPlan?.([...results.map((r) => r.step), ...fresh.plan]);
    if (!fresh.plan.some((s) => s.kind === "merge")) {
      const why = stopReason(fresh.stack, fresh.plan, fresh.target, blockersByPr(fresh.stack, fresh.trunk, fresh.rules), opts.force);
      stopped(why?.reason ?? "nothing left to merge", why?.pr ?? fresh.stack.prs[0]!.number);
    }
    cur = fresh;
  }
  const failed = results.find((r) => !r.ok);
  if (failed) {
    const s = failed.step;
    const at = "pr" in s ? `#${s.pr}` : s.branch;
    throw new StkError(`stack merge stopped at ${at}: ${failed.detail.replace(/^merge of #\d+ failed: /, "")}`, "step-failed", { results });
  }
  // a native merge step lands its whole `includes`; queued (enqueued) merges have not landed anything yet
  const mergedSet = new Set(
    results.flatMap((r) => (r.step.kind === "merge" && !r.enqueued ? (r.step.includes ?? [r.step.pr]) : [])),
  );
  const total = stack.prs.map((p) => p.number);
  return {
    results,
    total,
    merged: total.filter((x) => mergedSet.has(x)),
    remaining: total.filter((x) => !mergedSet.has(x)),
  };
}

export interface CreateStackResult {
  /** GitHub's stack number. */
  stack: number;
  prs: number[];
}

/**
 * Turn a classic chain into a GitHub stack. `prs` is bottom to top; every PR must be open, each based on the previous
 * one's branch and the bottom one on the trunk (GitHub requires it). Says exactly what blocks it otherwise.
 */
export async function createStack(ctx: Ctx, prs: number[]): Promise<CreateStackResult> {
  if (prs.length < 2) throw new StkError("a stack needs at least two PRs", "usage");
  const [trunk, details] = await Promise.all([trunkFor(ctx.exec, at(ctx)), prDetails(ctx.exec, at(ctx), prs)]);
  for (const [i, p] of details.entries()) {
    if (p.state !== "OPEN") throw new StkError(`#${p.number} is not open`, "usage");
    const want = i === 0 ? trunk : details[i - 1]!.headRef;
    if (p.baseRef !== want) {
      const fix = i === 0 ? `retarget it to ${trunk} first (:base)` : `it must be based on #${details[i - 1]!.number}'s branch (${want})`;
      throw new StkError(`#${p.number} targets ${p.baseRef}, not ${want}; ${fix}`, "usage");
    }
  }
  const r = await createPrStack(ctx.exec, at(ctx), prs);
  return { stack: r.number, prs };
}

export interface RebaseStackResult {
  /** Open PRs of the stack whose branches were rebased and force-pushed. */
  prs: number[];
}

/** A worktree holding a stack branch that has uncommitted changes (`StkError` data of a `dirty-worktree` rebase refusal). */
export interface DirtyWorktree {
  path: string;
  files: string[];
}

const cleanGhText = (r: { stderr: string; stdout: string }) => (r.stderr || r.stdout).trim().replace(/^[✗×x]\s+/, "");

/** Shared read-only prerequisites for native rebases; callers still check again immediately before actual mutation. */
async function preflightNativeRebase(ctx: Ctx, open: PullRequest[], bottoms: PullRequest[], stash = false) {
  const root = requireRoot(ctx, "rebase a stack");
  const ext = await ctx.exec(["gh", "stack", "--version"], { cwd: root });
  if (ext.code !== 0) {
    throw new StkError("the gh-stack extension is not installed; install it with: gh extension install github/gh-stack", "gh-failed");
  }
  const worktrees = await listWorktrees(ctx.exec, root);
  const cwds: Record<number, string> = {};
  const attach: { path: string; branch: string; tip: string }[] = [];
  const missing: MissingWorktrees["worktrees"] = [];
  // Every segment's bottom must already have its branch checked out (or be detached at its tip); gh stack may not switch an unrelated worktree.
  for (const pr of bottoms) {
    const found = resolveWorktree(worktrees, pr.headRef, pr.headSha);
    if (found.kind === "none") missing.push({ pr: pr.number, branch: pr.headRef });
    else cwds[pr.number] = found.worktree.path;
  }
  // Every open member sitting in a detached worktree gets its branch back before gh stack rewrites anything, so each
  // later rebase finds its worktree; whether that can be done is checked now (nothing is merged yet), changing nothing.
  for (const pr of open) {
    const found = resolveWorktree(worktrees, pr.headRef, pr.headSha);
    if (found.kind !== "detached") continue;
    await planAttach(ctx.exec, found.worktree.path, pr.headRef, pr.headSha);
    attach.push({ path: found.worktree.path, branch: pr.headRef, tip: pr.headSha });
  }
  if (missing.length > 0) {
    const what = missing.map((m) => `#${m.pr}'s branch (${m.branch})`).join(" or ");
    throw new StkError(`no worktree has ${what} checked out; open one with: stk worktree ${missing[0]!.pr}`, "no-worktree", { worktrees: missing });
  }
  const dirty: DirtyWorktree[] = [];
  for (const pr of open) {
    const found = resolveWorktree(worktrees, pr.headRef, pr.headSha);
    const path = found.kind === "none" ? undefined : found.worktree.path;
    if (!path || dirty.some((d) => d.path === path)) continue;
    const st = await ctx.exec(["git", "status", "--porcelain"], { cwd: path });
    if (st.code !== 0) throw new StkError(`git status failed in ${path}: ${st.stderr.trim()}`, "git-failed");
    const files = st.stdout.split("\n").filter(Boolean).map((l) => l.slice(3));
    if (files.length > 0) dirty.push({ path, files });
  }
  if (dirty.length > 0 && !stash) {
    throw new StkError(
      `Rebase stack didn't start: ${dirty.map((d) => `${d.path} has uncommitted changes (${d.files.join(", ")})`).join("; ")}`,
      "dirty-worktree",
      { worktrees: dirty },
    );
  }
  return { cwds, dirty, attach };
}

/**
 * Rebase a native stack the way GitHub's "Rebase stack" button does, locally. GitHub exposes no API for it (the REST
 * stacks endpoints only list/create/extend/dissolve), so this drives the `gh stack` extension inside the worktree that
 * has PR `n`'s branch checked out: `gh stack checkout n`, `gh stack rebase`, `gh stack push`.
 *
 * Before any `gh stack` call every worktree holding a stack branch is checked for uncommitted changes (gh stack refuses to
 * start otherwise): refused with `dirty-worktree` (data `{worktrees: DirtyWorktree[]}`), or with `stash` each dirty
 * worktree is stashed first and restored afterwards, also when the rebase fails. A real conflict aborts the rebase.
 */
export async function rebaseStack(ctx: Ctx, n: number, opts: { onStep?: (what: string) => void; stash?: boolean; label?: string } = {}): Promise<RebaseStackResult> {
  requireRoot(ctx, "rebase a stack");
  const detail = await nativeStackDetail(ctx.exec, at(ctx), n);
  const pr = detail?.members.find((m) => m.pr.number === n)?.pr;
  if (!detail || !pr || pr.state !== "OPEN") throw new StkError(`PR #${n} is not an open member of a GitHub stack`, "usage");
  const open = detail.members.filter((m) => m.pr.state === "OPEN").map((m) => m.pr);
  const prs = open.map((m) => m.number);
  const gh = async (args: string[], cwd: string) => ctx.exec(["gh", "stack", ...args], { cwd });
  const { cwds, dirty, attach } = await preflightNativeRebase(ctx, open, [pr], opts.stash);
  const cwd = cwds[n]!;
  // an agent's worktree sits on a detached HEAD at the branch tip: `gh stack` needs the branch itself checked out
  for (const a of attach) {
    opts.onStep?.(`checking out ${a.branch} in ${a.path}`);
    await attachBranch(ctx.exec, a.path, a.branch, a.tip);
  }

  const label = `stk rebase-stack ${opts.label ?? n}`;
  const stashed: { path: string; sha: string }[] = [];
  let failure: unknown;
  try {
    for (const d of dirty) {
      opts.onStep?.(`stashing ${d.path}`);
      const r = await ctx.exec(["git", "stash", "push", "-u", "-m", `${label} ${d.path}`], { cwd: d.path });
      if (r.code !== 0) throw new StkError(`git stash failed in ${d.path}: ${cleanGhText(r)}`, "git-failed");
      const head = await ctx.exec(["git", "rev-parse", "stash@{0}"], { cwd: d.path });
      if (head.code !== 0) throw new StkError(`could not identify the stash made in ${d.path}: ${cleanGhText(head)}`, "git-failed");
      stashed.push({ path: d.path, sha: head.stdout.trim() });
    }
    const step = async (what: string, args: string[]) => {
      opts.onStep?.(what);
      const r = await gh(args, cwd);
      if (r.code !== 0) throw new StkError(`Rebase stack failed at gh stack ${args.join(" ")}: ${cleanGhText(r)}`, "gh-failed");
    };
    await step("tracking the stack", ["checkout", String(n)]);
    opts.onStep?.("rebasing");
    const rebased = await gh(["rebase"], cwd);
    if (rebased.code !== 0) {
      const text = cleanGhText(rebased);
      if (!/conflict/i.test(text)) throw new StkError(`Rebase stack failed: ${text}`, "gh-failed");
      await gh(["rebase", "--abort"], cwd);
      throw new StkError(`rebase of the stack conflicted and was aborted: ${text}`, "rebase-conflict");
    }
    await step("pushing", ["push"]);
  } catch (e) {
    failure = e;
  }
  // Restore each worktree's own stash by SHA, last first, whatever happened. Stashes are shared by all linked worktrees,
  // so nothing is ever looked up by position or label: a stash that will not apply is left in place (named by sha and
  // path) and the others are still restored.
  const stuck: { path: string; sha: string }[] = [];
  for (const { path, sha } of stashed.reverse()) {
    opts.onStep?.(`restoring ${path}`);
    const applied = await ctx.exec(["git", "stash", "apply", "--index", sha], { cwd: path });
    if (applied.code !== 0) {
      stuck.push({ path, sha });
      continue;
    }
    const list = await ctx.exec(["git", "stash", "list", "--format=%H %gd"], { cwd: path });
    const ref = list.stdout.split("\n").find((l) => l.startsWith(`${sha} `))?.split(" ")[1];
    if (ref) await ctx.exec(["git", "stash", "drop", ref], { cwd: path });
  }
  if (stuck.length > 0) {
    const note = `could not restore your changes in ${stuck.map((s) => `${s.path} (stash ${s.sha}, kept in git stash)`).join(", ")}`;
    const base = failure instanceof Error ? `${failure.message}; ` : "";
    throw new StkError(`${base}${note}`, failure instanceof StkError ? failure.code : "git-failed", failure instanceof StkError ? failure.data : undefined);
  }
  if (failure) throw failure;
  return { prs };
}

// ---------- session ----------

export type SessionPr = BoardPr & {
  repo: RepoSlug;
  /** How the session touched this PR: first/last JSONL line, qualifying mention count, strongest role. */
  mention: { first: number; last: number; count: number; role: "created" | "acted" | "discussed" };
  /** How urgently the PR needs the user; higher first. `reason` labels `kind`; `next` = the viewer's move. */
  rank: { score: number; reason: string; kind: Readiness; next: boolean };
  /** Local checkout of the repo, when one was found. */
  repoDir: string | null;
  mergedAt?: string;
  closedAt?: string;
};
export interface SessionPrs {
  groups: { open: SessionPr[]; merged: SessionPr[]; closed: SessionPr[] };
  /** Repos whose PRs could not be fetched (no access, gh failure). */
  errors: { repo: RepoSlug; message: string }[];
}

export type Readiness = "merged" | "closed" | "draft" | "failing" | "changes" | "conflicts" | "threads" | "pending" | "needs-review" | "behind" | "blocked" | "ready" | "unknown";

/**
 * The one readiness verdict for a PR, shared by the board's status word and the session ranking. `ready` only when
 * open, not draft, checks all green (no failing/pending), mergeable, and review is APPROVED or not required (null);
 * REVIEW_REQUIRED is `needs-review`. Otherwise the first blocker in this order: failing checks, changes requested,
 * conflicts, unresolved threads, pending checks, review required, unknown mergeability.
 */
export function prReadiness(
  p: Pick<PullRequest, "state" | "isDraft" | "mergeable" | "mergeState" | "reviewDecision" | "checks" | "unresolvedThreads">,
): Readiness {
  if (p.state === "MERGED") return "merged";
  if (p.state === "CLOSED") return "closed";
  if (p.isDraft) return "draft";
  if (p.checks.some((c) => c.state === "fail")) return "failing";
  if (p.reviewDecision === "CHANGES_REQUESTED") return "changes";
  if (p.mergeable === "CONFLICTING" || p.mergeState === "DIRTY") return "conflicts";
  if (p.unresolvedThreads > 0) return "threads";
  if (p.checks.some((c) => c.state === "pending")) return "pending";
  if (p.reviewDecision === "REVIEW_REQUIRED") return "needs-review";
  if (p.mergeable !== "MERGEABLE" || p.mergeState === "UNKNOWN") return "unknown";
  if (p.mergeState === "BEHIND") return "behind";
  if (p.mergeState === "BLOCKED") return "blocked";
  return "ready";
}

const READINESS_REASON: Record<Readiness, string> = {
  merged: "merged",
  closed: "closed",
  draft: "draft",
  failing: "checks failing",
  changes: "changes requested",
  conflicts: "conflicts",
  threads: "unresolved threads",
  pending: "checks pending",
  "needs-review": "needs review",
  behind: "behind base",
  blocked: "blocked by repository rules",
  ready: "ready to merge",
  unknown: "mergeability unknown",
};

const READINESS_SCORE: Record<Readiness, number> = {
  ready: 100,
  failing: 80,
  changes: 70,
  conflicts: 60,
  threads: 55,
  "needs-review": 50,
  behind: 45,
  blocked: 42,
  pending: 40,
  unknown: 20,
  draft: 10,
  merged: 0,
  closed: 0,
};

/**
 * Urgency of a session PR (see `prReadiness`). `next` is true when the next action is the viewer's: ready to merge,
 * their own PR with failing checks, changes requested, conflicts, or unresolved threads. Someone else's failing
 * checks score 30 and are not `next`.
 */
export function rankSessionPr(
  p: Pick<PullRequest, "state" | "isDraft" | "author" | "mergeable" | "mergeState" | "reviewDecision" | "checks" | "unresolvedThreads">,
  viewer: string | null,
): { score: number; reason: string; kind: Readiness; next: boolean } {
  const kind = prReadiness(p);
  const mine = !!viewer && p.author.toLowerCase() === viewer.toLowerCase();
  if (kind === "failing" && !mine) return { score: 30, reason: READINESS_REASON.failing, kind, next: false };
  const next = kind === "ready" || kind === "changes" || kind === "conflicts" || kind === "threads" || (kind === "failing" && mine);
  return { score: READINESS_SCORE[kind], reason: READINESS_REASON[kind], kind, next };
}

/** Higher rank first; then most recently mentioned; then created > acted > discussed. */
export function compareSessionPrs(a: SessionPr, b: SessionPr): number {
  return b.rank.score - a.rank.score || b.mention.last - a.mention.last || roleRank(b.mention.role) - roleRank(a.mention.role);
}

/** Repos gh cannot see (placeholders, typos, no access) are skipped quietly rather than reported as errors. */
const UNRESOLVABLE = /could not resolve|not found|not accessible/i;

/** PRs mentioned in the agent session of Tern pane `paneId`, grouped open / merged / closed across repos. */
export async function sessionPrs(exec: Exec, paneId: string): Promise<SessionPrs> {
  const [refs, viewer] = await Promise.all([
    sessionPrRefs(exec, paneId),
    exec(["gh", "api", "user", "--jq", ".login"]).then(
      (r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null),
      () => null,
    ),
  ]);
  const byRepo = new Map<string, { repo: RepoSlug; numbers: number[] }>();
  for (const r of refs) {
    const key = `${r.owner}/${r.name}`.toLowerCase();
    const entry = byRepo.get(key) ?? { repo: { owner: r.owner, name: r.name }, numbers: [] };
    entry.numbers.push(r.number);
    byRepo.set(key, entry);
  }
  const mentions = new Map(refs.map((r) => [`${r.owner}/${r.name}#${r.number}`.toLowerCase(), r.mention]));
  const errors: SessionPrs["errors"] = [];
  const perRepo = await Promise.all(
    [...byRepo.values()].map(async ({ repo, numbers }): Promise<SessionPr[]> => {
      try {
        const [fetched, repoDir] = await Promise.all([
          fetchSessionPrs(exec, repo, numbers),
          resolveRepo(exec, repo.owner, repo.name),
        ]);
        const trunk = fetched.trunk ?? "main";
        const [worktrees, rules] = await Promise.all([repoDir ? listWorktrees(exec, repoDir).catch(() => []) : Promise.resolve([]), rulesFor(exec, repo, trunk)]);
        return fillWorktrees(fetched.prs, worktrees).map((p, i) => {
          const src = fetched.prs[i]!;
          return {
            ...p,
            blockers: p.state === "OPEN" ? blockers(p, trunk, rules) : [],
            repo,
            repoDir,
            mention: mentions.get(`${repo.owner}/${repo.name}#${p.number}`.toLowerCase())!,
            rank: rankSessionPr(p, viewer),
            ...(src.mergedAt ? { mergedAt: src.mergedAt } : {}),
            ...(src.closedAt ? { closedAt: src.closedAt } : {}),
          };
        });
      } catch (e) {
        if (!(e instanceof StkError)) throw e;
        if (!UNRESOLVABLE.test(e.message)) errors.push({ repo, message: e.message });
        return [];
      }
    }),
  );
  const all = perRepo.flat();
  const newestFirst = (key: "mergedAt" | "closedAt") => (a: SessionPr, b: SessionPr) =>
    (b[key] ?? "").localeCompare(a[key] ?? "");
  return {
    groups: {
      open: all.filter((p) => p.state === "OPEN").sort(compareSessionPrs),
      merged: all.filter((p) => p.state === "MERGED").sort(newestFirst("mergedAt")),
      closed: all.filter((p) => p.state === "CLOSED").sort(newestFirst("closedAt")),
    },
    errors,
  };
}

/** GitHub-side PR search over one owner for the palette (REST search bucket; call on explicit request only). */
export async function searchPalette(ctx: Pick<Ctx, "exec">, owner: string, query: string): Promise<PaletteItem[]> {
  return searchPrs(ctx.exec, owner, query);
}

export type PrAction = "close" | "reopen" | "ready" | "draft" | "rerun" | "update-branch";

export interface PrActionResult {
  number: number;
  action: PrAction;
  /** Workflow run ids whose failed jobs were re-run (`rerun` only). */
  runs?: number[];
}

/** One PR state mutation: close, reopen, mark ready / back to draft, or re-run failed checks. */
export async function prAction(ctx: Ctx, n: number, action: PrAction): Promise<PrActionResult> {
  const where = at(ctx);
  switch (action) {
    case "close":
      await closePr(ctx.exec, where, n);
      break;
    case "reopen":
      await reopenPr(ctx.exec, where, n);
      break;
    case "ready":
      await markReady(ctx.exec, where, n);
      break;
    case "draft":
      await markReady(ctx.exec, where, n, true);
      break;
    case "update-branch": {
      const pr = await getPr(ctx.exec, where, n);
      if (pr.state !== "OPEN") throw new StkError(`PR #${n} is ${pr.state.toLowerCase()}, not open`, "usage");
      if (pr.mergeable === "CONFLICTING" || pr.mergeState === "DIRTY") {
        throw new StkError(`PR #${n} conflicts with ${pr.baseRef}; update-branch cannot resolve conflicts`, "usage");
      }
      await updateBranch(ctx.exec, where, n, pr.headSha);
      break;
    }
    case "rerun":
      return { number: n, action, runs: (await rerunFailedChecks(ctx.exec, where, n)).runs };
  }
  return { number: n, action };
}

/** Change a PR's base branch (`gh pr edit --base`). The branch name is validated before it reaches gh. */
export async function retargetBase(ctx: Ctx, n: number, base: string): Promise<{ number: number; base: string }> {
  const b = base.trim();
  if (!b || b.startsWith("-") || /\s|\.\.|[~^:?*[\\]/.test(b)) throw new StkError(`not a valid branch name: ${base}`, "usage");
  await retargetPr(ctx.exec, at(ctx), n, b);
  return { number: n, base: b };
}

/**
 * `:gh <args>`: run gh for the palette with the repo / PR filled in. Mutating or unknown commands run only when
 * `confirmed` (the caller shows the confirm sheet first). Never throws on a nonzero exit: that is the result.
 */
export async function ghProxy(ctx: Ctx, line: string, o: { n?: number | null; confirmed?: boolean }): Promise<GhResult> {
  const repo = ctx.slug ?? (ctx.root ? await repoSlug(ctx.exec, ctx.root) : null);
  const planned = planGh(line, { repo, n: o.n ?? null });
  if (!planned.ok) throw new StkError(planned.error, "usage");
  const { plan } = planned;
  if (plan.mutating && !o.confirmed) throw new StkError(`confirmation required: ${plan.display}`, "usage");
  const r = await ctx.exec(plan.argv, { ...(ctx.root ? { cwd: ctx.root } : {}), env: GH_ENV });
  return { command: plan.display, code: r.code, mutating: plan.mutating, output: formatGhOutput(r.stdout, r.stderr, r.code) };
}

// ---------- rerun a required check that never reported ----------

export type RerunStep =
  /** Re-run a GitHub Actions workflow run that has the context's job. */
  | { kind: "rerun-run"; runId: number; name: string; failedOnly: boolean; contexts: string[] }
  /** Ask the app (a third-party check app, say) to re-run its check suite. */
  | { kind: "rerequest-suite"; suiteId: number; app: string; contexts: string[] }
  /** Nothing produces the check: push an empty commit to the PR branch from its worktree. */
  | { kind: "empty-commit"; branch: string; worktree: string; contexts: string[] };

export interface RerunRequiredPlan {
  number: number;
  headSha: string;
  /** Required checks that never reported on the head. */
  contexts: string[];
  steps: RerunStep[];
}

/** One line per step, for the confirm sheet. */
export function describeRerunStep(s: RerunStep): string {
  const for_ = s.contexts.join(", ");
  switch (s.kind) {
    case "rerun-run":
      return `Re-run ${s.failedOnly ? "failed jobs of " : ""}workflow “${s.name || `run ${s.runId}`}” (run ${s.runId}) for ${for_}`;
    case "rerequest-suite":
      return `Re-request the ${s.app} check suite for ${for_}`;
    case "empty-commit":
      return `Push an empty commit (“${RETRIGGER_MESSAGE}”) to ${s.branch} from ${s.worktree}: nothing can be re-run for ${for_}`;
  }
}

const RERUN_FAILED_CONCLUSIONS = new Set(["failure", "timed_out"]);

/**
 * Decide how to get the required checks that never reported on #n's head to report. Prefers re-running what produces
 * them: a workflow run that has the job (`gh run rerun`), else a non-Actions check suite that never produced a run
 * (`rerequest`). When any context has neither, the one path is an empty commit pushed from the branch's worktree.
 * `opts.contexts` overrides the missing-context detection (tests, explicit callers).
 */
export async function planRerunRequired(ctx: Ctx, n: number, opts: { contexts?: string[] } = {}): Promise<RerunRequiredPlan> {
  const where = at(ctx);
  const pr = await getPr(ctx.exec, where, n);
  if (pr.state !== "OPEN") throw new StkError(`PR #${n} is ${pr.state.toLowerCase()}, not open`, "usage");
  let contexts = opts.contexts;
  if (!contexts) {
    const [trunk, repo] = await Promise.all([trunkFor(ctx.exec, where), repoSlug(ctx.exec, where)]);
    const rules = await rulesFor(ctx.exec, repo, trunk);
    contexts = blockers(pr, trunk, rules).flatMap((b) => (b.kind === "required-check" ? [b.context] : []));
  }
  if (contexts.length === 0) throw new StkError(`#${n} has no required check missing from its head`, "usage");

  const [checkRuns, suites, runs] = await Promise.all([
    commitCheckRuns(ctx.exec, where, pr.headSha),
    commitCheckSuites(ctx.exec, where, pr.headSha),
    headWorkflowRuns(ctx.exec, where, pr.headSha),
  ]);
  const jobs = new Map<number, string[]>();
  const jobsOf = async (id: number) => {
    const hit = jobs.get(id);
    if (hit) return hit;
    const names = await workflowRunJobs(ctx.exec, where, id);
    jobs.set(id, names);
    return names;
  };
  const neverRan = suites.filter((s) => s.app !== "github-actions" && s.runCount === 0);

  const steps: RerunStep[] = [];
  const addStep = (step: RerunStep) => {
    const same = steps.find((s) => (s.kind === "rerun-run" && step.kind === "rerun-run" && s.runId === step.runId) || (s.kind === "rerequest-suite" && step.kind === "rerequest-suite" && s.suiteId === step.suiteId));
    if (same) same.contexts.push(...step.contexts);
    else steps.push(step);
  };
  const unresolved: string[] = [];
  for (const context of contexts) {
    const own = checkRuns.find((r) => r.name === context);
    let run: { id: number; name: string; status: string; conclusion: string | null } | undefined = own?.workflowRunId ? runs.find((r) => r.id === own.workflowRunId) : undefined;
    if (!run && !own) {
      for (const r of runs) {
        const names = await jobsOf(r.id);
        if (r.name === context || names.some((j) => j === context || `${r.name} / ${j}` === context)) {
          run = r;
          break;
        }
      }
    }
    if (run) {
      if (run.status !== "completed") throw new StkError(`workflow “${run.name}” is still ${run.status.replace("_", " ")} for ${context}; wait for it`, "usage");
      addStep({ kind: "rerun-run", runId: run.id, name: run.name, failedOnly: RERUN_FAILED_CONCLUSIONS.has(run.conclusion ?? ""), contexts: [context] });
    } else if (own && own.app !== "github-actions" && own.suiteId) {
      addStep({ kind: "rerequest-suite", suiteId: own.suiteId, app: own.app ?? "check", contexts: [context] });
    } else if (!own && neverRan.length > 0) {
      for (const s of neverRan) addStep({ kind: "rerequest-suite", suiteId: s.id, app: s.app ?? "check", contexts: [context] });
    } else {
      unresolved.push(context);
    }
  }
  if (unresolved.length === 0) return { number: n, headSha: pr.headSha, contexts, steps };

  const wt = worktreeForBranch(ctx.worktrees, pr.headRef);
  if (!wt) {
    throw new StkError(`nothing can be re-run for ${unresolved.join(", ")} and no worktree has ${pr.headRef} checked out to push an empty commit from (open one: :worktree)`, "not-a-repo");
  }
  return { number: n, headSha: pr.headSha, contexts, steps: [{ kind: "empty-commit", branch: pr.headRef, worktree: wt.path, contexts: unresolved }] };
}

export interface RerunRequiredResult {
  number: number;
  steps: RerunStep[];
}

/** Carry out a `planRerunRequired` plan. */
export async function rerunRequired(ctx: Ctx, plan: RerunRequiredPlan): Promise<RerunRequiredResult> {
  const where = at(ctx);
  for (const s of plan.steps) {
    if (s.kind === "rerun-run") await rerunWorkflowRun(ctx.exec, where, s.runId, s.failedOnly);
    else if (s.kind === "rerequest-suite") await rerequestCheckSuite(ctx.exec, where, s.suiteId);
    else await pushEmptyCommit(ctx.exec, s.worktree, s.branch, plan.headSha);
  }
  return { number: plan.number, steps: plan.steps };
}

// ---------- create a PR from a branch ----------

export interface CreatePrPlan {
  branch: string;
  base: string;
  /** Open PR whose branch is the base (stack-aware), else null: the base is the trunk. */
  baseIsPr: number | null;
  title: string;
  body: string;
  /** Commit subjects since the base, oldest first. */
  commits: string[];
  draft: boolean;
  /** What reaching origin takes before `gh pr create`. */
  push: PushKind;
}

/** Title and body for a branch's commits: first subject (else the branch name) and a bullet per subject. */
export function prText(branch: string, commits: string[]): { title: string; body: string } {
  return { title: commits[0] ?? branch, body: commits.map((c) => `- ${c}`).join("\n") };
}

/** The branch a `:pr` acts on: the given one, else the one checked out in the launch directory. */
async function targetBranch(ctx: Ctx, branch: string | undefined, trunk: string): Promise<string> {
  const b = branch ?? (await currentBranch(ctx.exec, requireRoot(ctx, "read the current branch")));
  if (!b) throw new StkError("HEAD is detached; check out a branch first", "usage");
  if (b === trunk) throw new StkError(`${b} is the trunk; create a branch first`, "usage");
  return b;
}

/** Plan `gh pr create` for a branch without a PR: base = the open PR's branch it was cut from, else the trunk. */
export async function planCreatePr(ctx: Ctx, opts: { branch?: string; draft?: boolean } = {}): Promise<CreatePrPlan> {
  const root = requireRoot(ctx, "create a pull request");
  const [trunk, refs] = await Promise.all([trunkFor(ctx.exec, root), listPrRefs(ctx.exec, root)]);
  const branch = await targetBranch(ctx, opts.branch, trunk);
  const existing = refs.find((r) => r.headRef === branch);
  if (existing) throw new StkError(`${branch} already has PR #${existing.number}`, "usage");
  const parent = await nearestParent(ctx.exec, root, branch, trunk, refs.map((r) => ({ name: r.headRef, prefer: true })));
  const base = parent ?? trunk;
  const commits = await commitSubjects(ctx.exec, root, base, branch);
  if (commits.length === 0) throw new StkError(`${branch} has no commits ahead of ${base}`, "usage");
  const push = await pushKind(ctx.exec, root, branch);
  return {
    branch,
    base,
    baseIsPr: parent ? (refs.find((r) => r.headRef === parent)?.number ?? null) : null,
    ...prText(branch, commits),
    commits,
    draft: opts.draft ?? false,
    push,
  };
}

export interface CreatePrResult {
  number: number;
  url: string;
  branch: string;
  base: string;
}

/** Push the branch when needed, then `gh pr create`. `plan.title` / `plan.draft` may have been edited by the user. */
export async function createPullRequest(ctx: Ctx, plan: Pick<CreatePrPlan, "branch" | "base" | "title" | "body" | "draft" | "push">): Promise<CreatePrResult> {
  const title = plan.title.trim();
  if (!title) throw new StkError("the title is empty", "usage");
  if (plan.push !== "none") await pushBranch(ctx.exec, requireRoot(ctx, "push the branch"), plan.branch);
  const r = await createPr(ctx.exec, at(ctx), { head: plan.branch, base: plan.base, title, body: plan.body, draft: plan.draft });
  return { ...r, branch: plan.branch, base: plan.base };
}

// ---------- submit a local chain of branches as PRs + a GitHub stack ----------

export interface StackSubmitEntry {
  branch: string;
  base: string;
  /** Existing open PR of the branch, else null: it will be created. */
  pr: number | null;
  /** Existing PR targeting the wrong branch: its current base, which will be retargeted. */
  retargetFrom: string | null;
  title: string;
  body: string;
  commits: string[];
  push: PushKind;
}

export interface StackSubmitPlan {
  trunk: string;
  draft: boolean;
  /** Bottom first. */
  entries: StackSubmitEntry[];
}

/** One line per entry, for the confirm sheet. */
export function describeSubmitEntry(e: StackSubmitEntry): string {
  if (e.pr !== null) return `#${e.pr} ${e.branch}${e.retargetFrom ? ` (retarget ${e.retargetFrom} → ${e.base})` : ""}`;
  return `new ${e.branch} → ${e.base}${e.push === "none" ? "" : " (push)"}: ${e.title}`;
}

/**
 * Walk down from `branch` to the trunk: each branch sits on its nearest ancestor among the local branches and open-PR
 * branches (merge-base), whatever its PR currently targets (a wrong PR base is retargeted). Returns the chain bottom first.
 */
export async function planStackSubmit(ctx: Ctx, opts: { branch?: string; draft?: boolean } = {}): Promise<StackSubmitPlan> {
  const root = requireRoot(ctx, "submit a stack");
  const [trunk, refs, locals] = await Promise.all([trunkFor(ctx.exec, root), listPrRefs(ctx.exec, root), localBranches(ctx.exec, root)]);
  const top = await targetBranch(ctx, opts.branch, trunk);
  const prFor = new Map(refs.map((r) => [r.headRef, r]));
  const candidates = [...new Set([...locals, ...refs.map((r) => r.headRef)])].map((name) => ({ name, prefer: prFor.has(name) }));
  const chain: { branch: string; parent: string | null }[] = [];
  const seen = new Set<string>();
  for (let cur: string | null = top; cur; ) {
    if (seen.has(cur)) throw new StkError(`the PR bases of ${[...seen].join(", ")} form a cycle`, "usage");
    seen.add(cur);
    const parent = await nearestParent(ctx.exec, root, cur, trunk, candidates);
    chain.push({ branch: cur, parent });
    cur = parent;
  }
  if (chain.length < 2) throw new StkError(`${top} is cut from ${trunk}, not from another branch; there is no chain to stack`, "usage");
  const entries: StackSubmitEntry[] = [];
  for (const { branch, parent } of chain.reverse()) {
    const base = parent ?? trunk;
    const pr = prFor.get(branch) ?? null;
    const commits = await commitSubjects(ctx.exec, root, base, branch);
    if (!pr && commits.length === 0) throw new StkError(`${branch} has no commits ahead of ${base}`, "usage");
    entries.push({
      branch,
      base,
      pr: pr?.number ?? null,
      retargetFrom: pr && pr.baseRef !== base ? pr.baseRef : null,
      ...prText(branch, commits),
      commits,
      push: pr ? "none" : await pushKind(ctx.exec, root, branch),
    });
  }
  return { trunk, draft: opts.draft ?? false, entries };
}

export interface StackSubmitResult {
  /** PRs created, bottom first. */
  created: { branch: string; number: number; url: string }[];
  stack: CreateStackResult;
}

/** Create the missing PRs bottom-up (pushing their branches), fix wrong bases, then create the GitHub stack. */
export async function stackSubmit(ctx: Ctx, plan: StackSubmitPlan): Promise<StackSubmitResult> {
  const created: StackSubmitResult["created"] = [];
  const numbers: number[] = [];
  const progress = () => (created.length ? ` (already created: ${created.map((c) => `#${c.number}`).join(", ")})` : "");
  try {
    for (const e of plan.entries) {
      if (e.pr !== null) {
        if (e.retargetFrom) await retargetPr(ctx.exec, at(ctx), e.pr, e.base);
        numbers.push(e.pr);
        continue;
      }
      const r = await createPullRequest(ctx, { ...e, draft: plan.draft });
      created.push({ branch: e.branch, number: r.number, url: r.url });
      numbers.push(r.number);
    }
    return { created, stack: await createStack(ctx, numbers) };
  } catch (e) {
    if (!(e instanceof StkError) || created.length === 0) throw e;
    throw new StkError(`${e.message}${progress()}`, e.code, e.data);
  }
}
