/** Raster size limits for SVGs, from their intrinsic size (pure: the worker applies them before `render()`). */
export const MAX_SIDE = 2400;
export const MIN_WIDTH = 1200;
export const MAX_PIXELS = 4_000_000;
/** Below this many pixels on a side the aspect ratio is absurd (a hairline), not a diagram. */
const MIN_SIDE = 4;

/** Zoom that renders a `width`x`height` SVG 1.2k-2.4k px wide without exceeding `MAX_SIDE` per side or `MAX_PIXELS` in total; null when unrenderable. */
export function svgZoom(width: number, height: number): number | null {
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const zoom = Math.min(Math.min(MAX_SIDE, Math.max(MIN_WIDTH, width * 2)) / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.round(width * zoom) < MIN_SIDE || Math.round(height * zoom) < MIN_SIDE ? null : zoom;
}

/** Zoom that renders a `width`x`height` SVG `targetWidth` px wide (so a terminal draws it 1:1), clamped to `MAX_SIDE` per side and `MAX_PIXELS` in total; null when unrenderable. */
export function svgZoomTo(width: number, height: number, targetWidth: number): number | null {
  if (!(width > 0 && height > 0 && targetWidth > 0) || !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(targetWidth)) return null;
  const zoom = Math.min(targetWidth / width, MAX_SIDE / width, MAX_SIDE / height, Math.sqrt(MAX_PIXELS / (width * height)));
  return Math.round(width * zoom) < MIN_SIDE || Math.round(height * zoom) < MIN_SIDE ? null : zoom;
}
