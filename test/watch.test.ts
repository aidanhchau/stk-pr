import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimEvent, checksSummary, diffPr, eventLine, isWaitable, mergeSnap, notifiedDir, pruneNotified, snapFromPr, systemNotify, waitVerdict, type PrSnap } from "../src/watch";
import type { Blocker, Check, ConversationEntry, Exec, PullRequest } from "../src/types";

const snap = (o: Partial<PrSnap> = {}): PrSnap => ({
  state: "OPEN", isDraft: false, author: "me", headSha: "s1", updatedAt: "t1", checks: "pending", failing: [], decision: null, ready: false, threads: 0, ...o,
});
const kinds = (a: PrSnap, b: PrSnap) => diffPr(a, b).map((e) => e.kind);
const text = (a: PrSnap, b: PrSnap) => diffPr(a, b).map((e) => e.text);

describe("diffPr", () => {
  test("no change, no events", () => {
    expect(diffPr(snap(), snap())).toEqual([]);
  });

  test("checks finishing: pass and fail (with names)", () => {
    expect(text(snap(), snap({ checks: "pass" }))).toEqual(["checks passed"]);
    expect(text(snap(), snap({ checks: "fail", failing: ["lint", "test", "build"] }))).toEqual(["checks failed · lint, test +1"]);
    expect(text(snap({ checks: "pass" }), snap({ checks: "fail", failing: ["e2e"] }))).toEqual(["checks failed · e2e"]);
  });

  test("a new push restarting checks is not a finish; none and unchanged are silent", () => {
    expect(kinds(snap({ headSha: "s1" }), snap({ headSha: "s2", checks: "pass" }))).toEqual([]);
    expect(kinds(snap({ checks: "none" }), snap({ checks: "pass" }))).toEqual([]);
    expect(kinds(snap({ checks: "pass" }), snap({ checks: "pass" }))).toEqual([]);
    expect(kinds(snap({ checks: "pending" }), snap({ checks: "pending" }))).toEqual([]);
  });

  test("new reviews by id, with the author", () => {
    const prev = snap({ reviews: [{ id: "r1", author: "ana", state: "COMMENTED" }] });
    const next = snap({
      decision: "APPROVED",
      reviews: [
        { id: "r1", author: "ana", state: "COMMENTED" },
        { id: "r2", author: "bob", state: "APPROVED" },
        { id: "r3", author: "cy", state: "CHANGES_REQUESTED" },
        { id: "r4", author: "di", state: "COMMENTED" },
        { id: "r5", author: "me", state: "COMMENTED" },
      ],
    });
    expect(diffPr(prev, next).map((e) => [e.kind, e.text, e.tone])).toEqual([
      ["approved", "approved by @bob", "success"],
      ["changes-requested", "changes requested by @cy", "error"],
      ["commented", "@di commented", "info"],
    ]);
  });

  test("without review lists the overall decision change is reported, without an author", () => {
    expect(text(snap(), snap({ decision: "APPROVED" }))).toEqual(["approved"]);
    expect(text(snap({ decision: "APPROVED" }), snap({ decision: "CHANGES_REQUESTED" }))).toEqual(["changes requested"]);
    expect(kinds(snap({ decision: "APPROVED" }), snap({ decision: null }))).toEqual([]);
  });

  test("with review lists the decision alone does not repeat the review", () => {
    const reviews = [{ id: "r1", author: "bob", state: "APPROVED" }];
    expect(kinds(snap({ reviews }), snap({ reviews, decision: "APPROVED" }))).toEqual([]);
  });

  test("becoming mergeable; together with passing checks it is one event", () => {
    expect(text(snap({ checks: "pass" }), snap({ checks: "pass", ready: true }))).toEqual(["ready to merge"]);
    expect(diffPr(snap(), snap({ checks: "pass", ready: true })).map((e) => [e.kind, e.text])).toEqual([["checks-passed", "checks passed · ready to merge"]]);
    expect(kinds(snap({ ready: true }), snap({ ready: true }))).toEqual([]);
    expect(kinds(snap({ ready: true }), snap({ ready: false }))).toEqual([]);
  });

  test("merged / closed end the story and nothing else is reported", () => {
    expect(diffPr(snap(), snap({ state: "MERGED", checks: "pass", ready: true })).map((e) => [e.kind, e.text])).toEqual([["merged", "merged"]]);
    expect(diffPr(snap(), snap({ state: "CLOSED" })).map((e) => [e.kind, e.tone])).toEqual([["closed", "error"]]);
    expect(diffPr(snap({ state: "MERGED" }), snap({ state: "MERGED" }))).toEqual([]);
    expect(diffPr(snap({ state: "CLOSED" }), snap({ state: "OPEN", checks: "pass" }))).toEqual([]);
  });

  test("new unresolved threads", () => {
    expect(text(snap({ threads: 1 }), snap({ threads: 2 }))).toEqual(["new unresolved thread"]);
    expect(text(snap({ threads: 0 }), snap({ threads: 3 }))).toEqual(["3 new unresolved threads"]);
    expect(kinds(snap({ threads: 3 }), snap({ threads: 2 }))).toEqual([]);
  });

  test("event keys are stable for the same occurrence and differ across occurrences", () => {
    const a = diffPr(snap(), snap({ checks: "pass" }))[0]!;
    const b = diffPr(snap(), snap({ checks: "pass" }))[0]!;
    expect(a.key).toBe(b.key);
    expect(diffPr(snap({ headSha: "s2" }), snap({ headSha: "s2", checks: "pass" }))[0]!.key).not.toBe(a.key);
    expect(diffPr(snap({ threads: 0 }), snap({ threads: 1, updatedAt: "t2" }))[0]!.key).not.toBe(diffPr(snap({ threads: 0 }), snap({ threads: 1, updatedAt: "t1" }))[0]!.key);
  });

  test("toast line names the repo and PR", () => {
    expect(eventLine({ name: "widgets" }, 2391, { text: "checks passed" })).toBe("widgets #2391 · checks passed");
  });
});

describe("snapshots", () => {
  const pr = (o: Partial<PullRequest> = {}): PullRequest => ({
    number: 1, title: "t", url: "u", author: "me", state: "OPEN", isDraft: false, headRef: "h", baseRef: "main", createdAt: "", updatedAt: "t1", headSha: "s1",
    mergeable: "MERGEABLE", reviewDecision: "APPROVED", checks: [], unresolvedThreads: 0, body: "", worktree: null, ...o,
  });
  const check = (name: string, state: Check["state"]): Check => ({ name, state, url: null });

  test("checksSummary", () => {
    expect(checksSummary([])).toBe("none");
    expect(checksSummary([check("a", "skipped")])).toBe("none");
    expect(checksSummary([check("a", "pass"), check("b", "pending")])).toBe("pending");
    expect(checksSummary([check("a", "pending"), check("b", "fail")])).toBe("fail");
    expect(checksSummary([check("a", "pass"), check("b", "skipped")])).toBe("pass");
  });

  test("snapFromPr: ready needs open, not draft, no blockers; reviews skip bots", () => {
    const blocked: Blocker[] = [{ kind: "threads", count: 1 }];
    expect(snapFromPr(pr(), []).ready).toBe(true);
    expect(snapFromPr(pr(), blocked).ready).toBe(false);
    expect(snapFromPr(pr({ isDraft: true }), []).ready).toBe(false);
    expect(snapFromPr(pr({ state: "MERGED" }), []).ready).toBe(false);
    expect(snapFromPr(pr(), []).reviews).toBeUndefined();
    const conv = [
      { kind: "review", id: "r1", author: "ana", state: "APPROVED", isBot: false },
      { kind: "review", id: "r2", author: "bot", state: "COMMENTED", isBot: true },
      { kind: "comment", id: "c1", author: "ana", isBot: false },
    ] as ConversationEntry[];
    expect(snapFromPr(pr(), [], conv).reviews).toEqual([{ id: "r1", author: "ana", state: "APPROVED" }]);
    expect(snapFromPr({ number: 1 } as PullRequest, []).checks).toBe("none");
  });

  test("mergeSnap keeps known reviews when the newer snapshot (a board row) has none", () => {
    const reviews = [{ id: "r1", author: "a", state: "APPROVED" }];
    expect(mergeSnap(snap({ reviews }), snap()).reviews).toEqual(reviews);
    expect(mergeSnap(snap({ reviews }), snap({ reviews: [] })).reviews).toEqual([]);
    expect(mergeSnap(undefined, snap()).reviews).toBeUndefined();
  });
});

describe("claimEvent", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "stk-notified-"));
    process.env.STK_NOTIFIED_DIR = dir;
  });
  afterEach(() => {
    delete process.env.STK_NOTIFIED_DIR;
    rmSync(dir, { recursive: true, force: true });
  });
  const repo = { owner: "Acme", name: "Widgets" };

  test("the first claim wins, later ones (another pane) lose; case-insensitive on the repo", () => {
    expect(claimEvent(repo, 5, "checks:pass:s1")).toBe(true);
    expect(claimEvent(repo, 5, "checks:pass:s1")).toBe(false);
    expect(claimEvent({ owner: "acme", name: "widgets" }, 5, "checks:pass:s1")).toBe(false);
    expect(readdirSync(notifiedDir()).length).toBe(1);
  });

  test("other PRs, repos and events are independent", () => {
    expect(claimEvent(repo, 5, "k")).toBe(true);
    expect(claimEvent(repo, 6, "k")).toBe(true);
    expect(claimEvent({ owner: "acme", name: "other" }, 5, "k")).toBe(true);
    expect(claimEvent(repo, 5, "k2")).toBe(true);
  });

  test("an unusable cache dir does not silence events", () => {
    process.env.STK_NOTIFIED_DIR = join(dir, "file");
    expect(claimEvent(repo, 1, "k")).toBe(true);
    process.env.STK_NOTIFIED_DIR = "/dev/null/nope";
    expect(claimEvent(repo, 1, "k")).toBe(true);
  });

  test("pruneNotified deletes only day-old markers", () => {
    claimEvent(repo, 1, "old");
    claimEvent(repo, 1, "new");
    const [old] = readdirSync(dir).sort();
    const file = join(dir, old!);
    const past = new Date(Date.now() - 25 * 3_600_000);
    utimesSync(file, past, past);
    pruneNotified();
    expect(existsSync(file)).toBe(false);
    expect(readdirSync(dir).length).toBe(1);
  });
});

describe("systemNotify", () => {
  test("posts a titled display notification via osascript, escaping quotes", async () => {
    const calls: string[][] = [];
    const run: Exec = async (argv) => {
      calls.push([...argv]);
      return { code: 0, stdout: "", stderr: "" };
    };
    await systemNotify('widgets #5 · "quoted" \\ done\nnext', run, "darwin");
    expect(calls).toEqual([["osascript", "-e", 'display notification "widgets #5 · \\"quoted\\" \\\\ done next" with title "stk"']]);
  });

  test("does nothing off macOS and never throws", async () => {
    let called = false;
    await systemNotify("x", async () => ((called = true), { code: 0, stdout: "", stderr: "" }), "linux");
    expect(called).toBe(false);
    await systemNotify("x", async () => {
      throw new Error("boom");
    }, "darwin");
  });
});

describe("waitVerdict", () => {
  test("no blockers: ready", () => {
    expect(waitVerdict([], 7)).toEqual({ verdict: "ready" });
  });

  test("soft blockers are waited out, with the reasons combined", () => {
    const bs: Blocker[] = [{ kind: "checks", failing: [], pending: ["build"] }, { kind: "review", decision: "REVIEW_REQUIRED" }, { kind: "threads", count: 2 }];
    expect(waitVerdict(bs, 7)).toEqual({ verdict: "wait", reason: "checks pending, needs review, 2 open threads" });
    expect(waitVerdict([{ kind: "required-check", context: "ci" }], 7)).toEqual({ verdict: "wait", reason: "required check 'ci' hasn't run" });
    expect(waitVerdict([{ kind: "checking" }], 7)).toEqual({ verdict: "wait", reason: "checking for conflicts" });
  });

  test("hard blockers win over soft ones", () => {
    expect(waitVerdict([{ kind: "checks", failing: [], pending: ["a"] }, { kind: "conflict", base: "main" }], 7)).toEqual({ verdict: "hard", reason: "#7 conflicts with main" });
    expect(waitVerdict([{ kind: "review", decision: "CHANGES_REQUESTED" }], 7)).toEqual({ verdict: "hard", reason: "changes requested on #7" });
    expect(waitVerdict([{ kind: "checks", failing: ["lint"], pending: [] }], 7)).toEqual({ verdict: "hard", reason: "checks failed on #7: lint" });
    expect(waitVerdict([{ kind: "draft" }], 7)).toEqual({ verdict: "hard", reason: "#7 is a draft" });
    expect(waitVerdict([{ kind: "behind", count: 2, base: "main" }], 7).verdict).toBe("hard");
  });

  test("isWaitable: non-empty and nothing hard", () => {
    expect(isWaitable([])).toBe(false);
    expect(isWaitable([{ kind: "checks", failing: [], pending: ["a"] }])).toBe(true);
    expect(isWaitable([{ kind: "checks", failing: ["a"], pending: [] }])).toBe(false);
    expect(isWaitable([{ kind: "review", decision: "REVIEW_REQUIRED" }, { kind: "draft" }])).toBe(false);
  });
});
