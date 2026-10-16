/**
 * Worker: downscale a PNG/JPEG/WebP/GIF to exactly `width`x`height` with one high-quality resize, returned as raw RGBA, so the UI thread never
 * decodes or resamples a big bitmap. The worker says `{ ready: true }` once it takes jobs.
 */
import { NativeImage } from "@opentui/core";

export interface RasterRequest {
  id: number;
  data: Uint8Array;
  width: number;
  height: number;
}
export interface RasterPixelsReply {
  id: number;
  pixels: Uint8Array;
  pxWidth: number;
  pxHeight: number;
}
export type RasterReply = { ready: true } | RasterPixelsReply | { id: number; error: string };

declare const self: { onmessage: ((e: { data: RasterRequest }) => void) | null; postMessage(msg: RasterReply, transfer?: Transferable[]): void };

self.onmessage = ({ data: { id, data, width, height } }) => {
  try {
    const full = NativeImage.decode(data);
    const small = full.resize({ width, height, kernel: "catmull-rom" });
    full.dispose();
    const raw = small.raw("rgba8");
    // rows are `stride` bytes apart: pack them tight
    const pixels = new Uint8Array(raw.width * raw.height * 4);
    for (let y = 0; y < raw.height; y++) pixels.set(raw.data.subarray(y * raw.stride, y * raw.stride + raw.width * 4), y * raw.width * 4);
    const reply = { id, pixels, pxWidth: raw.width, pxHeight: raw.height };
    small.dispose();
    self.postMessage(reply, [pixels.buffer]);
  } catch (e) {
    self.postMessage({ id, error: e instanceof Error ? e.message : String(e) });
  }
};
self.postMessage({ ready: true });
