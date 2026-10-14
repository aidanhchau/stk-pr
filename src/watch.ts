/**
 * PR state watching. Two halves:
 *  - Notifications: a pure diff of two snapshots of a PR (`diffPr`) into events ("checks passed", "approved by @x"...),
 *    plus the side effects around them (cross-pane claim files, the macOS notification).
 *  - Merge-when-ready: `waitVerdict` judges a PR's / stack plan's blockers as ready, worth waiting for, or a hard stop.
 * The diff and the verdict are pure; only `claimEvent`, `pruneNotified` and `systemNotify` touch the machine.
 */
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Blocker, Check, ConversationEntry, Exec, PullRequest, RepoSlug, ReviewDecision } from "./types";
import { inContext } from "./types";

// ---------- snapshots ----------

export type ChecksSummary = "pass" | "fail" | "pending" | "none";

/** The one verdict of a PR's checks: any failure fails, else any pending is pending; skipped checks do not count. */
export function checksSummary(checks: readonly Pick<Check, "state">[]): ChecksSummary {
  const cs = checks.filter((c) => c.state !== "skipped");
  if (cs.length === 0) return "none";
  if (cs.some((c) => c.state === "fail")) return "fail";
  return cs.some((c) => c.state === "pending") ? "pending" : "pass";
}

export interface ReviewSnap {
  id: string;
  author: string;
  state: string;
}

/** What `diffPr` compares. `reviews` is undefined until a PR detail (the only source of review authors) was seen. */
export interface PrSnap {
  state: PullRequest["state"];
  isDraft: boolean;
  author: string;
  headSha: string;
  /** GitHub's last-activity stamp: makes event keys unique per occurrence. */
  updatedAt: string;
  checks: ChecksSummary;
  failing: string[];
  decision: ReviewDecision;
  /** Open, not a draft and nothing blocks the merge. */
  ready: boolean;
  threads: number;
  reviews?: ReviewSnap[];
}

/** Snapshot of a PR as the board row or the detail carries it. Tolerates partial objects. */
export function snapFromPr(pr: PullRequest, blockers: readonly Blocker[], conversation?: readonly ConversationEntry[]): PrSnap {
  const checks = pr.checks ?? [];
  const snap: PrSnap = {
    state: pr.state,
    isDraft: !!pr.isDraft,
    author: pr.author ?? "",
    headSha: pr.headSha ?? "",
    updatedAt: pr.updatedAt ?? "",
    checks: checksSummary(checks),
    failing: checks.filter((c) => c.state === "fail").map((c) => c.name),
    decision: pr.reviewDecision ?? null,
    ready: pr.state === "OPEN" && !pr.isDraft && blockers.length === 0,
    threads: pr.unresolvedThreads ?? 0,
  };
  if (conversation) {
    snap.reviews = conversation.filter((e) => e.kind === "review" && !e.isBot).map((e) => ({ id: e.id, author: e.author, state: e.state ?? "COMMENTED" }));
  }
  return snap;
}

/** The newer snapshot, keeping the older one's review list when the newer comes from a source that has none (a board row). */
export function mergeSnap(prev: PrSnap | undefined, next: PrSnap): PrSnap {
  return next.reviews === undefined && prev?.reviews ? { ...next, reviews: prev.reviews } : next;
}

// ---------- diff ----------

export type WatchEventKind = "checks-passed" | "checks-failed" | "approved" | "changes-requested" | "commented" | "ready" | "merged" | "closed" | "threads";

export interface WatchEvent {
  kind: WatchEventKind;
  /** Toast body without the repo/PR prefix: `checks passed`, `approved by @ana`. */
  text: string;
  /** Identifies this occurrence across panes (and refreshes): the same event always has the same key. */
  key: string;
  tone: "success" | "error" | "info";
}

const who = (login: string) => (login ? `@${login}` : "someone");

/**
 * What changed for one PR between two snapshots. Nothing for a PR that was not open before. A PR that ended yields
 * only that. Checks finishing together with the PR becoming mergeable is one event.
 */
export function diffPr(prev: PrSnap, next: PrSnap): WatchEvent[] {
  if (prev.state !== "OPEN") return [];
  if (next.state !== "OPEN") {
    return [{ kind: next.state === "MERGED" ? "merged" : "closed", text: next.state === "MERGED" ? "merged" : "closed", key: `state:${next.state}`, tone: next.state === "MERGED" ? "info" : "error" }];
  }
  const out: WatchEvent[] = [];

  const sameHead = prev.headSha === next.headSha;
  const finished = prev.checks === "pending" && (next.checks === "pass" || next.checks === "fail");
  const lateFail = prev.checks === "pass" && next.checks === "fail";
  if (sameHead && (finished || lateFail)) {
    if (next.checks === "pass") out.push({ kind: "checks-passed", text: "checks passed", key: `checks:pass:${next.headSha}`, tone: "success" });
    else {
      const names = next.failing.slice(0, 2).join(", ");
      const more = next.failing.length > 2 ? ` +${next.failing.length - 2}` : "";
      out.push({ kind: "checks-failed", text: names ? `checks failed · ${names}${more}` : "checks failed", key: `checks:fail:${next.headSha}`, tone: "error" });
    }
  }

  if (prev.reviews && next.reviews) {
    const seen = new Set(prev.reviews.map((r) => r.id));
    for (const r of next.reviews) {
      if (seen.has(r.id) || r.author === next.author) continue;
      if (r.state === "APPROVED") out.push({ kind: "approved", text: `approved by ${who(r.author)}`, key: `review:${r.id}`, tone: "success" });
      else if (r.state === "CHANGES_REQUESTED") out.push({ kind: "changes-requested", text: `changes requested by ${who(r.author)}`, key: `review:${r.id}`, tone: "error" });
      else if (r.state === "COMMENTED") out.push({ kind: "commented", text: `${who(r.author)} commented`, key: `review:${r.id}`, tone: "info" });
    }
  } else if (prev.decision !== next.decision) {
    // no author without a detail: the board row only knows the overall decision
    if (next.decision === "APPROVED") out.push({ kind: "approved", text: "approved", key: `decision:APPROVED:${next.updatedAt}`, tone: "success" });
    else if (next.decision === "CHANGES_REQUESTED") out.push({ kind: "changes-requested", text: "changes requested", key: `decision:CHANGES_REQUESTED:${next.updatedAt}`, tone: "error" });
  }

  if (!prev.ready && next.ready) {
    const passed = out.find((e) => e.kind === "checks-passed");
    if (passed) passed.text = "checks passed · ready to merge";
    else out.push({ kind: "ready", text: "ready to merge", key: `ready:${next.headSha}:${next.updatedAt}`, tone: "success" });
  }

  if (next.threads > prev.threads) {
    const d = next.threads - prev.threads;
    out.push({ kind: "threads", text: d === 1 ? "new unresolved thread" : `${d} new unresolved threads`, key: `threads:${next.threads}:${next.updatedAt}`, tone: "info" });
  }
  return out;
}

/** Toast / notification line for an event: `widgets #2391 · checks passed`. */
export const eventLine = (repo: { name: string }, n: number, e: Pick<WatchEvent, "text">): string => inContext(repo, n, e.text);

// ---------- cross-pane dedupe ----------

export const notifiedDir = (): string => process.env.STK_NOTIFIED_DIR || join(homedir(), ".cache", "stk", "notified");

/** Marker files older than this are deleted. */
const NOTIFIED_KEEP_MS = 24 * 60 * 60_000;

/**
 * Announce a PR event once across every stk pane: the first caller creates `<hash>` (O_EXCL, atomic) and gets true;
 * everyone else gets false and stays quiet. An unwritable cache dir answers true (better a duplicate than silence).
 */
export function claimEvent(repo: RepoSlug, n: number, key: string): boolean {
  const hash = createHash("sha1").update(`${repo.owner}/${repo.name}#${n}:${key}`.toLowerCase()).digest("hex").slice(0, 24);
  try {
    mkdirSync(notifiedDir(), { recursive: true });
  } catch {
    return true;
  }
  try {
    const fd = openSync(join(notifiedDir(), hash), "wx");
    try {
      writeSync(fd, String(Date.now()));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "EEXIST";
  }
}

/** Delete claim files older than a day. Best effort. */
export function pruneNotified(now = Date.now()): void {
  let names: string[];
  try {
    names = readdirSync(notifiedDir());
  } catch {
    return;
  }
  for (const name of names) {
    const file = join(notifiedDir(), name);
    try {
      if (now - statSync(file).mtimeMs > NOTIFIED_KEEP_MS) unlinkSync(file);
    } catch {
      /* gone already */
    }
  }
}

// ---------- system notification ----------

/** AppleScript string literal. */
const asLiteral = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n]+/g, " ")}"`;

/** macOS notification via osascript (title "stk"). A no-op elsewhere; failures are swallowed. */
export async function systemNotify(text: string, run: Exec, platform: string = process.platform): Promise<void> {
  if (platform !== "darwin") return;
  try {
    await run(["osascript", "-e", `display notification ${asLiteral(text)} with title "stk"`]);
  } catch {
    /* a notification is never worth an error */
  }
}

// ---------- merge when ready ----------

/** How long a merge-when-ready job waits before giving up. */
export const WHEN_READY_MAX_MS = 24 * 60 * 60_000;
/** Poll period of a merge-when-ready job. */
export const WHEN_READY_POLL_MS = 60_000;

export type WaitVerdict = { verdict: "ready" } | { verdict: "wait"; reason: string } | { verdict: "hard"; reason: string };

/** One blocker as a waiting reason (`checks pending`) or, when hard, the failure it causes. */
function judge(b: Blocker, n: number): { hard: boolean; reason: string } {
  switch (b.kind) {
    case "checks":
      return b.failing.length
        ? { hard: true, reason: `checks failed on #${n}: ${b.failing.slice(0, 3).join(", ")}${b.failing.length > 3 ? ` +${b.failing.length - 3}` : ""}` }
        : { hard: false, reason: "checks pending" };
    case "review":
      return b.decision === "CHANGES_REQUESTED" ? { hard: true, reason: `changes requested on #${n}` } : { hard: false, reason: "needs review" };
    case "threads":
      return { hard: false, reason: `${b.count} open thread${b.count === 1 ? "" : "s"}` };
    case "draft":
      return { hard: true, reason: `#${n} is a draft` };
    case "conflict":
      return { hard: true, reason: `#${n} conflicts with ${b.base ?? "its base"}` };
    case "behind":
      return { hard: true, reason: `#${n} is behind ${b.base}: update the branch` };
    case "checking":
      return { hard: false, reason: "checking for conflicts" };
    case "required-check":
      return { hard: false, reason: `required check '${b.context}' hasn't run` };
    case "blocked":
      return { hard: false, reason: b.codeOwner ? "waiting for code owner review" : "blocked by repository rules" };
    case "base-not-trunk":
      return { hard: true, reason: `#${n} is based on ${b.base}, not the trunk: merge the stack` };
  }
}

/** Ready when nothing blocks; a hard stop (conflict, draft, changes requested, failing checks, behind) over waiting. */
export function waitVerdict(bs: readonly Blocker[], n: number): WaitVerdict {
  if (bs.length === 0) return { verdict: "ready" };
  const judged = bs.map((b) => judge(b, n));
  const hard = judged.find((j) => j.hard);
  if (hard) return { verdict: "hard", reason: hard.reason };
  return { verdict: "wait", reason: [...new Set(judged.map((j) => j.reason))].join(", ") };
}

/** True when waiting could clear every blocker (what the `merge when ready` entry points require). */
export const isWaitable = (bs: readonly Blocker[]): boolean => bs.length > 0 && !bs.some((b) => judge(b, 0).hard);
