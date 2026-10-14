import { describe, expect, test } from "bun:test";
import { commitHistory } from "../src/github";
import { prCommits, slugCtx } from "../src/service";
import type { Exec } from "../src/types";

const repo = { owner: "o", name: "history" };
const page = <T>(nodes: T[], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
const run = (name: string, databaseId: number, conclusion: string | null = "SUCCESS") => ({
  __typename: "CheckRun", name, databaseId, status: conclusion ? "COMPLETED" : "QUEUED", conclusion,
  detailsUrl: `https://checks/${databaseId}`, startedAt: conclusion ? "2026-10-01T00:00:00Z" : null, checkSuite: { app: { databaseId: 1 } },
});
const commit = (i: number) => ({ commit: {
  id: `node${i}`, oid: `sha${i}`, messageHeadline: `Commit ${i}`, committedDate: `2026-10-01T00:00:00Z`,
  url: `https://github.com/o/history/commit/sha${i}`, author: { name: "Contributor", user: { login: "author" } }, statusCheckRollup: null as unknown,
} });

describe("PR commit history", () => {
  test("paginates commits and contexts independently; newest queued rerun replaces historical success", async () => {
    const seen: string[][] = [];
    const first = Array.from({ length: 100 }, (_, i) => commit(i));
    first[0]!.commit.statusCheckRollup = { contexts: page([
      run("ci", 200, null), ...Array.from({ length: 99 }, (_, i) => run(`job${i}`, i)),
    ], "checks100") };
    const exec: Exec = async (argv) => {
      seen.push([...argv]);
      expect(argv.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
      const query = argv.find((a) => a.startsWith("query="))!;
      let data: unknown;
      if (query.includes("node(id: $id)")) {
        expect(argv).toContain("id=node0");
        expect(argv).toContain("c=checks100");
        data = { node: { statusCheckRollup: { contexts: page([
          run("ci", 100),
          { __typename: "StatusContext", context: "deploy", state: "SUCCESS", targetUrl: "https://deploy/old", createdAt: "2026-09-30" },
          { __typename: "StatusContext", context: "deploy", state: "FAILURE", targetUrl: "https://deploy/new", createdAt: "2026-10-01" },
        ]) } } };
      } else {
        expect(argv).toContain("o=o");
        expect(argv).toContain("r=history");
        expect(argv).toContain("n=2417");
        data = { repository: { pullRequest: { commits: argv.includes("c=commits100") ? page([commit(100)]) : page(first, "commits100") } } };
      }
      return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
    };
    const history = await prCommits(slugCtx(exec, repo), 2417);
    expect(seen).toHaveLength(3);
    expect(history).toHaveLength(101);
    expect(history[0]).toMatchObject({ sha: "sha0", message: "Commit 0", author: "author" });
    expect(history[100]!.sha).toBe("sha100");
    expect(history[0]!.checks).toHaveLength(101);
    expect(history[0]!.checks.find((c) => c.name === "ci")).toMatchObject({ state: "pending", url: "https://checks/200" });
    expect(history[0]!.checks.find((c) => c.name === "deploy")).toMatchObject({ state: "fail", url: "https://deploy/new" });
    expect(history[100]!.checks).toEqual([]);
  });

  test("nullable run IDs use timestamps without hiding a newer failure or reviving older results", async () => {
    const subject = commit(0);
    subject.commit.statusCheckRollup = { contexts: page([
      { ...run("new-null", 100), startedAt: "2026-10-01T00:00:00Z" },
      { ...run("new-null", 101, "FAILURE"), databaseId: null, startedAt: "2026-10-02T00:00:00Z", detailsUrl: "https://checks/new-null" },
      { ...run("old-null", 200, "FAILURE"), startedAt: "2026-10-02T00:00:00Z" },
      { ...run("old-null", 201), databaseId: null, startedAt: "2026-10-01T00:00:00Z" },
      { ...run("both-null", 300, "FAILURE"), databaseId: null, startedAt: "2026-10-02T00:00:00Z" },
      { ...run("both-null", 301), databaseId: null, startedAt: "2026-10-01T00:00:00Z" },
    ]) };
    const exec: Exec = async () => ({
      code: 0, stderr: "",
      stdout: JSON.stringify({ data: { repository: { pullRequest: { commits: page([subject]) } } } }),
    });
    const history = await commitHistory(exec, repo, 2417);
    expect(history[0]!.checks).toEqual([
      { name: "new-null", state: "fail", url: "https://checks/new-null" },
      { name: "old-null", state: "fail", url: "https://checks/200" },
      { name: "both-null", state: "fail", url: "https://checks/300" },
    ]);
  });

  test("does not turn unavailable history or a partial GraphQL response into empty success", async () => {
    const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify({ data: { repository: { pullRequest: null } }, errors: [{ message: "Access denied" }] }), stderr: "" });
    await expect(commitHistory(exec, repo, 2417)).rejects.toThrow("Access denied");
  });
});
