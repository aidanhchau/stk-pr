import { describe, expect, test } from "bun:test";
import { requestToken, rowReason, waitLabel } from "../src/waiting";

describe("waiting helpers", () => {
  test("label keeps one width across frames; still is static", () => {
    const w = [0, 1, 2, 3].map((t) => waitLabel("Planning", t).length);
    expect(new Set(w).size).toBe(1);
    expect(waitLabel("Planning", 1)).toBe("Planning ·· ");
    expect(waitLabel("Planning", 5, true)).toBe("Planning…");
  });
  test("a stale request result is dropped", () => {
    const t = requestToken();
    const a = t.next();
    const b = t.next();
    expect(t.current(a)).toBe(false);
    expect(t.current(b)).toBe(true);
  });
  test("row reasons: prefix dropped, bypass only for bypassable", () => {
    expect(rowReason("#7 is blocked: checks (pending: ci)", 7, false)).toEqual({ text: "checks (pending: ci)", hard: false });
    expect(rowReason("#7 is blocked: checks (pending: ci)", 7, true).text).toBe("bypass: checks (pending: ci)");
    expect(rowReason("#7 is a draft", 7, true)).toEqual({ text: "is a draft", hard: true });
  });
});
