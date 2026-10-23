import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearRulesCache, merge, slugCtx, stackInfo, stackMerge } from "../src/service";
import { StkError, type Exec } from "../src/types";

const SLUG = { owner: "o", name: "r" };
const ok = (body: unknown) => ({ code: 0, stdout: JSON.stringify(body), stderr: "" });
const http = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`, stderr: "" });
const pending = { __typename: "CheckRun", name: "optional-ci", status: "IN_PROGRESS", conclusion: null };
const failing = { __typename: "CheckRun", name: "optional-ci", status: "COMPLETED", conclusion: "FAILURE" };

/** Exercise service policy and the real merge-async serializer, without GitHub calls. */
function world(o: { queue?: boolean; required?: string[]; pr?: Record<string, unknown>; threads?: number; native?: boolean } = {}) {
  const calls: string[][] = [];
  const puts: Record<string, unknown>[] = [];
  const member = (n: number, base: string) => ({
    number: n, title: `PR ${n}`, url: "u", author: { login: "a" }, state: "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: base, headRefOid: `sha${n}`, mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: [], createdAt: "", updatedAt: "",
    ...o.pr,
  });
  const exec: Exec = async (argv, opts) => {
    calls.push([...argv]);
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry") && o.native) {
      const nodes = [member(7, "main"), member(8, "b7")].map((pr, i) => ({
        position: i + 1,
        pullRequest: { ...pr, statusCheckRollup: { contexts: { nodes: pr.statusCheckRollup } }, reviewThreads: { nodes: [] } },
      }));
      return ok({ data: { repository: { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 2 }, stack: { size: 2, entries: { nodes } } } } } });
    }
    if (argv.includes("defaultBranchRef")) return ok({ defaultBranchRef: { name: "main" } });
    if (argv[1] === "pr" && argv[2] === "view") return ok(member(7, "main"));
    if (query) return ok({ data: { repository: { pr7: { reviewThreads: { nodes: Array.from({ length: o.threads ?? 0 }, () => ({ isResolved: false })) } } } } });
    if (argv.includes("PUT")) {
      puts.push(JSON.parse(opts?.stdin ?? "{}"));
      return http({ status: "enqueued", details: { uuid: "queue-1" } });
    }
    const url = argv.at(-1)!;
    if (url === "repos/o/r") return http({ allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true });
    if (url === "repos/o/r/rules/branches/main") return http([
      ...(o.queue === false ? [] : [{ type: "merge_queue", parameters: { merge_method: "SQUASH" } }]),
      ...(o.required?.length ? [{ type: "required_status_checks", parameters: { required_status_checks: o.required.map((context) => ({ context })) } }] : []),
    ]);
    return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  };
  return { ctx: slugCtx(exec, SLUG), calls, puts };
}

beforeEach(() => clearRulesCache());
afterEach(() => clearRulesCache());

describe("service merge queues", () => {
  for (const [name, pr, required] of [
    ["pending PR checks", { statusCheckRollup: [pending] }, []],
    ["failing PR checks", { statusCheckRollup: [failing] }, []],
    ["a missing required check", {}, ["queue-ci"]],
    ["an unexplained BLOCKED state", { mergeStateStatus: "BLOCKED" }, []],
    ["mergeability still checking", { mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }, []],
    ["pending checks and missing required checks on a BLOCKED PR", { statusCheckRollup: [pending], mergeStateStatus: "BLOCKED" }, ["queue-ci"]],
  ] as const) {
    test(`enqueues despite ${name}`, async () => {
      const { ctx, puts } = world({ pr: { ...pr }, required: [...required] });
      const result = await merge(ctx, 7, { method: "rebase", explicitMethod: true, force: false });
      expect(result).toMatchObject({ number: 7, method: "squash", admin: false, bypassed: [], status: "enqueued" });
      // Queue requests cannot carry custom method, pinned SHA or bypass parameters.
      expect(puts).toEqual([{}]);
    });
  }

  test("dry-run blockers only show what prevents enqueueing", async () => {
    const { ctx, puts } = world({ required: ["queue-ci"], pr: { statusCheckRollup: [pending], mergeStateStatus: "BLOCKED" } });
    expect(await merge(ctx, 7, { method: "merge", force: false, dryRun: true })).toMatchObject({
      wouldMerge: true, method: "squash", admin: false, bypass: [], blockers: [],
    });
    expect(puts).toEqual([]);
  });

  test("force fails clearly before any merge request or method settlement", async () => {
    const { ctx, calls, puts } = world();
    const error = await merge(ctx, 7, { method: "rebase", force: true }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(StkError);
    expect(error).toMatchObject({ code: "blocked" });
    expect((error as Error).message).toContain("merge queue");
    expect((error as Error).message).toContain("--force");
    expect((error as Error).message).toContain("run without --force to enqueue");
    expect(puts).toEqual([]);
    expect(calls.some((argv) => argv.at(-1) === "repos/o/r")).toBe(false);
  });

  test("force dry-run is not mergeable and explains the queue restriction", async () => {
    const { ctx, puts } = world();
    const result = await merge(ctx, 7, { method: "rebase", force: true, dryRun: true });
    expect(result).toMatchObject({ wouldMerge: false, method: "squash", admin: false, bypass: [], blockers: [{ kind: "blocked" }] });
    expect(result.note).toContain("merge queue");
    expect(result.note).toContain("--force");
    expect(puts).toEqual([]);
  });

  for (const [kind, pr, threads] of [
    ["conflict", { mergeable: "CONFLICTING" }, 0],
    ["draft", { isDraft: true }, 0],
    ["review", { reviewDecision: "REVIEW_REQUIRED" }, 0],
    ["threads", {}, 1],
    ["behind", { mergeStateStatus: "BEHIND" }, 0],
  ] as const) {
    test(`${kind} still blocks a queue request`, async () => {
      const { ctx, puts } = world({ pr: { ...pr }, threads });
      const preview = await merge(ctx, 7, { method: "rebase", force: false, dryRun: true });
      expect(preview.wouldMerge).toBe(false);
      expect(preview.blockers.map((b) => b.kind)).toContain(kind);
      await expect(merge(ctx, 7, { method: "rebase", force: false })).rejects.toMatchObject({ code: "blocked" });
      expect(puts).toEqual([]);
    });
  }

  test("non-queue checks still block and force retains its custom payload", async () => {
    const { ctx, puts } = world({ queue: false, pr: { statusCheckRollup: [pending] } });
    await expect(merge(ctx, 7, { method: "rebase", force: false })).rejects.toMatchObject({ code: "blocked" });
    expect(puts).toEqual([]);
    const result = await merge(ctx, 7, { method: "rebase", force: true });
    expect(result).toMatchObject({ method: "rebase", admin: true, bypassed: [{ kind: "checks", failing: [], pending: ["optional-ci"] }] });
    expect(puts).toEqual([{ merge_method: "rebase", sha: "sha7", bypass_rules: true }]);
  });

  test("stack preview and execution use the queue method and no custom merge parameters", async () => {
    const { ctx, puts } = world({ native: true, required: ["queue-ci"], pr: { statusCheckRollup: [pending] } });
    const preview = await stackInfo(ctx, 8, { method: "merge", explicitMethod: true, force: true });
    expect(preview.method).toBe("squash");
    expect(preview.plan.filter((s) => s.kind === "merge")).toEqual([
      expect.objectContaining({ method: "squash", admin: false, bypass: [] }),
    ]);
    const result = await stackMerge(ctx, 8, { method: "merge", explicitMethod: true, force: true });
    expect(puts).toEqual([{}]);
    expect(result.results).toEqual([expect.objectContaining({ ok: true, enqueued: true })]);
  });
});
