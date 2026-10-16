/** Sheet layer: renders the open sheet (force / review / stack / worktree / help). Sheets own their keys while mounted. */
import type { ScrollBoxRenderable, TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { describeBlocker, type CreatePrPlan, type RepoSlug, type MergeDryRun, type OpenResult, type ReviewEvent, type StackInfo } from "../service";
import { StkError, mergeOutcomeOk, mergeOutcomeText, type Blocker, type MergeMethod, type PlanStep, type StepResult } from "../types";
import { jobStatusText } from "../jobs";
import { isWaitable } from "../watch";
import { waitLabel } from "../waiting";
import { list as prList, planItems, prStatus, stackSummary, withExpectedRebases, worktreeNote, type PrStateKind, type PrStatus } from "../stackview";
import { mergedPrs, stepStatuses } from "../jobview";
import { ConfirmSheet, OutputSheet } from "./confirm";
import { ImageSheet } from "./image-sheet";
import { PaletteSheet } from "./palette";
import { activeRepoKey, mergeMethodOf, useStore, useStoreInstance, type Outcome, type Sheet as SheetState } from "./store";
import { G, reducedMotion, useTermSize, useTheme, type GlyphName } from "./theme";
import { Pill, RowContext, Segmented, SectionLabel, Sheet, Txt, VIM_HELP, useVimNav, type Tone } from "./ui";

type Active = Exclude<SheetState, null>;

export function Sheets({ sheet }: { sheet: Active }) {
  switch (sheet.kind) {
    case "force":
      return <MergeSheet n={sheet.n} force />;
    case "merge":
      return <MergeSheet n={sheet.n} force={false} />;
    case "review":
      return <ReviewSheet n={sheet.n} initial={sheet.event} />;
    case "stack":
      return <StackSheet n={sheet.n} upTo={sheet.upTo} />;
    case "worktree":
      return <WorktreeSheet n={sheet.n} />;
    case "help":
      return <HelpSheet />;
    case "palette":
      return <PaletteSheet />;
    case "confirm":
      return <ConfirmSheet sheet={sheet} />;
    case "output":
      return <OutputSheet sheet={sheet} />;
    case "create-pr":
      return <CreatePrSheet plan={sheet.plan} repo={sheet.repo} />;
    case "image":
      return <ImageSheet sheet={sheet} />;
  }
}

// ---------- shared bits ----------

const isConfirm = (k: { name?: string; meta?: boolean; ctrl?: boolean }) => k.name === "return" || k.name === "enter";
/** ⌘⏎ (kitty `super`), with ctrl/meta+⏎ as fallback for terminals that don't report ⌘. */
const isChord = (k: { name?: string; meta?: boolean; ctrl?: boolean; option?: boolean; super?: boolean }) => isConfirm(k) && (k.super || k.meta || k.ctrl);

function useRepoMeta(): string | undefined {
  const repo = useStore((s) => s.repo);
  return repo ? `${repo.owner}/${repo.name}` : undefined;
}

/** One fixed-height row inside a sheet body. */
function Line({ children, selected }: { children?: ReactNode; selected?: boolean }) {
  const p = useTheme();
  if (!selected) {
    return (
      <box height={1} flexShrink={0} flexDirection="row" overflow="hidden">
        {children}
      </box>
    );
  }
  // Same filled selection as lists elsewhere, bleeding 2 cols into the sheet padding.
  return (
    <box height={1} flexShrink={0} flexDirection="row" overflow="hidden" backgroundColor={p.sel} marginLeft={-2} marginRight={-2} paddingLeft={2} paddingRight={2}>
      <RowContext.Provider value>{children}</RowContext.Provider>
    </box>
  );
}

const Gap = () => <box height={1} flexShrink={0} />;

/**
 * Key hints on the left, `Cancel esc` + the action pills right-aligned. When both don't fit on one row, the hints take their own
 * row and the pills wrap below (still right-aligned); when the pills alone are wider than the sheet, they wrap onto further rows.
 * Nothing overlaps the hints or runs past the sheet's edge.
 */
export function Footer({ left, cancel = "Cancel", children }: { left?: string; cancel?: string; children?: ReactNode }) {
  return (
    <box flexShrink={0} flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2} marginTop={1}>
      <Txt tone="muted">{left ?? ""}</Txt>
      <box flexDirection="row" flexWrap="wrap" justifyContent="flex-end" columnGap={2} flexShrink={1} maxWidth="100%" marginLeft="auto">
        <Txt tone="muted">{`${cancel} esc`}</Txt>
        {children}
      </box>
    </box>
  );
}

function Mono({ children }: { children: string }) {
  const p = useTheme();
  return (
    <box backgroundColor={p.wash} paddingLeft={1} paddingRight={1} height={1} flexShrink={0} overflow="hidden">
      <text fg={p.ink} wrapMode="none" truncate>
        {children}
      </text>
    </box>
  );
}

// ---------- blockers in plain words ----------

interface Entry {
  glyph: "x" | "o";
  label: string;
  detail: string;
  /** Cannot be bypassed by an admin merge. */
  hard: boolean;
}

const MAX_NAMES = 3;

function entriesOf(bs: Blocker[]): Entry[] {
  const out: Entry[] = [];
  const names = (label: string, glyph: "x" | "o", list: string[]) => {
    list.slice(0, MAX_NAMES).forEach((name) => out.push({ glyph, label, detail: name, hard: false }));
    if (list.length > MAX_NAMES) out.push({ glyph, label, detail: `+${list.length - MAX_NAMES} more`, hard: false });
  };
  for (const b of bs) {
    switch (b.kind) {
      case "checks":
        names("Check failing", "x", b.failing);
        names("Check running", "o", b.pending);
        break;
      case "review":
        out.push({
          glyph: "x",
          label: b.decision === "CHANGES_REQUESTED" ? "Changes requested" : "Review required",
          detail: b.decision === "CHANGES_REQUESTED" ? "a reviewer asked for changes" : "no approving review yet",
          hard: false,
        });
        break;
      case "threads":
        out.push({ glyph: "x", label: `${b.count} unresolved thread${b.count === 1 ? "" : "s"}`, detail: "", hard: false });
        break;
      case "base-not-trunk":
        out.push({ glyph: "x", label: "Base is not the trunk", detail: `targets ${b.base}`, hard: false });
        break;
      case "draft":
        out.push({ glyph: "x", label: "Draft", detail: "mark it ready for review first", hard: true });
        break;
      case "conflict":
        out.push({ glyph: "x", label: `Conflicts with ${b.base ?? "base"}`, detail: "resolve it on the branch first", hard: true });
        break;
      case "behind":
        out.push({ glyph: "o", label: b.count === null ? `Behind ${b.base}` : `${b.count} commit${b.count === 1 ? "" : "s"} behind ${b.base}`, detail: "update the branch", hard: false });
        break;
      case "checking":
        out.push({ glyph: "o", label: "Checking for conflicts…", detail: "mergeability not computed yet", hard: false });
        break;
      case "required-check":
        out.push({ glyph: "o", label: `Required check '${b.context}'`, detail: "hasn't run on this head", hard: false });
        break;
      case "blocked":
        out.push({ glyph: "x", label: "Blocked by repository rules", detail: b.codeOwner ? "code owner review may be missing" : "an admin can bypass", hard: false });
        break;
    }
  }
  return out;
}

/** Short, one-line summary of a PR's blockers for the stack chain. */
function blockerWords(bs: Blocker[]): string {
  const parts: string[] = [];
  for (const b of bs) {
    switch (b.kind) {
      case "checks":
        if (b.failing.length) parts.push(`${b.failing.length} failing check${b.failing.length === 1 ? "" : "s"}`);
        if (b.pending.length) parts.push(`${b.pending.length} pending check${b.pending.length === 1 ? "" : "s"}`);
        break;
      case "review":
        parts.push(b.decision === "CHANGES_REQUESTED" ? "changes requested" : "needs review");
        break;
      case "threads":
        parts.push(`${b.count} open thread${b.count === 1 ? "" : "s"}`);
        break;
      case "draft":
        parts.push("draft");
        break;
      case "conflict":
        parts.push(`conflicts with ${b.base ?? "base"}`);
        break;
      case "behind":
        parts.push(b.count === null ? `behind ${b.base}` : `${b.count} behind ${b.base}`);
        break;
      case "checking":
        parts.push("checking for conflicts…");
        break;
      case "required-check":
        parts.push(`required check '${b.context}' hasn't run`);
        break;
      case "blocked":
        parts.push("blocked by repository rules");
        break;
      case "base-not-trunk":
        parts.push(describeBlocker(b));
        break;
    }
  }
  return parts.join(", ");
}

function EntryLine({ e, note }: { e: Entry; note?: string }) {
  return (
    <Line>
      <box width={3} flexShrink={0}>
        <Txt tone={e.glyph === "x" ? "error" : "faint"}>{e.glyph === "x" ? G.cross : G.ring}</Txt>
      </box>
      <box width={24} flexShrink={0}>
        <Txt truncate>{e.label}</Txt>
      </box>
      <box flexGrow={1} flexShrink={1} overflow="hidden">
        <Txt tone="muted" truncate>
          {note ?? e.detail}
        </Txt>
      </box>
    </Line>
  );
}

// ---------- merge / force merge ----------

function MergeSheet({ n, force }: { n: number; force: boolean }) {
  const store = useStoreInstance();
  const pr = useStore((s) => s.prs[n]?.data?.pr);
  const meta = useRepoMeta();
  const p = useTheme();
  const method = useStore(mergeMethodOf);
  const [dry, setDry] = useState<Outcome<MergeDryRun> | null>(null);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setDry(null);
    void store.mergeDryRun(n, method, force).then((o) => live && setDry(o));
    return () => {
      live = false;
    };
  }, [store, n, method, force]);

  const can = !!dry && dry.ok && dry.value.wouldMerge && !working;
  // blocked only by things that can clear by themselves (pending checks, review, threads...): offer to wait for them
  const waitable = !force && !!dry && dry.ok && !dry.value.wouldMerge && isWaitable(dry.value.blockers) && !working;

  const whenReady = async () => {
    if (!waitable) return;
    setWorking(true);
    setErr(null);
    const o = await store.startMergeWhenReady(n, method, false);
    if (o.ok) {
      store.closeSheet();
      store.toast(`Waiting to merge #${n}`);
    } else {
      setWorking(false);
      setErr(o.error.message);
    }
  };

  const confirm = async () => {
    if (!can) return;
    setWorking(true);
    setErr(null);
    const o = await store.startMerge(n, method, force);
    if (o.ok) {
      store.closeSheet();
      store.toast(`Merging #${n} in the background`);
    }
    else {
      setWorking(false);
      setErr(o.error instanceof StkError && o.error.code === "blocked" ? `Blocked: ${o.error.message}` : o.error.message);
    }
  };

  useKeyboard((k) => {
    if (working) return;
    if (isConfirm(k)) void confirm();
    else if (k.name === "t" && !k.ctrl && !k.meta) store.cycleMergeMethod();
    else if (k.name === "w" && !k.ctrl && !k.meta) void whenReady();
  });

  const title = `${force ? "Force merge" : "Merge"} #${n}`;
  const base = pr?.baseRef ?? "the base branch";
  const what = pr ? `Merges “${pr.title}” into ${base}` : `Merges #${n} into ${base}`;
  const cmd = `gh pr merge ${n} --${method}${force ? " --admin" : ""}`;

  let body: ReactNode;
  if (!dry) {
    body = <Txt tone="muted">Checking what would be bypassed…</Txt>;
  } else if (!dry.ok) {
    body = <Txt tone="error">{dry.error.message}</Txt>;
  } else {
    const d = dry.value;
    const all = entriesOf(d.blockers);
    if (force && d.wouldMerge && d.bypass.length > 0) {
      body = (
        <>
          <text fg={p.ink}>{`${what} using admin rights. These will be bypassed:`}</text>
          <Gap />
          {entriesOf(d.bypass).map((e, i) => (
            <EntryLine key={i} e={e} />
          ))}
          <Gap />
          <Mono>{cmd}</Mono>
        </>
      );
    } else if (d.wouldMerge) {
      body = (
        <>
          <text fg={p.ink}>{force ? `${what}. Nothing is blocking it, so no admin rights are needed.` : `${what}.`}</text>
          <Gap />
          <Mono>{cmd}</Mono>
        </>
      );
    } else if (force) {
      body = (
        <>
          <text fg={p.ink}>This cannot be force-merged:</text>
          <Gap />
          {all
            .filter((e) => e.hard)
            .map((e, i) => (
              <EntryLine key={i} e={e} note="can’t bypass" />
            ))}
        </>
      );
    } else {
      body = (
        <>
          <text fg={p.ink}>This is blocked:</text>
          <Gap />
          {all.map((e, i) => (
            <EntryLine key={i} e={e} />
          ))}
          <Gap />
          <Txt tone="muted">{isWaitable(d.blockers) ? "w merges it when these clear · M force merges past what can be bypassed." : "Use M to force merge past what can be bypassed."}</Txt>
        </>
      );
    }
  }

  return (
    <Sheet title={title} meta={meta}>
      <Gap />
      {body}
      {err && (
        <>
          <Gap />
          <Txt tone="error">{err}</Txt>
        </>
      )}
      <Footer left={`t ${method}${waitable ? " · w merge when ready" : ""}`}>
        {waitable && <Pill label="Merge when ready" hint="w" variant="secondary" onPress={() => void whenReady()} />}
        <Pill
          label={working ? "Starting…" : force ? "Force merge" : "Merge"}
          hint={force ? "⌘⏎" : "⏎"}
          variant={force ? "secondary" : "primary"}
          disabled={!can}
          onPress={() => void confirm()}
        />
      </Footer>
    </Sheet>
  );
}

// ---------- review ----------

const EVENTS: { key: ReviewEvent; label: string }[] = [
  { key: "APPROVE", label: "Approve" },
  { key: "REQUEST_CHANGES", label: "Request changes" },
  { key: "COMMENT", label: "Comment" },
];
const EVENT_TITLE: Record<ReviewEvent, string> = { APPROVE: "Approve", REQUEST_CHANGES: "Request changes on", COMMENT: "Comment on" };

function ReviewSheet({ n, initial }: { n: number; initial: ReviewEvent }) {
  const store = useStoreInstance();
  const p = useTheme();
  const meta = useRepoMeta();
  const area = useRef<TextareaRenderable>(null);
  const [event, setEvent] = useState<ReviewEvent>(initial);
  const [insert, setInsert] = useState(initial !== "APPROVE");
  const [len, setLen] = useState(0);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    store.setInputFocused(insert);
  }, [store, insert]);
  useEffect(() => () => store.setInputFocused(false), [store]);

  const needsBody = event !== "APPROVE";
  const can = !working && (!needsBody || len > 0);

  const submit = async () => {
    const body = (area.current?.plainText ?? "").trim();
    if (working) return;
    if (needsBody && !body) {
      setErr(event === "COMMENT" ? "A comment needs text." : "Requesting changes needs a comment.");
      return;
    }
    setWorking(true);
    setErr(null);
    const o = await store.review(n, event, body);
    if (o.ok) store.closeSheet();
    else {
      setWorking(false);
      setErr(o.error.message);
    }
  };

  useKeyboard((k) => {
    if (working) return;
    if (insert) {
      if (k.name === "escape") {
        k.preventDefault();
        k.stopPropagation();
        setInsert(false);
      } else if (isChord(k)) {
        k.preventDefault();
        void submit();
      }
      return;
    }
    if (isConfirm(k)) void submit();
    else if (k.name === "i" || k.name === "a") setInsert(true);
    else if (k.name === "j" || k.name === "down" || k.name === "k" || k.name === "up") {
      const d = k.name === "j" || k.name === "down" ? 1 : -1;
      setEvent((e) => EVENTS[(EVENTS.findIndex((x) => x.key === e) + d + EVENTS.length) % EVENTS.length]!.key);
    }
  });

  return (
    <Sheet title={`${EVENT_TITLE[event]} #${n}`} meta={meta}>
      <Gap />
      <Segmented items={EVENTS} value={event} onChange={(k) => !working && setEvent(k)} />
      <Gap />
      <Txt tone="muted">{needsBody ? "Comment (required)" : "Comment (optional)"}</Txt>
      <box backgroundColor={p.wash} paddingLeft={1} paddingRight={1} height={6} flexShrink={0} onMouseDown={() => setInsert(true)}>
        <textarea
          ref={area}
          focused={insert && !working}
          height={6}
          textColor={p.ink}
          focusedTextColor={p.ink}
          backgroundColor={p.wash}
          focusedBackgroundColor={p.wash}
          placeholder={needsBody ? "Say what needs to change…" : "Add a note…"}
          placeholderColor={p.faint}
          onContentChange={() => setLen((area.current?.plainText ?? "").trim().length)}
        />
      </box>
      {err && (
        <>
          <Gap />
          <Txt tone="error">{err}</Txt>
        </>
      )}
      <Footer left={insert ? "esc normal mode" : "i edit · j/k event"}>
        <Pill
          label={working ? "Sending…" : EVENTS.find((e) => e.key === event)!.label}
          hint={insert ? "⌘⏎" : "⏎"}
          variant="primary"
          disabled={!can}
          onPress={() => void submit()}
        />
      </Footer>
    </Sheet>
  );
}

// ---------- stack merge ----------

type Phase = "plan" | "running" | "done" | "failed";

/** Greedy word wrap for sheet notes (plain text, one Line per row). */
function wrapText(t: string, width: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const w of t.split(/\s+/)) {
    if (cur && cur.length + 1 + w.length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

const prCount = (n: number) => `${n} PR${n === 1 ? "" : "s"}`;

const STATUS_VIEW: Record<PrStateKind, { glyph: GlyphName; tone: Tone }> = {
  approved: { glyph: "check", tone: "ok" },
  ready: { glyph: "check", tone: "ok" },
  "needs-review": { glyph: "half", tone: "warn" },
  changes: { glyph: "half", tone: "warn" },
  pending: { glyph: "ring", tone: "warn" },
  other: { glyph: "warn", tone: "warn" },
  failing: { glyph: "cross", tone: "error" },
  conflict: { glyph: "swap", tone: "error" },
  draft: { glyph: "hline", tone: "muted" },
  merged: { glyph: "check", tone: "merged" },
};

/** A job's `no-worktree` failure: the branches that need a worktree before the merge can start. */
function missingFrom(code: string | undefined, data: unknown): { pr: number; branch: string }[] {
  if (code !== "step-failed" && code !== "no-worktree") return [];
  const w = (data as { worktrees?: { pr: number; branch: string }[] } | undefined)?.worktrees;
  return Array.isArray(w) && w.every((x) => typeof x?.pr === "number" && typeof x.branch === "string") ? w : [];
}

export function StackSheet({ n, upTo }: { n: number; upTo?: number | "top" }) {
  const store = useStoreInstance();
  const { height: H } = useTermSize();
  const meta = useRepoMeta();
  const scroll = useRef<ScrollBoxRenderable>(null);
  const method = useStore(mergeMethodOf);
  const [force, setForce] = useState(false);
  const [info, setInfo] = useState<Outcome<StackInfo> | null>(null);
  const [planning, setPlanning] = useState(true);
  const [starting, setStarting] = useState(false);
  const [creatingWt, setCreatingWt] = useState(false);
  const [tick, setTick] = useState(0);
  const [replanTick, setReplanTick] = useState(0);
  const [startedId, setStartedId] = useState<string | null>(null);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [preview] = useState(() => store.stackPreview(n));
  /** Row cursor: starts on the PR the sheet was opened from. */
  const [selPr, setSelPr] = useState(n);
  /** Merge up to this PR; "top" = the whole stack. Defaults to the PR the sheet was opened on. */
  const [target, setTarget] = useState<number | "top">(upTo ?? n);

  const members: { number: number; title: string; isDraft: boolean }[] =
    info?.ok ? info.value.stack.prs.map((p) => ({ number: p.number, title: p.title, isDraft: p.isDraft })) : preview.map((e) => ({ number: e.number, title: e.title, isDraft: e.isDraft }));
  const topNum = members[members.length - 1]?.number ?? n;
  const targetNum = target === "top" ? topNum : target;
  // The job file is the source of truth: a running job shows even when this sheet was opened after it started.
  const job = useStore((s) => {
    const key = activeRepoKey(s);
    if (!key) return undefined;
    for (const pr of [targetNum, n]) {
      const j = s.jobs[`${key}#${pr}`];
      if (j?.kind === "stack-merge" || (j?.kind === "merge-when-ready" && j.stack)) return j;
    }
    return undefined;
  });
  // A rebase job of this stack: while it runs the sheet shows it, and when it ends the plan is made again.
  const rebaseJob = useStore((s) => {
    const key = activeRepoKey(s);
    const j = key ? s.jobs[`${key}#${n}`] : undefined;
    return j?.kind === "rebase-stack" ? j : undefined;
  });
  const [rebaseId, setRebaseId] = useState<string | null>(null);
  const rebasing = rebaseJob?.status === "running";
  const rebaseFailed = rebaseJob?.status === "failed" && rebaseJob.id === rebaseId;
  const dirtyWts: { path: string; files: string[] }[] =
    rebaseFailed && rebaseJob?.errorCode === "dirty-worktree" ? ((rebaseJob.errorData as { worktrees?: { path: string; files: string[] }[] } | undefined)?.worktrees ?? []) : [];
  const staleNote = info?.ok ? info.value.notes.find((x) => x.action === "rebase-stack") : undefined;
  const phase: Phase = !job || (job.status !== "running" && job.id !== startedId) ? "plan" : job.status === "running" ? "running" : job.status === "done" ? "done" : "failed";
  const results: StepResult[] = phase === "plan" ? [] : (job?.steps ?? []);
  // the one error the sheet shows: the failed merge job, else the rebase job, else a request that did not start
  const failMsg = phase === "failed" ? (job?.error ?? "The stack merge stopped.") : rebaseFailed && dirtyWts.length === 0 ? (rebaseJob?.error ?? "The stack rebase failed.") : startErr;

  useEffect(() => {
    if (phase !== "plan" || rebasing) return;
    let live = true;
    setPlanning(true);
    void store.stackInfo(n, method, force, target).then((o) => {
      if (!live) return;
      setInfo(o);
      setPlanning(false);
    });
    return () => {
      live = false;
    };
  }, [store, n, method, force, phase, target, rebasing, replanTick]);

  const waiting = planning || starting || creatingWt || rebasing || phase === "running";
  useEffect(() => {
    if (!waiting || reducedMotion()) return;
    const id = setInterval(() => setTick((t) => t + 1), 300);
    return () => clearInterval(id);
  }, [waiting]);

  const ok = info?.ok ? info.value : null;
  const plan = ok ? ok.plan : [];
  const forced = plan.some((s) => s.kind === "merge" && s.admin);
  const trunk = ok?.stack.trunk ?? null;
  // once a job exists the sheet shows the job's own plan (the one it computed at start), not the earlier preview
  const viewPlan = phase === "plan" ? withExpectedRebases(plan, ok?.stack.native === true) : (job?.plan ?? results.map((r) => r.step));
  const items = planItems(viewPlan, trunk ?? "the trunk", method);
  const landedPrs = phase === "plan" ? new Set<number>() : mergedPrs(results, job?.merged);
  const can = phase === "plan" && !planning && !!ok && plan.length > 0;
  const tidx = Math.max(0, members.findIndex((m) => m.number === targetNum));
  const wtOf = (pr: number) => ok?.rebaseWorktrees.find((w) => w.pr === pr);
  // branches that need a worktree before the merge can start: known up front, or named by the failed job
  const needWt: { pr: number; branch: string }[] =
    phase === "plan" ? (ok?.rebaseWorktrees.filter((w) => w.kind === "none") ?? []) : missingFrom(phase === "failed" ? job?.errorCode : undefined, job?.errorData);

  const confirm = async () => {
    if (staleNote) {
      setStartErr(null);
      const o = await store.startRebaseStack(n, { stash: dirtyWts.length > 0 });
      if (o.ok) setRebaseId(o.value.jobId);
      else setStartErr(o.error.message);
      return;
    }
    if (!can) return;
    setStartErr(null);
    setStarting(true);
    const o = await store.startStackMerge(targetNum, method, force);
    setStarting(false);
    if (o.ok) setStartedId(o.value.jobId);
    else setStartErr(o.error.message);
  };

  const createWorktrees = async () => {
    if (creatingWt || needWt.length === 0) return;
    setStartErr(null);
    setCreatingWt(true);
    for (const w of needWt) {
      const o = await store.openWorktree(w.pr, true);
      if (!o.ok) {
        setStartErr(o.error.message);
        setCreatingWt(false);
        return;
      }
    }
    setCreatingWt(false);
    setStartedId(null);
    setRebaseId(null);
    setReplanTick((t) => t + 1);
  };

  // The job is a merge-when-ready one that has not started merging: cancelling it is still possible.
  const waitingJob = job?.kind === "merge-when-ready" && job.status === "running" && job.waiting !== undefined ? job : undefined;
  // The plan stops only on things that clear by themselves (pending checks, missing review...): offer to wait for them.
  const stopBlockers = info?.ok && info.value.stop ? (info.value.blockers[info.value.stop.pr] ?? []) : [];
  const canWait = phase === "plan" && !planning && !force && !rebasing && stopBlockers.length > 0 && isWaitable(stopBlockers);

  const whenReady = async () => {
    if (!canWait || starting) return;
    setStartErr(null);
    setStarting(true);
    const o = await store.startMergeWhenReady(targetNum, method, true);
    setStarting(false);
    if (o.ok) setStartedId(o.value.jobId);
    else setStartErr(o.error.message);
  };

  // ⏎ on a row makes it the merge target; ⏎ on the target itself merges.
  const onOpen = () => {
    if (rebasing || phase !== "plan" || members.length === 0) return;
    if (selPr === targetNum) void confirm();
    else setTarget(selPr === topNum ? "top" : selPr);
  };

  useKeyboard((k) => {
    if (waitingJob && k.name === "c" && !k.ctrl && !k.meta) return void store.cancelMergeWhenReady(waitingJob.pr);
    if (phase === "running" || rebasing) return;
    if (k.ctrl || k.meta) return;
    if (k.name === "c" && needWt.length > 0) return void createWorktrees();
    if (isConfirm(k)) {
      if (phase === "done") store.closeSheet();
    } else if (phase === "failed" && k.name === "r") {
      setStartedId(null);
    } else if (phase === "plan") {
      if (k.name === "f") setForce((f) => !f);
      else if (k.name === "t") store.cycleMergeMethod();
      else if (k.name === "w") void whenReady();
    }
  });

  // Status of each plan line from the live results.
  const stepStat = stepStatuses(viewPlan, results, phase === "running");
  const status = (steps: number[]): "done" | "running" | "failed" | "pending" => {
    const st = steps.map((i) => stepStat[i]!);
    if (st.includes("failed")) return "failed";
    if (st.every((x) => x === "done")) return "done";
    return st.includes("running") || st.includes("done") ? (phase === "failed" ? "failed" : "running") : "pending";
  };

  const lines: ReactNode[] = [];
  const rowLine: number[] = [];
  const push = (node: ReactNode) => lines.push(<Line key={lines.length}>{node}</Line>);
  const text = (t: string, tone: Tone = "ink", bold?: boolean) =>
    push(
      <box flexGrow={1} flexShrink={1} overflow="hidden">
        <Txt tone={tone} bold={bold} truncate>
          {t}
        </Txt>
      </box>,
    );
  const wrapped = (t: string, tone: Tone = "ink", indent = 0) => {
    for (const l of wrapText(t, 78 - indent)) text(`${" ".repeat(indent)}${l}`, tone);
  };

  /** Merge order of each PR the plan lands (1 = first), by number. */
  const order: Record<number, number> = {};
  plan.filter((s) => s.kind === "merge").flatMap((s) => s.includes ?? [s.pr]).forEach((pr, i) => (order[pr] = i + 1));

  /** One stack member: status glyph, merge order, number, title, honest status; a detail line below. */
  const memberRow = (m: (typeof members)[number], i: number) => {
    const bs = ok?.blockers[m.number] ?? [];
    // the rule between the PRs that stay open (above) and the ones that merge (this row and below)
    if (i === tidx && tidx < members.length - 1) {
      push(
        <>
          <box width={3} flexShrink={0}>
            <Txt bold>{G.closed}</Txt>
          </box>
          <Txt bold>{`${G.hline}${G.hline} merge up to here `}</Txt>
          <Txt tone="faint">{G.hline.repeat(44)}</Txt>
        </>,
      );
    }
    const included = i <= tidx;
    const landed = landedPrs.has(m.number);
    const full = ok?.stack.prs.find((p) => p.number === m.number);
    const st: PrStatus | null = landed
      ? { kind: "merged", label: "merged", bypass: false, hard: false }
      : full
        ? prStatus(full, bs, force || forced)
        : m.isDraft
          ? { kind: "draft", label: "draft", bypass: false, hard: true }
          : null;
    const view = st ? STATUS_VIEW[st.kind] : null;
    const dim = !included && !landed;
    rowLine[i] = lines.length;
    lines.push(
      <Line key={lines.length} selected={phase === "plan" && m.number === selPr}>
        <box width={3} flexShrink={0}>
          <Txt tone={dim ? "faint" : (view?.tone ?? "faint")}>{view ? G[view.glyph] : G.ring}</Txt>
        </box>
        <box width={3} flexShrink={0}>
          <Txt tone={dim ? "faint" : "muted"}>{order[m.number] ? String(order[m.number]) : G.hline}</Txt>
        </box>
        <box width={7} flexShrink={0}>
          <Txt bold={included}>{`#${m.number}`}</Txt>
        </box>
        <box flexGrow={1} flexShrink={1} overflow="hidden">
          <Txt truncate tone={included ? "ink" : "faint"}>
            {m.title}
          </Txt>
        </box>
        <box flexShrink={0} paddingLeft={1}>
          <Txt tone={dim ? "faint" : (view?.tone ?? "faint")}>{dim ? "stays open" : st ? `${st.label}${st.bypass && !landed ? " · will bypass" : ""}` : ""}</Txt>
        </box>
      </Line>,
    );
    // the connector down to the PR below carries what else is worth knowing about this one
    const detail = [
      ...(m.number === n && upTo !== "top" ? ["opened here"] : []),
      ...(included && !landed && bs.filter((b) => b.kind !== "base-not-trunk").length > 1 ? [blockerWords(bs.filter((b) => b.kind !== "base-not-trunk"))] : []),
      ...(included && !landed ? (ok?.notes.filter((x) => x.pr === m.number).map((x) => x.text) ?? []) : []),
    ];
    push(
      <>
        <box width={3} flexShrink={0}>
          <Txt tone="faint">{G.vbar}</Txt>
        </box>
        <box flexGrow={1} flexShrink={1} overflow="hidden">
          <Txt tone="muted" truncate>{`   ${detail.join(" · ")}`}</Txt>
        </box>
      </>,
    );
  };

  if (rebasing && rebaseJob) {
    text(jobStatusText(rebaseJob), "ink");
  } else if (waitingJob) {
    text(jobStatusText(waitingJob), "ink");
    text(`Merges the stack up to #${waitingJob.pr} once nothing blocks it. Nothing is bypassed; gives up after 24 h or on a conflict.`, "muted");
  } else if (!info && phase !== "plan") {
    // Opened mid-job: no plan was made here, so show the job's own steps.
    text(job ? jobStatusText(job) : "", "ink");
    for (const r of results) text(`${r.ok ? G.check : G.cross} ${r.detail}`, r.ok ? "muted" : "error");
  } else if (info && !info.ok) {
    wrapped(info.error.message, "error");
  } else if (!info && members.length === 0) {
    text("Working out the plan…", "muted");
  } else {
    // Optimistic first paint (no plan yet): members the store already knows, status filling in once the plan lands.
    if (trunk) text([trunk, ...members.map((m) => `#${m.number}`)].join(` ${G.arrow === "->" ? "<-" : "←"} `), "ink", true);
    if (ok) {
      const summary = stackSummary({ trunk: ok.stack.trunk, method, plan, stop: ok.stop, above: members.slice(tidx + 1).map((m) => m.number) });
      wrapped(summary, planning ? "faint" : "ink");
    }
    push(<Gap />);
    push(<SectionLabel label="Stack" meta={trunk ? "top first · numbers are the merge order · ↑↓ picks how far to merge" : "working out the plan…"} />);
    // drawn bottom-to-top: the top PR first, the base branch at the bottom
    for (let i = members.length - 1; i >= 0; i--) memberRow(members[i]!, i);
    if (trunk) {
      push(
        <>
          <box width={3} flexShrink={0}>
            <Txt tone="muted">{G.dot}</Txt>
          </box>
          <box width={3} flexShrink={0} />
          <Txt bold>{trunk}</Txt>
          <Txt tone="muted">{"  base branch: everything lands here"}</Txt>
        </>,
      );
    }
    if (ok) {
      push(<Gap />);
      push(<SectionLabel label="Plan" meta={planning ? `${items.length} step${items.length === 1 ? "" : "s"} · ${waitLabel("updating plan", tick, reducedMotion())}` : `${items.length} step${items.length === 1 ? "" : "s"}`} />);
      if (items.length === 0) {
        text(planning ? "…" : force ? "Nothing can be merged." : "Nothing can be merged yet. Press f to plan a force merge.", planning ? "faint" : "error");
      }
      items.forEach((it, i) => {
        const st = status(it.steps);
        const glyph = st === "done" ? G.check : st === "failed" ? G.cross : st === "running" ? G.dot : G.ring;
        const tone: Tone = planning ? "faint" : st === "failed" ? "error" : st === "pending" ? "faint" : st === "done" ? "muted" : "ink";
        push(
          <>
            <box width={3} flexShrink={0}>
              <Txt tone={tone}>{glyph}</Txt>
            </box>
            <box flexGrow={1} flexShrink={1} overflow="hidden">
              <Txt tone={planning ? "faint" : st === "pending" ? "ink" : tone} truncate>
                {`${i + 1}. ${it.text}`}
              </Txt>
            </box>
          </>,
        );
        if (st === "running" && job?.progress && job.progress.phase !== "merged") {
          text(`     ${job.progress.phase === "enqueued" ? "queued by GitHub" : (job.progress.message ?? "waiting for GitHub")}`, "muted");
        }
        if (it.why) wrapped(it.why, "muted", 5);
        const wt = phase === "plan" && it.worktreePr !== undefined ? worktreeNote(wtOf(it.worktreePr)) : null;
        if (wt) wrapped(wt.text, wt.ok ? "faint" : "error", 5);
      });
      if (items.length > 0 && tidx < members.length - 1) {
        text(`${prList(members.slice(tidx + 1).map((m) => m.number))} will need a stack rebase before ${tidx === members.length - 2 ? "it merges" : "they merge"}.`, "muted");
      }
      if (!ok.stack.native && members.length > 1) {
        push(<Gap />);
        text("Tip: make this a GitHub stack to merge it in one request (:create-stack)", "faint");
      }
      for (const note of ok.notes) {
        push(<Gap />);
        for (const l of wrapText(note.fix, 76)) text(l, "muted");
      }
    }
  }

  const viewH = Math.max(3, Math.min(lines.length, H - 16, 26));
  const rowMode = phase === "plan" && members.length > 0;
  const selIdx = Math.max(0, members.findIndex((m) => m.number === selPr));
  // rows are drawn top PR first, so the cursor counts from the top of the stack
  const flip = (i: number) => members.length - 1 - i;
  const scrollTo = (c: number) => {
    if (rowMode) {
      const i = flip(c);
      setSelPr(members[i]?.number ?? selPr);
      scroll.current?.scrollTo(Math.max(0, (rowLine[i] ?? 0) - 1));
    } else {
      setCursor(c);
      scroll.current?.scrollTo(c);
    }
  };
  useVimNav({ count: rowMode ? members.length : lines.length, cursor: rowMode ? flip(selIdx) : cursor, setCursor: scrollTo, pageSize: viewH, enabled: true, sheet: true, onOpen });

  const count = info?.ok && plan.length > 0 ? plan.flatMap((s) => (s.kind === "merge" ? (s.includes ?? [s.pr]) : [])).length : tidx + 1;
  const what =
    members.length <= 1
      ? `#${targetNum}`
      : tidx === members.length - 1
        ? `stack (${prCount(count)})`
        : tidx === 0
          ? `#${targetNum} only`
          : `up to #${targetNum} (${prCount(count)})`;
  const label = `${force || forced ? "Force merge" : "Merge"} ${what}`;
  const title = phase === "done" ? `Stack #${job?.pr ?? topNum} finished` : `${force || forced ? "Force merge stack" : "Merge stack"} #${topNum}`;
  const keys =
    phase === "plan"
      ? `↑↓ pick · ⏎ merge up to here · f force · t ${method}${canWait ? " · w when ready" : ""}${needWt.length > 0 ? " · c create worktree" : ""}`
      : phase === "failed"
        ? `r plan again${needWt.length > 0 ? " · c create worktree" : ""}`
        : "";

  return (
    <Sheet title={title} meta={meta} width={84}>
      <Gap />
      <scrollbox ref={scroll} height={viewH} flexShrink={0} scrollY>
        <box flexDirection="column">{lines}</box>
      </scrollbox>
      {failMsg && dirtyWts.length === 0 && (
        <>
          <Gap />
          {wrapText(failMsg, 80).map((l, i) => (
            <Txt key={i} tone="error">{l}</Txt>
          ))}
        </>
      )}
      {phase === "done" && (
        <>
          <Gap />
          <Txt tone={mergeOutcomeOk(job?.outcome) ? "muted" : "error"}>{`${job ? mergeOutcomeText(job) : ""}. Esc or ⏎ to close.`}</Txt>
        </>
      )}
      {phase === "plan" && staleNote && !rebasing && dirtyWts.length === 0 && (
        <>
          <Gap />
          <Txt tone="muted">{`Rewrites and force-pushes ${prCount(members.length)}.`}</Txt>
        </>
      )}
      {dirtyWts.length > 0 && (
        <>
          <Gap />
          <Txt tone="error">Rebase stack didn't start: uncommitted changes in</Txt>
          {dirtyWts.map((d) => (
            <Txt key={d.path} tone="muted">{`  ${d.path}: ${d.files.slice(0, 4).join(", ")}${d.files.length > 4 ? ` +${d.files.length - 4}` : ""}`}</Txt>
          ))}
          <Txt tone="muted">⏎ stashes them, rebases, then restores them.</Txt>
        </>
      )}
      <Footer left={rebasing ? "runs in background · esc to close" : phase === "plan" || phase === "failed" ? keys : waitingJob ? "runs in background · c cancel waiting · esc to close" : phase === "running" ? "runs in background · esc to close" : ""} cancel={phase === "plan" && !rebasing ? "Cancel" : "Close"}>
        {needWt.length > 0 && !rebasing && <Pill label={creatingWt ? waitLabel("Creating", tick, reducedMotion()) : "Create worktree"} hint="c" variant="secondary" disabled={creatingWt} onPress={() => void createWorktrees()} />}
        {canWait && <Pill label="Merge when ready" hint="w" variant="secondary" disabled={starting} onPress={() => void whenReady()} />}
        {phase === "failed" && !rebasing && <Pill label="Plan again" hint="r" variant="primary" onPress={() => setStartedId(null)} />}
        {phase === "plan" && !rebasing && (
          <Pill
            label={starting ? waitLabel("Starting", tick, reducedMotion()) : planning ? waitLabel("Planning", tick, reducedMotion()) : staleNote ? (dirtyWts.length > 0 ? "Stash and rebase" : "Rebase stack") : label}
            hint="⏎"
            variant={staleNote ? "primary" : force || forced ? "secondary" : "primary"}
            disabled={starting || planning || creatingWt || needWt.length > 0 || (staleNote ? false : !can)}
            onPress={() => void confirm()}
          />
        )}
        {rebasing && <Pill label={waitLabel("Rebasing", tick, reducedMotion())} variant="secondary" disabled onPress={() => {}} />}
        {waitingJob && <Pill label="Cancel waiting" hint="c" variant="secondary" onPress={() => void store.cancelMergeWhenReady(waitingJob.pr)} />}
        {phase === "running" && !waitingJob && <Pill label={waitLabel("Merging", tick, reducedMotion())} variant="secondary" disabled onPress={() => {}} />}
      </Footer>
    </Sheet>
  );
}

// ---------- worktree ----------

function WorktreeSheet({ n }: { n: number }) {
  const store = useStoreInstance();
  const meta = useRepoMeta();
  const [res, setRes] = useState<Outcome<OpenResult> | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    let live = true;
    void store.openWorktree(n, false).then((o) => live && setRes(o));
    return () => {
      live = false;
    };
  }, [store, n]);

  const missing = !!res && res.ok && res.value.worktree === null;
  const create = async () => {
    if (!missing || creating) return;
    setCreating(true);
    const o = await store.openWorktree(n, true);
    setRes(o);
    setCreating(false);
  };

  useKeyboard((k) => {
    if (isConfirm(k)) {
      if (missing) void create();
      else store.closeSheet();
    }
  });

  let body: ReactNode;
  if (!res) body = <Txt tone="muted">Looking for a worktree…</Txt>;
  else if (!res.ok) body = <Txt tone="error">{res.error.message}</Txt>;
  else if (res.value.worktree === null) {
    const name = res.value.branch.replace(/\//g, "-");
    body = (
      <>
        <Txt>{`No worktree has ${res.value.branch} checked out.`}</Txt>
        <Gap />
        <Txt tone="muted">{`Create one next to the repo in .stk-worktrees/${name}`}</Txt>
        <Txt tone="muted">{`(git fetch origin ${res.value.branch}, then git worktree add).`}</Txt>
      </>
    );
  } else {
    body = (
      <>
        <Txt>{res.value.created ? `Created a worktree for ${res.value.branch}:` : `${res.value.branch} is checked out at:`}</Txt>
        <Gap />
        <Mono>{res.value.worktree}</Mono>
        <Gap />
        <Txt tone="muted">Open it in a new terminal tab:</Txt>
        <Mono>{`cd ${res.value.worktree}`}</Mono>
      </>
    );
  }

  return (
    <Sheet title={`Worktree #${n}`} meta={meta}>
      <Gap />
      {body}
      <Footer cancel="Close">
        {missing && <Pill label={creating ? "Creating…" : "Create worktree"} hint="⏎" variant="primary" disabled={creating} onPress={() => void create()} />}
      </Footer>
    </Sheet>
  );
}

// ---------- help ----------

const HELP: { label: string; keys: [string, string][] }[] = [
  {
    label: "Everywhere",
    keys: [
      [":  ctrl-k", "go to PR or run a command (:merge :approve :close …)"],
      ["/", "search this page"],
      ["n N", "next / previous match"],
      ["⌘⇧C", "copy the PR URL (page or selected row)"],
      ["?", "this help"],
      ["r", "refresh"],
      ["q", "quit"],
      ["esc", "close sheet / back"],
    ],
  },
  {
    label: "Board",
    keys: [
      ["⏎ l", "open PR"],
      ["1 2 3  tab", "switch scope"],
      ["/", "filter by title, branch, #"],
      ["w", "worktree"],
      ["S", "merge stack"],
      ["o", "open PR in browser"],
      ["d", "density"],
      ["R  :repo", "pick a repo (workspace board; :repo all returns)"],
    ],
  },
  {
    label: "PR",
    keys: [
      ["a", "approve"],
      ["x", "request changes"],
      ["C", "comment"],
      ["c", "reply to thread"],
      ["e", "resolve thread"],
      ["F", "fix thread / failing check with an omp agent (new tab)"],
      ["m", "merge"],
      ["M", "force merge"],
      ["t", "merge method"],
      ["S", "merge stack"],
      ["U", "update branch (when behind)"],
      ["w", "worktree"],
      ["o", "open comment (or PR) in browser"],
      ["⏎ l", "open file diff · expand comment or thread"],
      ["zo zc za", "expand / collapse / toggle"],
      ["zR zM", "expand all / collapse all"],
      ["B", "hide / show bot comments"],
      ["L", "hide / show noise + minimized"],
      ["/  n N", "search this page · next / previous match"],
    ],
  },
  { label: "Motion", keys: VIM_HELP },
  {
    label: "Go to PR (:)",
    keys: [
      ["type", "fuzzy match title, branch, author, repo"],
      ["123  owner/repo#9", "PR number here · any repo · or paste a URL"],
      ["merge approve close …", "commands act on this PR / the selected row; close and draft ask first"],
      ["↑ ↓  ctrl-n ctrl-p", "move"],
      ["⏎  esc", "open  close (backspace on empty too)"],
    ],
  },
  {
    label: "Sheets",
    keys: [
      ["⏎", "confirm"],
      ["⌘⏎", "confirm force merge"],
      ["t", "merge method"],
      ["f", "force (stack)"],
      ["j k", "options / scroll"],
      ["i  esc", "edit text / leave edit"],
    ],
  },
];

function HelpSheet() {
  const { height: H } = useTermSize();
  const scroll = useRef<ScrollBoxRenderable>(null);
  const [cursor, setCursor] = useState(0);

  const lines: ReactNode[] = [];
  HELP.forEach((sec, si) => {
    if (si > 0) lines.push(<Gap key={`g${si}`} />);
    lines.push(
      <Line key={`s${si}`}>
        <SectionLabel label={sec.label} />
      </Line>,
    );
    sec.keys.forEach(([k, d], i) => {
      lines.push(
        <Line key={`${si}.${i}`}>
          <box width={18} flexShrink={0}>
            <Txt bold>{k}</Txt>
          </box>
          <box flexGrow={1} flexShrink={1} overflow="hidden">
            <Txt tone="muted" truncate>
              {d}
            </Txt>
          </box>
        </Line>,
      );
    });
  });

  const viewH = Math.max(4, Math.min(lines.length, H - 14));
  const scrollTo = (c: number) => {
    setCursor(c);
    scroll.current?.scrollTo(c);
  };
  useVimNav({ count: lines.length, cursor, setCursor: scrollTo, pageSize: viewH, enabled: true, sheet: true });

  return (
    <Sheet title="Keys" meta={lines.length > viewH ? "j/k scroll" : undefined}>
      <Gap />
      <scrollbox ref={scroll} height={viewH} flexShrink={0} scrollY>
        <box flexDirection="column">{lines}</box>
      </scrollbox>
      <Footer cancel="Close" />
    </Sheet>
  );
}

// ---------- create PR ----------

const BODY_PREVIEW_LINES = 6;
const PUSH_NOTE = { none: "", new: "Pushes the branch to origin first", update: "Pushes new commits to origin first" } as const;

/** `:pr`: title (editable), base, body preview, draft toggle; ⏎ creates. */
function CreatePrSheet({ plan, repo }: { plan: CreatePrPlan; repo?: RepoSlug }) {
  const store = useStoreInstance();
  const p = useTheme();
  const meta = useRepoMeta();
  const [title, setTitle] = useState(plan.title);
  const [draft, setDraft] = useState(plan.draft);
  const [insert, setInsert] = useState(false);
  const [working, setWorking] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    store.setInputFocused(insert);
  }, [store, insert]);
  useEffect(() => () => store.setInputFocused(false), [store]);

  const can = !working && title.trim().length > 0;
  const submit = async () => {
    if (!can) return;
    setWorking(true);
    setErr(null);
    const o = await store.createPr({ ...plan, title, draft }, repo);
    if (o.ok) store.closeSheet();
    else {
      setWorking(false);
      setErr(o.error.message);
    }
  };

  useKeyboard((k) => {
    if (working) return;
    if (insert) {
      if (k.name === "escape") {
        k.preventDefault();
        k.stopPropagation();
        setInsert(false);
      } else if (isConfirm(k)) {
        k.preventDefault();
        if (isChord(k)) void submit();
        else setInsert(false);
      }
      return;
    }
    if (isConfirm(k)) void submit();
    else if ((k.name === "i" || k.name === "e") && !k.ctrl && !k.meta) setInsert(true);
    else if (k.name === "d" && !k.ctrl && !k.meta) setDraft((d) => !d);
  });

  const bodyLines = plan.body.split("\n");
  const shown = bodyLines.slice(0, BODY_PREVIEW_LINES);
  const note = PUSH_NOTE[plan.push];
  return (
    <Sheet title="Create pull request" meta={meta} width={80}>
      <Gap />
      <Line>
        <Txt tone="muted">{"Branch  "}</Txt>
        <Txt truncate>{plan.branch}</Txt>
      </Line>
      <Line>
        <Txt tone="muted">{"Base    "}</Txt>
        <Txt truncate>{plan.baseIsPr !== null ? `${plan.base}  (PR #${plan.baseIsPr}, stacked)` : plan.base}</Txt>
      </Line>
      <Gap />
      <Txt tone="muted">Title</Txt>
      <box backgroundColor={p.wash} paddingLeft={1} paddingRight={1} height={1} flexShrink={0} onMouseDown={() => setInsert(true)}>
        <input
          focused={insert && !working}
          value={title}
          onInput={setTitle}
          textColor={p.ink}
          focusedTextColor={p.ink}
          backgroundColor={p.wash}
          focusedBackgroundColor={p.wash}
          placeholder="Title"
          placeholderColor={p.faint}
          flexGrow={1}
        />
      </box>
      <Gap />
      <Txt tone="muted">{`Body · ${plan.commits.length} commit${plan.commits.length === 1 ? "" : "s"}`}</Txt>
      {shown.map((l, i) => (
        <Line key={i}>
          <Txt truncate>{l}</Txt>
        </Line>
      ))}
      {bodyLines.length > shown.length && <Txt tone="muted">{`… ${bodyLines.length - shown.length} more`}</Txt>}
      {note && (
        <>
          <Gap />
          <Txt tone="muted">{note}</Txt>
        </>
      )}
      {err && (
        <>
          <Gap />
          <Txt tone="error">{err}</Txt>
        </>
      )}
      <Footer left={`i edit title ${G.sep} d ${draft ? "draft ✓" : "draft"}`}>
        <Pill label={working ? "Creating…" : draft ? "Create draft" : "Create PR"} hint="⏎" variant="primary" disabled={!can} onPress={() => void submit()} />
      </Footer>
    </Sheet>
  );
}
