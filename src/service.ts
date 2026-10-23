/**
 * Command data logic shared by the CLI and the TUI. Every function returns plain
 * data (the CLI's JSON `data` shapes) and throws StkError on failure.
 */
import { join } from "node:path";
import type { PaletteItem } from "./fuzzy";
import { GH_ENV, formatGhOutput, planGh, type GhResult } from "./ghproxy";
import { git, listWorktrees, repoRoot, resolveWorktree, worktreeForBranch } from "./git";
import { behindText, preflightRestack, restackAndPush, type RestackInput } from "./restack";
import { provenanceKey } from "./provenance";
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
  closeAndReopenPr,
  behindBy,
  branchRules,
  repoMergeMethods,
  fetchSessionPrs,
  getPr,
  listPrs,
  mergeAsync,
  nativeStack,
  listPrRefs,
  prDetails,
  createPrStack,
  pullState,
  setPrBase,
  unstackPrStack,
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
import { blockers, chainThrough, executePlan, findForks, isHardBlocker, isQueueDeferrableBlocker, memberBlockers, planNativeStackMerge, planStackMerge, stackFor, treeOf, type ExecuteDeps, type Fork } from "./stack";
import { assertMethodAllowed, effectiveMethod, fallbackNote, intersectMethods } from "./methods";
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
  inMergeQueue?: boolean;
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
  /** The method the merge would send: the requested one, or the allowed one that replaces it. */
  method: MergeMethod;
  methodNote?: string;
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
  /** The method the plan was made for: the requested one, or the allowed one that replaced it. */
  method: MergeMethod;
  /** Why the requested method was replaced (e.g. "merge commits not allowed on dev; merged with squash instead"). */
  methodNote?: string;
}

export interface StackMergeResult {
  results: StepResult[];
  /** PR numbers in the stack. */
  total: number[];
  merged: number[];
  remaining: number[];
  /** Set when the remembered merge method was not allowed on the trunk and another was used. */
  note?: string;
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

const settingsCache = new Map<string, { at: number; methods: Promise<MergeMethod[] | null> }>();

/**
 * The merge methods allowed into `branch`: the repo settings intersected with the branch rules' pull_request
 * `allowed_merge_methods`. Repo settings cached like the rules (~10 min); null when they cannot be read (rate limits
 * surface), in which case callers keep their current behaviour.
 */
export async function allowedMethodsFor(exec: Exec, where: string | RepoSlug, branch: string): Promise<MergeMethod[] | null> {
  const slug = typeof where === "string" ? await repoSlug(exec, where) : where;
  const key = `${slug.owner}/${slug.name}`.toLowerCase();
  let hit = settingsCache.get(key);
  if (!hit || Date.now() - hit.at >= RULES_TTL_MS) {
    const methods = repoMergeMethods(exec, slug).catch((e) => {
      if (!(e instanceof StkError) || e.code === "rate-limited") {
        settingsCache.delete(key);
        throw e;
      }
      return null;
    });
    hit = { at: Date.now(), methods };
    settingsCache.set(key, hit);
  }
  const [repoWide, rules] = await Promise.all([hit.methods, rulesFor(exec, slug, branch)]);
  return intersectMethods(repoWide, rules?.allowedMergeMethods ?? null);
}

/** Test hook: forget cached rules and repo settings. */
export const clearRulesCache = () => {
  rulesCache.clear();
  settingsCache.clear();
};

/**
 * The method to send for a merge into `branch`, decided at execution time (the TUI's allowed-set read may not have
 * landed yet). A requested method the base rejects is swapped for the effective one with a note; an `explicit` one
 * (CLI `--method`) throws instead, listing the allowed methods. An unreadable allowed set changes nothing.
 */
export async function settleMethod(ctx: Ctx, requested: MergeMethod, branch: string, explicit: boolean): Promise<{ method: MergeMethod; note?: string }> {
  const allowed = await allowedMethodsFor(ctx.exec, at(ctx), branch).catch((e) => {
    // a rate limit must surface (the merge would fail on it anyway); any other unreadable set keeps the requested method
    if (e instanceof StkError && e.code === "rate-limited") throw e;
    return null;
  });
  if (explicit) {
    assertMethodAllowed(requested, allowed, branch);
    return { method: requested };
  }
  const method = effectiveMethod(requested, allowed);
  if (method === requested) return { method };
  return { method, note: `${fallbackNote(requested, allowed, branch)}; merged with ${method} instead` };
}

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
  const pr = fillWorktrees([{ ...view.pr, unresolvedThreads, inMergeQueue: discussion.inMergeQueue, ...(behind !== undefined ? { behindBy: behind } : {}) }], ctx.worktrees)[0]!;
  let stack: PrDetail["stack"] = null;
  if (pr.state !== "OPEN" && native) {
    // GitHub keeps `stack` for merged/closed PRs, so merged members stay listed; the ref chain only knows open PRs
    const entries = native.entries.map((e): StackEntry => (e.number === n ? { number: n, title: pr.title, state: pr.state, isDraft: pr.isDraft, inMergeQueue: pr.inMergeQueue, checks: e.checks } : { number: e.number, title: e.title, state: e.state, isDraft: e.isDraft, inMergeQueue: e.inMergeQueue, checks: e.checks, ...(e.mergeIssue ? { mergeIssue: e.mergeIssue } : {}) }));
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
            return { number: n, title: pr.title, state: pr.state, isDraft: pr.isDraft, inMergeQueue: pr.inMergeQueue, checks, ...(mergeIssue ? { mergeIssue } : {}), ...place };
          }
          const p = known.get(r.number) ?? extra.get(r.number);
          return p
            ? { number: p.number, title: p.title, state: p.state, isDraft: p.isDraft, inMergeQueue: p.inMergeQueue, checks: p.checks, ...(p.mergeIssue ? { mergeIssue: p.mergeIssue } : {}), ...place }
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

type MergeOpts = { method: MergeMethod; /** The method was chosen on purpose (CLI `--method`): a base that rejects it is an error, not a fallback. */ explicitMethod?: boolean; force: boolean; onProgress?: (p: MergeProgress) => void };
export function merge(ctx: Ctx, n: number, opts: MergeOpts & { dryRun: true }): Promise<MergeDryRun>;
export function merge(ctx: Ctx, n: number, opts: MergeOpts & { dryRun?: false }): Promise<MergeResult>;
export function merge(ctx: Ctx, n: number, opts: MergeOpts & { dryRun?: boolean }): Promise<MergeDryRun | MergeResult>;
/**
 * Merge one PR via GitHub's merge-async API, resolving once the request is final (merged or enqueued).
 * Throws StkError("blocked", data: {blockers}) when blocked (never for dry runs), "merge-timeout" if
 * GitHub is still working after 10 minutes. `force` sends bypass_rules only outside merge queues.
 */
export async function merge(
  ctx: Ctx,
  n: number,
  opts: MergeOpts & { dryRun?: boolean },
): Promise<MergeDryRun | MergeResult> {
  const { force } = opts;
  const trunk = await trunkFor(ctx.exec, at(ctx));
  const [pr, rules] = await Promise.all([getPr(ctx.exec, at(ctx), n), rulesFor(ctx.exec, at(ctx), trunk)]);
  if (pr.state !== "OPEN") throw new StkError(`PR #${n} is ${pr.state.toLowerCase()}, not open`, "usage");
  const queue = pr.baseRef === trunk ? rules?.mergeQueue : undefined;
  const queueForceReason = `#${n} targets a merge queue: --force cannot bypass it; run without --force to enqueue`;
  if (queue && force && !opts.dryRun) throw new StkError(queueForceReason, "blocked");
  // A merge queue owns the method; otherwise settle it against the PR's own base just before sending.
  const settled = queue ? { method: queue.method } : await settleMethod(ctx, opts.method, pr.baseRef, opts.explicitMethod === true);
  const method = settled.method;

  let bs = blockers(pr, trunk, rules);
  // The queue evaluates pending checks and transient mergeability; known failing checks still block.
  if (queue) bs = bs.filter((b) => !isQueueDeferrableBlocker(b));
  if (queue && force) {
    return { wouldMerge: false, method, admin: false, bypass: [], blockers: [...bs, { kind: "blocked" }], note: queueForceReason };
  }
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
      method,
      ...(settled.note ? { methodNote: settled.note } : {}),
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
      `#${n} ${force ? "cannot be force-merged" : "is blocked"}: ${describeBlockers(why)}${force || queue ? "" : " (use --force to bypass)"}`,
      "blocked",
      { blockers: why },
    );
  }
  const out = await mergeAsync(ctx.exec, at(ctx), n, {
    method,
    ...(queue ? { queue: true } : { bypass: force, sha: pr.headSha }),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  const fullNote = [note, settled.note].filter(Boolean).join("; ");
  return {
    number: n,
    method,
    admin: force,
    bypassed: force ? bs : [],
    status: out.status,
    ...(out.sha ? { sha: out.sha } : {}),
    ...(out.uuid ? { uuid: out.uuid } : {}),
    ...(fullNote ? { note: fullNote } : {}),
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
  /** As `MergeOpts.explicitMethod`. */
  explicitMethod?: boolean;
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
  /** The method the plan was made for: the requested one, or the allowed one that replaced it. */
  method: MergeMethod;
  /** Why the requested method was replaced, when it was. */
  methodNote?: string;
}

/**
 * Reads and plans a stack merge with the method settled against its trunk (the same rule `merge` and `stackMerge`
 * apply when they run), so a preview shows what `--merge` would do. The plan is made again when the method changes,
 * since a merge-commit stack plans without restacks.
 */
async function planFor(ctx: Ctx, n: number, opts: PlanOpts): Promise<PlanForResult> {
  const first = await planForMethod(ctx, n, opts);
  const queueMethod = first.rules?.mergeQueue?.method;
  if (queueMethod) {
    return { ...(queueMethod === opts.method ? first : await planForMethod(ctx, n, { ...opts, method: queueMethod })), method: queueMethod };
  }
  const settled = await settleMethod(ctx, opts.method, first.trunk, opts.explicitMethod === true);
  if (settled.method === opts.method) return { ...first, method: opts.method };
  return { ...(await planForMethod(ctx, n, { ...opts, method: settled.method })), method: settled.method, ...(settled.note ? { methodNote: settled.note } : {}) };
}

async function planForMethod(ctx: Ctx, n: number, opts: PlanOpts): Promise<Omit<PlanForResult, "method" | "methodNote">> {
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
    // GitHub does not retarget a stacked PR whose base PR merged by bypass, and refuses a base change while it is stacked: flag it, with the fix
    const notes: StackNote[] = [];
    const bottom = prs[0]!;
    const mergedBase = members.find((m) => m.pr.state === "MERGED" && m.pr.headRef === bottom.baseRef);
    if (mergedBase) {
      notes.push({
        pr: bottom.number,
        text: `#${bottom.number}'s base is a merged branch (${bottom.baseRef})`,
        fix: `GitHub did not retarget it and refuses a base change while it is stacked; stk's rebase-stack rebases it onto ${trunk}, unstacks, points it at ${trunk} and re-creates the stack.`,
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
  const { trunk, stack, forks, plan, target, notes, rules, method, methodNote } = await planFor(ctx, n, opts);
  const perPr = blockersByPr(stack, trunk, rules);
  // the sheet's own rebase (stale base) is the bottom PR; nothing there needs a checkout
  return { stack, forks, plan, blockers: perPr, target, stop: stopReason(stack, plan, target, perPr, opts.force), notes, method, ...(methodNote ? { methodNote } : {}) };
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
  /** How long to wait (elapsed time, planning reads included) for GitHub to retarget and rebase the next PR itself after a merge without bypass. Default 60s. */
  restackWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for the restack wait. Default `Date.now`. */
  now?: () => number;
}

/** After a merge sent without `bypass_rules` GitHub retargets the PRs above it onto the trunk and rebases them itself: what that must look like. */
interface AwaitedRestack {
  /** The heads the remaining PRs had before the merge; every one must change. */
  heads: Record<number, string>;
  method: MergeMethod;
}

/**
 * Re-read a native stack from GitHub and plan again. Right after a merge GitHub may still list the landed PR as open, and
 * right after a merge or a push it reports the new bottom's mergeability as "checking" or still exposes the old heads:
 * poll briefly while any holds. `stale` names a landed PR still open, `staleHead` a pushed head not reflected, and
 * `checking` a bottom PR whose mergeability GitHub is still computing, after attempts run out.
 *
 * With `restack` (the landed merge was not a bypass) GitHub's own retarget and rebase is awaited too, until a deadline
 * `restackWaitMs` after the call (elapsed time, so slow planning reads count; each sleep is capped to what is left): the
 * bottom PR's base must be the trunk and every remaining head must have changed (a `merge`-method stack has nothing to
 * rewrite, so there the trunk base alone is enough once the deadline passed). `restacking` names the PR still waiting at
 * the deadline and `waitedMs` is the time really spent. Once GitHub has restacked, the other conditions get `attempts`
 * more reads (`afterRelink` also holds off on a conflict shown right after a re-link, which GitHub may not have recomputed yet). Nothing is ever pushed locally on this path: it would race GitHub's own push.
 */
async function replanNative(
  ctx: Ctx,
  target: number,
  opts: PlanOpts,
  landed: Set<number>,
  policy: ReplanPolicy,
  expectedHeads: Record<number, string>,
  restack?: AwaitedRestack,
  afterRelink = false,
): Promise<{ fresh: PlanForResult; stale: number | null; staleHead: number | null; checking: number | null; restacking: number | null; waitedMs: number }> {
  const delay = policy.delayMs ?? 2000;
  const attempts = policy.attempts ?? 6;
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = policy.now ?? Date.now;
  const start = now();
  const deadline = start + (policy.restackWaitMs ?? 60_000);
  // reads made while GitHub's own restack is not being waited for
  let reads = 0;
  for (;;) {
    const fresh = await planFor(ctx, target, { ...opts, upTo: target });
    const stale = fresh.stack.prs.find((p) => landed.has(p.number))?.number ?? null;
    const staleHead = Object.entries(expectedHeads).find(([n, sha]) => !landed.has(Number(n)) && fresh.stack.prs.find((p) => p.number === Number(n))?.headSha !== sha);
    const bottom = fresh.stack.prs[0];
    // a bottom still on the merged branch is rebased next, and its mergeability only matters after that push
    const rebaseNext = fresh.notes.some((x) => x.action === "rebase-stack");
    const checking = !rebaseNext && !!bottom && memberBlockers(bottom, fresh.trunk, false, fresh.rules).some((b) => b.kind === "checking") ? bottom.number : null;
    const expired = now() >= deadline;
    const retargeted = !!bottom && bottom.baseRef === fresh.trunk;
    const unchanged = fresh.stack.prs.find((p) => p.headSha === restack?.heads[p.number]);
    const restacking = !restack || !bottom ? null : !retargeted ? bottom.number : unchanged && !(expired && restack.method === "merge") ? unchanged.number : null;
    // right after a re-link GitHub may still show a member as conflicting from before its base was recomputed: give it the same few reads
    const settlingConflict = afterRelink && fresh.stack.prs.some((p, i) => memberBlockers(p, fresh.trunk, i > 0, fresh.rules).some((b) => b.kind === "conflict"));
    const done = stale === null && checking === null && !staleHead && restacking === null && !settlingConflict;
    if (restacking === null) reads++;
    if (done || (restacking !== null ? expired : reads > attempts)) {
      return { fresh, stale, staleHead: staleHead ? Number(staleHead[0]) : null, checking, restacking, waitedMs: now() - start };
    }
    await sleep(restacking !== null ? Math.min(delay, Math.max(deadline - now(), 0)) : delay);
  }
}

/**
 * Execute the stack merge plan. Throws StkError("step-failed", data: {results}) if a step fails.
 *
 * A native plan with several merge steps (each bypass lands alone, GitHub only allows it on the bottom-most unmerged PR)
 * runs one merge at a time and re-reads the stack after each. After a merge sent without bypass GitHub retargets and
 * rebases the PRs above it itself: stk only waits for that (never pushes, it would race). After a bypass merge GitHub does
 * neither, so the remaining PRs are rebased in a temporary checkout and re-linked onto the trunk (`rebaseStack`:
 * unstack, retarget, re-create). Then the plan is made again so the next merge pins the head SHA that resulted.
 * `onPlan` receives the steps that ran plus the current plan whenever it changes.
 */
export async function stackMerge(
  ctx: Ctx,
  n: number,
  given: PlanOpts & { onStep?: (r: StepResult) => void; onProgress?: (p: MergeProgress) => void; onPlan?: (plan: PlanStep[]) => void; replan?: ReplanPolicy },
): Promise<StackMergeResult> {
  // planFor settles the method against the stack's trunk before anything merges: a remembered one it rejects is swapped
  // for an allowed one (and the plan made for that), an explicit one fails
  const first = await planFor(ctx, n, given);
  const opts = { ...given, method: first.method };
  const { stack } = first;
  let expectedHeads: Record<number, string> = {};
  // the PR stk itself re-linked as the last one of the stack (it is in no stack any more); only it may be planned as a plain PR
  let loneRelinked: number | null = null;
  // heads member branches had on origin before this run's restacks (see `rebaseStack`)
  const knownHeads: Record<string, string[]> = Object.create(null);
  const deps: ExecuteDeps = {
    exec: ctx.exec,
    // a native stack merge is API calls only; its rebase runs in a temporary checkout
    repoDir: stack.native ? (ctx.root ?? "") : requireRoot(ctx, "restack/merge a stack"),
    gh: {
      merge: (pr, m, admin, extra) =>
        mergeAsync(ctx.exec, at(ctx), pr, {
          method: first.rules?.mergeQueue?.method ?? m,
          ...(first.rules?.mergeQueue ? { queue: true } : { bypass: admin, ...(extra?.sha ? { sha: extra.sha } : {}) }),
          ...(extra?.onProgress ? { onProgress: extra.onProgress } : {}),
        }),
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
      refreshMergeability: (pr) => closeAndReopenPr(ctx.exec, at(ctx), pr, opts.replan?.sleep ?? ((ms) => Bun.sleep(ms)), opts.replan?.delayMs ?? 2000),
      rebaseStack: async (pr) => {
        const rebased = await rebaseStack(ctx, pr, { knownHeads, ...(opts.replan ? { replan: opts.replan } : {}) });
        for (const n of rebased.prs) {
          if (!stack.prs.some((p) => p.number === n)) throw new StkError(`native stack gained unexpected PR #${n}; review the stack`, "gh-failed");
        }
        expectedHeads = rebased.heads;
        loneRelinked = rebased.prs.length === 1 && rebased.relinked ? rebased.prs[0]! : null;
        return [rebased.relinked, rebased.note].filter(Boolean).join("; ") || undefined;
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
    const expected = stack.prs.filter((p) => !landed.has(p.number));
    // a lone PR left after stk's own re-link is in no stack any more and is planned as a plain PR, on the original trunk
    const lone = expected.length === 1 && loneRelinked === expected[0]!.number && fresh.stack.prs[0]?.baseRef === first.trunk;
    if (fresh.trunk !== first.trunk || (!fresh.stack.native && !lone)) {
      stopped("native stack or trunk changed; review the stack and start a new merge", first.target);
    }
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
  // Only a bypass merge is followed by a local rebase (GitHub restacks after any other merge): check its branches up front.
  const firstBypass = initialMerges.findIndex((s, i) => s.admin && i < initialMerges.length - 1);
  if (stack.native && firstBypass >= 0) {
    const before = new Set(initialMerges.slice(0, firstBypass + 1).flatMap((s) => s.includes ?? [s.pr]));
    const remaining = stack.prs.filter((p) => !before.has(p.number));
    // A rebase can reset checks/reviews and split a formerly atomic clean group into individual bypass merges.
    const bottoms = selected.filter((p) => !before.has(p.number));
    try {
      const root = requireRoot(ctx, "rebase a stack");
      await preflightRestack(ctx.exec, root, restackInput(first.trunk, remaining, stack.prs, knownHeads, provenanceKey(ctx.slug, root)));
    } catch (e) {
      const failed: StepResult = { step: { kind: "rebase-stack", pr: bottoms[0]!.number }, ok: false, detail: e instanceof Error ? e.message : String(e) };
      // the rebase runs after that bypass merge lands, so that is where it sits in the plan
      opts.onPlan?.([...first.plan.slice(0, firstBypass + 1), failed.step, ...first.plan.slice(firstBypass + 1)]);
      results.push(failed);
      opts.onStep?.(failed);
      stopped(failed.detail, bottoms[0]!.number);
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

    // The landed merge changes the next PR's base. After a bypass merge GitHub does nothing (rebased and re-linked below);
    // after any other it retargets and rebases the rest itself: wait for that and for its mergeability, then merge the head it ended on.
    // The heads stk pushed for an earlier bypass merge are history then: GitHub rewrites them, so only "changed from before this merge" counts.
    const bypassed = merges[0]!.admin;
    if (!bypassed) expectedHeads = {};
    const awaited: AwaitedRestack | undefined = bypassed ? undefined : { heads: Object.fromEntries(cur.stack.prs.filter((p) => !landed.has(p.number)).map((p) => [p.number, p.headSha])), method: opts.method };
    let { fresh, stale, staleHead, checking, restacking, waitedMs } = await replanNative(ctx, first.target, opts, landed, opts.replan ?? {}, expectedHeads, awaited);
    validateReplan(fresh, stale);
    if (restacking !== null) {
      stopped(`GitHub has not retargeted and rebased #${restacking} onto ${fresh.trunk} after #${[...landed].at(-1)} landed (waited ${Math.round(waitedMs / 1000)}s); merge again once it has, or run rebase-stack`, restacking);
    }
    if (staleHead !== null) stopped(`GitHub has not reflected the pushed head of #${staleHead} (${expectedHeads[staleHead]}); refusing to merge a stale head`, staleHead);
    const note = bypassed ? fresh.notes.find((x) => x.action === "rebase-stack") : undefined;
    if (note) {
      const rebase: PlanStep = { kind: "rebase-stack", pr: note.pr };
      opts.onPlan?.([...results.map((r) => r.step), rebase, ...fresh.plan]);
      const rebased = await executePlan([rebase], deps);
      results.push(...rebased);
      if (rebased.some((r) => !r.ok)) break;
      ({ fresh, stale, staleHead, checking } = await replanNative(ctx, first.target, opts, landed, opts.replan ?? {}, expectedHeads, undefined, true));
      validateReplan(fresh, stale);
      if (staleHead !== null) stopped(`GitHub has not reflected the pushed head of #${staleHead} (${expectedHeads[staleHead]}); refusing to merge a stale head`, staleHead);
      // a member still shown as conflicting after the re-link would silently cut the plan short: say so instead
      const targetAt = fresh.stack.prs.findIndex((p) => p.number === fresh.target);
      const conflictedIn = (f: PlanForResult) => f.stack.prs.find((p, i) => i <= targetAt && memberBlockers(p, f.trunk, i > 0, f.rules).some((b) => b.kind === "conflict"));
      const conflicted = conflictedIn(fresh);
      if (conflicted) {
        // a head that already contains its base cannot conflict with it: then GitHub's flag is stale and closing and reopening the PR makes it recompute
        let behind: number | string;
        try {
          behind = await behindBy(ctx.exec, at(ctx), conflicted.baseRef, conflicted.headSha);
        } catch (e) {
          behind = e instanceof Error ? e.message : String(e);
        }
        const still = `GitHub still reports #${conflicted.number} as conflicting after the stack was re-linked`;
        if (typeof behind === "string") return stopped(`${still}, and checking whether that is stale failed (${behind}); merge again once it clears`, conflicted.number);
        if (behind > 0) return stopped(`${still}, and its head is ${behind} commit${behind === 1 ? "" : "s"} behind ${conflicted.baseRef}, so the conflict looks real; resolve it and merge again`, conflicted.number);
        // closing a PR GitHub still tracks in a native stack could unlink or disturb the stack: leave it alone and say so
        if (fresh.stack.native) return stopped(`${still}, and its head already contains ${conflicted.baseRef}, so the flag looks stale; it is part of a GitHub stack, so stk will not close and reopen it: close and reopen #${conflicted.number} yourself to make GitHub recompute, then merge again`, conflicted.number);
        const refresh: PlanStep = { kind: "refresh-mergeability", pr: conflicted.number };
        opts.onPlan?.([...results.map((r) => r.step), refresh, ...fresh.plan]);
        const refreshed = await executePlan([refresh], deps);
        results.push(...refreshed);
        if (refreshed.some((r) => !r.ok)) break;
        ({ fresh, stale, staleHead, checking } = await replanNative(ctx, first.target, opts, landed, opts.replan ?? {}, expectedHeads, undefined, true));
        validateReplan(fresh, stale);
        if (staleHead !== null) stopped(`GitHub has not reflected the pushed head of #${staleHead} (${expectedHeads[staleHead]}); refusing to merge a stale head`, staleHead);
        const again = conflictedIn(fresh);
        if (again) stopped(`GitHub still reports #${again.number} as conflicting after the stack was re-linked, even after closing and reopening #${conflicted.number} to make it recompute; merge again once it clears`, again.number);
      }
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
    ...(first.methodNote ? { note: first.methodNote } : {}),
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
  /** Open PRs of the stack (bottom to top) whose branches were rebased onto the trunk. */
  prs: number[];
  /** Every open member's head on origin after the rebase (unchanged for a member that needed nothing). */
  heads: Record<number, string>;
  /** Set when the stack was also re-linked onto the trunk (unstack, retarget, re-create): what was done, in words. */
  relinked?: string;
  /** Local checkouts of rebased branches that now differ from origin (they are never touched), when there are any. */
  note?: string;
}

/** What the restack needs from a stack read: the open members bottom-up, and what the bottom one sits on. */
function restackInput(trunk: string, open: PullRequest[], all: PullRequest[], knownHeads?: Record<string, string[]>, key?: string): RestackInput {
  const bottom = open[0]!;
  // a squash merge leaves the merged PR's commits in the bottom's history: its head SHA is where the bottom's own commits start
  const below = all.find((p) => p.number !== bottom.number && p.headRef === bottom.baseRef);
  return {
    trunk,
    members: open.map((p) => ({ number: p.number, branch: p.headRef, headSha: p.headSha })),
    mergedBaseSha: below?.headSha ?? null,
    baseRef: bottom.baseRef,
    ...(knownHeads ? { knownHeads } : {}),
    ...(key ? { provenanceKey: key } : {}),
  };
}

/**
 * Re-link a native stack whose bottom open PR is still based on a merged branch (a bypass merge leaves GitHub's stack
 * like that: no retarget, no restack). GitHub refuses a base change while a PR is in a stack, so: unstack, point the
 * bottom PR at the trunk, re-create the stack from the open PRs (only when two or more remain; a lone PR is just a PR),
 * then wait while GitHub recomputes every open PR's mergeability. Never deletes the merged branch (that closes the child).
 * `open` is the membership that was rebased: if the stack differs when it is read again right before unstacking (a PR was
 * added or removed meanwhile) nothing is unstacked. Throws when GitHub still reports a PR's mergeability as unknown after
 * the polling ran out, so nothing proceeds as if it had settled. Returns what was done, in words, for the step output.
 */
async function relinkStack(ctx: Ctx, trunk: string, open: PullRequest[], policy: ReplanPolicy): Promise<string> {
  const bottom = open[0]!;
  const stack = (await pullState(ctx.exec, at(ctx), bottom.number)).stack;
  const now = await nativeStackDetail(ctx.exec, at(ctx), bottom.number);
  const nowOpen = now?.members.filter((m) => m.pr.state === "OPEN").map((m) => m.pr.number) ?? [];
  if (nowOpen.length !== open.length || nowOpen.some((n, i) => n !== open[i]!.number)) {
    const list = (ns: number[]) => (ns.length ? ns.map((n) => `#${n}`).join(", ") : "no stack");
    throw new StkError(`the stack changed while it was rebased (rebased ${list(open.map((p) => p.number))}, now ${list(nowOpen)}); nothing was unstacked, review it and run rebase-stack again`, "gh-failed");
  }
  if (stack !== null) await unstackPrStack(ctx.exec, at(ctx), stack);
  try {
    await setPrBase(ctx.exec, at(ctx), bottom.number, trunk);
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new StkError(`the stack was unstacked but #${bottom.number} could not be pointed at ${trunk} (${why}); retarget it, then create the stack again`, "gh-failed");
  }
  let recreated = "";
  if (open.length >= 2) {
    const prs = open.map((p) => p.number);
    try {
      const r = await createPrStack(ctx.exec, at(ctx), prs);
      recreated = ` and re-created the stack (${prs.map((x) => `#${x}`).join(", ")}${r.number ? ` as stack ${r.number}` : ""})`;
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e);
      throw new StkError(`#${bottom.number} now targets ${trunk} but the stack could not be re-created (${why})`, "gh-failed");
    }
  }
  // right after a base change or a re-created stack GitHub reports mergeability as unknown for a few seconds: let it settle for every PR, bottom first
  const sleep = policy.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const delay = policy.delayMs ?? 2000;
  const attempts = policy.attempts ?? 6;
  for (const p of open) {
    let state = (await pullState(ctx.exec, at(ctx), p.number)).mergeableState;
    for (let i = 0; state === "unknown" && i < attempts; i++) {
      await sleep(delay);
      state = (await pullState(ctx.exec, at(ctx), p.number)).mergeableState;
    }
    if (state === "unknown") {
      throw new StkError(`the stack was re-linked onto ${trunk}, but GitHub is still computing whether #${p.number} can merge (gave up after ${Math.round((attempts * delay) / 1000)}s); wait a moment, then merge again`, "gh-failed");
    }
  }
  return `unstacked, pointed #${bottom.number} at ${trunk}${recreated}`;
}

/**
 * Whether the bottom open PR was already rebased onto its merged parent's merge commit (a run that rewrote the branches but
 * failed while re-linking): its head then contains that commit. False when the parent's merge commit is unknown or an
 * object is missing locally, and for a bottom that does not contain it (not rebased, or its parent was amended).
 */
async function bottomRestacked(ctx: Ctx, root: string, parent: PullRequest, bottom: PullRequest): Promise<boolean> {
  const merge = (await pullState(ctx.exec, at(ctx), parent.number)).mergeCommit;
  if (!merge) return false;
  await git(ctx.exec, root, ["fetch", "--no-tags", "origin", merge, bottom.headSha]);
  for (const sha of [merge, bottom.headSha]) {
    if ((await git(ctx.exec, root, ["cat-file", "-e", `${sha}^{commit}`])).code !== 0) return false;
  }
  return (await git(ctx.exec, root, ["merge-base", "--is-ancestor", merge, bottom.headSha])).code === 0;
}

/**
 * Rebase a native stack the way GitHub's "Rebase stack" button does. GitHub exposes no API for it (the REST stacks
 * endpoints only list/create/extend/dissolve), so every open member is rebased bottom-up onto the trunk in a throwaway
 * detached checkout (see `restack.ts`) and pushed with leases; nothing in the user's worktrees is touched. A conflict
 * aborts with nothing pushed; unpushed local commits on a member branch are refused up front. When the bottom PR is still
 * based on a merged branch (what a bypass merge leaves), the stack is also re-linked onto the trunk (`relinkStack`);
 * that is what makes it mergeable again. A run that rewrote the branches but failed while re-linking is resumable: when
 * the bottom PR already contains its merged parent's merge commit it is already rebased, so only the re-link is repeated.
 */
export async function rebaseStack(ctx: Ctx, n: number, opts: { onStep?: (what: string) => void; knownHeads?: Record<string, string[]>; replan?: ReplanPolicy } = {}): Promise<RebaseStackResult> {
  const root = requireRoot(ctx, "rebase a stack");
  const detail = await nativeStackDetail(ctx.exec, at(ctx), n);
  const pr = detail?.members.find((m) => m.pr.number === n)?.pr;
  if (!detail || !pr || pr.state !== "OPEN") throw new StkError(`PR #${n} is not an open member of a GitHub stack`, "usage");
  const open = detail.members.filter((m) => m.pr.state === "OPEN").map((m) => m.pr);
  const mergedParent = detail.members.find((m) => m.pr.state === "MERGED" && m.pr.headRef === open[0]!.baseRef)?.pr;
  const resumed = !!mergedParent && (await bottomRestacked(ctx, root, mergedParent, open[0]!));
  if (resumed) opts.onStep?.(`#${open[0]!.number} is already rebased onto the merge of #${mergedParent!.number}; only re-linking`);
  const r = resumed
    ? { heads: Object.fromEntries(open.map((p) => [p.number, p.headSha])) as Record<number, string>, pushed: [] as number[], behind: [] }
    : await restackAndPush(ctx.exec, root, restackInput(detail.trunk, open, detail.members.map((m) => m.pr), opts.knownHeads, provenanceKey(ctx.slug, root)), opts.onStep);
  // a run of several restacks leaves local branches at their old tips on purpose: remember those heads so the next one does not take them for unpushed work
  if (opts.knownHeads) {
    for (const p of open) {
      if (r.heads[p.number] === p.headSha) continue;
      const known = opts.knownHeads;
      if (Object.hasOwn(known, p.headRef)) known[p.headRef]!.push(p.headSha);
      else Object.defineProperty(known, p.headRef, { value: [p.headSha], enumerable: true, writable: true, configurable: true });
    }
  }
  const relinked = mergedParent ? await relinkStack(ctx, detail.trunk, open, opts.replan ?? {}) : undefined;
  if (relinked) opts.onStep?.(relinked);
  const note = behindText(r.behind);
  return { prs: open.map((p) => p.number), heads: r.heads, ...(relinked ? { relinked } : {}), ...(note ? { note } : {}) };
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
