/**
 * Board screen: scope tabs, two-line rows, stacks as one flat unit (root, then members at one indent).
 * Repo scopes group Needs fixes / In review / Ready; the Session scope (PRs of one agent session, across repos)
 * groups Open / Merged / Closed and tags rows with their repo when more than one is involved.
 */
import type { ScrollBoxRenderable } from "@opentui/core";
import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { prReadiness, type BoardPr, type RepoSlug, type SessionPr } from "../service";
import type { Blocker } from "../types";
import { openInBrowser } from "./browser";
import { openStateSheet } from "./commands";
import { MergeJobStatus } from "./pr";
import { jobCovers } from "../jobs";
import { repoKey, useStore, useStoreInstance, type TuiScope } from "./store";
import { G, SPACE, clip, useLayout, useTheme } from "./theme";
import {
  Empty,
  ErrorState,
  KeyHints,
  Loading,
  Pill,
  Row,
  Scroll,
  Segmented,
  StatusGlyph,
  Txt,
  toneColor,
  useDoubleTap,
  useScreenKeys,
  useScrollFollow,
  useVimNav,
  useVimSearch,
  type Chrome,
  type StatusKind,
} from "./ui";

const REPO_SCOPES = [
  { key: "mine", label: "Mine" },
  { key: "review", label: "Review requests" },
  { key: "all", label: "All" },
] as const satisfies readonly { key: TuiScope; label: string }[];
const SESSION_SCOPE = { key: "session", label: "Session" } as const satisfies { key: TuiScope; label: string };

const REPO_GROUPS = [
  { id: 1, label: "Needs fixes" },
  { id: 2, label: "In review" },
  { id: 3, label: "Ready" },
] as const;
type TimeBucket = "today" | "yesterday" | "week" | "lastweek" | "month" | "older";
type GroupId = (typeof REPO_GROUPS)[number]["id"] | "open" | "merged" | "closed" | TimeBucket;

const TIME_BUCKETS: readonly { id: TimeBucket; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "week", label: "This week" },
  { id: "lastweek", label: "Last week" },
  { id: "month", label: "This month" },
  { id: "older", label: "Older" },
];

/** Board grouping: by last activity (default) or by current status. Shared by the board and its header (survives screen changes). */
type GroupMode = "time" | "status";
let groupMode: GroupMode = "time";
/** Time buckets whose merged/closed fold is expanded; lives as long as the process so the board remembers it. */
const foldOpen = new Set<string>();
let uiVersion = 0;
const uiListeners = new Set<() => void>();
const notifyUi = () => {
  uiVersion++;
  for (const l of uiListeners) l();
};
const toggleGroupMode = () => {
  groupMode = groupMode === "time" ? "status" : "time";
  notifyUi();
};
const setFolds = (buckets: readonly string[], open: boolean) => {
  for (const b of buckets) {
    if (open) foldOpen.add(b);
    else foldOpen.delete(b);
  }
  notifyUi();
};
/** Subscribes to grouping mode and fold changes; returns the change counter. */
const useUiVersion = (): number =>
  useSyncExternalStore(
    (cb) => {
      uiListeners.add(cb);
      return () => uiListeners.delete(cb);
    },
    () => uiVersion,
  );
const useGroupMode = (): GroupMode => {
  useUiVersion();
  return groupMode;
};

/** Local-time bucket of an ISO timestamp (weeks start Monday). */
function bucketOf(t: number, now: number): TimeBucket {
  if (Number.isNaN(t)) return "older";
  const d = new Date(now);
  const daysAgo = (n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - n).getTime();
  const sinceMonday = (d.getDay() + 6) % 7;
  if (t >= daysAgo(0)) return "today";
  if (t >= daysAgo(1)) return "yesterday";
  if (t >= daysAgo(sinceMonday)) return "week";
  if (t >= daysAgo(sinceMonday + 7)) return "lastweek";
  if (t >= new Date(d.getFullYear(), d.getMonth(), 1).getTime()) return "month";
  return "older";
}

const EMPTY_TEXT: Record<TuiScope, string> = {
  mine: "No open pull requests of yours.",
  review: "No review requests waiting on you.",
  all: "No open pull requests.",
  session: "No pull requests in this session yet.",
};

const SESSION_MISSING_TEXT = "No agent pane found. Run stk next to an omp pane, or pass --session-pane ID.";

/** A board row's PR: repo-scope PRs have no `repo` (they belong to the launch repo). */
type Entry = BoardPr & {
  repo?: RepoSlug;
  mergedAt?: SessionPr["mergedAt"];
  closedAt?: SessionPr["closedAt"];
};

/** Checks lane width: fits `○ 3 pending`. */
const CHECKS_W = 11;
const WT_W = 4;

interface Item {
  pr: Entry;
  /** Repo the PR lives in (launch repo for repo scopes). */
  repo: RepoSlug | null;
  /** Board cursor key `owner/name#n`. */
  key: string;
  depth: number;
  /** Number of the stack root (itself when unstacked or a root). */
  root: number;
  /** PR this one is stacked on, when that PR is on the board. */
  parent: number | null;
  /** Stack size, set on roots that have children. */
  stackSize: number;
  group: GroupId;
  /** Row y offset inside the scroll content. */
  y: number;
  /** Last row of its group (no hairline). */
  last: boolean;
  /** First row of its group. */
  first: boolean;
  /** Set on the collapsible `▸ N merged · M closed` row of a time bucket (its `pr` is the newest hidden PR; never act on it). */
  fold?: { bucket: TimeBucket; merged: number; closed: number; open: boolean };
}

const itemKey = (repo: RepoSlug | null, n: number) => `${repo ? repoKey(repo) : ""}#${n}`;

/**
 * Own group of a PR from the shared readiness verdict, ignoring the stack structure (a stacked base is not a
 * blocker here): 1 needs fixes, 3 ready, 2 in review / draft.
 */
function ownGroup(pr: BoardPr): 1 | 2 | 3 {
  const k = prReadiness(pr);
  if (k === "failing" || k === "changes" || k === "conflicts" || k === "threads") return 1;
  return k === "ready" ? 3 : 2;
}

const when = (t: Entry["mergedAt"]): number => (t ? new Date(t).getTime() : 0);

type Tree = { pr: Entry; depth: number; root: number; parent: number | null; fold?: Item["fold"] }[];

/** Stack trees of open PRs: children (baseRef = another PR's headRef, same repo) hang under that parent. */
function stackTrees(prs: Entry[], launch: RepoSlug | null): Tree[] {
  const repoOf = (pr: Entry) => pr.repo ?? launch;
  const byHead = new Map<string, Entry>();
  for (const pr of prs) byHead.set(`${itemKey(repoOf(pr), 0)}:${pr.headRef}`, pr);
  const parentOf = (pr: Entry): Entry | undefined => {
    const par = byHead.get(`${itemKey(repoOf(pr), 0)}:${pr.baseRef}`);
    return par && par.number !== pr.number ? par : undefined;
  };
  const key = (pr: Entry) => itemKey(repoOf(pr), pr.number);
  const children = new Map<string, Entry[]>();
  const roots: Entry[] = [];
  for (const pr of prs) {
    const par = parentOf(pr);
    if (par) children.set(key(par), [...(children.get(key(par)) ?? []), pr]);
    else roots.push(pr);
  }
  const seen = new Set<string>();
  const trees: Tree[] = [];
  const walk = (pr: Entry, root: number, parent: number | null, out: Tree) => {
    if (seen.has(key(pr))) return;
    seen.add(key(pr));
    // Stacks render flat: root on top, every other member at one indent level in stack order.
    out.push({ pr, depth: parent === null ? 0 : 1, root, parent });
    for (const c of children.get(key(pr)) ?? []) walk(c, root, pr.number, out);
  };
  for (const r of roots) {
    const out: Tree = [];
    walk(r, r.number, null, out);
    trees.push(out);
  }
  // Cycles (A based on B based on A) have no root: surface the leftovers as roots.
  for (const pr of prs) {
    if (seen.has(key(pr))) continue;
    const out: Tree = [];
    walk(pr, pr.number, null, out);
    trees.push(out);
  }
  return trees;
}

/**
 * Group PRs. `time` buckets by last activity (updatedAt); `status` groups Needs fixes / In review / Ready
 * (session: Open / Merged / Closed, newest first). Stacks (maximal base-chains over every entry) are placed as one
 * unit: in time mode by their most recent open member, in status mode by the root's group. Merged/closed members
 * inside a live stack stay with it; finished PRs outside one go to the merged fold / Merged / Closed groups.
 */
function buildModel(
  prs: Entry[],
  launch: RepoSlug | null,
  session: boolean,
  mode: GroupMode,
  now: number,
  expanded: ReadonlySet<string>,
): { groups: { id: GroupId; label: string; count: number; items: Item[] }[]; flat: Item[]; height: number } {
  const defs: { id: GroupId; label: string; trees: Tree[] }[] = [];
  const single = (pr: Entry): Tree => [{ pr, depth: 0, root: pr.number, parent: null }];
  const live = stackTrees(prs, launch).filter((t) => t.some((n) => n.pr.state === "OPEN"));
  const inLive = new Set<Entry>(live.flatMap((t) => t.map((n) => n.pr)));
  const rest = prs.filter((x) => !inLive.has(x));
  if (mode === "time") {
    const stamp = (t: Tree) => Math.max(0, ...t.filter((n) => n.pr.state === "OPEN").map((n) => Date.parse(n.pr.updatedAt) || 0));
    const open = [...live].sort((a, b) => stamp(b) - stamp(a));
    const finishedAt = (x: Entry) => (x.state === "MERGED" ? when(x.mergedAt) : when(x.closedAt)) || Date.parse(x.updatedAt) || 0;
    const fin = rest.sort((a, b) => finishedAt(b) - finishedAt(a));
    for (const b of TIME_BUCKETS) {
      const trees = open.filter((t) => bucketOf(stamp(t), now) === b.id);
      const here = fin.filter((x) => bucketOf(finishedAt(x), now) === b.id);
      const merged = here.filter((x) => x.state === "MERGED");
      const closed = here.filter((x) => x.state === "CLOSED");
      if (here.length > 0) {
        const isOpen = expanded.has(b.id);
        const fold = { bucket: b.id, merged: merged.length, closed: closed.length, open: isOpen };
        const kids = isOpen ? [...merged, ...closed].map((pr) => ({ pr, depth: 0, root: pr.number, parent: null })) : [];
        trees.push([{ pr: here[0]!, depth: 0, root: -1, parent: null, fold }, ...kids]);
      }
      defs.push({ id: b.id, label: b.label, trees });
    }
  } else if (session) {
    const done = (state: "MERGED" | "CLOSED") =>
      rest
        .filter((x) => x.state === state)
        .sort((a, b) => when(state === "MERGED" ? b.mergedAt : b.closedAt) - when(state === "MERGED" ? a.mergedAt : a.closedAt))
        .map(single);
    defs.push(
      { id: "open", label: "Open", trees: live },
      { id: "merged", label: "Merged", trees: done("MERGED") },
      { id: "closed", label: "Closed", trees: done("CLOSED") },
    );
  } else {
    for (const g of REPO_GROUPS) defs.push({ id: g.id, label: g.label, trees: live.filter((t) => ownGroup(t[0]!.pr) === g.id) });
  }

  let y = 0;
  const groups: { id: GroupId; label: string; count: number; items: Item[] }[] = [];
  for (const g of defs) {
    if (g.trees.length === 0) continue;
    const nodes = g.trees.flat();
    const items: Item[] = nodes.map((n, i, all) => {
      const repo = n.pr.repo ?? launch;
      return {
        pr: n.pr,
        repo,
        key: n.fold ? `fold:${n.fold.bucket}` : itemKey(repo, n.pr.number),
        depth: n.depth,
        root: n.root,
        parent: n.parent,
        stackSize: n.depth === 0 && !n.fold && all.some((m) => m.root === n.pr.number && m.depth > 0) ? all.filter((m) => m.root === n.pr.number).length : 0,
        group: g.id,
        fold: n.fold,
        y: 0,
        last: i === all.length - 1,
        first: i === 0,
      };
    });
    if (groups.length > 0) y += 1; // blank row between groups
    y += 2; // label + blank
    for (const it of items) {
      it.y = y;
      y += it.fold ? 1 : 2 + (it.last ? 0 : 1);
    }
    const folded = nodes.find((n) => n.fold)?.fold;
    const hidden = folded ? folded.merged + folded.closed : 0;
    groups.push({ id: g.id, label: g.label, count: items.filter((it) => !it.fold).length + (folded && !folded.open ? hidden : 0), items });
  }
  return { groups, flat: groups.flatMap((g) => g.items), height: y };
}

function statusOf(it: Item): StatusKind {
  if (it.pr.state === "MERGED") return "merged";
  if (it.pr.state === "CLOSED") return "closed";
  if (it.pr.isDraft) return "draft";
  const g = ownGroup(it.pr);
  return g === 1 ? "needs-fixes" : g === 3 ? "ready" : "review";
}

function checksText(pr: Entry): { text: string; tone: "error" | "muted" } | null {
  if (pr.state !== "OPEN") return null;
  const real = pr.checks.filter((c) => c.state !== "skipped");
  if (real.length === 0) return null;
  const failing = real.filter((c) => c.state === "fail").length;
  const pending = real.filter((c) => c.state === "pending").length;
  if (failing > 0) return { text: `${G.cross} ${failing}/${real.length}`, tone: "error" };
  if (pending > 0) return { text: `${G.ring} ${pending} pending`, tone: "muted" };
  return { text: `${G.check} ${real.length}/${real.length}`, tone: "muted" };
}

type BlockerTag = { label: string; severe: boolean };

/** The single most important thing to say on the meta line's right. */
function topBlocker(it: Item): BlockerTag | null {
  const pr = it.pr;
  if (pr.state !== "OPEN") return null;
  if (pr.isDraft) return { label: "draft", severe: false };
  const find = <K extends Blocker["kind"]>(k: K) => pr.blockers.find((b): b is Extract<Blocker, { kind: K }> => b.kind === k);
  if (find("conflict")) return { label: "conflict", severe: true };
  if (find("checking")) return { label: "checking", severe: false };
  if (find("required-check")) return { label: "check missing", severe: false };
  if (find("review")?.decision === "CHANGES_REQUESTED") return { label: "changes", severe: true };
  const threads = find("threads");
  if (threads) return { label: `${threads.count} ${threads.count === 1 ? "thread" : "threads"}`, severe: false };
  if (find("review")) return { label: "review", severe: false };
  const base = find("base-not-trunk");
  if (base && it.parent === null) return { label: `base ${clip(base.base, 18)}`, severe: false };
  if (find("behind")) return { label: "behind", severe: false };
  if (find("blocked")) return { label: "blocked", severe: false };
  return null;
}

/** `3d` / `5h` / `12m` since `t`; `now` for under a minute. */
function sinceText(t: Entry["mergedAt"], now: number): string {
  if (!t) return "";
  const s = Math.max(0, Math.round((now - new Date(t).getTime()) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/** `opened 3d ago` for recent PRs, `opened Oct 2` (plus year when not this year) from two weeks on. */
function openedText(createdAt: string, now: number): string {
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return "";
  if (now - t < 14 * 86400000) {
    const s = sinceText(createdAt, now);
    return s === "now" ? "opened just now" : `opened ${s} ago`;
  }
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear();
  return `opened ${new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) })}`;
}

const STATUS_WORD: Record<StatusKind, string> = {
  "needs-fixes": "needs fixes",
  review: "in review",
  ready: "ready",
  draft: "draft",
  merged: "merged",
  closed: "closed",
  fail: "",
  pending: "",
  pass: "",
  skipped: "",
};

function metaText(it: Item, wide: boolean, narrow: boolean, now: number, mode: GroupMode): string {
  const pr = it.pr;
  const parts = [`#${pr.number}`];
  if (it.parent !== null) parts.push(`on #${it.parent}`);
  // Queued PRs say so in every grouping; time grouping also needs the other open statuses per row.
  if (pr.state === "OPEN" && (pr.inMergeQueue || mode === "time")) parts.push(pr.inMergeQueue ? "queued" : STATUS_WORD[statusOf(it)]);
  parts.push(pr.author);
  const opened = openedText(pr.createdAt, now);
  if (opened) parts.push(opened);
  if (it.stackSize > 0) parts.push(`stack of ${it.stackSize}`);
  if (pr.state === "MERGED") parts.push(`merged ${sinceText(pr.mergedAt, now)} ago`.replace("now ago", "just now"));
  else if (pr.state === "CLOSED") parts.push(`closed ${sinceText(pr.closedAt, now)} ago`.replace("now ago", "just now"));
  else if (!wide && !narrow && it.parent === null) parts.push(pr.headRef);
  return parts.join(` ${G.sep} `);
}

function ago(at: number | undefined, now: number): string {
  if (!at) return "";
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function useNow(everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [everyMs]);
  return now;
}

/** Group label: UPPERCASE muted, faint leader, right count. (Label never shrinks.) */
function GroupLabel({ label, meta }: { label: string; meta: number }) {
  const p = useTheme();
  const { contentWidth } = useLayout();
  return (
    <box height={1} flexShrink={0} flexDirection="row">
      <box flexShrink={0}>
        <text fg={p.muted} wrapMode="none">{`${label.toUpperCase()} ${meta}`}</text>
      </box>
      <box flexGrow={1} flexShrink={1} height={1} overflow="hidden" marginLeft={1}>
        <text fg={p.faint} wrapMode="none">{G.leader.repeat(contentWidth)}</text>
      </box>
    </box>
  );
}

const plural = (n: number) => `${n} ${n === 1 ? "PR" : "PRs"}`;

interface BoardRowProps {
  it: Item;
  selected: boolean;
  /** Running merge job covering this PR (`merging` / `auto-merge`); replaces the blocker tag. */
  busy: string | null;
  titleW: number;
  wide: boolean;
  narrow: boolean;
  now: number;
  mode: GroupMode;
  showRepo: boolean;
  hasWt: boolean;
  compact: boolean;
  /** Double-click: put the cursor on the row, then do what Enter does (open the PR, or toggle a fold). */
  onActivate(it: Item): void;
}

const BoardRow = memo(function BoardRow({ it, selected, busy, titleW, wide, narrow, now, mode, showRepo, hasWt, compact, onActivate }: BoardRowProps) {
  const p = useTheme();
  const tap = useDoubleTap(() => onActivate(it));
  if (it.fold) {
    const f = it.fold;
    const parts = [f.merged ? `${f.merged} merged` : "", f.closed ? `${f.closed} closed` : ""].filter(Boolean);
    return (
      <box
        height={1}
        flexShrink={0}
        backgroundColor={selected ? p.sel : p.ground}
        marginLeft={-SPACE.bleed}
        marginRight={-SPACE.bleed}
        paddingLeft={SPACE.bleed}
        paddingRight={SPACE.bleed}
        {...tap}
      >
        <text fg={toneColor(p, "muted", selected)} wrapMode="none" truncate>{`${f.open ? "▾" : "▸"} ${parts.join(` ${G.sep} `)}`}</text>
      </box>
    );
  }
  const pr = it.pr;
  const checks = checksText(pr);
  const checksStr = (checks?.text ?? "").padStart(CHECKS_W);
  const checkFg = toneColor(p, checks?.tone ?? "muted", selected);
  const mutedFg = toneColor(p, "muted", selected);
  const branch = wide && pr.state === "OPEN" ? clip(pr.headRef, 26).padEnd(28) : wide ? " ".repeat(28) : "";
  const wt = hasWt ? (pr.worktree ? "  wt" : " ".repeat(WT_W)) : "";
  const done = pr.state !== "OPEN";
  const metaStr = `${showRepo && pr.repo ? `${pr.repo.name} ` : ""}${metaText(it, wide, narrow, now, mode)}`;
  const word = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.inMergeQueue ? "queued" : "";
  const at = word ? metaStr.lastIndexOf(word) : -1;
  const meta =
    at < 0 ? (
      metaStr
    ) : (
      <text wrapMode="none" truncate fg={mutedFg}>
        {metaStr.slice(0, at)}
        <span fg={pr.state === "MERGED" ? p.merged : pr.state === "CLOSED" ? p.closed : p.queued}>{word}</span>
        {metaStr.slice(at + word.length)}
      </text>
    );
  const titleRight = (
    <text wrapMode="none">
      <span fg={mutedFg}>{branch}</span>
      <span fg={checkFg}>{checksStr}</span>
      <span fg={mutedFg}>{wt}</span>
    </text>
  );
  const tag = busy ? { label: busy, severe: false } : topBlocker(it);
  const stackHint = selected && it.stackSize > 0;
  const tagNode = !tag ? null : tag.severe ? <Txt tone="error">{tag.label}</Txt> : <Pill label={tag.label} variant="neutral" />;
  const age = pr.updatedAt ? sinceText(pr.updatedAt, now) : "";
  const updated = mode === "status" && age ? (age === "now" ? "updated just now" : `updated ${age} ago`) : "";
  let right: React.ReactNode;
  if (stackHint) right = <Txt tone="cobalt">{`Merge stack S ${G.arrow}`}</Txt>;
  else if (tagNode && updated) {
    right = (
      <box flexDirection="row">
        {tagNode}
        <Txt tone="muted">{`  ${updated}`}</Txt>
      </box>
    );
  } else if (tagNode) right = tagNode;
  else if (updated) right = <Txt tone="muted" truncate>{updated}</Txt>;
  return (
    <Row
      selected={selected}
      depth={it.depth}
      titleTone={done ? "muted" : "default"}
      glyph={<StatusGlyph status={statusOf(it)} />}
      title={clip(pr.title, titleW)}
      titleRight={titleRight}
      meta={meta}
      right={right}
      hairline={!compact && !it.last}
      onOpen={() => onActivate(it)}
    />
  );
});

export function Board({ scope }: { scope: TuiScope }) {
  const store = useStoreInstance();
  const layout = useLayout();
  const session = scope === "session";
  const res = useStore((s) => (scope === "session" ? s.session : s.boards[scope]));
  const launch = useStore((s) => s.repo);
  const jobs = useStore((s) => s.jobs);
  const cursor = useStore((s) => s.boardCursor);
  const sessionPane = useStore((s) => s.sessionPane || s.sessionMissing);
  const sessionMissing = useStore((s) => s.sessionMissing);
  const data = res?.data;
  const [compact, setCompact] = useState(false);
  const sheet = useStore((s) => s.sheet);
  const scrollRef = useRef<ScrollBoxRenderable>(null);
  const now = useNow(30_000);
  const mode = useGroupMode();
  const ui = useUiVersion();
  const scopes = useMemo(() => (sessionPane ? [SESSION_SCOPE, ...REPO_SCOPES] : [...REPO_SCOPES]), [sessionPane]);

  const entries = useMemo<Entry[]>(() => {
    if (!data) return [];
    if ("groups" in data) return [...data.groups.open, ...data.groups.merged, ...data.groups.closed];
    return data.prs;
  }, [data]);
  const inWorkspace = useStore((s) => !!s.workspace && !s.workspace.focus);
  const repoCount = useMemo(() => new Set(entries.map((x) => (x.repo ? repoKey(x.repo) : ""))).size, [entries]);
  /** Multi-repo boards prefix each row's meta line with its repo (`widgets #1169 · …`), so rows scan by repo + number. */
  const showRepo = repoCount > 1 || (inWorkspace && entries.some((x) => x.repo));

  const search = useVimSearch({ enabled: !sheet });
  const query = search.query;
  const model = useMemo(
    () => buildModel(entries.filter((x) => search.matches(`${x.title} ${x.headRef} #${x.number} ${x.author} ${x.repo?.name ?? ""}`)), launch, session, mode, now, foldOpen),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, launch, session, query, mode, now, ui],
  );
  const flat = model.flat;
  const matchCount = query ? (flat.length === 1 ? "1 match" : `${flat.length} matches`) : "";
  const setSearchInfo = search.setInfo;
  useEffect(() => setSearchInfo(matchCount), [setSearchInfo, matchCount]);
  const idx = Math.max(0, flat.findIndex((x) => x.key === cursor));
  const sel = flat[idx];
  const hasWt = useMemo(() => entries.some((x) => x.worktree), [entries]);

  // A scope switch (not the initial mount, which restores the cursor on return from a PR) starts at the first row, scrolled to the top.
  const prevScope = useRef(scope);
  useEffect(() => {
    if (prevScope.current === scope) return;
    prevScope.current = scope;
    store.setBoardCursor(null);
    scrollRef.current?.scrollTo(0);
  }, [scope]);

  // Cursor follow: scrolloff margin, minimum scroll, glide on long jumps, anchored to the cursor key across refreshes; the wheel moves the viewport and only clamps the cursor at the edge.
  const follow = useScrollFollow(scrollRef, sel ? { key: sel.key, y: sel.y, h: sel.fold ? 1 : 2, lead: sel.first ? 2 : 0 } : null, {
    clampCursor: (top, bottom, dir) => {
      const fit = flat.filter((x) => x.y >= top && x.y + (x.fold ? 1 : 2) <= bottom);
      const it = dir === "up" ? fit[0] : fit[fit.length - 1];
      if (!it) return null;
      store.setBoardCursor(it.key);
      return it.key;
    },
  });

  const inBucket = (it: Item | undefined): it is Item & { group: TimeBucket } => !!it && TIME_BUCKETS.some((b) => b.id === it.group);
  /** Collapse buckets; a cursor on one of their hidden rows moves to the fold row. */
  const collapse = (buckets: readonly string[]) => {
    if (sel && inBucket(sel) && !sel.fold && sel.pr.state !== "OPEN" && buckets.includes(sel.group)) store.setBoardCursor(`fold:${sel.group}`);
    setFolds(buckets, false);
  };
  const open = (it: Item | undefined) => {
    if (!it) return;
    if (it.fold) {
      if (it.fold.open) collapse([it.fold.bucket]);
      else setFolds([it.fold.bucket], true);
    } else store.openPr(it.pr.number, it.repo ?? undefined);
  };
  const sectionStarts = useMemo(() => {
    let n = 0;
    return model.groups.map((g) => {
      const at = n;
      n += g.items.length;
      return at;
    });
  }, [model]);
  useVimNav({
    count: flat.length,
    cursor: idx,
    setCursor: (i) => {
      const it = flat[i];
      if (it) store.setBoardCursor(it.key);
    },
    pageSize: Math.max(2, Math.floor((layout.height - 8) / 3)),
    enabled: !sheet,
    onOpen: () => open(sel),
    onBack: () => {
      if (sel && inBucket(sel) && (sel.fold || sel.pr.state !== "OPEN")) collapse([sel.group]);
    },
    sectionStarts,
  });

  const zAt = useRef(0);
  useScreenKeys((k) => {
    if (k.ctrl || k.meta) return;
    if (zAt.current && Date.now() - zAt.current < 500) {
      zAt.current = 0;
      const here = mode === "time" && inBucket(sel) ? sel.group : null;
      const all = TIME_BUCKETS.map((b) => b.id);
      if (k.sequence === "o" && here) setFolds([here], true);
      else if (k.sequence === "c" && here) collapse([here]);
      else if (k.sequence === "a" && here) (foldOpen.has(here) ? collapse([here]) : setFolds([here], true));
      else if (k.sequence === "R" && mode === "time") setFolds(all, true);
      else if (k.sequence === "M" && mode === "time") collapse(all);
      return;
    }
    if (k.sequence === "z") {
      zAt.current = Date.now();
      return;
    }
    const scopeIdx = scopes.findIndex((s) => s.key === scope);
    if (k.name === "tab") store.setScope(scopes[(scopeIdx + (k.shift ? scopes.length - 1 : 1)) % scopes.length]!.key);
    else if (k.sequence === "R" && store.getState().workspace) store.openSheet({ kind: "palette", query: "repo " });
    else if (k.name === "w" && !k.shift && sel && !sel.fold) store.openSheet({ kind: "worktree", n: sel.pr.number, repo: sel.repo ?? undefined });
    else if (k.name === "p" && !k.shift && sel && !sel.fold) {
      // The command target is the stored cursor; bind it to the highlighted row (it may be unset or hidden by the filter).
      store.setBoardCursor(sel.key);
      openStateSheet(store);
    }
    else if ((k.name === "s" && k.shift) || k.sequence === "S") {
      if (!sel || sel.fold) return;
      const stacked = sel.parent !== null || sel.stackSize > 0;
      if (stacked) store.openSheet({ kind: "stack", n: sel.root, upTo: "top", repo: sel.repo ?? undefined });
      else store.toast("Not part of a stack", "info");
    } else if (k.name === "d" && !k.shift) setCompact((c) => !c);
    else if (k.sequence === "T") toggleGroupMode();
    else if (k.sequence === "o" && sel && !sel.fold) openInBrowser(store, sel.pr.url);
  });

  const wide = layout.mode === "wide";
  const narrow = layout.mode === "narrow";

  const lanes = (wide ? SPACE.branchLane + 2 : 0) + CHECKS_W + (hasWt ? WT_W : 0) + 2;
  const running = useMemo(() => Object.values(jobs).filter((j) => j.status === "running"), [jobs]);
  const busyTag = (it: Item): string | null => {
    const rowRepo = it.pr.repo ?? it.repo ?? launch;
    const job = rowRepo ? running.find((j) => jobCovers(j, rowRepo, it.pr.number)) : undefined;
    return job ? (job.kind === "merge-when-ready" && job.waiting !== undefined ? "auto-merge" : "merging") : null;
  };
  // Rows are memoized and get stable callbacks, so a cursor move re-renders the two rows whose selection changed, not the whole board.
  const openRef = useRef(open);
  openRef.current = open;
  const followRef = useRef(follow);
  followRef.current = follow;
  const activate = useCallback(
    (it: Item) => {
      // The one mouse path that moves the cursor: the view stays where it is instead of following the row.
      followRef.current.anchorItem({ key: it.key, y: it.y });
      store.setBoardCursor(it.key);
      openRef.current(it);
    },
    [store],
  );
  const renderRow = (it: Item) => (
    <BoardRow
      key={it.key}
      it={it}
      selected={!sheet && it === sel}
      busy={it.fold ? null : busyTag(it)}
      titleW={Math.max(8, layout.contentWidth - (3 * it.depth + 2) - lanes - 1)}
      wide={wide}
      narrow={narrow}
      now={now}
      mode={mode}
      showRepo={showRepo}
      hasWt={hasWt}
      compact={compact}
      onActivate={activate}
    />
  );

  return (
    <>
      <box height={1} flexShrink={0} flexDirection="row">
        <Segmented items={scopes} value={scope} onChange={(s) => store.setScope(s)} />
      </box>
      <box height={1} flexShrink={0} />
      {!data && res?.status === "error" ? (
        <ErrorState title="Couldn’t load pull requests" detail={res.error} />
      ) : !data ? (
        <Loading text="Loading pull requests" />
      ) : flat.length === 0 ? (
        <Empty text={query ? `No pull requests match /${query}` : session && sessionMissing ? SESSION_MISSING_TEXT : EMPTY_TEXT[scope]} />
      ) : (
        <Scroll scrollRef={scrollRef} onWheel={follow.onWheel}>
          {model.groups.map((g, gi) => (
            <box key={g.id} flexDirection="column" flexShrink={0}>
              {gi > 0 && <box height={1} />}
              <GroupLabel label={g.label} meta={g.count} />
              <box height={1} />
              {g.items.map(renderRow)}
            </box>
          ))}
        </Scroll>
      )}
      {data && "errors" in data && data.errors.length > 0 ? (
        <Txt tone="muted" truncate>{`couldn’t load: ${data.errors.map((e) => `${e.repo.owner}/${e.repo.name}`).join(", ")}`}</Txt>
      ) : null}
    </>
  );
}

/** Rows shown by a scope's board data (repo scope or session). */
function countOf(data: unknown): number | undefined {
  const d = data as { prs?: unknown[]; groups?: Record<"open" | "merged" | "closed", unknown[]> } | undefined;
  if (!d) return undefined;
  if (d.groups) return d.groups.open.length + d.groups.merged.length + d.groups.closed.length;
  return d.prs?.length;
}

export const boardChrome: Chrome = {
  HeaderRight() {
    const scope = useStore((s) => s.screen.scope);
    const res = useStore((s) => (scope === "session" ? s.session : s.boards[scope]));
    const now = useNow();
    const mode = useGroupMode();
    const n = countOf(res?.data);
    if (n === undefined) return null;
    const age = ago(res?.at, now);
    return <Txt tone="muted">{[plural(n), `by ${mode}`, age ? `updated ${age}` : ""].filter(Boolean).join(` ${G.sep} `)}</Txt>;
  },
  DockLeft() {
    const scope = useStore((s) => s.screen.scope);
    const res = useStore((s) => (scope === "session" ? s.session : s.boards[scope]));
    const repo = useStore((s) => s.repo);
    const busy = useStore((s) => s.busy);
    const job = useStore((s) => Object.values(s.jobs).find((j) => j.status === "running"));
    const n = countOf(res?.data);
    if (job) return <MergeJobStatus job={job} />;
    if (busy) return <Txt tone="muted">{`${busy}…`}</Txt>;
    if (res?.data && res.error) return <Txt tone="error">{`refresh failed: ${res.error}`}</Txt>;
    if (res?.refreshing) return <Txt tone="muted">refreshing…</Txt>;
    const name = scope === "session" ? "" : repo ? `${repo.owner}/${repo.name}` : "";
    const parts = [name, n === undefined ? "" : plural(n)].filter(Boolean);
    return <Txt tone="muted" truncate>{parts.join(` ${G.sep} `)}</Txt>;
  },
  DockRight() {
    const { mode } = useLayout();
    const workspace = useStore((s) => !!s.workspace);
    const repo: [string, string][] = workspace ? [["R", "repo"]] : [];
    return mode === "wide" ? (
      <KeyHints hints={[["j/k", "move"], ["⏎", "open"], ["w", "worktree"], ["p", "state"], ["S", "merge stack"], ["T", "group"], ...repo, ["/", "search"], ["?", "help"]]} />
    ) : (
      <KeyHints hints={[["j/k", "move"], ["⏎", "open"], ["w", "worktree"], ["p", "state"], ["S", "stack"], ["T", "group"], ...repo, ["?", "help"]]} />
    );
  },
};
