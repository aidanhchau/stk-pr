import { describe, expect, test } from "bun:test";
import { PrWatcher, type WatcherDeps, type WatcherHost } from "../src/tui/notify";
import type { BoardPr } from "../src/service";
import type { ConversationEntry, PullRequest } from "../src/types";
import type { NotifyMode } from "../src/prefs";

const repo = { owner: "acme", name: "widgets" };

const row = (n: number, o: Partial<PullRequest> = {}): BoardPr => ({
  number: n, title: `PR ${n}`, url: "u", author: "me", state: "OPEN", isDraft: false, headRef: `b${n}`, baseRef: "main", createdAt: "", updatedAt: "t1", headSha: "s1",
  mergeable: "MERGEABLE", reviewDecision: null, checks: [{ name: "build", state: "pending", url: null }], unresolvedThreads: 0, body: "", worktree: null, blockers: [{ kind: "checks", failing: [], pending: ["build"] }], ...o,
});
const passed = { checks: [{ name: "build", state: "pass" as const, url: null }], blockers: [] };

function harness(o: { mode?: NotifyMode; focused?: boolean; claimed?: Set<string>; jobMerged?: boolean } = {}) {
  const toasts: string[] = [];
  const systems: string[] = [];
  const host = { focused: o.focused ?? true, mode: o.mode ?? ("toast" as NotifyMode), screen: null as { repo: typeof repo; n: number } | null };
  const claimed = o.claimed ?? new Set<string>();
  let t = 0;
  const hostApi: WatcherHost = {
    toast: (text, kind) => toasts.push(`${kind}:${text}`),
    focused: () => host.focused,
    mode: () => host.mode,
    screenPr: () => host.screen,
  };
  const deps: Partial<WatcherDeps> = {
    now: () => t,
    claim: (r, n, key) => {
      const k = `${r.owner}/${r.name}#${n}:${key}`;
      if (claimed.has(k)) return false;
      claimed.add(k);
      return true;
    },
    system: async (text) => void systems.push(text),
    jobMerged: () => o.jobMerged ?? false,
  };
  const w = new PrWatcher(hostApi, deps);
  return { w, toasts, systems, host, advance: (ms: number) => void (t += ms), claimed };
}

describe("PrWatcher", () => {
  test("the first sighting is silent; the next refresh announces what changed", () => {
    const h = harness();
    h.w.observeRows([row(2391)], repo);
    expect(h.toasts).toEqual([]);
    h.w.observeRows([row(2391, passed)], repo);
    expect(h.toasts).toEqual(["success:widgets #2391 · checks passed · ready to merge"]);
    h.w.observeRows([row(2391, passed)], repo);
    expect(h.toasts.length).toBe(1);
  });

  test("session rows carry their own repo", () => {
    const h = harness();
    const other = { owner: "acme", name: "core" };
    h.w.observeRows([{ ...row(7), repo: other }] as never, null);
    h.w.observeRows([{ ...row(7, { unresolvedThreads: 1 }), repo: other }] as never, null);
    expect(h.toasts).toEqual(["info:core #7 · new unresolved thread"]);
  });

  test("a detail refresh reports new reviews with their author", () => {
    const h = harness();
    const review = (id: string, author: string, state: string) => ({ kind: "review", id, author, state, isBot: false, body: "", createdAt: "", url: "", minimized: false }) as ConversationEntry;
    h.w.observeRows([row(5)], repo);
    const blockers = row(5).blockers;
    h.w.observeDetail(repo, 5, { pr: row(5), blockers, conversation: [] });
    h.w.observeDetail(repo, 5, { pr: row(5, { reviewDecision: "APPROVED" }), blockers, conversation: [review("r1", "ana", "APPROVED")] });
    expect(h.toasts).toEqual(["success:widgets #5 · approved by @ana"]);
  });

  test("PRs the user is not watching stay quiet, unless their page is open and was seen moments ago", () => {
    const h = harness();
    h.w.observeDetail(repo, 9, { pr: row(9), blockers: [], conversation: [] });
    h.w.observeDetail(repo, 9, { pr: row(9, passed), blockers: [], conversation: [] });
    expect(h.toasts).toEqual([]);
    h.host.screen = { repo, n: 9 };
    h.w.observeDetail(repo, 9, { pr: row(9, { unresolvedThreads: 2 }), blockers: [], conversation: [] });
    expect(h.toasts).toEqual(["info:widgets #9 · 2 new unresolved threads"]);
    h.advance(10 * 60_000);
    h.w.observeDetail(repo, 9, { pr: row(9, { unresolvedThreads: 5 }), blockers: [], conversation: [] });
    expect(h.toasts.length).toBe(1);
  });

  test("mode: system posts a macOS notification only while unfocused; toast otherwise; off is silent", () => {
    const sys = harness({ mode: "system", focused: false });
    sys.w.observeRows([row(1)], repo);
    sys.w.observeRows([row(1, passed)], repo);
    expect(sys.systems).toEqual(["widgets #1 · checks passed · ready to merge"]);
    expect(sys.toasts).toEqual([]);

    const focused = harness({ mode: "system", focused: true });
    focused.w.observeRows([row(1)], repo);
    focused.w.observeRows([row(1, passed)], repo);
    expect(focused.systems).toEqual([]);
    expect(focused.toasts.length).toBe(1);

    const off = harness({ mode: "off" });
    off.w.observeRows([row(1)], repo);
    off.w.observeRows([row(1, passed)], repo);
    expect(off.toasts).toEqual([]);
    expect(off.systems).toEqual([]);
    expect(off.claimed.size).toBe(0);
  });

  test("another pane that already claimed the event keeps this one quiet", () => {
    const claimed = new Set<string>();
    const a = harness({ claimed });
    const b = harness({ claimed });
    for (const h of [a, b]) {
      h.w.observeRows([row(3)], repo);
      h.w.observeRows([row(3, passed)], repo);
    }
    expect(a.toasts.length + b.toasts.length).toBe(1);
  });

  test("a PR that left the own board is reported for lookup; its merge is news unless stk did it", () => {
    const h = harness();
    expect(h.w.observeRows([row(1), row(2)], repo, [repo])).toEqual([]);
    expect(h.w.observeRows([row(1)], repo, [repo])).toEqual([{ repo, n: 2 }]);
    expect(h.w.observeRows([row(1)], repo, [repo])).toEqual([]);
    // the lookup's detail says merged
    h.w.observeDetail(repo, 2, { pr: row(2, { state: "MERGED" }), blockers: [], conversation: [] });
    expect(h.toasts).toEqual(["info:widgets #2 · merged"]);

    const mine = harness();
    mine.w.observeRows([row(4)], repo, [repo]);
    mine.w.observeRows([], repo, [repo]);
    mine.w.markSelf(repo, 4);
    mine.w.observeDetail(repo, 4, { pr: row(4, { state: "MERGED" }), blockers: [], conversation: [] });
    expect(mine.toasts).toEqual([]);

    const job = harness({ jobMerged: true });
    job.w.observeRows([row(6)], repo, [repo]);
    job.w.observeRows([], repo, [repo]);
    job.w.observeDetail(repo, 6, { pr: row(6, { state: "MERGED" }), blockers: [], conversation: [] });
    expect(job.toasts).toEqual([]);
  });

  test("repos the answer did not cover (a failed repo) are not treated as left", () => {
    const h = harness();
    const other = { owner: "acme", name: "core" };
    h.w.observeRows([{ ...row(1), repo }, { ...row(2), repo: other }] as never, null, [repo, other]);
    expect(h.w.observeRows([{ ...row(1), repo }] as never, null, [repo])).toEqual([]);
  });

  test("the review board is watched but never looked up", () => {
    const h = harness();
    h.w.observeRows([row(8)], repo);
    expect(h.w.observeRows([], repo)).toEqual([]);
  });
});
