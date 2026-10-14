import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeCommand, extractPrRefs, agentPanes, findPane, isPlaceholderRepo, paneCandidates, rankAgentPanes, parseTranscript, sessionPrRefs, summarizeMentions, transcriptHead } from "../src/session";
import { prReadiness, rankSessionPr } from "../src/service";
import type { Exec } from "../src/types";

process.env.STK_PUSH_COMMANDS = "pushpr";
process.env.STK_WATCH_COMMANDS = "watchpr";

describe("extractPrRefs", () => {
  test("pull urls, /files, /commits, anchors, gh pr create output; deduped in first-mention order", () => {
    const text = [
      "see https://github.com/northwind/widgets/pull/101/files for the diff",
      "Creating pull request for feat into main in o/r\nhttps://github.com/o/r/pull/12",
      "comment https://github.com/northwind/widgets/pull/101#discussion_r123456",
      "https://github.com/northwind/widgets/pull/105/commits and https://github.com/o/r/pull/12.",
      "not a pr: https://github.com/o/r/pulls and https://github.com/o/r/issues/5",
      'json "url":"https://github.com/a-b/c.d/pull/7\n"',
    ].join("\n");
    expect(extractPrRefs(text)).toEqual([
      { owner: "northwind", name: "widgets", number: 101, firstSeen: 0 },
      { owner: "o", name: "r", number: 12, firstSeen: 2 },
      { owner: "northwind", name: "widgets", number: 105, firstSeen: 4 },
      { owner: "a-b", name: "c.d", number: 7, firstSeen: 6 },
    ]);
  });

  test("dedupe is case-insensitive on owner/name", () => {
    const refs = extractPrRefs("github.com/Foo/Bar/pull/1 github.com/foo/bar/pull/1");
    expect(refs).toHaveLength(1);
  });
});

describe("pane + transcript lookup", () => {
  const ls = { sessions: [{ tabs: [{ blocks: [{ id: 5, title: "T", cwd: "/x" }, { id: 6, title: "U" }] }] }] };
  test("findPane", () => {
    expect(findPane(ls, "5")).toEqual({ title: "T", cwd: "/x" });
    expect(findPane(ls, "9")).toBeNull();
  });
  test("transcriptHead reads the title and session cwd", () => {
    const head = [
      JSON.stringify({ type: "title", title: "T" }),
      JSON.stringify({ type: "session", title: "T", cwd: "/x" }),
      '{"type":"mod',
    ].join("\n");
    expect(transcriptHead(head)).toEqual({ title: "T", cwd: "/x" });
  });
});

const rec = (message: object) => JSON.stringify({ type: "message", message });
const user = (text: string) => rec({ role: "user", content: [{ type: "text", text }] });
const asst = (text: string, ...calls: { id: string; command: string; cwd?: string }[]) =>
  rec({
    role: "assistant",
    content: [
      ...(text ? [{ type: "text", text }, { type: "thinking", thinking: "see https://github.com/think/ing/pull/1" }] : []),
      ...calls.map((c) => ({ type: "toolCall", id: c.id, name: "bash", arguments: { command: c.command, ...(c.cwd ? { cwd: c.cwd } : {}) } })),
    ],
  });
const result = (id: string, text: string) => rec({ role: "toolResult", toolCallId: id, toolName: "bash", content: [{ type: "text", text }] });

describe("parseTranscript + summarizeMentions", () => {
  const A = "https://github.com/northwind";
  const lines = [
    JSON.stringify({ type: "title", title: "T" }),
    JSON.stringify({ type: "session", cwd: "/work/widgets" }),
    // list-only output: must not count
    asst("", { id: "c1", command: "gh pr list -R northwind/widgets --json url" }),
    result("c1", `${A}/widgets/pull/1\n${A}/widgets/pull/2\n${A}/widgets/pull/9`),
    // created via gh pr create and via pushpr
    asst("", { id: "c2", command: 'gh pr create -R northwind/widgets --title "x" --body "fixes 77"' }),
    result("c2", `${A}/widgets/pull/10`),
    asst("", { id: "c3", command: "pushpr octo/branch 2>&1 | tail -3" }),
    result("c3", `remote:\n${A}/gadgets/pull/20\n`),
    // acted: gh pr cmd with -R, in cwd repo, watchpr forms, gh api mutation; reads/listing ignored
    asst("", { id: "c4", command: 'gh pr merge 30 -R northwind/widgets --squash && gh pr comment 31 --body "see 99" && watchpr northwind/widgets#32 northwind/gadgets 33 | tail -3', cwd: "/work/gadgets" }),
    result("c4", `${A}/widgets/pull/500 merged`),
    asst("", { id: "c5", command: "gh api -X PUT repos/northwind/widgets/pulls/34/update-branch; gh api repos/northwind/widgets/pulls/35/comments --jq .[]" }),
    result("c5", "{}"),
    // heredoc fixtures and placeholders
    asst("", { id: "c6", command: "cat > t.sh <<'EOF'\ngh pr merge 40 -R northwind/widgets\nEOF\nwatchpr o/r#1" }),
    result("c6", `${A}/widgets/pull/41`),
    // discussed in assistant + user text, three syntaxes
    asst(`Look at ${A}/widgets/pull/50/files and northwind/widgets#51, also widgets #52 plus owner/repo#53 and gadgets #54.`),
    user(`what about ${A}/gadgets/pull/55 ?`),
    // a file read: contents must not count even if it has a URL
    asst("", { id: "c7", command: "cat docs.md" }),
    result("c7", `${A}/widgets/pull/60`),
    asst(`Another note on widgets #52 and ${A}/widgets/pull/52.`),
  ];
  const parsed = parseTranscript(lines.join("\n"), "/work/widgets");
  const refs = summarizeMentions(parsed, (cwd) => ({ "/work/gadgets": { owner: "northwind", name: "gadgets" }, "/work/widgets": { owner: "northwind", name: "widgets" } })[cwd] ?? null);
  const by = Object.fromEntries(refs.map((r) => [`${r.name}#${r.number}`, r.mention]));

  test("classifies created / acted / discussed", () => {
    expect(by["widgets#10"]!.role).toBe("created");
    expect(by["gadgets#20"]!.role).toBe("created");
    for (const k of ["widgets#30", "gadgets#31", "widgets#32", "gadgets#33", "widgets#34"]) expect(by[k]?.role).toBe("acted");
    for (const k of ["widgets#50", "widgets#51", "widgets#52", "gadgets#54", "gadgets#55"]) expect(by[k]?.role).toBe("discussed");
  });
  test("list-only, read-only, heredoc, flag-value and thinking references are excluded", () => {
    for (const k of ["widgets#1", "widgets#2", "widgets#9", "widgets#500", "widgets#60", "widgets#41", "widgets#40", "widgets#35", "widgets#99", "widgets#77", "ing#1"]) {
      expect(by[k]).toBeUndefined();
    }
  });
  test("placeholder repos are dropped", () => {
    expect(refs.some((r) => r.owner === "owner" || r.owner === "o")).toBe(false);
    expect(isPlaceholderRepo("owner", "repo")).toBe(true);
    expect(isPlaceholderRepo("o", "r")).toBe(true);
    expect(isPlaceholderRepo("foo", "bar")).toBe(true);
    expect(isPlaceholderRepo("northwind", "widgets")).toBe(false);
  });
  test("mention stats: line indexes, count per record, strongest role", () => {
    expect(by["widgets#52"]).toEqual({ first: 14, last: 18, count: 2, role: "discussed" });
    expect(by["widgets#10"]).toEqual({ first: 5, last: 5, count: 1, role: "created" });
  });
  test("analyzeCommand resolves cd and rejects non-PR commands", () => {
    const i = analyzeCommand("cd /w/x && gh pr checks 7 --watch", "/other");
    expect(i.hits).toEqual([{ role: "acted", cwd: "/w/x", number: 7 }]);
    expect(analyzeCommand("gh pr list; gh pr view; echo gh pr merge 5", null).hits).toEqual([]);
  });
});

describe("prReadiness / rankSessionPr", () => {
  const base = { state: "OPEN" as const, isDraft: false, author: "me", mergeable: "MERGEABLE" as const, reviewDecision: "APPROVED" as const, checks: [], unresolvedThreads: 0 };
  const ck = (state: "pass" | "fail" | "pending") => [{ name: "c", state, url: null }];
  const r = (o: object, v = "me") => rankSessionPr({ ...base, ...o }, v);
  test("readiness", () => {
    expect(prReadiness(base)).toBe("ready");
    expect(prReadiness({ ...base, reviewDecision: null, checks: ck("pass") })).toBe("ready");
    expect(prReadiness({ ...base, reviewDecision: "REVIEW_REQUIRED" })).toBe("needs-review");
    expect(prReadiness({ ...base, mergeable: "UNKNOWN" })).toBe("unknown");
    expect(prReadiness({ ...base, checks: ck("pending") })).toBe("pending");
    expect(prReadiness({ ...base, unresolvedThreads: 2 })).toBe("threads");
    expect(prReadiness({ ...base, isDraft: true })).toBe("draft");
    expect(prReadiness({ ...base, state: "MERGED" })).toBe("merged");
  });
  test("scores and next", () => {
    expect(r({})).toEqual({ score: 100, reason: "ready to merge", kind: "ready", next: true });
    expect(r({ reviewDecision: null, checks: ck("pass") }).score).toBe(100);
    expect(r({ checks: ck("fail") })).toMatchObject({ score: 80, reason: "checks failing", next: true });
    expect(r({ checks: ck("fail") }, "other")).toMatchObject({ score: 30, next: false });
    expect(r({ reviewDecision: "CHANGES_REQUESTED" })).toMatchObject({ score: 70, reason: "changes requested", next: true });
    expect(r({ mergeable: "CONFLICTING" })).toMatchObject({ score: 60, reason: "conflicts", next: true });
    expect(r({ reviewDecision: "REVIEW_REQUIRED" })).toMatchObject({ score: 50, reason: "needs review", next: false });
    expect(r({ checks: ck("pending") })).toMatchObject({ score: 40, next: false });
    expect(r({ isDraft: true })).toMatchObject({ score: 10, reason: "draft", next: false });
    expect(r({ state: "MERGED" })).toMatchObject({ score: 0, next: false });
  });
});

describe("sessionPrRefs", () => {
  test("uses the transcript whose title matches the pane; falls back to tern capture", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stk-sess-"));
    await mkdir(join(dir, "-proj"));
    const mk = (title: string, body: string) =>
      [JSON.stringify({ type: "title", title }), JSON.stringify({ type: "session", title, cwd: "/x" }), user(body)].join("\n");
    await writeFile(join(dir, "-proj", "a.jsonl"), mk("Mine", "x https://github.com/a/b/pull/1 y and https://github.com/o/r/pull/5"));
    await writeFile(join(dir, "-proj", "b.jsonl"), mk("Other", "https://github.com/a/b/pull/2"));
    const calls: string[][] = [];
    const lsOut = (title: string) =>
      JSON.stringify({ sessions: [{ tabs: [{ blocks: [{ id: 7, title, cwd: "/x" }] }] }] });
    const exec = (title: string): Exec => async (argv) => {
      calls.push([...argv]);
      if (argv[1] === "ls") return { code: 0, stdout: lsOut(title), stderr: "" };
      return { code: 0, stdout: "scroll https://github.com/q/w/pull/9", stderr: "" };
    };
    const hit = await sessionPrRefs(exec("Mine"), "7", { sessionsDir: dir });
    expect(hit.map((r) => r.number)).toEqual([1]);
    expect(hit[0]!.mention).toEqual({ first: 2, last: 2, count: 1, role: "discussed" });
    expect(calls.some((c) => c[1] === "capture")).toBe(false);
    const miss = await sessionPrRefs(exec("Nope"), "7", { sessionsDir: dir });
    expect(miss.map((r) => `${r.owner}/${r.name}#${r.number}`)).toEqual(["q/w#9"]);
  });
});

describe("agent pane resolution", () => {
  const blk = (id: number, title: string, extra: object = {}) => ({ id, title, cwd: "/p", program: "/bin/zsh", command: null, focused: false, live: true, ...extra });
  const STK_CMD = "'/home/u/.bun/bin/bun' '/home/u/projects/stk/src/cli.ts' tui --gh 'o/r'";
  // shaped like `tern ls --json`: tab 1 omp + stk(launched), tab 2 omp, tab 3 omp + this stk, tab 4 fresh shell + stk, other window omp
  const ls = {
    sessions: [
      {
        id: 4,
        tabs: [
          { id: 1, blocks: [blk(10, "AGENT one"), blk(11, "stk · session · AGENT one", { command: STK_CMD, focused: true })] },
          { id: 2, blocks: [blk(20, "AGENT two", { focused: true })] },
          { id: 3, blocks: [blk(30, "AGENT three", { focused: true }), blk(31, "stk · workspace ~/p (3 repos) · session · stk")] },
          { id: 4, blocks: [blk(40, "zsh"), blk(41, "stk · workspace ~/p (3 repos) · session · stk", { focused: true })] },
        ],
      },
      { id: 5, tabs: [{ id: 6, blocks: [blk(50, "AGENT far", { focused: true })] }] },
    ],
  };
  const all = (...ids: number[]) => new Map(ids.map((i, k) => [String(i), 1000 - k * 10]));
  const ranked = (origin: string, m: Map<string, number>) => rankAgentPanes(paneCandidates(ls, origin), origin, m).map((c) => c.id);

  test("stk panes are never candidates", () => {
    expect(paneCandidates(ls, "31").map((c) => c.id)).toEqual(["10", "20", "30", "40", "50"]);
  });
  test("a sibling omp pane of the same tab wins over other tabs", () => {
    // 20 has the freshest transcript but 30 shares the tab with stk pane 31
    expect(ranked("31", new Map([["10", 1], ["20", 999], ["30", 5], ["50", 2000]]))).toEqual(["30", "20", "10", "50"]);
  });
  test("a fresh tab with only a shell: most recently written session of the window, then other windows", () => {
    expect(ranked("41", new Map([["10", 100], ["20", 300], ["30", 200], ["50", 900]]))).toEqual(["20", "30", "10", "50"]);
  });
  test("panes without a transcript are dropped; none -> empty", () => {
    expect(ranked("41", new Map())).toEqual([]);
    expect(ranked("41", all(30))).toEqual(["30"]);
  });
  test("the origin leads when it is itself an agent pane", () => {
    expect(ranked("20", all(10, 20, 30))[0]).toBe("20");
  });
  test("agentPanes reads transcripts through tern ls", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stk-agent-"));
    await mkdir(join(dir, "-p"));
    const mk = (title: string) => [JSON.stringify({ type: "title", title }), JSON.stringify({ type: "session", title, cwd: "/p" })].join("\n");
    await writeFile(join(dir, "-p", "a.jsonl"), mk("AGENT three"));
    const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify(ls), stderr: "" });
    expect((await agentPanes(exec, "31", { sessionsDir: dir })).map((c) => c.id)).toEqual(["30"]);
    expect(await agentPanes(exec, "41", { sessionsDir: join(dir, "nope") })).toEqual([]);
  });
});
