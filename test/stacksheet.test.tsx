import { afterEach, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StackInfo } from "../src/service";
import { StackSheet } from "../src/tui/sheets";
import { Store, StoreContext, type Outcome } from "../src/tui/store";
import { ThemeContext, dark } from "../src/tui/theme";
import type { PlanStep, PullRequest } from "../src/types";

let setup: TestRendererSetup | null = null;
afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

const pr = (number: number, title: string, baseRef: string, headRef: string): PullRequest =>
  ({ number, title, baseRef, headRef, headSha: `sha${number}`, state: "OPEN", isDraft: false, reviewDecision: "REVIEW_REQUIRED", checks: [], unresolvedThreads: 0 }) as unknown as PullRequest;

const review = { kind: "review", decision: "REVIEW_REQUIRED" } as const;
const merge = (n: number): PlanStep => ({ kind: "merge", pr: n, method: "squash", admin: true, bypass: [review], sha: `sha${n}`, includes: [n] });

function info(o: { wt: "none" | "detached" }): StackInfo {
  const a = pr(2462, "CI: run the Atlas lane one direction at a time (fixes OOM / exit 137 in step 7)", "main", "aidan/ci-atlas-lane");
  const b = pr(2463, "Queue chief-of-staff Slack answers and DMs for cosd to pull", "aidan/ci-atlas-lane", "aidan/cos-slack-answers");
  return {
    stack: { trunk: "main", prs: [a, b], native: true },
    forks: [],
    plan: [merge(2462), merge(2463)],
    blockers: { 2462: [review], 2463: [review] },
    target: 2463,
    stop: null,
    notes: [],
    rebaseWorktrees: [{ pr: 2463, branch: "aidan/cos-slack-answers", kind: o.wt, ...(o.wt === "none" ? {} : { path: "/wt/cos" }) }],
  };
}

class Stub extends Store {
  constructor(private readonly out: StackInfo) {
    super("/nonexistent", { gh: { owner: "maple", name: "maple-gtm" } });
  }
  override async stackInfo(): Promise<Outcome<StackInfo>> {
    return { ok: true, value: this.out };
  }
}

async function render(i: StackInfo): Promise<string> {
  setup = await testRender(
    <ThemeContext.Provider value={{ name: "dark", p: dark }}>
      <StoreContext.Provider value={new Stub(i)}>
        <StackSheet n={2462} />
      </StoreContext.Provider>
    </ThemeContext.Provider>,
    { width: 96, height: 42 },
  );
  await setup.renderOnce();
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n").map((l) => l.trimEnd()).join("\n");
}

test("the stack is drawn top PR first with the base branch at the bottom, merge order numbered, and the plan says why", async () => {
  const text = await render(info({ wt: "none" }));
  if (process.env.STK_PRINT) console.log(text);
  const rows = text.split("\n");
  const at = (s: string) => rows.findIndex((l) => l.includes(s));
  expect(text).toContain("main ← #2462 ← #2463");
  expect(text).toContain("Merges #2462 into main, then #2463, squashing each; bypasses review on both.");
  // bottom-to-top: #2463 above #2462 above main
  expect(at("#2463  Queue")).toBeLessThan(at("#2462  CI: run"));
  expect(at("#2462  CI: run")).toBeLessThan(at("base branch"));
  expect(text).toContain("needs review · will bypass");
  expect(text).toContain("opened here");
  expect(text).toContain("after #2462 lands");
  // the rebase sits between the two merges
  expect(at("1. Merge #2462")).toBeLessThan(at("2. Rebase #2463"));
  expect(at("2. Rebase #2463")).toBeLessThan(at("3. Merge #2463"));
  expect(text).toContain("no worktree has aidan/cos-slack-answers checked out; c creates one");
  expect(text).toContain("c create worktree");
});

test("a detached worktree at the tip is reported as usable", async () => {
  const text = await render(info({ wt: "detached" }));
  expect(text).toContain("detached at the branch tip");
  expect(text).not.toContain("c create worktree");
});
