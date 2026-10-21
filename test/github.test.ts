import { describe, expect, spyOn, test } from "bun:test";
import {
  closeAndReopenPr,
  closePr,
  markReady,
  reopenPr,
  rerunFailedChecks,
  getPr,
  listPrs,
  mapDiscussion,
  mergeAsync,
  nativeStack,
  prDiscussion,
  requestMergeAsync,
  retargetPr,
  updateBranch,
  behindBy,
  splitDiffByFile,
  submitReview,
  trunkFor,
  unresolvedThreadCounts,
  viewPr,
  waitChecks,
  withThreads,
} from "../src/github";
import { StkError, type Exec } from "../src/types";

const fx = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

type Reply = { code?: number; stdout?: string; stderr?: string };
interface Call {
  argv: readonly string[];
  stdin?: string;
  cwd?: string;
}

/** Fake Exec: first matching handler (by argv prefix) wins; records calls. */
function fake(handlers: [string[], Reply | (() => Reply)][]) {
  const calls: Call[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv, stdin: opts?.stdin, cwd: opts?.cwd });
    for (const [prefix, reply] of handlers) {
      if (prefix.every((p, i) => argv[i] === p)) {
        const r = typeof reply === "function" ? reply() : reply;
        return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      }
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  };
  return { exec, calls };
}

describe("listPrs", () => {
  test("maps fields, checks and argv", async () => {
    const { exec, calls } = fake([[["gh", "pr", "list"], { stdout: await fx("pr-list.json") }]]);
    const prs = await listPrs(exec, "/repo", { author: "@me", state: "open" });
    expect(calls[0]!.argv).toEqual([
      "gh", "pr", "list", "--json",
      "number,title,url,author,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt,updatedAt",
      "--limit", "100", "--author", "@me", "--state", "open",
    ]);
    expect(calls[0]!.cwd).toBe("/repo");
    expect(prs).toHaveLength(2);
    const a = prs[0]!;
    expect(a).toMatchObject({
      number: 10, author: "octo-dev", headRef: "feat-a", baseRef: "main", headSha: "aaa111",
      reviewDecision: null, mergeable: "MERGEABLE", worktree: null, unresolvedThreads: 0, isDraft: false,
      createdAt: "2026-10-01T10:00:00Z", updatedAt: "2026-10-02T10:00:00Z",
    });
    const by = Object.fromEntries(a.checks.map((c) => [c.name, c.state]));
    expect(by).toEqual({
      lint: "pass", neutral: "skipped", skipped: "skipped", cancelled: "fail", timeout: "fail",
      action: "fail", startup: "fail", failed: "fail", running: "pending",
      vercel: "pass", "ctx-pending": "pending", "ctx-error": "fail", "ctx-fail": "fail",
    });
    expect(a.checks[0]!.url).toBe("https://ci/lint");
    expect(a.checks[1]!.url).toBeNull();
    expect(a.checks.find((c) => c.name === "vercel")!.url).toBe("https://vercel/x");
    expect(prs[1]).toMatchObject({ isDraft: true, mergeable: "CONFLICTING", reviewDecision: "APPROVED", checks: [] });
  });

  test("gh failure throws StkError gh-failed", async () => {
    const { exec } = fake([[["gh", "pr", "list"], { code: 1, stderr: "boom" }]]);
    const err = await listPrs(exec, "/repo").catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("gh-failed");
    expect(err.message).toBe("boom");
  });
});

describe("viewPr", () => {
  const base = { number: 7, title: "t", state: "OPEN", isDraft: false, headRefName: "a", baseRefName: "main", headRefOid: "x" };
  const view = async (extra: object) => {
    const { exec, calls } = fake([[["gh", "pr", "view"], { stdout: JSON.stringify({ ...base, ...extra, files: [] }) }]]);
    return { out: await viewPr(exec, "/repo", 7), calls };
  };

  test("requests and maps body", async () => {
    const { out, calls } = await view({ body: "## Hi\n- a" });
    expect(calls[0]!.argv.at(-1)).toContain(",body,");
    expect(out.pr.body).toBe("## Hi\n- a");
  });

  test("null or missing body maps to empty string", async () => {
    expect((await view({ body: null })).out.pr.body).toBe("");
    expect((await view({})).out.pr.body).toBe("");
  });
});

describe("threads", () => {
  const repoView = [["gh", "repo", "view", "--json", "owner,name"], { stdout: '{"owner":{"login":"o"},"name":"r"}' }] as [string[], Reply];

  test("one aliased graphql query, counts merged into PRs", async () => {
    const { exec, calls } = fake([
      repoView,
      [["gh", "pr", "list"], { stdout: await fx("pr-list.json") }],
      [["gh", "api", "graphql"], { stdout: await fx("threads-graphql.json") }],
    ]);
    const prs = await listPrs(exec, "/repo");
    const counts = await unresolvedThreadCounts(exec, "/repo", prs.map((p) => p.number));
    expect(counts.get(10)).toBe(2);
    expect(counts.get(11)).toBe(0);
    const gql = calls.filter((c) => c.argv[2] === "graphql");
    expect(gql).toHaveLength(1);
    const query = gql[0]!.argv.find((a) => a.startsWith("query="))!;
    expect(query).toContain("pr10: pullRequest(number: 10)");
    expect(query).toContain("pr11: pullRequest(number: 11)");
    expect(query).toContain("reviewThreads(first: 100)");
    expect(query).toContain('owner: "o"');
    const merged = withThreads(prs, counts);
    expect(merged.map((p) => p.unresolvedThreads)).toEqual([2, 0]);
  });

  test("getPr includes threads", async () => {
    const one = JSON.stringify(JSON.parse(await fx("pr-list.json"))[0]);
    const { exec } = fake([
      repoView,
      [["gh", "pr", "view", "10"], { stdout: one }],
      [["gh", "api", "graphql"], { stdout: await fx("threads-graphql.json") }],
    ]);
    const pr = await getPr(exec, "/repo", 10);
    expect(pr.unresolvedThreads).toBe(2);
    expect(pr.number).toBe(10);
  });

  test("empty list makes no calls", async () => {
    const { exec, calls } = fake([]);
    expect((await unresolvedThreadCounts(exec, "/repo", [])).size).toBe(0);
    expect(calls).toHaveLength(0);
  });
});

describe("splitDiffByFile", () => {
  test("handles modify, rename, binary, new and deleted", async () => {
    const files = splitDiffByFile(await fx("sample.diff"));
    expect(files.map((f) => [f.path, f.oldPath, f.additions, f.deletions])).toEqual([
      ["src/a.ts", null, 2, 1],
      ["new/name.ts", "old/name.ts", 1, 1],
      ["img.png", null, 0, 0],
      ["added.txt", null, 2, 0],
      ["gone.txt", null, 0, 2],
    ]);
    expect(files[0]!.patch.startsWith("diff --git a/src/a.ts")).toBe(true);
    expect(files[2]!.patch).toContain("Binary files");
    expect(files.map((f) => f.patch).join("")).toBe(await fx("sample.diff"));
  });

  test("empty text yields no files", () => {
    expect(splitDiffByFile("")).toEqual([]);
  });
});

const http = (status: number, body: unknown) => ({
  code: status >= 400 ? 1 : 0,
  stdout: `HTTP/2.0 ${status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(body)}`,
});
const SLUG = { owner: "o", name: "r" };
const PUT = ["gh", "api", "-i", "-X", "PUT", "repos/o/r/pulls/5/merge-async"];
const pending = { status: "pending", details: { uuid: "u-1", message: "queued" } };

describe("merge-async", () => {
  test("request argv + body: method, pinned sha, bypass only when asked", async () => {
    const { exec, calls } = fake([[PUT, http(202, pending)]]);
    await requestMergeAsync(exec, SLUG, 5, { method: "squash", sha: "abc" });
    await requestMergeAsync(exec, SLUG, 5, { method: "rebase", bypass: true });
    expect(calls[0]!.argv).toEqual([...PUT, "--input", "-"]);
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ merge_method: "squash", sha: "abc" });
    expect(JSON.parse(calls[1]!.stdin!)).toEqual({ merge_method: "rebase", bypass_rules: true });
    expect(calls.flatMap((c) => c.argv)).not.toContain("--delete-branch");
  });

  test("202 pending, 409 pending (existing uuid), 200 merged/enqueued", async () => {
    const run = async (status: number, body: unknown) => requestMergeAsync(fake([[PUT, http(status, body)]]).exec, SLUG, 5, { method: "squash" });
    expect(await run(202, pending)).toEqual({ status: "pending", uuid: "u-1", message: "queued" });
    expect(await run(409, { status: "pending", details: { uuid: "u-0" } })).toMatchObject({ status: "pending", uuid: "u-0" });
    expect(await run(200, { status: "merged", details: { message: "ok", sha: "m1" } })).toMatchObject({ status: "merged", sha: "m1" });
    expect(await run(200, { status: "enqueued", details: { message: "q" } })).toMatchObject({ status: "enqueued" });
  });

  test("400 unmergeable -> gh-failed with GitHub's message; non-HTTP failure uses stderr", async () => {
    const e1 = await requestMergeAsync(fake([[PUT, http(400, { message: "Pull request is a draft" })]]).exec, SLUG, 5, { method: "squash" }).catch((e) => e);
    expect(e1).toBeInstanceOf(StkError);
    expect(e1.code).toBe("gh-failed");
    expect(e1.message).toContain("Pull request is a draft");
    expect(e1.message).toBe("merge of #5 failed: Pull request is a draft");
    const e2 = await requestMergeAsync(fake([[PUT, { code: 1, stderr: "gh: not logged in" }]]).exec, SLUG, 5, { method: "squash" }).catch((e) => e);
    expect(e2.message).toContain("not logged in");
  });

  test("a cwd target resolves the slug via gh repo view", async () => {
    const { exec, calls } = fake([
      [["gh", "repo", "view"], { stdout: '{"owner":{"login":"o"},"name":"r"}' }],
      [PUT, http(202, pending)],
    ]);
    await requestMergeAsync(exec, "/repo", 5, { method: "squash" });
    expect(calls[1]!.argv).toContain("repos/o/r/pulls/5/merge-async");
  });

  test("mergeAsync polls pending -> merged and reports progress", async () => {
    const polls = [http(200, pending), http(200, { status: "merged", details: { message: "done", sha: "m9" } })];
    const { exec, calls } = fake([
      [PUT, http(202, pending)],
      [["gh", "api", "-i", "repos/o/r/pulls/5/merge-async/u-1"], () => polls.shift()!],
    ]);
    const seen: string[] = [];
    const sleeps: number[] = [];
    const out = await mergeAsync(exec, SLUG, 5, {
      method: "squash",
      onProgress: (p) => seen.push(`${p.phase}:${p.uuid}`),
      sleep: async (ms) => void sleeps.push(ms),
    });
    expect(out).toMatchObject({ status: "merged", sha: "m9", uuid: "u-1" });
    expect(seen).toEqual(["requested:u-1", "pending:u-1", "merged:u-1"]);
    expect(sleeps).toEqual([2000, 2000]);
    expect(calls).toHaveLength(3);
  });

  test("mergeAsync: immediate 200 merged skips polling; enqueued is final", async () => {
    const a = fake([[PUT, http(200, { status: "merged", details: { message: "m", sha: "s" } })]]);
    expect(await mergeAsync(a.exec, SLUG, 5, { method: "squash" })).toMatchObject({ status: "merged", sha: "s" });
    expect(a.calls).toHaveLength(1);
    const b = fake([[PUT, http(200, { status: "enqueued", details: { message: "queued" } })]]);
    expect(await mergeAsync(b.exec, SLUG, 5, { method: "squash" })).toMatchObject({ status: "enqueued" });
  });

  test("mergeAsync: failed status throws gh-failed with the reason", async () => {
    const { exec } = fake([
      [PUT, http(202, pending)],
      [["gh", "api", "-i", "repos/o/r/pulls/5/merge-async/u-1"], http(200, { status: "failed", details: { message: "Required status check is expected" } })],
    ]);
    const err = await mergeAsync(exec, SLUG, 5, { method: "squash", sleep: async () => {} }).catch((e) => e);
    expect(err.code).toBe("gh-failed");
    expect(err.message).toContain("Required status check is expected");
  });

  test("mergeAsync: stays pending past the timeout -> merge-timeout with uuid", async () => {
    const { exec } = fake([
      [PUT, http(202, pending)],
      [["gh", "api", "-i", "repos/o/r/pulls/5/merge-async/u-1"], http(200, pending)],
    ]);
    const err = await mergeAsync(exec, SLUG, 5, { method: "squash", timeoutMs: 20, pollMs: 5 }).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("merge-timeout");
    expect(err.data).toEqual({ uuid: "u-1", pr: 5 });
    expect(err.message).toContain("u-1");
  });

  const POLL = ["gh", "api", "-i", "repos/o/r/pulls/5/merge-async/u-1"];
  const PULL = ["gh", "api", "-i", "repos/o/r/pulls/5"];
  const tls = { code: 1, stderr: 'Get "https://api.github.com/repos/o/r/pulls/5/merge-async/u-1": net/http: TLS handshake timeout' };

  test("mergeAsync: a poll that hits a TLS timeout once is retried and the merge is reported", async () => {
    const polls = [tls, http(200, { status: "merged", details: { sha: "m9" } })];
    const { exec, calls } = fake([
      [PUT, http(202, pending)],
      [POLL, () => polls.shift()!],
    ]);
    const sleeps: number[] = [];
    const out = await mergeAsync(exec, SLUG, 5, { method: "squash", pollMs: 10, sleep: async (ms) => void sleeps.push(ms) });
    expect(out).toMatchObject({ status: "merged", sha: "m9" });
    expect(sleeps).toEqual([10, 10]);
    expect(calls.filter((c) => c.argv.includes("PUT"))).toHaveLength(1);
    expect(calls.some((c) => c.argv.join(" ") === PULL.join(" "))).toBe(false);
  });

  test("mergeAsync: a poll that keeps failing falls back to the PR; merged means success with its merge sha", async () => {
    const { exec, calls } = fake([
      [PUT, http(202, pending)],
      [POLL, tls],
      [PULL, http(200, { state: "closed", merged: true, merge_commit_sha: "abc123" })],
    ]);
    const seen: string[] = [];
    const sleeps: number[] = [];
    const out = await mergeAsync(exec, SLUG, 5, { method: "squash", pollMs: 10, onProgress: (p) => seen.push(p.phase), sleep: async (ms) => void sleeps.push(ms) });
    expect(out).toMatchObject({ status: "merged", uuid: "u-1", sha: "abc123" });
    expect(seen).toEqual(["requested", "merged"]);
    // bounded: 4 poll attempts with doubling backoff, and the merge request is sent once
    expect(calls.filter((c) => c.argv.join(" ") === POLL.join(" "))).toHaveLength(4);
    expect(sleeps).toEqual([10, 10, 20, 40]);
    expect(calls.filter((c) => c.argv.includes("PUT"))).toHaveLength(1);
  });

  test("mergeAsync: a poll that keeps failing while the PR is still open is an unknown-outcome error, not a failed merge", async () => {
    const { exec, calls } = fake([
      [PUT, http(202, pending)],
      [POLL, tls],
      [PULL, http(200, { state: "open", merged: false, merge_commit_sha: null })],
    ]);
    const err = await mergeAsync(exec, SLUG, 5, { method: "squash", sleep: async () => {} }).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("gh-failed");
    expect(err.message).toContain("outcome of the merge of #5 is unknown");
    expect(err.message).toContain("TLS handshake timeout");
    expect(err.message).toContain("still open");
    expect(err.message).not.toContain("failed:");
    expect(calls.filter((c) => c.argv.includes("PUT"))).toHaveLength(1);
  });

  test("mergeAsync: a definite 4xx answer to the poll is not retried, but the PR is still re-read", async () => {
    const { exec, calls } = fake([
      [PUT, http(202, pending)],
      [POLL, http(404, { message: "Not Found" })],
      [PULL, http(200, { state: "closed", merged: true, merge_commit_sha: "zz" })],
    ]);
    const out = await mergeAsync(exec, SLUG, 5, { method: "squash", sleep: async () => {} });
    expect(out).toMatchObject({ status: "merged", sha: "zz" });
    expect(calls.filter((c) => c.argv.join(" ") === POLL.join(" "))).toHaveLength(1);
  });

  test("mergeAsync: poll retries stop at the caller's timeoutMs and throw merge-timeout with the uuid", async () => {
    const { exec } = fake([
      [PUT, http(202, pending)],
      [POLL, tls],
    ]);
    // a fake clock the injected sleep advances; no real waiting
    let clock = 1_000_000;
    const nowSpy = spyOn(Date, "now").mockImplementation(() => clock);
    const sleeps: number[] = [];
    const outcome = await mergeAsync(exec, SLUG, 5, { method: "squash", pollMs: 20, timeoutMs: 50, sleep: async (ms) => void (sleeps.push(ms), (clock += ms)) }).then(
      () => null,
      (e: unknown) => e as StkError,
    );
    nowSpy.mockRestore();
    const err = outcome!;
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("merge-timeout");
    expect(err.data).toEqual({ uuid: "u-1", pr: 5 });
    // backoff would be 20, 40, 80 after the first poll delay: each sleep is capped to what is left of the 50ms deadline
    expect(sleeps).toEqual([20, 20, 10]);
  });
});

describe("nativeStack", () => {
  const reply = (stack: unknown, entry: unknown) =>
    ({ stdout: JSON.stringify({ data: { repository: { pullRequest: { stackEntry: entry, stack } } } }) });
  const gql = [["gh", "api", "graphql"]] as const;

  test("maps entries bottom first with the PR's own position", async () => {
    const nodes = [
      { position: 2, pullRequest: { number: 11, title: "second", state: "OPEN", isDraft: true, statusCheckRollup: { state: "FAILURE" } } },
      { position: 1, pullRequest: { number: 10, title: "first", state: "MERGED", isDraft: false, statusCheckRollup: null } },
    ];
    const { exec } = fake([[[...gql[0]], reply({ size: 2, entries: { nodes } }, { position: 2 })]]);
    expect(await nativeStack(exec, SLUG, 11)).toEqual({
      position: 2,
      entries: [
        { number: 10, position: 1, state: "MERGED", title: "first", isDraft: false, checks: "none" },
        { number: 11, position: 2, state: "OPEN", title: "second", isDraft: true, checks: "fail" },
      ],
    });
  });

  test("null when the PR has no stack or the stack has a single PR", async () => {
    expect(await nativeStack(fake([[[...gql[0]], reply(null, null)]]).exec, SLUG, 1)).toBeNull();
    const one = reply({ size: 1, entries: { nodes: [{ position: 1, pullRequest: { number: 1, title: "t", state: "OPEN", isDraft: false } }] } }, { position: 1 });
    expect(await nativeStack(fake([[[...gql[0]], one]]).exec, SLUG, 1)).toBeNull();
  });
});

describe("retarget / trunk", () => {
  test("retarget argv", async () => {
    const { exec, calls } = fake([[["gh", "pr", "edit"], {}]]);
    await retargetPr(exec, "/repo", 7, "main");
    expect(calls[0]!.argv).toEqual(["gh", "pr", "edit", "7", "--base", "main"]);
  });

  test("retarget of a native stack member explains the GitHub refusal", async () => {
    const { exec } = fake([[["gh", "pr", "edit"], { code: 1, stderr: "GraphQL: Cannot change the base branch because the pull request is part of a stack. (updatePullRequest)" }]]);
    await expect(retargetPr(exec, "/repo", 7, "main")).rejects.toThrow("GitHub doesn't allow changing the base of a stacked PR; use Rebase stack.");
  });

  test("updateBranch: PUT update-branch with expected_head_sha on stdin", async () => {
    const { exec, calls } = fake([[["gh", "api", "-i", "-X", "PUT"], { stdout: 'HTTP/2.0 202 Accepted\r\n\r\n{"message":"Updating pull request branch."}' }]]);
    await updateBranch(exec, SLUG, 7, "abc123");
    expect(calls[0]!.argv).toEqual(["gh", "api", "-i", "-X", "PUT", "repos/o/r/pulls/7/update-branch", "--input", "-"]);
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ expected_head_sha: "abc123" });
  });

  test("updateBranch: a moved head (422) throws", async () => {
    const { exec } = fake([[["gh", "api", "-i"], { code: 1, stdout: 'HTTP/2.0 422 Unprocessable Entity\r\n\r\n{"message":"expected head sha didn\'t match"}' }]]);
    await expect(updateBranch(exec, SLUG, 7, "old")).rejects.toThrow(/expected head sha/);
  });

  test("behindBy reads behind_by from the compare call", async () => {
    const { exec, calls } = fake([[["gh", "api", "-i"], { stdout: 'HTTP/2.0 200 OK\r\n\r\n{"behind_by":4,"ahead_by":1}' }]]);
    expect(await behindBy(exec, SLUG, "feat/base", "feat/head")).toBe(4);
    expect(calls[0]!.argv.at(-1)).toBe("repos/o/r/compare/feat%2Fbase...feat%2Fhead");
  });

  test("trunkFor", async () => {
    const { exec } = fake([[["gh", "repo", "view"], { stdout: '{"defaultBranchRef":{"name":"develop"}}' }]]);
    expect(await trunkFor(exec, "/repo")).toBe("develop");
  });
});

describe("submitReview", () => {
  test("posts JSON on stdin via --input -", async () => {
    const { exec, calls } = fake([[["gh", "api"], {}]]);
    await submitReview(exec, "/repo", 9, {
      event: "REQUEST_CHANGES",
      body: "fix it",
      comments: [{ path: "a.ts", line: 3, body: "nit" }],
    });
    expect(calls[0]!.argv).toEqual([
      "gh", "api", "--method", "POST", "repos/{owner}/{repo}/pulls/9/reviews", "--input", "-",
    ]);
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({
      event: "REQUEST_CHANGES",
      body: "fix it",
      comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "nit" }],
    });
  });

  test("omits comments when none", async () => {
    const { exec, calls } = fake([[["gh", "api"], {}]]);
    await submitReview(exec, "/repo", 9, { event: "APPROVE", body: "" });
    expect(JSON.parse(calls[0]!.stdin!)).toEqual({ event: "APPROVE", body: "" });
  });
});

describe("waitChecks", () => {
  test("polls until nothing is pending, tolerating nonzero exit", async () => {
    const replies: Reply[] = [
      { code: 8, stdout: '[{"name":"ci","state":"IN_PROGRESS","bucket":"pending"}]' },
      { code: 1, stdout: '[{"name":"ci","state":"FAILURE","bucket":"fail"},{"name":"s","state":"SKIPPED","bucket":"skipping"}]' },
    ];
    const { exec, calls } = fake([[["gh", "pr", "checks"], () => replies.shift()!]]);
    let t = 0;
    const sleeps: number[] = [];
    const checks = await waitChecks(exec, "/repo", 3, {
      timeoutMs: 60_000,
      now: () => t,
      sleep: async (ms) => { sleeps.push(ms); t += ms; },
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.argv).toEqual(["gh", "pr", "checks", "3", "--json", "name,state,bucket"]);
    expect(sleeps).toEqual([15_000]);
    expect(checks.map((c) => [c.name, c.state])).toEqual([["ci", "fail"], ["s", "skipped"]]);
  });

  test("times out", async () => {
    const { exec } = fake([[["gh", "pr", "checks"], { code: 8, stdout: '[{"name":"ci","state":"QUEUED","bucket":"pending"}]' }]]);
    let t = 0;
    const err = await waitChecks(exec, "/repo", 3, {
      timeoutMs: 20_000,
      now: () => t,
      sleep: async (ms) => { t += ms; },
    }).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.code).toBe("gh-failed");
  });

  test("no checks reported returns empty", async () => {
    const { exec } = fake([[["gh", "pr", "checks"], { code: 1, stderr: "no checks reported on the 'x' branch" }]]);
    expect(await waitChecks(exec, "/repo", 3, { timeoutMs: 1000 })).toEqual([]);
  });

  test("optional green checks cannot finish before the required context registers on the new head", async () => {
    const replies: Reply[] = [
      { stdout: '[{"name":"lint","bucket":"pass"}]' },
      { code: 8, stdout: '[{"name":"test","workflow":"Depot PR tests","bucket":"pending"}]' },
      { stdout: '[{"name":"test","workflow":"Depot PR tests","bucket":"pass"}]' },
    ];
    const { exec, calls } = fake([
      [["gh", "pr", "checks"], () => replies.shift()!],
      [["gh", "pr", "view", "3", "--json", "headRefOid"], { stdout: '{"headRefOid":"new"}' }],
    ]);
    let t = 0;
    const checks = await waitChecks(exec, "/repo", 3, {
      timeoutMs: 60_000, expectedHeadSha: "new", requiredChecks: ["Depot PR tests / test"],
      now: () => t, sleep: async (ms) => { t += ms; },
    });
    expect(t).toBe(30_000);
    expect(checks.map((c) => c.state)).toEqual(["pass"]);
    expect(calls.filter((c) => c.argv[2] === "checks")).toHaveLength(3);
  });

  test("empty and skipped-only required checks time out rather than count as passing", async () => {
    for (const reply of [
      { code: 1, stderr: "no checks reported on this branch" },
      { stdout: '[{"name":"ci","bucket":"skipping"}]' },
    ]) {
      const { exec } = fake([[["gh", "pr", "checks"], reply]]);
      let t = 0;
      await expect(waitChecks(exec, "/repo", 3, {
        timeoutMs: 20_000, requiredChecks: ["ci"], now: () => t, sleep: async (ms) => { t += ms; },
      })).rejects.toThrow("timed out waiting for checks");
      expect(t).toBe(15_000);
    }
  });

  test("old-head green checks cannot satisfy a post-push wait", async () => {
    const { exec } = fake([
      [["gh", "pr", "checks"], { stdout: '[{"name":"ci","bucket":"pass"}]' }],
      [["gh", "pr", "view", "3", "--json", "headRefOid"], { stdout: '{"headRefOid":"old"}' }],
    ]);
    let t = 0;
    await expect(waitChecks(exec, "/repo", 3, {
      timeoutMs: 20_000, expectedHeadSha: "new", requiredChecks: ["ci"],
      now: () => t, sleep: async (ms) => { t += ms; },
    })).rejects.toThrow("timed out waiting for checks");
  });
});

describe("discussion", () => {
  const repoView = [["gh", "repo", "view", "--json", "owner,name"], { stdout: '{"owner":{"login":"o"},"name":"r"}' }] as [string[], Reply];
  const actor = (login: string, bot = false) => ({ login, __typename: bot ? "Bot" : "User" });
  const page = <T>(nodes: T[], next: string | null = null) => ({ pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes });
  const empty = page<never>([]);
  const pr = (p: { reviewThreads?: unknown; reviews?: unknown; comments?: unknown }) =>
    JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: empty, reviews: empty, comments: empty, ...p } } } });

  test("maps bots, outdated, urls; keeps every comment and non-empty review", async () => {
    const { exec } = fake([repoView, [["gh", "api", "graphql"], { stdout: await fx("discussion-single-pr.json") }]]);
    const d = await prDiscussion(exec, "/repo", 102);
    expect(d.conversation.every((e) => !e.minimized)).toBe(true);
    // sorted by time; the empty-body-free fixture keeps both reviews and issue comments
    expect(d.conversation.map((e) => [e.kind, e.author, e.isBot])).toEqual([
      ["comment", "chatgpt-codex-connector", true],
      ["review", "cursor", true],
      ["review", "devin-ai-integration", true],
      ["comment", "linear-code", true],
    ]);
  });

  test("multi-bot fixture: bugbot/codex/devin threads carry isBot, isOutdated and urls", async () => {
    const { exec } = fake([repoView, [["gh", "api", "graphql"], { stdout: await fx("discussion-multi-bot.json") }]]);
    const d = await prDiscussion(exec, "/repo", 101);
    expect(d.threads.length).toBe(4);
    for (const t of d.threads) {
      expect(typeof t.isOutdated).toBe("boolean");
      expect(t.comments[0]!.isBot).toBe(true);
      for (const c of t.comments) {
        expect(c.url).toStartWith("https://github.com/");
      }
    }
    expect(d.threads.map((t) => t.comments[0]!.author)).toContain("cursor");
    expect(d.conversation.every((e) => e.body.trim() !== "")).toBe(true);
    expect(d.conversation.every((e) => Date.parse(e.createdAt) >= 0)).toBe(true);
    const times = d.conversation.map((e) => Date.parse(e.createdAt));
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  test("maps resolvedBy, startLine, diffHunk (first comment) and mine", () => {
    const c = (login: string, hunk: string, mine = false) => ({ author: actor(login), body: "b", createdAt: "2026-01-01T00:00:00Z", url: "u", diffHunk: hunk, viewerDidAuthor: mine });
    const d = mapDiscussion({
      reviewThreads: page([
        { id: "T1", isResolved: true, isOutdated: false, path: "a.ts", line: 5, startLine: 4, resolvedBy: { login: "me" }, comments: page([c("devin", "@@ H1"), c("me", "@@ H2", true)]) },
        { id: "T2", isResolved: false, isOutdated: true, path: null, line: null, startLine: 3, comments: page([c("x", "@@ H3")]) },
      ]),
      reviews: empty,
      comments: empty,
    });
    expect(d.threads.map((t) => [t.resolvedBy, t.diffHunk, t.startLine, t.comments.map((x) => x.mine)])).toEqual([
      ["me", "@@ H1", 4, [false, true]],
      [null, "@@ H3", null, [false]],
    ]);
  });

  test("review entries carry the status of the threads their findings opened", () => {
    const c = (rid: string | null) => ({ author: actor("cursor[bot]"), body: "b", createdAt: "2026-01-01T00:00:00Z", url: "u", pullRequestReview: rid ? { id: rid } : null });
    const th = (id: string, rid: string | null, isResolved: boolean, isOutdated = false) => ({ id, isResolved, isOutdated, path: "a.ts", line: 1, comments: page([c(rid)]) });
    const rv = (id: string, url: string) => ({ id, author: actor("cursor[bot]"), state: "COMMENTED", body: "found issues", submittedAt: "2026-01-02T00:00:00Z", url });
    const d = mapDiscussion({
      reviewThreads: page([th("T1", "R1", true), th("T2", "R1", false), th("T3", "R1", false, true), th("T4", "R2", true), th("T5", null, false)]),
      reviews: page([rv("R1", "r1"), rv("R2", "r2"), rv("R3", "r3")]),
      comments: empty,
    });
    const f = (url: string) => d.conversation.find((e) => e.id === url)!.findings;
    expect(f("r1")).toEqual({ total: 3, open: 1, resolved: 1, outdated: 1, threadIds: ["T1", "T2", "T3"] });
    expect(f("r2")).toEqual({ total: 1, open: 0, resolved: 1, outdated: 0, threadIds: ["T4"] });
    expect(f("r3")).toBeUndefined();
  });

  test("minimized comments are kept and flagged; empty reviews survive only with a meaningful state; [bot] logins are bots", () => {
    const d = mapDiscussion({
      reviewThreads: empty,
      reviews: page([
        { author: actor("a"), state: "APPROVED", body: "  ", submittedAt: "2026-01-01T00:00:00Z", url: "r1" },
        { author: actor("b"), state: "CHANGES_REQUESTED", body: "fix it", submittedAt: "2026-01-02T00:00:00Z", url: "r2" },
        { author: actor("c"), state: "COMMENTED", body: "", submittedAt: "2026-01-02T01:00:00Z", url: "r3" },
      ]),
      comments: page([
        { author: actor("x[bot]"), body: "hidden", createdAt: "2026-01-01T12:00:00Z", url: "c1", isMinimized: true, minimizedReason: "OUTDATED" },
        { author: actor("x[bot]"), body: "shown", createdAt: "2026-01-03T00:00:00Z", url: "c2", isMinimized: false },
      ]),
    });
    expect(d.conversation.map((e) => [e.id, e.kind, e.state, e.isBot, e.minimized, e.minimizedReason])).toEqual([
      ["r1", "review", "APPROVED", false, false, undefined],
      ["c1", "comment", undefined, true, true, "outdated"],
      ["r2", "review", "CHANGES_REQUESTED", false, false, undefined],
      ["c2", "comment", undefined, true, false, undefined],
    ]);
  });

  test("paginates threads, reviews and comments, and overflowing thread comments", async () => {
    const th = (id: string, comments: unknown) => ({ id, isResolved: false, isOutdated: id === "T2", path: "a.ts", line: 1, comments });
    const c = (body: string) => ({ author: actor("u"), body, createdAt: "2026-01-01T00:00:00Z", url: `u/${body}` });
    const rv = (n: number) => ({ author: actor("u"), state: "COMMENTED", body: `r${n}`, submittedAt: `2026-01-0${n}T00:00:00Z`, url: `rv${n}` });
    const ic = (n: number) => ({ author: actor("u"), body: `i${n}`, createdAt: `2026-02-0${n}T00:00:00Z`, url: `ic${n}`, isMinimized: false });
    const queries: string[][] = [];
    const exec: Exec = async (argv) => {
      const a = [...argv];
      if (a[1] === "repo") return { code: 0, stdout: '{"owner":{"login":"o"},"name":"r"}', stderr: "" };
      queries.push(a);
      const has = (kv: string) => a.includes(kv);
      let out: unknown;
      if (a.some((x) => x.startsWith("id=T1"))) {
        out = { data: { node: { comments: page([c("t1-b")]) } } };
      } else if (!has("tc=T-1") && !has("rc=R-1") && !has("cc=C-1")) {
        out = { data: { repository: { pullRequest: {
          reviewThreads: page([th("T1", page([c("t1-a")], "TC-1"))], "T-1"),
          reviews: page([rv(1)], "R-1"),
          comments: page([ic(1)], "C-1"),
        } } } };
      } else {
        expect(has("tc=T-1") && has("rc=R-1") && has("cc=C-1")).toBe(true);
        out = { data: { repository: { pullRequest: {
          reviewThreads: page([th("T2", page([c("t2-a")]))]),
          reviews: page([rv(2)]),
          comments: page([ic(2)]),
        } } } };
      }
      return { code: 0, stdout: JSON.stringify(out), stderr: "" };
    };
    const d = await prDiscussion(exec, "/repo", 7);
    expect(d.threads.map((t) => [t.id, t.isOutdated, t.comments.map((x) => x.body)])).toEqual([
      ["T1", false, ["t1-a", "t1-b"]],
      ["T2", true, ["t2-a"]],
    ]);
    expect(d.conversation.map((e) => e.id)).toEqual(["rv1", "rv2", "ic1", "ic2"]);
    expect(queries.filter((q) => q.some((x) => x.startsWith("n=7"))).length).toBe(2);
  });
});

describe("PR state mutations", () => {
  const SLUG = { owner: "o", name: "r" };
  const recorder = (reply: (argv: readonly string[]) => { code?: number; stdout?: string; stderr?: string } = () => ({})) => {
    const calls: { argv: string[]; cwd?: string }[] = [];
    const exec: Exec = async (argv, opts) => {
      calls.push({ argv: [...argv], ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}) });
      const r = reply(argv);
      return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };
    return { exec, calls };
  };

  test("close, reopen, ready, draft argv (checkout and slug)", async () => {
    const f = recorder();
    await closePr(f.exec, "/w", 5);
    await reopenPr(f.exec, "/w", 5);
    await markReady(f.exec, "/w", 5);
    await markReady(f.exec, "/w", 5, true);
    expect(f.calls.map((c) => c.argv)).toEqual([
      ["gh", "pr", "close", "5"],
      ["gh", "pr", "reopen", "5"],
      ["gh", "pr", "ready", "5"],
      ["gh", "pr", "ready", "5", "--undo"],
    ]);
    expect(f.calls.every((c) => c.cwd === "/w")).toBe(true);
    const g = recorder();
    await closePr(g.exec, SLUG, 5);
    await markReady(g.exec, SLUG, 5, true);
    expect(g.calls.map((c) => c.argv)).toEqual([
      ["gh", "pr", "close", "5", "-R", "o/r"],
      ["gh", "pr", "ready", "5", "--undo", "-R", "o/r"],
    ]);
  });

  const checks = JSON.stringify([
    { name: "a", bucket: "fail", link: "https://github.com/o/r/actions/runs/111/job/1" },
    { name: "b", bucket: "fail", link: "https://github.com/o/r/actions/runs/111/job/2" },
    { name: "c", bucket: "cancel", link: "https://github.com/o/r/actions/runs/222/job/3" },
    { name: "d", bucket: "pass", link: "https://github.com/o/r/actions/runs/333/job/4" },
    { name: "e", bucket: "fail", link: "https://example.com/external" },
  ]);

  test("rerunFailedChecks reruns each unique failing run once", async () => {
    const f = recorder((argv) => (argv[2] === "checks" ? { code: 1, stdout: checks } : {}));
    expect(await rerunFailedChecks(f.exec, SLUG, 7)).toEqual({ runs: [111, 222] });
    expect(f.calls.map((c) => c.argv)).toEqual([
      ["gh", "pr", "checks", "7", "--json", "name,bucket,link", "-R", "o/r"],
      ["gh", "run", "rerun", "111", "--failed", "-R", "o/r"],
      ["gh", "run", "rerun", "222", "--failed", "-R", "o/r"],
    ]);
    const g = recorder((argv) => (argv[2] === "checks" ? { stdout: checks } : {}));
    await rerunFailedChecks(g.exec, "/w", 7);
    expect(g.calls[1]!.argv).toEqual(["gh", "run", "rerun", "111", "--failed"]);
    expect(g.calls[1]!.cwd).toBe("/w");
  });

  test("no failing checks throws without rerunning", async () => {
    const f = recorder(() => ({ stdout: JSON.stringify([{ name: "d", bucket: "pass", link: "https://github.com/o/r/actions/runs/3/job/4" }]) }));
    const err = (await rerunFailedChecks(f.exec, "/w", 7).catch((e: unknown) => e)) as StkError;
    expect(err).toBeInstanceOf(StkError);
    expect(err.message).toBe("no failing checks to re-run");
    expect(f.calls).toHaveLength(1);
  });

  test("rate limit errors pass through", async () => {
    const f = recorder(() => ({ code: 1, stderr: "API rate limit exceeded for user" }));
    expect(((await closePr(f.exec, "/w", 1).catch((e: unknown) => e)) as StkError).code).toBe("rate-limited");
    expect(((await rerunFailedChecks(f.exec, "/w", 1).catch((e: unknown) => e)) as StkError).code).toBe("rate-limited");
  });
});

describe("closeAndReopenPr", () => {
  const SLUG = { owner: "o", name: "r" };
  const tls = { code: 1, stderr: 'Patch "https://api.github.com/repos/o/r/pulls/5": net/http: TLS handshake timeout' };
  /** A PR #5 that is open until a PATCH closes it; `close` answers the close, `reopens` the successive reopen attempts. */
  const prFake = (close: "ok" | "lost" | "rejected", reopens: ("ok" | "tls")[]) => {
    let state: "open" | "closed" = "open";
    const patches: string[] = [];
    const exec: Exec = async (argv, opts) => {
      if (argv.includes("PATCH")) {
        const want = JSON.parse(opts!.stdin!).state as string;
        patches.push(want);
        if (want === "closed") {
          if (close === "rejected") return { ...http(403, { message: "Forbidden" }), stderr: "" };
          state = "closed";
          return close === "lost" ? { code: 1, stdout: "", stderr: tls.stderr } : { ...http(200, {}), stderr: "" };
        }
        if (reopens.shift() === "tls") return { code: 1, stdout: "", stderr: tls.stderr };
        state = "open";
        return { ...http(200, {}), stderr: "" };
      }
      return { ...http(200, { state, merged: false }), stderr: "" };
    };
    return { exec, patches };
  };
  const sleeps: number[] = [];
  const sleep = async (ms: number) => void sleeps.push(ms);

  test("a close whose response was lost (but applied) is still followed by the reopen", async () => {
    const { exec, patches } = prFake("lost", ["ok"]);
    await closeAndReopenPr(exec, SLUG, 5, sleep, 10);
    expect(patches).toEqual(["closed", "open"]);
  });

  test("a reopen that fails transiently is retried until it works", async () => {
    const { exec, patches } = prFake("ok", ["tls", "tls", "ok"]);
    await closeAndReopenPr(exec, SLUG, 5, sleep, 10);
    expect(patches).toEqual(["closed", "open", "open", "open"]);
  });

  test("a reopen that keeps failing ends with a loud message naming the PR as closed and its URL", async () => {
    const { exec, patches } = prFake("ok", ["tls", "tls", "tls", "tls", "tls"]);
    const err = await closeAndReopenPr(exec, SLUG, 5, sleep, 10).catch((e) => e);
    expect(err).toBeInstanceOf(StkError);
    expect(err.message).toContain("#5 is CLOSED");
    expect(err.message).toContain("https://github.com/o/r/pull/5");
    expect(patches).toEqual(["closed", "open", "open", "open", "open"]);
  });

  test("a close that was rejected (the PR still reads as open) throws that error and never reopens", async () => {
    const { exec, patches } = prFake("rejected", []);
    const err = await closeAndReopenPr(exec, SLUG, 5, sleep, 10).catch((e) => e);
    expect(err.message).toContain("closing #5 failed");
    expect(patches).toEqual(["closed"]);
  });
});

