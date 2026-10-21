import { afterEach, describe, expect, test } from "bun:test";
import { main } from "../src/cli";
import { branchRules, repoMergeMethods } from "../src/github";
import { effectiveMethod, fallbackNote, nextMethod } from "../src/methods";
import { allowedMethodsFor, clearRulesCache } from "../src/service";
import { planStackMerge } from "../src/stack";
import { Store, mergeMethodNote, mergeMethodOf } from "../src/tui/store";
import type { Exec, MergeMethod, PullRequest, Stack } from "../src/types";

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

describe("CLI --method pre-flight", () => {
  function cli(rules: unknown[] | null) {
    const calls: string[][] = [];
    const gh = github({ rules });
    const exec: Exec = async (argv, opts) => {
      calls.push([...argv]);
      if (argv[0] === "git" && argv[1] === "rev-parse") return { code: 0, stdout: "/work/repo\n", stderr: "" };
      if (argv[0] === "git" && argv[1] === "worktree") return { code: 0, stdout: "worktree /work/repo\nHEAD 111\nbranch refs/heads/dev", stderr: "" };
      if (argv.slice(0, 4).join(" ") === "gh repo view --json") {
        return { code: 0, stdout: argv[4] === "defaultBranchRef" ? '{"defaultBranchRef":{"name":"dev"}}' : '{"owner":{"login":"o"},"name":"r"}', stderr: "" };
      }
      return gh.exec(argv, opts);
    };
    const out: string[] = [];
    const run = async (...args: string[]) => ({
      code: await main(["--repo", "/work/repo", "--json", ...args], { exec, stdout: (s) => void out.push(s), stderr: (s) => void out.push(s) }),
      out: out.join(""),
    });
    return { run, calls };
  }

  for (const cmd of [["merge", "7"], ["stack", "7", "--merge"]]) {
    test(`${cmd[0]} --method merge is rejected before any PR is read or merged, listing the allowed methods`, async () => {
      const { run, calls } = cli(SQUASH_REBASE_RULE);
      const r = await run(...cmd, "--method", "merge");
      expect(r.code).toBe(1);
      expect(r.out).toContain("merge method 'merge' is not allowed on dev; allowed: squash, rebase");
      expect(calls.some((c) => c.includes("PUT") || (c[1] === "pr" && c[2] === "view") || c.includes("graphql"))).toBe(false);
    });
  }

  test("an allowed --method passes the pre-flight", async () => {
    const { run } = cli(SQUASH_REBASE_RULE);
    const r = await run("merge", "7", "--method", "rebase");
    expect(r.out).not.toContain("is not allowed");
  });

  test("when the allowed set cannot be read the method is not second-guessed", async () => {
    const { run } = cli(null);
    const r = await run("merge", "7", "--method", "merge");
    expect(r.out).not.toContain("is not allowed");
  });
});
