import type { Blocker, Check, CheckState } from "../types";

export type CurrentCheck = Check & { expected?: boolean };

/** Repository-required contexts can be absent from the reported head rollup. */
export function currentChecks(checks: Check[], blockers: Blocker[]): CurrentCheck[] {
  const missing = [...new Set(blockers.flatMap((b) => b.kind === "required-check" ? [b.context] : []))];
  return [
    ...checks.filter((c) => !missing.includes(c.name)),
    ...missing.map((name): CurrentCheck => ({ name, state: "pending", url: null, expected: true })),
  ];
}

/** A skipped result is not a passing test; absent results have no success signal. */
export function checkSummary(checks: Check[]): { text: string; state: CheckState | "none" } {
  if (!checks.length) return { text: "No checks reported", state: "none" };
  const count = (state: CheckState) => checks.filter((c) => c.state === state).length;
  const fail = count("fail"), pending = count("pending"), pass = count("pass"), skipped = count("skipped");
  const text = [fail && `${fail} failing`, pending && `${pending} pending`, pass && `${pass} passing`, skipped && `${skipped} skipped`].filter(Boolean).join(" · ");
  return { text: pass === checks.length ? "all passing" : text, state: fail ? "fail" : pending ? "pending" : skipped ? "skipped" : "pass" };
}
