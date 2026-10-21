// Which merge methods a base branch allows, and which one stk actually uses. Pure; the allowed set is read in service.ts.
import { StkError, type MergeMethod } from "./types";

/** Cycling order of `t`. */
export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

/** What the fallback prefers when the remembered method is not allowed. */
const FALLBACK_ORDER: readonly MergeMethod[] = ["squash", "rebase", "merge"];

const WORDS: Record<MergeMethod, string> = { squash: "squash merges", merge: "merge commits", rebase: "rebase merges" };

/** `allowed` (null = unknown) restricted to MERGE_METHODS order. */
export function intersectMethods(a: readonly MergeMethod[] | null, b: readonly MergeMethod[] | null): MergeMethod[] | null {
  if (!a) return b ? [...b] : null;
  if (!b) return [...a];
  return a.filter((m) => b.includes(m));
}

/** The remembered method when allowed (or when the allowed set is unknown), else the first allowed of squash, rebase, merge. */
export function effectiveMethod(pref: MergeMethod | undefined, allowed: readonly MergeMethod[] | null | undefined): MergeMethod {
  const want = pref ?? "squash";
  if (!allowed || allowed.length === 0 || allowed.includes(want)) return want;
  return FALLBACK_ORDER.find((m) => allowed.includes(m)) ?? want;
}

/** The next allowed method after `current` in cycling order; unchanged when only one is allowed. */
export function nextMethod(current: MergeMethod, allowed: readonly MergeMethod[] | null | undefined): MergeMethod {
  const ring = allowed && allowed.length > 0 ? MERGE_METHODS.filter((m) => allowed.includes(m)) : MERGE_METHODS;
  const at = ring.indexOf(current);
  return ring[(at + 1) % ring.length]!;
}

/** Brief note when the remembered method is not allowed on `branch`, else null. */
export function fallbackNote(pref: MergeMethod | undefined, allowed: readonly MergeMethod[] | null | undefined, branch: string): string | null {
  const want = pref ?? "squash";
  if (!allowed || allowed.length === 0 || allowed.includes(want)) return null;
  return `${WORDS[want]} not allowed on ${branch}`;
}

/** Pre-flight for an explicit method: throws a usage error naming the allowed ones. Unknown allowed set passes. */
export function assertMethodAllowed(method: MergeMethod, allowed: readonly MergeMethod[] | null, branch: string): void {
  if (!allowed || allowed.includes(method)) return;
  const list = allowed.length > 0 ? allowed.join(", ") : "none";
  throw new StkError(`merge method '${method}' is not allowed on ${branch}; allowed: ${list}`, "usage");
}
