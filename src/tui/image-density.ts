/**
 * Image density: what the terminal says one cell is in pixels, and the denser size images are sent at (see `SUPERSAMPLE`).
 *
 * OpenTUI scales an image to `cols x terminalPixelWidth / terminalCols` pixels before transmitting it, from the reply to `CSI 14t`. Where that
 * reply counts logical pixels (Tern on a Retina screen: 8x16 per cell where the screen has 16x32) the terminal receives a bitmap with a
 * quarter of the pixels it will show and blows it up: blurry. `installImageDensity` tells OpenTUI's native layer the pixel size is
 * `SUPERSAMPLE`x the reported one, so it transmits that many pixels; the layout keeps using the reported size, which `imageCell` returns.
 *
 * Only the kitty protocol does this: it scales a bitmap into its cell box. Sixel and half-blocks draw 1:1 at the size OpenTUI resized to, so
 * a boosted resolution would make them overflow the cells reserved for the image; they keep the real geometry (`scale() === 1`).
 */
import { CliRenderEvents, resolveRenderLib, type CliRenderer, type RenderLib } from "@opentui/core";
import { useSyncExternalStore } from "react";
import { SUPERSAMPLE, targetPixels, type Cell } from "./image-fit";

/** Cell size used until the terminal has answered, or when it never does. */
const FALLBACK: Cell = { w: 8, h: 16 };

type SetResolution = Parameters<RenderLib["sessionSetImageResolution"]>;

let reported: Cell | null = null;
/** The last resolution OpenTUI was told, as reported by the terminal (unboosted), to re-send when the boost changes. */
let last: SetResolution | null = null;
let applied = 1;
let kitty = false;
let version = 0;
const listeners = new Set<() => void>();
let set: ((...a: SetResolution) => void) | null = null;

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
const notify = () => {
  version++;
  for (const l of listeners) l();
};

/** Pixels sent per reported pixel: `SUPERSAMPLE` where the terminal scales bitmaps into cells (kitty), else 1. */
export const imageScale = (): number => (kitty ? SUPERSAMPLE : 1);

/** Terminal cell size in pixels, as reported (not supersampled); a guess until the terminal answers. */
export const imageCell = (): Cell => reported ?? FALLBACK;

/** Pixels an image `cols`x`rows` cells large is sent at; null until the terminal has reported its pixel size (nothing to match yet). */
export const imageTarget = (cols: number, rows: number): { w: number; h: number } | null => (reported ? targetPixels(cols, rows, reported, imageScale()) : null);

/** The terminal's cell size, re-rendering the caller when the terminal (re)reports it. */
export function useImageCell(): Cell {
  useSyncExternalStore(subscribe, () => version);
  return imageCell();
}

function apply(): void {
  if (!set || !last) return;
  const [context, session, cols, rows, pw, ph] = last;
  applied = imageScale();
  set(context, session, cols, rows, pw * applied, ph * applied);
}

/** Intercepts the resolution OpenTUI hands its native layer, to boost it (kitty) and to track the reported size. Call before the renderer is created. */
export function installImageDensity(): void {
  const lib = resolveRenderLib();
  set = lib.sessionSetImageResolution.bind(lib);
  lib.sessionSetImageResolution = (context, session, cols, rows, pixelWidth, pixelHeight) => {
    reported = cols > 0 && rows > 0 && pixelWidth > 0 && pixelHeight > 0 ? { w: pixelWidth / cols, h: pixelHeight / rows } : null;
    last = [context, session, cols, rows, pixelWidth, pixelHeight];
    apply();
    notify();
  };
}

/** Follows the terminal's capabilities: the boost applies once (and only if) it speaks kitty graphics, which can arrive after the pixel size. */
export function watchImageCapabilities(renderer: CliRenderer): void {
  const sync = () => {
    const now = renderer.capabilities?.kitty_graphics === true;
    if (now === kitty) return;
    kitty = now;
    if (imageScale() !== applied) apply();
    notify();
  };
  renderer.on(CliRenderEvents.CAPABILITIES, sync);
  sync();
}
