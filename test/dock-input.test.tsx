import { afterEach, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { useEffect, useState } from "react";
import { PALETTE_LINE, Store, StoreContext, useStore, useStoreInstance } from "../src/tui/store";
import { ThemeContext, dark } from "../src/tui/theme";
import { DockInput } from "../src/tui/ui";

let setup: TestRendererSetup | null = null;
afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

/** A line owner like the palette: keeps the query in state and publishes it from an effect, so the dock lags a render behind. */
function Owner({ initial }: { initial: string }) {
  const store = useStoreInstance();
  const [query, setQuery] = useState(initial);
  useEffect(() => {
    store.setSearchLine(PALETTE_LINE, { query, active: true, info: "", onInput: setQuery });
  }, [store, query]);
  return null;
}

function Dock() {
  const line = useStore((s) => s.searchLine);
  return <box height={1}>{line ? <DockInput line={line} /> : null}</box>;
}

async function render(initial: string) {
  const store = new Store("/nonexistent", { gh: { owner: "o", name: "r" }, prefsFile: null });
  setup = await testRender(
    <ThemeContext.Provider value={{ name: "dark", p: dark }}>
      <StoreContext.Provider value={store}>
        <Owner initial={initial} />
        <Dock />
      </StoreContext.Provider>
    </ThemeContext.Provider>,
    { width: 40, height: 3 },
  );
  const s = setup;
  const frame = async () => {
    for (let i = 0; i < 4; i++) await s.renderOnce();
    return s.captureCharFrame();
  };
  return { s, store, frame };
}

test("an insert and a backspace landing before the owner re-publishes leave the deletion in place", async () => {
  const { s, store, frame } = await render("a");
  await frame();
  // one stdin batch: the owner sees `ab` then `a` before its effect publishes either
  await s.mockInput.pressKeys(["b", "\b"]);
  const f = await frame();
  expect(store.getState().searchLine?.query).toBe("a");
  expect(f.split("\n")[0]).toMatch(/^\/a\s*$/);
});

test("a query the owner sets itself shows in the input", async () => {
  const { store, frame } = await render("");
  await frame();
  // the owner moves its own query, as `:repo` does
  store.getState().searchLine!.onInput("repo ");
  const f = await frame();
  expect(f.split("\n")[0]).toMatch(/^\/repo\s*$/);
  expect(store.getState().searchLine?.query).toBe("repo ");
});
