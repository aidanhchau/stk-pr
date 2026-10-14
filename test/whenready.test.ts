import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StkError, type Exec } from "../src/types";
import { cancelJob, jobStatusText, makeWhenReadyRunner, readJob, runJob, startJob, type Job, type JobRunner, type WhenReadyDeps } from "../src/jobs";
import { slugCtx } from "../src/service";

/** Mutable fake GitHub: `chain` open PRs (one classic stack), each PR's blockers are set membership the test flips over time. */
interface Fake {
  exec: Exec;
  puts: string[];
  /** Calls to `gh pr view` / `gh pr list`, i.e. what polling costs. */
  views: number;
  pending: Set<number>;
  failing: Set<number>;
  needsReview: Set<number>;
  changes: Set<number>;
  conflict: Set<number>;
  closed: Set<number>;
  rateLimited: { until: number } | null;
}

function fakeGithub(chain: number[], native = false): Fake {
  const f: Fake = { exec: null as unknown as Exec, puts: [], views: 0, pending: new Set(), failing: new Set(), needsReview: new Set(), changes: new Set(), conflict: new Set(), closed: new Set(), rateLimited: null };
  const merged = new Set<number>();
  const rollupOf = (n: number) => {
    const rollup = f.failing.has(n)
      ? [{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" }]
      : f.pending.has(n)
        ? [{ __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null }]
        : [{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" }];
    return rollup;
  };
  const pr = (n: number) => {
    const at = chain.indexOf(n);
    return {
      number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, author: { login: "me" },
      state: f.closed.has(n) ? "CLOSED" : merged.has(n) ? "MERGED" : "OPEN", isDraft: false,
      headRefName: `b${n}`, baseRefName: at > 0 ? `b${chain[at - 1]}` : "main", headRefOid: `sha${n}`,
      mergeable: f.conflict.has(n) ? "CONFLICTING" : "MERGEABLE", mergeStateStatus: f.conflict.has(n) ? "DIRTY" : "CLEAN",
      reviewDecision: f.changes.has(n) ? "CHANGES_REQUESTED" : f.needsReview.has(n) ? "REVIEW_REQUIRED" : "APPROVED",
      statusCheckRollup: rollupOf(n), createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", body: "", files: [],
    };
  };
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  f.exec = async (argv) => {
    const a = argv.join(" ");
    if (f.rateLimited && (argv[1] === "pr" || a.includes("merge-async"))) {
      return { code: 1, stdout: "", stderr: "API rate limit exceeded for user" };
    }
    if (a.includes("merge-async")) {
      const n = Number(/pulls\/(\d+)\//.exec(argv.find((x) => x.includes("merge-async"))!)![1]);
      f.puts.push(`merge ${n}`);
      for (const m of chain.filter((x) => x <= n)) merged.add(m);
      return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ status: "merged", details: {} })}`, stderr: "" };
    }
    if (argv[1] === "repo") return ok({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } });
    if (argv[1] === "pr" && argv[2] === "list") {
      f.views++;
      return ok(chain.filter((n) => !merged.has(n) && !f.closed.has(n)).map(pr));
    }
    if (argv[1] === "pr" && argv[2] === "view") {
      f.views++;
      return ok(pr(Number(argv[3])));
    }
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const n = Number(argv[argv.indexOf("-F") + 1]!.slice(2));
      if (!native || !chain.includes(n)) return ok({ data: { repository: { pullRequest: { stackEntry: null, stack: null } } } });
      const full = query.includes("headRefOid");
      const nodes = chain.map((m, i) => ({
        position: i + 1,
        pullRequest: full
          ? { ...pr(m), statusCheckRollup: { contexts: { nodes: rollupOf(m) } }, reviewThreads: { nodes: [] } }
          : { number: m, title: `PR ${m}`, state: pr(m).state, isDraft: false, statusCheckRollup: null },
      }));
      const repository = { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: chain.indexOf(n) + 1 }, stack: { size: nodes.length, entries: { nodes } } } };
      return ok({ data: { repository } });
    }
    if (/pr\d+: pullRequest/.test(query)) {
      const repo: Record<string, unknown> = {};
      for (const m of query.matchAll(/pr(\d+): pullRequest/g)) repo[`pr${m[1]}`] = { reviewThreads: { nodes: [] } };
      return ok({ data: { repository: repo } });
    }
    if (query) return ok({ data: { repository: { pullRequest: { reviewThreads: page, reviews: page, comments: page } } } });
    return { code: 1, stdout: "", stderr: `unexpected: ${a}` };
  };
  return f;
}

const repo = { owner: "o", name: "r" };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stk-whenready-"));
  process.env.STK_JOBS_DIR = dir;
});
afterEach(() => {
  delete process.env.STK_JOBS_DIR;
  rmSync(dir, { recursive: true, force: true });
});

/** Fake clock: `sleep` advances it and lets the test change GitHub after each wait (`tick(n)`: n-th sleep, 1-based). */
function clock(tick: (n: number, sleeps: number[]) => void = () => {}) {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const deps: Pick<WhenReadyDeps, "now" | "sleep"> = {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
      sleeps.push(ms);
      tick(sleeps.length, sleeps);
    },
  };
  return { deps, sleeps, advance: (ms: number) => void (t += ms) };
}

async function start(f: Fake, runner: JobRunner, opts: { pr: number; stack?: boolean }): Promise<{ id: string; done: Promise<boolean> }> {
  const { id } = await startJob({ kind: "merge-when-ready", repo, pr: opts.pr, method: "squash", force: false, ...(opts.stack ? { stack: true } : {}) }, { spawn: () => 0, alive: () => true });
  const done = runJob(id, (job, update) => runner(job, update, async () => slugCtx(f.exec, repo)));
  return { id, done };
}

const job = (id: string): Job => readJob(id, { alive: () => true })!;

describe("merge-when-ready", () => {
  test("a clear PR merges on the first poll without waiting", async () => {
    const f = fakeGithub([7]);
    const c = clock();
    const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
    await done;
    expect(job(id).status).toBe("done");
    expect(job(id).outcome).toBe("merged");
    expect(job(id).merged).toEqual([7]);
    expect(f.puts).toEqual(["merge 7"]);
    expect(c.sleeps).toEqual([]);
  });

  test("waits while checks are pending, polling every 60 s, then merges once they pass", async () => {
    const f = fakeGithub([7]);
    f.pending.add(7);
    const seen: string[] = [];
    const c = clock((n) => {
      seen.push(jobStatusText(job(idOf())));
      if (n === 3) f.pending.delete(7);
    });
    let idOf = () => "";
    const started = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
    idOf = () => started.id;
    await started.done;
    expect(c.sleeps).toEqual([60_000, 60_000, 60_000]);
    expect(seen[0]).toBe("waiting to merge #7 · checks pending");
    expect(f.puts).toEqual(["merge 7"]);
    expect(job(started.id).status).toBe("done");
    expect(job(started.id).waiting).toBeUndefined();
  });

  test("never merges while a soft blocker stands (review required)", async () => {
    const f = fakeGithub([7]);
    f.needsReview.add(7);
    const c = clock((n) => {
      if (n === 2) f.needsReview.delete(7);
    });
    const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
    await done;
    expect(c.sleeps.length).toBe(2);
    expect(f.puts).toEqual(["merge 7"]);
    expect(job(id).status).toBe("done");
  });

  test("a conflict that appears while waiting fails the job with the reason and merges nothing", async () => {
    const f = fakeGithub([7]);
    f.pending.add(7);
    const c = clock((n) => {
      if (n === 2) f.conflict.add(7);
    });
    const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
    await done;
    const j = job(id);
    expect(j.status).toBe("failed");
    expect(j.error).toContain("#7 conflicts with");
    expect(j.errorCode).toBe("blocked");
    expect(f.puts).toEqual([]);
  });

  test("changes requested, failing checks and a PR closed by someone else are hard stops", async () => {
    for (const [setup, text] of [
      [(f: Fake) => f.changes.add(7), "changes requested on #7"],
      [(f: Fake) => f.failing.add(7), "checks failed on #7: lint"],
      [(f: Fake) => f.closed.add(7), "#7 was closed by someone else"],
    ] as const) {
      const f = fakeGithub([7]);
      f.pending.add(7);
      const c = clock((n) => {
        if (n === 1) setup(f);
      });
      const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
      await done;
      expect(job(id).status).toBe("failed");
      expect(job(id).error).toContain(text);
      expect(f.puts).toEqual([]);
    }
  });

  test("gives up after the deadline with the last waiting reason", async () => {
    const f = fakeGithub([7]);
    f.pending.add(7);
    const c = clock();
    const { id, done } = await start(f, makeWhenReadyRunner({ ...c.deps, maxMs: 5 * 60_000 }), { pr: 7 });
    await done;
    const j = job(id);
    expect(j.status).toBe("failed");
    expect(j.error).toBe("gave up after 5m: checks pending");
    expect(j.errorCode).toBe("merge-timeout");
    expect(f.puts).toEqual([]);
  });

  test("the default deadline is 24 h", async () => {
    const f = fakeGithub([7]);
    f.pending.add(7);
    const c = clock();
    const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
    await done;
    expect(job(id).error).toBe("gave up after 24h: checks pending");
    expect(c.sleeps.length).toBe(24 * 60);
  }, 60_000);

  test("cancel while waiting stops the job and keeps the cancelled record", async () => {
    const f = fakeGithub([7]);
    f.pending.add(7);
    let id = "";
    const c = clock((n) => {
      if (n === 2) expect(cancelJob(id, { alive: () => true })).toBe(true);
      if (n === 3) throw new Error("kept polling after cancel");
    });
    const started = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
    id = started.id;
    await started.done;
    const j = job(id);
    expect(j.status).toBe("failed");
    expect(j.error).toBe("cancelled");
    expect(j.errorCode).toBe("cancelled");
    expect(f.puts).toEqual([]);
  });

  test("cancel is refused once the merge started and is a no-op for other jobs", async () => {
    const { id } = await startJob({ kind: "merge-when-ready", repo, pr: 7, method: "squash", force: false }, { spawn: () => 0, alive: () => true });
    // no `waiting`: the runner has begun merging
    expect(() => cancelJob(id, { alive: () => true })).toThrow(StkError);
    const other = await startJob({ kind: "merge", repo, pr: 8, method: "squash", force: false }, { spawn: () => 0, alive: () => true });
    expect(cancelJob(other.id, { alive: () => true })).toBe(false);
    expect(cancelJob("nope")).toBe(false);
  });

  test("a rate limit pauses polling until the reset instead of failing", async () => {
    const f = fakeGithub([7]);
    f.rateLimited = { until: 0 };
    const c = clock((n) => {
      if (n === 1) f.rateLimited = null;
    });
    const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 7 });
    await done;
    expect(c.sleeps.length).toBe(1);
    expect(c.sleeps[0]).toBeGreaterThanOrEqual(60_000);
    expect(job(id).status).toBe("done");
    expect(f.puts).toEqual(["merge 7"]);
  });

  test("a stack target waits on the blocked member, then lands the stack up to it", async () => {
    const f = fakeGithub([10, 11, 12], true);
    f.pending.add(10);
    f.needsReview.add(11);
    const c = clock((n) => {
      if (n === 1) f.pending.delete(10);
      if (n === 2) f.needsReview.delete(11);
    });
    const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 11, stack: true });
    const seen = job(id);
    await done;
    expect(seen.stack).toBe(true);
    expect(c.sleeps.length).toBe(2);
    const j = job(id);
    expect(j.status).toBe("done");
    expect(j.merged).toEqual([10, 11]);
    expect(f.puts).not.toContain("merge 12");
  });

  test("a stack target stops on a conflict anywhere below it", async () => {
    const f = fakeGithub([10, 11], true);
    f.pending.add(11);
    const c = clock((n) => {
      if (n === 1) f.conflict.add(10);
    });
    const { id, done } = await start(f, makeWhenReadyRunner(c.deps), { pr: 11, stack: true });
    await done;
    expect(job(id).status).toBe("failed");
    expect(job(id).error).toContain("#10 conflicts");
    expect(f.puts).toEqual([]);
  });
});
