import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverWorkspace, emptyWorkspaceMessage } from "../src/repos";
import { mergeBoards, type RepoBoard } from "../src/workspace";
import { rankRepos } from "../src/commands";
import type { BoardPr } from "../src/service";

const config = (url: string) => `[core]\n\tbare = false\n[remote "origin"]\n\turl = ${url}\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n`;

async function clone(dir: string, url: string | null) {
  await mkdir(join(dir, ".git"), { recursive: true });
  await writeFile(join(dir, ".git/config"), url ? config(url) : "[core]\n\tbare = false\n");
}

/** A linked worktree of the clone at `main`: `.git` file -> .git/worktrees/<name> with a commondir. */
async function worktree(main: string, dir: string, name: string) {
  const gitdir = join(main, ".git/worktrees", name);
  await mkdir(gitdir, { recursive: true });
  await writeFile(join(gitdir, "commondir"), "../..\n");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, ".git"), `gitdir: ${gitdir}\n`);
}

describe("discoverWorkspace", () => {
  test("finds repos and folds worktrees into their slug; skips ignored dirs; stops at repos", async () => {
    const base = await mkdtemp(join(tmpdir(), "stk-ws-"));
    // the folder itself is a git checkout without a remote (a monorepo-style root): still descended into
    await clone(base, null);
    await clone(join(base, "repos/core"), "git@github.com:Acme/core.git");
    await worktree(join(base, "repos/core"), join(base, "wt/feat/core"), "feat");
    await clone(join(base, "repos/web"), "https://github.com/acme/web.git");
    await clone(join(base, "a/b/c/deep"), "https://github.com/acme/deep.git"); // depth 4: beyond the scan
    await clone(join(base, "a/b/shallow"), "https://github.com/acme/shallow.git"); // depth 3
    await clone(join(base, "archive/old"), "https://github.com/acme/archived.git");
    await clone(join(base, "node_modules/pkg"), "https://github.com/acme/pkg.git");
    await clone(join(base, ".hidden/x"), "https://github.com/acme/hidden.git");
    await clone(join(base, "repos/core/vendor/inner"), "https://github.com/acme/inner.git"); // inside a repo: not entered
    await clone(join(base, "repos/gitlab"), "https://gitlab.com/acme/lab.git");
    await clone(join(base, "repos/noremote"), null);
    await symlink(join(base, "repos/web"), join(base, "repos/web-link")).catch(() => {});

    const scan = await discoverWorkspace(base);
    expect(scan.repos.map((r) => `${r.slug.owner}/${r.slug.name}`)).toEqual(["Acme/core", "acme/shallow", "acme/web"]);
    const core = scan.repos[0]!;
    expect(core.dir).toBe(join(base, "repos/core"));
    expect(core.worktrees).toEqual([join(base, "wt/feat/core")]);
    expect(scan.noRemote).toEqual([base, join(base, "repos/gitlab"), join(base, "repos/noremote")].sort());
  });

  test("a worktree met without its main clone stands in as the repo's dir", async () => {
    const base = await mkdtemp(join(tmpdir(), "stk-ws-"));
    const elsewhere = join(base, "elsewhere/core");
    await clone(elsewhere, "https://github.com/acme/widgets.git");
    await worktree(elsewhere, join(base, "scan/core-a"), "a");
    await worktree(elsewhere, join(base, "scan/core-b"), "b");
    const scan = await discoverWorkspace(join(base, "scan"));
    expect(scan.repos).toHaveLength(1);
    expect(scan.repos[0]).toMatchObject({ dir: join(base, "scan/core-a"), worktrees: [join(base, "scan/core-b")] });
  });

  test("an empty tree reports what was searched and the remedies", async () => {
    const base = await mkdtemp(join(tmpdir(), "stk-ws-"));
    await mkdir(join(base, "x/y"), { recursive: true });
    const scan = await discoverWorkspace(base);
    expect(scan.repos).toEqual([]);
    const msg = emptyWorkspaceMessage(scan);
    expect(msg).toContain(base);
    expect(msg).toContain("3 directories");
    expect(msg).toContain("--repo DIR");
    expect(msg).toContain("--gh owner/name");
  });
});

const pr = (n: number, updatedAt: string): BoardPr => ({ number: n, updatedAt, blockers: [] }) as unknown as BoardPr;

describe("mergeBoards", () => {
  const board = (name: string, prs: BoardPr[]): RepoBoard => ({ repo: { owner: "o", name }, board: { repo: { owner: "o", name }, trunk: "main", prs } });

  test("newest activity first across repos; ties by repo then number; rows carry their repo", () => {
    const m = mergeBoards([
      board("zeta", [pr(5, "2026-10-12T10:00:00Z"), pr(2, "2026-10-10T10:00:00Z")]),
      board("alpha", [pr(9, "2026-10-12T10:00:00Z"), pr(8, "2026-10-12T10:00:00Z"), pr(1, "2026-10-13T10:00:00Z")]),
    ]);
    expect(m.prs.map((p) => `${p.repo.name}#${p.number}`)).toEqual(["alpha#1", "alpha#9", "alpha#8", "zeta#5", "zeta#2"]);
    expect(m.errors).toEqual([]);
  });

  test("failed repos are reported, the rest still merge", () => {
    const m = mergeBoards([{ repo: { owner: "o", name: "bad" }, error: "no access" }, board("ok", [pr(1, "2026-10-12T10:00:00Z")])]);
    expect(m.prs).toHaveLength(1);
    expect(m.errors).toEqual([{ repo: { owner: "o", name: "bad" }, message: "no access" }]);
  });
});

describe("rankRepos", () => {
  const slugs = ["acme/widgets", "acme/widgets-web", "acme/gadgets-api"];
  test("empty query: workspace row first, then every repo", () => {
    expect(rankRepos(slugs, "").map((r) => r.slug)).toEqual([null, ...slugs]);
  });
  test("fuzzy filters; `all` returns the workspace row", () => {
    expect(rankRepos(slugs, "gadgets").map((r) => r.slug)).toEqual(["acme/gadgets-api"]);
    expect(rankRepos(slugs, "web").map((r) => r.slug)).toEqual(["acme/widgets-web"]);
    expect(rankRepos(slugs, "all")[0]!.slug).toBeNull();
  });
});
