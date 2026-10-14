import { afterEach, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { Store, StoreContext } from "../src/tui/store";
import { ToastArea } from "../src/tui/ui";

let setup: TestRendererSetup | null = null;
afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

async function render(text: string, width: number): Promise<string[]> {
  const store = new Store("/nonexistent", { gh: { owner: "o", name: "r" } });
  store.toast(text, "error");
  setup = await testRender(
    <StoreContext.Provider value={store}>
      <ToastArea />
    </StoreContext.Provider>,
    { width, height: 20 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n");
}

// Every word must be on screen, in order, and no row may run past the terminal's right edge.
async function expectFullyVisible(text: string, width: number): Promise<void> {
  const rows = await render(text, width);
  const shown = rows.join(" ").replace(/[✗✓●×]/g, " ").split(/\s+/).filter(Boolean).join(" ");
  expect(shown).toContain(text);
  for (const r of rows) expect(r.trimEnd().length).toBeLessThanOrEqual(width);
}

test("a long toast wraps onto several rows on a narrow terminal instead of clipping", async () => {
  await expectFullyVisible("Updated the branch of #2391 so it now includes the latest main", 44);
});

test("a long error toast is fully visible on a wide terminal", async () => {
  await expectFullyVisible(
    "Stack #2391 stopped at #2391: merge of #2391 failed: Rules can only be bypassed when merging the bottom-most unmerged pull request in the stack.",
    120,
  );
});
