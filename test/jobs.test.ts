import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StkError, jobFailureText, mergeOutcomeText, type Exec } from "../src/types";
import { requestMergeAsync } from "../src/github";
import { claimNotify, claimStartupNotify, jobStatusText, jobsDir, listJobs, readJob, runJob, serviceRunner, startJob, watchJob, type Job, type JobSpec } from "../src/jobs";
import { slugCtx } from "../src/service";

/**
 * Fake GitHub for the real merge path: open PRs `chain` (one native stack when `native`), mergeable with green
 * checks except `blocked` (review required). merge-async answers `result` (`enqueued` = merge queue).
 */
function fakeMergeGithub(
  chain: number[],
  o: { native: boolean; result: "merged" | "enqueued"; blocked?: number[] },
): { exec: Exec; puts: string[] } {
  const { native, result, blocked = [] } = o;
  const puts: string[] = [];
  const pr = (n: number) => {
    const at = chain.indexOf(n);
    return {
      number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, author: { login: "me" }, state: merged.has(n) ? "MERGED" : "OPEN", isDraft: false,
      headRefName: `b${n}`, baseRefName: at > 0 && !rebased ? `b${chain[at - 1]}` : "main", headRefOid: `sha${n}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: blocked.includes(n) ? "REVIEW_REQUIRED" : "APPROVED", statusCheckRollup: [],
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", body: "", files: [],
    };
  };
  const ok = (v: unknown) => ({ code: 0, stdout: JSON.stringify(v), stderr: "" });
  const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
  const merged = new Set<number>();
  // gh stack push moves the open PRs onto the trunk (GitHub leaves them on the merged branch until then)
  let rebased = false;
  const exec: Exec = async (argv, opts) => {
    const a = argv.join(" ");
    if (a.includes("merge-async")) {
      const path = argv.find((x) => x.includes("merge-async"))!;
      const n = Number(/pulls\/(\d+)\//.exec(path)![1]);
      // GitHub: rules can only be bypassed on the bottom-most unmerged PR of a stack
      if (opts?.stdin && JSON.parse(opts.stdin).bypass_rules && n !== chain.find((m) => !merged.has(m))) {
        const body = { status: "failed", details: { message: "Rules can only be bypassed when merging the bottom-most unmerged pull request in the stack." } };
        return { code: 1, stdout: `HTTP/2.0 400 Bad Request\r\n\r\n${JSON.stringify(body)}`, stderr: "" };
      }
      puts.push(path);
      if (result === "merged") for (const m of native ? chain.filter((x) => x <= n) : [n]) merged.add(m);
      return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ status: result, details: {} })}`, stderr: "" };
    }
    if (a.startsWith("gh stack ")) {
      if (a === "gh stack push") rebased = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (a === "git worktree list --porcelain") return { code: 0, stdout: chain.map((n) => `worktree /wt-${n}\nHEAD sha${n}\nbranch refs/heads/b${n}\n\n`).join(""), stderr: "" };
    if (a === "git status --porcelain") return { code: 0, stdout: "", stderr: "" };
    if (a.startsWith("git rev-parse --verify refs/heads/")) return { code: 0, stdout: `sha${argv[3]!.replace("refs/heads/b", "")}\n`, stderr: "" };
    if (a.startsWith("git ls-remote origin refs/heads/")) return { code: 0, stdout: `sha${argv[3]!.replace("refs/heads/b", "")}\t${argv[3]}\n`, stderr: "" };
    if (argv[1] === "repo") return ok({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } });
    if (argv[1] === "pr" && argv[2] === "list") return ok(chain.filter((n) => !merged.has(n)).map(pr));
    if (argv[1] === "pr" && argv[2] === "view") return ok(pr(Number(argv[3])));
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const n = Number(argv[argv.indexOf("-F") + 1]!.slice(2));
      if (!native || !chain.includes(n)) return ok({ data: { repository: { pullRequest: { stackEntry: null, stack: null } } } });
      const full = query.includes("headRefOid");
      const nodes = chain.map((m, i) => ({
        position: i + 1,
        pullRequest: full
          ? { ...pr(m), statusCheckRollup: null, reviewThreads: { nodes: [] } }
          : { number: m, title: `PR ${m}`, state: merged.has(m) ? "MERGED" : "OPEN", isDraft: false, statusCheckRollup: null },
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
  return { exec, puts };
}

const repo = { owner: "o", name: "r" };
const spec: JobSpec = { kind: "merge", repo, pr: 7, method: "squash", force: false };
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stk-jobs-"));
  process.env.STK_JOBS_DIR = dir;
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const step = (pr: number) => ({ step: { kind: "merge" as const, pr, method: "squash" as const, admin: false, bypass: [] }, ok: true, detail: `merged #${pr}` });
const alive = () => true;
const dead = () => false;

describe("jobs", () => {
  test("startJob writes a running file and spawns the runner with its id", async () => {
    const spawned: string[] = [];
    const { id } = await startJob(spec, { alive, spawn: (i) => (spawned.push(i), 4242) });
    expect(spawned).toEqual([id]);
    expect(jobsDir()).toBe(dir);
    // The runner records its own pid when it starts; until then the file names the starting process.
    expect(readJob(id, { alive })).toMatchObject({ id, kind: "merge", pr: 7, status: "running", pid: process.pid, steps: [] });
  });

  test("a runner that finishes before startJob returns keeps its outcome", async () => {
    const { id } = await startJob(spec, {
      alive,
      // Simulates a fast detached child: it claims the job and finishes before spawn() even returns to the parent.
      spawn: (i) => {
        const path = join(dir, `${i}.json`);
        const job = JSON.parse(readFileSync(path, "utf8")) as Job;
        writeFileSync(path, JSON.stringify({ ...job, pid: 4242, status: "done", steps: [step(7)], updatedAt: Date.now() }));
        return 4242;
      },
    });
    expect(readJob(id, { alive })).toMatchObject({ status: "done", pid: 4242 });
  });

  test("a second job for the same PR is refused while the first runs", async () => {
    await startJob(spec, { alive, spawn: () => 1 });
    await expect(startJob(spec, { alive, spawn: () => 1 })).rejects.toThrow("already being merged");
    // ...but fine once the first runner is gone.
    await expect(startJob(spec, { alive: dead, spawn: () => 1 })).resolves.toHaveProperty("id");
  });

  test("lifecycle: running -> steps/progress recorded after each update -> done", async () => {
    const { id } = await startJob(spec, { alive, spawn: () => process.pid });
    const seen: Job[] = [];
    const stop = watchJob(id, (j) => seen.push(j), { alive });
    await runJob(id, async (_j, update) => {
      update({ total: 2, prs: [7] });
      update({ progress: { pr: 7, phase: "pending", uuid: "u1" } });
      expect(readJob(id, { alive })).toMatchObject({ total: 2, progress: { phase: "pending" }, status: "running" });
      update({ steps: [step(7)] });
    });
    await Bun.sleep(1200); // the 1 s poll catches whatever fs.watch missed
    stop();
    const done = readJob(id, { alive })!;
    expect(done).toMatchObject({ status: "done", pid: process.pid, total: 2 });
    expect(done.steps).toHaveLength(1);
    expect(seen.at(-1)!.status).toBe("done");
    expect(seen[0]!.status).toBe("running");
  });

  test("a runner failure marks the job failed and keeps the StkError code, data and step results", async () => {
    const { id } = await startJob({ ...spec, kind: "stack-merge" }, { alive, spawn: () => process.pid });
    await runJob(id, async () => {
      throw new StkError("stack merge stopped: boom", "step-failed", { results: [step(6), { ...step(7), ok: false, detail: "boom" }] });
    });
    const j = readJob(id, { alive })!;
    expect(j).toMatchObject({ status: "failed", error: "stack merge stopped: boom", errorCode: "step-failed" });
    expect(j.steps.map((s) => s.ok)).toEqual([true, false]);
  });

  test("stale pid: a running job whose runner died is failed with 'runner exited'", async () => {
    const { id } = await startJob(spec, { alive, spawn: () => 999_999 });
    expect(readJob(id, { alive })!.status).toBe("running");
    const j = readJob(id, { alive: dead })!;
    expect(j).toMatchObject({ status: "failed", error: "runner exited" });
    // persisted, so every reader agrees afterwards
    expect(readJob(id, { alive })!.status).toBe("failed");
  });

  test("a finished job is never touched by the stale check", async () => {
    const { id } = await startJob(spec, { alive, spawn: () => 999_999 });
    await runJob(id, async () => {});
    expect(readJob(id, { alive: dead })!.status).toBe("done");
  });

  test("listJobs filters by repo and PR (including PRs a stack job lands), newest first, ignoring junk files", async () => {
    const a = await startJob(spec, { alive, spawn: () => 1 });
    const b = await startJob({ ...spec, kind: "stack-merge", pr: 9 }, { alive, spawn: () => 1 });
    await startJob({ ...spec, repo: { owner: "x", name: "y" }, pr: 1 }, { alive, spawn: () => 1 });
    await runJob(b.id, async (_j, update) => update({ prs: [8, 9] }));
    writeFileSync(join(dir, "junk.json"), "not json");
    expect(listJobs({ repo, alive }).map((j) => j.id)).toEqual([b.id, a.id]);
    expect(listJobs({ repo, pr: 8, alive }).map((j) => j.id)).toEqual([b.id]);
    expect(listJobs({ repo: { owner: "O", name: "R" }, pr: 7, alive }).map((j) => j.id)).toEqual([a.id]);
  });

  test("fake runner (STK_FAKE_MERGE) walks three steps without touching gh", async () => {
    process.env.STK_FAKE_MERGE = "1";
    process.env.STK_FAKE_MERGE_MS = "5";
    try {
      const { id } = await startJob(spec, { alive, spawn: () => process.pid });
      await runJob(id);
      const j = readJob(id, { alive })!;
      expect(j).toMatchObject({ status: "done", total: 3 });
      expect(j.steps).toHaveLength(3);
    } finally {
      delete process.env.STK_FAKE_MERGE;
      delete process.env.STK_FAKE_MERGE_MS;
    }
  });

  test("jobStatusText shows step n/total and the async phase", () => {
    const base: Job = { id: "j", kind: "stack-merge", repo, pr: 7, method: "squash", force: false, status: "running", steps: [step(5), step(6)], total: 5, pid: 1, startedAt: 0, updatedAt: 0 };
    expect(jobStatusText(base)).toBe("merging stack #7… · 3/5");
    expect(jobStatusText({ ...base, kind: "merge", total: undefined, steps: [], progress: { pr: 7, phase: "pending" } })).toBe("merging #7… · waiting for GitHub");
  });

  const runService = async (s: JobSpec, exec: Exec, withCheckout = false) => {
    const { id } = await startJob(s, { alive, spawn: () => process.pid });
    const ctx = async () => (withCheckout ? { ...slugCtx(exec, repo), root: "/repo", worktrees: [5, 6, 7].map((n) => ({ path: `/wt-${n}`, branch: `b${n}`, head: `sha${n}`, bare: false })) } : slugCtx(exec, repo));
    await runJob(id, (job, update) => serviceRunner(job, update, ctx));
    return readJob(id, { alive })!;
  };
  const stackSpec: JobSpec = { ...spec, kind: "stack-merge" };

  test("a merge GitHub only adds to the merge queue finishes as queued, not merged", async () => {
    const { exec, puts } = fakeMergeGithub([7], { native: false, result: "enqueued" });
    const j = await runService(spec, exec);
    expect(puts).toEqual(["repos/o/r/pulls/7/merge-async"]);
    expect(j).toMatchObject({ status: "done", outcome: "enqueued", merged: [] });
    expect(mergeOutcomeText(j)).toBe("Queued · #7 (not merged yet)");
  });

  test("a native stack merge that lands in the merge queue finishes as queued", async () => {
    const { exec, puts } = fakeMergeGithub([5, 6, 7], { native: true, result: "enqueued" });
    const j = await runService(stackSpec, exec);
    expect(puts).toEqual(["repos/o/r/pulls/7/merge-async"]);
    expect(j).toMatchObject({ status: "done", outcome: "enqueued", merged: [] });
    expect(mergeOutcomeText(j)).toBe("Queued · #7 (not merged yet)");
  });

  test("a whole native stack merging reports every landed PR", async () => {
    const { exec } = fakeMergeGithub([5, 6, 7], { native: true, result: "merged" });
    const j = await runService(stackSpec, exec);
    expect(j).toMatchObject({ status: "done", outcome: "merged", merged: [5, 6, 7] });
    expect(mergeOutcomeText(j)).toBe("Stack merged · #5, #6, #7");
  });

  test("only a ready prefix merging is partial: the selected PR is still open", async () => {
    const { exec, puts } = fakeMergeGithub([5, 6, 7], { native: true, result: "merged", blocked: [6] });
    const j = await runService(stackSpec, exec);
    expect(puts).toEqual(["repos/o/r/pulls/5/merge-async"]);
    expect(j).toMatchObject({ status: "done", outcome: "partial", merged: [5] });
    expect(mergeOutcomeText(j)).toBe("Merged #5 · #7 still open");
  });

  test("a forced native stack merges a bypassed PR alone once everything below it has landed", async () => {
    const { exec, puts } = fakeMergeGithub([5, 6, 7], { native: true, result: "merged", blocked: [6] });
    const j = await runService({ ...stackSpec, force: true }, exec, true);
    expect(puts).toEqual(["repos/o/r/pulls/5/merge-async", "repos/o/r/pulls/6/merge-async", "repos/o/r/pulls/7/merge-async"]);
    // the job's plan grew the rebase that GitHub needs between the merges
    expect(j).toMatchObject({ status: "done", outcome: "merged", merged: [5, 6, 7], total: 4 });
    expect(j.plan!.map((s) => s.kind)).toEqual(["merge", "rebase-stack", "merge", "merge"]);
  });

  test("GitHub's JSON error body is read: no raw JSON, no HTTP code", async () => {
    const body = { status: "failed", details: { message: "Rules can only be bypassed when merging the bottom-most unmerged pull request in the stack." } };
    const exec: Exec = async (argv) => (argv[1] === "repo" ? { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r" }), stderr: "" } : { code: 1, stdout: `HTTP/2.0 400 Bad Request\r\n\r\n${JSON.stringify(body)}`, stderr: "" });
    const e = (await requestMergeAsync(exec, "/r", 2388, { method: "squash", bypass: true }).catch((x: unknown) => x)) as StkError;
    expect(e.message).toBe("merge of #2388 failed: Rules can only be bypassed when merging the bottom-most unmerged pull request in the stack.");
    const bare = (await requestMergeAsync(async (argv) => (argv[1] === "repo" ? { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r" }), stderr: "" } : { code: 1, stdout: "HTTP/2.0 500 Err\r\n\r\n", stderr: "" }), "/r", 1, { method: "squash" }).catch((x: unknown) => x)) as StkError;
    expect(bare.message).toBe("merge of #1 failed (HTTP 500)");
  });

  test("failure toasts do not repeat their prefixes", () => {
    expect(jobFailureText({ kind: "stack-merge", pr: 2391, error: "stack merge stopped at #2391: Merge conflict detected" })).toBe("Stack #2391 stopped at #2391: Merge conflict detected");
    expect(jobFailureText({ kind: "merge", pr: 2388, error: "merge of #2388 failed: Rules can only be bypassed." })).toBe("merge of #2388 failed: Rules can only be bypassed.");
    expect(jobFailureText({ kind: "merge", pr: 7, error: "boom" })).toBe("#7 merge failed: boom");
  });

  test("a blocked bottom PR merges nothing and says so", async () => {
    const { exec, puts } = fakeMergeGithub([5, 6, 7], { native: true, result: "merged", blocked: [5] });
    const j = await runService(stackSpec, exec);
    expect(puts).toEqual([]);
    expect(j).toMatchObject({ status: "done", outcome: "none", merged: [] });
    expect(mergeOutcomeText(j)).toBe("Nothing merged · #5 is blocked");
  });

  describe("announcing a job's end once", () => {
    const finish = (id: string, endedAgoMs: number) => {
      const path = join(dir, `${id}.json`);
      const job = JSON.parse(readFileSync(path, "utf8")) as Job;
      writeFileSync(path, JSON.stringify({ ...job, status: "failed", error: "boom", updatedAt: Date.now() - endedAgoMs }));
    };

    test("two watchers of one job produce one toast", async () => {
      const { id } = await startJob(spec, { alive, spawn: () => 1 });
      const toasts: string[] = [];
      // A viewer as the TUI does it: on the job's end, toast only if the claim is won, then stop watching.
      const viewer = (name: string) =>
        new Promise<void>((resolve) => {
          const stop = watchJob(
            id,
            (j) => {
              if (j.status === "running") return;
              if (claimNotify(j.id)) toasts.push(name);
              stop();
              resolve();
            },
            { alive },
          );
        });
      const both = Promise.all([viewer("tui"), viewer("tui2")]);
      finish(id, 0);
      await both;
      expect(toasts).toHaveLength(1);
      expect(readJob(id, { alive })?.notifiedAt).toBeGreaterThan(0);
    });

    test("a job that ended long ago is not announced on startup", async () => {
      const { id } = await startJob(spec, { alive, spawn: () => 1 });
      finish(id, 5 * 60_000);
      expect(claimStartupNotify(readJob(id, { alive })!)).toBe(false);
      expect(readJob(id, { alive })?.notifiedAt).toBeUndefined();
    });

    test("a job that ended 10s ago and is unclaimed is announced once", async () => {
      const { id } = await startJob(spec, { alive, spawn: () => 1 });
      finish(id, 10_000);
      const job = readJob(id, { alive })!;
      expect(claimStartupNotify(job)).toBe(true);
      expect(claimStartupNotify(job)).toBe(false);
      expect(claimStartupNotify(readJob(id, { alive })!)).toBe(false);
    });

    test("a still-running job is never announced on startup", async () => {
      const { id } = await startJob(spec, { alive, spawn: () => 1 });
      expect(claimStartupNotify(readJob(id, { alive })!)).toBe(false);
    });
  });
});
