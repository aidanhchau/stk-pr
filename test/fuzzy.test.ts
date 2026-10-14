import { describe, expect, test } from "bun:test";
import { ageOf, dedupeItems, fuzzyMatch, parseTarget, rankPrs, type PaletteItem } from "../src/fuzzy";

const pr = (number: number, title: string, over: Partial<PaletteItem> = {}): PaletteItem => ({
  repo: "o/r",
  number,
  title,
  headRef: "feat",
  author: "ana",
  state: "OPEN",
  isDraft: false,
  updatedAt: "2026-10-01T00:00:00Z",
  ...over,
});
const order = (items: PaletteItem[], q: string) => rankPrs(items, q).map((r) => r.item.number);

describe("fuzzy ranking", () => {
  test("exact number first, with or without #", () => {
    const items = [pr(1, "Bump 123 deps"), pr(123, "Unrelated"), pr(1234, "Other")];
    expect(order(items, "123")[0]).toBe(123);
    expect(order(items, "#123")[0]).toBe(123);
    expect(order(items, "#12")).toContain(1234);
  });

  test("word start beats mid-word", () => {
        expect(fuzzyMatch("ca", "Add cache")!.score).toBeGreaterThan(fuzzyMatch("ca", "Abaca")!.score);
    expect(order([pr(1, "scache"), pr(2, "cache")], "cache")[0]).toBe(2);
    expect(order([pr(1, "xxauth"), pr(2, "fix auth")], "auth")[0]).toBe(2);
  });

  test("contiguous run beats scattered letters; non-subsequence is dropped", () => {
    const items = [pr(1, "a big rotating thing"), pr(2, "bug fix"), pr(3, "unrelated")];
    expect(order(items, "bug")[0]).toBe(2);
    expect(order(items, "zzz")).toEqual([]);
  });

  test("weak scattered matches are dropped for queries of 3+ chars", () => {
    expect(fuzzyMatch("reb", "Reject self-calls before core startCall")).toBeNull();
    expect(fuzzyMatch("reb", "Rebase the stack")).not.toBeNull();
    expect(fuzzyMatch("reb", "Fix rebuild")).not.toBeNull();
    expect(fuzzyMatch("pnl", "Pay no lag")).not.toBeNull(); // acronym: every char starts a word
    expect(fuzzyMatch("re", "Reject self-calls before")).not.toBeNull(); // short queries stay loose
    expect(order([pr(1, "Reject self-calls before core"), pr(2, "Rebase onto main")], "reb")).toEqual([2]);
  });

  test("recency breaks ties; empty query is newest first", () => {
    const items = [pr(1, "same title", { updatedAt: "2026-09-01T00:00:00Z" }), pr(2, "same title", { updatedAt: "2026-10-05T00:00:00Z" })];
    expect(order(items, "same")).toEqual([2, 1]);
    expect(order(items, "")).toEqual([2, 1]);
  });

  test("matches branch, author and repo name; positions point into the title", () => {
    const items = [pr(1, "Title", { headRef: "octo/churn", author: "zed" }), pr(2, "Other", { author: "ana" })];
    expect(order(items, "churn")).toEqual([1]);
    expect(order(items, "ana")).toEqual([2]);
    expect(rankPrs([pr(3, "Add cache layer")], "cache")[0]!.positions).toEqual([4, 5, 6, 7, 8]);
  });

  test("every term must match", () => {
    const items = [pr(1, "Add cache layer"), pr(2, "Add widget")];
    expect(order(items, "add cache")).toEqual([1]);
  });
});

describe("palette helpers", () => {
  test("parseTarget reads refs and URLs", () => {
    expect(parseTarget("acme/web#42")).toEqual({ owner: "acme", name: "web", number: 42 });
    expect(parseTarget("https://github.com/acme/web/pull/42/files")).toEqual({ owner: "acme", name: "web", number: 42 });
    expect(parseTarget("github.com/acme/web/pull/7")).toEqual({ owner: "acme", name: "web", number: 7 });
    expect(parseTarget("#42")).toBeNull();
    expect(parseTarget("some title")).toBeNull();
  });

  test("dedupe keeps the newest entry per repo+number", () => {
    const out = dedupeItems([[pr(1, "old", { updatedAt: "2026-01-01T00:00:00Z" })], [pr(1, "new", { updatedAt: "2026-02-01T00:00:00Z" }), pr(1, "x", { repo: "o/other" })]]);
    expect(out.map((i) => i.title).sort()).toEqual(["new", "x"]);
  });

  test("ageOf", () => {
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(ageOf("2026-10-13T11:59:30Z", now)).toBe("now");
    expect(ageOf("2026-10-13T09:00:00Z", now)).toBe("3h");
    expect(ageOf("2026-10-06T12:00:00Z", now)).toBe("1w");
  });
});
