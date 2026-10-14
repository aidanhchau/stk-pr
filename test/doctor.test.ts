import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/cli";
import { doctorOk, doctorText, runDoctor, versionText, type DoctorCheck } from "../src/doctor";
import type { Exec } from "../src/types";

type Reply = { code?: number; stdout?: string; stderr?: string };

const future = Math.floor(Date.now() / 1000) + 1800;
const GOOD_AUTH = "github.com\n  ✓ Logged in to github.com account octo (keyring)\n  - Token scopes: 'gist', 'read:org', 'repo'\n";
const gqlHeaders = (remaining: number) => `HTTP/2.0 200 OK\nX-Ratelimit-Limit: 5000\nX-Ratelimit-Remaining: ${remaining}\nX-Ratelimit-Reset: ${future}\n\n{"data":{}}`;
const restBody = (remaining: number) => JSON.stringify({ resources: { core: { limit: 5000, remaining, reset: future } } });

/** Fake Exec: first handler whose argv prefix matches wins. */
function fake(overrides: [string[], Reply][] = []): { exec: Exec; calls: string[][] } {
  const handlers: [string[], Reply][] = [
    ...overrides,
    [["gh", "--version"], { stdout: "gh version 2.81.0 (2026-01-01)\n" }],
    [["gh", "auth", "status"], { stdout: GOOD_AUTH }],
    [["gh", "extension", "list"], { stdout: "gh stack\tgithub/gh-stack\tv0.2.1\n" }],
    [["tern", "--version"], { stdout: "tern 0.8.3 (e2b8656)\n" }],
    [["gh", "api", "-i", "graphql"], { stdout: gqlHeaders(4900) }],
    [["gh", "api", "rate_limit"], { stdout: restBody(4000) }],
    [["git", "rev-parse", "--show-toplevel"], { stdout: "/work/repo\n" }],
    [["git", "worktree", "list"], { stdout: "worktree /work/repo\nHEAD 111\nbranch refs/heads/main" }],
    [["gh", "repo", "view", "--json", "owner,name"], { stdout: '{"owner":{"login":"o"},"name":"r"}' }],
  ];
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    for (const [prefix, r] of handlers) {
      if (prefix.every((p, i) => argv[i] === p)) return { code: r.code ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
  };
  return { exec, calls };
}

function env() {
  const dir = mkdtempSync(join(tmpdir(), "stk-doctor-"));
  const sessionsDir = join(dir, "sessions");
  mkdirSync(sessionsDir);
  return { dir, sessionsDir, cacheDirs: [join(dir, "cache", "jobs"), join(dir, "cache")] };
}

const byId = (checks: DoctorCheck[]): Record<string, DoctorCheck> => Object.fromEntries(checks.map((c) => [c.id, c]));

describe("stk doctor", () => {
  test("healthy environment: every check ok", async () => {
    const e = env();
    const checks = await runDoctor({ exec: fake().exec, cwd: "/work/repo", env: { TERN_PANE: "7", HOME: e.dir }, sessionsDir: e.sessionsDir, cacheDirs: e.cacheDirs });
    const c = byId(checks);
    expect(checks.map((x) => x.status)).toEqual(checks.map(() => "ok"));
    expect(c.gh!.message).toBe("gh 2.81.0");
    expect(c["gh-auth"]!.message).toContain("octo");
    expect(c["gh-stack"]!.message).toBe("gh-stack v0.2.1");
    expect(c.tern!.message).toContain("tern 0.8.3");
    expect(c.tern!.message).toContain("pane 7");
    expect(c["rate-graphql"]!.message).toContain("4900/5000");
    expect(c["rate-rest"]!.message).toContain("4000/5000");
    expect(c.repo!.message).toContain("o/r");
    expect(doctorOk(checks)).toBe(true);
    expect(doctorText(checks).split("\n")).toHaveLength(checks.length);
    expect(doctorText(checks)).not.toContain("→");
  });

  test("failures carry a fix hint and make the run unhealthy", async () => {
    const e = env();
    const { exec } = fake([
      [["gh", "--version"], { code: 127, stderr: "not found" }],
      [["gh", "auth", "status"], { code: 1, stderr: "You are not logged into any GitHub hosts." }],
      [["gh", "extension", "list"], { stdout: "" }],
      [["tern", "--version"], { code: 127 }],
      [["gh", "api", "-i", "graphql"], { code: 1 }],
      [["gh", "api", "rate_limit"], { code: 1 }],
    ]);
    const checks = await runDoctor({ exec, cwd: "/work/repo", env: { HOME: e.dir }, sessionsDir: join(e.dir, "missing"), cacheDirs: e.cacheDirs });
    const c = byId(checks);
    expect(c.gh!.status).toBe("fail");
    expect(c.gh!.fix).toContain("brew install gh");
    expect(c["gh-auth"]!.status).toBe("fail");
    expect(c["gh-auth"]!.fix).toContain("gh auth login");
    expect(c["gh-stack"]!.status).toBe("warn");
    expect(c["gh-stack"]!.fix).toContain("gh extension install github/gh-stack");
    expect(c.tern!.status).toBe("warn");
    expect(c["omp-transcripts"]!.status).toBe("warn");
    expect(c["rate-graphql"]!.status).toBe("warn");
    expect(c["rate-rest"]!.status).toBe("warn");
    expect(doctorOk(checks)).toBe(false);
    const text = doctorText(checks);
    expect(text).toContain("✗ gh is not installed\n    → install the GitHub CLI");
    expect(text).toContain("⚠");
  });

  test("token without the repo scope fails; no scopes line warns", async () => {
    const e = env();
    const run = async (stdout: string) => {
      const { exec } = fake([[["gh", "auth", "status"], { stdout }]]);
      const checks = await runDoctor({ exec, cwd: "/work/repo", env: { HOME: e.dir }, sessionsDir: e.sessionsDir, cacheDirs: e.cacheDirs });
      return byId(checks)["gh-auth"]!;
    };
    const noRepo = await run("✓ Logged in to github.com account octo (keyring)\n  - Token scopes: 'gist', 'read:org'\n");
    expect(noRepo.status).toBe("fail");
    expect(noRepo.fix).toContain("gh auth refresh -s repo");
    const none = await run("✓ Logged in to github.com account octo (GH_TOKEN)\n");
    expect(none.status).toBe("warn");
  });

  test("rate limits: exhausted fails, nearly spent warns", async () => {
    const e = env();
    const { exec } = fake([
      [["gh", "api", "-i", "graphql"], { stdout: gqlHeaders(0) }],
      [["gh", "api", "rate_limit"], { stdout: restBody(100) }],
    ]);
    const c = byId(await runDoctor({ exec, cwd: "/work/repo", env: { HOME: e.dir }, sessionsDir: e.sessionsDir, cacheDirs: e.cacheDirs }));
    expect(c["rate-graphql"]!.status).toBe("fail");
    expect(c["rate-graphql"]!.message).toContain("exhausted");
    expect(c["rate-rest"]!.status).toBe("warn");
    expect(c["rate-rest"]!.message).toContain("100/5000");
  });

  test("tern on PATH but outside a pane warns", async () => {
    const e = env();
    const c = byId(await runDoctor({ exec: fake().exec, cwd: "/work/repo", env: { HOME: e.dir }, sessionsDir: e.sessionsDir, cacheDirs: e.cacheDirs }));
    expect(c.tern!.status).toBe("warn");
    expect(c.tern!.message).toContain("TERN_PANE");
  });

  test("unwritable cache dir fails", async () => {
    const e = env();
    const blocker = join(e.dir, "file");
    writeFileSync(blocker, "x");
    const c = byId(await runDoctor({ exec: fake().exec, cwd: "/work/repo", env: { HOME: e.dir }, sessionsDir: e.sessionsDir, cacheDirs: [join(blocker, "sub")] }));
    expect(c.cache!.status).toBe("fail");
    expect(c.cache!.fix).toContain("STK_JOBS_DIR");
  });

  test("keyboard hint depends on the terminal", async () => {
    const e = env();
    const run = async (envVars: Record<string, string>) =>
      byId(await runDoctor({ exec: fake().exec, cwd: "/work/repo", env: { HOME: e.dir, ...envVars }, sessionsDir: e.sessionsDir, cacheDirs: e.cacheDirs })).keyboard!;
    expect((await run({ TERM_PROGRAM: "ghostty" })).status).toBe("ok");
    expect((await run({ TERM: "xterm-kitty" })).status).toBe("ok");
    expect((await run({ TERM_PROGRAM: "Apple_Terminal" })).status).toBe("warn");
    expect((await run({ TERM: "xterm-256color" })).status).toBe("warn");
  });

  test("outside a repo: a workspace is reported, an empty dir warns", async () => {
    const e = env();
    const notRepo: [string[], Reply][] = [[["git", "rev-parse", "--show-toplevel"], { code: 128, stderr: "fatal: not a git repository" }]];
    const ws = join(e.dir, "ws");
    mkdirSync(join(ws, "a", ".git"), { recursive: true });
    writeFileSync(join(ws, "a", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:o/a.git\n');
    mkdirSync(join(ws, "b", ".git"), { recursive: true });
    writeFileSync(join(ws, "b", ".git", "config"), '[remote "origin"]\n\turl = git@github.com:o/b.git\n');
    const found = byId(await runDoctor({ exec: fake(notRepo).exec, cwd: ws, env: { HOME: e.dir }, sessionsDir: e.sessionsDir, cacheDirs: e.cacheDirs })).repo!;
    expect(found.status).toBe("ok");
    expect(found.message).toContain("workspace of 2 repos");

    const empty = join(e.dir, "empty");
    mkdirSync(empty);
    const none = byId(await runDoctor({ exec: fake(notRepo).exec, cwd: empty, env: { HOME: e.dir }, sessionsDir: e.sessionsDir, cacheDirs: e.cacheDirs })).repo!;
    expect(none.status).toBe("warn");
    expect(none.message).toContain("No GitHub repositories found");
    expect(none.fix).toContain("--repo");
  });
});

describe("stk --version", () => {
  test("plain version outside a clone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stk-ver-"));
    expect(await versionText(fake().exec, dir, "1.2.3")).toBe("1.2.3");
  });

  test("adds the short sha inside a clone", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stk-ver-"));
    mkdirSync(join(dir, ".git"));
    const { exec, calls } = fake([[["git", "rev-parse", "--short", "HEAD"], { stdout: "abc1234\n" }]]);
    expect(await versionText(exec, dir, "1.2.3")).toBe("1.2.3 (abc1234)");
    expect(calls[0]).toEqual(["git", "rev-parse", "--short", "HEAD"]);
  });

  test("cli: --version and doctor --json", async () => {
    let out = "";
    const deps = { exec: fake().exec, stdout: (s: string) => void (out += s), stderr: () => {} };
    expect(await main(["--version"], deps)).toBe(0);
    expect(out).toMatch(/^stk \d+\.\d+\.\d+/);
    out = "";
    expect(await main(["--version", "--json"], deps)).toBe(0);
    expect(JSON.parse(out).data.version).toMatch(/^\d+\.\d+\.\d+/);

    out = "";
    const code = await main(["doctor", "--json", "--repo", "/work/repo"], deps);
    const j = JSON.parse(out);
    expect(j.ok).toBe(true);
    expect(j.data.checks.map((c: { id: string }) => c.id)).toEqual([
      "gh", "gh-auth", "gh-stack", "tern", "omp-transcripts", "rate-graphql", "rate-rest", "cache", "keyboard", "repo",
    ]);
    expect(code).toBe(j.data.healthy ? 0 : 1);
  });
});
