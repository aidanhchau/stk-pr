import { afterEach, expect, spyOn, test } from "bun:test";
import { CliRenderer } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { stateActions, type PrFacts } from "../src/commands";
import { slugCtx, type BoardPr, type Ctx, type PrDetail } from "../src/service";
import type { Blocker } from "../src/types";
import { App } from "../src/tui/app";
import { Store, StoreContext, type AppState } from "../src/tui/store";
import { ThemeContext, dark } from "../src/tui/theme";

let setup: TestRendererSetup | null = null;
let restore: (() => void)[] = [];
afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
  for (const r of restore.splice(0)) r();
});

const repo = { owner: "o", name: "r" };
type Kind = "draft" | "open" | "closed" | "merged";
const prOf = (kind: Kind, n = 1): BoardPr => ({
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  author: "alice",
  state: kind === "closed" ? "CLOSED" : kind === "merged" ? "MERGED" : "OPEN",
  isDraft: kind === "draft",
  headRef: `b${n}`,
  baseRef: "main",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  headSha: `sha${n}`,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  checks: [],
  unresolvedThreads: 0,
  blockers: kind === "draft" ? [{ kind: "draft" } as Blocker] : [],
  body: "",
  worktree: null,
});
const detailOf = (kind: Kind): PrDetail => {
  const pr = prOf(kind);
  return { repo, pr, blockers: pr.blockers, threads: [], conversation: [], files: [], stack: null };
};

/** The real App over a seeded store whose gh calls are recorded, never run. */
async function renderApp(kind: Kind, screen: AppState["screen"], cursor: string | null, others = true) {
  const calls: string[][] = [];
  const exec = async (argv: readonly string[]) => {
    calls.push([...argv]);
    return { code: 0, stdout: "", stderr: "" };
  };
  const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
  spyOn(store, "init").mockResolvedValue(undefined);
  const loadPr = spyOn(store, "loadPr").mockResolvedValue(undefined);
  const loadScope = spyOn(store, "loadScope").mockResolvedValue(undefined);
  const seed = store as unknown as { set(p: Partial<AppState>): void; ctxs: Map<string, Promise<Ctx>> };
  seed.ctxs.set("o/r", Promise.resolve(slugCtx(exec, repo)));
  seed.set({
    screen,
    boardCursor: cursor,
    boards: { mine: { status: "ready", data: { repo, trunk: "main", prs: [prOf(kind), ...(others ? [prOf("open", 2)] : [])].map((p) => ({ ...p, repo })) }, refreshing: false } },
    prCache: { "o/r#1": { status: "ready", data: detailOf(kind), refreshing: false, at: Date.now() } },
  });
  const title = spyOn(CliRenderer.prototype, "setTerminalTitle").mockImplementation(() => {});
  restore.push(() => {
    title.mockRestore();
    loadPr.mockRestore();
    loadScope.mockRestore();
    store.dispose();
  });
  setup = await testRender(
    <ThemeContext.Provider value={{ name: "dark", p: dark }}>
      <StoreContext.Provider value={store}>
        <App />
      </StoreContext.Provider>
    </ThemeContext.Provider>,
    { width: 100, height: 30, kittyKeyboard: true },
  );
  await setup.renderOnce();
  const s = setup;
  const frame = async () => {
    for (let i = 0; i < 4; i++) await s.renderOnce();
    return s.captureCharFrame();
  };
  return { s, store, calls, loadPr, frame };
}

const page = (kind: Kind) => renderApp(kind, { kind: "pr", repo, n: 1, scope: "mine" }, null);
const board = (kind: Kind) => renderApp(kind, { kind: "board", scope: "mine" }, "o/r#1", kind !== "merged");

const facts = (state: PrFacts["state"], isDraft: boolean): PrFacts => ({
  state,
  isDraft,
  failingChecks: false,
  behind: false,
  baseMerged: false,
  inStack: false,
  nativeStack: false,
  hasWorktree: false,
  onPage: true,
});

test("state actions per PR state: draft, open, closed, merged", () => {
  expect(stateActions(facts("OPEN", true)).map((a) => a.id)).toEqual(["ready", "close"]);
  expect(stateActions(facts("OPEN", false)).map((a) => a.id)).toEqual(["draft", "close"]);
  expect(stateActions(facts("CLOSED", false)).map((a) => a.id)).toEqual(["reopen"]);
  expect(stateActions(facts("MERGED", false))).toEqual([]);
  expect(stateActions(null)).toEqual([]);
});

test("p on a draft PR page lists only ready and close", async () => {
  const { s, store, frame } = await page("draft");
  s.mockInput.pressKey("p");
  const text = await frame();
  expect(store.getState().sheet).toEqual({ kind: "state" });
  expect(text).toContain("Ready for review");
  expect(text).toContain("Close");
  expect(text).not.toContain("Convert to draft");
  expect(text).not.toContain("Reopen");
});

test("p on an open PR page lists convert to draft and close", async () => {
  const { s, frame } = await page("open");
  s.mockInput.pressKey("p");
  const text = await frame();
  expect(text).toContain("Convert to draft");
  expect(text).toContain("Close");
  expect(text).not.toContain("Ready for review");
});

test("p on a closed PR lists only reopen, and r reopens through the existing command", async () => {
  const { s, calls, store, frame } = await page("closed");
  s.mockInput.pressKey("p");
  const text = await frame();
  expect(text).toContain("Reopen");
  expect(text).not.toContain("asks first");
  s.mockInput.pressKey("o");
  await frame();
  expect(store.getState().sheet).toBeNull();
  expect(calls.map((c) => c.join(" "))).toEqual(["gh pr reopen 1 -R o/r"]);
});

test("a merged PR has no State pill and p only toasts", async () => {
  const { s, store, frame } = await page("merged");
  expect(await frame()).not.toContain("State p");
  s.mockInput.pressKey("p");
  await frame();
  expect(store.getState().sheet).toBeNull();
  expect(store.getState().toasts.some((t) => t.text.includes("is merged"))).toBe(true);
});

test("the State pill shows on a draft PR page", async () => {
  const { frame } = await page("draft");
  expect(await frame()).toContain("State p");
});

test("r marks a draft ready right away (no confirm)", async () => {
  const { s, calls, store, frame } = await page("draft");
  s.mockInput.pressKey("p");
  await frame();
  s.mockInput.pressKey("r");
  await frame();
  expect(store.getState().sheet).toBeNull();
  expect(calls.map((c) => c.join(" "))).toEqual(["gh pr ready 1 -R o/r"]);
});

test("c closes only after the confirm sheet", async () => {
  const { s, calls, store, frame } = await page("open");
  s.mockInput.pressKey("p");
  await frame();
  s.mockInput.pressKey("c");
  const text = await frame();
  expect(store.getState().sheet?.kind).toBe("confirm");
  expect(text).toContain("Close #1");
  expect(calls).toEqual([]);
  s.mockInput.pressEnter();
  await frame();
  expect(calls.map((c) => c.join(" "))).toEqual(["gh pr close 1 -R o/r"]);
});

test("d converts an open PR to draft only after the confirm sheet", async () => {
  const { s, calls, store, frame } = await page("open");
  s.mockInput.pressKey("p");
  await frame();
  s.mockInput.pressKey("d");
  await frame();
  expect(store.getState().sheet?.kind).toBe("confirm");
  expect(calls).toEqual([]);
  s.mockInput.pressEnter();
  await frame();
  expect(calls.map((c) => c.join(" "))).toEqual(["gh pr ready 1 --undo -R o/r"]);
});

test("⏎ on the selected row runs it; j moves the selection", async () => {
  const { s, calls, store, frame } = await page("draft");
  s.mockInput.pressKey("p");
  await frame();
  s.mockInput.pressKey("j");
  await frame();
  s.mockInput.pressEnter();
  await frame();
  expect(store.getState().sheet?.kind).toBe("confirm");
  expect(calls).toEqual([]);
});

test("esc closes the sheet without running anything", async () => {
  const { s, calls, store, frame } = await page("draft");
  s.mockInput.pressKey("p");
  await frame();
  s.mockInput.pressEscape();
  await frame();
  expect(store.getState().sheet).toBeNull();
  expect(calls).toEqual([]);
});

test("the Draft blocker reads ⏎ mark ready for review, and ⏎ on it marks the PR ready", async () => {
  const { s, calls, frame } = await page("draft");
  expect(await frame()).toContain("⏎ mark ready for review");
  s.mockInput.pressEnter();
  await frame();
  expect(calls.map((c) => c.join(" "))).toEqual(["gh pr ready 1 -R o/r"]);
});

test("a successful change refreshes the PR page", async () => {
  const { s, loadPr, frame } = await page("draft");
  s.mockInput.pressKey("p");
  await frame();
  s.mockInput.pressKey("r");
  await frame();
  expect(loadPr).toHaveBeenCalledWith(1, expect.objectContaining({ force: true }));
});

test("p on the board opens the sheet for the selected row", async () => {
  const { s, store, frame } = await board("open");
  s.mockInput.pressKey("p");
  const text = await frame();
  expect(store.getState().sheet).toEqual({ kind: "state" });
  expect(text).toContain("Convert to draft");
});

test("on the board, r in the sheet marks the selected draft ready", async () => {
  const { s, calls, frame } = await board("draft");
  s.mockInput.pressKey("p");
  await frame();
  s.mockInput.pressKey("r");
  await frame();
  expect(calls.map((c) => c.join(" "))).toEqual(["gh pr ready 1 -R o/r"]);
});

test("on the board, p on a merged row toasts and opens no sheet", async () => {
  const { s, store, frame } = await board("merged");
  s.mockInput.pressKey("p");
  await frame();
  expect(store.getState().sheet).toBeNull();
});

test("on a fresh board (no stored cursor), p acts on the highlighted row", async () => {
  const { s, store, frame } = await renderApp("draft", { kind: "board", scope: "mine" }, null);
  s.mockInput.pressKey("p");
  const text = await frame();
  expect(store.getState().sheet).toEqual({ kind: "state" });
  const cursor = store.getState().boardCursor;
  expect(cursor).toMatch(/^o\/r#[12]$/);
  expect(text).toContain(`#${cursor!.slice(-1)} ·`);
});

test("on a filtered board, p acts on the visible row, not the hidden stored cursor", async () => {
  const { s, store, calls, frame } = await renderApp("draft", { kind: "board", scope: "mine" }, "o/r#2");
  s.mockInput.pressKey("/");
  await frame();
  await s.mockInput.typeText("Change 1");
  await frame();
  s.mockInput.pressEnter();
  await frame();
  s.mockInput.pressKey("p");
  const text = await frame();
  expect(store.getState().boardCursor).toBe("o/r#1");
  expect(text).toContain("#1 · draft");
  s.mockInput.pressKey("r");
  await frame();
  expect(calls.map((c) => c.join(" "))).toEqual(["gh pr ready 1 -R o/r"]);
});
