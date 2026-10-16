/**
 * PR page: header, blockers, chronological Activity, lazy commit/check history, current-head checks, changed files, diff, stack band;
 * merge bar in the dock via `prChrome`. Diffs and commit history load only when opened.
 *
 * Keys (list): j/k/gg/G/ctrl-d/u/f/b/counts/{ }/l/Enter via useVimNav (Enter toggles expand/collapse); ↑/↓ scroll the page and never change the selection; / n N search; c reply, e resolve, F fix with agent, B bots, L low-signal, o open comment url, z{a,o,c,R,M} folds,
 * a/x/C review, m/M merge, t method, S stack, w worktree. Keys (diff open): j/k/gg/G/ctrl-* scroll, ]c [c hunks, ]f [f files,
 * s split, za/zo/zc fold, Esc/h close.
 */
import type { DiffRenderable, MouseEvent as TuiMouseEvent, ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Fragment, createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { ReviewThread } from "../github";
import type { PrDetail } from "../service";
import { isWaitable } from "../watch";
import { nativeUpTo, type Blocker, type CheckState, type ConversationEntry, type MergeMethod } from "../types";
import { activityId, activityLayout, activityMeta, bodyRows, defaultLevel, foldBots, groupActivity, lowSignalTag, rowsHeight, type ActivityItem, type BotFold, type Level, type RL } from "./activity";
import { imagesVersion, peekImage, subscribeImages } from "../images";
import { layoutBlocks, parseComment, preview, threadFix, type ImageEnv, type Span } from "./markdown";
import { jobDockText, type Job } from "../jobs";
import { diffKey, mergeMethodOf, runningJobOf, useStore, useStoreInstance, type Store } from "./store";
import { checkSummary, currentChecks, type CurrentCheck } from "./pr-checks";
import { CommitCheckRow, CommitRow, commitColumns, useCommitHistory, type HistoryItem } from "./pr-history";
import { G, SPACE, clip, lerpHex, personColor, useLayout, useTheme, type Palette } from "./theme";
import { Clipped, ErrorState, Loading, Pill, Rule, Scroll, StatusGlyph, Txt, toneColor, useScreenKeys, useScrollFollow, useVimNav, useVimSearch, type Chrome, type Tone } from "./ui";

/** True while the PR page owns Esc / h (an open diff or reply input); app.tsx must not navigate back then. */
let captures = false;
export const prCapturesBack = (): boolean => captures;

// ---------- blockers ----------

interface Desc {
  glyph: "fail" | "pending";
  label: string;
  detail: string;
  short: string;
  /** Resolves by itself (stack merge), so docks show it muted rather than as a failure. */
  soft?: boolean;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const names = (xs: string[]) => (xs.length > 1 ? `${xs[0]} +${xs.length - 1}` : (xs[0] ?? ""));

function parentOf(d: PrDetail): number | null {
  if (!d.stack) return null;
  const i = d.stack.prs.indexOf(d.pr.number);
  return i > 0 ? d.stack.prs[i - 1]! : null;
}

function describe(b: Blocker, d: PrDetail): Desc {
  switch (b.kind) {
    case "checks":
      return b.failing.length
        ? { glyph: "fail", label: "Check failing", detail: names(b.failing), short: "checks failing" }
        : { glyph: "pending", label: "Check running", detail: names(b.pending), short: "checks running" };
    case "review":
      return b.decision === "CHANGES_REQUESTED"
        ? { glyph: "fail", label: "Changes requested", detail: "", short: "changes requested" }
        : { glyph: "pending", label: "Review required", detail: "", short: "review required" };
    case "threads":
      return { glyph: "fail", label: `${plural(b.count, "unresolved thread")}`, detail: "", short: `${plural(b.count, "thread")} open` };
    case "draft":
      return { glyph: "pending", label: "Draft", detail: "mark ready for review", short: "draft" };
    case "conflict":
      return { glyph: "fail", label: `Conflicts with ${b.base ?? "base"}`, detail: "resolve locally and push", short: `conflicts with ${b.base ?? "base"}` };
    case "behind":
      return {
        glyph: "pending",
        label: b.count === null ? `Behind ${b.base}` : `${plural(b.count, "commit")} behind ${b.base}`,
        detail: "U updates the branch",
        short: `behind ${b.base}`,
      };
    case "checking":
      return { glyph: "pending", label: `Checking for conflicts${G.ellipsis}`, detail: "GitHub is computing mergeability", short: "checking for conflicts" };
    case "required-check":
      return { glyph: "pending", label: `Required check '${b.context}'`, detail: "hasn't run on this head", short: `required check '${b.context}' hasn't run` };
    case "blocked":
      return {
        glyph: "fail",
        label: "Blocked by repository rules",
        detail: b.codeOwner ? "code owner review may be missing · M bypasses" : "M bypasses as admin",
        short: "blocked by repository rules",
      };
    case "base-not-trunk": {
      const o = b.owner;
      if (o?.state === "MERGED") {
        return { glyph: "pending", label: `Base #${o.number} merged`, detail: ":rebase-stack", short: `base #${o.number} merged ${G.sep} rebase stack` };
      }
      const parent = o?.state === "OPEN" ? o.number : parentOf(d);
      if (parent !== null) return { glyph: "pending", label: `Waiting on #${parent}`, detail: "merge the stack", short: `waiting on #${parent}`, soft: true };
      const trunk = d.stack?.trunk ?? "trunk";
      return { glyph: "pending", label: `Base is ${b.base}`, detail: `not ${trunk} ${G.sep} :base to retarget`, short: `base is ${b.base}, not ${trunk}` };
    }
  }
}

function mergeInfo(d: PrDetail) {
  const descs = d.blockers.map((b) => describe(b, d));
  const parent = parentOf(d);
  const stackOnly = d.blockers.length > 0 && d.blockers.every((b) => b.kind === "base-not-trunk") && parent !== null;
  return { descs, parent, stackOnly, blocked: d.blockers.length > 0, closed: d.pr.state !== "OPEN" };
}

// ---------- actions shared by keys and pills ----------

let armed: { n: number; at: number } | null = null;

function mergeAction(store: Store, d: PrDetail) {
  const info = mergeInfo(d);
  const n = d.pr.number;
  const method = mergeMethodOf(store.getState());
  if (info.closed) return void store.toast(`#${n} is ${d.pr.state.toLowerCase()}`);
  // a native member above the bottom cannot merge alone: its merge lands the downstack, so it is a stack merge up to here
  if (nativeUpTo(d.stack, n) !== null) return store.openSheet({ kind: "stack", n, upTo: n });
  if (info.stackOnly) return stackAction(store, d);
  // blocked only by what clears by itself (pending checks, review...): the merge sheet offers to wait for it
  if (info.blocked && isWaitable(d.blockers)) return store.openSheet({ kind: "merge", n });
  if (info.blocked) return void store.toast(`Can’t merge: ${info.descs.map((x) => x.short).join(` ${G.sep} `)} ${G.sep} M force merges`, "error");
  if (armed && armed.n === n && Date.now() - armed.at < 3000) {
    armed = null;
    void store.startMerge(n, method, false).then((o) => o.ok && store.toast(`Merging #${n} in the background`));
    return;
  }
  armed = { n, at: Date.now() };
  store.toast(`Press m again to ${method}-merge #${n}`);
}

function forceAction(store: Store, d: PrDetail) {
  const n = d.pr.number;
  const method = mergeMethodOf(store.getState());
  if (d.pr.state !== "OPEN") return void store.toast(`#${n} is ${d.pr.state.toLowerCase()}`);
  if (d.blockers.length === 0) return void store.toast("Nothing to bypass · m merges");
  // bypassing happens in the stack sheet (force toggle) for a member that cannot merge alone
  if (nativeUpTo(d.stack, n) !== null) return store.openSheet({ kind: "stack", n, upTo: n });
  const sheet = { kind: "force" as const, n, method };
  store.openSheet(sheet);
}

const canUpdate = (d: PrDetail) => d.pr.state === "OPEN" && d.blockers.some((b) => b.kind === "behind") && !d.blockers.some((b) => b.kind === "conflict");

/** `U`: merge the base into the branch; only offered when GitHub reports it behind and not conflicting. */
function updateBranchAction(store: Store, d: PrDetail) {
  const n = d.pr.number;
  if (d.pr.state !== "OPEN") return void store.toast(`#${n} is ${d.pr.state.toLowerCase()}`);
  if (d.blockers.some((b) => b.kind === "conflict")) return void store.toast("Conflicts with the base: resolve them locally", "error");
  if (!d.blockers.some((b) => b.kind === "behind")) return void store.toast("Branch is up to date");
  void store.prAction(n, "update-branch", d.repo);
}

/** `#2411 → #2413, #2414`: where a classic chain splits into a tree (null when it is one line). */
function forkText(d: PrDetail): string | null {
  const forks = d.stack?.forks ?? [];
  return forks.length ? forks.map((f) => `#${f.parent} → ${f.children.map((c) => `#${c}`).join(", ")}`).join(`; `) : null;
}

function stackAction(store: Store, d: PrDetail) {
  if (!d.stack) return void store.toast("Not part of a stack");
  if (d.pr.state !== "OPEN") return void store.toast(`#${d.pr.number} is ${d.pr.state.toLowerCase()}`);
  // a native stack merges along its own line even when a classic branch forks off it; a classic tree has no line to merge
  const forks = forkText(d);
  if (forks && !d.stack.native) return void store.toast(`The chain forks (${forks}): merge or retarget one branch first`, "error");
  store.openSheet({ kind: "stack", n: d.pr.number });
}

// ---------- text helpers ----------

/** Greedy word wrap to `w` cells; keeps blank lines, hard-splits long words. */
function wrap(text: string, w: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").replace(/\t/g, "  ").split("\n")) {
    if (!para.trim()) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    const lead = /^\s*/.exec(para)![0];
    let line = "";
    for (let word of para.trim().split(/\s+/)) {
      while (word.length > w) {
        if (line) out.push(line);
        out.push(word.slice(0, w));
        word = word.slice(w);
        line = "";
      }
      if (!line) line = (out.length === 0 || !lead ? "" : lead.slice(0, 4)) + word;
      else if (line.length + 1 + word.length <= w) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    if (line) out.push(line);
  }
  while (out.length && !out[out.length - 1]) out.pop();
  return out;
}

function age(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return `${Math.floor(s / (86400 * 30))}mo`;
}

const MINUS = process.env.STK_ASCII === "1" ? "-" : "−";
/** 999 -> `999`, 12400 -> `12k`. */
const num = (n: number) => (n >= 1000 ? `${n >= 10000 ? Math.round(n / 1000) : Math.round(n / 100) / 10}k` : String(n));

/** Open a URL in the default browser. Spawns directly (never an OSC 8 link: the Tern plugin routes GitHub PR links back into stk). `STK_OPEN` overrides the opener. */
export function openUrl(url: string) {
  const opener = process.env.STK_OPEN ?? (process.platform === "darwin" ? "open" : "xdg-open");
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no opener available */
  }
}

export function openInBrowser(store: Store, url: string) {
  openUrl(url);
  store.toast("Opened in browser");
}

/**
 * Text of the rows `<diff>` renders for a patch (one entry per row): headers and `@@` lines are not drawn; split view pairs -/+ runs.
 * Row indices match the renderable, so they double as scroll offsets for search.
 */
function diffLines(patch: string, view: "unified" | "split"): string[] {
  const rows: string[] = [];
  let del: string[] = [];
  let add: string[] = [];
  let inHunk = false;
  const flush = () => {
    if (view === "split") for (let i = 0; i < Math.max(del.length, add.length); i++) rows.push(`${del[i] ?? ""} ${add[i] ?? ""}`);
    else rows.push(...del, ...add);
    del = [];
    add = [];
  };
  for (const l of patch.split("\n")) {
    if (l.startsWith("@@")) {
      flush();
      inHunk = true;
    } else if (!inHunk) continue;
    else if (l.startsWith("-")) del.push(l.slice(1));
    else if (l.startsWith("+")) add.push(l.slice(1));
    else if (l.startsWith("\\")) continue;
    else {
      flush();
      if (l !== "") rows.push(l.slice(1));
    }
  }
  flush();
  return rows;
}

/** Plain text of a comment body as rendered (markdown cleaned), for searching; `details` includes collapsed `<details>` content. */
function plainBody(body: string, details = true): string {
  const c = parseComment(body);
  const lines = layoutBlocks(c.blocks, 400, { details, measure: Infinity, previews: true }).map((spans) => spans.map((s) => s.text).join(""));
  return `${preview(c)}\n${lines.join("\n")}`;
}

/** File order: per directory level, folders first, then files; each alphabetical. */
function byTree(a: { path: string }, b: { path: string }): number {
  const x = a.path.split("/");
  const y = b.path.split("/");
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    const xDir = i < x.length - 1;
    const yDir = i < y.length - 1;
    if (xDir !== yDir) return xDir ? -1 : 1;
    return x[i]!.localeCompare(y[i]!);
  }
  return x.length - y.length;
}

type BadgePr = { state: "OPEN" | "CLOSED" | "MERGED"; isDraft: boolean };
/** Badge text; the stack list sizes its badge column from it. */
const badgeLabel = (pr: BadgePr) => (pr.state === "MERGED" ? "Merged" : pr.state === "CLOSED" ? "Closed" : pr.isDraft ? "Draft" : "Open");

/** GitHub-style state badge: solid pill, white bold text. */
function StateBadge({ pr }: { pr: BadgePr }) {
  const p = useTheme();
  const label = badgeLabel(pr);
  const bg = pr.state === "MERGED" ? p.merged : pr.state === "CLOSED" ? p.closed : pr.isDraft ? p.draft : p.open;
  return (
    <box flexDirection="row" flexShrink={0}>
      <text fg="#FFFFFF" bg={bg} wrapMode="none">
        <strong>{` ${label} `}</strong>
      </text>
      <text wrapMode="none">{" "}</text>
    </box>
  );
}

/** Check glyph: pass ✓ green, fail × red, pending ● amber, skipped/none muted. */
function CheckGlyph({ state }: { state: "pass" | "fail" | "pending" | "skipped" | "none" | "merged" }) {
  const p = useTheme();
  const [ch, fg] =
    state === "merged" ? [G.check, p.merged] : state === "pass" ? [G.check, p.ok] : state === "fail" ? [G.cross, p.error] : state === "pending" ? [G.dot, p.warn] : state === "skipped" ? [G.ring, p.muted] : [" ", p.muted];
  return <text fg={fg}>{ch}</text>;
}

// ---------- small views ----------

function T({ tone = "ink", bold, sel, children }: { tone?: Tone; bold?: boolean; sel?: boolean; children?: ReactNode }) {
  const p = useTheme();
  return (
    <text fg={toneColor(p, tone, sel)} wrapMode="none">
      {bold ? <strong>{children}</strong> : children}
    </text>
  );
}

/**
 * The press in progress on the PR page. A text-selection drag sends drag events only to the row under the pointer (and no `out`
 * events), so the pressed item can't see a drag that leaves it; `trackPress` runs on the scroll area, where every drag bubbles.
 */
let press: { x: number; y: number; dragged: boolean; owner: object; armed: boolean } | null = null;
const trackPress = (e: TuiMouseEvent) => {
  if (press && (Math.abs(press.x - e.x) > 1 || press.y !== e.y)) press.dragged = true;
};

/**
 * Mouse handlers for a cursor item. Pressing moves the cursor there; a click on the item already under the cursor opens it at once.
 * A click is a press and release with the pointer never more than one cell from the press (a stray one-cell selection is cleared):
 * moving further marks the press as a drag even if it comes back (`trackPress`), so a drag never opens anything. `body` also rejects
 * a release that leaves text selected (the second press of a double click, which selects a word), so a header's quick second click
 * still opens. `stop` keeps a header row's handling from reaching its block.
 */
function useClick(selected: boolean, onSelect?: () => void, onOpen?: () => void, opts: { body?: boolean; stop?: boolean } = {}) {
  const renderer = useRenderer();
  /** Identity of this item's handlers: a release counts only for the item that took the press. */
  const me = useRef({});
  return {
    onMouseDown: (e: TuiMouseEvent) => {
      if (opts.stop) e.stopPropagation();
      press = { x: e.x, y: e.y, dragged: false, owner: me.current, armed: selected };
      if (!selected) onSelect?.();
    },
    onMouseUp: (e: TuiMouseEvent) => {
      if (opts.stop) e.stopPropagation();
      const d = press;
      if (!d || d.owner !== me.current) return;
      press = null;
      if (!d.armed || d.dragged || !onOpen || Math.abs(d.x - e.x) > 1 || d.y !== e.y) return;
      // More text selected than the cells crossed (a one-cell slip selects both ends) is a word/line selection, not a click.
      const sel = renderer.getSelection();
      if (opts.body && (sel?.getSelectedText() ?? "").length > Math.abs(d.x - e.x) + 1) return;
      if (sel) renderer.clearSelection();
      onOpen();
    },
  };
}

/**
 * Selectable block: selection = `sel` fill over all its lines, bleeding into the gutter (lives inside <Scroll>). `mark` draws an accent bar in the left bleed.
 * Clicks: see `useClick`; `current` (the item is under the cursor, default `selected`) arms them when the fill is drawn elsewhere (a header-only highlight).
 * Single-line rows take the board's hover wash; multi-line blocks (comment bodies) stay plain so the page doesn't flash while the pointer crosses it.
 */
function Sel({
  selected,
  current = selected,
  h,
  onSelect,
  onOpen,
  body,
  stop,
  mark,
  children,
}: {
  selected: boolean;
  current?: boolean;
  h: number;
  onSelect?: () => void;
  onOpen?: () => void;
  body?: boolean;
  stop?: boolean;
  mark?: boolean;
  children: ReactNode;
}) {
  const p = useTheme();
  const click = useClick(current, onSelect, onOpen, { body, stop });
  const [hover, setHover] = useState(false);
  const hoverable = h === 1;
  return (
    <box
      flexDirection="column"
      flexShrink={0}
      height={h}
      backgroundColor={selected ? p.sel : hover && hoverable ? p.wash : p.ground}
      marginLeft={-SPACE.bleed}
      marginRight={-SPACE.bleed}
      paddingLeft={SPACE.bleed}
      paddingRight={SPACE.bleed}
      {...click}
      onMouseOver={hoverable ? () => setHover(true) : undefined}
      onMouseOut={hoverable ? () => setHover(false) : undefined}
    >
      {mark && (
        <box position="absolute" left={0} top={0} height={h}>
          <text fg={p.cobalt}>{G.mark}</text>
        </box>
      )}
      {children}
    </box>
  );
}

/** Left text (truncating) + right-aligned text on one row. */
function Split({ left, right }: { left: ReactNode; right?: ReactNode }) {
  return (
    <box height={1} flexDirection="row" flexShrink={0}>
      <box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
        {left}
      </box>
      {right !== undefined && (
        <box flexShrink={0} marginLeft={2}>
          {right}
        </box>
      )}
    </box>
  );
}

/** Section label (UPPERCASE, faint leader, right meta); the leader has basis 0 so a long rule never pushes the meta off-screen. */
function Label({ label, meta }: { label: string; meta?: ReactNode }) {
  const p = useTheme();
  return (
    <box height={1} flexDirection="row" flexShrink={0} overflow="hidden">
      <text fg={p.muted}>{label.toUpperCase()}</text>
      <box flexGrow={1} flexShrink={1} flexBasis={0} height={1} overflow="hidden" marginLeft={1} marginRight={1}>
        <text fg={p.faint} wrapMode="none">
          {G.leader.repeat(300)}
        </text>
      </box>
      {meta !== undefined && <text fg={p.muted}>{meta}</text>}
    </box>
  );
}

/** Clickable header text: plain until hovered, then cobalt + underline. Opens the PR in the browser. */
function PrLink({ label, muted, onPress }: { label: string; muted?: boolean; onPress: () => void }) {
  const p = useTheme();
  const [hover, setHover] = useState(false);
  return (
    <box flexShrink={0} height={1} onMouseDown={onPress} onMouseOver={() => setHover(true)} onMouseOut={() => setHover(false)}>
      <text fg={hover ? p.cobalt : muted ? p.muted : p.ink} wrapMode="none">
        {hover ? <u>{label}</u> : label}
      </text>
    </box>
  );
}

function Bar({ children }: { children?: ReactNode }) {
  const p = useTheme();
  return (
    <box height={1} flexDirection="row" flexShrink={0}>
      <text fg={p.rule}>{`${G.vbar} `}</text>
      <box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
        {children}
      </box>
    </box>
  );
}

// ---------- conversation + threads ----------

const DESC_CAP = 8;

const locOf = (th: ReviewThread) => (th.path ? `${th.path}${th.line ? `:${th.line}` : ""}` : "General");

function pillColor(p: Palette, label: string): string {
  const t = label.trim();
  if (/^P[01]$|changes requested/.test(t)) return p.error;
  if (t === "approved") return p.ok;
  if (/^P2$/.test(t)) return p.ink;
  return p.muted;
}

/** Active search query; matching text is painted with a wash. */
const QueryCtx = createContext("");

/** Split spans so every case-insensitive occurrence of `q` becomes its own highlighted span. */
function markSpans(spans: Span[], q: string): (Span & { hl?: boolean })[] {
  if (!q) return spans;
  const needle = q.toLowerCase();
  const out: (Span & { hl?: boolean })[] = [];
  for (const s of spans) {
    const hay = s.text.toLowerCase();
    let at = 0;
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, at)) {
      if (i > at) out.push({ ...s, text: s.text.slice(at, i) });
      out.push({ ...s, text: s.text.slice(i, i + needle.length), hl: true });
      at = i + needle.length;
    }
    out.push(at ? { ...s, text: s.text.slice(at) } : s);
  }
  return out;
}

/** `accent` colours `author` spans (a person's name); `rail` colours `rail` spans. */
function SpanText({ spans, tone = "ink", sel, truncate, accent, rail }: { spans: Span[]; tone?: Tone; sel?: boolean; truncate?: boolean; accent?: string; rail?: string }) {
  const p = useTheme();
  const q = useContext(QueryCtx);
  const hlBg = lerpHex(p.ground, p.cobalt, 0.3);
  return (
    <text fg={toneColor(p, tone, sel)} wrapMode="none" truncate={truncate}>
      {markSpans(spans, q).map((s, i) => {
        const bg = s.hl ? hlBg : undefined;
        switch (s.style) {
          case "bold":
            return (
              <strong key={i} bg={bg}>
                {s.text}
              </strong>
            );
          case "author":
            return (
              <strong key={i} fg={accent ?? toneColor(p, tone, sel)} bg={bg}>
                {s.text}
              </strong>
            );
          case "rail":
            return (
              <span key={i} fg={rail ?? p.faint} bg={bg}>
                {s.text}
              </span>
            );
          case "add":
          case "del":
            return (
              <span key={i} fg={s.style === "add" ? p.ok : p.error} bg={bg}>
                {s.text}
              </span>
            );
          case "link":
            return (
              <span key={i} fg={p.cobalt} bg={bg}>
                <u>{s.text}</u>
              </span>
            );
          case "code":
            return (
              <span key={i} fg={p.ink} bg={bg ?? p.wash}>
                {s.text}
              </span>
            );
          case "subhead":
            return (
              <strong key={i} fg={lerpHex(p.ink, p.muted, 0.45)} bg={bg}>
                {s.text}
              </strong>
            );
          case "muted":
            return (
              <span key={i} fg={toneColor(p, "muted", sel)} bg={bg}>
                {s.text}
              </span>
            );
          case "warn":
            return (
              <span key={i} fg={p.warn} bg={bg}>
                {s.text}
              </span>
            );
          case "pill":
            return (
              <span key={i} fg={pillColor(p, s.text)} bg={bg ?? p.wash}>
                {s.text}
              </span>
            );
          default:
            return (
              <span key={i} bg={bg}>
                {s.text}
              </span>
            );
        }
      })}
    </text>
  );
}

interface Reply {
  id: string;
  value: string;
}

/**
 * Rows of one comment/thread: 2-col left pad, right pad via `bodyWidth`. The selection fill spans the block, or only the head row when `headOnly` (long bodies keep ground contrast).
 * `accent` is the person's colour: their name, and a dimmed rail in the left pad of `rail` rows. Only the head row opens on click; body text is free to select.
 */
function RowsView({
  rows,
  selected,
  muted,
  headOnly,
  accent,
  reply,
  onInput,
  onSelect,
  onOpen,
}: {
  rows: RL[];
  selected: boolean;
  muted?: boolean;
  headOnly?: boolean;
  accent?: string;
  reply?: Reply | null;
  onInput?: (v: string) => void;
  onSelect: () => void;
  onOpen?: () => void;
}) {
  const p = useTheme();
  const bodySel = selected && !headOnly;
  const rail = accent ? lerpHex(accent, p.ground, 0.4) : p.faint;
  const headClick = useClick(selected, onSelect, onOpen, { stop: true });
  return (
    <Sel selected={bodySel} current={selected} h={rowsHeight(rows)} onSelect={onSelect} onOpen={onOpen} body>
      {rows.map((r, i) => {
        switch (r.t) {
          case "head": {
            const split = (
              <Split
                left={<SpanText spans={r.left} tone={muted || r.muted ? "muted" : "ink"} sel={selected} accent={accent} rail={rail} />}
                right={r.right ? <T tone="muted" sel={selected}>{r.right}</T> : undefined}
              />
            );
            return headOnly ? (
              <Sel key={i} selected={selected} h={1} onSelect={onSelect} onOpen={onOpen} stop>
                {split}
              </Sel>
            ) : (
              <box key={i} height={1} flexShrink={0} {...headClick}>
                {split}
              </box>
            );
          }
          case "text":
            return (
              <box key={i} height={1} flexShrink={0} overflow="hidden" flexDirection="row" paddingLeft={r.rail ? (r.indent ?? 0) : 2}>
                {r.rail && (
                  <text fg={rail} selectable={false} wrapMode="none">
                    {"│ "}
                  </text>
                )}
                <SpanText spans={r.spans} tone={muted ? "muted" : "ink"} sel={bodySel} accent={accent} rail={rail} />
              </box>
            );
          case "image": {
            const img = peekImage(r.src);
            return (
              <box key={i} height={r.rows} flexShrink={0} flexDirection="row" paddingLeft={r.rail ? (r.railIndent ?? 0) : 2}>
                {r.rail && (
                  <text fg={rail} selectable={false} wrapMode="none">
                    {Array.from({ length: r.rows }, () => "│ ").join("\n")}
                  </text>
                )}
                {img.status === "ready" && <image source={img.data} fit="fill" protocol="auto" width={r.cols} height={r.rows} marginLeft={r.indent} flexShrink={0} />}
              </box>
            );
          }
          case "gap":
            return r.rail ? (
              <box key={i} height={1} flexShrink={0} paddingLeft={r.indent ?? 0}>
                <text fg={rail} selectable={false} wrapMode="none">
                  {"│"}
                </text>
              </box>
            ) : (
              <box key={i} height={1} flexShrink={0} />
            );
          case "input":
            return (
              <box key={i} height={1} flexShrink={0} paddingLeft={2} onMouseDown={(e) => e.stopPropagation()} onMouseUp={(e) => e.stopPropagation()}>
                <input
                  focused
                  value={reply?.value ?? ""}
                  placeholder={`Reply${G.ellipsis}  ⌘⏎ send ${G.sep} esc cancel`}
                  onInput={onInput}
                  backgroundColor={p.wash}
                  focusedBackgroundColor={p.wash}
                  textColor={p.ink}
                  focusedTextColor={p.ink}
                  placeholderColor={p.faint}
                  flexGrow={1}
                />
              </box>
            );
        }
      })}
    </Sel>
  );
}

// ---------- items / blocks ----------

type Item =
  | { id: "desc"; kind: "desc" }
  | { id: string; kind: "convo"; e: ConversationEntry }
  | { id: string; kind: "thread"; th: ReviewThread; nested?: boolean; owner?: string }
  | { id: string; kind: "bots"; fold: BotFold }
  | { id: string; kind: "check"; url: string | null; name: string; state: CheckState }
  | HistoryItem
  | { id: string; kind: "passing" }
  | { id: string; kind: "file"; path: string }
  | { id: "files"; kind: "files" }
  | { id: string; kind: "stack"; n: number };

interface Block {
  key: string;
  h: number;
  node: ReactNode;
  item?: string;
  /** First focusable block of a section: scrolling reveals the label above it. */
  lead?: number;
}

export function Pr({ n }: { n: number }) {
  const res = useStore((s) => s.prs[n]);
  if (res?.status === "error" && !res.data) return <ErrorState title={`Couldn’t load #${n}`} detail={res.error} />;
  if (!res?.data) return <Loading text={`Loading #${n}`} />;
  return <PrBody n={n} d={res.data} />;
}

/** Dock-left status of a running detached merge job: `● merging stack · 2/5` (it keeps running if the TUI closes). */
export function MergeJobStatus({ job }: { job: Job }) {
  return <Txt tone="cobalt" truncate>{`${G.dot} ${jobDockText(job)}`}</Txt>;
}

function PrBody({ n, d }: { n: number; d: PrDetail }) {
  const store = useStoreInstance();
  const p = useTheme();
  const { contentWidth: cw } = useLayout();
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const diffRef = useRef<DiffRenderable>(null);
  const { pr } = d;
  const history = useCommitHistory(n, d.repo);
  const renderer = useRenderer();
  // images arrive after layout: rows are re-derived (and heights re-accounted) whenever one finishes loading
  useSyncExternalStore(subscribeImages, imagesVersion);
  const res = renderer.resolution;
  const images: ImageEnv = { lookup: peekImage, cell: res && renderer.terminalWidth > 0 ? { w: res.width / renderer.terminalWidth, h: res.height / renderer.terminalHeight } : { w: 8, h: 16 } };

  const focus = useStore((s) => (s.screen.kind === "pr" ? s.screen.focus : undefined));
  const [curId, setCurId] = useState<string | null>(focus?.key ?? null);
  const [levels, setLevels] = useState<Map<string, Level>>(new Map());
  const [showBots, setShowBots] = useState(true);
  const [showLow, setShowLow] = useState(true);
  const fixRef = useRef<() => void>(() => {});
  useEffect(
    () =>
      store.onPageCommand((id) => {
        if (id === "fix") return fixRef.current();
        if (id === "toggle-bots") setShowBots((v) => !v);
        else setShowLow((v) => !v);
        store.toast(id === "toggle-bots" ? "Bot comments toggled" : "Noise and minimized toggled");
      }),
    [store],
  );
  const [passingOpen, setPassingOpen] = useState(false);
  const [filesOpen, setFilesOpen] = useState(false);
  const [reply, setReply] = useState<Reply | null>(null);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [view, setView] = useState<"unified" | "split">("unified");
  const [diffFolded, setDiffFolded] = useState(false);
  const diffRes = useStore((s) => (openFile ? s.diffs[diffKey(n, openFile)] : undefined));
  const sheet = useStore((s) => s.sheet);
  const diffPatch = diffRes?.data?.patch;
  const diffText = useMemo(() => (diffPatch ? diffLines(diffPatch, view) : []), [diffPatch, view]);

  // ----- derive -----
  const visibleThreads = showBots ? d.threads : d.threads.filter((t) => t.comments.some((c) => !c.isBot));
  const lowCount = d.conversation.filter((e) => lowSignalTag(e)).length;
  const fresh = showLow ? d.conversation : d.conversation.filter((e) => !lowSignalTag(e));
  const convo = showBots ? fresh : fresh.filter((e) => !e.isBot);
  const activity = groupActivity(convo, visibleThreads);
  const actRows = foldBots(activity);
  /** A fold is open when toggled open, or while the cursor sits on one of its members (search landed there). */
  const inFold = (f: BotFold) => curId !== null && f.members.some((m) => activityId(m) === curId);
  const foldOpen = (f: BotFold) => (levels.get(f.id) ?? 0) > 0 || inFold(f);
  // Keep a fold the cursor was taken into open after the cursor moves on.
  const revealed = actRows.find((r): r is BotFold => r.kind === "bots" && (levels.get(r.id) ?? 0) === 0 && inFold(r))?.id;
  useEffect(() => {
    if (revealed) setLevels((m) => new Map(m).set(revealed, 1));
  }, [revealed]);
  const allActivity = useMemo(() => groupActivity(d.conversation, d.threads), [d]);
  const checks = useMemo(() => currentChecks(d.pr.checks, d.blockers), [d]);
  const failing = checks.filter((c) => c.state === "fail");
  const pending = checks.filter((c) => c.state === "pending");
  const passing = checks.filter((c) => c.state === "pass");
  const skipped = checks.filter((c) => c.state === "skipped");
  const quiet = [...passing, ...skipped];
  const files = [...d.files].sort(byTree);
  const info = mergeInfo(d);

  /** Every searchable item in display order, visible or not (collapsed, hidden bot/low-signal, passing checks). */
  const searchItems = useMemo(() => {
    const out: { item: Item; text: string }[] = [];
    if (pr.body.trim()) out.push({ item: { id: "desc", kind: "desc" }, text: plainBody(pr.body) });
    for (const it of allActivity) {
      const text = it.kind === "convo" ? `${it.e.author}\n${plainBody(it.e.body)}` : `${locOf(it.th)}\n${it.th.comments.map((c) => `${c.author}\n${plainBody(c.body)}`).join("\n")}`;
      out.push({ item: { id: activityId(it), ...it }, text });
    }
    out.push(...history.searchItems);
    const cks = checks;
    const running = [...cks.filter((c) => c.state === "fail"), ...cks.filter((c) => c.state === "pending")];
    const calm = [...cks.filter((c) => c.state === "pass"), ...cks.filter((c) => c.state === "skipped")];
    running.forEach((c, i) => out.push({ item: { id: `c:${i}:${c.name}`, kind: "check", url: c.url, name: c.name, state: c.state }, text: c.name }));
    if (calm.length) out.push({ item: { id: "passing", kind: "passing" }, text: "" });
    calm.forEach((c, i) => out.push({ item: { id: `q:${i}:${c.name}`, kind: "check", url: c.url, name: c.name, state: c.state }, text: c.name }));
    for (const f of [...d.files].sort(byTree)) out.push({ item: { id: `f:${f.path}`, kind: "file", path: f.path }, text: f.path });
    return out;
  }, [d, checks, history.resource?.data]);

  const levelOf = (item: ActivityItem): Level => levels.get(activityId(item)) ?? defaultLevel(item);

  const items: Item[] = [];
  const starts: number[] = [];
  const mark = () => starts.push(items.length);
  const hasDesc = !!pr.body.trim();
  if (hasDesc) {
    mark();
    items.push({ id: "desc", kind: "desc" });
  }
  if (d.stack) {
    mark();
    for (const e of [...d.stack.entries].reverse()) items.push({ id: `s:${e.number}`, kind: "stack", n: e.number });
  }
  if (activity.length) mark();
  for (const r of actRows) {
    if (r.kind !== "bots") items.push({ id: activityId(r), ...r });
    else {
      items.push({ id: r.id, kind: "bots", fold: r });
      if (foldOpen(r)) for (const m of r.members) items.push({ id: activityId(m), ...m });
    }
  }
  mark();
  items.push(...history.items);
  if (failing.length || pending.length || quiet.length) mark();
  [...failing, ...pending].forEach((c, i) => items.push({ id: `c:${i}:${c.name}`, kind: "check", url: c.url, name: c.name, state: c.state }));
  if (quiet.length) {
    items.push({ id: "passing", kind: "passing" });
    if (passingOpen) quiet.forEach((c, i) => items.push({ id: `q:${i}:${c.name}`, kind: "check", url: c.url, name: c.name, state: c.state }));
  }
  if (files.length) {
    mark();
    items.push({ id: "files", kind: "files" });
    if (filesOpen) for (const f of files) items.push({ id: `f:${f.path}`, kind: "file", path: f.path });
  }

  const idx = Math.max(0, items.findIndex((x) => x.id === curId));
  const cur: Item | undefined = items[idx];
  const curKey = cur?.id ?? null;
  /** Cursor highlight: hidden while a sheet or the palette is open. */
  const hlKey = sheet ? null : curKey;

  // ----- actions -----
  const setCursorIdx = (i: number) => setCurId(items[Math.max(0, Math.min(items.length - 1, i))]?.id ?? null);
  const loadFile = (path: string) => {
    setOpenFile(path);
    setDiffFolded(false);
    void store.loadDiff(n, path);
  };
  const setLevel = (id: string, f: (cur: Level) => Level, def: Level) =>
    setLevels((m) => {
      const next = new Map(m);
      next.set(id, f(m.get(id) ?? def));
      return next;
    });
  /** Raise (`+1`), lower (`-1`) or toggle (`0`) the detail level of a comment or thread. */
  const stepLevel = (item: Extract<Item, { kind: "convo" | "thread" }>, how: 1 | -1 | 0) =>
    setLevel(item.id, (c) => (how === 0 ? (c > 0 ? 0 : 2) : (Math.max(0, Math.min(2, c + how)) as Level)), defaultLevel(item));
  /** Description: 1 = capped, 2 = full. */
  const descLevel: Level = levels.get("desc") ?? 1;
  /** `:fix` / F: an omp agent in a new Tern tab fixes the selected review thread or failing check. */
  const fixCur = () => {
    const fp = { number: n, title: pr.title, url: pr.url, headRef: pr.headRef, baseRef: pr.baseRef };
    if (cur?.kind === "thread") return void store.fixWithAgent(fp, { kind: "thread", thread: cur.th }, d.repo);
    if (cur?.kind === "check" && cur.state === "fail") return void store.fixWithAgent(fp, { kind: "check", check: { name: cur.name, state: cur.state, url: cur.url }, log: null }, d.repo);
    store.toast("Select a review thread or a failing check to fix");
  };
  fixRef.current = fixCur;
  const setDescLevel = (l: Level) => setLevel("desc", () => l, 1);
  const startReply = (th: ReviewThread) => {
    setReply({ id: th.id, value: "" });
    store.setInputFocused(true);
  };
  const endReply = () => {
    setReply(null);
    store.setInputFocused(false);
  };
  const submitReply = (v: string) => {
    const body = v.trim();
    const id = reply?.id;
    endReply();
    if (id && body) void store.reply(n, id, body);
  };
  const openCur = () => {
    if (!cur) return;
    follow.anchorItem();
    if (cur.kind === "file") openFile === cur.path ? closeDiff() : loadFile(cur.path);
    else if (cur.kind === "files") setFilesOpen((v) => !v);
    else if (cur.kind === "commits") history.setOpen(!history.open);
    else if (cur.kind === "commit") history.setCommitOpen(cur.commit.sha, !history.isOpen(cur.commit.sha));
    else if (cur.kind === "commit-retry") history.retry();
    else if (cur.kind === "commit-check") {
      if (cur.check.url) openUrl(cur.check.url);
      else store.toast("No logs link for this historical check");
    }
    else if (cur.kind === "stack") {
      if (cur.n === n) store.toast("You are here");
      else {
        // The opened page lands on this same row (its own stack entry) at the same terminal row.
        const at = ys.current.get(cur.id);
        const sb = scrollRef.current;
        store.openPr(cur.n, d.repo, { key: cur.id, row: (sb?.viewport.screenY ?? 0) + (at?.y ?? 0) - (sb?.scrollTop ?? 0) });
      }
    }
    else if (cur.kind === "desc") setDescLevel(descLevel === 2 ? 1 : 2);
    else if (cur.kind === "passing") setPassingOpen((v) => !v);
    else if (cur.kind === "check") {
      if (cur.url) openUrl(cur.url);
      else store.toast("No logs link for this check");
    } else if (cur.kind === "bots") setLevel(cur.id, (c) => (c > 0 ? 0 : 1), 0);
    else setLevel(cur.id, (c) => (c === 2 ? 0 : ((c + 1) as Level)), defaultLevel(cur));
  };
  const fold = (how: "a" | "o" | "c") => {
    if (!cur) return;
    follow.anchorItem();
    const want = how === "a" ? undefined : how === "c";
    if (cur.kind === "desc") setDescLevel(how === "a" ? (descLevel === 2 ? 1 : 2) : how === "o" ? 2 : 1);
    else if (cur.kind === "thread" || cur.kind === "convo") stepLevel(cur, how === "a" ? 0 : how === "o" ? 1 : -1);
    else if (cur.kind === "bots") setLevel(cur.id, (c) => (how === "a" ? (c > 0 ? 0 : 1) : how === "o" ? 1 : 0), 0);
    else if (cur.kind === "passing") setPassingOpen((v) => (want === undefined ? !v : !want));
    else if (cur.kind === "files") setFilesOpen((v) => (want === undefined ? !v : !want));
    else if (cur.kind === "commits") history.setOpen(want === undefined ? !history.open : !want);
    else if (cur.kind === "commit") history.setCommitOpen(cur.commit.sha, want === undefined ? !history.isOpen(cur.commit.sha) : !want);
  };
  const foldAll = (open: boolean) => {
    const lv: Level = open ? 1 : 0;
    const folds = actRows.filter((r): r is BotFold => r.kind === "bots");
    // A cursor on a fold member would hold its fold open (`inFold`): move it up to the fold's own row.
    const holder = open ? undefined : folds.find(inFold);
    if (holder) setCurId(holder.id);
    if (!open && (cur?.kind === "commit" || cur?.kind === "commit-check" || cur?.kind === "commit-retry")) setCurId("commits");
    setLevels(
      new Map<string, Level>([
        ["desc", open ? 2 : 1],
        ...allActivity.map((it) => [activityId(it), lv] as const),
        ...folds.map((f) => [f.id, lv] as const),
      ]),
    );
    setPassingOpen(open);
    setFilesOpen(open);
    history.foldAll(open);
  };
  const closeDiff = () => {
    setOpenFile(null);
  };

  // ----- esc / h: reply cancel and diff close (deferred so app.tsx's handler still sees `prCapturesBack()`) -----
  const live = useRef({ reply, openFile, searching: false });
  live.current = { reply, openFile, searching: live.current.searching };
  captures = reply !== null || openFile !== null;
  useEffect(
    () => () => {
      captures = false;
      if (live.current.reply) store.setInputFocused(false);
    },
    [store],
  );
  useKeyboard((k) => {
    const s = store.getState();
    const { reply: r, openFile: f } = live.current;
    if (k.name === "escape" && r) {
      k.stopPropagation();
      setTimeout(endReply, 0);
    } else if (r && (k.name === "return" || k.name === "enter")) {
      // Same policy as the review sheet: ⌘⏎ (or ctrl/meta+⏎ where ⌘ isn't reported) sends; plain ⏎ never posts.
      k.preventDefault();
      k.stopPropagation();
      if (k.super || k.ctrl || k.meta) submitReply(r.value);
    } else if (!s.sheet && !s.inputFocused && !live.current.searching && f && (k.name === "escape" || (k.name === "h" && !k.ctrl && !k.meta))) {
      k.stopPropagation();
      setTimeout(closeDiff, 0);
    }
  });

  // ----- blocks / scroll positions -----
  const blocks: Block[] = [];
  const push = (key: string, h: number, node: ReactNode, o: { item?: string; lead?: number } = {}) => blocks.push({ key, h, node, ...o });
  const gap = (key: string, h = 1) => push(key, h, <box height={h} flexShrink={0} />);
  const wide = Math.max(10, cw - 2);
  const bodyW = Math.max(10, cw - 4);

  push(
    "pills",
    1,
    <box height={1} flexDirection="row" gap={2} flexShrink={0}>
      {!info.closed && <Pill label="Approve" hint="a" onPress={() => store.openSheet({ kind: "review", n, event: "APPROVE" })} />}
      {!info.closed && <Pill label="Request changes" hint="x" onPress={() => store.openSheet({ kind: "review", n, event: "REQUEST_CHANGES" })} />}
      <Pill label="Comment" hint="C" onPress={() => store.openSheet({ kind: "review", n, event: "COMMENT" })} />
    </box>,
  );
  gap("pills-gap");

  // description
  {
    const collapsed = descLevel < 2;
    const lineCount = hasDesc ? layoutBlocks(parseComment(pr.body).blocks, bodyW, { details: false }).length : 0;
    const selected = hlKey === "desc";
    const select = () => setCurId("desc");
    push(
      "ds",
      1,
      <Sel selected={selected} h={1} onSelect={select} onOpen={openCur}>
        <Label label="Description" meta={hasDesc && collapsed ? plural(lineCount, "line") : undefined} />
      </Sel>,
    );
    gap("ds-gap");
    if (!hasDesc) push("ds-none", 1, <T tone="muted">No description</T>);
    else {
      const rows = bodyRows(pr.body, descLevel, bodyW, DESC_CAP, undefined, false, images);
      push("desc", rowsHeight(rows), <RowsView rows={rows} selected={selected} headOnly onSelect={select} onOpen={openCur} />, { item: "desc", lead: 2 });
    }
    gap("ds-end", 2);
  }

  // stack: top of the stack first, trunk at the bottom
  if (d.stack) {
    const top = [...d.stack.entries].reverse();
    const forks = forkText(d);
    const hint = d.stack.native
      ? ` ${G.sep} merge S ${G.arrow}${forks ? ` ${G.sep} forks ${forks}` : ""}`
      : forks
        ? ` ${G.sep} forks ${forks} ${G.sep} GitHub stacks must be one line`
        : ` ${G.sep} merge S ${G.arrow} ${G.sep} not a GitHub stack ${G.sep} :create-stack`;
    const count = `${top.length} PR${top.length === 1 ? "" : "s"}`;
    push("sk", 1, <Label label="Stack" meta={d.pr.state === "OPEN" ? `${count}${hint}` : count} />);
    gap("sk-gap");
    // Fixed slots (badge | widest issue) so the badge column never moves with the row selected or the PR opened; titles clip to what's left.
    // The open PR is marked by its title alone: bold ink, the rest muted. A conflict shows only as the row's ✗ (Blocking merge explains it).
    const rows = top.map((e) => ({
      e,
      issue: e.mergeIssue === "blocked" ? "blocked by rules" : e.mergeIssue === "checking" ? `checking${G.ellipsis}` : "",
    }));
    const badgeW = Math.max(...top.map((e) => badgeLabel(e).length + 3));
    const issueW = Math.max(...rows.map((r) => r.issue.length));
    rows.forEach(({ e, issue }, i) => {
      // a forked tree: branches indent by depth, and a row not sitting on the row below names its parent
      const indent = "  ".repeat(e.tree?.depth ?? 0);
      const parent = e.tree?.parent ?? null;
      const on = parent !== null && top[i + 1]?.number !== parent ? ` (on #${parent})` : "";
      const id = `s:${e.number}`;
      const selected = hlKey === id;
      const here = e.number === n;
      push(
        id,
        1,
        <Sel selected={selected} h={1} onSelect={() => setCurId(id)} onOpen={openCur} mark={here}>
          <Split
            left={
              <box flexDirection="row" height={1}>
                <box flexShrink={0} flexDirection="row">
                  {indent && <text>{indent}</text>}
                  <CheckGlyph state={e.state === "MERGED" ? "merged" : e.mergeIssue === "conflict" ? "fail" : e.checks} />
                  <text>{"  "}</text>
                </box>
                <Clipped text={`#${e.number}${on}${e.title ? ` ${e.title}` : ""}`} fg={toneColor(p, here ? "ink" : "muted", selected)} bold={here} />
              </box>
            }
            right={
              <box flexDirection="row" height={1} width={badgeW + issueW}>
                <box width={badgeW} flexShrink={0}>
                  <StateBadge pr={e} />
                </box>
                {issueW > 0 && (
                  <box width={issueW} flexShrink={0}>
                    <T tone="muted" sel={selected}>{issue}</T>
                  </box>
                )}
              </box>
            }
          />
        </Sel>,
        { item: id, lead: i === 0 ? 2 : 0 },
      );
    });
    push("sk-trunk", 1, <T tone="muted">{`   └ ${d.stack.trunk}`}</T>);
    gap("sk-end", 2);
  }

  if (info.descs.length && !info.closed) {
    push("bl", 1, <Label label="Blocking merge" meta={info.descs.length} />);
    gap("bl-gap");
    const lw = Math.min(34, Math.max(...info.descs.map((x) => x.label.length)));
    info.descs.forEach((x, i) =>
      push(
        `bl${i}`,
        1,
        <box height={1} flexDirection="row" flexShrink={0}>
          <StatusGlyph status={x.glyph} />
          <text>{"  "}</text>
          <box flexShrink={0} width={lw}>
            <text fg={p.ink} wrapMode="none" truncate>
              {x.label}
            </text>
          </box>
          <box flexGrow={1} flexShrink={1} marginLeft={2} height={1} overflow="hidden">
            <T tone="muted">{x.detail}</T>
          </box>
        </box>,
      ),
    );
    gap("bl-end", 2);
  }

  // activity: comments, reviews (with their findings nested) and threads in one chronological list, no rows between entries
  {
    const meta = activityMeta({ comments: convo.length, openThreads: visibleThreads.filter((t) => !t.isResolved).length, lowSignal: lowCount, lowHidden: !showLow, botsHidden: fresh.length - convo.length });
    push("act", 1, <Label label="Activity" meta={meta} />);
    gap("act-gap");
    if (!activity.length) push("act-none", 1, <T tone="muted">No activity</T>);
    const blocksOf = activityLayout(actRows, { levelOf, isOpen: foldOpen, replyId: reply?.id ?? null, w: bodyW, prAuthor: pr.author, age, images });
    blocksOf.forEach(({ id, item, rows, who }, i) => {
      const selected = hlKey === id;
      const level = item.kind === "bots" ? 0 : levelOf(item);
      const replying = item.kind === "thread" && reply?.id === item.th.id;
      push(
        id,
        rowsHeight(rows),
        <RowsView
          rows={rows}
          selected={selected}
          headOnly={level > 0}
          muted={item.kind === "convo" && level === 0 && (item.e.isBot || !!lowSignalTag(item.e))}
          accent={who ? personColor(p, who, pr.author) : undefined}
          reply={replying ? reply : null}
          onInput={item.kind === "thread" ? (v) => setReply({ id: item.th.id, value: v }) : undefined}
          onSelect={() => setCurId(id)}
          onOpen={openCur}
        />,
        { item: id, lead: i === 0 ? 2 : 0 },
      );
    });
    gap("act-end", 2);
  }

  // Historical results are deliberately separate from the current head's required checks.
  push(
    "commits", 1,
    <Sel selected={hlKey === "commits"} h={1} onSelect={() => setCurId("commits")} onOpen={openCur}>
      <Label label={`${history.open ? G.open : G.closed} Commits`} meta={history.resource?.data ? `${history.commits.length} ${G.sep} historical checks${history.resource.refreshing ? ` ${G.sep} refreshing` : ""}` : "history · load on open"} />
    </Sel>,
    { item: "commits" },
  );
  if (history.open) {
    const cols = commitColumns(history.commits, (c) => age(c.committedAt));
    gap("commits-gap");
    if (!history.resource || history.resource.status === "idle" || history.resource.status === "loading") push("commits-loading", 1, <Loading text="Loading commit history" />);
    else if (history.resource.status === "ready" && !history.commits.length) push("commits-empty", 1, <T tone="muted">No commits reported</T>);
    for (const item of history.items) {
      const selected = hlKey === item.id;
      if (item.kind === "commits") continue;
      if (item.kind === "commit-retry") {
        push(item.id, 2,
          <Sel selected={selected} h={2} onSelect={() => setCurId(item.id)} onOpen={openCur}>
            <T tone="error">{`Couldn’t load history: ${history.resource?.error ?? "unknown error"}`}</T>
            <T sel={selected}>Retry commit history · Enter</T>
          </Sel>, { item: item.id });
        continue;
      }
      push(item.id, 1,
        <Sel selected={selected} h={1} onSelect={() => setCurId(item.id)} onOpen={openCur}>
          {item.kind === "commit"
            ? <CommitRow commit={item.commit} open={history.isOpen(item.commit.sha)} selected={selected} age={age(item.commit.committedAt)} cols={cols} />
            : <CommitCheckRow check={item.check} selected={selected} />}
        </Sel>, { item: item.id });
      if (item.kind === "commit" && history.isOpen(item.commit.sha) && !item.commit.checks.length) push(`${item.id}:empty`, 1, <T tone="muted">  No checks reported for this commit</T>);
    }
  }
  gap("commits-end", 2);

  // checks
  {
    const summary = checkSummary(checks);
    const color = summary.state === "fail" ? p.error : summary.state === "pending" ? p.warn : summary.state === "pass" ? p.ok : p.muted;
    const meta = <>current head {G.sep} <span fg={color}>{summary.text}</span></>;
    push("ck", 1, <Label label="Checks" meta={meta} />);
    gap("ck-gap");
    if (!checks.length) push("ck-none", 1, <T tone="muted">No checks reported on this head</T>);
    let firstCheck = true;
    const checkRow = (id: string, c: CurrentCheck) => {
      const selected = hlKey === id;
      const status = c.expected ? "expected · hasn’t run on this head" : c.state === "fail" ? "failed" : c.state === "pending" ? "running" : c.state === "skipped" ? "skipped" : "passed";
      push(
        id,
        1,
        <Sel selected={selected} h={1} onSelect={() => setCurId(id)} onOpen={openCur}>
          <Split
            left={
              <box flexDirection="row" height={1}>
                <CheckGlyph state={c.state as "pass" | "fail" | "pending" | "skipped"} />
                <text>{"  "}</text>
                <T tone={c.state === "pass" || c.state === "skipped" ? "muted" : "ink"} sel={selected}>
                  {c.name}
                </T>
              </box>
            }
            right={<T tone="muted" sel={selected}>{`${status}${c.url ? `   logs ${G.out}` : ""}`}</T>}
          />
        </Sel>,
        { item: id, lead: firstCheck ? 2 : 0 },
      );
      firstCheck = false;
    };
    [...failing, ...pending].forEach((c, i) => checkRow(`c:${i}:${c.name}`, c));
    if (quiet.length) {
      const sel = hlKey === "passing";
      push(
        "passing",
        1,
        <Sel selected={sel} h={1} onSelect={() => setCurId("passing")} onOpen={openCur}>
          <box flexDirection="row" height={1}>
            <CheckGlyph state={skipped.length ? "skipped" : "pass"} />
            <text>{"  "}</text>
            <T tone="muted" sel={sel}>{`${passing.length} passing${skipped.length ? ` ${G.sep} ${skipped.length} skipped` : ""}`}</T>
            <T tone="faint" sel={sel}>{` ${passingOpen ? G.open : G.closed}`}</T>
          </box>
        </Sel>,
        { item: "passing", lead: firstCheck ? 2 : 0 },
      );
      if (passingOpen) quiet.forEach((c, i) => checkRow(`q:${i}:${c.name}`, c));
    }
    gap("ck-end", 2);
  }

  // files
  if (files.length) {
    const add = files.reduce((a, f) => a + f.additions, 0);
    const del = files.reduce((a, f) => a + f.deletions, 0);
    const fsel = hlKey === "files";
    push(
      "fl",
      1,
      <Sel selected={fsel} h={1} onSelect={() => setCurId("files")} onOpen={openCur}>
        <Label label={`${filesOpen ? G.open : G.closed} Files`} meta={<>{`${files.length} ${G.sep} `}<span fg={p.ok}>{`+${num(add)}`}</span>{" "}<span fg={p.error}>{`${MINUS}${num(del)}`}</span></>} />
      </Sel>,
      { item: "files", lead: 2 },
    );
    let prev: string[] = [];
    let firstFile = true;
    for (const f of filesOpen ? files : []) {
      const parts = f.path.split("/");
      const dirs = parts.slice(0, -1);
      let same = 0;
      while (same < dirs.length && same < prev.length && dirs[same] === prev[same]) same++;
      for (let i = same; i < dirs.length; i++) {
        push(`d:${f.path}:${i}`, 1, <T tone="muted">{`${"  ".repeat(i)}${G.open} ${dirs[i]}/`}</T>);
      }
      prev = dirs;
      const id = `f:${f.path}`;
      const selected = hlKey === id;
      const active = openFile === f.path;
      push(
        id,
        1,
        <Sel selected={selected} h={1} onSelect={() => setCurId(id)} onOpen={openCur}>
          <Split
            left={
              <T sel={selected} bold={active}>
                {`${"  ".repeat(dirs.length)}  ${parts[parts.length - 1]}`}
              </T>
            }
            right={
              <text wrapMode="none">
                <span fg={f.status === "D" ? p.error : toneColor(p, "muted", selected)}>{f.status.padStart(3)}</span>
                <span fg={p.ok}>{(f.additions ? `+${num(f.additions)}` : "").padStart(7)}</span>
                <span fg={p.error}>{(f.deletions ? `${MINUS}${num(f.deletions)}` : "").padStart(7)}</span>
              </text>
            }
          />
        </Sel>,
        { item: id, lead: firstFile ? 4 : 0 },
      );
      firstFile = false;
    }
    gap("fl-end", 2);
  }

  // diff card
  let diffRows = 0;
  if (openFile) {
    const f = d.files.find((x) => x.path === openFile);
    push(
      "diff-head",
      1,
      <Split
        left={<T bold>{openFile}</T>}
        right={
          <text fg={p.muted} wrapMode="none">
            {f ? (
              <>
                <span fg={p.ok}>{`+${num(f.additions)}`}</span>{" "}
                <span fg={p.error}>{`${MINUS}${num(f.deletions)}`}</span>
                {`  ${G.sep}  `}
              </>
            ) : null}
            {`s ${view === "split" ? "unified" : "split"}`}
          </text>
        }
      />,
    );
    push("diff-rule", 1, <Rule />);
    if (diffFolded) {
      push("diff", 1, <T tone="muted">{`${G.closed} folded ${G.sep} zo to open`}</T>);
    } else if (diffRes?.status === "error" && !diffPatch) {
      push("diff", 3, <ErrorState title={`Couldn’t load ${openFile}`} detail={diffRes.error} hint="esc closes" />);
    } else if (!diffPatch) {
      push("diff", 1, <Loading text={`Loading ${openFile}`} />);
    } else {
      diffRows = Math.max(1, diffText.length);
      const add = lerpHex(p.ground, p.bulletGreen, 0.1);
      const rem = lerpHex(p.ground, p.error, 0.1);
      push(
        "diff",
        diffRows,
        <diff
          ref={diffRef}
          diff={diffPatch}
          view={view}
          fg={p.ink}
          wrapMode="none"
          showLineNumbers
          height={diffRows}
          flexShrink={0}
          lineNumberFg={p.faint}
          lineNumberBg={p.ground}
          contextBg={p.ground}
          contextContentBg={p.ground}
          addedBg={add}
          removedBg={rem}
          addedContentBg={lerpHex(p.ground, p.bulletGreen, 0.18)}
          removedContentBg={lerpHex(p.ground, p.error, 0.18)}
          addedLineNumberBg={add}
          removedLineNumberBg={rem}
          addedSignColor={add}
          removedSignColor={rem}
        />,
      );
    }
    gap("diff-end", 2);
  }

  const ys = useRef(new Map<string, { y: number; h: number; lead: number }>());
  {
    let y = 0;
    const m = new Map<string, { y: number; h: number; lead: number }>();
    for (const b of blocks) {
      m.set(b.item ?? b.key, { y, h: b.h, lead: b.lead ?? 0 });
      y += b.h;
    }
    ys.current = m;
  }

  // keep the cursor visible: scrolloff, min scroll, glide on long jumps, anchored on curKey across fold/refresh reflow; wheel clamps cursor at the edge
  const curPos = curKey ? ys.current.get(curKey) : undefined;
  const follow = useScrollFollow(scrollRef, curPos && curKey && openFile === null ? { key: curKey, y: curPos.y, h: curPos.h, lead: curPos.lead } : null, {
    initialScreenRow: focus?.row,
    clampCursor: (top, bottom, dir) => {
      const fit = items.filter((it) => {
        const q = ys.current.get(it.id);
        return q && q.y >= top && q.y + q.h <= bottom;
      });
      const it = dir === "up" ? fit[0] : fit[fit.length - 1];
      if (!it) return null;
      setCurId(it.id);
      return it.id;
    },
  });

  // ----- search (`/ n N`): list items (revealing collapsed/hidden groups), or rows of the open diff -----
  const queryRef = useRef("");
  /** Level 1 shows the match when it is outside `<details>`; otherwise open the details (level 2). */
  const levelFor = (bodies: string[]): Level => {
    const q = queryRef.current.toLowerCase();
    return bodies.some((b) => plainBody(b, false).toLowerCase().includes(q)) ? 1 : 2;
  };
  const goItem = (i: number) => {
    const it = searchItems[i]?.item;
    if (!it) return;
    if (it.kind === "convo") {
      if (!showLow && lowSignalTag(it.e)) setShowLow(true);
      if (!showBots && it.e.isBot) setShowBots(true);
      const lv = levelFor([it.e.body]);
      setLevel(it.id, (c) => Math.max(c, lv) as Level, defaultLevel(it));
    } else if (it.kind === "thread") {
      if (!showBots && it.th.comments.every((c) => c.isBot)) setShowBots(true);
      const lv = levelFor(it.th.comments.map((c) => c.body));
      setLevel(it.id, (c) => Math.max(c, lv) as Level, defaultLevel(it));
    } else if (it.kind === "desc") {
      const lv = levelFor([pr.body]);
      setLevel("desc", (c) => Math.max(c, lv) as Level, 1);
    } else if (it.kind === "file") setFilesOpen(true);
    else if (it.kind === "commit" || it.kind === "commit-check") {
      history.setOpen(true);
      if (it.kind === "commit-check") history.setCommitOpen(it.commit.sha, true);
    }
    else if (it.id.startsWith("q:")) setPassingOpen(true);
    setCurId(it.id);
  };
  const diffOpen = openFile !== null;
  /** Diff row of the last search jump: the search cursor while it is still on screen (the viewport top is not the match). */
  const lastMatch = useRef(-1);
  const search = useVimSearch(
    diffOpen
      ? {
          enabled: !sheet,
          count: diffFolded ? 0 : diffText.length,
          // read lazily: the scroll position changes without a render
          get cursor() {
            const sb = scrollRef.current;
            const rel = (sb?.scrollTop ?? 0) - (ys.current.get("diff")?.y ?? 0);
            const row = lastMatch.current;
            if (row >= 0 && row >= rel && row < rel + (sb?.viewport.height ?? 0)) return row;
            return rel < 0 ? -1 : Math.min(diffText.length - 1, rel);
          },
          setCursor: (i: number) => {
            const sb = scrollRef.current;
            lastMatch.current = i;
            if (!sb) return;
            const y = (ys.current.get("diff")?.y ?? 0) + i;
            const vh = sb.viewport.height;
            const top = sb.scrollTop;
            if (y < top + 3) follow.scrollTo(y - 3);
            else if (y >= top + vh - 3) follow.scrollTo(y - vh + 4);
          },
          textAt: (i: number) => diffText[i] ?? "",
        }
      : {
          enabled: !sheet,
          count: searchItems.length,
          cursor: searchItems.findIndex((x) => x.item.id === curKey),
          setCursor: goItem,
          textAt: (i: number) => searchItems[i]?.text ?? "",
        },
  );
  live.current.searching = search.active;
  queryRef.current = search.query;
  if (search.active) captures = true;


  // jump to the diff when a file opens
  useEffect(() => {
    if (!openFile) return;
    // layout of the new card is computed on the next frame; scrolling earlier would clamp to the old height
    const t = setTimeout(() => {
      const pos = ys.current.get("diff-head");
      if (pos) follow.scrollTo(pos.y);
    }, 50);
    return () => clearTimeout(t);
  }, [openFile]);

  // ----- keys -----
  const pageSize = scrollRef.current?.viewport.height ?? 10;
  useVimNav({
    count: items.length,
    cursor: idx,
    setCursor: setCursorIdx,
    pageSize,
    enabled: openFile === null,
    onOpen: () => !live.current.searching && openCur(),
    sectionStarts: starts,
    // ↑/↓ only scroll the page, a line per press; the selection never changes (it may scroll off screen). j/k move it, and the view follows.
    onArrow: (dir, times) => follow.nudge(dir === "down" ? times : -times),
  });

  const pend = useRef({ digits: "", gAt: 0, prefix: "", at: 0 });
  const fileItems = items.filter((x): x is Extract<Item, { kind: "file" }> => x.kind === "file");

  useScreenKeys((k) => {
    const st = pend.current;
    const seq = k.sequence;
    const now = Date.now();
    const sb = scrollRef.current;
    const vh = sb?.viewport.height ?? 10;
    const diffOpen = openFile !== null;

    if (k.ctrl && diffOpen && sb) {
      const times = Number(st.digits) || 1;
      st.digits = "";
      if (k.name === "d") follow.scrollBy(Math.floor(vh / 2) * times);
      else if (k.name === "u") follow.scrollBy(-Math.floor(vh / 2) * times);
      else if (k.name === "f") follow.scrollBy((vh - 1) * times);
      else if (k.name === "b") follow.scrollBy(-(vh - 1) * times);
      return;
    }
    if (k.ctrl || k.meta) return;

    // two-key prefixes: z (folds), ] [ (diff hunks/files)
    if (st.prefix && now - st.at < 500) {
      const pre = st.prefix;
      st.prefix = "";
      if (pre === "z") {
        if (diffOpen && (seq === "a" || seq === "o" || seq === "c")) setDiffFolded((v) => (seq === "a" ? !v : seq === "c"));
        else if (seq === "a" || seq === "o" || seq === "c") fold(seq);
        else if (seq === "R") foldAll(true);
        else if (seq === "M") foldAll(false);
        return;
      }
      if (diffOpen) {
        const dir = pre === "]" ? 1 : -1;
        if (seq === "c") {
          const top = ys.current.get("diff")?.y ?? 0;
          const rel = (sb?.scrollTop ?? 0) - top;
          const offs = diffRef.current?.getHunkRowOffsets() ?? [];
          const next = dir > 0 ? offs.find((o) => o > rel) : [...offs].reverse().find((o) => o < rel);
          if (next !== undefined && sb) follow.scrollTo(top + next);
        } else if (seq === "f") {
          const at = fileItems.findIndex((x) => x.path === openFile);
          const nf = fileItems[at + dir];
          if (nf) {
            setCurId(nf.id);
            loadFile(nf.path);
          }
        }
      }
      return;
    }
    st.prefix = "";
    if (seq === "z" || seq === "]" || seq === "[") {
      st.prefix = seq;
      st.at = now;
      return;
    }

    if (diffOpen && (k.name === "return" || k.name === "enter") && !live.current.reply && !live.current.searching) return void closeDiff();
    if (diffOpen && sb) {
      if (seq.length === 1 && seq >= "0" && seq <= "9" && (seq !== "0" || st.digits)) {
        st.digits += seq;
        return;
      }
      const times = Number(st.digits) || 1;
      st.digits = "";
      if (k.name === "j" || k.name === "down") return follow.scrollBy(times);
      if (k.name === "k" || k.name === "up") return follow.scrollBy(-times);
      if (seq === "G") return follow.scrollTo(1e6);
      if (seq === "g") {
        if (now - st.gAt < 500) {
          st.gAt = 0;
          follow.scrollTo(ys.current.get("diff-head")?.y ?? 0);
        } else st.gAt = now;
        return;
      }
      if (seq === "s") return setView((v) => (v === "split" ? "unified" : "split"));
    }

    switch (seq) {
      case "c":
        if (cur?.kind === "thread") startReply(cur.th), k.preventDefault();
        else store.toast("Select a thread to reply");
        return;
      case "F":
        return fixCur();
      case "e":
        if (cur?.kind === "thread" && !cur.th.isResolved) void store.resolveThread(n, cur.th.id);
        else store.toast("Select an unresolved thread to resolve");
        return;
      case "s":
        return setView((v) => (v === "split" ? "unified" : "split"));
      case "a":
        if (info.closed) return store.toast(`#${n} is ${pr.state.toLowerCase()}`);
        return store.openSheet({ kind: "review", n, event: "APPROVE" });
      case "x":
        if (info.closed) return store.toast(`#${n} is ${pr.state.toLowerCase()}`);
        return store.openSheet({ kind: "review", n, event: "REQUEST_CHANGES" });
      case "C":
        return store.openSheet({ kind: "review", n, event: "COMMENT" });
      case "o":
        if (cur?.kind === "desc") return openInBrowser(store, pr.url);
        if (cur?.kind === "convo") return openInBrowser(store, cur.e.url);
        if (cur?.kind === "commit" || cur?.kind === "commit-check") return openInBrowser(store, cur.commit.url);
        if (cur?.kind === "thread") {
          const fix = threadFix(cur.th);
          return openInBrowser(store, fix ? `https://github.com/${d.repo.owner}/${d.repo.name}/commit/${fix}` : (cur.th.comments[0]?.url ?? pr.url));
        }
        return openInBrowser(store, pr.url);
      case "B":
        setShowBots((v) => !v);
        return store.toast(showBots ? "Bot comments hidden" : "Bot comments shown");
      case "L":
        setShowLow((v) => !v);
        return store.toast(showLow ? "Noise and minimized hidden" : "Noise and minimized shown");
      case "m":
        return mergeAction(store, d);
      case "M":
        return forceAction(store, d);
      case "t":
        return store.cycleMergeMethod();
      case "S":
        return stackAction(store, d);
      case "U":
        return updateBranchAction(store, d);
      case "w":
        return store.openSheet({ kind: "worktree", n });
    }
  });

  // ----- header (fixed) -----
  const tw = Math.max(10, cw - 4);
  const titleLines = wrap(pr.title, tw);
  if (titleLines.length > 2) titleLines.splice(2, titleLines.length, titleLines[1]!.slice(0, tw - 1) + G.ellipsis);
  const wt = pr.worktree ? pr.worktree.split("/").filter(Boolean).pop() : null;
  const rest = [`${pr.headRef} ${G.arrow} ${pr.baseRef}`, wt ? `wt ${wt}` : ""].filter(Boolean);
  const byLine = [
    pr.author ? `by ${pr.author}` : "",
    pr.createdAt && age(pr.createdAt) ? `opened ${age(pr.createdAt)} ago` : "",
    pr.updatedAt && age(pr.updatedAt) ? `updated ${age(pr.updatedAt)} ago` : "",
  ]
    .filter(Boolean)
    .join(` ${G.sep} `)
    .replace(/(now) ago/g, "just now");

  return (
    <>
      {titleLines.map((l, i) => (
        <text key={i} fg={p.ink} wrapMode="none">
          <strong>{l}</strong>
        </text>
      ))}
      <box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
        <StateBadge pr={pr} />
        <PrLink label={`#${pr.number}`} onPress={() => openInBrowser(store, pr.url)} />
        <text fg={p.muted} wrapMode="none">
          {clip(` ${G.sep} ${rest.join(` ${G.sep} `)}`, Math.max(0, cw - `#${pr.number}`.length - 9))}
        </text>
      </box>
      <box height={1} flexShrink={0} overflow="hidden">
        <text fg={p.muted} wrapMode="none">
          {clip(byLine, cw)}
        </text>
      </box>
      <box height={1} flexShrink={0} />
      <box flexGrow={1} flexShrink={1} flexBasis={0} minHeight={0} flexDirection="column">
        <QueryCtx.Provider value={search.query}>
          <Scroll scrollRef={scrollRef} onWheel={follow.onWheel} onMouseDrag={trackPress}>
            {blocks.map((b) => (
              <Fragment key={b.key}>{b.node}</Fragment>
            ))}
          </Scroll>
        </QueryCtx.Provider>
      </box>
    </>
  );
}

// ---------- chrome ----------

function useCurrent() {
  const n = useStore((s) => (s.screen.kind === "pr" ? s.screen.n : 0));
  const d = useStore((s) => s.prs[n]?.data);
  return { n, d };
}

export const prChrome: Chrome = {
  HeaderRight() {
    const store = useStoreInstance();
    const { n, d } = useCurrent();
    const refreshing = useStore((s) => s.prs[n]?.refreshing ?? false);
    return (
      <box flexDirection="row" flexShrink={0}>
        <Txt tone="muted">{`${refreshing ? `refreshing${G.ellipsis} ${G.sep} ` : ""}${d ? `#${n} ${G.sep} ` : ""}`}</Txt>
        {d ? <PrLink label="o github" muted onPress={() => openInBrowser(store, d.pr.url)} /> : null}
        <Txt tone="muted">{`${d ? ` ${G.sep} ` : ""}h back ${G.sep} ? help`}</Txt>
      </box>
    );
  },
  DockLeft() {
    const p = useTheme();
    const { n, d } = useCurrent();
    const busy = useStore((s) => s.busy);
    const job = useStore((s) => runningJobOf(s, s.screen.kind === "pr" ? s.screen.repo : null, n));
    if (job) return <MergeJobStatus job={job} />;
    if (busy) return <Txt tone="muted">{`${busy}${G.ellipsis}`}</Txt>;
    if (!d) return <Txt tone="muted">{""}</Txt>;
    if (d.pr.state === "MERGED") return <Txt tone="muted">merged</Txt>;
    if (d.pr.state === "CLOSED") return <Txt tone="muted">closed</Txt>;
    const info = mergeInfo(d);
    if (!info.blocked) return <Txt tone="cobalt">{`${G.check} Ready to merge`}</Txt>;
    const conflict = d.blockers.findIndex((b) => b.kind === "conflict");
    const sorted = [...info.descs].sort((a, b) => Number(!!a.soft) - Number(!!b.soft) || a.short.length - b.short.length);
    if (conflict >= 0) sorted.unshift(...sorted.splice(sorted.indexOf(info.descs[conflict]!), 1));
    const rest = sorted.length - 1;
    const soft = !!sorted[0]!.soft;
    return (
      <text fg={soft ? p.muted : p.ink} wrapMode="none" truncate>
        <span fg={soft ? p.muted : p.error}>{G.dot}</span>
        {` ${sorted[0]!.short}`}
        {rest > 0 ? <span fg={p.muted}>{` +${rest}`}</span> : null}
      </text>
    );
  },
  DockRight() {
    const store = useStoreInstance();
    const { contentWidth } = useLayout();
    const { d } = useCurrent();
    const merging = useStore((s) => runningJobOf(s, s.screen.kind === "pr" ? s.screen.repo : null, d?.pr.number ?? 0) !== undefined);
    const busy = useStore((s) => s.busy) ?? (merging ? "merging" : null);
    const m = useStore(mergeMethodOf);
    if (!d || d.pr.state !== "OPEN") return <KeyHintsFallback />;
    const info = mergeInfo(d);
    const short = contentWidth < 80;
    const upTo = nativeUpTo(d.stack, d.pr.number);
    return (
      <box flexDirection="row" gap={2}>
        <Pill label={short ? G.open : `${m} ${G.open}`} hint={short ? undefined : "t"} onPress={() => store.cycleMergeMethod()} disabled={!!busy} />
        {info.blocked && !info.stackOnly && <Pill label="Force merge" hint="M" onPress={() => forceAction(store, d)} disabled={!!busy} />}
        {canUpdate(d) && <Pill label="Update branch" hint="U" onPress={() => updateBranchAction(store, d)} disabled={!!busy} />}
        {(!info.stackOnly || upTo !== null) && (d.stack?.entries.length ?? 0) > 1 && <Pill label={short ? "Stack" : "Merge stack"} hint={short ? undefined : "S"} onPress={() => stackAction(store, d)} disabled={!!busy} />}
        {upTo !== null ? (
          <Pill label={short ? `Up to #${d.pr.number}` : `Merge up to #${d.pr.number} (${upTo} PRs)`} hint="m" variant="primary" onPress={() => mergeAction(store, d)} disabled={!!busy} />
        ) : info.stackOnly ? (
          <Pill label="Merge stack" hint="S" variant="primary" onPress={() => stackAction(store, d)} disabled={!!busy} />
        ) : (
          <Pill label="Merge" hint="m" variant="primary" onPress={() => mergeAction(store, d)} disabled={!!busy} />
        )}
      </box>
    );
  },
};

function KeyHintsFallback() {
  return <Txt tone="muted">{`h back ${G.sep} r refresh ${G.sep} ? help ${G.sep} q quit`}</Txt>;
}
