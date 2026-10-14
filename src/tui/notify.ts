/**
 * PR change notifications for the running TUI. The store feeds every board / session / detail refresh in here; the
 * watcher keeps the last snapshot per PR, diffs against it (`diffPr`) and announces what changed. No requests of
 * its own. The first sighting of a PR is silent; only PRs on the user's own / review board or the session, plus the
 * PR page being viewed, are announced.
 */
import { exec as realExec } from "../exec";
import { listJobs } from "../jobs";
import type { NotifyMode } from "../prefs";
import type { BoardPr, PrDetail } from "../service";
import type { Exec, RepoSlug } from "../types";
import { claimEvent, diffPr, eventLine, mergeSnap, pruneNotified, snapFromPr, systemNotify, type PrSnap, type WatchEvent } from "../watch";

export interface WatcherHost {
  toast(text: string, kind: "info" | "success" | "error"): void;
  /** Is the terminal focused right now? */
  focused(): boolean;
  /** Effective mode for the current focus state (`notifyMode(prefs, { focused })`). */
  mode(focused: boolean): NotifyMode;
  /** The PR page on screen, if any. */
  screenPr(): { repo: RepoSlug; n: number } | null;
}

export interface WatcherDeps {
  now: () => number;
  claim: (repo: RepoSlug, n: number, key: string) => boolean;
  /** Post a macOS notification. */
  system: (text: string) => Promise<void>;
  /** Did a stk job (this pane's or another's) merge or start merging this PR? Then "merged" is not news. */
  jobMerged: (repo: RepoSlug, n: number) => boolean;
}

/** A PR page's own refreshes only count when the previous sighting is this recent (older: the user has been away from it). */
const SCREEN_FRESH_MS = 5 * 60_000;
/** After the user acted on a PR (stk), its merge / close is their own doing. */
const SELF_MS = 2 * 60_000;
/** Most vanished PRs looked up per refresh (one request each). */
const GONE_LOOKUPS = 5;

const keyOf = (r: RepoSlug, n: number) => `${r.owner}/${r.name}#${n}`.toLowerCase();

export class PrWatcher {
  private snaps = new Map<string, { snap: PrSnap; at: number }>();
  /** PRs on a watched board: announced on every refresh. */
  private watched = new Set<string>();
  /** Open PRs of the user's own board, by repo: a PR missing from the next answer left the board (merged or closed). */
  private mine = new Map<string, Set<number>>();
  private selfActed = new Map<string, number>();
  private pruned = false;
  private readonly deps: WatcherDeps;

  constructor(private readonly host: WatcherHost, deps: Partial<WatcherDeps> = {}) {
    this.deps = {
      now: Date.now,
      claim: claimEvent,
      system: (text) => systemNotify(text, realExec as Exec),
      jobMerged: (repo, n) => listJobs({ repo, pr: n }).some((j) => j.status !== "failed"),
      ...deps,
    };
  }

  /** The user acted on this PR through stk (review, close, merge...): its merge / close needs no announcement. */
  markSelf(repo: RepoSlug, n: number): void {
    this.selfActed.set(keyOf(repo, n), this.deps.now());
  }

  /**
   * Feed the rows of a board refresh (`mine` / `review` boards or the session's PRs). `ownRepos`: for the user's own
   * board, the repos this answer covers; open PRs of them that are no longer listed are returned (the store looks
   * them up once so the merge / close is announced from their detail).
   */
  observeRows(rows: readonly (BoardPr & { repo?: RepoSlug })[], fallback: RepoSlug | null, ownRepos?: readonly RepoSlug[]): { repo: RepoSlug; n: number }[] {
    const now = this.deps.now();
    const open = new Map<string, Set<number>>();
    for (const row of rows) {
      const repo = row.repo ?? fallback;
      if (!repo) continue;
      const key = keyOf(repo, row.number);
      const known = this.watched.has(key);
      this.watched.add(key);
      const prev = this.snaps.get(key);
      const next = mergeSnap(prev?.snap, snapFromPr(row, row.blockers ?? []));
      this.snaps.set(key, { snap: next, at: now });
      if (known && prev) this.announce(repo, row.number, diffPr(prev.snap, next));
      if (row.state === "OPEN") {
        const rk = `${repo.owner}/${repo.name}`;
        open.set(rk, (open.get(rk) ?? new Set<number>()).add(row.number));
      }
    }
    const gone: { repo: RepoSlug; n: number }[] = [];
    for (const repo of ownRepos ?? []) {
      const rk = `${repo.owner}/${repo.name}`;
      const listed = open.get(rk) ?? new Set<number>();
      for (const n of this.mine.get(rk) ?? []) if (!listed.has(n)) gone.push({ repo, n });
      this.mine.set(rk, listed);
    }
    return gone.slice(0, GONE_LOOKUPS);
  }

  /** Feed a loaded PR detail (the only source of review authors). */
  observeDetail(repo: RepoSlug, n: number, d: Pick<PrDetail, "pr" | "blockers" | "conversation">): void {
    const key = keyOf(repo, n);
    const now = this.deps.now();
    const prev = this.snaps.get(key);
    const next = mergeSnap(prev?.snap, snapFromPr(d.pr, d.blockers ?? [], d.conversation));
    this.snaps.set(key, { snap: next, at: now });
    if (!prev) return;
    const screen = this.host.screenPr();
    const viewing = !!screen && keyOf(screen.repo, screen.n) === key && now - prev.at < SCREEN_FRESH_MS;
    if (this.watched.has(key) || viewing) this.announce(repo, n, diffPr(prev.snap, next));
  }

  private announce(repo: RepoSlug, n: number, events: WatchEvent[]): void {
    for (const e of events) {
      if ((e.kind === "merged" || e.kind === "closed") && this.selfCaused(repo, n)) continue;
      const focused = this.host.focused();
      const mode = this.host.mode(focused);
      if (mode === "off") continue;
      if (!this.deps.claim(repo, n, e.key)) continue;
      if (!this.pruned) {
        this.pruned = true;
        pruneNotified(this.deps.now());
      }
      const line = eventLine(repo, n, e);
      if (mode === "system" && !focused) void this.deps.system(line);
      else this.host.toast(line, e.tone);
    }
  }

  private selfCaused(repo: RepoSlug, n: number): boolean {
    const at = this.selfActed.get(keyOf(repo, n));
    return (at !== undefined && this.deps.now() - at < SELF_MS) || this.deps.jobMerged(repo, n);
  }
}
