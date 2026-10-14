import { describe, expect, test } from "bun:test";
import type { Exec } from "../src/types";
import { clearRulesCache, slugCtx, stackInfo } from "../src/service";

const CHAIN = [101, 102, 103, 104, 105, 106];

/** Recording fake GitHub for a 6-PR native stack on main: #103 needs review, #104 has an unresolved thread. */
function recordingGithub(o: { draft?: number[]; merged?: number[] } = {}): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  const member = (n: number) => {
    const at = CHAIN.indexOf(n);
    return {
      number: n, title: `PR ${n}`, url: `https://github.com/o/r/pull/${n}`, author: { login: "me" }, state: o.merged?.includes(n) ? "MERGED" : "OPEN", isDraft: o.draft?.includes(n) ?? false,
      headRefName: `b${n}`, baseRefName: at > 0 ? `b${CHAIN[at - 1]}` : "main", headRefOid: `sha${n}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
      reviewDecision: n === 103 ? "REVIEW_REQUIRED" : "APPROVED",
      statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name: "ci", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: null }] } },
      createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z",
      reviewThreads: { nodes: n === 104 ? [{ isResolved: false }, { isResolved: true }] : [] },
    };
  };
  const exec: Exec = async (argv) => {
    calls.push([...argv]);
    const query = argv.find((x) => x.startsWith("query=")) ?? "";
    if (query.includes("stackEntry")) {
      const nodes = CHAIN.map((n, i) => ({ position: i + 1, pullRequest: member(n) }));
      const repository = { defaultBranchRef: { name: "main" }, pullRequest: { stackEntry: { position: 6 }, stack: { size: 6, entries: { nodes } } } };
      return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh call: ${argv.join(" ")}` };
  };
  return { exec, calls };
}

describe("stackInfo on a native stack", () => {
  test("plans a 6-PR stack in a single GraphQL call", async () => {
    clearRulesCache();
    const { exec, calls } = recordingGithub();
    const info = await stackInfo(slugCtx(exec, { owner: "o", name: "r" }), 106, { method: "squash", force: false });
    // one GraphQL call for the whole stack, plus the cached branch-rules lookup
    expect(calls.length).toBe(2);
    expect(calls[0]!.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
    expect(info.stack.native).toBe(true);
    expect(info.stack.prs.map((p) => p.number)).toEqual(CHAIN);
    expect(info.forks).toEqual([]);
    // #103 needs review: the plan lands only the unblocked prefix (#101, #102)
    expect(info.plan).toEqual([
      { kind: "merge", pr: 102, method: "squash", admin: false, bypass: [], sha: "sha102", includes: [101, 102] },
    ]);
    expect(info.blockers).toEqual({
      101: [],
      102: [],
      103: [{ kind: "review", decision: "REVIEW_REQUIRED" }],
      104: [{ kind: "threads", count: 1 }],
      105: [],
      106: [],
    });
  });

  test("force merges each PR that needs a bypass on its own, bottom-up; clean runs land as one merge", async () => {
    const { exec, calls } = recordingGithub();
    const info = await stackInfo(slugCtx(exec, { owner: "o", name: "r" }), 106, { method: "squash", force: true });
    expect(calls.length).toBe(1);
    expect(info.plan).toEqual([
      { kind: "merge", pr: 102, method: "squash", admin: false, bypass: [], sha: "sha102", includes: [101, 102] },
      { kind: "merge", pr: 103, method: "squash", admin: true, bypass: [{ kind: "review", decision: "REVIEW_REQUIRED" }], sha: "sha103", includes: [103] },
      { kind: "merge", pr: 104, method: "squash", admin: true, bypass: [{ kind: "threads", count: 1 }], sha: "sha104", includes: [104] },
      { kind: "merge", pr: 106, method: "squash", admin: false, bypass: [], sha: "sha106", includes: [105, 106] },
    ]);
  });

  test("merge up to a chosen PR lands only the stack below it", async () => {
    const { exec } = recordingGithub();
    const info = await stackInfo(slugCtx(exec, { owner: "o", name: "r" }), 106, { method: "squash", force: false, upTo: 102 });
    expect(info.target).toBe(102);
    expect(info.stop).toBeNull();
    expect(info.stack.prs.map((p) => p.number)).toEqual(CHAIN);
    expect(info.plan).toEqual([{ kind: "merge", pr: 102, method: "squash", admin: false, bypass: [], sha: "sha102", includes: [101, 102] }]);
  });

  test("a draft below the target stops the plan there: no merge step above it, and the reason names the draft", async () => {
    const { exec } = recordingGithub({ draft: [104] });
    const info = await stackInfo(slugCtx(exec, { owner: "o", name: "r" }), 106, { method: "squash", force: true, upTo: "top" });
    const merges = info.plan.filter((s) => s.kind === "merge");
    // #103 needs a bypass so it lands alone after #101-#102; nothing above the draft #104 is planned
    expect(merges.map((m) => m.pr)).toEqual([102, 103]);
    expect(merges[1]).toMatchObject({ pr: 103, admin: true, includes: [103] });
    expect(info.plan.some((s) => "pr" in s && s.pr > 103)).toBe(false);
    expect(info.stop).toEqual({ pr: 104, reason: "#104 is a draft" });
  });

  test("an unforced stop names the real blockers", async () => {
    const { exec } = recordingGithub();
    const info = await stackInfo(slugCtx(exec, { owner: "o", name: "r" }), 106, { method: "squash", force: false, upTo: "top" });
    expect(info.stop?.pr).toBe(103);
    expect(info.stop?.reason).toContain("#103 is blocked");
  });

  test("a bottom PR based on a merged branch is flagged with a manual fix, never retargeted", async () => {
    const { exec, calls } = recordingGithub({ merged: [101] });
    const info = await stackInfo(slugCtx(exec, { owner: "o", name: "r" }), 106, { method: "squash", force: true, upTo: "top" });
    expect(calls.length).toBe(1);
    expect(info.stack.prs.map((p) => p.number)).toEqual([102, 103, 104, 105, 106]);
    expect(info.plan.some((s) => s.kind === "retarget")).toBe(false);
    expect(info.blockers[102]).toEqual([]);
    expect(info.notes).toHaveLength(1);
    expect(info.notes[0]).toMatchObject({ pr: 102 });
    expect(info.notes[0]!.text).toBe("#102's base is a merged branch (b101)");
    expect(info.notes[0]!.fix).toContain("Rebase stack");
  });
});

describe("gh call list", () => {
  test("a native stack plans with the native query only: no pr list, no repo view for the trunk", async () => {
    const { exec, calls } = recordingGithub();
    await stackInfo(slugCtx(exec, { owner: "o", name: "r" }), 106, { method: "squash", force: false });
    const kinds = calls.map((c) => (c[1] === "pr" ? "pr list" : c[1] === "repo" ? "repo view" : c.some((x) => x.startsWith("query=")) ? "graphql" : c.join(" ")));
    expect(kinds.filter((k) => k === "pr list" || k === "repo view")).toEqual([]);
    expect(kinds.filter((k) => k === "graphql")).toHaveLength(1);
  });
});
