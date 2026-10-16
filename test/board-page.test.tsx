import { afterEach, expect, spyOn, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import type { BoardPr, PrDetail, RepoSlug } from "../src/service";
import { Board } from "../src/tui/board";
import { Store, StoreContext, useStore, type AppState } from "../src/tui/store";
import { ThemeContext, dark, reducedMotion, setReducedMotionPref } from "../src/tui/theme";
import { Dock, DockCommands, DockCount, DockInput, DockModeHint, Page } from "../src/tui/ui";

let setup: TestRendererSetup | null = null;
let cleanup: (() => void) | null = null;
afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
  cleanup?.();
  cleanup = null;
});

const repo: RepoSlug = { owner: "acme", name: "launch" };
const otherRepo: RepoSlug = { owner: "acme", name: "widgets" };
type BoardEntry = BoardPr & { repo: RepoSlug };
const keyOf = (pr: BoardEntry) => `${pr.repo.owner}/${pr.repo.name}#${pr.number}`;
const rowOf = (frame: string[], text: string) => frame.findIndex((line) => line.includes(text));

function largeBoard(): BoardEntry[] {
  return Array.from({ length: 70 }, (_, i): BoardEntry => ({
    repo: i === 4 || i === 65 || i === 68 ? otherRepo : repo,
    number: 1001 + i,
    title: i === 65 ? "Far-down board target" : i === 68 ? "Search-only distant target" : `Board change ${String(i + 1).padStart(3, "0")}`,
    url: `https://example.test/pr/${1001 + i}`,
    author: "alice",
    state: "OPEN",
    isDraft: false,
    headRef: `change-${1001 + i}`,
    baseRef: "main",
    createdAt: "2019-12-01T00:00:00Z",
    // Fixed, descending timestamps keep all rows in one bucket and in the same order across runs.
    updatedAt: new Date(Date.parse("2020-01-01T12:00:00Z") - i * 60_000).toISOString(),
    headSha: `sha-${1001 + i}`,
    mergeable: "MERGEABLE",
    reviewDecision: "APPROVED",
    checks: [],
    unresolvedThreads: 0,
    blockers: [],
    body: "",
    worktree: null,
  }));
}

function BoardPage() {
  const line = useStore((s) => s.searchLine);
  return (
    <box width="100%" height="100%" flexDirection="column">
      <Page><Board scope="mine" /></Page>
      <Dock
        top={line?.active ? <DockInput line={line} /> : <DockCommands />}
        status={line ? <DockModeHint line={line} /> : null}
        count={line ? <DockCount line={line} /> : null}
      />
    </box>
  );
}

async function renderBoard(prs = largeBoard()) {
  const previousMotion = reducedMotion();
  const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
  // Cursor-follow should settle without waiting for animation timers; this is not a timing test.
  store.setReducedMotion(true);
  const loadPr = spyOn(store, "loadPr").mockResolvedValue(undefined);
  // `set` is private; seed typed board/cache snapshots without loading a repo or contacting GitHub.
  const seed = store as unknown as { set(patch: Partial<AppState>): void };
  cleanup = () => {
    // Clear the cursor's pending dwell prefetch before disposing this isolated store.
    seed.set({ screen: { kind: "board", scope: "mine" } });
    store.setBoardCursor(null);
    store.dispose();
    loadPr.mockRestore();
    setReducedMotionPref(previousMotion);
  };
  const prCache: AppState["prCache"] = {};
  for (const pr of prs) {
    const detail: PrDetail = {
      repo: pr.repo,
      pr,
      blockers: pr.blockers,
      threads: [],
      conversation: [],
      files: [],
      stack: null,
    };
    // Warm details also keep cursor-dwell prefetch local, independently of the openPr load stub.
    prCache[keyOf(pr)] = { status: "ready", data: detail, refreshing: false, at: Date.now() };
  }
  const refresh = (next: BoardEntry[]) => seed.set({
    boards: { mine: { status: "ready", data: { repo, trunk: "main", prs: next }, refreshing: false } },
  });
  seed.set({ prCache });
  refresh(prs);
  setup = await testRender(
    <ThemeContext.Provider value={{ name: "dark", p: dark }}>
      <StoreContext.Provider value={store}>
        <BoardPage />
      </StoreContext.Provider>
    </ThemeContext.Provider>,
    { width: 120, height: 26 },
  );
  const s = setup;
  const frame = async () => {
    for (let i = 0; i < 4; i++) await s.renderOnce();
    return s.captureCharFrame().split("\n");
  };
  return { s, store, frame, refresh, prs };
}

test("counted movement and single-row movement reach and open a distant PR on a seventy-row board", async () => {
  const { s, store, frame, prs } = await renderBoard();
  const target = prs[65]!;
  let f = await frame();
  expect(rowOf(f, prs[0]!.title)).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, target.title)).toBe(-1);

  await s.mockInput.typeText("65j");
  f = await frame();
  expect(store.getState().boardCursor).toBe(keyOf(target));
  expect(rowOf(f, target.title)).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, prs[0]!.title)).toBe(-1);

  s.mockInput.pressArrow("up");
  await frame();
  expect(store.getState().boardCursor).toBe(keyOf(prs[64]!));
  s.mockInput.pressKey("j");
  await frame();
  expect(store.getState().boardCursor).toBe(keyOf(target));
  s.mockInput.pressEnter();
  await frame();
  expect(store.getState().screen).toMatchObject({ kind: "pr", n: target.number, repo: target.repo, scope: "mine" });
});

test("keyboard search filters a large board to a distant PR and Enter opens its own repo", async () => {
  const { s, store, frame, prs } = await renderBoard();
  const target = prs[68]!;
  expect(rowOf(await frame(), target.title)).toBe(-1);

  s.mockInput.pressKey("/");
  await frame();
  await s.mockInput.typeText("Search-only distant");
  let f = await frame();
  expect(rowOf(f, target.title)).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, prs[0]!.title)).toBe(-1);
  expect(f.join("\n")).toContain("1 match");
  expect(store.getState().screen.kind).toBe("board");

  s.mockInput.pressEnter();
  await frame();
  expect(store.getState().searchLine).toMatchObject({ query: "Search-only distant", active: false });
  s.mockInput.pressEnter();
  f = await frame();
  expect(rowOf(f, target.title)).toBeGreaterThanOrEqual(0);
  expect(store.getState().screen).toMatchObject({ kind: "pr", n: target.number, repo: target.repo, scope: "mine" });
  expect(store.getState().boardCursor).toBe(keyOf(target));
});

test("clicking a nonselected row selects it, and a second click opens that row rather than the old selection", async () => {
  const { s, store, frame, prs } = await renderBoard();
  const target = prs[4]!;
  let f = await frame();
  const y = rowOf(f, target.title);
  expect(y).toBeGreaterThanOrEqual(0);

  await s.mockMouse.click(8, y);
  f = await frame();
  expect(store.getState().screen.kind).toBe("board");
  expect(store.getState().boardCursor).toBe(keyOf(target));
  expect(rowOf(f, target.title)).toBeGreaterThanOrEqual(0);

  await s.mockMouse.click(8, rowOf(f, target.title));
  await frame();
  expect(store.getState().screen).toMatchObject({ kind: "pr", n: target.number, repo: target.repo, scope: "mine" });
});

test("refresh updates a selected row's title, readiness and blocker without moving selection", async () => {
  const { s, store, frame, refresh, prs } = await renderBoard();
  const target = prs[3]!;
  await frame();
  await s.mockInput.typeText("3j");
  let f = await frame();
  expect(store.getState().boardCursor).toBe(keyOf(target));
  expect(f[rowOf(f, target.title) + 1]).toContain("ready");

  const blocked: BoardEntry = {
    ...target,
    title: "Refreshed blocked title",
    mergeable: "CONFLICTING",
    blockers: [{ kind: "conflict", base: "main" }],
  };
  refresh(prs.map((pr) => pr.number === target.number ? blocked : pr));
  f = await frame();
  const y = rowOf(f, blocked.title);
  expect(y).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, target.title)).toBe(-1);
  expect(f[y + 1]).toContain(`#${target.number}`);
  expect(f[y + 1]).toContain("needs fixes");
  expect(f[y + 1]).toContain("conflict");
  expect(store.getState().boardCursor).toBe(keyOf(target));

  const ready: BoardEntry = { ...target, title: "Refreshed ready title" };
  refresh(prs.map((pr) => pr.number === target.number ? ready : pr));
  f = await frame();
  const readyY = rowOf(f, ready.title);
  expect(readyY).toBeGreaterThanOrEqual(0);
  expect(f[readyY + 1]).toContain("ready");
  expect(f[readyY + 1]).not.toContain("conflict");
  expect(rowOf(f, blocked.title)).toBe(-1);
  expect(store.getState().boardCursor).toBe(keyOf(target));
});

test("a stack member stays under its root and opens the root's stack sheet after selection moves", async () => {
  const prs = largeBoard();
  const root = prs[1]!;
  const child: BoardEntry = { ...prs[2]!, baseRef: root.headRef };
  prs[2] = child;
  const { s, store, frame } = await renderBoard(prs);
  let f = await frame();
  const rootY = rowOf(f, root.title);
  const childY = rowOf(f, child.title);
  expect(rootY).toBeGreaterThanOrEqual(0);
  expect(childY).toBeGreaterThan(rootY);
  expect(f[rootY + 1]).toContain("stack of 2");
  expect(f[childY + 1]).toContain(`on #${root.number}`);

  s.mockInput.pressKey("j");
  f = await frame();
  expect(store.getState().boardCursor).toBe(keyOf(root));
  expect(f.join("\n")).toContain("Merge stack S");
  s.mockInput.pressKey("j");
  await frame();
  expect(store.getState().boardCursor).toBe(keyOf(child));
  s.mockInput.pressKey("S");
  await frame();
  expect(store.getState().sheet).toEqual({ kind: "stack", n: root.number, upTo: "top", repo: root.repo });
});
