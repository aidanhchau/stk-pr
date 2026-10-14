import { afterEach, expect, test } from "bun:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { Footer } from "../src/tui/sheets";
import { Store, StoreContext } from "../src/tui/store";
import { ThemeContext, dark } from "../src/tui/theme";
import { Pill, Sheet } from "../src/tui/ui";

let setup: TestRendererSetup | null = null;
afterEach(() => {
  setup?.renderer.destroy();
  setup = null;
});

const HINT = "↑↓ ⏎ target · f force · t squash · w when ready";

/** The merge-stack footer with two PRs, at `width` terminal columns; returns the sheet's rows (border to border). */
async function render(width: number): Promise<string[]> {
  setup = await testRender(
    <ThemeContext.Provider value={{ name: "dark", p: dark }}>
      <StoreContext.Provider value={new Store("/nonexistent", { gh: { owner: "o", name: "r" } })}>
        <Sheet title="Merge stack #1178">
          <Footer left={HINT}>
            <Pill label="Merge when ready" hint="w" variant="secondary" onPress={() => {}} />
            <Pill label="Merge stack (2 PRs)" hint="⏎" variant="primary" onPress={() => {}} />
          </Footer>
        </Sheet>
      </StoreContext.Provider>
    </ThemeContext.Provider>,
    { width, height: 30 },
  );
  await setup.renderOnce();
  return setup.captureCharFrame().split("\n").filter((l) => l.includes("│"));
}

for (const width of [48, 64, 100]) {
  test(`at ${width} columns every footer action is fully inside the sheet`, async () => {
    const rows = await render(width);
    // Inside text only: between the sheet's left and right border.
    const inner = rows.map((l) => l.slice(l.indexOf("│") + 1, l.lastIndexOf("│")));
    const text = inner.join("\n");
    for (const label of ["Cancel esc", "Merge when ready w", "Merge stack (2 PRs) ⏎"]) expect(text).toContain(label);
    // Nothing drawn past the right border.
    for (const l of rows) expect(l.slice(l.lastIndexOf("│") + 1).trim()).toBe("");
  });
}
