import { useEffect, useState } from "react";
import type { Check, CheckState, PrCommit, RepoSlug } from "../types";
import { repoKey, useStore, useStoreInstance } from "./store";
import { Clipped, toneColor } from "./ui";
import { G, useTheme, type Palette } from "./theme";

/** Glyph and color of a check state, as the current-head checks show them (green ✓, red ×, amber ●, muted ○). */
const checkMark = (p: Palette, state: CheckState): [string, string] =>
  state === "pass" ? [G.check, p.ok] : state === "fail" ? [G.cross, p.error] : state === "pending" ? [G.dot, p.warn] : [G.ring, p.muted];

export type HistoryItem =
  | { id: "commits"; kind: "commits" }
  | { id: "commit-retry"; kind: "commit-retry" }
  | { id: string; kind: "commit"; commit: PrCommit }
  | { id: string; kind: "commit-check"; commit: PrCommit; check: Check };

/** Own lazy loading and nested folds without giving historical checks head-readiness semantics. */
export function useCommitHistory(n: number, repo: RepoSlug) {
  const store = useStoreInstance();
  const key = `${repoKey(repo)}#${n}`;
  const resource = useStore((s) => s.commitCache[key]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [expandAll, setExpandAll] = useState(false);
  useEffect(() => {
    store.setCommitsVisible(n, repo, open);
    return () => store.setCommitsVisible(n, repo, false);
  }, [open, key, store]);
  useEffect(() => {
    if (open && (!resource || resource.status === "idle")) void store.loadCommits(n, { repo });
  }, [open, resource?.status, key, store]);
  const commits = resource?.data ?? [];
  const isOpen = (sha: string) => expanded[sha] ?? expandAll;
  const searchItems: { item: HistoryItem; text: string }[] = [];
  const items: HistoryItem[] = [{ id: "commits", kind: "commits" }];
  for (const commit of commits) {
    const item: HistoryItem = { id: `commit:${commit.sha}`, kind: "commit", commit };
    searchItems.push({ item, text: `${commit.message}\n${commit.sha}\n${commit.author}` });
    if (open) items.push(item);
    commit.checks.forEach((check, i) => {
      const child: HistoryItem = { id: `commit-check:${commit.sha}:${i}`, kind: "commit-check", commit, check };
      searchItems.push({ item: child, text: `${check.name}\n${check.state}` });
      if (open && isOpen(commit.sha)) items.push(child);
    });
  }
  if (open && resource?.error) items.push({ id: "commit-retry", kind: "commit-retry" });
  return {
    open, setOpen, resource, commits, items, searchItems, isOpen,
    setCommitOpen(sha: string, value: boolean) { setExpanded((old) => ({ ...old, [sha]: value })); },
    foldAll(value: boolean) { setOpen(value); setExpandAll(value); setExpanded({}); },
    retry() { void store.loadCommits(n, { repo, force: true }); },
  };
}

const SLOT_ORDER: CheckState[] = ["fail", "pending", "pass", "skipped"];
const countOf = (checks: Check[], state: CheckState) => checks.filter((c) => c.state === state).length;

/** Shared column widths of the commit rows, so author, age and each check state line up down the list. */
export interface CommitColumns {
  author: number;
  age: number;
  /** One slot per state any commit has (worst first), wide enough for its glyph and largest count. */
  slots: { state: CheckState; w: number }[];
}

export function commitColumns(commits: PrCommit[], ageOf: (c: PrCommit) => string): CommitColumns {
  const slots = SLOT_ORDER.flatMap((state) => {
    const most = Math.max(0, ...commits.map((c) => countOf(c.checks, state)));
    return most ? [{ state, w: 1 + String(most).length }] : [];
  });
  return {
    author: Math.max(0, ...commits.map((c) => c.author.length)),
    age: Math.max(0, ...commits.map((c) => ageOf(c).length)),
    slots,
  };
}

/** `▸ sha  message …  author age  ×1 ✓2 ○7`: check counts only, colored by state; a commit with none leaves its slots blank. */
export function CommitRow({ commit, open, selected, age, cols }: { commit: PrCommit; open: boolean; selected: boolean; age: string; cols: CommitColumns }) {
  const p = useTheme();
  return (
    <box flexDirection="row" height={1} flexShrink={0}>
      <box flexDirection="row" flexShrink={0}>
        <text fg={toneColor(p, "faint", selected)}>{`${open ? G.open : G.closed} ${commit.sha.slice(0, 7)}  `}</text>
      </box>
      <box flexGrow={1} flexShrink={1} height={1} overflow="hidden">
        <Clipped text={commit.message} fg={toneColor(p, "ink", selected)} />
      </box>
      <box flexDirection="row" flexShrink={0} marginLeft={2}>
        <text wrapMode="none">
          <span fg={toneColor(p, "muted", selected)}>{`${commit.author.padEnd(cols.author)} ${age.padStart(cols.age)}`}</span>
          {cols.slots.map(({ state, w }) => {
            const n = countOf(commit.checks, state);
            const [glyph, fg] = checkMark(p, state);
            return <span key={state} fg={fg}>{`  ${(n ? `${glyph}${n}` : "").padEnd(w)}`}</span>;
          })}
        </text>
      </box>
    </box>
  );
}

export function CommitCheckRow({ check, selected }: { check: Check; selected: boolean }) {
  const p = useTheme();
  const [glyph, fg] = checkMark(p, check.state);
  const word = check.state === "pass" ? "passed" : check.state === "fail" ? "failed" : check.state === "pending" ? "pending" : "skipped";
  return (
    <box flexDirection="row" height={1} flexShrink={0} paddingLeft={2}>
      <box width={3} flexShrink={0}><text fg={fg}>{glyph}</text></box>
      <box flexGrow={1} flexShrink={1} height={1} overflow="hidden"><Clipped text={check.name} fg={toneColor(p, "muted", selected)} /></box>
      <box flexShrink={0} marginLeft={2}>
        <text wrapMode="none">
          <span fg={fg}>{word}</span>
          {check.url ? <span fg={toneColor(p, "muted", selected)}>{`   logs ${G.out}`}</span> : null}
        </text>
      </box>
    </box>
  );
}
