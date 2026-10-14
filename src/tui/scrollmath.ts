/** Pure scroll math for `useScrollFollow` (no renderer dependency, unit-tested). */

export const GLIDE_MIN = 3; // jumps of this many lines or fewer are immediate
export const GLIDE_MS = 120;
export const GLIDE_FRAME_MS = 16;

/** Clamp a scrollTop to [0, scrollHeight - viewport] and round to a whole line. */
export function clampTop(y: number, scrollHeight: number, vh: number): number {
  return Math.max(0, Math.min(Math.max(0, scrollHeight - vh), Math.round(y)));
}

/**
 * Minimum scrollTop that keeps the block [y - lead, y + h] inside the viewport with `margin` lines to
 * spare at each edge (vim scrolloff). Returns `top` unchanged when already inside, never recentres.
 */
export function scrolloffTarget(top: number, vh: number, y: number, h: number, lead = 0, margin = 3): number {
  const size = h + lead;
  const m = Math.max(0, Math.min(margin, Math.floor((vh - size) / 2)));
  if (size >= vh) return y; // taller than the view: show its top
  const from = y - lead - m;
  const to = y + h + m;
  if (from < top) return from;
  if (to > top + vh) return to - vh;
  return top;
}

/** scrollTop that puts a block now at content line `y` back on screen row `row` (row = y - scrollTop when recorded). */
export function anchorRestore(y: number, row: number): number {
  return y - row;
}

/** Ease-out (cubic) integer scrollTop sequence from `from` to `to`, excluding `from`, ending exactly at `to`. */
export function glideSteps(from: number, to: number, ms = GLIDE_MS, frameMs = GLIDE_FRAME_MS): number[] {
  const frames = Math.max(1, Math.round(ms / frameMs));
  const out: number[] = [];
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const e = 1 - (1 - t) ** 3;
    const v = i === frames ? to : Math.round(from + (to - from) * e);
    if (out.length === 0 ? v !== from : v !== out[out.length - 1]) out.push(v);
  }
  if (out.length === 0 || out[out.length - 1] !== to) out.push(to);
  return out;
}
