import { describe, expect, test } from "bun:test";
import { anchorRestore, clampTop, glideSteps, scrolloffTarget } from "../src/tui/scrollmath";

describe("scrolloffTarget", () => {
  test("inside the margin: no scroll", () => {
    expect(scrolloffTarget(10, 20, 20, 1)).toBe(10);
  });
  test("within 3 lines of bottom: minimum scroll", () => {
    // item at line 27 (h1) -> bottom edge 28+3=31 > 30 -> top 11
    expect(scrolloffTarget(10, 20, 27, 1)).toBe(11);
  });
  test("within 3 lines of top: minimum scroll", () => {
    expect(scrolloffTarget(10, 20, 12, 1)).toBe(9);
  });
  test("exactly at margin: no scroll", () => {
    expect(scrolloffTarget(10, 20, 13, 1)).toBe(10);
    expect(scrolloffTarget(10, 20, 26, 1)).toBe(10);
  });
  test("taller than the view shows its top", () => {
    expect(scrolloffTarget(0, 10, 40, 30)).toBe(40);
  });
  test("lead lines stay visible; margin shrinks in tiny viewports", () => {
    expect(scrolloffTarget(10, 20, 12, 1, 2)).toBe(7);
    expect(scrolloffTarget(0, 5, 20, 1)).toBe(18);
  });
});

describe("anchor restore", () => {
  test("item keeps its screen row after re-layout", () => {
    const top = 40;
    const row = 55 - top; // item at content y 55
    expect(anchorRestore(70, row)).toBe(55); // layout above grew by 15
    expect(70 - anchorRestore(70, row)).toBe(row);
  });
  test("clampTop bounds", () => {
    expect(clampTop(-4, 100, 20)).toBe(0);
    expect(clampTop(500, 100, 20)).toBe(80);
    expect(clampTop(3.6, 100, 20)).toBe(4);
    expect(clampTop(5, 10, 20)).toBe(0);
  });
});

describe("glideSteps", () => {
  test("ends exactly at target, strictly monotonic integers, ease-out", () => {
    const s = glideSteps(0, 100);
    expect(s[s.length - 1]).toBe(100);
    expect(s.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < s.length; i++) expect(s[i]!).toBeGreaterThan(s[i - 1]!);
    const d = s.map((v, i) => v - (s[i - 1] ?? 0));
    expect(d[0]!).toBeGreaterThan(d[d.length - 1]!);
    expect(s.every(Number.isInteger)).toBe(true);
  });
  test("upwards", () => {
    const s = glideSteps(90, 10);
    expect(s[s.length - 1]).toBe(10);
    for (let i = 1; i < s.length; i++) expect(s[i]!).toBeLessThan(s[i - 1]!);
  });
  test("small distance dedupes steps", () => {
    expect(glideSteps(0, 5)).toEqual([...new Set(glideSteps(0, 5))]);
    expect(glideSteps(0, 5).at(-1)).toBe(5);
  });
});
