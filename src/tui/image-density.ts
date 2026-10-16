/**
 * Image density: what the terminal says one cell is in pixels, and the denser size images are sent at (see `SUPERSAMPLE`).
 *
 * OpenTUI scales an image to `cols x terminalPixelWidth / terminalCols` pixels before transmitting it, from the reply to `CSI 14t`. Where that
 * reply counts logical pixels (Tern on a Retina screen: 8x16 per cell where the screen has 16x32) the terminal receives a bitmap with a
 * quarter of the pixels it will show and blows it up: blurry. `installImageDensity` tells OpenTUI's native layer the pixel size is
 * `SUPERSAMPLE`x the reported one, so it transmits that many pixels; the layout keeps using the reported size, which `imageCell` returns.
 */
import { resolveRenderLib } from "@opentui/core";
import { useSyncExternalStore } from "react";
import { SUPERSAMPLE, targetPixels, type Cell } from "./image-fit";

/** Cell size used until the terminal has answered, or when it never does. */
const FALLBACK: Cell = { w: 8, h: 16 };

let reported: Cell | null = null;
let version = 0;
const listeners = new Set<() => void>();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

/** Terminal cell size in pixels, as reported (not supersampled); a guess until the terminal answers. */
export const imageCell = (): Cell => reported ?? FALLBACK;

/** Pixels an image `cols`x`rows` cells large is sent at; null until the terminal has reported its pixel size (nothing to match yet). */
export const imageTarget = (cols: number, rows: number): { w: number; h: number } | null => (reported ? targetPixels(cols, rows, reported) : null);

/** The terminal's cell size, re-rendering the caller when the terminal (re)reports it. */
export function useImageCell(): Cell {
  useSyncExternalStore(subscribe, () => version);
  return imageCell();
}

/** Makes OpenTUI send `SUPERSAMPLE`x the pixels the terminal reports per cell, and tracks the reported size. Call once, before the first render. */
export function installImageDensity(): void {
  const lib = resolveRenderLib();
  const set = lib.sessionSetImageResolution.bind(lib);
  lib.sessionSetImageResolution = (context, session, cols, rows, pixelWidth, pixelHeight) => {
    reported = cols > 0 && rows > 0 && pixelWidth > 0 && pixelHeight > 0 ? { w: pixelWidth / cols, h: pixelHeight / rows } : null;
    set(context, session, cols, rows, pixelWidth * SUPERSAMPLE, pixelHeight * SUPERSAMPLE);
    version++;
    for (const l of listeners) l();
  };
}
