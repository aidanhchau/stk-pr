/**
 * Worker: SVG text -> PNG bytes. Loading system fonts costs seconds, which would freeze the TUI, so resvg lives here.
 * Diagrams are authored for GitHub's light page, so the PNG is composited on white. `width`/`height` are the SVG's own (logical) size;
 * the PNG is rendered 1.2k-2.4k px wide so it stays sharp when a terminal scales it to its cell grid.
 */
import { Resvg } from "@resvg/resvg-js";

export interface SvgRequest {
  id: number;
  svg: string;
}
export type SvgReply = { id: number; png: Uint8Array; width: number; height: number } | { id: number; error: string };

declare const self: { onmessage: ((e: { data: SvgRequest }) => void) | null; postMessage(msg: SvgReply, transfer?: Transferable[]): void };

self.onmessage = ({ data: { id, svg } }) => {
  try {
    const { width, height } = new Resvg(svg, { font: { loadSystemFonts: false } });
    if (!(width > 0 && height > 0)) throw new Error("empty svg");
    const zoom = Math.min(2400, Math.max(1200, width * 2)) / width;
    const out = new Resvg(svg, { background: "#ffffff", fitTo: { mode: "zoom", value: zoom }, font: { loadSystemFonts: true, defaultFontFamily: "Arial" } }).render().asPng();
    // copy: asPng returns a Buffer that may view shared memory
    const png = new Uint8Array(out);
    self.postMessage({ id, png, width: Math.round(width), height: Math.round(height) }, [png.buffer]);
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
