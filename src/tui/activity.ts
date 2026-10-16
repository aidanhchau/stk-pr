/**
 * Activity: PR-level comments, reviews and review threads as one chronological list.
 * Pure model + row layout used by the TUI (rows are 1 cell tall, except `image` rows: see `rowsHeight`); no React, no theme.
 *
 * Spacing invariant: entries are stacked with NO rows between them, collapsed or expanded. Blank rows exist only inside an expanded
 * thread (between replies, before the trail), so toggling an entry changes only that entry's own rows.
 *
 * Who said what: a human's name is drawn in their colour (`author` span). Every expanded body, and every finding nested under a
 * review, carries a rail down the left column (`rail` rows): in the human's colour, faint for bots. Runs of quiet bot output fold into one row.
 */
import type { ReviewThread } from "../github";
import type { ConversationEntry } from "../types";
import { clipSpans, findingsSpan, isNoise, layoutRows, parseComment, preview, shortAuthor, shortPath, suggestionTarget, threadFix, threadTrail, withoutTitle, type ImageEnv, type ImageGroupItem, type Span } from "./markdown";

// ---------- levels + rows ----------

/** Rendered row of a comment/thread block (all rows are 1 cell tall). */
export type RL =
  | { t: "head"; left: Span[]; right?: string; muted?: boolean }
  | { t: "text"; spans: Span[]; muted?: boolean; rail?: boolean; indent?: number }
  | { t: "gap"; rail?: boolean; indent?: number }
  /** A drawn image, `rows` cells tall. `indent`: columns before the image; `railIndent`: columns before the rail (see `indentRow`). */
  | { t: "image"; src: string; alt: string; cols: number; rows: number; indent: number; rail?: boolean; railIndent?: number }
  /** Images side by side (a table row's), `rows` cells tall in all, captions included. Indents as for `image`. */
  | { t: "images"; items: ImageGroupItem[]; rows: number; indent: number; rail?: boolean; railIndent?: number }
  | { t: "input" };

/** Cells a row occupies. */
export const rowHeight = (r: RL): number => (r.t === "image" || r.t === "images" ? r.rows : 1);
export const rowsHeight = (rows: RL[]): number => rows.reduce((n, r) => n + rowHeight(r), 0);

/** 0 = one-line preview, 1 = capped body, 2 = full body with `<details>` open. */
export type Level = 0 | 1 | 2;
export const BODY_CAP = 6;

const OPEN = "▾";
const CLOSED = "▸";
const SEP = "·";
const ELLIPSIS = "…";
const RAIL = "│";
const NEST = 2;

// ---------- severity ----------

export type Severity = "high" | "medium" | "low";

const EMOJI_SEVERITY: Record<string, Severity> = { "🔴": "high", "🟥": "high", "🟡": "medium", "🟨": "medium", "🔍": "low" };

const TEXT_SEVERITY: Record<string, Severity> = { critical: "high", high: "high", medium: "medium", low: "low" };
const BADGE_SEVERITY: Record<string, Severity> = { P0: "high", P1: "high", P2: "medium", P3: "low" };
const SEVERITY_TEXT_RE = /\(?\b(critical|high|medium|low)\s+severity\b\)?/i;
const EDGE_JUNK_RE = /^[\s·|:\u2013\u2014-]+|[\s·|:\u2013\u2014-]+$/g;

/** Severity of a bot finding and its title with the marker removed: `🔴 Bug` / `Bug · High Severity` / a `P1` badge. */
export function parseSeverity(c: { title: string; badge: string | null }): { severity: Severity | null; title: string } {
  let title = c.title.trim();
  let severity: Severity | null = null;
  const em = /^(🔴|🟥|🟡|🟨|🔍)\uFE0F?\s*/u.exec(title);
  if (em) {
    severity = EMOJI_SEVERITY[em[1]!]!;
    title = title.slice(em[0].length);
  }
  const tx = SEVERITY_TEXT_RE.exec(title);
  if (tx) {
    severity ??= TEXT_SEVERITY[tx[1]!.toLowerCase()]!;
    title = title.replace(SEVERITY_TEXT_RE, " ");
  }
  if (!severity && c.badge) severity = BADGE_SEVERITY[c.badge.trim().toUpperCase()] ?? null;
  title = title.replace(EDGE_JUNK_RE, "").replace(/\s{2,}/g, " ");
  return { severity, title };
}

// ---------- grouping ----------

/** `owner`: login of the human whose review a nested thread belongs to (its rail colour). */
export type ActivityItem = { kind: "convo"; e: ConversationEntry; nested?: false } | { kind: "thread"; th: ReviewThread; nested?: boolean; owner?: string };

export const activityId = (it: ActivityItem): string => (it.kind === "convo" ? `v:${it.e.id}` : `t:${it.th.id}`);

const at = (iso: string | undefined): number => Date.parse(iso ?? "") || 0;
const threadAt = (th: ReviewThread): number => at(th.comments[0]?.createdAt);

/**
 * Display order of the Activity section: comments, reviews and threads by time (a review by `createdAt`, a thread by its first comment).
 * A thread listed in a visible review's `findings.threadIds` is nested directly under that review instead of standing at its own time.
 */
export function groupActivity(convo: ConversationEntry[], threads: ReviewThread[]): ActivityItem[] {
  const byId = new Map(threads.map((t) => [t.id, t]));
  const owner = new Map<string, string>();
  for (const e of convo) for (const id of e.findings?.threadIds ?? []) if (byId.has(id) && !owner.has(id)) owner.set(id, e.id);
  const top: { it: ActivityItem; time: number }[] = [
    ...convo.map((e) => ({ it: { kind: "convo", e } as ActivityItem, time: at(e.createdAt) })),
    ...threads.filter((t) => !owner.has(t.id)).map((th) => ({ it: { kind: "thread", th } as ActivityItem, time: threadAt(th) })),
  ];
  // Array#sort is stable: equal times keep comments before threads, then source order
  top.sort((a, b) => a.time - b.time);
  const out: ActivityItem[] = [];
  for (const { it } of top) {
    out.push(it);
    if (it.kind !== "convo") continue;
    const own = threads.filter((t) => owner.get(t.id) === it.e.id).sort((a, b) => threadAt(a) - threadAt(b));
    for (const th of own) out.push({ kind: "thread", th, nested: true, ...(it.e.isBot ? {} : { owner: it.e.author }) });
  }
  return out;
}

// ---------- bot folds ----------

/** A run of quiet bot output shown as one row; `members` are the folded items in display order. */
export interface BotFold {
  kind: "bots";
  id: string;
  members: ActivityItem[];
}
export type ActivityRow = ActivityItem | BotFold;

const botOnly = (th: ReviewThread): boolean => th.comments.length > 0 && th.comments.every((c) => c.isBot);

/**
 * Runs of 2+ consecutive quiet bot units fold into one `BotFold`. A unit is a bot comment/review together with the findings nested
 * under it (quiet only when every finding is resolved), or a standalone resolved bot-only thread. Humans and open findings break runs,
 * so nothing that needs attention is ever folded away.
 */
export function foldBots(items: ActivityItem[]): ActivityRow[] {
  const units: { items: ActivityItem[]; quiet: boolean }[] = [];
  for (const it of items) {
    const last = units[units.length - 1];
    if (it.kind === "thread" && it.nested && last) {
      last.items.push(it);
      if (!it.th.isResolved) last.quiet = false;
    } else if (it.kind === "convo") units.push({ items: [it], quiet: it.e.isBot });
    else units.push({ items: [it], quiet: it.th.isResolved && botOnly(it.th) });
  }
  const out: ActivityRow[] = [];
  let run: ActivityItem[][] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ kind: "bots", id: `b:${activityId(run[0]![0]!)}`, members: run.flat() });
    else for (const u of run) out.push(...u);
    run = [];
  };
  for (const u of units) {
    if (u.quiet) run.push(u.items);
    else {
      flush();
      out.push(...u.items);
    }
  }
  flush();
  return out;
}

/** `▸ 4 bot comments  codex ×2 · bugbot ×2 · 3 resolved findings  12h`. */
function foldHead(f: BotFold, open: boolean, x: RowCtx): RL {
  const counts = new Map<string, number>();
  let comments = 0;
  let findings = 0;
  let last = "";
  for (const it of f.members) {
    const when = it.kind === "convo" ? it.e.createdAt : (it.th.comments[0]?.createdAt ?? "");
    if (when > last) last = when;
    if (it.kind === "convo") {
      comments++;
      const name = shortAuthor(it.e.author);
      counts.set(name, (counts.get(name) ?? 0) + 1);
    } else findings++;
  }
  const who = [...counts].map(([name, k]) => (k > 1 ? `${name} ×${k}` : name));
  if (findings) who.push(`${findings} resolved finding${findings === 1 ? "" : "s"}`);
  const left: Span[] = [
    { text: `${open ? OPEN : CLOSED} `, style: "muted" },
    { text: `${comments} bot comment${comments === 1 ? "" : "s"}`, style: "muted" },
    { text: `  ${who.join(` ${SEP} `)}`, style: "muted" },
    ...(last ? [{ text: `  ${x.age(last)}`, style: "muted" as const }] : []),
  ];
  return { t: "head", left: clipSpans(left, x.w), muted: true };
}

/** `noise` (superseded bot output) or `minimized` (hidden on GitHub); such entries render as one muted line by default. */
export const lowSignalTag = (e: ConversationEntry): string | null =>
  e.minimized ? (e.minimizedReason ? `minimized ${SEP} ${e.minimizedReason}` : "minimized") : isNoise(parseComment(e.body)) ? "noise" : null;

/** Standalone open threads start expanded; resolved ones and threads nested under a review start as one line. */
export const defaultLevel = (it: ActivityItem): Level =>
  it.kind === "convo" ? (it.e.isBot || lowSignalTag(it.e) || !it.e.body.trim() ? 0 : 1) : it.th.isResolved || it.nested ? 0 : 1;

export interface ActivityCounts {
  comments: number;
  openThreads: number;
  lowSignal: number;
}

/** Section meta: `N comments · K open threads · L low-signal`. */
export function activityMeta(c: ActivityCounts & { lowHidden?: boolean; botsHidden?: number }): string {
  const n = (k: number, w: string) => `${k} ${w}${k === 1 ? "" : "s"}`;
  return [
    n(c.comments, "comment"),
    n(c.openThreads, "open thread"),
    c.lowSignal ? `${c.lowSignal} low-signal${c.lowHidden ? " hidden" : ""}` : "",
    c.botsHidden ? `${c.botsHidden} bot hidden` : "",
  ]
    .filter(Boolean)
    .join(` ${SEP} `);
}

// ---------- rows ----------

/**
 * Body lines at `level`; level 1 caps at BODY_CAP with a trailing "… N more lines" (", N images" when some of them are pictures). A drawn
 * image counts as one line however tall it is, a table row's side-by-side images as one; only images that survive the cap are requested.
 */
export function bodyRows(body: string, level: Level, w: number, cap = BODY_CAP, removed?: string[], dropTitle = false, images?: ImageEnv): RL[] {
  const blocks = parseComment(body).blocks;
  const all = layoutRows(dropTitle ? withoutTitle(blocks) : blocks, w, { details: level === 2, removed, images });
  const shown = level === 2 ? all : all.slice(0, cap);
  const rows: RL[] = shown.map((r): RL => {
    if (r.t === "image") return { t: "image", src: r.src, alt: r.alt, cols: r.cols, rows: r.rows, indent: r.indent };
    if (r.t === "images") return { t: "images", items: r.items, rows: r.rows, indent: r.indent };
    if (r.image) images?.request(r.image);
    return r.spans.length ? { t: "text", spans: r.spans } : { t: "gap" };
  });
  if (shown.length < all.length) {
    const hidden = new Set<string>();
    for (const r of all.slice(shown.length)) {
      if (r.t === "image") hidden.add(r.src);
      else if (r.t === "images") for (const it of r.items) hidden.add(it.src);
      else if (r.image) hidden.add(r.image);
    }
    const pics = hidden.size ? `, ${hidden.size} ${hidden.size === 1 ? "image" : "images"}` : "";
    rows.push({ t: "text", spans: [{ text: `${ELLIPSIS} ${all.length - shown.length} more lines${pics}`, style: "muted" }] });
  }
  return rows;
}

/** Review verdict after the author/age. A plain COMMENTED review says nothing beyond the comment itself, so it gets no tag. */
const STATE_SPAN: Record<string, Span> = {
  APPROVED: { text: "✓ approved", style: "add" },
  CHANGES_REQUESTED: { text: "× changes requested", style: "del" },
  DISMISSED: { text: "dismissed", style: "muted" },
};

export interface RowCtx {
  /** Row width available to a top-level entry. */
  w: number;
  prAuthor: string;
  /** `4h` style age of an ISO time. */
  age: (iso: string) => string;
  /** Draws images in bodies; without it they are one `▣ alt` line. */
  images?: ImageEnv;
}

const pad = (n: number): Span[] => (n ? [{ text: " ".repeat(n), style: "plain" }] : []);
/** Shift a row right by `n` columns. A railed row moves its rail too (`indent` pads before it), so nested rails stay under their head. */
const indentRow = (r: RL, n: number): RL => {
  if (!n) return r;
  if (r.t === "image" || r.t === "images") return r.rail ? { ...r, railIndent: (r.railIndent ?? 0) + n } : { ...r, indent: r.indent + n };
  if ((r.t === "text" || r.t === "gap") && r.rail) return { ...r, indent: (r.indent ?? 0) + n };
  return r.t === "head" ? { ...r, left: [...pad(n), ...r.left] } : r.t === "text" ? { ...r, spans: [...pad(n), ...r.spans] } : r;
};

function convoHead(e: ConversationEntry, level: Level, x: RowCtx): RL {
  const c = parseComment(e.body);
  const tag = lowSignalTag(e);
  const f = findingsSpan(e.findings);
  const left: Span[] = [
    { text: `${level === 0 ? CLOSED : OPEN} `, style: "muted" },
    ...(e.isBot ? [{ text: `${shortAuthor(e.author)} bot`, style: "muted" as const }] : [{ text: shortAuthor(e.author), style: "author" as const }]),
    { text: `  ${x.age(e.createdAt)}`, style: "muted" },
    ...(e.state && STATE_SPAN[e.state] ? [{ text: "  ", style: "plain" as const }, STATE_SPAN[e.state]!] : []),
    ...(f ? [{ text: "  ", style: "plain" as const }, f] : []),
    ...(level === 0 ? [{ text: `  ${preview(c)}`, style: "muted" as const }] : []),
    ...(tag ? [{ text: `  ${tag}`, style: "muted" as const }] : []),
  ];
  return { t: "head", left: level === 0 ? clipSpans(left, x.w) : left, muted: level === 0 && !!tag };
}

/** An expanded body carries a rail: the author's colour for a human, faint for a bot (the block's `who`). */
export function convoRows(e: ConversationEntry, level: Level, x: RowCtx): RL[] {
  if (level === 0) return [convoHead(e, 0, x)];
  return [convoHead(e, level, x), ...bodyRows(e.body, level, x.w, undefined, undefined, false, x.images).map(withRail)];
}

const withRail = (r: RL): RL => (r.t === "text" || r.t === "gap" || r.t === "image" || r.t === "images" ? { ...r, rail: true } : r);

const locOf = (th: ReviewThread): string => (th.path ? `${th.path}${th.line ? `:${th.line}` : ""}` : "");

/** Resolved ✓ green, open ● ink, outdated (unresolved) ◌ muted. */
const statusSpan = (th: ReviewThread): Span => (th.isResolved ? { text: "✓", style: "add" } : th.isOutdated ? { text: "◌", style: "muted" } : { text: "●", style: "plain" });
const SEVERITY_STYLE: Record<Severity, Span["style"]> = { high: "del", medium: "warn", low: "muted" };

/** The one-line thread row: status · severity dot · title, `file:line` on the right. Open threads trail a muted who-flagged suffix when room allows. */
function threadHead(th: ReviewThread, level: Level, x: RowCtx, nested: boolean): RL {
  const first = th.comments[0];
  const { severity, title } = first ? parseSeverity(parseComment(first.body)) : { severity: null, title: "" };
  const ind = nested ? NEST : 0;
  const right = th.path ? shortPath(locOf(th), Math.min(40, Math.floor((x.w - ind) / 3))) : "";
  const left: Span[] = [
    ...(nested ? [{ text: `${RAIL} `, style: "rail" as const }] : pad(ind)),
    statusSpan(th),
    { text: " ", style: "plain" },
    severity ? { text: "●", style: SEVERITY_STYLE[severity] } : { text: " ", style: "plain" },
    { text: ` ${title || "(empty comment)"}`, style: "plain" },
    ...(level === 0 && !th.isResolved ? [{ text: `  ${threadTrail(th, x.prAuthor).replace(/ · open$/, "")}`, style: "muted" as const }] : []),
  ];
  return { t: "head", muted: th.isResolved, left: clipSpans(left, x.w - ind - (right ? right.length + 2 : 0) + ind), right: right || undefined };
}

/** Muted last line of an expanded thread: conversation trail plus a cobalt `fix <sha>` token when a reply cites a commit. */
function trailRow(th: ReviewThread, x: RowCtx, ind: number): RL {
  const fix = threadFix(th);
  const spans: Span[] = [{ text: threadTrail(th, x.prAuthor), style: "muted" }];
  if (fix) spans.push({ text: ` ${SEP} `, style: "muted" }, { text: `fix ${fix.slice(0, 7)}`, style: "link" });
  return { t: "text", spans: clipSpans([...pad(ind), ...spans], x.w - NEST) };
}

/** A nested finding carries its review's rail: the reviewer's colour for a human review, faint for a bot one. */
export function threadRows(th: ReviewThread, level: Level, x: RowCtx, o: { nested: boolean; replying: boolean }): RL[] {
  const head = threadHead(th, level, x, o.nested);
  if (level === 0) return [head];
  const ind = o.nested ? NEST : 0;
  const bw = x.w - ind - NEST;
  const removed = suggestionTarget(th.diffHunk, th.line && th.startLine ? th.line - th.startLine + 1 : 1);
  const rows: RL[] = [head];
  th.comments.forEach((c, i) => {
    if (i > 0) rows.push({ t: "gap" });
    const name: Span = c.isBot ? { text: `${shortAuthor(c.author)} bot`, style: "muted" } : { text: shortAuthor(c.author), style: "bold" };
    rows.push({ t: "text", spans: [...pad(ind), name, { text: ` ${SEP} ${x.age(c.createdAt)}`, style: "muted" }] });
    for (const r of bodyRows(c.body, level, bw, undefined, removed, i === 0, x.images)) rows.push(indentRow(r, ind));
  });
  rows.push({ t: "gap" }, trailRow(th, x, ind));
  if (o.replying) rows.push({ t: "gap" }, { t: "input" });
  return o.nested ? rows.map((r, i) => (i === 0 ? r : withRail(r))) : rows;
}

export interface ActivityBlock {
  id: string;
  item: ActivityItem | BotFold;
  rows: RL[];
  /** Login whose colour accents this block (name + rail): a human author, or the human owner of a nested finding. */
  who: string | null;
}

/**
 * One block per entry, in display order, with nothing between blocks (see the spacing invariant above). An open fold lists its members
 * after its own row, indented one step and laid out that much narrower so they read as its children.
 */
export function activityLayout(
  items: ActivityRow[],
  o: { levelOf: (it: ActivityItem) => Level; isOpen?: (f: BotFold) => boolean; replyId: string | null } & RowCtx,
): ActivityBlock[] {
  const one = (item: ActivityItem, x: RowCtx): ActivityBlock => {
    const level = o.levelOf(item);
    if (item.kind === "convo") return { id: activityId(item), item, rows: convoRows(item.e, level, x), who: item.e.isBot ? null : item.e.author };
    const rows = threadRows(item.th, level, x, { nested: !!item.nested, replying: o.replyId === item.th.id });
    return { id: activityId(item), item, rows, who: item.owner ?? null };
  };
  const inner = { ...o, w: o.w - NEST };
  return items.flatMap((item) => {
    if (item.kind !== "bots") return [one(item, o)];
    const open = !!o.isOpen?.(item);
    const members = open ? item.members.map((m) => one(m, inner)).map((b) => ({ ...b, rows: b.rows.map((r) => indentRow(r, NEST)) })) : [];
    return [{ id: item.id, item, rows: [foldHead(item, open, o)], who: null }, ...members];
  });
}
