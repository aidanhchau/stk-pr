import { describe, expect, test } from "bun:test";
import { bodyRows, rowsHeight } from "../src/tui/activity";
import { fitImage, layoutBlocks, layoutRows, parseComment, plain, preview, type ImageEnv } from "../src/tui/markdown";

const SVG = "https://github.com/o/r/blob/abc1234/change.svg?raw=true";
const images = (c: string) => parseComment(c).blocks.filter((b) => b.t === "image");
const text = (c: string) => layoutBlocks(parseComment(c).blocks, 80, { details: true }).map(plain);

describe("standalone images vs chrome", () => {
  test("markdown and HTML images alone on a line become image blocks", () => {
    expect(images(`![change](${SVG})`)).toEqual([{ t: "image", src: SVG, alt: "change" }]);
    expect(images(`<img src="https://x.test/a.png" alt="shot" width="700">`)).toEqual([{ t: "image", src: "https://x.test/a.png", alt: "shot" }]);
    expect(images(`<p align="center"><a href="https://x.test"><picture><source srcset="d.png"><img alt="logo" src="https://x.test/logo.png"></picture></a></p>`)).toEqual([
      { t: "image", src: "https://x.test/logo.png", alt: "logo" },
    ]);
    expect(images(`[![shot](https://x.test/a.png)](https://x.test/full)`)).toHaveLength(1);
    expect(images(`text\n\n![a](https://x.test/1.png) ![b](https://x.test/2.png)\n\nmore`)).toHaveLength(2);
  });

  test("an image in prose, a heading or a table is dropped, the text stays", () => {
    expect(images("see ![x](https://x.test/a.png) here")).toHaveLength(0);
    expect(text("see ![x](https://x.test/a.png) here")).toEqual(["see here"]);
    expect(images("# ![x](https://x.test/a.png) Title")).toHaveLength(0);
    expect(text("| a | ![x](https://x.test/a.png) |\n|---|---|\n| 1 | 2 |").join("\n")).not.toMatch(/\uE020|\uE021/);
  });

  test("badges, bot buttons and pills are still stripped; pills still render", () => {
    expect(images("![build](https://img.shields.io/badge/build-passing-green)")).toHaveLength(0);
    expect(images(`<a href="https://cursor.com/open"><picture><img alt="Fix in Cursor" src="https://cursor.com/assets/images/fix-in-cursor-dark.png"></picture></a>`)).toHaveLength(0);
    expect(images(`<a href="https://app.devin.ai/r"><img src="https://static.devin.ai/assets/gh-devin-review-light.svg?v=4" alt="Devin Review"></a>`)).toHaveLength(0);
    expect(images(`<img height="20" src="https://x.test/tiny.png">`)).toHaveLength(0);
    expect(images("![x](./relative.png)")).toHaveLength(0);
    expect(parseComment("**![P1 Badge](https://img.shields.io/badge/P1-orange)  Title**").badge).toBe("P1");
  });

  test("a preview never shows an image; an image-only comment previews its alt", () => {
    expect(preview(parseComment(`![diagram](${SVG})\n\nBody`))).toBe("Body");
    expect(preview(parseComment(`![diagram](${SVG})`))).toBe("▣ diagram");
  });

  test("without an image environment it is one muted alt line (search text, collapsed rows)", () => {
    expect(text(`intro\n\n![change](${SVG})\n\noutro`)).toEqual(["intro", "", "▣ change", "", "outro"]);
  });
});

describe("fitImage", () => {
  const cell = { w: 10, h: 20 };
  test("width-limited: fills the width, height follows the aspect ratio and the cell shape", () => {
    expect(fitImage(1000, 380, 90, cell)).toEqual({ cols: 90, rows: 17 });
  });
  test("never upscales past the image's own size", () => {
    expect(fitImage(332, 244, 90, cell)).toEqual({ cols: 33, rows: 12 });
  });
  test("tall images are capped in rows and narrowed to keep their shape", () => {
    expect(fitImage(400, 1600, 90, cell)).toEqual({ cols: 15, rows: 30 });
    expect(fitImage(400, 1600, 90, cell, 10)).toEqual({ cols: 5, rows: 10 });
  });
  test("caps at 100 columns and never returns less than one cell", () => {
    expect(fitImage(4000, 400, 300, cell).cols).toBe(100);
    expect(fitImage(5, 5, 90, cell)).toEqual({ cols: 1, rows: 1 });
  });
});

describe("image rows", () => {
  const requested: string[] = [];
  const env = (status: "ready" | "loading" | "error"): ImageEnv => ({
    cell: { w: 10, h: 20 },
    request: (src) => void requested.push(src),
    lookup: () => (status === "ready" ? { status, width: 1000, height: 380 } : status === "error" ? { status, reason: "404" } : { status }),
  });
  const rows = (e: ImageEnv, details = true, body = `intro\n\n![change](${SVG})\n\noutro`) => layoutRows(parseComment(body).blocks, 80, { details, images: e });

  test("a ready image is one row carrying its height, between blank lines", () => {
    const r = rows(env("ready"));
    expect(r.map((x) => (x.t === "image" ? `image ${x.items[0]!.cols}x${x.rows}` : plain(x.spans)))).toEqual(["intro", "", "image 80x15", "", "outro"]);
  });

  test("loading and failed images are one muted line that names the image to request", () => {
    expect(rows(env("loading"))[2]).toEqual({ t: "text", spans: [{ text: "▣ change · loading image", style: "muted" }], image: SVG });
    expect(rows(env("error"))[2]).toMatchObject({ t: "text", image: SVG });
    expect(layoutBlocks(parseComment(`![change](${SVG})`).blocks, 80, { details: true, images: env("error") }).map(plain)).toEqual(["▣ change · 404"]);
  });

  test("layout alone never requests anything", () => {
    requested.length = 0;
    rows(env("loading"));
    expect(requested).toEqual([]);
  });

  test("inside open <details> the image is indented; closed details hide it", () => {
    const body = `<details><summary>s</summary>\n\n![c](${SVG})\n\n</details>`;
    expect(rows(env("ready"), true, body).find((x) => x.t === "image")).toMatchObject({ indent: 2, items: [{ cols: 78 }] });
    expect(rows(env("ready"), false, body).map((x) => x.t === "text" && plain(x.spans))).toEqual(["▸ s"]);
  });

  test("bodyRows: an image is one line for the cap, rowsHeight counts its rows, and only shown images are requested", () => {
    const body = `![change](${SVG})\n\n${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n\n")}`;
    const out = bodyRows(body, 1, 80, 4, undefined, false, env("ready"));
    expect(out[0]).toMatchObject({ t: "image", rows: 15, items: [{ cols: 80, caption: null, x: 0 }], indent: 0 });
    const last = out.at(-1);
    expect(last?.t === "text" && plain(last.spans)).toMatch(/more lines$/);
    expect(rowsHeight(out)).toBe(out.length - 1 + 15);

    const hidden = `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n\n")}\n\n![late](https://x.test/late.png)\n\n![early](https://x.test/early.png)`;
    requested.length = 0;
    bodyRows(hidden, 1, 80, 4, undefined, false, env("loading"));
    expect(requested).toEqual([]);
    requested.length = 0;
    bodyRows(`![early](https://x.test/early.png)\n\nx`, 1, 80, 4, undefined, false, env("loading"));
    expect(requested).toEqual(["https://x.test/early.png"]);
  });
});

describe("images in tables", () => {
  const A = "https://x.test/a.png";
  const B = "https://x.test/b.png";
  const table = `| Collapsed | Expanded |\n|---|---|\n| ![card-collapsed](${A}) | ![card-expanded](${B}) |`;
  const env = (status: "ready" | "loading", requested: string[] = []): ImageEnv => ({
    cell: { w: 10, h: 20 },
    request: (src) => void requested.push(src),
    lookup: () => (status === "ready" ? { status, width: 800, height: 400 } : { status }),
  });
  const rows = (body: string, w: number, e?: ImageEnv) => layoutRows(parseComment(body).blocks, w, { details: true, images: e });
  const shape = (r: ReturnType<typeof rows>[number]) => (r.t === "text" ? plain(r.spans) : `image ${r.items.map((i) => `${i.cols}x${i.rows}@${i.x}`).join(" ")} h${r.rows}`);

  test("cell images are kept per cell, the header is the caption source, the separator row is not mistaken for an image row", () => {
    const [t] = parseComment(table).blocks;
    expect(t).toMatchObject({ t: "table", rows: [["Collapsed", "Expanded"], ["", ""]] });
    expect(t?.t === "table" && t.images).toEqual([[[], []], [[{ src: A, alt: "card-collapsed" }], [{ src: B, alt: "card-expanded" }]]]);
  });

  test("a text-only table is unchanged and carries no image grid", () => {
    const [t] = parseComment("| a | b |\n|---|---|\n| 1 | 2 |").blocks;
    expect(t).toEqual({ t: "table", rows: [["a", "b"], ["1", "2"]] });
  });

  test("badges in table cells are still stripped", () => {
    const [t] = parseComment(`| a | b |\n|---|---|\n| ![build](https://img.shields.io/badge/build-passing-green) | 2 |`).blocks;
    expect(t).toEqual({ t: "table", rows: [["a", "b"], ["", "2"]] });
  });

  test("an image-only row is not dropped as a separator", () => {
    expect(parseComment(`| ![a](${A}) | ![b](${B}) |\n|---|---|`).blocks[0]).toMatchObject({ t: "table", rows: [["", ""]] });
  });

  test("ready images with room go side by side under their header captions, in one row", () => {
    const r = rows(table, 100, env("ready"));
    expect(r.map(shape)).toEqual(["image 49x12@0 49x12@51 h13"]);
    const g = r[0]!;
    expect(g.t === "image" && g.items.map((i) => i.caption)).toEqual(["Collapsed", "Expanded"]);
  });

  test("each image needs 40 columns: 81 columns stack, 82 sit side by side", () => {
    expect(rows(table, 81, env("ready")).map(shape)).toEqual(["Collapsed", "image 80x20@0 h20", "", "Expanded", "image 80x20@0 h20"]);
    expect(rows(table, 82, env("ready")).map(shape)).toEqual(["image 40x10@0 40x10@42 h11"]);
  });

  test("three images need 3x40 columns and two gaps", () => {
    const three = `| a | b | c |\n|---|---|---|\n| ![1](${A}) | ![2](${B}) | ![3](https://x.test/c.png) |`;
    expect(rows(three, 123, env("ready")).map((x) => x.t)).toEqual(["text", "image", "text", "text", "image", "text", "text", "image"]);
    expect(rows(three, 124, env("ready")).map((x) => (x.t === "image" ? x.items.length : 0))).toEqual([3]);
  });

  test("images still loading stack as `▣ alt` lines under their captions, naming what to request", () => {
    const r = rows(table, 100, env("loading"));
    expect(r.map(shape)).toEqual(["Collapsed", "▣ card-collapsed · loading image", "", "Expanded", "▣ card-expanded · loading image"]);
    expect(r.filter((x) => x.t === "text" && x.image).map((x) => x.t === "text" && x.image)).toEqual([A, B]);
  });

  test("without an image environment it is text: captions and `▣ alt`", () => {
    expect(layoutBlocks(parseComment(table).blocks, 100, { details: true }).map(plain)).toEqual(["Collapsed", "▣ card-collapsed", "", "Expanded", "▣ card-expanded"]);
  });

  test("text cells keep their text, labelled by the header, above the row's images", () => {
    const mixed = `| Name | Shot |\n|---|---|\n| Alpha | ![a](${A}) |\n| Beta | ![b](${B}) |`;
    expect(rows(mixed, 100, env("ready")).map(shape)).toEqual(["Name: Alpha", "Shot", "image 80x20@0 h20", "", "Name: Beta", "Shot", "image 80x20@0 h20"]);
  });

  test("a single image cell with a caption is stacked like a standalone image", () => {
    expect(rows(`| Before |\n|---|\n| ![a](${A}) |`, 100, env("ready")).map(shape)).toEqual(["Before", "image 80x20@0 h20"]);
  });

  test("details indent side-by-side rows", () => {
    const r = rows(`<details><summary>s</summary>\n\n${table}\n\n</details>`, 100, env("ready"));
    expect(r.find((x) => x.t === "image" && x.items.length === 2)).toMatchObject({ indent: 2 });
  });

  test("bodyRows: height counts the group once; the cap hint names hidden images; only shown loading images are requested", () => {
    const out = bodyRows(`${table}\n\nx`, 1, 100, 6, undefined, false, env("ready"));
    expect(rowsHeight(out)).toBe(13 + 2);
    const body = `${Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n\n")}\n\n${table}`;
    const hint = (e: ImageEnv) => {
      const o = bodyRows(body, 1, 100, 4, undefined, false, e).at(-1);
      return o?.t === "text" ? plain(o.spans) : "";
    };
    expect(hint(env("ready"))).toMatch(/more lines, 2 images$/);
    const requested: string[] = [];
    expect(hint(env("loading", requested))).toMatch(/more lines, 2 images$/);
    expect(requested).toEqual([]);
  });

  test("escaped pipes stay inside their cell, and are unescaped in image src and alt", () => {
    const [t] = parseComment(`| a | b |\n|---|---|\n| ![x\\|y](https://x.test/p.png?a=1\\|2) | one \\| two |`).blocks;
    expect(t).toMatchObject({ t: "table", rows: [["a", "b"], ["", "one | two"]] });
    expect(t?.t === "table" && t.images?.[1]).toEqual([[{ src: "https://x.test/p.png?a=1|2", alt: "x|y" }], []]);
  });
});
