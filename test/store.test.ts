import { describe, expect, mock, test } from "bun:test";
import * as service from "../src/service";
import { StkError } from "../src/types";

// prDetail resolves only when the test says so, in the order the test chooses. Module mocks are process-wide in
// bun test, so only contexts marked `held` are intercepted; every other file still gets the real prDetail.
const realPrDetail = service.prDetail;
const realCreateStack = service.createStack;
const realPrCommits = service.prCommits;
const commitRequests: { repo: string; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
const created: number[][] = [];
const pending: { n: number; resolve: (v: unknown) => void; reject: (e: Error) => void }[] = [];
mock.module("../src/service", () => ({
  ...service,
  prCommits: (ctx: service.Ctx & { held?: boolean }, n: number) => {
    if (!ctx.held) return realPrCommits(ctx, n);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    commitRequests.push({ repo: ctx.slug!.name, resolve, reject });
    return promise;
  },
  createStack: async (ctx: { held?: boolean }, prs: number[]) => {
    if (!ctx.held) return realCreateStack(ctx as service.Ctx, prs);
    created.push(prs);
    return { stack: 9, prs };
  },
  prDetail: (ctx: { held?: boolean }, n: number) => {
    if (!ctx.held) return realPrDetail(ctx as service.Ctx, n);
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    pending.push({ n, resolve, reject });
    return promise;
  },
}));

// Loaded after mock.module so the store binds the mocked prDetail; a static import would bind the real one.
const { Store, PALETTE_LINE } = await import("../src/tui/store");

const repo = { owner: "o", name: "r" };
const detail = (title: string) => ({ pr: { number: 7, title, headSha: "head" } });
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("Store prefetch vs forced load", () => {
  test("a prefetch resolving after a forced refresh does not overwrite the fresh detail", async () => {
    const store = new Store("/nonexistent", { gh: repo });
    const s = store as unknown as {
      ctxs: Map<string, Promise<unknown>>;
      prefetchBudget: number;
      prefetch(r: typeof repo, n: number): void;
      getState(): { prCache: Record<string, { data?: { pr: { title: string } } }> };
    };
    s.ctxs.set("o/r", Promise.resolve({ root: null, slug: repo, held: true }));
    s.prefetchBudget = 10;

    s.prefetch(repo, 7);
    await flush();
    const forced = store.loadPr(7, { force: true, repo });
    await flush();
    expect(pending.length).toBe(2);

    pending[1]!.resolve(detail("fresh"));
    await forced;
    pending[0]!.resolve(detail("stale"));
    await flush();

    expect(s.getState().prCache["o/r#7"]?.data?.pr.title).toBe("fresh");
  });
});

describe("Store createStack", () => {
  test("success toasts and force-refetches every member's detail", async () => {
    const store = new Store("/nonexistent", { gh: repo });
    const s = store as unknown as { ctxs: Map<string, Promise<unknown>>; getState(): { toasts: { text: string; kind: string }[] } };
    s.ctxs.set("o/r", Promise.resolve({ root: null, slug: repo, held: true }));
    pending.length = 0;
    const out = await store.createStack([7, 8, 9], 7, repo);
    await flush();
    expect(out.ok).toBe(true);
    expect(created).toEqual([[7, 8, 9]]);
    expect(s.getState().toasts.at(-1)).toMatchObject({ text: "r · Created GitHub stack · #7 → #8 → #9", kind: "success" });
    // detail of the current PR (from run) and of each member, none skipped by an updatedAt/freshness short-circuit
    expect(new Set(pending.map((p) => p.n))).toEqual(new Set([7, 8, 9]));
    for (const p of pending) p.resolve(detail("x"));
  });
});

describe("Store lazy commit history", () => {
  const historical = (sha: string) => [{ sha, message: sha, author: "a", committedAt: "", url: "", checks: [] }];

  test("only expanded history refreshes with the page, even when the head stays unchanged", async () => {
    pending.length = 0;
    commitRequests.length = 0;
    const store = new Store("/nonexistent", { gh: repo, pr: 7, prefsFile: null });
    const internals = store as unknown as { ctxs: Map<string, Promise<unknown>> };
    internals.ctxs.set("o/r", Promise.resolve({ root: null, slug: repo, held: true }));
    store.loadScope = async () => {};
    const initial = store.refresh();
    await flush();
    pending[0]!.resolve(detail("initial"));
    await initial;
    expect(commitRequests).toHaveLength(0);
    store.setCommitsVisible(7, repo, true);
    const opened = store.loadCommits(7, { repo });
    await flush();
    commitRequests[0]!.resolve(historical("head"));
    await opened;
    const refreshed = store.refresh();
    await flush();
    pending[1]!.resolve(detail("refreshed"));
    await flush();
    expect(commitRequests).toHaveLength(2);
    commitRequests[1]!.resolve([{ ...historical("head")[0]!, checks: [{ name: "ci", state: "pass", url: null }] }]);
    await refreshed;
    expect(store.getState().commitCache["o/r#7"]?.data?.[0]?.checks).toEqual([{ name: "ci", state: "pass", url: null }]);
    store.setCommitsVisible(7, repo, false);
    const collapsed = store.refresh();
    await flush();
    pending[2]!.resolve(detail("collapsed"));
    await collapsed;
    expect(commitRequests).toHaveLength(2);
    expect(store.getState().commitCache["o/r#7"]?.data?.[0]?.checks).toEqual([{ name: "ci", state: "pass", url: null }]);
  });

  test("collapsing during a detail or history request stops follow-on loads without discarding the response", async () => {
    pending.length = 0;
    commitRequests.length = 0;
    const store = new Store("/nonexistent", { gh: repo, pr: 7, prefsFile: null });
    const internals = store as unknown as { ctxs: Map<string, Promise<unknown>> };
    internals.ctxs.set("o/r", Promise.resolve({ root: null, slug: repo, held: true }));
    store.setCommitsVisible(7, repo, true);
    const opened = store.loadCommits(7, { repo });
    await flush();
    const detailLoad = store.loadPr(7, { force: true, repo });
    await flush();
    store.setCommitsVisible(7, repo, false);
    pending[0]!.resolve(detail("closed during request"));
    await detailLoad;
    expect(commitRequests).toHaveLength(1);
    commitRequests[0]!.resolve(historical("head"));
    await opened;
    expect(store.getState().commitCache["o/r#7"]?.data).toEqual(historical("head"));
    await flush();
    expect(commitRequests).toHaveLength(1);
  });

  test("failed detail refreshes never reload history, and known cooldown blocks expansion and retries locally", async () => {
    pending.length = 0;
    commitRequests.length = 0;
    const store = new Store("/nonexistent", { gh: repo, pr: 7, prefsFile: null });
    const internals = store as unknown as { ctxs: Map<string, Promise<unknown>>; rateLimitedUntil: number };
    internals.ctxs.set("o/r", Promise.resolve({ root: null, slug: repo, held: true }));
    store.setCommitsVisible(7, repo, true);
    const opened = store.loadCommits(7, { repo });
    await flush();
    commitRequests[0]!.resolve(historical("head"));
    await opened;
    const initial = store.loadPr(7, { repo });
    await flush();
    pending[0]!.resolve(detail("initial"));
    await flush();
    commitRequests[1]!.resolve(historical("head"));
    await initial;
    const failed = store.loadPr(7, { force: true, repo });
    await flush();
    pending[1]!.reject(new Error("detail unavailable"));
    await failed;
    expect(commitRequests).toHaveLength(2);
    expect(store.getState().prCache["o/r#7"]?.error).toBe("detail unavailable");
    const limited = store.loadPr(7, { force: true, repo });
    await flush();
    pending[2]!.reject(new StkError("quota exhausted", "rate-limited", { resetAt: Date.now() + 60_000 }));
    await limited;
    await store.loadCommits(8, { repo });
    await store.loadCommits(8, { repo, force: true });
    await store.loadCommits(7, { repo, force: true });
    expect(commitRequests).toHaveLength(2);
    expect(store.getState().commitCache["o/r#8"]).toMatchObject({ status: "error", errorCode: "rate-limited", refreshing: false });
    expect(store.getState().commitCache["o/r#7"]).toMatchObject({ status: "ready", data: historical("head"), errorCode: "rate-limited", refreshing: false });
    await flush();
    expect(commitRequests).toHaveLength(2);
    internals.rateLimitedUntil = Date.now() - 1;
    const retry = store.loadCommits(7, { repo, force: true });
    await flush();
    commitRequests[2]!.resolve(historical("head"));
    await retry;
    expect(store.getState().commitCache["o/r#7"]?.error).toBeUndefined();
  });

  test("offscreen prefetch head invalidation leaves history lazy until the next visible open", async () => {
    pending.length = 0;
    commitRequests.length = 0;
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    const internals = store as unknown as {
      ctxs: Map<string, Promise<unknown>>;
      set(patch: unknown): void;
      prefetch(r: typeof repo, n: number): void;
    };
    internals.ctxs.set("o/r", Promise.resolve({ root: null, slug: repo, held: true }));
    internals.set({ prCache: { "o/r#7": { status: "ready", refreshing: false, at: 0, data: { pr: { number: 7, headSha: "old" } } } } });
    const opened = store.loadCommits(7, { repo });
    await flush();
    commitRequests[0]!.resolve(historical("old"));
    await opened;
    internals.prefetch(repo, 7);
    await flush();
    pending[0]!.resolve(detail("new head"));
    await flush();
    expect(store.getState().commitCache["o/r#7"]?.status).toBe("idle");
    expect(commitRequests).toHaveLength(1);
    store.setCommitsVisible(7, repo, true);
    const reopen = store.loadCommits(7, { repo });
    await flush();
    commitRequests[1]!.resolve(historical("head"));
    await reopen;
    expect(store.getState().commitCache["o/r#7"]?.data).toEqual(historical("head"));
  });

  test("a cooldown learned while opening the context blocks the pending history request", async () => {
    commitRequests.length = 0;
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    const internals = store as unknown as { ctxs: Map<string, Promise<unknown>>; rateLimitedUntil: number };
    const context = Promise.withResolvers<unknown>();
    internals.ctxs.set("o/r", context.promise);
    const opened = store.loadCommits(7, { repo });
    await flush();
    internals.rateLimitedUntil = Date.now() + 60_000;
    context.resolve({ root: null, slug: repo, held: true });
    await opened;
    expect(commitRequests).toHaveLength(0);
    expect(store.getState().commitCache["o/r#7"]).toMatchObject({ status: "error", errorCode: "rate-limited", refreshing: false });
  });

  test("deduplicates loads, isolates same-number PRs across repos, and keeps errors local", async () => {
    commitRequests.length = 0;
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    const other = { owner: "o", name: "other" };
    const internals = store as unknown as { ctxs: Map<string, Promise<unknown>> };
    for (const r of [repo, other]) internals.ctxs.set(`o/${r.name}`, Promise.resolve({ root: null, slug: r, held: true }));
    expect(store.getState().commitCache).toEqual({});
    const first = store.loadCommits(7, { repo });
    const duplicate = store.loadCommits(7, { repo });
    const second = store.loadCommits(7, { repo: other });
    await flush();
    expect(commitRequests.map((r) => r.repo)).toEqual(["r", "other"]);
    expect(store.getState().commitCache["o/r#7"]?.status).toBe("loading");
    commitRequests[1]!.reject(new Error("history unavailable"));
    commitRequests[0]!.resolve(historical("a"));
    await Promise.all([first, duplicate, second]);
    expect(store.getState().commitCache["o/r#7"]?.data?.[0]?.sha).toBe("a");
    expect(store.getState().commitCache["o/other#7"]).toMatchObject({ status: "error", error: "history unavailable" });
    expect(store.getState().fatal).toBeNull();
    await store.loadCommits(7, { repo });
    expect(commitRequests).toHaveLength(2);
    const refresh = store.loadCommits(7, { repo, force: true });
    await flush();
    expect(store.getState().commitCache["o/r#7"]?.refreshing).toBe(true);
    commitRequests[2]!.reject(new Error("refresh failed"));
    await refresh;
    expect(store.getState().commitCache["o/r#7"]).toMatchObject({ status: "ready", error: "refresh failed", data: historical("a") });
  });

  test("a changed head drops stale history immediately and rejects the old in-flight response", async () => {
    commitRequests.length = 0;
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    const internals = store as unknown as {
      ctxs: Map<string, Promise<unknown>>;
      set(patch: unknown): void;
    };
    internals.ctxs.set("o/r", Promise.resolve({ root: null, slug: repo, held: true }));
    internals.set({ prCache: { "o/r#7": { status: "ready", refreshing: false, data: { pr: { headSha: "old" } } } } });
    const initial = store.loadCommits(7, { repo });
    await flush();
    commitRequests[0]!.resolve(historical("old"));
    await initial;
    const stale = store.loadCommits(7, { repo, force: true });
    await flush();
    internals.set({ prCache: { "o/r#7": { status: "ready", refreshing: false, data: { pr: { headSha: "new" } } } } });
    expect(store.getState().commitCache["o/r#7"]).toMatchObject({ status: "idle" });
    expect(store.getState().commitCache["o/r#7"]?.data).toBeUndefined();
    const fresh = store.loadCommits(7, { repo });
    await flush();
    commitRequests[2]!.resolve(historical("new"));
    await fresh;
    commitRequests[1]!.resolve(historical("old"));
    await stale;
    expect(store.getState().commitCache["o/r#7"]?.data?.[0]?.sha).toBe("new");
  });
});

describe("Store dock search line", () => {
  const line = (query: string, active: boolean) => ({ query, active, info: "", onInput: () => {} });

  test("a screen re-publishing its committed search keeps the open palette's line; closing the palette restores the search", () => {
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    store.setSearchLine("pr-search", line("zzz", false));
    const palette = line("create-stack", true);
    store.setSearchLine(PALETTE_LINE, palette);
    // the page's match count changed under the palette (a refresh): it re-publishes its own slot
    store.setSearchLine("pr-search", line("zzz", false));
    expect(store.getState().searchLine).toBe(palette);
    store.setSearchLine(PALETTE_LINE, null);
    expect(store.getState().searchLine).toMatchObject({ query: "zzz", active: false });
    store.setSearchLine("pr-search", null);
    expect(store.getState().searchLine).toBeNull();
  });
});
