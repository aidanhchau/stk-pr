/** Pure geometry for drawn images: the pixels a cell box covers on screen, and the cells a modal gives an image. */

export interface Cell {
  w: number;
  h: number;
}

/**
 * How many times denser than the terminal's reported pixel size images are sent. Terminals disagree on what `CSI 14t` counts: kitty and
 * Ghostty report device pixels, Tern reports logical ones (a Retina screen then holds 2x what is reported). Sending `SUPERSAMPLE`x the
 * reported size is never blurry (the terminal scales the picture into its cell box, downwards where it has fewer pixels) and costs only
 * transfer size; sending exactly the reported size is blurry wherever the report is logical.
 */
export const SUPERSAMPLE = 2;

/** Pixels an image `cols`x`rows` cells large is sent at: what OpenTUI transmits for it, so an image prepared at this size is not resampled again. */
export function targetPixels(cols: number, rows: number, cell: Cell, scale = SUPERSAMPLE): { w: number; h: number } {
  return { w: Math.max(1, Math.round(cols * cell.w * scale)), h: Math.max(1, Math.round(rows * cell.h * scale)) };
}

/** Cells an image of `width`x`height` px takes in a `maxCols`x`maxRows` area, as large as fits and in proportion (enlarged past its own size: that is the point of the modal). */
export function fitInto(width: number, height: number, maxCols: number, maxRows: number, cell: Cell): { cols: number; rows: number } {
  const cols = Math.max(1, Math.min(Math.floor(maxCols), Math.floor((Math.max(1, Math.floor(maxRows)) * cell.h * width) / (height * cell.w))));
  const rows = Math.max(1, Math.min(Math.floor(maxRows), Math.round((cols * cell.w * height) / (width * cell.h))));
  return { cols, rows };
}
