/** What to hand an `<image>` for `src` drawn `cols`x`rows` cells: the pixel-exact rendering once it exists, else the base image. */
import type { NativeImage } from "@opentui/core";
import { useEffect, useSyncExternalStore } from "react";
import { imageState, imageVariant, imagesVersion, pinImageVariant, subscribeImages } from "../images";
import { imageTarget, useImageCell } from "./image-density";

/**
 * Re-renders when the terminal's pixel size or an image changes. `pin`: while true the rendering is kept cached, so images on screen never
 * evict each other (release it for views that are not drawn, e.g. under a sheet). null until the image has loaded.
 */
export function useImageSource(src: string, cols: number, rows: number, pin = true): { source: Uint8Array | NativeImage; width: number; height: number } | null {
  useImageCell();
  useSyncExternalStore(subscribeImages, imagesVersion);
  const img = imageState(src);
  const target = imageTarget(cols, rows);
  const w = target?.w;
  const h = target?.h;
  useEffect(() => (pin && w && h ? pinImageVariant(src, w, h) : undefined), [src, w, h, pin]);
  if (img?.status !== "ready") return null;
  return { source: (w && h ? imageVariant(src, w, h) : undefined) ?? img.data, width: img.width, height: img.height };
}
