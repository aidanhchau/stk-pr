import { describe, expect, test } from "bun:test";
import { StkError, type Exec } from "../src/types";
import { createStack, slugCtx } from "../src/service";

/** Classic chain 7 <- 8 <- 9 on main; `status` is what the stacks endpoint answers. */
function fake(o: { status?: number; body?: unknown; baseOf?: Record<number, string> } = {}) {
  const calls: { argv: string[]; stdin?: string }[] = [];
  const pr = (n: number) => ({
    number: n, title: `PR ${n}`, url: "", author: { login: "me" }, state: "OPEN", isDraft: false,
    headRefName: `b${n}`, baseRefName: o.baseOf?.[n] ?? (n === 7 ? "main" : `b${n - 1}`), headRefOid: `s${n}`, mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED", statusCheckRollup: null, createdAt: "", updatedAt: "", reviewThreads: { nodes: [] },
  });
  const exec: Exec = async (argv, opts) => {
    calls.push({ argv: [...argv], ...(opts?.stdin ? { stdin: opts.stdin } : {}) });
    const a = argv.join(" ");
    if (a.startsWith("gh repo view")) return { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: "main" } }), stderr: "" };
    const q = argv.find((x) => x.startsWith("query="));
    if (q) {
      const repository: Record<string, unknown> = {};
      for (const m of q.matchAll(/pr(\d+): pullRequest/g)) repository[`pr${m[1]}`] = pr(Number(m[1]));
      return { code: 0, stdout: JSON.stringify({ data: { repository } }), stderr: "" };
    }
    if (a.includes("/stacks")) {
      const status = o.status ?? 201;
      return { code: status < 300 ? 0 : 1, stdout: `HTTP/2.0 ${status} X\r\n\r\n${JSON.stringify(o.body ?? { number: 5, pull_requests: [{}, {}, {}] })}`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected ${a}` };
  };
  return { ctx: slugCtx(exec, { owner: "o", name: "r" }), calls };
}

describe("createStack", () => {
  test("POSTs the PRs bottom to top", async () => {
    const { ctx, calls } = fake();
    expect(await createStack(ctx, [7, 8, 9])).toEqual({ stack: 5, prs: [7, 8, 9] });
    const post = calls.find((c) => c.argv.join(" ").includes("/stacks"))!;
    expect(post.argv).toEqual(["gh", "api", "-i", "-X", "POST", "repos/o/r/stacks", "--input", "-"]);
    expect(JSON.parse(post.stdin!)).toEqual({ pull_requests: [7, 8, 9] });
  });

  test("a bottom PR not based on the trunk is refused before any request, saying what to do", async () => {
    const { ctx, calls } = fake({ baseOf: { 7: "old-branch" } });
    const e = (await createStack(ctx, [7, 8, 9]).catch((x: unknown) => x)) as StkError;
    expect(e.message).toBe("#7 targets old-branch, not main; retarget it to main first (:base)");
    expect(calls.some((c) => c.argv.join(" ").includes("/stacks"))).toBe(false);
  });

  test("a broken link in the chain is named", async () => {
    const { ctx } = fake({ baseOf: { 9: "main" } });
    const e = (await createStack(ctx, [7, 8, 9]).catch((x: unknown) => x)) as StkError;
    expect(e.message).toContain("#9 targets main, not b8");
  });

  test("422 and 404 map to readable errors", async () => {
    const r422 = (await createStack(fake({ status: 422, body: { message: "Validation Failed" } }).ctx, [7, 8]).catch((x: unknown) => x)) as StkError;
    expect(r422.message).toBe("GitHub cannot make these PRs a stack: Validation Failed");
    const r404 = (await createStack(fake({ status: 404, body: {} }).ctx, [7, 8]).catch((x: unknown) => x)) as StkError;
    expect(r404.message).toContain("could not find #7, #8");
  });
});
