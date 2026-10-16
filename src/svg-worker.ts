/**
 * Worker: SVG text -> pixels. Loading system fonts costs seconds, which would freeze the TUI, so resvg lives here.
 * Diagrams are authored for GitHub's light page, so the render is composited on white. `width`/`height` are the SVG's own (logical) size.
 * Without `targetWidth` the render is 1.2k-2.4k px wide (a size-independent fallback), returned as PNG bytes; with it, exactly that many px wide
 * (bounded, see svg-bounds.ts, the size a terminal draws it at, so nothing is resampled on the way to the screen), returned as raw RGBA.
 * The worker says `{ ready: true }` once it takes jobs.
 */
import { Resvg } from "@resvg/resvg-js";
import { svgZoom, svgZoomTo } from "./svg-bounds";

export interface SvgRequest {
  id: number;
  svg: string;
  targetWidth?: number;
}
export interface SvgPngReply {
  id: number;
  png: Uint8Array;
  width: number;
  height: number;
}
export interface SvgPixelsReply {
  id: number;
  pixels: Uint8Array;
  pxWidth: number;
  pxHeight: number;
}
export type SvgReply = { ready: true } | SvgPngReply | SvgPixelsReply | { id: number; error: string };

declare const self: { onmessage: ((e: { data: SvgRequest }) => void) | null; postMessage(msg: SvgReply, transfer?: Transferable[]): void };

self.onmessage = ({ data: { id, svg, targetWidth } }) => {
  try {
    const { width, height } = new Resvg(svg, { font: { loadSystemFonts: false } });
    const zoom = targetWidth === undefined ? svgZoom(width, height) : svgZoomTo(width, height, targetWidth);
    if (zoom === null) throw new Error("unrenderable size");
    const out = new Resvg(svg, { background: "#ffffff", fitTo: { mode: "zoom", value: zoom }, font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render();
    // copies: the buffers may view shared memory
    if (targetWidth === undefined) {
      const png = new Uint8Array(out.asPng());
      self.postMessage({ id, png, width: Math.round(width), height: Math.round(height) }, [png.buffer]);
    } else {
      const pixels = new Uint8Array(out.pixels);
      self.postMessage({ id, pixels, pxWidth: out.width, pxHeight: out.height }, [pixels.buffer]);
    }
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
self.postMessage({ ready: true });
