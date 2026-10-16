import { describe, expect, test } from "bun:test";
import { svgZoomTo, MAX_PIXELS, MAX_SIDE } from "../src/svg-bounds";
import { fitInto, SUPERSAMPLE, targetPixels } from "../src/tui/image-fit";

describe("targetPixels", () => {
  test("is the cell box in pixels, supersampled: what OpenTUI sends for it", () => {
    // Tern on a Retina screen reports 8x16 per cell; the screen shows 16x32
    expect(targetPixels(100, 19, { w: 8, h: 16 })).toEqual({ w: 100 * 8 * SUPERSAMPLE, h: 19 * 16 * SUPERSAMPLE });
    expect(targetPixels(100, 19, { w: 8, h: 16 })).toEqual({ w: 1600, h: 608 });
  });
  test("fractional cells round, and never reach zero", () => {
    expect(targetPixels(3, 1, { w: 8.4, h: 16.7 }, 1)).toEqual({ w: 25, h: 17 });
    expect(targetPixels(1, 1, { w: 0.1, h: 0.1 }, 1)).toEqual({ w: 1, h: 1 });
  });
});

describe("fitInto", () => {
  const cell = { w: 10, h: 20 };
  test("width-limited: fills the width, enlarging past the image's own size", () => {
    expect(fitInto(1000, 380, 200, 60, cell)).toEqual({ cols: 200, rows: 38 });
    expect(fitInto(100, 38, 200, 60, cell)).toEqual({ cols: 200, rows: 38 });
  });
  test("height-limited: fills the height and narrows to keep the shape", () => {
    expect(fitInto(400, 1600, 200, 40, cell)).toEqual({ cols: 20, rows: 40 });
  });
  test("a one-cell area still yields one cell", () => {
    expect(fitInto(500, 100, 1, 1, cell)).toEqual({ cols: 1, rows: 1 });
  });
});

describe("svgZoomTo", () => {
  test("renders exactly the target width when within bounds", () => {
    expect(svgZoomTo(1000, 380, 1600)).toBeCloseTo(1.6);
    expect(svgZoomTo(1000, 380, 500)).toBeCloseTo(0.5);
  });
  test("is clamped to the side and pixel bounds", () => {
    const zoom = svgZoomTo(1000, 380, 10_000)!;
    expect(1000 * zoom).toBeLessThanOrEqual(MAX_SIDE);
    const tall = svgZoomTo(1000, 3000, 10_000)!;
    expect(3000 * tall).toBeLessThanOrEqual(MAX_SIDE);
    expect(1000 * tall * 3000 * tall).toBeLessThanOrEqual(MAX_PIXELS * 1.001);
  });
  test("nonsense sizes are unrenderable", () => {
    expect(svgZoomTo(0, 10, 100)).toBeNull();
    expect(svgZoomTo(100, 10, 0)).toBeNull();
    expect(svgZoomTo(100_000, 1, 1600)).toBeNull();
    expect(svgZoomTo(Number.NaN, 10, 100)).toBeNull();
  });
});
