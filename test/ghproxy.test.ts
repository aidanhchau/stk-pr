import { describe, expect, test } from "bun:test";
import { GH_ENV, formatGhOutput, isMutating, planGh, stripAnsi, tokenize } from "../src/ghproxy";

const repo = { owner: "o", name: "r" };
const plan = (line: string, n: number | null = 7) => {
  const r = planGh(line, { repo, n });
  if (!r.ok) throw new Error(r.error);
  return r.plan;
};

describe("gh proxy planning", () => {
  test("tokenize handles quotes and escapes", () => {
    expect(tokenize(`pr comment 7 --body "hello \\"you\\" there" 'a b'`)).toEqual(["pr", "comment", "7", "--body", 'hello "you" there', "a b"]);
    expect(tokenize(`a "unterminated`)).toBeNull();
  });

  test("expands {n}, appends -R for repo-scoped groups, keeps an explicit -R", () => {
    expect(plan("pr view {n}").argv).toEqual(["gh", "pr", "view", "7", "-R", "o/r"]);
    expect(plan("gh run list").argv).toEqual(["gh", "run", "list", "-R", "o/r"]);
    expect(plan("pr view 3 -R x/y").argv).toEqual(["gh", "pr", "view", "3", "-R", "x/y"]);
    expect(plan("pr view 3 --repo=x/y").argv).toEqual(["gh", "pr", "view", "3", "--repo=x/y"]);
    expect(plan("repo view").argv).toEqual(["gh", "repo", "view", "o/r"]);
    expect(plan("search prs foo").argv).toEqual(["gh", "search", "prs", "foo"]);
  });

  test("gh api expands {owner}/{repo} and {n}; no -R", () => {
    expect(plan("api repos/{owner}/{repo}/pulls/{n}/files").argv).toEqual(["gh", "api", "repos/o/r/pulls/7/files"]);
  });

  test("{n} without a PR is an error", () => {
    expect(planGh("pr view {n}", { repo, n: null })).toEqual({ ok: false, error: expect.stringContaining("{n}") });
  });

  test("display quotes arguments with spaces", () => {
    expect(plan(`pr comment 7 --body "hi there"`).display).toBe("gh pr comment 7 --body 'hi there' -R o/r");
  });
});

describe("gh proxy classification", () => {
  const m = (line: string) => plan(line).mutating;
  test("read-only commands run immediately", () => {
    for (const l of ["pr view 7", "pr list --state all", "pr diff 7", "pr checks 7", "issue view 1", "run list", "run view 5 --log", "repo view", "search prs x", "api repos/{owner}/{repo}", "api -X GET repos/o/r", "auth status", "status"]) expect(m(l)).toBe(false);
  });
  test("mutating and unknown commands ask first", () => {
    for (const l of ["pr edit 7 --base main", "pr close 7", "pr reopen 7", "pr merge 7", "pr ready 7", "pr review 7 --approve", "pr comment 7 -b x", "pr checkout 7", "issue create -t x", "issue close 1", "run rerun 5", "run cancel 5", "release create v1", "label create x", "repo edit --description x", "repo delete", "frobnicate", "api -X POST repos/o/r/issues", "api --method=DELETE repos/o/r/x", "api repos/o/r/issues -f title=x", "api repos/o/r/issues -F body=@f", "api graphql -f query=q", "api -X GET repos/o/r -f per_page=1"]) {
      expect([l, m(l)]).toEqual([l, l === "api -X GET repos/o/r -f per_page=1" ? false : true]);
    }
  });
  test("isMutating on bare flags", () => {
    expect(isMutating([])).toBe(false);
    expect(isMutating(["--version"])).toBe(false);
  });
});

describe("gh proxy environment and output", () => {
  test("never prompts or colours", () => {
    expect(GH_ENV.GH_PROMPT_DISABLED).toBe("1");
    expect(GH_ENV.NO_COLOR).toBe("1");
    expect(GH_ENV.GH_PAGER).toBe("cat");
  });
  test("output strips ANSI, joins stderr, hints on prompt failures", () => {
    expect(stripAnsi("\x1b[1;32mok\x1b[0m")).toBe("ok");
    expect(formatGhOutput("\x1b[32mhi\x1b[0m\n", "warn\n", 0)).toBe("hi\nwarn");
    expect(formatGhOutput("", "must provide `--title` and `--body`", 1)).toContain("pass every input as flags");
    expect(formatGhOutput("", "", 0)).toBe("(no output)");
  });
});

import { ghProxy, type Ctx } from "../src/service";
import type { Exec } from "../src/types";

describe("ghProxy service", () => {
  const run = (reply: { code?: number; stdout?: string; stderr?: string } = {}) => {
    const seen: { argv: readonly string[]; opts: Parameters<Exec>[1] }[] = [];
    const exec: Exec = async (argv, opts) => (seen.push({ argv, opts }), { code: reply.code ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" });
    const ctx: Ctx = { exec, root: "/work/repo", slug: { owner: "o", name: "r" }, worktrees: [] };
    return { ctx, seen };
  };

  test("read-only runs at once in the repo dir with the no-tty env", async () => {
    const { ctx, seen } = run({ stdout: "\x1b[1mTitle\x1b[0m\n" });
    const r = await ghProxy(ctx, "pr view {n}", { n: 7 });
    expect(r).toEqual({ command: "gh pr view 7 -R o/r", code: 0, mutating: false, output: "Title" });
    expect(seen[0]!.argv).toEqual(["gh", "pr", "view", "7", "-R", "o/r"]);
    expect(seen[0]!.opts?.cwd).toBe("/work/repo");
    expect(seen[0]!.opts?.env).toEqual(GH_ENV);
    expect(seen[0]!.opts?.stdin).toBeUndefined();
  });

  test("mutating commands need confirmed: true and never run otherwise", async () => {
    const { ctx, seen } = run();
    await expect(ghProxy(ctx, "pr close {n}", { n: 7 })).rejects.toThrow("confirmation required: gh pr close 7 -R o/r");
    expect(seen).toHaveLength(0);
    const r = await ghProxy(ctx, "pr close {n}", { n: 7, confirmed: true });
    expect(r.mutating).toBe(true);
    expect(seen).toHaveLength(1);
  });

  test("a failing gh is a result with its exit code, not an exception", async () => {
    const { ctx } = run({ code: 1, stderr: "no pull requests found" });
    expect(await ghProxy(ctx, "pr view 99", {})).toMatchObject({ code: 1, output: "no pull requests found" });
  });
});
