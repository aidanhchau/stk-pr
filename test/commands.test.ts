import { describe, expect, test } from "bun:test";
import { COMMANDS, available, commandHint, rankCommands, type PrFacts } from "../src/commands";

const facts = (over: Partial<PrFacts> = {}): PrFacts => ({ state: "OPEN", isDraft: false, failingChecks: false, behind: false, baseMerged: false, inStack: false, hasWorktree: false, nativeStack: false, onPage: false, ...over });
const names = (q: string, f: PrFacts | null) => rankCommands(q, f).map((r) => r.def.id);

describe("palette commands", () => {
  test("prefix of a name, a word or an alias ranks the command", () => {
    expect(names("mer", facts())).toEqual(["merge", "merge-stack", "merge-when-ready"]);
    expect(names("stack", facts())).toEqual(["stack-submit", "merge-stack"]);
    expect(names("pr", facts())).toEqual(["close", "create-pr"]);
    expect(names("lgtm", facts())).toEqual(["approve"]);
    expect(names("appr", facts())).toEqual(["approve"]);
  });

  test("title-like and numeric queries do not pull commands in; empty query lists none", () => {
    expect(names("quiet", facts())).toEqual([]);
    expect(names("123", facts())).toEqual([]);
    expect(names("", facts())).toEqual([]);
  });

  test("availability follows the PR state", () => {
    expect(names("close", facts({ state: "MERGED" }))).toEqual([]);
    expect(names("reopen", facts({ state: "OPEN" }))).toEqual([]);
    expect(names("reopen", facts({ state: "CLOSED" }))).toEqual(["reopen"]);
    expect(names("ready", facts({ isDraft: false }))).toEqual(["merge-when-ready"]);
    expect(names("ready", facts({ isDraft: true }))).toEqual(["ready"]);
    expect(names("convert", facts({ isDraft: true }))).toEqual([]);
    expect(names("convert", facts())).toEqual(["draft"]);
    expect(names("rerun", facts())).toEqual([]);
    expect(names("rerun", facts({ failingChecks: true }))).toEqual(["rerun"]);
    expect(names("worktree", facts())).toEqual([]);
    expect(names("worktree", facts({ hasWorktree: true }))).toEqual(["worktree"]);
  });

  test("merge when ready: open non-draft PRs, found by :auto-merge too; cancel only while one waits", () => {
    expect(names("merge-when", facts())).toEqual(["merge-when-ready"]);
    expect(names("auto-merge", facts())).toEqual(["merge-when-ready"]);
    expect(names("merge-when", facts({ isDraft: true }))).toEqual([]);
    expect(names("merge-when", facts({ state: "MERGED" }))).toEqual([]);
    expect(names("merge-when", facts({ waitingToMerge: true }))).toEqual([]);
    expect(names("cancel-merge", facts())).toEqual([]);
    expect(names("cancel-merge", facts({ waitingToMerge: true }))).toEqual(["cancel-merge"]);
    expect(names("cancel", facts({ waitingToMerge: true }))).toEqual(["cancel-merge"]);
  });

  test("update branch only when behind", () => {
    expect(names("update", facts())).toEqual([]);
    expect(names("update", facts({ behind: true }))).toEqual(["update-branch"]);
  });

  test("no target keeps only global commands; page toggles need the PR page", () => {
    expect(names("ref", null)).toEqual(["refresh"]);
    expect(names("merge", null)).toEqual([]);
    expect(names("bots", facts())).toEqual([]);
    expect(names("bots", facts({ onPage: true }))).toEqual(["toggle-bots"]);
    expect(names("fix", facts({ onPage: true }))).toEqual(["fix"]);
    expect(names("fix", facts({ onPage: false }))).toEqual([]);
  });

  test("close and draft are the confirm-first commands", () => {
    expect(COMMANDS.filter((c) => c.destructive).map((c) => c.id).sort()).toEqual(["close", "draft"]);
    expect(available(COMMANDS.find((c) => c.id === "refresh")!, null)).toBe(true);
  });
});

import { baseCandidates, isMergedBase, rankBases } from "../src/commands";
import type { PaletteItem } from "../src/fuzzy";

const item = (n: number, headRef: string, state: PaletteItem["state"], repo = "o/r"): PaletteItem => ({ repo, number: n, title: "t", headRef, author: "a", state, isDraft: false, updatedAt: "" });

describe("base retarget helpers", () => {
  const items = [item(1, "octo/churn-pause", "MERGED"), item(2, "feat/x", "OPEN"), item(3, "feat/y", "OPEN", "o/other"), item(4, "octo/mine", "OPEN")];
  test("candidates: default first, then open heads of the same repo, minus the PR's own head", () => {
    expect(baseCandidates("main", items, "o/r", ["octo/mine"])).toEqual(["main", "feat/x"]);
  });
  test("merged base detection", () => {
    expect(isMergedBase(items, "o/r", "octo/churn-pause")).toBe(true);
    expect(isMergedBase(items, "o/r", "feat/x")).toBe(false);
    expect(isMergedBase(items, "o/r", "main")).toBe(false);
    expect(isMergedBase([...items, item(5, "octo/churn-pause", "OPEN")], "o/r", "octo/churn-pause")).toBe(false);
  });
  test("branch ranking keeps order when empty, filters, and offers a typed free name", () => {
    expect(rankBases(["main", "feat/x"], "").map((r) => r.name)).toEqual(["main", "feat/x"]);
    expect(rankBases(["main", "feat/x"], "fx").map((r) => r.name)).toEqual(["feat/x", "fx"]);
    const typed = rankBases(["main", "feat/x"], "release/1");
    expect(typed).toEqual([{ name: "release/1", positions: [], free: true }]);
    expect(rankBases(["main"], "main").every((r) => !r.free)).toBe(true);
  });
  test("rebase stack only for stack members", () => {
    expect(names("rebase", facts())).toEqual([]);
    expect(names("rebase", facts({ inStack: true }))).toEqual(["rebase-stack"]);
    expect(names("reb", facts({ inStack: true }))).toEqual(["rebase-stack"]);
  });
  test("native stack members cannot change base: base/retarget rank Rebase stack instead", () => {
    const f = facts({ inStack: true, nativeStack: true });
    expect(names("base", f)).toEqual(["rebase-stack"]);
    expect(names("retarget", f)).toEqual(["rebase-stack"]);
    expect(names("base", facts({ inStack: true }))).toEqual(["base", "rebase-stack"]);
  });
  test("base command is available on open PRs only", () => {
    expect(names("base", facts())).toEqual(["base"]);
    expect(names("retarget", facts())).toEqual(["base"]);
    expect(names("base", facts({ state: "MERGED" }))).toEqual([]);
  });
});

describe("preference commands", () => {
  test("notify and reduced-motion rank from their names and need no PR", () => {
    expect(names("notify", null)).toEqual(["notify-toast", "notify-system", "notify-off"]);
    expect(names("notify o", null)).toEqual(["notify-off"]);
    expect(names("reduced-motion", null)).toEqual(["motion-on", "motion-off"]);
    expect(names("reduced motion off", null)).toEqual(["motion-off"]);
  });

  test("row detail shows the current setting", () => {
    const hint = (id: string, prefs: Parameters<typeof commandHint>[1]) => commandHint(COMMANDS.find((c) => c.id === id)!, prefs);
    expect(hint("notify-off", { notify: "off" })).toContain("current");
    expect(hint("notify-toast", { notify: "off" })).not.toContain("current");
    expect(hint("notify-system", {})).toContain("auto");
    expect(hint("motion-on", { reducedMotion: true })).toContain("current");
    expect(hint("motion-off", {})).toContain("current");
    expect(hint("motion-on", {})).not.toContain("current");
  });
});
