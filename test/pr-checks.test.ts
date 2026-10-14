import { expect, test } from "bun:test";
import { checkSummary, currentChecks } from "../src/tui/pr-checks";

test("only actual passing results without missing contexts produce an all-passing summary", () => {
  expect(checkSummary([])).toEqual({ text: "No checks reported", state: "none" });
  expect(checkSummary([{ name: "Tests", state: "skipped", url: null }])).toEqual({ text: "1 skipped", state: "skipped" });
  expect(checkSummary([
    { name: "Lint", state: "pass", url: null },
    { name: "Tests", state: "skipped", url: null },
  ])).toEqual({ text: "1 passing · 1 skipped", state: "skipped" });
  expect(checkSummary([{ name: "Tests", state: "pass", url: null }])).toEqual({ text: "all passing", state: "pass" });
  const checks = currentChecks([{ name: "Lint", state: "pass", url: null }], [
    { kind: "required-check", context: "Depot PR tests / test" },
    { kind: "required-check", context: "Depot PR tests / test" },
  ]);
  expect(checks).toHaveLength(2);
  expect(checks[1]).toEqual({ name: "Depot PR tests / test", state: "pending", url: null, expected: true });
  expect(checkSummary(checks)).toEqual({ text: "1 pending · 1 passing", state: "pending" });
});

test("an unsatisfied required context overrides a reported green result with the same name", () => {
  const checks = currentChecks([{ name: "Tests", state: "pass", url: "https://x/old-run" }], [{ kind: "required-check", context: "Tests" }]);
  expect(checks).toEqual([{ name: "Tests", state: "pending", url: null, expected: true }]);
});
