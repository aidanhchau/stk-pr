import { describe, expect, test } from "bun:test";
import { clipSpans, findingsSpan, findFixRef, isNoise, suggestionTarget, threadFix, threadTrail, layoutBlocks, parseComment, plain, preview, shortAuthor, shortPath, wrapSpans } from "../src/tui/markdown";

const fx = async () =>
  JSON.parse(await Bun.file(new URL("./fixtures/discussion-multi-bot.json", import.meta.url)).text()).data.repository.pullRequest as {
    reviewThreads: { nodes: { comments: { nodes: { body: string }[] } }[] };
    reviews: { nodes: { author: { login: string }; body: string }[] };
  };
const lines = (body: string, w = 80, details = true) => layoutBlocks(parseComment(body).blocks, w, { details }).map(plain);

const CODEX =
  "**<sub><sub>![P1 Badge](https://img.shields.io/badge/P1-orange?style=flat)</sub></sub>  Distinguish failed first payments before activating**\n\nAn `incomplete` subscription with a bank default ([Subscription status](https://docs.example.com/api/subscriptions/object)).\n\nUseful? React with 👍 / 👎.";
const DEVIN = '<!-- devin-review-comment {"id": "BUG_1", "file_path": "a.ts"} -->\n🔴 **Failed first payment activates subscription**\n\nBody text.\n\n<!-- devin-review-badge-begin -->\n<a href="https://app.devin.ai/review/x"><picture><source srcset="x.svg"><img src="y.svg" alt="Devin Review"></picture></a>\n<!-- devin-review-badge-end -->\n\n[Devin Review ↗](https://app.devin.ai/review/x)';
const BUGBOT = "### Failed bank debits stay active\n\n**High Severity**\n\n<!-- DESCRIPTION START -->\n`isPendingFirstPayment` treats every incomplete subscription as ACTIVE.\n<!-- DESCRIPTION END -->\n\n<!-- BUGBOT_BUG_ID: b69d -->\n\n<!-- LOCATIONS START\nbackend/a.ts#L47-L60\nLOCATIONS END -->\n<details>\n<summary>Additional Locations (1)</summary>\n\n- [`backend/b.ts#L500-L507`](https://github.com/o/r/blob/x/backend/b.ts#L500-L507)\n\n</details>\n\n<div><a href=\"https://cursor.com/open?link=abc\" target=\"_blank\"><picture><source media=\"(prefers-color-scheme: dark)\" srcset=\"d.png\"><img alt=\"Fix in Cursor\" width=\"115\" src=\"d.png\"></picture></a>&nbsp;<a href=\"https://cursor.com/agents?link=def\"><picture><img alt=\"Fix in Web\" src=\"w.png\"></picture></a></div>\n\n<sup>Reviewed by [Cursor Bugbot](https://cursor.com/bugbot) for commit 0e03162. Configure [here](https://www.cursor.com/dashboard/bugbot).</sup>";

describe("parseComment", () => {
  test("P1 badge image becomes a pill; title is bold text without markup", () => {
    const c = parseComment(CODEX);
    expect(c.badge).toBe("P1");
    expect(c.title).toBe("Distinguish failed first payments before activating");
    expect(preview(c)).toBe("P1 · Distinguish failed first payments before activating");
    const first = c.blocks[0]!;
    expect(first.t === "p" && first.spans.map((s) => s.style)).toEqual(["pill", "bold"]);
    expect(preview(c)).not.toMatch(/[*<>!\[\]]|https?:/);
  });

  test("footers ('Useful? React with') and link urls are stripped; link text stays", () => {
    const out = lines(CODEX).join("\n");
    expect(out).not.toMatch(/Useful\?|React with|https?:/);
    expect(out).toContain("(Subscription status).");
    expect(out).toContain("An incomplete subscription"); // inline code loses backticks
    expect(out).not.toContain("`");
  });

  test("devin: HTML comments (incl. multi-line) and badge/footer rows are stripped", () => {
    const c = parseComment(DEVIN);
    expect(preview(c)).toBe("🔴 Failed first payment activates subscription");
    const out = lines(DEVIN).join("\n");
    expect(out).not.toMatch(/devin-review|<!--|<a |Devin Review|↗/);
    expect(out).toContain("Body text.");
  });

  test("bugbot: heading + severity title, details fold, button rows and sup trailer removed", () => {
    const c = parseComment(BUGBOT);
    expect(preview(c)).toBe("Failed bank debits stay active · High Severity");
    const folded = lines(BUGBOT, 80, false).join("\n");
    expect(folded).toContain("▸ Additional Locations (1)");
    expect(folded).not.toContain("backend/b.ts");
    const open = lines(BUGBOT, 80, true).join("\n");
    expect(open).toContain("▾ Additional Locations (1)");
    expect(open).toContain("  • backend/b.ts#L500-L507");
    expect(open).not.toMatch(/Fix in|cursor\.com|Reviewed by|Configure|LOCATIONS|DESCRIPTION|BUGBOT|<|>/);
    expect(open).toContain("isPendingFirstPayment treats every incomplete subscription as ACTIVE.");
  });

  test("fenced code keeps indentation, headings bold, bullets hang", () => {
    const body = "## Heading\n\n- first bullet that is long enough to wrap around the narrow width here\n  - nested\n\n```ts\nfunction f() {\n    return <div>1</div>;\n}\n```";
    const c = parseComment(body);
    const out = layoutBlocks(c.blocks, 30, { details: true });
    const text = out.map(plain);
    expect(out[0]![0]!.style).toBe("bold");
    expect(text[1]).toBe("");
    expect(text[2]).toBe("• first bullet that is long");
    expect(text[3]).toMatch(/^  enough/); // hanging indent
    expect(text).toContain("  • nested");
    expect(text).toContain("      return <div>1</div>;"); // code indentation preserved (2 pad + 4)
    expect(text).toContain("  function f() {");
    expect(out.find((l) => plain(l).includes("return"))![0]!.style).toBe("code");
  });

  test("tables become aligned columns; wide tables fall back to wrapped rows", () => {
    const t = "| Area | Change |\n|------|--------|\n| **Checkout** | flag |\n| Reuse | recreate |";
    expect(lines(t)).toEqual(["Area      Change", "Checkout  flag", "Reuse     recreate"]);
    const wide = `| Area | Change |\n|---|---|\n| X | ${"word ".repeat(30)} |`;
    const out = lines(wide, 40);
    expect(out[0]).toMatch(/^X word/);
    expect(out.every((l) => l.length <= 40)).toBe(true);
  });

  test("GitHub alert markers are dropped; cursor risk comment title", () => {
    const c = parseComment("> [!NOTE]\n> **Newer findings are available below.** Devin posted more.");
    expect(c.title).toStartWith("Newer findings are available below.");
    expect(isNoise(c)).toBe(true);
    const risk = parseComment("<!-- CURSOR_AUTOMATION_ID: x -->\n## Risk assessment: **Very Low**\n**Evidence (diff only):** 1 file.\n<div><a href=\"https://cursor.com/a\"><picture><img alt=\"Open in Web\" src=\"x\"></picture></a></div>\n<sub>Sent by Cursor Automation: Assign PR reviewers</sub>");
    expect(risk.title).toBe("Risk assessment: Very Low");
    const out = layoutBlocks(risk.blocks, 80, { details: true }).map(plain);
    expect(out[0]).toBe("Risk assessment: Very Low");
    expect(out.join("\n")).not.toMatch(/Sent by|Open in/);
    expect(out).toContain("Evidence (diff only): 1 file.");
  });

  test("multi-bot fixture bodies: previews are clean titles, never raw markup", async () => {
    const pr = await fx();
    const previews = pr.reviewThreads.nodes.map((t) => preview(parseComment(t.comments.nodes[0]!.body)));
    expect(previews[0]).toBe("P1 · Distinguish failed first payments before activating");
    expect(previews[2]).toBe("Failed bank debits stay active · High Severity");
    for (const p of previews) expect(p).not.toMatch(/<|>|\*\*|!\[|https?:|Useful\?|devin-review|\.\.\./);
    const stale = pr.reviews.nodes.filter((r) => isNoise(parseComment(r.body)));
    expect(stale.length).toBeGreaterThan(0);
  });
});

describe("readable prose layout", () => {
  const para = "word ".repeat(60).trim();
  test("prose wraps at the 84-col measure in wide panes; code and tables keep full width", () => {
    const out = layoutBlocks(parseComment(para).blocks, 150, { details: true }).map(plain);
    expect(out.length).toBeGreaterThan(1);
    expect(Math.max(...out.map((l) => l.length))).toBeLessThanOrEqual(84);
    expect(Math.max(...out.map((l) => l.length))).toBeGreaterThan(70);
    const narrow = layoutBlocks(parseComment(para).blocks, 40, { details: true }).map(plain);
    expect(Math.max(...narrow.map((l) => l.length))).toBeLessThanOrEqual(40);
    const code = "```\n" + "x".repeat(120) + "\n```";
    expect(layoutBlocks(parseComment(code).blocks, 150, { details: true }).map(plain)).toEqual(["  " + "x".repeat(120)]);
    expect(layoutBlocks(parseComment(para).blocks, 150, { details: true, measure: Infinity }).length).toBe(2);
  });

  test("inline code is its own span (ink on wash in the view); links stay link-styled", () => {
    const out = layoutBlocks(parseComment("Use `foo()` and [docs](https://x.y/z) now").blocks, 80, { details: true });
    expect(out[0]!.filter((s) => s.style !== "plain").map((s) => [s.text, s.style])).toEqual([["foo()", "code"], ["docs", "link"]]);
    expect(plain(out[0]!)).toBe("Use foo() and docs now");
  });

  test("headings: h1/h2 bold, h3+ subhead; blank before and after h1/h2; lists get blank lines around them; bullets muted", () => {
    const body = "intro\n# Big\ntext one\n### Small\ntext two\n- a\n  - b\nafter";
    const out = layoutBlocks(parseComment(body).blocks, 80, { details: true });
    expect(out.map(plain)).toEqual(["intro", "", "Big", "", "text one", "", "Small", "text two", "", "• a", "  • b", "", "after"]);
    expect(out[2]![0]!.style).toBe("bold");
    expect(out[6]![0]!.style).toBe("subhead");
    expect(out[9]![0]).toEqual({ text: "• ", style: "muted" });
    expect(out[10]![0]).toEqual({ text: "  ", style: "plain" });
  });
});

describe("layout helpers", () => {
  test("wrapSpans never exceeds width and keeps styles", () => {
    const spans = [{ text: "alpha ", style: "plain" as const }, { text: "beta gamma", style: "bold" as const }, { text: " delta", style: "plain" as const }];
    const out = wrapSpans(spans, 11);
    expect(out.map(plain)).toEqual(["alpha beta", "gamma delta"]);
    expect(out[0]!.find((x) => x.text === "beta")!.style).toBe("bold");
  });

  test("clipSpans ends with an ellipsis, not a splice", () => {
    const out = clipSpans([{ text: "hello world and more", style: "plain" }], 10);
    expect(plain(out)).toBe("hello wor…");
  });

  test("shortAuthor / shortPath", () => {
    expect(shortAuthor("chatgpt-codex-connector")).toBe("codex");
    expect(shortAuthor("devin-ai-integration")).toBe("devin");
    expect(shortAuthor("cursor")).toBe("bugbot");
    expect(shortAuthor("cursor[bot]")).toBe("bugbot");
    expect(shortAuthor("octo-dev")).toBe("octo-dev");
    expect(shortPath("backend/module-pricing/src/status-read/subscription-decoding.ts:68", 44)).toBe("…/status-read/subscription-decoding.ts:68");
    expect(shortPath("a/b.ts", 44)).toBe("a/b.ts");
  });
});

describe("suggestions", () => {
  const body = "Use a const.\n\n```suggestion\nconst a = 1;\nconst b = 2;\n```\n\nThanks";
  test("```suggestion fence becomes a suggestion block, other fences stay code", () => {
    const bl = parseComment(`${body}\n\n\`\`\`ts\nx\n\`\`\``).blocks;
    expect(bl.find((b) => b.t === "suggestion")).toEqual({ t: "suggestion", lines: ["const a = 1;", "const b = 2;"] });
    expect(bl.some((b) => b.t === "code")).toBe(true);
  });
  test("empty suggestion deletes lines; four-backtick fence works", () => {
    expect(parseComment("```suggestion\n```").blocks).toEqual([{ t: "suggestion", lines: [] }]);
    expect(parseComment("````suggestion\nx\n````").blocks).toEqual([{ t: "suggestion", lines: ["x"] }]);
  });
  test("layout renders removed lines red-prefixed and added lines", () => {
    const hunk = "@@ -1,3 +1,3 @@\n ctx\n-old gone\n+let a = 0;\n+let b = 0;";
    const removed = suggestionTarget(hunk, 2);
    expect(removed).toEqual(["let a = 0;", "let b = 0;"]);
    const out = layoutBlocks(parseComment(body).blocks, 80, { details: true, removed }).map(plain);
    expect(out).toEqual(["Use a const.", "", "suggested change", "- let a = 0;", "- let b = 0;", "+ const a = 1;", "+ const b = 2;", "", "Thanks"]);
    expect(layoutBlocks(parseComment(body).blocks, 80, { details: true }).map(plain)).not.toContain("- let a = 0;");
    expect(suggestionTarget(null, 2)).toEqual([]);
  });
});

describe("fix refs and trail", () => {
  test("findFixRef", () => {
    expect(findFixRef("Fixed in abc1234")).toBe("abc1234");
    expect(findFixRef("Addressed in `ABCDEF1`.")).toBe("abcdef1");
    expect(findFixRef("Fixed in commit [3f2a9c1](https://github.com/o/r/commit/3f2a9c1d)")).toBe("3f2a9c1");
    expect(findFixRef("see https://github.com/o/r/commit/0123456789abcdef0123456789abcdef01234567")).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(findFixRef("Fixed in defaced")).toBeNull();
    expect(findFixRef("nothing here abc1234")).toBeNull();
  });
  const th = (o: object) => ({ isResolved: true, isOutdated: false, resolvedBy: "octo-dev", ...o, comments: [
    { author: "devin-ai-integration", mine: false, body: "Bug. Fixed in abc1234 (in the review body)" },
    { author: "octo-dev", mine: true, body: "Fixed in 1234abc" },
  ] });
  test("threadFix ignores the opening comment; trail summarises", () => {
    expect(threadFix(th({}))).toBe("1234abc");
    expect(threadTrail(th({}), "octo-dev")).toBe("devin flagged · you replied · resolved by octo-dev");
    expect(threadTrail({ ...th({}), isResolved: false, isOutdated: true, comments: [{ author: "cursor[bot]", mine: false, body: "" }] }, "x")).toBe("bugbot flagged · open · outdated");
  });
});

describe("diff blocks, autofix previews, findings status", () => {
  const DIFF = "```diff\n@@ -1,2 +1,2 @@\n ctx\n-old\n+new\n```";
  const styled = (body: string, opts = { details: true }) => layoutBlocks(parseComment(body).blocks, 60, opts).filter((l) => l.length).map((l) => `${l[0]!.style}:${plain(l).trim()}`);

  test("fenced diff colours + green, - red, @@ muted; plain code is untouched", () => {
    expect(styled(DIFF)).toEqual(["muted:@@ -1,2 +1,2 @@", "code:ctx", "del:-old", "add:+new"]);
    expect(styled("```\na\n- b\n```")).toEqual(["code:a", "code:- b"]);
  });

  test("an unfenced-language block that looks like a unified diff is coloured too", () => {
    expect(styled("```\ndiff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n```")).toEqual(["muted:diff --git a/x b/x", "muted:--- a/x", "muted:+++ b/x", "muted:@@ -1 +1 @@", "del:-a", "add:+b"]);
  });

  test("Preview details holding a diff stay collapsed even with details open, unless previews is set", () => {
    const body = `<details>\n<summary>Preview (abc123)</summary>\n\n${DIFF}\n\n</details>\n\n<details>\n<summary>Other</summary>\n\ntext\n</details>`;
    expect(styled(body)).toEqual(["muted:▸ Preview (abc123)", "muted:▾ Other", "plain:text"]);
    const open = layoutBlocks(parseComment(body).blocks, 60, { details: true, previews: true }).flat();
    expect(open.find((x) => x.text.trim() === "+new")?.style).toBe("add");
  });

  test("✅ Fixed items get a green check and muted text", () => {
    const l = layoutBlocks(parseComment("- ✅ Fixed: **Thing** was broken").blocks, 60, { details: true })[0]!;
    expect(plain(l)).toBe("• ✓ Fixed: Thing was broken");
    expect(l.find((s) => s.text.includes("✓"))!.style).toBe("add");
    expect(l.filter((s) => s.style === "plain" && s.text.trim())).toEqual([]);
    expect(l.find((s) => s.text.includes("Fixed"))!.style).toBe("muted");
  });

  test("findingsSpan: resolved green, open red, outdated muted", () => {
    const f = (open: number, resolved: number, outdated: number) => findingsSpan({ total: open + resolved + outdated, open, resolved, outdated });
    expect(f(0, 1, 0)).toEqual({ text: "1 finding · resolved", style: "add" });
    expect(f(1, 1, 0)).toEqual({ text: "2 findings · 1 open", style: "del" });
    expect(f(0, 0, 2)).toEqual({ text: "outdated", style: "muted" });
    expect(f(0, 0, 0)).toBeNull();
  });
});
