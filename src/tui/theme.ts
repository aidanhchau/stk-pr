/** Palette, theme detection, spacing and glyph tables for the TUI ("Quiet signage", design v2 §2, §4, §5, §6.5). */
import { createContext, useContext, useEffect, useState, useSyncExternalStore } from "react";
import type { CliRenderer } from "@opentui/core";
import { useRenderer } from "@opentui/react";

/** One resize listener per renderer shared by every component (OpenTUI's useTerminalDimensions adds one per caller; >10 trips Node's leak warning, which prints over the screen). */
const sizeStores = new WeakMap<CliRenderer, { subscribe(fn: () => void): () => void; get(): { width: number; height: number } }>();
function sizeStore(r: CliRenderer) {
  let s = sizeStores.get(r);
  if (!s) {
    let snap = { width: r.width, height: r.height };
    const subs = new Set<() => void>();
    r.on("resize", (width: number, height: number) => {
      snap = { width, height };
      for (const f of subs) f();
    });
    s = {
      subscribe(fn) {
        subs.add(fn);
        return () => subs.delete(fn);
      },
      get: () => snap,
    };
    sizeStores.set(r, s);
  }
  return s;
}
export function useTermSize(): { width: number; height: number } {
  const s = sizeStore(useRenderer());
  return useSyncExternalStore(s.subscribe, s.get);
}

export interface Palette {
  ground: string;
  surface: string;
  ink: string;
  muted: string;
  faint: string;
  rule: string;
  wash: string;
  cobalt: string;
  /** Selected-row fill. */
  sel: string;
  /** Muted text on `sel`. */
  mutedOnSel: string;
  sign: string;
  signText: string;
  signMuted: string;
  error: string;
  bulletGreen: string;
  bulletRed: string;
  bulletPurple: string;
  /** Readable green for text on ground (counts, approved). */
  ok: string;
  /** Amber for pending/running states. */
  warn: string;
  /** State badge fills (white text): PR open / merged / closed / draft. */
  open: string;
  merged: string;
  closed: string;
  draft: string;
  /** Name/rail colours for people other than the PR author (who gets `cobalt`); none reuse a status colour. */
  people: string[];
}

export const light: Palette = {
  ground: "#FBFBFA",
  surface: "#FFFFFF",
  ink: "#18181B",
  muted: "#6E6E6A",
  faint: "#A3A29D",
  rule: "#E7E6E2",
  wash: "#F2F1EE",
  cobalt: "#0039A6",
  sel: "#E6ECF7",
  mutedOnSel: "#62625E",
  sign: "#111111",
  signText: "#FFFFFF",
  signMuted: "#BCBCBC",
  error: "#B3261E",
  bulletGreen: "#00933C",
  bulletRed: "#EE352E",
  bulletPurple: "#B933AD",
  ok: "#1A7F37",
  warn: "#9A6700",
  open: "#1F883D",
  merged: "#8250DF",
  closed: "#CF222E",
  draft: "#6E7781",
  people: ["#8250DF", "#0F7B74", "#B4532A", "#A4237A"],
};

export const dark: Palette = {
  ground: "#0F0F11",
  surface: "#18181B",
  ink: "#ECECE8",
  muted: "#A09F99",
  faint: "#6B6A66",
  rule: "#2B2B2F",
  wash: "#1D1D20",
  cobalt: "#7C9DE0",
  sel: "#0F2A5C",
  mutedOnSel: "#A09F99",
  sign: "#232327",
  signText: "#FFFFFF",
  signMuted: "#C4C4C0",
  error: "#F2766C",
  bulletGreen: "#00933C",
  bulletRed: "#EE352E",
  bulletPurple: "#B933AD",
  ok: "#3FB950",
  warn: "#D29922",
  open: "#238636",
  merged: "#8957E5",
  closed: "#DA3633",
  draft: "#6E7781",
  people: ["#B392F0", "#4FB8B0", "#E39A6B", "#E07EC0"],
};

export type ThemeName = "light" | "dark";
export const palettes: Record<ThemeName, Palette> = { light, dark };

/** Env-only part of detection: STK_THEME, then COLORFGBG (last field 7/15 => light), else dark. */
export function envTheme(env: Record<string, string | undefined> = process.env): ThemeName {
  const forced = env.STK_THEME;
  if (forced === "light" || forced === "dark") return forced;
  const fgbg = env.COLORFGBG?.split(";").pop();
  if (fgbg === "7" || fgbg === "15") return "light";
  return "dark";
}

/** STK_THEME wins; else the terminal-reported mode; else env fallback. */
export function resolveTheme(mode: ThemeName | null | undefined, env: Record<string, string | undefined> = process.env): ThemeName {
  if (env.STK_THEME === "light" || env.STK_THEME === "dark") return env.STK_THEME;
  return mode ?? envTheme(env);
}

/** Live theme name: starts from renderer.themeMode/env, resolves via waitForThemeMode, follows `theme_mode` events. */
export function useThemeName(): ThemeName {
  const renderer = useRenderer();
  const [name, setName] = useState<ThemeName>(() => resolveTheme(renderer.themeMode));
  useEffect(() => {
    const on = (m: ThemeName) => setName(resolveTheme(m));
    renderer.on("theme_mode", on);
    void renderer.waitForThemeMode(500).then((m) => setName(resolveTheme(m)));
    return () => void renderer.off("theme_mode", on);
  }, [renderer]);
  return name;
}

export const ThemeContext = createContext<{ name: ThemeName; p: Palette }>({ name: "dark", p: dark });
export const useTheme = (): Palette => useContext(ThemeContext).p;
export const useThemeMode = (): ThemeName => useContext(ThemeContext).name;

// ---------- spacing (design §5) ----------

export const SPACE = {
  /** Edge padding in columns (default / narrow). */
  gutter: 4,
  gutterNarrow: 2,
  /** Content max width in columns. */
  maxWidth: 132,
  /** Terminal columns below which the layout is `narrow`. */
  narrowBelow: 80,
  /** Content columns at or above which the layout is `wide`. */
  wideContent: 108,
  /** Selection fill bleeds this many columns into the gutter each side. */
  bleed: 2,
  /** Branch lane width in the wide layout. */
  branchLane: 28,
  checksLane: 9,
  ageLane: 4,
} as const;

export type LayoutMode = "narrow" | "default" | "wide";
export interface Layout {
  /** Terminal columns / rows. */
  width: number;
  height: number;
  gutter: number;
  /** Width of the content column (excludes gutters). */
  contentWidth: number;
  /** Blank columns left of the page frame when centred (width > maxWidth + 2*gutter). */
  margin: number;
  mode: LayoutMode;
}

export function layoutFor(width: number, height = 0): Layout {
  const gutter = width < SPACE.narrowBelow ? SPACE.gutterNarrow : SPACE.gutter;
  const contentWidth = Math.max(10, Math.min(width - 2 * gutter, SPACE.maxWidth));
  const margin = Math.max(0, Math.floor((width - contentWidth - 2 * gutter) / 2));
  const mode: LayoutMode = width < SPACE.narrowBelow ? "narrow" : contentWidth >= SPACE.wideContent ? "wide" : "default";
  return { width, height, gutter, contentWidth, margin, mode };
}

export function useLayout(): Layout {
  const { width, height } = useTermSize();
  return layoutFor(width, height);
}

// ---------- glyphs (design §4, §6.5) ----------

const unicode = {
  dot: "●",
  ring: "○",
  check: "✓",
  cross: "×",
  up: "↑",
  arrow: "→",
  out: "↗",
  child: "└",
  vbar: "│",
  hline: "─",
  leader: "┈",
  open: "▾",
  closed: "▸",
  tl: "╭",
  tr: "╮",
  bl: "╰",
  br: "╯",
  sep: "·",
  ellipsis: "…",
  mark: "▎",
} as const;

const ascii: Record<keyof typeof unicode, string> = {
  dot: "*",
  ring: "o",
  check: "+",
  cross: "x",
  up: "^",
  arrow: "->",
  out: ">",
  child: "`",
  vbar: "|",
  hline: "-",
  leader: ".",
  open: "v",
  closed: ">",
  tl: "+",
  tr: "+",
  bl: "+",
  br: "+",
  sep: "-",
  ellipsis: "...",
  mark: ">",
};

export type GlyphName = keyof typeof unicode;
/** `STK_ASCII=1` switches to the spec's fallback table. */
export const G: Record<GlyphName, string> = process.env.STK_ASCII === "1" ? ascii : unicode;

// ---------- colour helpers ----------

const hex = (s: string): [number, number, number] => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];
const h2 = (n: number) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");

/** A person's colour: the PR author is cobalt, everyone else a stable pick from `people` by login. */
export function personColor(p: Palette, login: string, prAuthor: string): string {
  if (login === prAuthor) return p.cobalt;
  let h = 0;
  for (const ch of login) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return p.people[h % p.people.length]!;
}

/** Linear RGB blend of `a` towards `b` by `t` (0 = a, 1 = b). */
export function lerpHex(a: string, b: string, t: number): string {
  const [ar, ag, ab] = hex(a);
  const [br, bg, bb] = hex(b);
  return `#${h2(ar + (br - ar) * t)}${h2(ag + (bg - ag) * t)}${h2(ab + (bb - ab) * t)}`;
}

/** The saved reduced-motion preference (`prefs.json`); the store sets it on start. Env vars always win upward. */
let reducedMotionPref = false;
export const setReducedMotionPref = (on: boolean): void => {
  reducedMotionPref = on;
};

export const reducedMotion = (): boolean =>
  reducedMotionPref || process.env.NO_MOTION === "1" || process.env.STK_REDUCE_MOTION === "1" || process.env.STK_REDUCED_MOTION === "1";

/** Truncate to `n` cells with an ellipsis. */
export function clip(s: string, n: number): string {
  if (n <= 0) return "";
  if (s.length <= n) return s;
  return n === 1 ? G.ellipsis : s.slice(0, n - 1) + G.ellipsis;
}

export type { CliRenderer };
