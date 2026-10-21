import { describe, expect, test } from "bun:test";
import { main } from "../src/cli";
import type { Exec } from "../src/types";

const fx = (name: string) => Bun.file(new URL(`./fixtures/${name}`, import.meta.url)).text();

type Reply = { code?: number; stdout?: string; stderr?: string };

const PORCELAIN = [
  "worktree /work/repo\nHEAD 111\nbranch refs/heads/main",
  "worktree /work/wt-a\nHEAD aaa111\nbranch refs/heads/feat-a",
].join("\n\n");

/** Fake Exec: first handler whose argv prefix matches wins; records every call. */
async function setup(extra: [string[], Reply][] = []) {
  const prList = await fx("pr-list.json");
  const prs = JSON.parse(prList) as unknown[];
  const handlers: [string[], Reply][] = [
    ...extra,
    [["git", "rev-parse", "--show-toplevel"], { stdout: "/work/repo\n" }],
    [["git", "worktree", "list"], { stdout: PORCELAIN }],
    [["gh", "repo", "view", "--json", "defaultBranchRef"], { stdout: '{"defaultBranchRef":{"name":"main"}}' }],
    [["gh", "repo", "view", "--json", "owner,name"], { stdout: '{"owner":{"login":"o"},"name":"r"}' }],
    [["gh", "api", "graphql"], { stdout: await fx("threads-graphql.json") }],
    [["gh", "pr", "list"], { stdout: prList }],
    [["gh", "pr", "view", "10"], { stdout: JSON.stringify(prs[0]) }],
    [["gh", "pr", "view", "11"], { stdout: JSON.stringify(prs[1]) }],
  ];
  const calls: string[][] = [];
  const stdins: string[] = [];
  const exec: Exec = async (argv, opts) => {
    calls.push([...argv]);
    if (opts?.stdin !== undefined) stdins.push(opts.stdin);
    for (const [prefix, r] of handlers) {
      if (prefix.every((p, i) => argv[i] === p)) {
        return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
      }
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  };
  const out: string[] = [];
  const err: string[] = [];
  const run = async (...args: string[]) => {
    out.length = 0;
    err.length = 0;
    const code = await main(["--repo", "/work/repo", ...args], {
      exec,
      stdout: (s) => void out.push(s),
      stderr: (s) => void err.push(s),
    });
    return { code, out: out.join(""), err: err.join("") };
  };
  const has = (...prefix: string[]) => calls.some((c) => prefix.every((p, i) => c[i] === p));
  return { run, calls, has, stdins };
}

interface Kinded {
  kind: string;
}

/** Superset of the `prs`/`merge` response shapes these tests read; use `envelope<unknown>` for other commands. */
interface Data {
  trunk: string;
  prs: { worktree: string | null; unresolvedThreads: number; blockers: Kinded[] }[];
  wouldMerge: boolean;
  admin: boolean;
  method: string;
  bypassed: Kinded[];
  bypass: Kinded[];
}

interface Envelope<D> {
  ok: boolean;
  data: D;
  error: { code: string; message: string; data: { blockers: Kinded[] } };
}

const envelope = <D = Data>(out: string): Envelope<D> => {
  expect(out.trim().split("\n")).toHaveLength(1);
  // Cast: JSON.parse output is trusted test input shaped by the CLI under test.
  return JSON.parse(out) as Envelope<D>;
};

describe("cli", () => {
  test("prs: JSON envelope, blockers, worktree fill, thread counts", async () => {
    const { run, has } = await setup();
    const r = await run("--json", "prs");
    expect(r.code).toBe(0);
    const j = envelope(r.out);
    expect(j.ok).toBe(true);
    expect(j.data.trunk).toBe("main");
    expect(j.data.prs).toHaveLength(2);
    const a = j.data.prs[0]!;
    const b = j.data.prs[1]!;
    expect(a.worktree).toBe("/work/wt-a");
    expect(b.worktree).toBeNull();
    expect(a.unresolvedThreads).toBe(2);
    expect(a.blockers.map((x: { kind: string }) => x.kind)).toEqual(["checks", "threads"]);
    expect(b.blockers.map((x: { kind: string }) => x.kind)).toContain("conflict");
    expect(has("gh", "pr", "list", "--json")).toBe(true);
  });

  test("prs --review searches review-requested:@me", async () => {
    const { run, calls } = await setup();
    await run("--json", "prs", "--review");
    const list = calls.find((c) => c[1] === "pr" && c[2] === "list")!;
    expect(list).toContain("review-requested:@me");
    expect(list).not.toContain("--author");
  });

  test("open uses the existing worktree without fetch or worktree add", async () => {
    const { run, has } = await setup();
    const r = await run("--json", "open", "10", "--create");
    expect(envelope<unknown>(r.out).data).toEqual({ branch: "feat-a", worktree: "/work/wt-a", created: false });
    expect(has("git", "fetch")).toBe(false);
    expect(has("git", "worktree", "add")).toBe(false);
    expect(has("git", "checkout")).toBe(false);
  });

  test("open --create fetches then adds a worktree", async () => {
    const { run, calls } = await setup([
      [["git", "fetch"], {}],
      [["git", "worktree", "add"], {}],
    ]);
    const r = await run("--json", "open", "11", "--create");
    expect(envelope<unknown>(r.out).data).toEqual({
      branch: "feat-b",
      worktree: "/work/.stk-worktrees/feat-b",
      created: true,
    });
    const fetchIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "fetch");
    const addIdx = calls.findIndex((c) => c[0] === "git" && c[1] === "worktree" && c[2] === "add");
    expect(calls[fetchIdx]).toEqual(["git", "fetch", "origin", "feat-b"]);
    expect(calls[addIdx]).toEqual(["git", "worktree", "add", "/work/.stk-worktrees/feat-b", "feat-b"]);
    expect(fetchIdx).toBeGreaterThan(-1);
    expect(addIdx).toBeGreaterThan(fetchIdx);
  });

  test("open without --create and no worktree reports null", async () => {
    const { run, has } = await setup();
    const r = await run("--json", "open", "11");
    expect(envelope<unknown>(r.out).data).toEqual({ branch: "feat-b", worktree: null, created: false });
    expect(has("git", "fetch")).toBe(false);
  });

  test("merge without --force is blocked and does not merge", async () => {
    const { run, has } = await setup();
    const r = await run("--json", "merge", "10");
    expect(r.code).toBe(1);
    const j = envelope(r.out);
    expect(j.ok).toBe(false);
    expect(j.error.code).toBe("blocked");
    expect(j.error.data.blockers.map((b: { kind: string }) => b.kind)).toEqual(["checks", "threads"]);
    expect(has("gh", "api", "-i", "-X", "PUT")).toBe(false);
  });

  test("merge --force requests merge-async with bypass_rules and lists bypassed blockers", async () => {
    const merged = { stdout: `HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ status: "merged", details: { sha: "m1" } })}` };
    const { run, calls, stdins } = await setup([[["gh", "api", "-i", "-X", "PUT"], merged]]);
    const r = await run("--json", "merge", "10", "--force");
    expect(r.code).toBe(0);
    const j = envelope(r.out);
    expect(j.data.admin).toBe(true);
    expect(j.data.method).toBe("squash");
    expect(j.data.bypassed.map((b: { kind: string }) => b.kind)).toEqual(["checks", "threads"]);
    const put = calls.find((c) => c.includes("PUT"))!;
    expect(put).toContain("repos/o/r/pulls/10/merge-async");
    expect(JSON.parse(stdins.at(-1)!)).toMatchObject({ merge_method: "squash", bypass_rules: true });
    expect(calls.some((c) => c[1] === "pr" && c[2] === "merge")).toBe(false);
  });

  test("merge --force still refuses conflicts and drafts", async () => {
    const { run, has } = await setup();
    const r = await run("--json", "merge", "11", "--force");
    expect(r.code).toBe(1);
    const j = envelope(r.out);
    expect(j.error.code).toBe("blocked");
    expect(j.error.data.blockers.map((b: { kind: string }) => b.kind).sort()).toEqual(["conflict", "draft"]);
    expect(has("gh", "api", "-i", "-X", "PUT")).toBe(false);
  });

  test("merge --dry-run makes no merge call", async () => {
    const { run, has } = await setup();
    const r = await run("--json", "merge", "10", "--force", "--dry-run");
    expect(r.code).toBe(0);
    const d = envelope(r.out).data;
    expect(d.wouldMerge).toBe(true);
    expect(d.admin).toBe(true);
    expect(d.bypass.map((b: { kind: string }) => b.kind)).toEqual(["checks", "threads"]);
    expect(has("gh", "api", "-i", "-X", "PUT")).toBe(false);

    const blocked = envelope((await run("--json", "merge", "10", "--dry-run")).out).data;
    expect(blocked.wouldMerge).toBe(false);
    expect(blocked.admin).toBe(false);
    expect(has("gh", "api", "-i", "-X", "PUT")).toBe(false);
  });

  test("gh failure becomes an error envelope", async () => {
    const { run } = await setup([[["gh", "pr", "list"], { code: 1, stderr: "boom\n" }]]);
    const r = await run("--json", "prs");
    expect(r.code).toBe(1);
    expect(JSON.parse(r.out)).toEqual({ ok: false, error: { code: "gh-failed", message: "boom" } });
    expect(envelope(r.out).ok).toBe(false);
  });

  test("human mode errors go to stderr", async () => {
    const { run } = await setup([[["gh", "pr", "list"], { code: 1, stderr: "boom" }]]);
    const r = await run("prs");
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("boom");
  });

  test("unknown command is a usage error; --help prints help", async () => {
    const { run } = await setup();
    const bad = await run("--json", "frobnicate");
    expect(bad.code).toBe(1);
    expect(envelope(bad.out).error.code).toBe("usage");
    const badFlag = await run("--json", "prs", "--nope");
    expect(envelope(badFlag.out).error.code).toBe("usage");
    const help = await run("--help");
    expect(help.code).toBe(0);
    expect(help.out).toContain("usage: stk");
  });
});
