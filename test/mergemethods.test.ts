import { afterEach, describe, expect, test } from "bun:test";
import { branchRules, repoMergeMethods } from "../src/github";
import { effectiveMethod, fallbackNote, nextMethod } from "../src/methods";
import { allowedMethodsFor, clearRulesCache, merge, settleMethod, slugCtx, stackInfo, stackMerge } from "../src/service";
import { planStackMerge } from "../src/stack";
import { mergeOutcomeText } from "../src/types";
import { Store, mergeMethodNote, mergeMethodOf } from "../src/tui/store";
import type { Exec, MergeMethod, PlanStep, PullRequest, Stack } from "../src/types";

const SLUG = { owner: "o", name: "r" };
const ok = (body: unknown) => ({ code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(body)}`, stderr: "" });
const fail = { code: 1, stdout: `HTTP/2.0 500 Server Error\r\n\r\n{"message":"boom"}`, stderr: "" };

/** Fake GitHub for the settings + ruleset reads of one repo; null makes that read fail. */
function github(o: { settings?: Record<string, boolean> | null; rules?: unknown[] | null }): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const url = argv.at(-1)!;
    if (url === "repos/o/r") return o.settings === null ? fail : ok({ allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true, ...o.settings });
    if (url.startsWith("repos/o/r/rules/branches/")) return o.rules === null ? fail : ok(o.rules ?? []);
    return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  };
  return { exec, calls };
}
const SQUASH_REBASE_RULE = [{ type: "pull_request", parameters: { allowed_merge_methods: ["squash", "rebase"] } }];

afterEach(() => clearRulesCache());

describe("reading the allowed methods", () => {
  test("a ruleset's allowed_merge_methods is parsed from the rules call", async () => {
    const { exec } = github({ rules: SQUASH_REBASE_RULE });
    expect((await branchRules(exec, SLUG, "dev")).allowedMergeMethods).toEqual(["squash", "rebase"]);
    expect((await branchRules(github({ rules: [{ type: "pull_request", parameters: {} }] }).exec, SLUG, "dev")).allowedMergeMethods).toBeUndefined();
  });

  test("repo settings map to methods", async () => {
    expect(await repoMergeMethods(github({ settings: { allow_merge_commit: false } }).exec, SLUG)).toEqual(["squash", "rebase"]);
  });

  test("repo settings and the ruleset intersect; cached per repo and branch", async () => {
    const { exec, calls } = github({ settings: { allow_rebase_merge: false }, rules: SQUASH_REBASE_RULE });
    expect(await allowedMethodsFor(exec, SLUG, "dev")).toEqual(["squash"]);
    await allowedMethodsFor(exec, SLUG, "dev");
    expect(calls).toHaveLength(2);
  });

  test("a ruleset alone narrows an unrestricted repo (core: squash and rebase on dev)", async () => {
    expect(await allowedMethodsFor(github({ rules: SQUASH_REBASE_RULE }).exec, SLUG, "dev")).toEqual(["squash", "rebase"]);
  });

  test("an unreadable read falls back to the other one, and to null when both fail", async () => {
    expect(await allowedMethodsFor(github({ settings: null, rules: SQUASH_REBASE_RULE }).exec, SLUG, "dev")).toEqual(["squash", "rebase"]);
    clearRulesCache();
    expect(await allowedMethodsFor(github({ settings: { allow_squash_merge: false }, rules: null }).exec, SLUG, "dev")).toEqual(["merge", "rebase"]);
    clearRulesCache();
    expect(await allowedMethodsFor(github({ settings: null, rules: null }).exec, SLUG, "dev")).toBeNull();
  });
});

describe("effective method", () => {
  const allowed: MergeMethod[] = ["squash", "rebase"];

  test("the remembered method when allowed or when the allowed set is unknown", () => {
    expect(effectiveMethod("rebase", allowed)).toBe("rebase");
    expect(effectiveMethod("merge", null)).toBe("merge");
    expect(effectiveMethod(undefined, undefined)).toBe("squash");
  });

  test("a disallowed remembered method falls back to the first allowed of squash, rebase, merge", () => {
    expect(effectiveMethod("merge", allowed)).toBe("squash");
    expect(effectiveMethod("squash", ["rebase", "merge"])).toBe("rebase");
    expect(effectiveMethod("squash", ["merge"])).toBe("merge");
  });

  test("cycling skips disallowed methods", () => {
    expect(nextMethod("squash", allowed)).toBe("rebase");
    expect(nextMethod("rebase", allowed)).toBe("squash");
    expect(nextMethod("squash", ["squash"])).toBe("squash");
    expect(nextMethod("squash", null)).toBe("merge");
  });

  test("the note names what the remembered method lacks", () => {
    expect(fallbackNote("merge", allowed, "dev")).toBe("merge commits not allowed on dev");
    expect(fallbackNote("squash", allowed, "dev")).toBeNull();
    expect(fallbackNote("merge", null, "dev")).toBeNull();
  });
});

describe("Store with a restricted trunk", () => {
  const repo = { owner: "Acme", name: "Web" };
  type Poke = { set(p: object): void; prefetchBudget: number; prefetchWindowAt: number; loadMergeMethods(r: unknown, b: string): Promise<void> };
  const detail = (baseRef: string) => ({ status: "ready", refreshing: false, at: Date.now(), data: { pr: { baseRef, number: 5 }, stack: null } });
  const board = (trunk: string) => ({ status: "ready", refreshing: false, data: { repo, trunk, prs: [] } });
  function restricted() {
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    store.setMergeMethod(repo, "merge");
    (store as unknown as Poke).set({
      boards: { mine: board("dev") },
      mergeMethods: { "acme/web@dev": { branch: "dev", allowed: ["squash", "rebase"] } },
    });
    return store;
  }

  test("a remembered method the trunk rejects falls back, with a note for the sheets", () => {
    const store = restricted();
    expect(mergeMethodOf(store.getState())).toBe("squash");
    expect(mergeMethodNote(store.getState())).toBe("merge commits not allowed on dev");
  });

  test("t cycles only through the allowed methods", () => {
    const store = restricted();
    store.cycleMergeMethod();
    expect(mergeMethodOf(store.getState())).toBe("rebase");
    store.cycleMergeMethod();
    expect(mergeMethodOf(store.getState())).toBe("squash");
    expect(mergeMethodNote(store.getState())).toBeNull();
  });

  test("allowed methods are kept per branch: the open PR's base picks its own entry and one read never overwrites another", () => {
    const store = restricted();
    const poke = store as unknown as Poke;
    poke.set({
      mergeMethods: { ...store.getState().mergeMethods, "acme/web@release": { branch: "release", allowed: ["squash", "merge", "rebase"] } },
      screen: { kind: "pr", n: 5, repo, scope: "mine" },
      prCache: { "Acme/Web#5": detail("release") },
    });
    expect(mergeMethodOf(store.getState())).toBe("merge");
    poke.set({ prCache: { "Acme/Web#5": detail("dev") } });
    expect(mergeMethodOf(store.getState())).toBe("squash");
    expect(Object.keys(store.getState().mergeMethods).sort()).toEqual(["acme/web@dev", "acme/web@release"]);
  });

  test("a board row's base picks the entry too (workspace and session boards)", () => {
    const store = restricted();
    const row = { number: 9, baseRef: "release", repo, state: "OPEN" };
    (store as unknown as Poke).set({
      boards: { mine: { status: "ready", refreshing: false, data: { prs: [row] } } },
      mergeMethods: { "acme/web@release": { branch: "release", allowed: ["squash", "merge"] }, "acme/web@dev": { branch: "dev", allowed: ["rebase"] } },
      boardCursor: "Acme/Web#9",
    });
    expect(mergeMethodOf(store.getState())).toBe("merge");
  });

  test("allowed methods are read for every distinct (repo, base) of a loaded board, and for a PR page served from cache", async () => {
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    const poke = store as unknown as Poke;
    poke.prefetchBudget = 0; // no detail warming here
    poke.prefetchWindowAt = Date.now();
    const loads: string[] = [];
    poke.loadMergeMethods = async (r, b) => void loads.push(`${(r as { owner: string; name: string }).name}@${b}`);
    const rows = [
      { number: 1, state: "OPEN", baseRef: "main", updatedAt: "", headRef: "a", repo: { owner: "o", name: "x" } },
      { number: 2, state: "OPEN", baseRef: "main", updatedAt: "", headRef: "b", repo: { owner: "o", name: "x" } },
      { number: 3, state: "OPEN", baseRef: "dev", updatedAt: "", headRef: "c", repo: { owner: "o", name: "y" } },
      { number: 4, state: "MERGED", baseRef: "gone", updatedAt: "", headRef: "d", repo: { owner: "o", name: "y" } },
    ];
    (store as unknown as { prefetchBoard(r: null, p: unknown[]): void }).prefetchBoard(null, rows);
    expect(loads).toEqual(["x@main", "y@dev"]);

    loads.length = 0;
    poke.set({ prCache: { "Acme/Web#5": detail("release") } });
    await store.loadPr(5, { repo });
    expect(loads).toEqual(["Web@release"]);
  });

  test("a stack plans with the effective method", () => {
    const store = restricted();
    const method = mergeMethodOf(store.getState());
    const pr = (number: number, headRef: string, baseRef: string): PullRequest => ({
      number, title: "t", url: "", author: "a", state: "OPEN", isDraft: false, headRef, baseRef, headSha: `sha${number}`, mergeable: "MERGEABLE",
      reviewDecision: "APPROVED", checks: [], unresolvedThreads: 0, body: "", worktree: null, createdAt: "", updatedAt: "",
    });
    const stack: Stack = { trunk: "dev", prs: [pr(3351, "a", "dev"), pr(3356, "b", "a")] };
    const plan = planStackMerge(stack, { method, force: false, repoDir: "/x" }, []);
    const merges = plan.filter((s) => s.kind === "merge");
    expect(merges.length).toBeGreaterThan(0);
    expect(merges.every((s) => s.kind === "merge" && s.method === "squash")).toBe(true);
  });
});

/** Fake GitHub for merging PR #7 (clean, approved) into `base`, with per-branch rulesets; records merge-async bodies. */
function mergeWorld(o: { base: string; rules: Record<string, unknown[]> }) {
  const calls: string[][] = [];
  const puts: { method: string; url: string }[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push([...argv]);
    const url = argv.at(-1)!;
    if (argv.includes("defaultBranchRef")) return { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "" };
    if (argv[1] === "pr" && argv[2] === "view") {
      const pr = {
        number: 7, title: "t", url: "u", author: { login: "a" }, state: "OPEN", isDraft: false, headRefName: "h", baseRefName: o.base, headRefOid: "sha7",
        mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED", statusCheckRollup: [], createdAt: "", updatedAt: "",
      };
      return { code: 0, stdout: JSON.stringify(pr), stderr: "" };
    }
    if (argv.some((a) => a.startsWith("query="))) return { code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } }), stderr: "" };
    if (argv.includes("PUT")) {
      puts.push({ method: JSON.parse(opts?.stdin ?? "{}").merge_method, url });
      return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ status: "merged", details: { sha: "m1" } })}`, stderr: "" };
    }
    if (url === "repos/o/r") return ok({ allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: true });
    const branch = /^repos\/o\/r\/rules\/branches\/(.+)$/.exec(url)?.[1];
    if (branch) return ok(o.rules[branch] ?? []);
    return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  };
  return { ctx: slugCtx(exec, SLUG), calls, puts };
}

describe("the method is settled when the merge runs", () => {
  test("a remembered method the base rejects is swapped just before the PUT, and the result says so", async () => {
    const { ctx, puts } = mergeWorld({ base: "main", rules: { main: SQUASH_REBASE_RULE } });
    const r = await merge(ctx, 7, { method: "merge", force: false });
    expect(puts.map((p) => p.method)).toEqual(["squash"]);
    expect(r.method).toBe("squash");
    expect(r.note).toBe("merge commits not allowed on main; merged with squash instead");
  });

  test("an explicit method the base rejects fails before anything is sent, listing the allowed ones", async () => {
    const { ctx, puts } = mergeWorld({ base: "main", rules: { main: SQUASH_REBASE_RULE } });
    await expect(merge(ctx, 7, { method: "merge", explicitMethod: true, force: false })).rejects.toThrow("merge method 'merge' is not allowed on main; allowed: squash, rebase");
    expect(puts).toEqual([]);
  });

  test("an unreadable allowed set leaves the method alone", async () => {
    const { ctx, puts } = mergeWorld({ base: "main", rules: {} });
    const failing: Exec = async (argv, opts) => (/^repos\/o\/r(\/rules\/.*)?$/.test(argv.at(-1)!) ? fail : ctx.exec(argv, opts));
    await merge({ ...ctx, exec: failing }, 7, { method: "merge", force: false });
    expect(puts.map((p) => p.method)).toEqual(["merge"]);
  });

  test("the rules are read for the PR's own base, not the default branch", async () => {
    const { ctx, calls, puts } = mergeWorld({ base: "release", rules: { main: [], release: [{ type: "pull_request", parameters: { allowed_merge_methods: ["rebase"] } }] } });
    await expect(merge(ctx, 7, { method: "squash", explicitMethod: true, force: false })).rejects.toThrow("merge method 'squash' is not allowed on release; allowed: rebase");
    expect(calls.some((c) => c.at(-1) === "repos/o/r/rules/branches/release")).toBe(true);
    expect(puts).toEqual([]);
  });
});

describe("a stack settles its method against the stack trunk", () => {
  /** Two-PR native stack on `main`, both clean and approved; main's ruleset allows squash and rebase. */
  function stackWorld() {
    const puts: string[] = [];
    const member = (n: number, base: string) => ({
      number: n, title: `PR ${n}`, url: "u", author: { login: "me" }, state: "OPEN", isDraft: false, headRefName: `b${n}`, baseRefName: base, headRefOid: `sha${n}`,
      mergeable: "MERGEABLE", mergeStateStatus: "CLEAN", reviewDecision: "APPROVED",
      statusCheckRollup: { contexts: { nodes: [] } }, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
    });
    const exec: Exec = async (argv, opts) => {
      const query = argv.find((x) => x.startsWith("query=")) ?? "";
      if (query.includes("stackEntry")) {
        const nodes = [member(101, "main"), member(102, "b101")].map((pullRequest, i) => ({ position: i + 1, pullRequest }));
        const repository = { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 2 }, stack: { size: 2, entries: { nodes } } } };
        return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
      }
      if (argv.includes("PUT")) {
        puts.push(JSON.parse(opts?.stdin ?? "{}").merge_method);
        return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify({ status: "merged", details: { sha: "m1" } })}`, stderr: "" };
      }
      const url = argv.at(-1)!;
      if (url === "repos/o/r") return ok({});
      if (url === "repos/o/r/rules/branches/main") return ok(SQUASH_REBASE_RULE);
      return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
    };
    return { ctx: slugCtx(exec, SLUG), puts };
  }

  test("a remembered merge-commit stack plans and merges as squash", async () => {
    const { ctx, puts } = stackWorld();
    const plans: PlanStep[][] = [];
    const r = await stackMerge(ctx, 101, { method: "merge", force: false, upTo: 102, onPlan: (p) => plans.push(p) });
    expect(puts).toEqual(["squash"]);
    expect(r.note).toBe("merge commits not allowed on main; merged with squash instead");
    expect(plans.flat().every((s) => s.kind !== "merge" || s.method === "squash")).toBe(true);
  });

  test("an explicit method the trunk rejects fails before any merge", async () => {
    const { ctx, puts } = stackWorld();
    await expect(stackMerge(ctx, 101, { method: "merge", explicitMethod: true, force: false, upTo: 102 })).rejects.toThrow("allowed: squash, rebase");
    expect(puts).toEqual([]);
  });

  test("the preview (stackInfo) settles the method like --merge does and carries the note", async () => {
    const { ctx, puts } = stackWorld();
    const info = await stackInfo(ctx, 101, { method: "merge", force: false, upTo: 102 });
    expect(info.method).toBe("squash");
    expect(info.methodNote).toBe("merge commits not allowed on main; merged with squash instead");
    expect(info.plan.every((s) => s.kind !== "merge" || s.method === "squash")).toBe(true);
    expect(puts).toEqual([]);
  });

  test("the preview honours an explicit method: a disallowed one fails, an allowed one is kept", async () => {
    const { ctx } = stackWorld();
    await expect(stackInfo(ctx, 101, { method: "merge", explicitMethod: true, force: false, upTo: 102 })).rejects.toThrow("allowed: squash, rebase");
    const info = await stackInfo(ctx, 101, { method: "rebase", explicitMethod: true, force: false, upTo: 102 });
    expect(info.method).toBe("rebase");
    expect(info.methodNote).toBeUndefined();
  });
});

describe("settling reports what it did", () => {
  test("a dry run returns the settled method and the note", async () => {
    const { ctx, puts } = mergeWorld({ base: "main", rules: { main: SQUASH_REBASE_RULE } });
    const d = await merge(ctx, 7, { method: "merge", force: false, dryRun: true });
    expect(d.method).toBe("squash");
    expect(d.methodNote).toBe("merge commits not allowed on main; merged with squash instead");
    expect(puts).toEqual([]);
    const plain = await merge(ctx, 7, { method: "rebase", force: false, dryRun: true });
    expect(plain.method).toBe("rebase");
    expect(plain.methodNote).toBeUndefined();
  });

  test("the outcome text carries the job note", () => {
    const note = "merge commits not allowed on main; merged with squash instead";
    expect(mergeOutcomeText({ kind: "merge", pr: 7, outcome: "merged", merged: [7], note })).toBe(`Merged #7 · ${note}`);
    expect(mergeOutcomeText({ kind: "stack-merge", pr: 7, outcome: "merged", merged: [6, 7], note })).toBe(`Stack merged · #6, #7 · ${note}`);
    expect(mergeOutcomeText({ kind: "merge", pr: 7, outcome: "merged", merged: [7] })).toBe("Merged #7");
  });
});

describe("rate limits while settling", () => {
  const limited: Exec = async () => ({ code: 1, stdout: `HTTP/2.0 403 Forbidden\r\n\r\n{"message":"API rate limit exceeded"}`, stderr: "" });

  test("a rate limit escapes instead of being read as an unreadable set", async () => {
    await expect(settleMethod(slugCtx(limited, SLUG), "merge", "main", false)).rejects.toMatchObject({ code: "rate-limited" });
    clearRulesCache();
    await expect(settleMethod(slugCtx(limited, SLUG), "merge", "main", true)).rejects.toMatchObject({ code: "rate-limited" });
  });

  test("any other failure keeps the requested method", async () => {
    const down: Exec = async () => fail;
    expect(await settleMethod(slugCtx(down, SLUG), "merge", "main", false)).toEqual({ method: "merge" });
  });
});
