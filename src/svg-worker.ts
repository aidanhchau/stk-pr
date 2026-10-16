/**
 * Worker: SVG text -> PNG bytes. Loading system fonts costs seconds, which would freeze the TUI, so resvg lives here.
 * Diagrams are authored for GitHub's light page, so the PNG is composited on white. `width`/`height` are the SVG's own (logical) size.
 * Without `targetWidth` the PNG is rendered 1.2k-2.4k px wide (a size-independent fallback); with it, exactly that many px wide (bounded, see
 * svg-bounds.ts), the size a terminal draws it at, so nothing is resampled on the way to the screen.
 */
import { Resvg } from "@resvg/resvg-js";
import { svgZoom, svgZoomTo } from "./svg-bounds";

export interface SvgRequest {
  id: number;
  svg: string;
  targetWidth?: number;
}
export type SvgReply = { id: number; png: Uint8Array; width: number; height: number; pxWidth: number; pxHeight: number } | { id: number; error: string };

declare const self: { onmessage: ((e: { data: SvgRequest }) => void) | null; postMessage(msg: SvgReply, transfer?: Transferable[]): void };

self.onmessage = ({ data: { id, svg, targetWidth } }) => {
  try {
    const { width, height } = new Resvg(svg, { font: { loadSystemFonts: false } });
    const zoom = targetWidth === undefined ? svgZoom(width, height) : svgZoomTo(width, height, targetWidth);
    if (zoom === null) throw new Error("unrenderable size");
    const out = new Resvg(svg, { background: "#ffffff", fitTo: { mode: "zoom", value: zoom }, font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render();
    // copy: asPng returns a Buffer that may view shared memory
    const png = new Uint8Array(out.asPng());
    self.postMessage({ id, png, width: Math.round(width), height: Math.round(height), pxWidth: out.width, pxHeight: out.height }, [png.buffer]);
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
