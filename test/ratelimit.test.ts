import { beforeEach, describe, expect, test } from "bun:test";
import { forgetRateLimit, nativeStack, rateLimitReset, viewPr } from "../src/github";
import { listBoard, prDetail, slugCtx, type Ctx, type PrDetail } from "../src/service";
import { Store } from "../src/tui/store";
import { StkError, type Exec } from "../src/types";


const SLUG = { owner: "o", name: "r" };

/** One GraphQL call per `gh pr …`, `gh repo view`, and `gh api graphql`; `gh api rate_limit` is REST and free. */
const isGraphql = (argv: readonly string[]) =>
  (argv[1] === "api" && argv[2] === "graphql") || argv[1] === "pr" || (argv[1] === "repo" && argv[2] === "view");

interface FakeOpts {
  /** PR numbers forming one native stack (bottom first); empty = no native stack. */
  native?: number[];
  /** Branch chain for ref topology (bottom first), independent of native. */
  chain?: number[];
  total?: number;
  /** PR numbers that are MERGED (their native-stack summary and `pr view` say so). */
  merged?: number[];
  queued?: number[];
  /** Extra branch-stacked PRs: PR → the PR whose branch it is based on (makes forks in the ref topology). */
  bases?: Record<number, number>;
}

interface FakeState {
  updatedAt: Map<number, string>;
  graphql: number;
  calls: string[][];
  /** When set, every GraphQL call fails with this stderr. */
  failWith: string | null;
  resetEpoch: number;
  rateLimitReads: number;
}
interface Fake {
  exec: Exec;
  state: FakeState;
  ctx: Ctx;
}

/** Fake GitHub: answers by command shape and counts every GraphQL call. */
function fakeGithub(o: FakeOpts = {}): Fake {
  const total = o.total ?? 33;
  const chain = o.chain ?? o.native ?? [];
  const stamp = (n: number) => `2026-10-01T00:${String(chain.includes(n) ? 50 + (n % 10) : n).padStart(2, "0")}:00Z`;
  const state: FakeState = {
    updatedAt: new Map<number, string>(Array.from({ length: total }, (_, i) => [i + 1, stamp(i + 1)] as const)),
    graphql: 0,
    calls: [],
    failWith: null,
    resetEpoch: Math.floor(Date.now() / 1000) + 1800,
    rateLimitReads: 0,
  };
  const raw = (n: number) => {
    const at = chain.indexOf(n);
    return {
      number: n,
      title: `PR ${n}`,
      url: `https://github.com/o/r/pull/${n}`,
      author: { login: "me" },
      state: o.merged?.includes(n) ? "MERGED" : "OPEN",
      isDraft: false,
      headRefName: `b${n}`,
      baseRefName: o.bases?.[n] ? `b${o.bases[n]}` : at > 0 ? `b${chain[at - 1]}` : "main",
      headRefOid: `sha${n}`,
      mergeable: "MERGEABLE",
      reviewDecision: null,
      statusCheckRollup: [],
      createdAt: "2026-09-01T00:00:00Z",
      updatedAt: state.updatedAt.get(n),
      body: "",
      files: [],
    };
  };
  const summary = (n: number, i: number) => ({
    number: n,
    title: `PR ${n}`,
    state: o.merged?.includes(n) ? "MERGED" : "OPEN",
    isDraft: false,
    isInMergeQueue: o.queued?.includes(n) ?? false,
    statusCheckRollup: [{ state: "SUCCESS" }, { state: "FAILURE" }, { state: "PENDING" }, null][i % 4] ?? null,
  });
  const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  const exec: Exec = async (argv) => {
    state.calls.push([...argv]);
    if (argv[1] === "api" && argv[2] === "rate_limit") {
      state.rateLimitReads++;
      // Stale on purpose: GitHub's rate_limit endpoint can report spare GraphQL points while GraphQL refuses.
      return { code: 0, stdout: JSON.stringify({ resources: { graphql: { remaining: 4709, reset: state.resetEpoch }, core: { remaining: 4000, reset: state.resetEpoch } } }), stderr: "" };
    }
    if (argv.join(" ").includes("query={rateLimit{resetAt}}")) {
      state.rateLimitReads++;
      const remaining = state.failWith && !/secondary/i.test(state.failWith) ? 0 : 100;
      return { code: remaining ? 0 : 1, stdout: `HTTP/2.0 200 OK\r\nX-Ratelimit-Remaining: ${remaining}\r\nX-Ratelimit-Reset: ${state.resetEpoch}\r\n\r\n{}`, stderr: "" };
    }
    if (!isGraphql(argv)) return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
    state.graphql++;
    if (state.failWith) return { code: 1, stdout: "", stderr: state.failWith };
    const ok = (v: unknown) => ({ code: 0, stdout: typeof v === "string" ? v : JSON.stringify(v), stderr: "" });
    if (argv[1] === "repo") return ok({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } });
    if (argv[1] === "pr" && argv[2] === "list") return ok(Array.from(state.updatedAt.keys(), raw));
    if (argv[1] === "pr" && argv[2] === "view") return ok(raw(Number(argv[3])));
    const query = argv.find((a) => a.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const n = Number(argv[argv.indexOf("-F") + 1]!.slice(2));
      const pos = (o.native ?? []).indexOf(n);
      if (pos < 0) return ok({ data: { repository: { pullRequest: { stackEntry: null, stack: null } } } });
      const nodes = o.native!.map((m, i) => ({ position: i + 1, pullRequest: summary(m, i) }));
      return ok({ data: { repository: { pullRequest: { stackEntry: { position: pos + 1 }, stack: { size: nodes.length, entries: { nodes } } } } } });
    }
    if (/pr\d+: pullRequest/.test(query)) {
      const nums = [...query.matchAll(/pr(\d+): pullRequest/g)].map((m) => Number(m[1]));
      const repo: Record<string, unknown> = {};
      for (const n of nums) repo[`pr${n}`] = query.includes("statusCheckRollup") ? summary(n, n) : { isInMergeQueue: o.queued?.includes(n) ?? false, reviewThreads: { nodes: [] } };
      return ok({ data: { repository: repo } });
    }
    const n = Number(argv.find((a) => /^n=\d+$/.test(a))?.slice(2));
    return ok({ data: { repository: { pullRequest: { isInMergeQueue: o.queued?.includes(n) ?? false, reviewThreads: page, reviews: page, comments: page } } } });
  };
  return { exec, state, ctx: slugCtx(exec, SLUG) };
}

beforeEach(() => forgetRateLimit());

describe("prDetail stack entries", () => {
  test("native stack: members come from the one native query, no per-member pr view", async () => {
    const { ctx, state } = fakeGithub({ native: [10, 11, 12, 13, 14, 15], queued: [11, 12] });
    const d = await prDetail(ctx, 12);
    expect(d.stack?.entries.map((e) => [e.number, e.title, e.checks])).toEqual([
      [10, "PR 10", "pass"],
      [11, "PR 11", "fail"],
      [12, "PR 12", "none"], // the PR itself: its own (empty) check list
      [13, "PR 13", "none"],
      [14, "PR 14", "pass"],
      [15, "PR 15", "fail"],
    ]);
    expect(d.pr.inMergeQueue).toBe(true);
    expect(d.stack?.entries.filter((e) => e.inMergeQueue).map((e) => e.number)).toEqual([11, 12]);
    expect(state.calls.filter((c) => c[1] === "pr" && c[2] === "view")).toHaveLength(1);
    // repo view (trunk) + pr view + discussion + pr list refs + native stack
    expect(state.graphql).toBe(5);
  });

  test("merged PR keeps its native stack, merged members included", async () => {
    const { ctx } = fakeGithub({ native: [10, 11, 12, 13], merged: [10, 11] });
    const d = await prDetail(ctx, 11);
    expect(d.pr.state).toBe("MERGED");
    expect(d.stack?.prs).toEqual([10, 11, 12, 13]);
    expect(d.stack?.entries.map((e) => [e.number, e.state])).toEqual([[10, "MERGED"], [11, "MERGED"], [12, "OPEN"], [13, "OPEN"]]);
    expect(d.stack?.native).toBe(true);
  });

  test("non-native stack: all other members in one aliased query", async () => {
    const { ctx, state } = fakeGithub({ chain: [1, 2, 3, 4], queued: [2, 3] });
    const d = await prDetail(ctx, 2);
    expect(d.stack?.prs).toEqual([1, 2, 3, 4]);
    expect(d.stack?.entries.map((e) => e.title)).toEqual(["PR 1", "PR 2", "PR 3", "PR 4"]);
    expect(d.pr.inMergeQueue).toBe(true);
    expect(d.stack?.entries.filter((e) => e.inMergeQueue).map((e) => e.number)).toEqual([2, 3]);
    expect(state.calls.filter((c) => c[1] === "pr" && c[2] === "view")).toHaveLength(1);
    const summaries = state.calls.filter((c) => c.some((a) => a.includes("pr1: pullRequest")));
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.join(" ")).toContain("pr4: pullRequest");
    expect(summaries[0]!.join(" ")).not.toContain("pr2: pullRequest");
    expect(state.graphql).toBe(6);
  });

  test("every member of a forked tree shows the same whole tree; merging still uses the line through the PR", async () => {
    // 1 on main; 2 and 3 on 1; 4 on 3
    const { ctx } = fakeGithub({ chain: [1, 2], bases: { 3: 1, 4: 3 } });
    const shown = (d: PrDetail) => d.stack?.entries.map((e) => [e.number, e.tree?.parent, e.tree?.depth]);
    const tree = [
      [1, null, 0],
      [2, 1, 0],
      [3, 1, 1],
      [4, 3, 1],
    ];
    for (const [n, line] of [
      [1, [1]],
      [2, [1, 2]],
      [4, [1, 3, 4]],
    ] as const) {
      const d = await prDetail(ctx, n);
      expect(shown(d)).toEqual(tree);
      expect(d.stack?.prs).toEqual([...line]);
      expect(d.stack?.forks).toEqual([{ parent: 1, children: [2, 3] }]);
    }
  });
});

test("board merges queue membership in the existing single enrichment query", async () => {
  const { ctx, state } = fakeGithub({ total: 3, queued: [2] });
  const board = await listBoard(ctx, "all");
  expect(board.prs.map((p) => [p.number, p.inMergeQueue])).toEqual([[1, false], [2, true], [3, false]]);
  const enrichment = state.calls.filter((c) => c.some((a) => a.includes("pr1: pullRequest")));
  expect(enrichment).toHaveLength(1);
  expect(enrichment[0]!.join(" ")).toContain("isInMergeQueue");
  expect(enrichment[0]!.join(" ")).toContain("reviewThreads");
  expect(state.graphql).toBe(3); // trunk, list, and the existing batch enrichment
});

describe("rate-limit error mapping", () => {
  test("primary limit: rate-limited with the reset from the live GraphQL headers, not the stale rate_limit endpoint", async () => {
    const f = fakeGithub();
    f.state.failWith = "GraphQL: API rate limit already exceeded for user ID 55217308";
    const err = await viewPr(f.exec, SLUG, 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StkError);
    expect((err as StkError).code).toBe("rate-limited");
    expect(rateLimitReset(err)).toBe(f.state.resetEpoch * 1000);
    expect((err as StkError).message).toMatch(/^GitHub rate limit reached · resets \d{1,2}:\d{2}(am|pm)$/);
  });

  test("secondary limit (GraphQL headers not exhausted): retry in about a minute; the reset is read once", async () => {
    const f = fakeGithub();
    f.state.failWith = "You have exceeded a secondary rate limit. Please wait a few minutes";
    const exec = f.exec;
    const a = rateLimitReset(await viewPr(exec, SLUG, 1).catch((e: unknown) => e));
    const b = rateLimitReset(await viewPr(exec, SLUG, 2).catch((e: unknown) => e));
    expect(a).toBeGreaterThan(Date.now() + 50_000);
    expect(a).toBeLessThan(Date.now() + 70_000);
    expect(b).toBe(a);
  });

  test("an unreadable reset probe still maps to rate-limited", async () => {
    const exec: Exec = async (argv) =>
      argv.join(" ").includes("rateLimit{resetAt}") ? { code: 1, stdout: "", stderr: "boom" } : { code: 1, stdout: "", stderr: "GraphQL: API rate limit exceeded" };
    const err = await viewPr(exec, SLUG, 1).catch((e: unknown) => e);
    expect((err as StkError).code).toBe("rate-limited");
  });

  test("other gh failures stay gh-failed", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "not found" });
    const err = await viewPr(exec, SLUG, 1).catch((e: unknown) => e);
    expect((err as StkError).code).toBe("gh-failed");
    expect(rateLimitReset(err)).toBeNull();
  });

  test("nativeStack and prDetail surface the limit instead of treating it as 'no stack'", async () => {
    const f = fakeGithub({ native: [1, 2] });
    f.state.failWith = "GraphQL: API rate limit already exceeded for user ID 1";
    expect(((await nativeStack(f.exec, SLUG, 1).catch((e: unknown) => e)) as StkError).code).toBe("rate-limited");
    expect(((await prDetail(f.ctx, 1).catch((e: unknown) => e)) as StkError).code).toBe("rate-limited");
  });
});

interface StoreInternals {
  ctxs: Map<string, Promise<Ctx>>;
  prefetchBudget: number;
  prefetchActive: number;
  prefetchQueue: unknown[];
  rateLimitedUntil: number;
  set(p: Record<string, unknown>): void;
  poll(): void;
  loadBoard(scope: "mine", opts: { force: boolean }): Promise<void>;
}

/** The fake Exec is microtask-only, so draining the microtask queue settles every in-flight call chain. */
async function settle() {
  for (let i = 0; i < 2000; i++) await Promise.resolve();
}

async function idle(s: StoreInternals) {
  for (let i = 0; i < 50; i++) {
    await settle();
    if (s.prefetchActive === 0 && s.prefetchQueue.length === 0) return;
  }
  throw new Error("prefetch never went idle");
}

function storeOn(f: Fake) {
  const store = new Store("/nonexistent", { gh: SLUG });
  const s = store as unknown as StoreInternals;
  s.ctxs.set("o/r", Promise.resolve(f.ctx));
  s.set({ ctx: f.ctx });
  return { store, s };
}

/** GraphQL calls made while `fn` runs, and how many were detail fetches (`pr view`). */
async function measure(f: Fake, fn: () => Promise<void>) {
  const g0 = f.state.graphql;
  const v0 = f.state.calls.filter((c) => c[1] === "pr" && c[2] === "view").length;
  await fn();
  return { graphql: f.state.graphql - g0, details: f.state.calls.filter((c) => c[1] === "pr" && c[2] === "view").length - v0 };
}

describe("Store polling cost (33 open PRs, 6-PR native stack)", () => {
  const stack = [10, 11, 12, 13, 14, 15];

  test("first load prefetches 12 details; later polls with unchanged updatedAt fetch none", async () => {
    const f = fakeGithub({ native: stack });
    const { s } = storeOn(f);
    const first = await measure(f, async () => {
      await s.loadBoard("mine", { force: true });
      await idle(s);
    });
    expect(first.details).toBe(12);
    // board (trunk, pr list, threads) + per detail: trunk, view, discussion, refs, native (stack members: no extra views)
    expect(first.graphql).toBe(3 + 12 * 5);
    const budgetAfterFirst = s.prefetchBudget;

    for (let i = 0; i < 3; i++) {
      const poll = await measure(f, async () => {
        s.poll();
        await settle();
        await idle(s);
      });
      expect(poll.details).toBe(0);
      expect(poll.graphql).toBe(3); // the board itself
    }
    expect(s.prefetchBudget).toBe(budgetAfterFirst); // polls never reset or refill the budget
  });

  test("only the PR whose board updatedAt moved is refetched", async () => {
    const f = fakeGithub({ native: stack });
    const { s } = storeOn(f);
    await s.loadBoard("mine", { force: true });
    await idle(s);
    f.state.updatedAt.set(12, "2026-10-02T00:00:00Z");
    const poll = await measure(f, async () => {
      s.poll();
      await settle();
      await idle(s);
    });
    expect(poll.details).toBe(1);
    expect(f.state.calls.filter((c) => c[1] === "pr" && c[2] === "view").at(-1)![3]).toBe("12");
  });

  test("hourly budget: exhausted budget stops prefetch even for changed PRs", async () => {
    const f = fakeGithub({ native: stack });
    const { s } = storeOn(f);
    await s.loadBoard("mine", { force: true });
    await idle(s);
    s.prefetchBudget = 0;
    f.state.updatedAt.set(12, "2026-10-02T00:00:00Z");
    const poll = await measure(f, async () => {
      s.poll();
      await settle();
      await idle(s);
    });
    expect(poll.details).toBe(0);
  });

  test("a rate-limit error pauses polling until the reset and keeps cached data", async () => {
    const f = fakeGithub({ native: stack });
    const { store, s } = storeOn(f);
    await s.loadBoard("mine", { force: true });
    await idle(s);
    f.state.failWith = "GraphQL: API rate limit already exceeded for user ID 55217308";
    await s.loadBoard("mine", { force: true });
    expect(s.rateLimitedUntil).toBe(f.state.resetEpoch * 1000);
    const board = store.getState().boards.mine!;
    expect(board.data?.prs).toHaveLength(33);
    expect(board.error).toMatch(/^GitHub rate limit reached · resets /);
    expect(board.errorCode).toBe("rate-limited");

    const before = f.state.calls.length;
    s.poll();
    await settle();
    expect(f.state.calls.length).toBe(before);
  });

  test("with notifications off, an unfocused terminal skips polls and catches up on focus", async () => {
    const f = fakeGithub({ native: stack });
    const { store, s } = storeOn(f);
    store.setNotify("off");
    await s.loadBoard("mine", { force: true });
    await idle(s);
    store.setTerminalFocused(false);
    const before = f.state.calls.length;
    s.poll();
    s.poll();
    await settle();
    expect(f.state.calls.length).toBe(before);
    const refocus = await measure(f, async () => {
      store.setTerminalFocused(true);
      await settle();
      await idle(s);
    });
    expect(refocus.graphql).toBe(3);
  });
});
