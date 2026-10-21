// Shared contract between the git layer, the GitHub layer, the stack engine,
// the CLI and the Tern plugin. The CLI's `--json` output is these shapes.

/** Runs a program and returns its result. Never throws on nonzero exit. */
export type Exec = (
  argv: readonly string[],
  opts?: { cwd?: string; stdin?: string; env?: Record<string, string> },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export interface Worktree {
  path: string;
  /** Short branch name (no refs/heads/), null when detached. */
  branch: string | null;
  head: string;
  bare: boolean;
}

export type CheckState = "pass" | "fail" | "pending" | "skipped";

export interface Check {
  name: string;
  state: CheckState;
  url: string | null;
}

/** A PR commit and the check results attached to that SHA (not current merge readiness). */
export interface PrCommit {
  sha: string;
  /** Commit subject. */
  message: string;
  author: string;
  committedAt: string;
  url: string;
  checks: Check[];
}

export type ReviewDecision = "APPROVED" | "CHANGES_REQUESTED" | "REVIEW_REQUIRED" | null;

export type Mergeable = "MERGEABLE" | "CONFLICTING" | "UNKNOWN";

/** GitHub's `mergeStateStatus`. BEHIND only appears when branch protection requires an up-to-date branch. */
export type MergeState = "BEHIND" | "BLOCKED" | "CLEAN" | "DIRTY" | "DRAFT" | "HAS_HOOKS" | "UNKNOWN" | "UNSTABLE";

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  /** Short branch names. */
  headRef: string;
  baseRef: string;
  /** ISO timestamps from GitHub. */
  createdAt: string;
  updatedAt: string;
  headSha: string;
  mergeable: Mergeable;
  /** GitHub's mergeStateStatus; absent on hand-built PRs. */
  mergeState?: MergeState;
  /** Commits the base has that the head lacks. Only the opened PR's detail loads it (one REST compare call). */
  behindBy?: number;
  reviewDecision: ReviewDecision;
  checks: Check[];
  unresolvedThreads: number;
  /** Markdown description; empty when none. Only loaded by `viewPr`. */
  body: string;
  /** Local worktree checked out on headRef, if any. Filled by the CLI. */
  worktree: string | null;
}

/** A linear chain, bottom (targets the trunk) first. */
export interface Stack {
  trunk: string;
  prs: PullRequest[];
  /** True when GitHub itself tracks these PRs as a native stacked-PR stack (merged via merge-async). */
  native?: boolean;
}

/** What blocks a normal merge; the force merge bypasses only these. */
export type Blocker =
  | { kind: "checks"; failing: string[]; pending: string[] }
  | { kind: "review"; decision: ReviewDecision }
  | { kind: "threads"; count: number }
  | { kind: "draft" }
  | { kind: "conflict"; base?: string }
  | { kind: "behind"; count: number | null; base: string }
  | { kind: "checking" }
  /** A branch-rule required status check that never reported on the head. */
  | { kind: "required-check"; context: string }
  /** GitHub says BLOCKED and nothing more specific explains it (repository rules; admins may bypass). */
  | { kind: "blocked"; codeOwner?: boolean }
  | { kind: "base-not-trunk"; base: string; /** The PR whose head branch is `base`, when known (filled by prDetail). */ owner?: { number: number; state: PullRequest["state"] } };

/** What a base branch's rules (REST `rules/branches/{branch}`) demand beyond a plain merge. */
export interface RepoRules {
  /** Required status check contexts. */
  requiredChecks: string[];
  /** The pull_request rule requires code owner review. */
  codeOwnerReview: boolean;
  /** Merge methods the pull_request rule(s) allow (their `allowed_merge_methods`, intersected); absent when no rule restricts them. */
  allowedMergeMethods?: MergeMethod[];
}

export type MergeMethod = "squash" | "merge" | "rebase";

/** One step of a stack merge plan, in execution order. */
export type PlanStep =
  | {
      kind: "merge";
      pr: number;
      method: MergeMethod;
      admin: boolean;
      bypass: Blocker[];
      /** Head SHA GitHub must still see (merge-async `sha`); omitted when an earlier step will move the head. */
      sha?: string;
      /** Native stack: every PR the one merge-async call lands (downstack first, `pr` last). */
      includes?: number[];
    }
  | { kind: "retarget"; pr: number; from: string; to: string }
  | {
      kind: "restack";
      pr: number;
      branch: string;
      /** Rebase `branch` onto `onto`, dropping commits up to and including `upstream`. */
      onto: string;
      upstream: string;
      /** Remote tip recorded before rebasing; the push is leased against it. */
      expectedRemoteSha: string;
      worktree: string | null;
    }
  | { kind: "push"; branch: string; expectedRemoteSha: string; cwd: string }
  | { kind: "wait-checks"; pr: number }
  /** Native stack: rebase the open PRs onto the trunk in a temporary checkout after a lower PR landed; `pr` is the bottom open PR. */
  | { kind: "rebase-stack"; pr: number }
  /** A member still shows as conflicting although its head already contains its base (a stale GitHub flag): close and reopen it so GitHub recomputes. */
  | { kind: "refresh-mergeability"; pr: number };

export interface StepResult {
  step: PlanStep;
  ok: boolean;
  detail: string;
  /** New SHA after a restack or push. */
  sha?: string;
  /** The merge was only added to a merge queue; nothing has landed yet. */
  enqueued?: boolean;
}

/** Progress of one asynchronous merge request. */
export interface MergeProgress {
  pr: number;
  phase: "requested" | "pending" | "merged" | "enqueued" | "failed";
  uuid?: string;
  message?: string;
}

/**
 * What a finished merge job did. `merged`: the selected PR (and, for a stack, everything below it) landed.
 * `enqueued`: it only went into a merge queue. `partial`: some stack PRs below it landed, the selected one is
 * still open. `none`: nothing landed (the plan was empty: the bottom PR is blocked).
 */
export type MergeOutcome = "merged" | "enqueued" | "partial" | "none";

/** Short toast/summary line for a finished merge job: `Stack merged · #10, #11`, `Merged #12`, `Queued · #12 (not merged yet)`, `Merged #10 · #12 still open`, `Nothing merged · #10 is blocked`. */
export function mergeOutcomeText(job: { kind: "merge" | "stack-merge" | "rebase-stack" | "merge-when-ready"; stack?: boolean; pr: number; outcome?: MergeOutcome; merged?: number[]; prs?: number[]; note?: string }): string {
  if (job.kind === "rebase-stack") return `Stack rebased · ${(job.prs ?? [job.pr]).map((n) => `#${n}`).join(", ")}${job.note ? ` · ${job.note}` : ""}`;
  const merged = (job.merged ?? []).map((n) => `#${n}`).join(", ");
  const withNote = (text: string) => (job.note ? `${text} · ${job.note}` : text);
  switch (job.outcome) {
    case "enqueued":
      return withNote(`Queued · #${job.pr} (not merged yet)${merged ? `; merged ${merged}` : ""}`);
    case "partial":
      return withNote(`Merged ${merged} · #${job.pr} still open`);
    case "none":
      return withNote(`Nothing merged · #${job.prs?.[0] ?? job.pr} is blocked`);
    default:
      return withNote((job.kind === "stack-merge" || job.stack) && (job.merged?.length ?? 0) > 1 ? `Stack merged · ${merged}` : `Merged ${merged || `#${job.pr}`}`);
  }
}

/** Toast text for a failed job; strips the prefixes the error already carries so nothing reads "merge failed: merge of #7 failed: …". */
export function jobFailureText(job: { kind: "merge" | "stack-merge" | "rebase-stack" | "merge-when-ready"; stack?: boolean; pr: number; error?: string }): string {
  const err = job.error ?? "unknown error";
  if (job.kind === "rebase-stack") return `Rebase of stack #${job.pr} failed: ${err}`;
  if (job.kind === "merge-when-ready") {
    if (err === "cancelled") return "Merge when ready cancelled";
    if (err.startsWith("stack merge stopped")) return `Stack #${job.pr} ${err.slice("stack merge ".length)}`;
    return /^merge of #\d+ failed/.test(err) ? err : `Merge when ready stopped: ${err}`;
  }
  if (job.kind === "stack-merge") return err.startsWith("stack merge stopped") ? `Stack #${job.pr} ${err.slice("stack merge ".length)}` : `Stack #${job.pr} merge failed: ${err}`;
  return /^merge of #\d+ failed/.test(err) ? err : `#${job.pr} merge failed: ${err}`;
}

/** Partial or empty results are not successes; the UI shows them as warnings. */
export const mergeOutcomeOk = (outcome: MergeOutcome | undefined): boolean => outcome !== "partial" && outcome !== "none";

/** Toasts name where they happened: `widgets #2391 · Review sent`, or `widgets · Stack merged · #2391, #2389` when the text already names the PR. */
export function inContext(repo: { name: string }, n: number | undefined, text: string): string {
  return n === undefined || text.includes(`#${n}`) ? `${repo.name} · ${text}` : `${repo.name} #${n} · ${text}`;
}

export class StkError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not-a-repo"
      | "gh-failed"
      | "git-failed"
      | "dirty-worktree"
      | "diverged"
      | "lease-rejected"
      | "rebase-conflict"
      | "not-linear"
      | "blocked"
      | "step-failed"
      | "merge-timeout"
      | "rate-limited"
      | "usage",
    /** Machine-readable detail that rides along in the CLI JSON envelope. */
    readonly data?: unknown,
  ) {
    super(message);
  }
}

export interface RepoSlug {
  owner: string;
  name: string;
}

/** A PR mentioned in an agent session, in order of first mention. */
export interface SessionPrRef extends RepoSlug {
  number: number;
  /** Position of the first mention (line index in the session source). */
  firstSeen: number;
}

/** A PR-level comment or a review with a non-empty body, shown on the PR page timeline. */
export interface ConversationEntry {
  kind: "comment" | "review";
  id: string;
  author: string;
  isBot: boolean;
  /** Review state (APPROVED, CHANGES_REQUESTED, COMMENTED, ...). Reviews only. */
  state?: string;
  body: string;
  createdAt: string;
  url: string;
  minimized: boolean;
  minimizedReason?: string;
  /** Review threads opened by this review: open = unresolved and current, outdated = unresolved but outdated. Reviews only. */
  findings?: { total: number; open: number; resolved: number; outdated: number; threadIds: string[] };
}

/**
 * For a native-stack member above the bottom open PR: how many open PRs a merge up to `n` lands (itself and everything
 * below). Null otherwise; such a PR cannot merge alone (GitHub lands the downstack with it), so its merge IS a stack merge.
 * Counts only the line through `n` (`prs`): `entries` may also list display-only PRs of a forked tree (a classic sibling branch).
 */
export function nativeUpTo(stack: { native: boolean; prs: number[]; entries: { number: number; state: string }[] } | null | undefined, n: number): number | null {
  if (!stack?.native) return null;
  const open = stack.entries.filter((e) => e.state === "OPEN" && stack.prs.includes(e.number));
  const i = open.findIndex((e) => e.number === n);
  return i > 0 ? i + 1 : null;
}
