/** Shared primitives for every screen (design v2 §4-§8). Colours come from the Palette; screens never hardcode hex. */
import { MacOSScrollAccel, RGBA, type InputRenderable, type KeyEvent, type MouseEvent, type ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer, type BoxProps } from "@opentui/react";
import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ComponentType, type ReactNode, type Ref, type RefObject } from "react";
import { useStore, useStoreInstance, type Toast } from "./store";
import { GLIDE_FRAME_MS, GLIDE_MIN, anchorRestore, clampTop, glideSteps, scrolloffTarget } from "./scrollmath";
import { G, SPACE, clip, lerpHex, reducedMotion, useLayout, useTermSize, useTheme, type Palette } from "./theme";

const LINE = "─".repeat(400);
const LEADER = "┈".repeat(400);

// ---------- text ----------

export type Tone = "ink" | "muted" | "faint" | "error" | "cobalt" | "merged" | "ok" | "warn";
export const RowContext = createContext(false);

/** Colour for a tone, aware of selection fill (muted becomes mutedOnSel inside a selected Row). */
export function toneColor(p: Palette, tone: Tone, selected = false): string {
  if (tone === "muted") return selected ? p.mutedOnSel : p.muted;
  return p[tone];
}

/** Single-line text with a tone. `truncate` clips with an ellipsis inside its flex box. */
export function Txt({ tone = "ink", bold, truncate, children }: { tone?: Tone; bold?: boolean; truncate?: boolean; children?: ReactNode }) {
  const p = useTheme();
  const selected = useContext(RowContext);
  const fg = toneColor(p, tone, selected);
  const body = bold ? <strong>{children}</strong> : children;
  return truncate ? (
    <text fg={fg} wrapMode="none" truncate>
      {body}
    </text>
  ) : (
    <text fg={fg}>{body}</text>
  );
}

// ---------- layout ----------

/**
 * Screen frame: ground fill, 1 blank row on top, content column of `contentWidth` centred with
 * the spec's edge padding. Children fill the remaining height (flex column).
 */
export function Page({ children }: { children: ReactNode }) {
  const p = useTheme();
  const { contentWidth, gutter } = useLayout();
  return (
    <box flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} flexDirection="column" alignItems="center" backgroundColor={p.ground}>
      <box width={contentWidth + 2 * gutter} flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} flexDirection="column" paddingLeft={gutter} paddingRight={gutter} paddingTop={1}>
        {children}
      </box>
    </box>
  );
}

/** One shared accelerator: slow wheel = 1 line/event, a fast flick ramps up (OpenTUI's built-in curve). */
const WHEEL_ACCEL = new MacOSScrollAccel();

/**
 * Scroll area inside a Page. Extends 2 cols into the gutter on both sides so the selection
 * fill of `Row` can bleed; content is still at the page's content column. Rows go directly inside.
 * The mouse never moves the view except the wheel: dragging to select text must not scroll, so ScrollBox's drag auto-scroll is switched off.
 */
export function Scroll({
  children,
  scrollRef,
  onWheel,
}: {
  children: ReactNode;
  scrollRef?: Ref<ScrollBoxRenderable>;
  onWheel?: (dir: "up" | "down") => void;
}) {
  const p = useTheme();
  const ref = useCallback(
    (sb: ScrollBoxRenderable | null) => {
      // ScrollBox scrolls itself while a drag ends within 3 rows of its edge (up to 72 lines/s), and @opentui/core 0.6.x has no option to
      // turn that off. `updateAutoScroll` is its only way in (`startAutoScroll` is reached only from it), so a no-op on the instance
      // disables it. Revisit when @opentui/core is upgraded.
      if (sb) sb.updateAutoScroll = () => {};
      if (typeof scrollRef === "function") scrollRef(sb);
      else if (scrollRef) (scrollRef as { current: ScrollBoxRenderable | null }).current = sb;
    },
    [scrollRef],
  );
  return (
    <scrollbox
      ref={ref}
      scrollY
      // Never focusable: a focused scrollbox also scrolls itself on j/k/h/l/up/down/pageup/pagedown (by 1/5 viewport, no animation)
      // on top of our own cursor-follow, so after any click every j moved the cursor AND jerked the viewport.
      focusable={false}
      scrollAcceleration={WHEEL_ACCEL}
      onMouseScroll={onWheel ? (e: { scroll?: { direction?: string } }) => onWheel(e.scroll?.direction === "up" ? "up" : "down") : undefined}
      flexGrow={1}
      flexShrink={1}
      flexBasis={0}
      minHeight={0}
      marginLeft={-SPACE.bleed}
      marginRight={-SPACE.bleed}
      style={{
        rootOptions: { backgroundColor: p.ground },
        wrapperOptions: { backgroundColor: p.ground },
        viewportOptions: { backgroundColor: p.ground },
        contentOptions: { backgroundColor: p.ground, paddingLeft: SPACE.bleed, paddingRight: SPACE.bleed, paddingBottom: 1 },
      }}
    >
      {children}
    </scrollbox>
  );
}

// ---------- scroll follow ----------

/** The cursor block in content lines: `y` first line, `h` height, `lead` extra lines above it to keep visible (a group label). */
export interface FollowTarget {
  key: string;
  y: number;
  h: number;
  lead?: number;
}

export interface ScrollFollowOptions {
  /** Lines kept between the cursor block and the viewport edge (vim scrolloff). Default 3. */
  margin?: number;
  /** The wheel scrolled the cursor out of view: return the key of the item nearest the edge within [top, bottom) (content lines), or null to leave it. */
  clampCursor?(top: number, bottom: number, dir: "up" | "down"): string | null;
  /** First placement puts the target on this terminal row (absolute, so a taller fixed header above the scroll doesn't shift it) instead of scrolling the minimum. Read once, at mount. */
  initialScreenRow?: number;
}

export interface ScrollFollow {
  /** Scroll to an absolute line (glides when the jump is > 3 lines). */
  scrollTo(y: number): void;
  /** Scroll relative to the current position, or to the in-flight glide's goal (glides when > 3 lines). */
  scrollBy(dy: number): void;
  /**
   * Call right before a toggle / re-layout that changes content around the cursor (expand, collapse, fold):
   * records the cursor's screen row; after layout scrollTop is restored so that row stays put (no scrolloff jump).
   * Cleared automatically if no layout change arrives. `at` names another item that is about to take the cursor (a double-click on it):
   * its row is the one kept in place, so the view doesn't move to give it scrolloff.
   */
  anchorItem(at?: { key: string; y: number }): void;
  /** Scroll the viewport by `dy` lines at once (any glide stops); the cursor is left where it is, even off screen. */
  nudge(dy: number): void;
  /** Pass to `<Scroll onWheel>`. */
  onWheel(dir: "up" | "down"): void;
}

/**
 * Cursor follow for a `<Scroll>`: scrolls the minimum needed to keep `target` inside the viewport with a
 * `margin` (never recentres), anchors on `target.key` when content reflows (data refresh, expand/collapse
 * above the cursor keep it on the same screen row), glides long programmatic jumps (~120ms ease-out in whole
 * lines; off with STK_REDUCED_MOTION=1), and lets the wheel scroll the viewport immediately and independently,
 * clamping the cursor to the edge only once it would leave the view.
 */
export function useScrollFollow(scrollRef: RefObject<ScrollBoxRenderable | null>, target: FollowTarget | null | undefined, opts: ScrollFollowOptions = {}): ScrollFollow {
  const latest = useRef({ target, opts });
  latest.current = { target, opts };
  const last = useRef<{ key: string; y: number } | null>(null);
  const skipKey = useRef<string | null>(null);
  const anchor = useRef<{ key: string; row: number; timer: NodeJS.Timeout } | null>(null);
  const glide = useRef<{ timer: NodeJS.Timeout; goal: number } | null>(null);
  const initial = useRef(opts.initialScreenRow);

  const stopGlide = () => {
    clearInterval(glide.current?.timer);
    glide.current = null;
  };
  useEffect(
    () => () => {
      stopGlide();
      clearTimeout(anchor.current?.timer);
    },
    [],
  );

  const place = (sb: ScrollBoxRenderable, y: number) => sb.scrollTo(clampTop(y, sb.scrollHeight, sb.viewport?.height ?? 0));

  /** Immediate when short / reduced-motion / `instant`; otherwise a timer-driven glide that retargets on every call. */
  const jump = (y: number, instant = false) => {
    const sb = scrollRef.current;
    if (!sb) return;
    stopGlide();
    const to = clampTop(y, sb.scrollHeight, sb.viewport?.height ?? 0);
    const from = sb.scrollTop;
    if (instant || reducedMotion() || Math.abs(to - from) <= GLIDE_MIN) return sb.scrollTo(to);
    const steps = glideSteps(from, to);
    let i = 0;
    sb.scrollTo(steps[i++]!);
    if (i >= steps.length) return;
    const timer = setInterval(() => {
      const s = scrollRef.current;
      if (!s) return stopGlide();
      s.scrollTo(steps[i++]!);
      if (i >= steps.length) stopGlide();
    }, GLIDE_FRAME_MS);
    glide.current = { timer, goal: to };
  };

  const tk = target?.key;
  const ty = target?.y;
  const th = target?.h;
  const tl = target?.lead;
  useEffect(() => {
    const sb = scrollRef.current;
    const prev = last.current;
    last.current = target ? { key: target.key, y: target.y } : null;
    if (!sb || !target) return;
    const vh = sb.viewport?.height ?? 0;
    if (vh <= 0) return;
    if (skipKey.current === target.key) {
      skipKey.current = null;
      return;
    }
    // Initial placement pending (the effect below waits for layout): skip the scrolloff jump.
    if (initial.current !== undefined) return;
    const a = anchor.current;
    if (a && a.key === target.key) {
      // Toggle: keep the cursor on the recorded screen row, no scrolloff adjustment.
      clearTimeout(a.timer);
      anchor.current = null;
      stopGlide();
      place(sb, anchorRestore(target.y, a.row));
      return;
    }
    const base = glide.current?.goal ?? sb.scrollTop;
    if (prev && prev.key === target.key) {
      // Same item, new position (refresh / fold above): keep it at the same screen row.
      if (target.y !== prev.y) jump(sb.scrollTop + (target.y - prev.y), true);
      return;
    }
    const want = scrolloffTarget(base, vh, target.y, target.h, target.lead ?? 0, latest.current.opts.margin ?? 3);
    if (want !== base) jump(want);
  }, [tk, ty, th, tl]);
  // `initialScreenRow`: the scrollbox has no size at mount, so poll a few frames until the target is laid out, then place it once.
  useEffect(() => {
    if (initial.current === undefined) return;
    let tries = 0;
    const timer = setInterval(() => {
      const sb = scrollRef.current;
      const t = latest.current.target;
      const row = initial.current;
      if (sb && t && row !== undefined && (sb.viewport?.height ?? 0) > 0 && sb.scrollHeight >= t.y + t.h) place(sb, t.y - (row - sb.viewport.screenY));
      else if (++tries < 30) return;
      initial.current = undefined;
      clearInterval(timer);
    }, 16);
    return () => clearInterval(timer);
  }, []);

  const onWheel = (_dir: "up" | "down") => {
    stopGlide();
    // The scrollbox applies the wheel delta after (or before) this listener runs; read the result next tick.
    setTimeout(() => {
      const sb = scrollRef.current;
      const { target: t, opts: o } = latest.current;
      if (!sb || !t || !o.clampCursor) return;
      const vh = sb.viewport?.height ?? 0;
      const top = sb.scrollTop;
      if (t.y >= top && t.y + t.h <= top + vh) return;
      const m = Math.max(0, Math.min(o.margin ?? 3, Math.floor((vh - t.h) / 2)));
      const key = o.clampCursor(top + m, top + vh - m, t.y < top ? "up" : "down");
      if (key && key !== t.key) skipKey.current = key;
    }, 0);
  };

  return {
    scrollTo: (y) => jump(y),
    scrollBy: (dy) => jump((glide.current?.goal ?? scrollRef.current?.scrollTop ?? 0) + dy),
    anchorItem: (at) => {
      const sb = scrollRef.current;
      const t = at ?? latest.current.target;
      if (!sb || !t) return;
      clearTimeout(anchor.current?.timer);
      const timer = setTimeout(() => (anchor.current = null), 150);
      anchor.current = { key: t.key, row: t.y - sb.scrollTop, timer };
    },
    nudge: (dy) => {
      const sb = scrollRef.current;
      if (!sb) return;
      stopGlide();
      place(sb, sb.scrollTop + dy);
    },
    onWheel,
  };
}

/** One-row hairline filling its parent's width; `ink` is the table-header rule. */
export function Rule({ ink }: { ink?: boolean }) {
  const p = useTheme();
  return (
    <box height={1} width="100%" flexShrink={0} overflow="hidden">
      <text fg={ink ? p.ink : p.rule} wrapMode="none">
        {LINE}
      </text>
    </box>
  );
}

/** UPPERCASE muted label, faint `┈` leader, right-aligned muted meta (count). */
export function SectionLabel({ label, meta }: { label: string; meta?: string | number }) {
  const p = useTheme();
  return (
    <box height={1} flexDirection="row" flexShrink={0}>
      <box flexShrink={0}>
        <text fg={p.muted}>{label.toUpperCase()}</text>
      </box>
      <box flexGrow={1} flexShrink={1} height={1} overflow="hidden" marginLeft={1} marginRight={1}>
        <text fg={p.faint} wrapMode="none">
          {LEADER}
        </text>
      </box>
      {meta !== undefined && (
        <box flexGrow={1} flexShrink={1} overflow="hidden" height={1}>
          <text fg={p.muted} wrapMode="none">{String(meta)}</text>
        </box>
      )}
    </box>
  );
}

/**
 * The one black band per view: white rule row, bold title row (+ right text), optional sub
 * row(s) in the muted band colour, blank bottom row. `children` replace the sub row.
 */
export function SignBand({ title, right, sub, children }: { title: ReactNode; right?: ReactNode; sub?: string; children?: ReactNode }) {
  const p = useTheme();
  return (
    <box flexDirection="column" backgroundColor={p.sign} flexShrink={0} width="100%">
      <box height={1} overflow="hidden">
        <text fg={p.signText} bg={p.sign} wrapMode="none">
          {LINE}
        </text>
      </box>
      <box height={1} flexDirection="row" paddingLeft={2} paddingRight={2} justifyContent="space-between">
        <text fg={p.signText} bg={p.sign}>
          <strong>{title}</strong>
        </text>
        {right !== undefined && (
          <text fg={p.signText} bg={p.sign}>
            {right}
          </text>
        )}
      </box>
      {sub !== undefined && (
        <box height={1} paddingLeft={2} paddingRight={2} overflow="hidden">
          <text fg={p.signMuted} bg={p.sign} wrapMode="none" truncate>
            {sub}
          </text>
        </box>
      )}
      {children}
      <box height={1} />
    </box>
  );
}

// ---------- controls ----------

export type PillVariant = "neutral" | "primary" | "secondary" | "danger-quiet";

/** The tap in progress: one at a time, since there is one pointer. */
let tapping: { x: number; y: number; dragged: boolean; owner: object } | null = null;
/** The last finished tap of a `useDoubleTap` element, waiting for its second. A drag anywhere forgets it. */
let lastTap: { owner: object; x: number; y: number; at: number } | null = null;
/** Root drag handler. A drag that starts on a tap element is a drag once it is past one cell; one that starts anywhere else (body text) is one at once. */
const cancelTap = (e: MouseEvent) => {
  if (!tapping) lastTap = null;
  else if (Math.abs(tapping.x - e.x) > 1 || tapping.y !== e.y) {
    tapping.dragged = true;
    lastTap = null;
  }
};
/**
 * Root press handler. A press bubbles up to it after the pressed element's own handler has set `tapping`, so a press that isn't on the
 * element waiting for its second tap (a plain-text press has no `tapping` at all) starts the count over.
 */
const forgetStrayTap = () => {
  if (lastTap && tapping?.owner !== lastTap.owner) lastTap = null;
};

/**
 * Mouse handlers for a button or link. It fires on release, and only for a click: the pointer is released within one cell of the press
 * and no drag went further than that (a drag is a text selection; one cell of jitter is allowed). A tap never moves the cursor or scrolls. OpenTUI sends a drag only to
 * the element under the pointer, so a drag that leaves the button and comes back never reaches it; drags bubble to the root, which cancels
 * the tap once one is more than a cell from the press (set at press), whichever element it passes over, and the cancel sticks.
 * `onTap` gets the release event. With `hit`, only a press it accepts starts a tap, and that press goes no further up (so a link inside a
 * double-tap row is not also a tap of the row); any other press is left to the elements above.
 */
export function useTap(onTap?: (e: MouseEvent) => void, hit?: (e: MouseEvent) => boolean, waiting?: object) {
  const renderer = useRenderer();
  const own = useRef({});
  const me = waiting ?? own.current;
  return {
    onMouseDown: (e: MouseEvent) => {
      renderer.root.onMouseDrag = cancelTap;
      renderer.root.onMouseDown = forgetStrayTap;
      // A link press stops propagation below, so the root never sees it: forget another element's pending double-tap here.
      if (lastTap && lastTap.owner !== me) lastTap = null;
      if (hit) {
        if (!hit(e)) {
          tapping = null;
          return;
        }
        e.stopPropagation();
      }
      tapping = { x: e.x, y: e.y, dragged: false, owner: me };
    },
    onMouseUp: (e: MouseEvent) => {
      const d = tapping;
      if (!d || d.owner !== me) return;
      tapping = null;
      if (d.dragged || Math.abs(d.x - e.x) > 1 || d.y !== e.y) return;
      onTap?.(e);
    },
  };
}

/** Longest gap between the two taps of a double-click. */
export const DOUBLE_TAP_MS = 400;

/**
 * Mouse handlers for an element that opens on a double-click and does nothing on a single one. Each tap follows `useTap` (no drag
 * past one cell); the second must land on the same element, within `DOUBLE_TAP_MS` and one cell of the first. It fires on the second
 * release, then clears the word selection the second press made. A tap on another element, or any drag, starts the count over.
 */
export function useDoubleTap(onOpen?: () => void) {
  const renderer = useRenderer();
  const me = useRef({});
  return useTap((e) => {
    const prev = lastTap;
    const now = Date.now();
    if (prev && prev.owner === me.current && now - prev.at <= DOUBLE_TAP_MS && Math.abs(prev.x - e.x) <= 1 && prev.y === e.y) {
      lastTap = null;
      if (renderer.getSelection()) renderer.clearSelection();
      onOpen?.();
    } else lastTap = { owner: me.current, x: e.x, y: e.y, at: now };
  }, undefined, me.current);
}

/** A `<box>` that runs `onOpen` on a double-click (see `useDoubleTap`). */
export function OpenBox({ onOpen, ...box }: BoxProps & { onOpen?: () => void }) {
  const tap = useDoubleTap(onOpen);
  return <box {...box} {...(onOpen ? tap : {})} />;
}

/**
 * 1-row pill (one space of fill each side). primary = ink bg (the one safe action), secondary/neutral = wash,
 * danger-quiet = wash with error-coloured label (never a red fill). `hint` is the key shown after the label.
 */
export function Pill({
  label,
  hint,
  variant = "secondary",
  disabled,
  onPress,
}: {
  label: string;
  hint?: string;
  variant?: PillVariant;
  disabled?: boolean;
  onPress?: () => void;
}) {
  const p = useTheme();
  const tap = useTap(disabled ? undefined : onPress);
  const bg = variant === "primary" && !disabled ? p.ink : p.wash;
  const fg = disabled ? p.faint : variant === "primary" ? p.ground : variant === "danger-quiet" ? p.error : variant === "neutral" ? p.muted : p.ink;
  const hintFg = disabled ? p.faint : variant === "primary" ? lerpHex(p.ground, p.ink, 0.3) : p.muted;
  return (
    <box flexDirection="row" flexShrink={0} {...tap}>
      <text fg={fg} bg={bg}>
        {" "}
        <strong>{label}</strong>
        {hint ? <span fg={hintFg}>{` ${hint}`}</span> : null}{" "}
      </text>
    </box>
  );
}

/** Key hint: muted, no box. `Kbd k="m"` renders `m`; with `label` renders `Merge m`. */
export function Kbd({ k, label }: { k: string; label?: string }) {
  const p = useTheme();
  return <text fg={p.muted}>{label ? `${label} ${k}` : k}</text>;
}

/** Segmented tabs: no track; inactive tabs are muted text, the selected tab is a solid ink pill with ground-coloured bold text. */
export function Segmented<K extends string>({ items, value, onChange }: { items: { key: K; label: string }[]; value: K; onChange: (k: K) => void }) {
  return (
    <box flexDirection="row" alignSelf="flex-start" flexShrink={0}>
      {items.map((it, i) => (
        <SegmentedTab key={it.key} first={i === 0} on={it.key === value} label={it.label} onPress={() => onChange(it.key)} />
      ))}
    </box>
  );
}

function SegmentedTab({ first, on, label, onPress }: { first: boolean; on: boolean; label: string; onPress: () => void }) {
  const p = useTheme();
  const tap = useTap(onPress);
  return (
    <box flexDirection="row" marginLeft={first ? 0 : 1} {...tap}>
      <text fg={on ? p.ground : p.muted} bg={on ? p.ink : p.ground} wrapMode="none">
        {on ? <strong>{` ${label} `}</strong> : ` ${label} `}
      </text>
    </box>
  );
}

// ---------- status ----------

export type StatusKind = "needs-fixes" | "review" | "ready" | "draft" | "merged" | "closed" | "fail" | "pending" | "pass" | "skipped";

/** Single-cell status glyph with the spec's colour logic (colour only on the glyph). */
export function StatusGlyph({ status }: { status: StatusKind }) {
  const p = useTheme();
  const [ch, fg] = {
    "needs-fixes": [G.dot, p.bulletRed],
    review: [G.ring, p.faint],
    ready: [G.dot, p.bulletGreen],
    draft: [G.ring, p.faint],
    merged: [G.dot, p.bulletPurple],
    closed: [G.cross, p.faint],
    fail: [G.cross, p.error],
    pending: [G.ring, p.faint],
    pass: [G.check, p.muted],
    skipped: [G.ring, p.faint],
  }[status];
  return <text fg={fg}>{ch}</text>;
}

// ---------- rows ----------
/** Single-line flex-filling text; clips to its measured width with an ellipsis at the end (or native middle truncation). */
export function Clipped({ text, fg, bold, middle }: { text: string; fg: string; bold?: boolean; middle?: boolean }) {
  const [w, setW] = useState(0);
  const shown = middle || w <= 0 ? text : clip(text, w);
  return (
    <box
      flexGrow={1}
      flexShrink={1}
      height={1}
      overflow="hidden"
      onSizeChange={function () {
        setW(this.width);
      }}
    >
      <text fg={fg} wrapMode="none" truncate={middle}>
        {bold ? <strong>{shown}</strong> : shown}
      </text>
    </box>
  );
}

export interface RowProps {
  selected?: boolean;
  /** Stack depth: 0 = root. d>=1 draws `└` at col 3d-2, glyph at col 3d, title at 3d+2. */
  depth?: number;
  /** Usually a <StatusGlyph/>. */
  glyph?: ReactNode;
  title: string;
  /** `muted` dims the title (merged/closed rows). */
  titleTone?: "default" | "muted";
  /** Title truncation: "end" (default, `foo bar…`) or "middle" (`foo…bar`, for paths). */
  truncate?: "end" | "middle";
  /** Right end of the title line (checks lane, age...). */
  titleRight?: ReactNode;
  /** Second line, left (muted by default; pass <Txt> children for other tones). */
  meta?: ReactNode;
  /** Second line, right-aligned (blocker text / CTA). */
  right?: ReactNode;
  /** Draw the hairline row after this row. */
  hairline?: boolean;
  /** Double-click: what Enter does for this row. A single click does nothing. */
  onOpen?: () => void;
}

/**
 * Two text lines (+ optional hairline row). Selection = `sel` fill across both lines, bleeding 2 cols
 * into the gutter (needs to be inside `<Scroll>`). Hover = wash. Descendant `<Txt tone="muted">` automatically
 * switches to mutedOnSel while selected.
 */
export function Row({ selected, depth = 0, glyph, title, titleTone, truncate, titleRight, meta, right, hairline, onOpen }: RowProps) {
  const p = useTheme();
  const tap = useDoubleTap(onOpen);
  const [hover, setHover] = useState(false);
  const bg = selected ? p.sel : hover ? p.wash : p.ground;
  const prefix = depth > 0 ? `${" ".repeat(3 * depth - 2)}${G.child} ` : "";
  const indent = " ".repeat(3 * depth + 2);
  return (
    <RowContext.Provider value={!!selected}>
      <box flexDirection="column" flexShrink={0}>
        <box
          flexDirection="column"
          backgroundColor={bg}
          marginLeft={-SPACE.bleed}
          marginRight={-SPACE.bleed}
          paddingLeft={SPACE.bleed}
          paddingRight={SPACE.bleed}
          {...(onOpen ? tap : {})}
          onMouseOver={() => setHover(true)}
          onMouseOut={() => setHover(false)}
        >
          <box height={1} flexDirection="row">
            {prefix ? <text fg={p.faint}>{prefix}</text> : null}
            {glyph}
            <text> </text>
            <Clipped text={title} fg={titleTone === "muted" ? (selected ? p.mutedOnSel : p.muted) : p.ink} bold middle={truncate === "middle"} />
            {titleRight !== undefined && <box marginLeft={2} flexShrink={0}>{titleRight}</box>}
          </box>
          <box height={1} flexDirection="row">
            <text>{indent}</text>
            {typeof meta === "string" ? (
              <Clipped text={meta} fg={selected ? p.mutedOnSel : p.muted} />
            ) : (
              <box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
                {meta}
              </box>
            )}
            {right !== undefined && <box marginLeft={2} flexShrink={0}>{typeof right === "string" ? <text fg={selected ? p.mutedOnSel : p.muted}>{right}</text> : right}</box>}
          </box>
        </box>
        {hairline && <Rule />}
      </box>
    </RowContext.Provider>
  );
}

// ---------- states ----------

/** Plain muted line that breathes between faint and muted (1800 ms period, 100 ms frames). */
export function Loading({ text }: { text: string }) {
  const p = useTheme();
  const still = reducedMotion();
  const [t, setT] = useState(0);
  useEffect(() => {
    if (still) return;
    const id = setInterval(() => setT(Date.now()), 100);
    return () => clearInterval(id);
  }, [still]);
  const k = still ? 1 : (Math.sin((t / 1800) * 2 * Math.PI) + 1) / 2;
  return <text fg={still ? p.muted : lerpHex(p.faint, p.muted, k)}>{still ? `${text}…` : text}</text>;
}

/** `×` + bold sentence, muted detail, muted hint. No card. */
export function ErrorState({ title, detail, hint = "Press r to retry" }: { title: string; detail?: string; hint?: string }) {
  const p = useTheme();
  return (
    <box flexDirection="row">
      <text fg={p.error}>{`${G.cross}  `}</text>
      <box flexDirection="column" flexGrow={1} flexShrink={1}>
        <text fg={p.ink}>
          <strong>{title}</strong>
        </text>
        {detail ? <text fg={p.muted}>{detail}</text> : null}
        {hint ? <text fg={p.muted}>{hint}</text> : null}
      </box>
    </box>
  );
}

/** Muted one-liner for empty lists. */
export function Empty({ text }: { text: string }) {
  const p = useTheme();
  return <text fg={p.muted}>{text}</text>;
}

// ---------- toasts, dock, sheet ----------

/** Greedy word wrap to `w` columns (long words are split); toasts wrap themselves because an absolute box won't grow. */
export function wrapText(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let line = "";
    for (let word of para.split(/\s+/).filter(Boolean)) {
      while (word.length > w) {
        if (line) out.push(line), (line = "");
        out.push(word.slice(0, w));
        word = word.slice(w);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else out.push(line), (line = word);
    }
    out.push(line);
  }
  return out;
}

function ToastLine({ t, W }: { t: Toast; W: number }) {
  const p = useTheme();
  const glyph = t.kind === "error" ? G.cross : t.kind === "success" ? G.check : G.dot;
  // room: 90% of the terminal minus the area's right gutter, padding (2) and the glyph column (2)
  const lines = wrapText(t.text, Math.max(10, Math.min(t.text.length, Math.floor(W * 0.9) - SPACE.gutter - 4)));
  const width = Math.max(...lines.map((l) => l.length));
  return (
    <box flexDirection="row" backgroundColor={p.wash} paddingLeft={1} paddingRight={1} marginTop={1} alignSelf="flex-end">
      <box flexShrink={0} width={2}>
        <text fg={t.kind === "error" ? p.error : p.muted} bg={p.wash}>{`${glyph} `}</text>
      </box>
      <box flexShrink={0} width={width} flexDirection="column">
        {lines.map((l, i) => (
          <text key={i} fg={p.ink} bg={p.wash} wrapMode="none">
            {l}
          </text>
        ))}
      </box>
    </box>
  );
}

/** Bottom-right stack of toasts, above the dock. Rendered once by App. Spans the terminal explicitly: the app root can be wider than the screen on narrow terminals, so anchoring `right` alone pushed toasts off the edge. */
export function ToastArea() {
  const toasts = useStore((s) => s.toasts);
  const { width: W } = useTermSize();
  if (toasts.length === 0) return null;
  return (
    <box position="absolute" left={0} width={W} bottom={4} zIndex={40} flexDirection="column" alignItems="flex-end" paddingRight={SPACE.gutter}>
      {toasts.map((t) => (
        <ToastLine key={t.id} t={t} W={W} />
      ))}
    </box>
  );
}

export type KeyHint = [key: string, label: string];

/** `j/k move · ⏎ open · ? help` */
export function KeyHints({ hints }: { hints: KeyHint[] }) {
  const p = useTheme();
  return (
    <text fg={p.muted} wrapMode="none" truncate>
      {hints.map(([k, l]) => `${k} ${l}`).join(` ${G.sep} `)}
    </text>
  );
}

/**
 * Bottom dock: full-bleed rule, then two rows inside the gutter.
 * Row 1: `top` left (`: commands · / search`, or the typed line) and `right` (key hints / action pills).
 * Row 2: `status` left (readiness / job status, or the mode hint while typing) and `count` right (`31 loaded`, `3/12`).
 * Rendered by App for every screen; the palette results panel sits above the rule.
 */
export function Dock({ top, right, status, count }: { top?: ReactNode; right?: ReactNode; status?: ReactNode; count?: ReactNode }) {
  const p = useTheme();
  const { gutter, margin } = useLayout();
  return (
    <box flexDirection="column" flexShrink={0} backgroundColor={p.ground}>
      <box height={1} overflow="hidden">
        <text fg={p.rule} wrapMode="none">
          {LINE}
        </text>
      </box>
      <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={margin + gutter} paddingRight={margin + gutter}>
        <box flexGrow={1} flexShrink={1} overflow="hidden" height={1}>
          {top}
        </box>
        <box flexShrink={0} marginLeft={2}>
          {right}
        </box>
      </box>
      <box height={1} flexDirection="row" justifyContent="space-between" paddingLeft={margin + gutter} paddingRight={margin + gutter}>
        <box flexGrow={1} flexShrink={1} overflow="hidden" height={1}>
          {status}
        </box>
        <box flexShrink={0} marginLeft={2}>
          {count}
        </box>
      </box>
    </box>
  );
}

/**
 * Modal: scrim that blocks clicks to the page, rounded rule-coloured frame, sign-band header
 * (`title` + right `meta`), padded body. Close is the caller's `onClose` (App binds Esc to closeSheet).
 */
export function Sheet({ title, meta, width = 72, children }: { title: string; meta?: string; width?: number; children: ReactNode }) {
  const p = useTheme();
  const { width: W, height: H } = useTermSize();
  const w = Math.min(W < SPACE.narrowBelow ? 64 : width, W - 2);
  const scrim = RGBA.fromHex(p.ground);
  scrim.a = 0.55;
  return (
    <box position="absolute" left={0} top={0} width={W} height={H} zIndex={50} onMouseDown={(e) => e.stopPropagation()} backgroundColor={scrim}>
      <box
        position="absolute"
        left={Math.floor((W - w) / 2)}
        top={H >= 24 ? 4 : 1}
        width={w}
        border
        borderStyle="rounded"
        borderColor={p.rule}
        backgroundColor={p.ground}
        flexDirection="column"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <SignBand title={title} right={meta} />
        <box flexDirection="column" paddingLeft={3} paddingRight={3} paddingBottom={1} backgroundColor={p.ground}>
          {children}
        </box>
      </box>
    </box>
  );
}

/**
 * Per-screen key handler. Runs only while no sheet is open and no text input has focus, so screens
 * never need to gate themselves. ⌘ chords (kitty `super`) are app-level (see app.tsx) and never reach screens, which
 * would otherwise read ⌘⇧C as `C`. (Sheets use plain `useKeyboard`; they only mount while open.)
 */
export function useScreenKeys(handler: (key: KeyEvent) => void): void {
  const store = useStoreInstance();
  useKeyboard((key) => {
    const s = store.getState();
    if (s.sheet || s.inputFocused || key.super) return;
    handler(key);
  });
}

/** What a screen contributes to the shared header/dock. Each is a component so it can read the store. */
export interface Chrome {
  /** Right end of the header row (e.g. `8 PRs · updated 14s ago`). */
  HeaderRight: ComponentType;
  /** Dock left: status text / merge status. */
  DockLeft: ComponentType;
  /** Dock right: key hints or action pills. */
  DockRight: ComponentType;
}

// ---------- vim navigation ----------

export interface VimNavOptions {
  count: number;
  cursor: number;
  setCursor(n: number): void;
  /** Visible rows; Ctrl-d/u move half, Ctrl-f/b a full page. */
  pageSize: number;
  enabled: boolean;
  /** Set by sheets themselves; page lists are modal-blocked (no keys) while any sheet or the palette is open. */
  sheet?: boolean;
  /** l / Enter. */
  onOpen?(): void;
  /** h. */
  onBack?(): void;
  /** Sorted item indices where sections begin; `{` / `}` jump between them. */
  sectionStarts?: number[];
  /** When set, ↑/↓ call this (with the count) instead of moving the cursor; only j/k move it. */
  onArrow?(dir: "up" | "down", times: number): void;
}

const GG_MS = 500;

/**
 * vim list motions: j/k/↓/↑, gg, G, Ctrl-d/u, Ctrl-f/b, l/Enter (open), h (back), {/} (sections),
 * numeric prefixes (5j, 12G). Inactive while `enabled` is false or a text input has focus. `onArrow` takes ↑/↓ over.
 * Handles the keys but does not preventDefault; one list per screen should call it.
 */
export function useVimNav(opts: VimNavOptions): void {
  const store = useStoreInstance();
  const latest = useRef(opts);
  latest.current = opts;
  const pending = useRef({ digits: "", g: 0 });

  useKeyboard((key) => {
    const o = latest.current;
    if (!o.enabled || store.getState().inputFocused) return;
    if (!o.sheet && store.getState().sheet) return;
    const st = pending.current;
    const last = o.count - 1;
    const go = (n: number) => {
      if (o.count === 0) return;
      const c = Math.max(0, Math.min(last, n));
      latest.current = { ...o, cursor: c };
      o.setCursor(c);
    };
    const name = key.name;
    const seq = key.sequence;

    // count prefix (0 only continues an existing count)
    if (!key.ctrl && !key.meta && seq.length === 1 && seq >= "0" && seq <= "9" && (seq !== "0" || st.digits)) {
      st.digits += seq;
      st.g = 0;
      return;
    }
    const n = st.digits ? Number(st.digits) : 0;
    const times = n || 1;
    const clear = () => {
      st.digits = "";
      st.g = 0;
    };
    const half = Math.max(1, Math.floor(o.pageSize / 2));
    const page = Math.max(1, o.pageSize - 1);

    if (key.ctrl) {
      if (name === "d") go(o.cursor + half * times);
      else if (name === "u") go(o.cursor - half * times);
      else if (name === "f") go(o.cursor + page * times);
      else if (name === "b") go(o.cursor - page * times);
      clear();
      return;
    }
    if (key.meta) return clear();

    if (name === "g" && !key.shift && seq === "g") {
      if (Date.now() - st.g < GG_MS) {
        go(n ? n - 1 : 0);
        return clear();
      }
      st.g = Date.now();
      return;
    }
    if (seq === "G") {
      go(n ? n - 1 : last);
      return clear();
    }
    if (o.onArrow && (name === "up" || name === "down")) o.onArrow(name, times);
    else if (name === "j" || name === "down") go(o.cursor + times);
    else if (name === "k" || name === "up") go(o.cursor - times);
    else if (name === "l" || name === "return") o.onOpen?.();
    else if (name === "h") o.onBack?.();
    else if (seq === "}" || seq === "{") {
      const starts = o.sectionStarts ?? [];
      let c = o.cursor;
      for (let i = 0; i < times; i++) {
        const nxt = seq === "}" ? starts.find((x) => x > c) : [...starts].reverse().find((x) => x < c);
        if (nxt === undefined) break;
        c = nxt;
      }
      go(c);
    }
    clear();
  });
}

export interface VimSearch {
  /** Current (or last committed) query. */
  query: string;
  /** True while the search line is shown and focused. */
  active: boolean;
  open(): void;
  setQuery(q: string): void;
  commit(): void;
  cancel(): void;
  /** Case-insensitive substring match; true for an empty query. */
  matches(text: string): boolean;
  next(): void;
  prev(): void;
  /** Override the match info shown in the dock (screens that filter instead of jump). */
  setInfo(info: string): void;
}

/** The search line the dock shows in place of the key hints (published by the active `useVimSearch`). */
export interface SearchLine {
  query: string;
  active: boolean;
  /** Right-aligned info, e.g. `3/12`. */
  info: string;
  onInput(q: string): void;
  /** Leading glyph, `/` by default (`:` for the palette). */
  prefix?: string;
  /** Dock row-2 hint while typing. */
  hint?: string;
  placeholder?: string;
}

/**
 * `/` opens the search line (shown by the dock, bottom-left), Esc cancels (clears), Enter commits; `n`/`N` jump to
 * the next/previous match when `count/cursor/setCursor/textAt` are given (list screens). Sets inputFocused while
 * typing so global keys and nav are suspended.
 */
export function useVimSearch(opts: { enabled?: boolean; count?: number; cursor?: number; setCursor?(n: number): void; textAt?(i: number): string } = {}): VimSearch {
  const store = useStoreInstance();
  const owner = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(false);
  const [info, setInfo] = useState("");
  const latest = useRef({ opts, query, active });
  latest.current = { opts, query, active };

  const matches = (text: string) => !query || text.toLowerCase().includes(query.toLowerCase());
  const jump = (dir: 1 | -1) => {
    const { opts: o, query: q } = latest.current;
    if (!q || !o.textAt || !o.setCursor || !o.count) return;
    const cur = o.cursor ?? 0;
    for (let step = 1; step <= o.count; step++) {
      const i = (((cur + dir * step) % o.count) + o.count) % o.count;
      if (o.textAt(i).toLowerCase().includes(q.toLowerCase())) return o.setCursor(i);
    }
  };
  const open = () => {
    setQuery("");
    setActive(true);
    store.setInputFocused(true);
  };
  const close = (keep: boolean) => {
    if (!keep) setQuery("");
    setActive(false);
    store.setInputFocused(false);
  };

  useKeyboard((key) => {
    const { opts: o, active: typing } = latest.current;
    if (typing) {
      if (key.name === "escape") close(false);
      else if (key.name === "return") {
        close(true);
        jump(1);
      }
      return;
    }
    if (o.enabled === false || store.getState().inputFocused) return;
    if (key.ctrl || key.meta) return;
    if (key.sequence === "/") open();
    else if (key.sequence === "n") jump(1);
    else if (key.sequence === "N") jump(-1);
  });

  // `cur/total` for jump-style searches: matches up to the cursor over all matches.
  let auto = "";
  if (query && opts.textAt && opts.count) {
    const lq = query.toLowerCase();
    const cursor = opts.cursor ?? -1;
    let total = 0;
    let upTo = 0;
    for (let i = 0; i < opts.count; i++) {
      if (!opts.textAt(i).toLowerCase().includes(lq)) continue;
      total++;
      if (i <= cursor) upTo = total;
    }
    auto = total ? `${upTo}/${total}` : "no match";
  }
  const shown = auto || info;

  useEffect(() => {
    store.setSearchLine(owner, active || query ? { query, active, info: shown, onInput: setQuery } : null);
  }, [store, owner, active, query, shown]);
  useEffect(() => () => store.setSearchLine(owner, null), [store, owner]);

  return { query, active, open, setQuery, commit: () => close(true), cancel: () => close(false), matches, next: () => jump(1), prev: () => jump(-1), setInfo };
}

/** Dock row 1 while a line is being typed (`/` search, `:` palette): the input replaces the status text. */
export function DockInput({ line }: { line: SearchLine }) {
  const p = useTheme();
  // The owner's query is written into the input here rather than through a `value` prop: OpenTUI emits `input` for a
  // programmatic write too, before React swaps the `onInput` listener, so a prop write echoed into the previous
  // handler during the commit. `writing` marks exactly our own writes; every user event is forwarded, even one that
  // happens to equal a query the owner has not re-published yet.
  const ref = useRef<InputRenderable>(null);
  const writing = useRef(false);
  const latest = useRef(line);
  latest.current = line;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || el.value === line.query) return;
    writing.current = true;
    try {
      el.value = line.query;
    } finally {
      writing.current = false;
    }
  }, [line.query]);
  const onInput = useRef((v: string) => {
    if (!writing.current) latest.current.onInput(v);
  }).current;
  return (
    <box height={1} flexDirection="row" flexGrow={1}>
      <box flexShrink={0}><text fg={p.ink} wrapMode="none">{line.prefix ?? "/"}</text></box>
      <input ref={ref} focused onInput={onInput} placeholder={line.placeholder} backgroundColor={p.ground} textColor={p.ink} flexGrow={1} />
    </box>
  );
}

/** Dock row 1 default: the muted command/search hint. */
export function DockCommands() {
  const p = useTheme();
  return <text fg={p.muted} wrapMode="none" truncate>{": commands · / search"}</text>;
}

/** Dock row 2 left while a line exists: the mode hint when typing, `/query` once a search is committed. */
export function DockModeHint({ line }: { line: SearchLine }) {
  const p = useTheme();
  const text = line.active ? (line.hint ?? "n/N next · esc") : `${line.prefix ?? "/"}${line.query}`;
  return <text fg={p.muted} wrapMode="none" truncate>{text}</text>;
}

/** Dock row 2 right: count/info of the active line (`31 loaded`, `3/12`). */
export function DockCount({ line }: { line: SearchLine }) {
  const p = useTheme();
  return <text fg={p.muted} wrapMode="none">{line.info}</text>;
}

/** Vim keys for the help sheet: [key, description]. */
export const VIM_HELP: [string, string][] = [
  ["j k / ↓ ↑", "move (5j = count)"],
  ["gg G", "top / bottom (12G = line)"],
  ["ctrl-d ctrl-u", "half page down / up"],
  ["ctrl-f ctrl-b", "page down / up"],
  ["l ⏎", "open"],
  ["h esc ⌫", "back"],
  ["{ }", "previous / next section"],
  ["/ n N", "search, next, previous match"],
  ["]f [f", "next / previous file (diff)"],
  ["]c [c", "next / previous hunk (diff)"],
  ["za zo zc", "toggle / open / close fold"],
  ["r  ?  q", "refresh, help, quit"],
];
