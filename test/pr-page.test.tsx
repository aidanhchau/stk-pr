import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { slugCtx, type Ctx, type PrDetail } from "../src/service";
import type { ConversationEntry, Exec, PrCommit } from "../src/types";
import { Pr } from "../src/tui/pr";
import { Store, StoreContext, useStore, type AppState } from "../src/tui/store";
import { ThemeContext, dark } from "../src/tui/theme";
import { DOUBLE_TAP_MS, DockInput } from "../src/tui/ui";

let setup: TestRendererSetup | null = null;
afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
  delete process.env.STK_OPEN;
});

/** Point `openUrl` at a script that records the URLs it is given, so a test can see what the page tried to open. */
function fakeOpener() {
  const dir = mkdtempSync(join(tmpdir(), "stk-open-"));
  const log = join(dir, "opened");
  const bin = join(dir, "open.sh");
  writeFileSync(bin, `#!/bin/sh\necho "$1" >> "${log}"\n`);
  chmodSync(bin, 0o755);
  process.env.STK_OPEN = bin;
  /** The URLs opened so far: waits for `n` of them (the opener is a child process), or a moment to be sure none came. */
  return async (n = 0) => {
    for (let i = 0; i < 60 && (n ? readLog().length < n : i < 10); i++) await Bun.sleep(50);
    return readLog();
  };
  function readLog() {
    return existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  }
}
/** Wait out the double-click window, so the next click starts a new pair. */
const pause = () => Bun.sleep(DOUBLE_TAP_MS + 80);

const repo = { owner: "o", name: "r" };
const at = (min: number) => new Date(Date.parse("2026-01-01T00:00:00Z") + min * 60_000).toISOString();
const comment = (id: string, min: number, author: string, isBot: boolean, body: string): ConversationEntry => ({
  kind: "comment",
  id,
  author,
  isBot,
  body,
  createdAt: at(min),
  url: `https://x/${id}`,
  minimized: false,
});

const detail: PrDetail = {
  repo,
  pr: {
    number: 7,
    title: "Fold test",
    url: "https://x/pr/7",
    author: "alice",
    state: "OPEN",
    isDraft: false,
    headRef: "a",
    baseRef: "main",
    createdAt: at(0),
    updatedAt: at(0),
    headSha: "abc",
    mergeable: "MERGEABLE",
    reviewDecision: null,
    checks: [],
    unresolvedThreads: 0,
    body: "",
    worktree: null,
  },
  blockers: [],
  threads: [],
  conversation: [
    comment("h", 1, "alice", false, ["human hello", ...Array.from({ length: 9 }, (_, i) => `line ${i + 2} of the review`)].join("\n\n")),
    comment("b1", 2, "cursor[bot]", true, "first bot note"),
    comment("b2", 3, "cursor[bot]", true, "second bot note"),
    // Short (under the body cap) so "more lines" only ever means alice's comment; they give the page room to scroll.
    comment("h2", 4, "bob", false, "bob one\n\nbob two\n\nbob three"),
    comment("h3", 5, "carol", false, "carol one\n\ncarol two\n\ncarol three"),
  ],
  files: [],
  stack: null,
};

/** Search queries are entered by the app dock, not by the PR page itself. */
function SearchablePr() {
  const line = useStore((s) => s.searchLine);
  return (
    <box flexGrow={1} flexDirection="column">
      <Pr n={7} />
      <box height={1} flexShrink={0}>{line?.active ? <DockInput line={line} /> : null}</box>
    </box>
  );
}

function VisiblePr() {
  const screen = useStore((s) => s.screen);
  return screen.kind === "pr" ? <Pr n={screen.n} /> : <text>Board</text>;
}

async function renderPr(height = 40, data: PrDetail = detail, commits?: PrCommit[], searchDock = false) {
  const store = new Store("/nonexistent", { gh: repo, pr: 7, prefsFile: null });
  // Seed through the real setter so repo-scoped views and head invalidation behave as in production.
  const seed = store as unknown as { set(p: Partial<AppState>): void; ctxs: Map<string, Promise<Ctx>> };
  seed.ctxs.set("o/r", Promise.resolve(slugCtx(async () => { throw new Error("unexpected network request in PR fixture"); }, repo)));
  seed.set({
    prCache: { "o/r#7": { status: "ready", data, refreshing: false, at: Date.now() } },
    ...(commits ? { commitCache: { "o/r#7": { status: "ready", data: commits, refreshing: false } } } : {}),
  });
  setup = await testRender(
    <ThemeContext.Provider value={{ name: "dark", p: dark }}>
      <StoreContext.Provider value={store}>
        {searchDock ? <SearchablePr /> : <VisiblePr />}
      </StoreContext.Provider>
    </ThemeContext.Provider>,
    { width: 100, height },
  );
  const s = setup;
  const frame = async () => {
    for (let i = 0; i < 4; i++) await s.renderOnce();
    return s.captureCharFrame().split("\n");
  };
  return { s, frame, store, seed };
}

const rowOf = (f: string[], text: string) => f.findIndex((l) => l.includes(text));

test("zM closes a bot fold even while the cursor is on one of its members, leaving the cursor on the fold", async () => {
  const { s, frame } = await renderPr();
  let f = await frame();
  const fold = rowOf(f, "2 bot comments");
  expect(f[fold]!.trimStart().startsWith("▸")).toBe(true);
  // The cursor starts on alice's comment: j moves to the fold, Enter opens it, j j reaches the second bot note.
  s.mockInput.pressKey("j");
  await frame();
  s.mockInput.pressEnter();
  await Bun.sleep(300);
  f = await frame();
  expect(f[rowOf(f, "2 bot comments")]!.trimStart().startsWith("▾")).toBe(true);
  s.mockInput.pressKey("j");
  s.mockInput.pressKey("j");
  await Bun.sleep(300);
  await frame();
  await s.mockInput.typeText("zM");
  f = await frame();
  // zM also collapses alice's comment above, so find the fold row again.
  expect(f[rowOf(f, "2 bot comments")]!.trimStart().startsWith("▸")).toBe(true);
  expect(rowOf(f, "second bot note")).toBe(-1);
  // Cursor landed on the fold: Enter reopens it.
  s.mockInput.pressEnter();
  f = await frame();
  expect(f[rowOf(f, "2 bot comments")]!.trimStart().startsWith("▾")).toBe(true);
});

const capped = (f: string[]) => rowOf(f, "more lines") >= 0;

// With no description or stack, the cursor starts on alice's comment. The mouse never moves it, never opens or folds anything, and never scrolls.
test("in a comment body, a drag selects text and a plain click does nothing", async () => {
  const { s, frame } = await renderPr();
  let f = await frame();
  const before = f.join("\n");
  const y = rowOf(f, "human hello");

  await s.mockMouse.drag(4, y, 30, y + 2);
  f = await frame();
  expect(capped(f)).toBe(true);
  expect(s.renderer.getSelection()?.getSelectedText()).toContain("line 2 of the review");

  await s.mockMouse.click(6, y);
  await s.mockMouse.click(4, rowOf(f, "▾ alice"));
  f = await frame();
  expect(capped(f)).toBe(true);
  expect(f.join("\n")).toBe(before);
});

test("a single click on another block, a fold or a header does nothing, even repeated slowly", async () => {
  const { s, frame } = await renderPr();
  let f = await frame();
  const fold = rowOf(f, "2 bot comments");
  await s.mockMouse.click(4, fold);
  await pause();
  await s.mockMouse.click(4, fold);
  await pause();
  await s.mockMouse.click(6, rowOf(f, "bob one"));
  f = await frame();
  // The fold stayed closed and the cursor is still on alice's comment: Enter expands it in full.
  expect(f[fold]!.trimStart().startsWith("▸")).toBe(true);
  s.mockInput.pressEnter();
  f = await frame();
  expect(capped(f)).toBe(false);
});

test("a double-click on a fold opens it and puts the cursor there, so Enter then closes it", async () => {
  const { s, frame } = await renderPr();
  let f = await frame();
  const fold = rowOf(f, "2 bot comments");
  await s.mockMouse.click(4, fold);
  await s.mockMouse.click(4, fold);
  await Bun.sleep(300);
  f = await frame();
  expect(f[rowOf(f, "2 bot comments")]!.trimStart().startsWith("▾")).toBe(true);
  expect(capped(f)).toBe(true);
  s.mockInput.pressEnter();
  await Bun.sleep(300);
  f = await frame();
  expect(f[rowOf(f, "2 bot comments")]!.trimStart().startsWith("▸")).toBe(true);
});

test("a double-click on a comment's header expands it; on its body text nothing folds", async () => {
  const { s, frame } = await renderPr();
  let f = await frame();
  const before = f.join("\n");
  const body = rowOf(f, "line 3 of the review");
  await s.mockMouse.click(6, body);
  await s.mockMouse.click(6, body);
  f = await frame();
  expect(capped(f)).toBe(true);
  expect(f.join("\n")).toBe(before);
  // bob's body is short and uncapped; its header (collapsed to a line or not) is the only place a double-click acts
  const head = rowOf(f, "▾ alice");
  await s.mockMouse.click(4, head);
  await s.mockMouse.click(4, head);
  f = await frame();
  expect(capped(f)).toBe(false);
});

test("two clicks too far apart, on different rows, or with a drag between them do not open", async () => {
  const { s, frame } = await renderPr();
  let f = await frame();
  const fold = rowOf(f, "2 bot comments");
  const bob = rowOf(f, "bob one") - 1;
  // too slow
  await s.mockMouse.click(4, fold);
  await pause();
  await s.mockMouse.click(4, fold);
  // two rows
  await pause();
  await s.mockMouse.click(4, fold);
  await s.mockMouse.click(4, bob);
  // a drag between them
  await pause();
  await s.mockMouse.click(4, fold);
  await s.mockMouse.drag(4, fold + 1, 30, fold + 2);
  await s.mockMouse.click(4, fold);
  // the second tap is a drag
  await pause();
  await s.mockMouse.click(4, fold);
  await s.mockMouse.drag(4, fold, 30, fold);
  f = await frame();
  expect(f[fold]!.trimStart().startsWith("▸")).toBe(true);
});

test("a drag that starts on body text, or a press on plain text, between two clicks on a row starts the double-click over", async () => {
  const { s, frame } = await renderPr();
  const f = await frame();
  const fold = rowOf(f, "2 bot comments");
  const body = rowOf(f, "line 3 of the review");
  // A frozen clock, so the gestures below are always inside the double-click window however long the mock mouse takes.
  const real = Date.now();
  let clock = real;
  const spy = spyOn(Date, "now").mockImplementation(() => clock);
  try {
    clock += 1000;
    await s.mockMouse.click(4, fold);
    await s.mockMouse.pressDown(4, body);
    await s.mockMouse.emitMouseEvent("drag", 30, body + 1);
    await s.mockMouse.release(30, body + 1);
    await s.mockMouse.click(4, fold);
    let after = await frame();
    expect(after[fold]!.trimStart().startsWith("▸")).toBe(true);
    clock += 1000;
    await s.mockMouse.click(4, fold);
    await s.mockMouse.click(6, body);
    await s.mockMouse.click(4, fold);
    after = await frame();
    expect(after[fold]!.trimStart().startsWith("▸")).toBe(true);
    // control: the same two clicks with nothing between them do open it
    clock += 1000;
    await s.mockMouse.click(4, fold);
    await s.mockMouse.click(4, fold);
    await Bun.sleep(300);
    const opened = await frame();
    expect(opened[rowOf(opened, "2 bot comments")]!.trimStart().startsWith("▾")).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

const linked: PrDetail = {
  ...detail,
  conversation: [
    ...detail.conversation.slice(0, 3),
    comment("h2", 4, "bob", false, "bob one see [the guide](https://guide.test/x?y=1) or [rel](/o/r/pull/3)\n\nbob two https://bare.test/p.\n\n| Check | Result |\n| --- | --- |\n| lint | [log](https://ci.test/lint) |"),
    detail.conversation[4]!,
  ],
};

test("a click on a link in a comment opens it, and moves nothing; a click beside it does nothing", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, linked);
  let f = await frame();
  const before = f.join("\n");
  const y = rowOf(f, "bob one see");
  const col = (text: string, row = y) => f[row]!.indexOf(text);
  await s.mockMouse.click(col("the guide") + 3, y);
  expect(await opened(1)).toEqual(["https://guide.test/x?y=1"]);
  await s.mockMouse.click(col("rel") + 1, y);
  const bare = rowOf(f, "bob two");
  await s.mockMouse.click(col("https://bare.test/p") + 5, bare);
  // beside the link, on plain words, and on the very cell after the URL's trailing "."
  await s.mockMouse.click(col("bob one") + 2, y);
  await s.mockMouse.click(col("https://bare.test/p.") + "https://bare.test/p.".length - 1, bare);
  expect(await opened(3)).toEqual(["https://guide.test/x?y=1", "https://x/o/r/pull/3", "https://bare.test/p"]);
  f = await frame();
  expect(f.join("\n")).toBe(before);
  // the cursor never left alice's comment: Enter expands her comment in full
  expect(capped(f)).toBe(true);
  s.mockInput.pressEnter();
  f = await frame();
  expect(capped(f)).toBe(false);
});

test("a link inside a table cell opens on a click", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, linked);
  const f = await frame();
  const y = rowOf(f, "lint");
  expect(y).toBeGreaterThanOrEqual(0);
  const x = f[y]!.indexOf("log");
  await s.mockMouse.click(x + 1, y);
  await s.mockMouse.click(f[y]!.indexOf("lint"), y);
  expect(await opened(1)).toEqual(["https://ci.test/lint"]);
});

test("a link click between two clicks on a row starts the double-click over", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, linked);
  const f = await frame();
  const fold = rowOf(f, "2 bot comments");
  const y = rowOf(f, "bob one see");
  expect(fold).toBeGreaterThanOrEqual(0);
  // A frozen clock, so the three clicks are always inside the double-click window however long the mock mouse takes.
  let clock = Date.now() + 1000;
  const spy = spyOn(Date, "now").mockImplementation(() => clock);
  try {
    await s.mockMouse.click(4, fold);
    await s.mockMouse.click(f[y]!.indexOf("the guide") + 3, y);
    await s.mockMouse.click(4, fold);
    expect(await opened(1)).toEqual(["https://guide.test/x?y=1"]);
    const after = await frame();
    expect(after[fold]!.trimStart().startsWith("▸")).toBe(true);
  } finally {
    spy.mockRestore();
  }
});

test("dragging across a link selects text and opens nothing", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, linked);
  let f = await frame();
  const y = rowOf(f, "bob one see");
  const x = f[y]!.indexOf("the guide");
  // press on the link, release past it
  await s.mockMouse.drag(x + 1, y, x + 20, y);
  // press before it, release on it
  await s.mockMouse.drag(x - 6, y, x + 3, y);
  // press on it, leave and come back
  await s.mockMouse.pressDown(x + 3, y);
  await s.mockMouse.emitMouseEvent("drag", x + 30, y);
  await s.mockMouse.emitMouseEvent("drag", x + 3, y);
  await s.mockMouse.release(x + 3, y);
  f = await frame();
  expect(await opened()).toEqual([]);
  await s.mockMouse.drag(x - 6, y, x + 12, y);
  expect(s.renderer.getSelection()?.getSelectedText()).toContain("the guide");
  // a plain click right after still opens it
  await s.mockMouse.click(x + 3, y);
  expect(await opened(1)).toEqual(["https://guide.test/x?y=1"]);
});

test("a double-click on a link opens it once and folds nothing", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, linked);
  let f = await frame();
  const before = f.join("\n");
  const y = rowOf(f, "bob one see");
  const x = f[y]!.indexOf("the guide") + 3;
  await s.mockMouse.click(x, y);
  await s.mockMouse.click(x, y);
  expect(await opened(1)).toEqual(["https://guide.test/x?y=1"]);
  f = await frame();
  expect(f.join("\n")).toBe(before);
  // a later, separate click opens it again
  await pause();
  await s.mockMouse.click(x, y);
  expect(await opened(2)).toEqual(["https://guide.test/x?y=1", "https://guide.test/x?y=1"]);
});

const checkDetail: PrDetail = { ...detail, conversation: [], threads: [], pr: { ...detail.pr, checks: [{ name: "Lint", state: "fail", url: "https://ci.test/lint" }, { name: "Unit", state: "fail", url: "https://ci.test/unit" }] } };

test("a check row opens its URL on a double-click only, and the double-click takes the cursor there", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, checkDetail);
  let f = await frame();
  const lint = rowOf(f, "Lint");
  const unit = rowOf(f, "Unit");
  expect(lint).toBeGreaterThanOrEqual(0);
  await s.mockMouse.click(6, lint);
  await pause();
  await s.mockMouse.click(6, lint);
  expect(await opened()).toEqual([]);
  await pause();
  await s.mockMouse.click(6, lint);
  await s.mockMouse.click(6, lint);
  expect(await opened(1)).toEqual(["https://ci.test/lint"]);
  // a double-click on the other check opens that one, and Enter then repeats it (the cursor is there now)
  await pause();
  await s.mockMouse.click(6, unit);
  await s.mockMouse.click(6, unit);
  expect(await opened(2)).toEqual(["https://ci.test/lint", "https://ci.test/unit"]);
  s.mockInput.pressEnter();
  expect(await opened(3)).toEqual(["https://ci.test/lint", "https://ci.test/unit", "https://ci.test/unit"]);
  f = await frame();
});

test("single clicks, slow pairs, a pair across rows and a click-then-drag never open a check", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, checkDetail);
  const f = await frame();
  const lint = rowOf(f, "Lint");
  const unit = rowOf(f, "Unit");
  await s.mockMouse.click(6, lint);
  await pause();
  await s.mockMouse.click(6, lint);
  await pause();
  await s.mockMouse.click(6, lint);
  await s.mockMouse.click(6, unit);
  await pause();
  await s.mockMouse.click(6, lint);
  await s.mockMouse.drag(6, lint, 40, lint);
  await pause();
  await s.mockMouse.drag(6, lint, 40, lint);
  await s.mockMouse.click(6, lint);
  expect(await opened()).toEqual([]);
});

test("dragging to the edge of the page while selecting does not scroll it or move the cursor", async () => {
  const { s, frame } = await renderPr(20);
  await frame();
  // Move the cursor to the bot fold by key (the view follows it), so alice's comment, the block pressed below, is not under the cursor.
  s.mockInput.pressKey("j");
  await Bun.sleep(300);
  let f = await frame();
  const before = f.join("\n");
  const y = rowOf(f, "line 3 of the review");
  expect(y).toBeGreaterThanOrEqual(0);
  // Press on a block the cursor is not on, then drag below the page's bottom edge and hold there, where ScrollBox would auto-scroll.
  await s.mockMouse.pressDown(4, y);
  for (let i = 0; i < 6; i++) {
    await s.mockMouse.emitMouseEvent("drag", 40, 18 + (i % 2));
    await Bun.sleep(60);
    await s.renderOnce();
  }
  await s.mockMouse.emitMouseEvent("drag", 40, 19);
  await Bun.sleep(300);
  f = await frame();
  await s.mockMouse.release(40, 19);
  f = await frame();
  expect(f.join("\n")).toBe(before);
  // The cursor is still on the bot fold: Enter opens it.
  s.mockInput.pressEnter();
  await Bun.sleep(300);
  f = await frame();
  expect(rowOf(f, "first bot note")).toBeGreaterThanOrEqual(0);
});

test("one cell of jitter during a Pill press still counts as a click", async () => {
  const { s, frame, store } = await renderPr();
  const f = await frame();
  const y = rowOf(f, "Comment C");
  const x = f[y]!.indexOf("Comment C") + 2;
  await s.mockMouse.pressDown(x, y);
  await s.mockMouse.emitMouseEvent("drag", x + 1, y);
  await s.mockMouse.release(x + 1, y);
  await frame();
  expect(store.getState().sheet).toMatchObject({ kind: "review", event: "COMMENT" });
});

test("a drag that leaves a Pill and comes back to release on it does not fire it", async () => {
  const { s, frame, store } = await renderPr();
  const f = await frame();
  const y = rowOf(f, "Comment C");
  const x = f[y]!.indexOf("Comment C") + 2;
  await s.mockMouse.pressDown(x, y);
  await s.mockMouse.emitMouseEvent("drag", 40, y + 4);
  await s.mockMouse.emitMouseEvent("drag", x, y);
  await s.mockMouse.release(x, y);
  await frame();
  expect(store.getState().sheet).toBeNull();
  // The next plain click still works.
  await s.mockMouse.click(x, y);
  await frame();
  expect(store.getState().sheet).toMatchObject({ kind: "review", event: "COMMENT" });
});

test("a click on a Pill button fires on release, and a drag across it does not", async () => {
  const { s, frame, store } = await renderPr();
  let f = await frame();
  const y = rowOf(f, "Comment C");
  expect(y).toBeGreaterThanOrEqual(0);
  const x = f[y]!.indexOf("Comment C") + 2;
  await s.mockMouse.pressDown(x, y);
  await s.mockMouse.emitMouseEvent("drag", x + 6, y);
  await s.mockMouse.release(x + 6, y);
  await frame();
  expect(store.getState().sheet).toBeNull();
  await s.mockMouse.click(x, y);
  await frame();
  expect(store.getState().sheet).toMatchObject({ kind: "review", event: "COMMENT" });
});

test("↑/↓ scroll the page and never change the selection, even off screen; j moves it", async () => {
  const { s, frame } = await renderPr(16);
  let f = await frame();
  const head = rowOf(f, "▾ alice");
  s.mockInput.pressArrow("down");
  s.mockInput.pressArrow("down");
  f = await frame();
  expect(rowOf(f, "▾ alice")).toBe(head - 2);
  // Scroll the selected comment entirely off screen (the wheel would pull the selection onto a visible item), then back.
  for (let i = 0; i < 18; i++) s.mockInput.pressArrow("down");
  await Bun.sleep(20);
  f = await frame();
  expect(rowOf(f, "▾ alice")).toBe(-1);
  expect(rowOf(f, "human hello")).toBe(-1);
  for (let i = 0; i < 20; i++) s.mockInput.pressArrow("up");
  await Bun.sleep(20);
  f = await frame();
  expect(rowOf(f, "▾ alice")).toBe(head);
  // The selection stayed on alice's comment: Enter expands it fully.
  s.mockInput.pressEnter();
  f = await frame();
  expect(rowOf(f, "more lines")).toBe(-1);
  // j moves to the bot fold (the view glides down to it); Enter opens it.
  s.mockInput.pressKey("j");
  await frame();
  s.mockInput.pressEnter();
  await Bun.sleep(300);
  f = await frame();
  expect(rowOf(f, "▾ 2 bot comments")).toBeGreaterThanOrEqual(0);
});

const historyCommit: PrCommit = {
  sha: "1234567890abcdef", message: "Preserve results before rebase", author: "alice", committedAt: at(1),
  url: "https://x/commit/1234567890abcdef",
  checks: [{ name: "Depot PR tests / test", state: "fail", url: "https://x/log/1" }],
};
const quietDetail: PrDetail = { ...detail, conversation: [], threads: [] };

/** Exercise service/GraphQL mapping without letting a renderer or store call the real gh executable. */
function historyTransport(store: Store) {
  const requests: string[][] = [];
  let state: "FAILURE" | "SUCCESS" = "FAILURE";
  const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
  const exec: Exec = async (argv) => {
    requests.push([...argv]);
    const ok = (data: unknown) => ({ code: 0, stdout: JSON.stringify(data), stderr: "" });
    const query = argv.find((arg) => arg.startsWith("query=")) ?? "";
    if (query.includes("commits(first:")) return ok({ data: { repository: { pullRequest: { commits: {
      pageInfo: page.pageInfo,
      nodes: [{ commit: {
        id: "commit-node", oid: historyCommit.sha, messageHeadline: historyCommit.message,
        committedDate: historyCommit.committedAt, url: historyCommit.url, author: { user: { login: "alice" } },
        statusCheckRollup: { contexts: { pageInfo: page.pageInfo, nodes: [
          { __typename: "CheckRun", name: "Depot PR tests / test", status: "COMPLETED", conclusion: state, detailsUrl: "https://x/log/1" },
        ] } },
      } }],
    } } } } });
    if (argv[1] === "repo") return ok({ owner: { login: "o" }, name: "r", defaultBranchRef: { name: "main" } });
    if (argv[1] === "pr" && argv[2] === "list") return ok([]);
    if (argv[1] === "pr" && argv[2] === "view") return ok({
      ...quietDetail.pr, author: { login: "alice" }, headRefName: "a", baseRefName: "main", headRefOid: "abc",
      statusCheckRollup: [], files: [],
    });
    if (argv[1] === "api" && argv[2] === "graphql") return ok({ data: { repository: { pullRequest: {
      reviewThreads: page, reviews: page, comments: page, stackEntry: null, stack: null,
    } } } });
    if (argv[1] === "api" && argv.some((arg) => arg.startsWith("repos/o/r/"))) {
      const data = argv.some((arg) => arg.includes("/compare/")) ? { behind_by: 0 } : [];
      return { code: 0, stdout: `HTTP/2.0 200 OK\r\n\r\n${JSON.stringify(data)}`, stderr: "" };
    }
    throw new Error(`unexpected fixture command: ${argv.join(" ")}`);
  };
  const internals = store as unknown as { ctxs: Map<string, Promise<Ctx>> };
  internals.ctxs.set("o/r", Promise.resolve(slugCtx(exec, repo)));
  return {
    requests,
    historyCalls: () => requests.filter((args) => args.some((arg) => arg.includes("commits(first:"))).length,
    pass() { state = "SUCCESS"; },
  };
}

test("expanded history refreshes check results, collapsed and unmounted history spends no further requests", async () => {
  const { s, frame, store, seed } = await renderPr(40, quietDetail);
  const transport = historyTransport(store);
  await frame();
  expect(transport.historyCalls()).toBe(0);
  s.mockInput.pressEnter();
  await frame();
  expect(transport.historyCalls()).toBe(1);
  expect(store.getState().commitCache["o/r#7"]?.data?.[0]?.checks[0]?.state).toBe("fail");
  transport.pass();
  await store.loadPr(7, { repo, force: true });
  await frame();
  expect(transport.historyCalls()).toBe(2);
  expect(store.getState().commitCache["o/r#7"]?.data?.[0]?.checks[0]?.state).toBe("pass");
  s.mockInput.pressEnter();
  await frame();
  await store.loadPr(7, { repo, force: true });
  expect(transport.historyCalls()).toBe(2);
  s.mockInput.pressEnter();
  await frame();
  expect(transport.historyCalls()).toBe(2);
  seed.set({ screen: { kind: "board", scope: "mine" } });
  await frame();
  await store.loadPr(7, { repo, force: true });
  expect(transport.historyCalls()).toBe(2);
  expect(store.getState().commitCache["o/r#7"]?.data?.[0]?.checks[0]?.state).toBe("pass");
});

test("expansion and repeated Enter retries during known cooldown show a local error without requests or loading loops", async () => {
  const { s, frame, store } = await renderPr(40, quietDetail);
  const transport = historyTransport(store);
  const internals = store as unknown as { rateLimitedUntil: number };
  internals.rateLimitedUntil = Date.now() + 60_000;
  await frame();
  s.mockInput.pressEnter();
  let f = await frame();
  expect(rowOf(f, "Retry commit history")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "paused until reset")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Loading commit history")).toBe(-1);
  s.mockInput.pressKey("j");
  await frame();
  for (let i = 0; i < 2; i++) {
    s.mockInput.pressEnter();
    f = await frame();
    expect(rowOf(f, "Retry commit history")).toBeGreaterThanOrEqual(0);
    expect(rowOf(f, "Loading commit history")).toBe(-1);
  }
  expect(transport.requests).toHaveLength(0);
  internals.rateLimitedUntil = Date.now() - 1;
  s.mockInput.pressEnter();
  f = await frame();
  expect(transport.historyCalls()).toBe(1);
  expect(rowOf(f, "Preserve results before rebase")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Retry commit history")).toBe(-1);
});

test("switching PR keys unregisters the old expanded section while keeping its cached history", async () => {
  const { s, frame, store, seed } = await renderPr(40, quietDetail, [historyCommit]);
  const transport = historyTransport(store);
  await frame();
  s.mockInput.pressEnter();
  await frame();
  seed.set({
    screen: { kind: "pr", n: 8, repo, scope: "mine" },
    prCache: {
      ...store.getState().prCache,
      "o/r#8": { status: "ready", refreshing: false, at: Date.now(), data: { ...quietDetail, pr: { ...quietDetail.pr, number: 8 } } },
    },
    commitCache: {
      ...store.getState().commitCache,
      "o/r#8": { status: "ready", refreshing: false, data: [] },
    },
  });
  await frame();
  await store.loadPr(7, { repo, force: true });
  expect(transport.historyCalls()).toBe(0);
  expect(store.getState().commitCache["o/r#7"]?.data).toEqual([historyCommit]);
});

test("cooldown refresh errors keep cached history visible and expose retry without an automatic loop", async () => {
  const { s, frame, store } = await renderPr(40, quietDetail, [historyCommit]);
  const transport = historyTransport(store);
  await frame();
  s.mockInput.pressEnter();
  await frame();
  const internals = store as unknown as { rateLimitedUntil: number };
  internals.rateLimitedUntil = Date.now() + 60_000;
  await store.loadCommits(7, { repo, force: true });
  const f = await frame();
  expect(rowOf(f, "Preserve results before rebase")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Retry commit history")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Loading commit history")).toBe(-1);
  expect(store.getState().commitCache["o/r#7"]).toMatchObject({ status: "ready", errorCode: "rate-limited", refreshing: false });
  await frame();
  expect(transport.requests).toHaveLength(0);
});

test("commit history loads only when opened and nested folds keep the cursor usable", async () => {
  const { s, frame, store, seed } = await renderPr(40, quietDetail);
  let loads = 0;
  store.loadCommits = async (n, opts) => {
    loads++;
    expect(n).toBe(7);
    expect(opts?.repo).toEqual(repo);
    seed.set({ commitCache: { "o/r#7": { status: "ready", data: [historyCommit], refreshing: false } } });
  };
  let f = await frame();
  expect(loads).toBe(0);
  expect(rowOf(f, "Preserve results before rebase")).toBe(-1);
  // With no activity or description the collapsed history is the first cursor item.
  s.mockInput.pressEnter();
  f = await frame();
  expect(loads).toBe(1);
  expect(rowOf(f, "1 · historical checks")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Preserve results before rebase")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Depot PR tests / test")).toBe(-1);
  s.mockInput.pressKey("j");
  await frame();
  await s.mockInput.typeText("zo");
  f = await frame();
  expect(rowOf(f, "Depot PR tests / test")).toBeGreaterThanOrEqual(0);
  await s.mockInput.typeText("zc");
  f = await frame();
  expect(rowOf(f, "Depot PR tests / test")).toBe(-1);
  await s.mockInput.typeText("za");
  await frame();
  s.mockInput.pressKey("j");
  await frame();
  await s.mockInput.typeText("zM");
  f = await frame();
  expect(rowOf(f, "Preserve results before rebase")).toBe(-1);
  // Closing all folds from a child returns to the section header.
  s.mockInput.pressEnter();
  f = await frame();
  expect(rowOf(f, "Preserve results before rebase")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Depot PR tests / test")).toBe(-1);
  await s.mockInput.typeText("zR");
  f = await frame();
  expect(rowOf(f, "Depot PR tests / test")).toBeGreaterThanOrEqual(0);
  expect(loads).toBe(1);
});

test("required contexts missing from a green rollup remain expected on the current head", async () => {
  const data: PrDetail = {
    ...quietDetail,
    pr: { ...detail.pr, checks: [{ name: "Lint", state: "pass", url: null }] },
    blockers: [{ kind: "required-check", context: "Depot PR tests / test" }],
  };
  const { frame } = await renderPr(40, data);
  const f = await frame();
  const checks = rowOf(f, "CHECKS");
  expect(checks).toBeGreaterThanOrEqual(0);
  expect(f[checks]).toContain("1 pending");
  expect(f[checks]).not.toContain("all passing");
  expect(rowOf(f.slice(checks + 1), "Depot PR tests / test")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "expected")).toBeGreaterThan(checks);
});

test("a missing required context renders Checks even with no reported head checks", async () => {
  const { frame } = await renderPr(40, { ...quietDetail, blockers: [{ kind: "required-check", context: "Required tests" }] });
  const f = await frame();
  const checks = rowOf(f, "CHECKS");
  expect(f[checks]).toContain("1 pending");
  expect(rowOf(f, "expected")).toBeGreaterThan(checks);
  expect(f.join("\n")).not.toContain("all passing");
});

test("loaded historical checks are searchable through collapsed folds", async () => {
  const { s, frame, store } = await renderPr(40, quietDetail, [historyCommit], true);
  expect(rowOf(await frame(), "Depot PR tests / test")).toBe(-1);
  s.mockInput.pressKey("/");
  await frame();
  await s.mockInput.typeText("Depot PR tests");
  await frame();
  expect(store.getState().searchLine?.query).toBe("Depot PR tests");
  s.mockInput.pressEnter();
  const f = await frame();
  expect(rowOf(f, "Preserve results before rebase")).toBeGreaterThanOrEqual(0);
  expect(rowOf(f, "Depot PR tests / test")).toBeGreaterThanOrEqual(0);
});

test("history errors offer a focusable Enter retry rather than a dead fold", async () => {
  const { s, frame, store, seed } = await renderPr(40, quietDetail);
  let loads = 0;
  store.loadCommits = async (_n, opts) => {
    loads++;
    seed.set({ commitCache: { "o/r#7": opts?.force
      ? { status: "ready", data: [historyCommit], refreshing: false }
      : { status: "error", error: "Network unavailable", refreshing: false } } });
  };
  await frame();
  s.mockInput.pressEnter();
  let f = await frame();
  expect(rowOf(f, "Retry commit history")).toBeGreaterThanOrEqual(0);
  s.mockInput.pressKey("j");
  await frame();
  s.mockInput.pressEnter();
  f = await frame();
  expect(loads).toBe(2);
  expect(rowOf(f, "Preserve results before rebase")).toBeGreaterThanOrEqual(0);
});

test("the commits header and its rows open on a double-click, not on a single click", async () => {
  const opened = fakeOpener();
  const { s, frame } = await renderPr(40, quietDetail, [historyCommit]);
  let f = await frame();
  const header = rowOf(f, "COMMITS");
  await s.mockMouse.click(4, header);
  await pause();
  await s.mockMouse.click(4, header);
  f = await frame();
  expect(rowOf(f, "Preserve results before rebase")).toBe(-1);
  await pause();
  await s.mockMouse.click(4, header);
  await s.mockMouse.click(4, header);
  f = await frame();
  const commit = rowOf(f, "Preserve results before rebase");
  expect(commit).toBeGreaterThanOrEqual(0);
  // a double-click on a commit (the cursor is on the header, not on it) opens its checks
  await pause();
  await s.mockMouse.click(4, commit);
  await s.mockMouse.click(4, commit);
  f = await frame();
  const check = rowOf(f, "Depot PR tests / test");
  expect(check).toBeGreaterThanOrEqual(0);
  // and a double-click on a check row opens its logs
  await pause();
  await s.mockMouse.click(6, check);
  await s.mockMouse.click(6, check);
  expect(await opened(1)).toEqual(["https://x/log/1"]);
  // the header closes the section again
  await pause();
  await s.mockMouse.click(4, header);
  await s.mockMouse.click(4, header);
  f = await frame();
  expect(rowOf(f, "Preserve results before rebase")).toBe(-1);
});
