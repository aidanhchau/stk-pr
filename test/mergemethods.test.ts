import { afterEach, describe, expect, test } from "bun:test";
import { branchRules, repoMergeMethods } from "../src/github";
import { effectiveMethod, fallbackNote, nextMethod } from "../src/methods";
import { allowedMethodsFor, clearRulesCache, merge, slugCtx, stackMerge } from "../src/service";
import { planStackMerge } from "../src/stack";
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
  function restricted() {
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    store.setMergeMethod(repo, "merge");
    (store as unknown as { set(p: object): void }).set({ mergeMethods: { "acme/web": { branch: "dev", allowed: ["squash", "rebase"] } } });
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
});
