import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkPrompt, logTail, parseRunUrl, promptPath, startFix, ternTabArgv, threadLocation, threadPrompt, LOG_TAIL_CHARS } from "../src/agentfix";
import type { ReviewThread } from "../src/github";
import type { Exec } from "../src/types";

const pr = { number: 42, title: "Add widget", url: "https://github.com/o/r/pull/42", headRef: "feat/widget", baseRef: "main" };
const thread: ReviewThread = {
  id: "PRRT_1",
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 12,
  startLine: 10,
  resolvedBy: null,
  diffHunk: "@@ -1,2 +1,3 @@\n+const x = ```y```;",
  comments: [
    { author: "alice", isBot: false, body: "Please rename.", createdAt: "", url: "", mine: false },
    { author: "bugbot", isBot: true, body: "Possible null deref.", createdAt: "", url: "", mine: false },
  ],
};

describe("prompts", () => {
  test("thread prompt carries PR, branch, location, comments, hunk and the instruction", () => {
    const p = threadPrompt(pr, thread);
    for (const s of ["PR #42: Add widget", pr.url, "Branch: feat/widget", "src/a.ts:10-12", "alice:\nPlease rename.", "bugbot (bot):", "@@ -1,2 +1,3 @@", "Fix this review comment, push, and reply on the thread."]) expect(p).toContain(s);
    expect(p).toContain("````diff"); // fence longer than the ``` inside the hunk
  });
  test("location forms", () => {
    expect(threadLocation({ ...thread, startLine: null })).toBe("src/a.ts:12");
    expect(threadLocation({ ...thread, line: null })).toBe("src/a.ts");
    expect(threadLocation({ ...thread, path: null })).toBe("(no file)");
  });
  test("check prompt has name, url and the log tail; without a log it says so", () => {
    const c = { name: "test", state: "fail" as const, url: "https://github.com/o/r/actions/runs/7/job/9" };
    const p = checkPrompt(pr, c, "boom\n");
    expect(p).toContain("Failing check: test");
    expect(p).toContain(c.url);
    expect(p).toContain("boom");
    expect(checkPrompt(pr, c, null)).toContain("No log could be fetched");
  });
  test("logTail keeps the end on a line boundary and strips ANSI", () => {
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n");
    const t = logTail(big);
    expect(t.length).toBeLessThan(LOG_TAIL_CHARS + 40);
    expect(t.startsWith("[… earlier log truncated]\nline ")).toBe(true);
    expect(t.endsWith("line 1999")).toBe(true);
    expect(logTail("\x1b[31mred\x1b[0m")).toBe("red");
  });
});

describe("launch", () => {
  test("run url parsing", () => {
    expect(parseRunUrl("https://github.com/o/r/actions/runs/7/job/9")).toEqual({ owner: "o", name: "r", run: "7", job: "9" });
    expect(parseRunUrl("https://github.com/o/r/actions/runs/7")?.job).toBeNull();
    expect(parseRunUrl("https://ci.example.com/x")).toBeNull();
    expect(parseRunUrl(null)).toBeNull();
  });
  test("tab argv and prompt path are shell-safe words", () => {
    expect(ternTabArgv("/w/t", "/h/p.md")).toEqual(["tern", "new", "tab", "--cwd", "/w/t", "--", "omp", "@/h/p.md", "Proceed"]);
    expect(promptPath(pr, 5, "/h")).toBe("/h/.cache/stk/agentfix/pr42-5.md");
  });
  test("startFix creates the worktree, fetches the failed log, writes the prompt and opens the tab", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv, opts) => {
      calls.push([...argv, `cwd=${opts?.cwd ?? ""}`]);
      if (argv[0] === "gh" && argv[1] === "repo") return { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r" }), stderr: "" };
      if (argv[0] === "gh" && argv[1] === "api") return { code: 0, stdout: JSON.stringify({ data: { repository: { pr42: { reviewThreads: { nodes: [] } } } } }), stderr: "" };
      if (argv[0] === "gh" && argv[1] === "pr") return { code: 0, stdout: JSON.stringify(ghPr()), stderr: "" };
      if (argv[0] === "gh" && argv[1] === "run") return { code: 0, stdout: "FAILED step\n", stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const home = mkdtempSync(`${tmpdir()}/af-`);
    const prev = process.env.HOME;
    process.env.HOME = home;
    try {
      const ctx = { exec, root: "/repo", worktrees: [{ path: "/wt/feat", branch: "feat/widget", head: "x", bare: false }] };
      const started = await startFix(ctx as never, pr, { kind: "check", check: { name: "test", state: "fail", url: "https://github.com/o/r/actions/runs/7/job/9" }, log: null });
      expect(started.worktree).toBe("/wt/feat");
      expect(readFileSync(started.promptFile, "utf8")).toContain("FAILED step");
      const run = calls.find((c) => c[1] === "run")!;
      expect(run.slice(0, 9)).toEqual(["gh", "run", "view", "7", "-R", "o/r", "--job", "9", "--log-failed"]);
      expect(calls.at(-1)!.slice(0, 7)).toEqual(["tern", "new", "tab", "--cwd", "/wt/feat", "--", "omp"]);
    } finally {
      process.env.HOME = prev;
    }
  });
  test("tern failure surfaces its message", async () => {
    const exec: Exec = async (argv) => {
      if (argv[0] === "tern") return { code: 1, stdout: "", stderr: "no Tern is running" };
      if (argv[1] === "repo") return { code: 0, stdout: JSON.stringify({ owner: { login: "o" }, name: "r" }), stderr: "" };
      if (argv[1] === "api") return { code: 0, stdout: JSON.stringify({ data: { repository: { pr42: { reviewThreads: { nodes: [] } } } } }), stderr: "" };
      return { code: 0, stdout: JSON.stringify(ghPr()), stderr: "" };
    };
    const ctx = { exec, root: "/repo", worktrees: [{ path: "/wt/feat", branch: "feat/widget", head: "x", bare: false }] };
    await expect(startFix(ctx as never, pr, { kind: "thread", thread })).rejects.toThrow("no Tern is running");
  });
});

function ghPr() {
  return { number: 42, title: "Add widget", state: "OPEN", isDraft: false, headRefName: "feat/widget", baseRefName: "main", headRefOid: "abc" };
}
