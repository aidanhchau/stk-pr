import { afterEach, expect, spyOn, test } from "bun:test";
import { CliRenderer } from "@opentui/core";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { slugCtx, type BoardPr, type Ctx, type PrDetail } from "../src/service";
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
const pr = (n: number): BoardPr => ({
  number: n,
  title: `Change ${n}`,
  url: `https://github.com/o/r/pull/${n}`,
  author: "alice",
  state: "OPEN",
  isDraft: false,
  headRef: `b${n}`,
  baseRef: "main",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  headSha: `sha${n}`,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  checks: [],
  unresolvedThreads: 0,
  blockers: [],
  body: "",
  worktree: null,
});
const detailOf = (n: number): PrDetail => ({ repo, pr: pr(n), blockers: [], threads: [], conversation: [], files: [], stack: null });

/** The real App over a seeded store; OSC 52 (SSH path of copyText) is captured instead of touching pbcopy. */
async function renderApp(screen: AppState["screen"], cursor: string | null) {
  const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
  spyOn(store, "init").mockResolvedValue(undefined);
  const loadPr = spyOn(store, "loadPr").mockResolvedValue(undefined);
  const seed = store as unknown as { set(p: Partial<AppState>): void; ctxs: Map<string, Promise<Ctx>> };
  seed.ctxs.set("o/r", Promise.resolve(slugCtx(async () => { throw new Error("unexpected network request"); }, repo)));
  seed.set({
    screen,
    boardCursor: cursor,
    boards: { mine: { status: "ready", data: { repo, trunk: "main", prs: [pr(1), pr(2)].map((p) => ({ ...p, repo })) }, refreshing: false } },
    prCache: { "o/r#1": { status: "ready", data: detailOf(1), refreshing: false, at: Date.now() }, "o/r#2": { status: "ready", data: detailOf(2), refreshing: false, at: Date.now() } },
  });
  // The test renderer has no terminal session to retitle.
  const title = spyOn(CliRenderer.prototype, "setTerminalTitle").mockImplementation(() => {});
  const prevTty = process.env.SSH_TTY;
  process.env.SSH_TTY = "1";
  const writes: string[] = [];
  const write = spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  restore.push(() => {
    write.mockRestore();
    title.mockRestore();
    loadPr.mockRestore();
    if (prevTty === undefined) delete process.env.SSH_TTY;
    else process.env.SSH_TTY = prevTty;
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
  // What the clipboard was handed: the last OSC 52 payload, decoded.
  const copied = () => writes.filter((w) => w.startsWith("\x1b]52;c;")).map((w) => Buffer.from(w.slice(7, -1), "base64").toString());
  return { s: setup, store, copied };
}

test("⌘⇧C on the PR page copies that PR's URL with the copy-url toast and opens no sheet", async () => {
  const { s, store, copied } = await renderApp({ kind: "pr", repo, n: 1, scope: "mine" }, null);
  s.mockInput.pressKey("c", { super: true, shift: true });
  await s.renderOnce();
  expect(copied()).toEqual(["https://github.com/o/r/pull/1"]);
  expect(store.getState().toasts.some((t) => t.text === "Copied PR URL")).toBe(true);
  expect(store.getState().sheet).toBeNull();
});

test("⌘⇧C on the board copies the selected row's PR URL", async () => {
  const { s, copied } = await renderApp({ kind: "board", scope: "mine" }, "o/r#2");
  s.mockInput.pressKey("c", { super: true, shift: true });
  await s.renderOnce();
  expect(copied()).toEqual(["https://github.com/o/r/pull/2"]);
});

test("plain c / C and ⌘C do not copy", async () => {
  const { s, copied } = await renderApp({ kind: "pr", repo, n: 1, scope: "mine" }, null);
  s.mockInput.pressKey("c");
  s.mockInput.pressKey("c", { super: true });
  s.mockInput.pressKey("c", { shift: true });
  await s.renderOnce();
  expect(copied()).toEqual([]);
});

test("⌘⇧C does nothing special while the search input is focused", async () => {
  const { s, copied } = await renderApp({ kind: "pr", repo, n: 1, scope: "mine" }, null);
  s.mockInput.pressKey("/");
  await s.renderOnce();
  s.mockInput.pressKey("c", { super: true, shift: true });
  await s.renderOnce();
  expect(copied()).toEqual([]);
});
