import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRemote, resolveRepo } from "../src/repos";
import { ghInvocation, listPrs, repoSlug, requestMergeAsync, submitReview, trunkFor } from "../src/github";
import { openCtxForSlug, at, listBoard, openWorktree, stackInfo, slugCtx } from "../src/service";
import type { Exec } from "../src/types";

/** Exec whose `git remote get-url origin` answers from a dir -> url map. */
function remotes(map: Record<string, string>) {
  const calls: string[] = [];
  const exec: Exec = async (argv, opts) => {
    if (argv.join(" ") === "git remote get-url origin" && opts?.cwd) {
      calls.push(opts.cwd);
      const url = map[opts.cwd];
      return url ? { code: 0, stdout: `${url}\n`, stderr: "" } : { code: 2, stdout: "", stderr: "no origin" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${argv.join(" ")}` };
  };
  return { exec, calls };
}

async function layout() {
  const base = await mkdtemp(join(tmpdir(), "stk-repos-"));
  const main = join(base, "projects/core");
  const wt = join(base, "projects/core-wt");
  const other = join(base, "projects/nested/other");
  await mkdir(join(main, ".git"), { recursive: true });
  await mkdir(wt, { recursive: true });
  await writeFile(join(wt, ".git"), "gitdir: x");
  await mkdir(join(other, ".git"), { recursive: true });
  return { base, root: join(base, "projects"), main, wt, other, cacheFile: join(base, "cache/repos.json") };
}

test("parseRemote handles https, ssh and scp forms", () => {
  for (const u of ["https://github.com/o/r.git", "git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://github.com/o/r/"]) {
    expect(parseRemote(u)).toEqual({ owner: "o", name: "r" });
  }
});

describe("resolveRepo", () => {
  test("prefers a main clone over a worktree, caches, and revalidates the cache", async () => {
    const l = await layout();
    const url = "git@github.com:acme-co/widgets.git";
    const { exec, calls } = remotes({ [l.main]: url, [l.wt]: url, [l.other]: "https://github.com/x/other" });
    const opts = { roots: [l.root], cacheFile: l.cacheFile };

    expect(await resolveRepo(exec, "acme-co", "widgets", opts)).toBe(l.main);
    expect(JSON.parse(await Bun.file(l.cacheFile).text())["acme-co/widgets"]).toBe(l.main);

    calls.length = 0;
    expect(await resolveRepo(exec, "Acme-Co", "widgets", opts)).toBe(l.main);
    expect(calls).toEqual([l.main]); // served from cache after one validation, no scan

    // cached path no longer has that remote -> rescan finds the worktree
    const { exec: exec2 } = remotes({ [l.wt]: url });
    expect(await resolveRepo(exec2, "acme-co", "widgets", opts)).toBe(l.wt);
    expect(JSON.parse(await Bun.file(l.cacheFile).text())["acme-co/widgets"]).toBe(l.wt);
  });

  test("returns null and drops a stale cache entry when nothing matches", async () => {
    const l = await layout();
    await mkdir(join(l.base, "cache"), { recursive: true });
    await writeFile(l.cacheFile, JSON.stringify({ "o/r": l.other }));
    const { exec } = remotes({ [l.main]: "https://github.com/a/b" });
    expect(await resolveRepo(exec, "o", "r", { roots: [l.root], cacheFile: l.cacheFile })).toBeNull();
    expect(JSON.parse(await Bun.file(l.cacheFile).text())).toEqual({});
  });
});

describe("repo-less gh", () => {
  const slug = { owner: "o", name: "r" };

  test("ghInvocation adds -R to pr commands and a positional slug to repo view", () => {
    expect(ghInvocation(slug, ["pr", "view", "5"])).toEqual({ argv: ["gh", "pr", "view", "5", "-R", "o/r"] });
    expect(ghInvocation(slug, ["repo", "view", "--json", "defaultBranchRef"]).argv).toEqual([
      "gh", "repo", "view", "o/r", "--json", "defaultBranchRef",
    ]);
    expect(ghInvocation("/dir", ["pr", "view", "5"])).toEqual({ argv: ["gh", "pr", "view", "5"], cwd: "/dir" });
  });

  test("github functions run without cwd and carry -R", async () => {
    const calls: { argv: readonly string[]; cwd?: string; stdin?: string }[] = [];
    const exec: Exec = async (argv, opts) => {
      calls.push({ argv, cwd: opts?.cwd, stdin: opts?.stdin });
      if (argv[1] === "repo") return { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "" };
      if (argv[2] === "list") return { code: 0, stdout: "[]", stderr: "" };
      if (argv[2] === "-i") return { code: 0, stdout: 'HTTP/2.0 202 Accepted\r\n\r\n{"status":"pending","details":{"uuid":"u1"}}', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await trunkFor(exec, slug)).toBe("main");
    await listPrs(exec, slug, { author: "@me", state: "open" });
    await requestMergeAsync(exec, slug, 7, { method: "squash" });
    await submitReview(exec, slug, 7, { event: "APPROVE", body: "" });
    expect(await repoSlug(exec, slug)).toEqual(slug);
    for (const c of calls) expect(c.cwd).toBeUndefined();
    expect(calls[0]!.argv).toEqual(["gh", "repo", "view", "o/r", "--json", "defaultBranchRef"]);
    expect(calls[1]!.argv.slice(-2)).toEqual(["-R", "o/r"]);
    expect(calls[2]!.argv).toEqual(["gh", "api", "-i", "-X", "PUT", "repos/o/r/pulls/7/merge-async", "--input", "-"]);
    expect(calls[3]!.argv).toContain("repos/o/r/pulls/7/reviews");
  });

  test("service: board uses -R; git-dependent actions throw not-a-repo", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push([...argv]);
      if (argv[1] === "repo") return { code: 0, stdout: '{"defaultBranchRef":{"name":"main"}}', stderr: "" };
      if (argv[2] === "list") return { code: 0, stdout: "[]", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = slugCtx(exec, { owner: "o", name: "r" });
    expect(at(ctx)).toEqual({ owner: "o", name: "r" });
    const board = await listBoard(ctx, "mine");
    expect(board.repo).toEqual({ owner: "o", name: "r" });
    expect(calls.every((c) => c.includes("-R") || c[1] === "repo" || c[1] === "api")).toBe(true);
    await expect(stackInfo(ctx, 1, { method: "squash", force: false })).rejects.toMatchObject({ code: "not-a-repo" });
    await expect(
      openWorktree(
        slugCtx(async (a) => ({ code: 0, stdout: a[2] === "view" ? JSON.stringify({ number: 1, title: "t", state: "OPEN", isDraft: false, headRefName: "h", baseRefName: "main", headRefOid: "x" }) : "{}", stderr: "" }), { owner: "o", name: "r" }),
        1,
        { create: true },
      ),
    ).rejects.toMatchObject({ code: "not-a-repo" });
  });

  test("openCtxForSlug falls back to repo-less when no checkout resolves", async () => {
    const exec: Exec = async () => ({ code: 1, stdout: "", stderr: "" });
    const prevRoots = process.env.STK_ROOTS;
    const prevHome = process.env.HOME;
    process.env.STK_ROOTS = join(tmpdir(), "stk-nonexistent-root");
    process.env.HOME = await mkdtemp(join(tmpdir(), "stk-home-"));
    try {
      const ctx = await openCtxForSlug(exec, "no", "such-repo");
      expect(ctx.root).toBeNull();
      expect(ctx.slug).toEqual({ owner: "no", name: "such-repo" });
      expect(ctx.worktrees).toEqual([]);
    } finally {
      if (prevRoots === undefined) delete process.env.STK_ROOTS;
      else process.env.STK_ROOTS = prevRoots;
      process.env.HOME = prevHome;
    }
  });
});
