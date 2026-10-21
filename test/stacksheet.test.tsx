import { afterEach, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { StackInfo } from "../src/service";
import { StackSheet } from "../src/tui/sheets";
import { Store, StoreContext, repoKey, type Outcome } from "../src/tui/store";
import { ThemeContext, dark } from "../src/tui/theme";
import type { Job } from "../src/jobs";
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

const A = pr(2462, "CI: run the Atlas lane one direction at a time (fixes OOM / exit 137 in step 7)", "main", "aidan/ci-atlas-lane");
const B = pr(2463, "Queue chief-of-staff Slack answers and DMs for cosd to pull", "aidan/ci-atlas-lane", "aidan/cos-slack-answers");
const C = pr(2464, "Show the queue depth in the cosd status line", "aidan/cos-slack-answers", "aidan/cos-queue-depth");

/** The plan the service makes for a native stack of `prs` landed up to `target`. */
function infoFor(prs: PullRequest[], target: number): StackInfo {
  return {
    stack: { trunk: "main", prs, native: true },
    forks: [],
    plan: prs.filter((p) => p.number <= target).map((p) => merge(p.number)),
    blockers: Object.fromEntries(prs.map((p) => [p.number, [review]])),
    target,
    stop: null,
    notes: [],
    method: "squash",
  };
}

class Stub extends Store {
  /** The `upTo` of every plan the sheet asked for. */
  readonly asked: (number | "top")[] = [];
  constructor(private readonly prs: PullRequest[]) {
    super("/nonexistent", { gh: { owner: "maple", name: "maple-gtm" } });
  }
  override async stackInfo(_n: number, _method: unknown, _force: boolean, upTo: number | "top" = "top"): Promise<Outcome<StackInfo>> {
    this.asked.push(upTo);
    return { ok: true, value: infoFor(this.prs, upTo === "top" ? this.prs[this.prs.length - 1]!.number : upTo) };
  }
}

/** The frame's text without the sheet border, with wrapped lines joined. */
const flat = (t: string) => t.split("\n").map((l) => l.replace(/^\s*│|│\s*$/g, "").trim()).filter(Boolean).join(" ");

const frame = () => setup!.captureCharFrame().split("\n").map((l) => l.trimEnd()).join("\n");

async function settle(): Promise<string> {
  await setup!.renderOnce();
  await Bun.sleep(20);
  await setup!.renderOnce();
  return frame();
}

async function mount(prs: PullRequest[], props: { n: number; upTo?: number | "top" }, jobs: Job[] = []) {
  const store = new Stub(prs);
  const seeded = Object.fromEntries(jobs.map((j) => [`${repoKey(j.repo)}#${j.pr}`, j]));
  (store as unknown as { set: (p: object) => void }).set({ jobs: seeded });
  setup = await testRender(
    <ThemeContext.Provider value={{ name: "dark", p: dark }}>
      <StoreContext.Provider value={store}>
        <StackSheet {...props} />
      </StoreContext.Provider>
    </ThemeContext.Provider>,
    { width: 96, height: 46 },
  );
  await setup.renderOnce();
  return { store, text: await settle() };
}

test("the stack is drawn top PR first with the base branch at the bottom, merge order numbered, and the plan says why", async () => {
  const { text } = await mount([A, B], { n: 2463 });
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
});

test("the rebase step says it runs in a temporary checkout and never offers a worktree", async () => {
  const { text } = await mount([A, B], { n: 2463 });
  expect(flat(text)).toContain("runs in a temporary checkout");
  expect(text).not.toContain("worktree");
});

test("opened on the bottom PR, only that PR is planned and the PRs above it stay open", async () => {
  const { store, text } = await mount([A, B, C], { n: 2462 });
  if (process.env.STK_PRINT) console.log(text);
  expect(store.asked.at(-1)).toBe(2462);
  expect(flat(text)).toContain("Merges #2462 into main, squashing it; bypasses review on #2462. #2463 and #2464 stay open.");
  expect(text.match(/stays open/g)).toHaveLength(2);
  expect(text).toMatch(/▸\s+── merge up to here/);
  expect(text).toContain("opened here");
  expect(text).toContain("1. Merge #2462");
  expect(text).not.toContain("Merge #2463");
  expect(text).not.toContain("Rebase #2463");
  expect(flat(text)).toContain("#2463 and #2464 will need a stack rebase before they merge.");
  expect(text).toContain("↑↓ pick · ⏎ merge up to here");
  // the rule sits between the PRs that stay open and the one that merges
  const rows = text.split("\n");
  const at = (s: string) => rows.findIndex((l) => l.includes(s));
  expect(at("#2463  Queue")).toBeLessThan(at("merge up to here ─"));
  expect(at("merge up to here ─")).toBeLessThan(at("#2462  CI: run"));
});

test("opened on the top PR, the whole stack is planned", async () => {
  const { store, text } = await mount([A, B, C], { n: 2464 });
  expect(store.asked.at(-1)).toBe(2464);
  expect(flat(text)).toContain("Merges #2462 into main, then #2463, then #2464, squashing each; bypasses review on all 3.");
  expect(text).not.toContain("stays open");
  expect(text).not.toContain("stack rebase before");
  expect(text).not.toContain("merge up to here ─");
});

test("⏎ on another row makes it the merge target", async () => {
  const { store } = await mount([A, B, C], { n: 2462 });
  setup!.mockInput.pressArrow("up");
  await settle();
  setup!.mockInput.pressEnter();
  const text = await settle();
  expect(store.asked.at(-1)).toBe(2463);
  expect(flat(text)).toContain("Merges #2462 into main, then #2463, squashing each; bypasses review on both. #2464 stays open.");
  expect(text.match(/stays open/g)).toHaveLength(2);
  expect(text).toContain("#2464 will need a stack rebase before it merges.");
  // up to the top again: the whole stack, nothing left open
  setup!.mockInput.pressArrow("up");
  await settle();
  setup!.mockInput.pressEnter();
  const whole = await settle();
  expect(store.asked.at(-1)).toBe("top");
  expect(whole).not.toContain("stays open");
});

test("an explicit upTo wins over the PR the sheet was opened on", async () => {
  const { store, text } = await mount([A, B, C], { n: 2462, upTo: 2463 });
  expect(store.asked.at(-1)).toBe(2463);
  expect(text).toContain("#2464 stays open");
  setup!.renderer.destroy();
  const whole = await mount([A, B, C], { n: 2462, upTo: "top" });
  expect(whole.store.asked.at(-1)).toBe("top");
  expect(whole.text).not.toContain("stays open");
  // opened on the whole stack from elsewhere (the board), so no PR is "opened here"
  expect(whole.text).not.toContain("opened here");
});

test("reopened from a lower member, the sheet shows the running whole-stack job instead of planning again", async () => {
  const repo = { owner: "maple", name: "maple-gtm" };
  const job: Job = {
    id: "j1",
    kind: "stack-merge",
    repo,
    pr: 2464,
    method: "squash",
    force: true,
    status: "running",
    steps: [],
    total: 3,
    plan: [merge(2462), merge(2463), merge(2464)],
    prs: [2462, 2463, 2464],
    pid: process.pid,
    startedAt: 1,
    updatedAt: 1,
  };
  const { text } = await mount([A, B, C], { n: 2462 }, [job]);
  expect(text).toContain("runs in background");
  expect(text).not.toContain("merge up to here ·");
});

test("right after a stack merge starts, before its job has a plan, the sheet keeps the plan and never says nothing can be merged", async () => {
  const repo = { owner: "maple", name: "maple-gtm" };
  const { store } = await mount([A, B], { n: 2463 });
  // the runner writes the job at once but adds its plan only after it has re-read the stack
  const job: Job = { id: "j2", kind: "stack-merge", repo, pr: 2463, method: "squash", force: true, status: "running", steps: [], total: 0, prs: [2462, 2463], pid: process.pid, startedAt: 1, updatedAt: 1 };
  (store as unknown as { set: (p: object) => void }).set({ jobs: { [`${repoKey(repo)}#2463`]: job } });
  const text = await settle();
  if (process.env.STK_PRINT) console.log(text);
  expect(text).not.toContain("Nothing can be merged");
  expect(text).toContain("1. Merge #2462");
  expect(text).toContain("3. Merge #2463");
});
