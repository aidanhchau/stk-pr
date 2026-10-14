import { describe, expect, test } from "bun:test";
import type { ReviewThread } from "../src/github";
import type { ConversationEntry } from "../src/types";
import { activityId, activityLayout, activityMeta, defaultLevel, foldBots, groupActivity, parseSeverity, type ActivityItem, type ActivityRow, type Level, type RL } from "../src/tui/activity";
import { parseComment } from "../src/tui/markdown";

const t0 = Date.parse("2026-01-01T00:00:00Z");
const iso = (min: number) => new Date(t0 + min * 60_000).toISOString();

const entry = (id: string, min: number, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  kind: "comment",
  id,
  author: "alice",
  isBot: false,
  body: `comment ${id}`,
  createdAt: iso(min),
  url: `https://x/${id}`,
  minimized: false,
  ...extra,
});

const thread = (id: string, min: number, body = "**Bug** here", extra: Partial<ReviewThread> = {}): ReviewThread => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: "src/a.ts",
  line: 7,
  startLine: null,
  resolvedBy: null,
  diffHunk: null,
  comments: [{ author: "devin-ai-integration[bot]", isBot: true, body, createdAt: iso(min), url: `https://x/${id}`, mine: false }],
  ...extra,
});

const review = (id: string, min: number, threadIds: string[]): ConversationEntry =>
  entry(id, min, { kind: "review", findings: { total: threadIds.length, open: threadIds.length, resolved: 0, outdated: 0, threadIds } });

const ids = (xs: ActivityItem[]) => xs.map((x) => `${x.kind === "thread" && x.nested ? ">" : ""}${activityId(x)}`);

describe("groupActivity", () => {
  test("orders comments, reviews and threads by time", () => {
    const out = groupActivity([entry("c2", 20), entry("c1", 5)], [thread("th1", 10), thread("th0", 1)]);
    expect(ids(out)).toEqual(["t:th0", "v:c1", "t:th1", "v:c2"]);
  });

  test("a review nests its findings directly under it, chronologically", () => {
    const out = groupActivity([entry("c1", 0), review("r1", 10, ["b", "a"]), entry("c2", 30)], [thread("a", 11), thread("b", 9), thread("free", 20)]);
    expect(ids(out)).toEqual(["v:c1", "v:r1", ">t:b", ">t:a", "t:free", "v:c2"]);
  });

  test("unattributed threads stand at their own time; unknown ids are ignored", () => {
    const out = groupActivity([review("r1", 10, ["ghost"]), entry("c1", 40)], [thread("late", 25)]);
    expect(ids(out)).toEqual(["v:r1", "t:late", "v:c1"]);
  });

  test("a thread whose review is not shown stands alone at its own time", () => {
    const out = groupActivity([entry("c1", 50)], [thread("a", 5)]);
    expect(ids(out)).toEqual(["t:a", "v:c1"]);
  });
});

describe("parseSeverity", () => {
  const sev = (body: string) => parseSeverity(parseComment(body));
  test("emoji markers map to high / medium / low and are stripped", () => {
    expect(sev("🔴 **Null deref**")).toEqual({ severity: "high", title: "Null deref" });
    expect(sev("🟡 **Race**")).toEqual({ severity: "medium", title: "Race" });
    expect(sev("🔍 **Check this**")).toEqual({ severity: "low", title: "Check this" });
    expect(sev("🟨 **Square**")).toEqual({ severity: "medium", title: "Square" });
  });
  test("severity text is stripped from the title", () => {
    const s = sev("### Leaks a handle\n\n**High Severity**\n\nbody");
    expect(s).toEqual({ severity: "high", title: "Leaks a handle" });
    expect(parseSeverity({ title: "Off by one (Low Severity)", badge: null })).toEqual({ severity: "low", title: "Off by one" });
    expect(parseSeverity({ title: "Thing · Medium Severity", badge: null })).toEqual({ severity: "medium", title: "Thing" });
  });
  test("badges and plain titles", () => {
    expect(parseSeverity({ title: "Fix it", badge: "P1" })).toEqual({ severity: "high", title: "Fix it" });
    expect(parseSeverity({ title: "Just a note", badge: null })).toEqual({ severity: null, title: "Just a note" });
  });
});

describe("activityMeta", () => {
  test("counts", () => {
    expect(activityMeta({ comments: 3, openThreads: 1, lowSignal: 2 })).toBe("3 comments · 1 open thread · 2 low-signal");
    expect(activityMeta({ comments: 1, openThreads: 0, lowSignal: 1, lowHidden: true, botsHidden: 2 })).toBe("1 comment · 0 open threads · 1 low-signal hidden · 2 bot hidden");
  });
});

const x = { w: 100, prAuthor: "alice", age: () => "4h" };
const text = (r: RL) => (r.t === "head" ? r.left.map((s) => s.text).join("") : r.t === "text" ? r.spans.map((s) => s.text).join("") : "");

describe("rows", () => {
  const resolved = thread("r", 3, "🔴 **Bad thing**", { isResolved: true, resolvedBy: "alice" });
  const openFirst = thread("o", 4, "🟡 **Maybe**").comments[0]!;
  const open = thread("o", 4, "x", { comments: [openFirst, { author: "alice", isBot: false, body: "reply text", createdAt: iso(6), url: "u", mine: true }] });
  const rev = review("rv", 1, ["r", "o"]);
  const items = groupActivity([rev, entry("c", 9)], [resolved, open]);

  const layout = (levels: Record<string, Level>) => activityLayout(items, { ...x, levelOf: (it) => levels[activityId(it)] ?? defaultLevel(it), replyId: null });

  test("collapsed thread is one line: status, severity dot, title, file:line; resolved has no trail", () => {
    const b = layout({}).find((q) => q.id === "t:r")!;
    expect(b.rows).toHaveLength(1);
    const head = b.rows[0]!;
    expect(head.t === "head" && head.right).toBe("src/a.ts:7");
    expect(text(head)).toBe("│ ✓ ● Bad thing");
    if (head.t === "head") expect(head.left.map((s) => s.style)).toContain("del");
  });

  test("expanded thread: headers `author · age`, replies separated by one blank, trail last", () => {
    const rows = layout({ "t:o": 1 }).find((q) => q.id === "t:o")!.rows;
    const lines = rows.map((r) => (r.t === "gap" ? "<gap>" : text(r)));
    expect(lines.some((l) => l.trim() === "devin bot · 4h")).toBe(true);
    expect(lines.some((l) => l.trim() === "alice · 4h")).toBe(true);
    expect(lines.filter((l) => l === "<gap>")).toHaveLength(2); // between replies, before the trail
    expect(lines.at(-1)).toContain("devin flagged");
  });

  test("expanded thread does not repeat the title as the first body line", () => {
    const th = thread("d", 2, "🔴 **Same title**\n\nThe actual explanation.");
    const lines = activityLayout([{ kind: "thread", th }], { ...x, levelOf: () => 1, replyId: null })[0]!.rows.map(text);
    expect(lines.filter((l) => l.includes("Same title"))).toHaveLength(1);
    expect(lines.some((l) => l.includes("The actual explanation."))).toBe(true);
  });

  test("spacing: toggling an entry changes only its own rows and never adds blank rows between entries", () => {
    const toggled = ["t:o", "v:c", "t:r"];
    const before = layout({});
    const after = layout({ "t:o": 1, "v:c": 1, "t:r": 2 });
    expect(after.map((b) => b.id)).toEqual(before.map((b) => b.id));
    for (const b of [...before, ...after]) {
      expect(b.rows.length).toBeGreaterThan(0);
      expect(b.rows[0]!.t).not.toBe("gap");
      expect(b.rows.at(-1)!.t).not.toBe("gap");
    }
    for (const b of before.filter((q) => !toggled.includes(q.id))) expect(after.find((q) => q.id === b.id)!.rows).toEqual(b.rows);
  });

  test("findings nested under a human review carry that person's rail; the review stays one line collapsed", () => {
    const b = layout({ "v:rv": 0, "t:r": 1 });
    expect(b[0]!.id).toBe("v:rv");
    expect(b[0]!.rows).toHaveLength(1);
    expect(b[1]!.item.kind === "thread" && b[1]!.item.nested).toBe(true);
    expect(b[1]!.who).toBe("alice");
    expect(text(b[1]!.rows[0]!).startsWith("│ ")).toBe(true);
    expect(b[1]!.rows.slice(1).every((r) => (r.t === "text" || r.t === "gap" ? r.rail : true))).toBe(true);
  });

  test("a bot review's findings and an expanded bot comment carry a faint rail (no person's colour)", () => {
    const botRev = entry("brv", 1, { kind: "review", isBot: true, author: "cursor[bot]", body: "Looks fine overall.", findings: { total: 1, open: 0, resolved: 1, outdated: 0, threadIds: ["r"] } });
    const b = activityLayout(groupActivity([botRev], [resolved]), { ...x, levelOf: () => 1, replyId: null });
    expect(b[0]!.who).toBeNull();
    expect(b[0]!.rows.slice(1).every((r) => (r.t === "text" || r.t === "gap" ? r.rail : true))).toBe(true);
    expect(b[1]!.who).toBeNull();
    expect(text(b[1]!.rows[0]!).startsWith("│ ")).toBe(true);
    expect(b[1]!.rows.slice(1).every((r) => (r.t === "text" || r.t === "gap" ? r.rail : true))).toBe(true);
  });

  test("inside an open bot fold, a bot review's body rail sits under its head, in line with its findings' rail", () => {
    const botRev = entry("brv", 1, { kind: "review", isBot: true, author: "devin-ai-integration[bot]", body: "Devin found 1 issue.", findings: { total: 1, open: 0, resolved: 1, outdated: 0, threadIds: ["r"] } });
    const other = entry("bc", 2, { isBot: true, author: "cursor[bot]", body: "note" });
    const rows = foldBots(groupActivity([botRev, other], [resolved]));
    const b = activityLayout(rows, { ...x, levelOf: (it) => (activityId(it) === "v:brv" ? 1 : 0), isOpen: () => true, replyId: null });
    const review = b.find((q) => q.id === "v:brv")!;
    const finding = b.find((q) => q.id === "t:r")!;
    // the member head is indented 2 by the fold; its body rail is padded by the same 2, and so is the finding's rail
    expect(text(review.rows[0]!).startsWith("  ▾")).toBe(true);
    expect(review.rows.slice(1).every((r) => (r.t === "text" || r.t === "gap" ? r.rail && r.indent === 2 : true))).toBe(true);
    expect(text(finding.rows[0]!).startsWith("  │ ")).toBe(true);
  });
});

describe("foldBots", () => {
  const bot = (id: string, min: number, extra: Partial<ConversationEntry> = {}) => entry(id, min, { isBot: true, author: "cursor[bot]", ...extra });
  const shape = (rows: ActivityRow[]) => rows.map((r) => (r.kind === "bots" ? `[${r.members.map(activityId).join(" ")}]` : activityId(r)));

  test("runs of 2+ quiet bot units fold; a lone bot entry and humans stay", () => {
    const items = groupActivity([bot("a", 1), bot("b", 2), entry("h", 3), bot("c", 4), entry("h2", 5)], []);
    expect(shape(foldBots(items))).toEqual(["[v:a v:b]", "v:h", "v:c", "v:h2"]);
  });

  test("a bot review folds with its resolved findings but an open finding keeps it out, breaking the run", () => {
    const quiet = bot("q", 1, { kind: "review", findings: { total: 1, open: 0, resolved: 1, outdated: 0, threadIds: ["r1"] } });
    const loud = bot("l", 3, { kind: "review", findings: { total: 1, open: 1, resolved: 0, outdated: 0, threadIds: ["o1"] } });
    const items = groupActivity([quiet, bot("x", 2), loud, bot("y", 4)], [thread("r1", 1, "**A**", { isResolved: true }), thread("o1", 3)]);
    expect(shape(foldBots(items))).toEqual(["[v:q t:r1 v:x]", "v:l", "t:o1", "v:y"]);
  });

  test("standalone threads fold only when resolved and bot-only", () => {
    const items = groupActivity([bot("a", 1)], [thread("r", 2, "**A**", { isResolved: true }), thread("o", 3)]);
    expect(shape(foldBots(items))).toEqual(["[v:a t:r]", "t:o"]);
  });

  test("the fold row names who and how many, with no rows between entries", () => {
    const items = groupActivity([bot("a", 1), bot("b", 2, { author: "chatgpt-codex-connector[bot]" }), bot("c", 3)], []);
    const [closed] = activityLayout(foldBots(items), { ...x, levelOf: () => 0, replyId: null });
    expect(text(closed!.rows[0]!)).toBe("▸ 3 bot comments  bugbot ×2 · codex  4h");
    const open = activityLayout(foldBots(items), { ...x, levelOf: () => 0, isOpen: () => true, replyId: null });
    expect(open.map((q) => q.id)).toEqual(["b:v:a", "v:a", "v:b", "v:c"]);
    expect(open.every((q) => q.rows[0]!.t !== "gap")).toBe(true);
    // Members sit one step in from the fold row and still fit the row width.
    for (const q of open.slice(1)) {
      expect(text(q.rows[0]!).startsWith("  ▸ ")).toBe(true);
      expect(text(q.rows[0]!).length).toBeLessThanOrEqual(x.w);
    }
  });
});
