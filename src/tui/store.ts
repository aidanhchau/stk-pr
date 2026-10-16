/**
 * App state for the TUI: a tiny external store (no zustand) read through `useStore(selector)`.
 * All service calls go through here so loading/error state, stale-response guards and
 * post-mutation refreshes live in one place. Screens never call `service` directly.
 */
import { createContext, useContext, useRef, useSyncExternalStore } from "react";
import { startFix, type FixPr, type FixTarget } from "../agentfix";
import { exec } from "../exec";
import { agentPanes } from "../session";
import type { SearchLine } from "./ui";
import type { GhResult } from "../ghproxy";
import { dedupeItems, toItem, type PaletteItem } from "../fuzzy";
import { rateLimitReset, repoSlug, type FileDiff } from "../github";
import { discoverWorkspace, emptyWorkspaceMessage, homeLabel, type WorkspaceRepo } from "../repos";
import { listWorkspaceBoard, openWorkspaceCtx, type WorkspaceBoard } from "../workspace";
import {
  listBoard,
  merge,
  openCtx,
  openCtxForSlug,
  openWorktree,
  prDetail,
  prFiles,
  prCommits,
  reply,
  resolve,
  review,
  ghProxy,
  prAction,
  retargetBase,
  searchPalette,
  sessionPrs,
  stackInfo,
  createStack,
  createPullRequest,
  planCreatePr,
  planRerunRequired,
  planStackSubmit,
  rerunRequired,
  stackSubmit,
  type CreatePrPlan,
  type CreatePrResult,
  type RerunRequiredPlan,
  type RerunRequiredResult,
  type StackSubmitPlan,
  type StackSubmitResult,
  type Board,
  type BoardPr,
  type BoardScope,
  type Ctx,
  type MergeDryRun,
  type OpenResult,
  type PrAction,
  type PrDetail,
  type RepoSlug,
  type ReviewEvent,
  type CreateStackResult,
  type StackEntry,
  type StackInfo,
} from "../service";

/** Palette commands handled by the open PR page. */
export type PageCommandId = "toggle-bots" | "toggle-noise" | "fix";

/** setSearchLine owner of the `:` palette; its line wins over any screen search while the palette is open. */
export const PALETTE_LINE = "palette";

/** The session scope groups PRs by what happened to them in one agent session (across repos). */
/** Pane title without the leading icon glyph. */
export const cleanPaneTitle = (t: string): string => t.replace(/^[\p{Co}\p{Cf}\s]+/u, "").replace(/^[^\p{L}\p{N}]+/u, "").trim() || t;
export type SessionData = Awaited<ReturnType<typeof sessionPrs>>;
export type TuiScope = BoardScope | "session";

/** `owner/name`: the key of everything repo-scoped in the store. */
export type RepoKey = string;
export const repoKey = (r: RepoSlug): RepoKey => `${r.owner}/${r.name}`;
const prKey = (r: RepoKey, n: number) => `${r}#${n}`;
const PREFETCH_CONCURRENCY = 3;
const PREFETCH_FRESH_MS = 60_000;
const STACK_INFO_TTL_MS = 30_000;
const STACK_RECHECK_MS = 3_000;
const PREFETCH_BOARD_LIMIT = 12;
/** Max background prefetches per hour per process (GitHub rate). */
const PREFETCH_BUDGET = 60;
const PREFETCH_WINDOW_MS = 3_600_000;
const PREFETCH_DWELL_MS = 250;
import { STARTUP_NOTIFY_MS, cancelJob, claimNotify, claimStartupNotify, jobCovers, listJobs, startJob, watchJob, type Job } from "../jobs";
import { PrWatcher } from "./notify";
import { StkError, inContext, jobFailureText, mergeOutcomeOk, mergeOutcomeText, type MergeMethod, type PrCommit } from "../types";
import { loadPrefs, notifyMode, prefsPath, repoPrefs, savePrefs, withRepoPrefs, type NotifyMode, type Prefs } from "../prefs";
import { setReducedMotionPref } from "./theme";

export interface Resource<T> {
  status: "idle" | "loading" | "ready" | "error";
  data?: T;
  /** Message of the last failure (kept alongside stale `data` on refresh errors). */
  error?: string;
  errorCode?: StkError["code"] | "internal";
  /** Epoch ms of the last successful load. */
  at?: number;
  /** A background reload is in flight while `data` is still shown. */
  refreshing: boolean;
}

/** Item to land the cursor on when a PR page opens, kept at terminal `row` (opening a stack sibling keeps the stack under the cursor). */
export interface PrFocus {
  key: string;
  row: number;
}

export type Screen =
  | { kind: "board"; scope: TuiScope }
  | { kind: "pr"; n: number; repo: RepoSlug; scope: TuiScope; focus?: PrFocus };

export type Sheet =
  | null
  | { kind: "force"; n: number; repo?: RepoSlug; method?: MergeMethod }
  /** The plain merge sheet: shown for a PR blocked by something that can clear by itself, offering to merge when ready. */
  | { kind: "merge"; n: number; repo?: RepoSlug }
  | { kind: "review"; n: number; event: ReviewEvent; repo?: RepoSlug }
  | { kind: "stack"; n: number; repo?: RepoSlug; /** merge up to this PR (default: `n`, the PR the sheet was opened on); "top" = the whole stack */ upTo?: number | "top" }
  | { kind: "worktree"; n: number; repo?: RepoSlug }
  | { kind: "help" }
  | { kind: "palette"; /** initial command-line text */ query?: string }
  | { kind: "output"; title: string; command: string; output: string; code: number }
  | { kind: "create-pr"; plan: CreatePrPlan; repo?: RepoSlug }
  | { kind: "confirm"; title: string; body: string; label: string; onConfirm: () => void }
  | { kind: "image"; src: string; alt: string };

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "success" | "error";
}

/** A workspace board: the GitHub repos found under the launch directory (not itself inside a repo). */
export interface WorkspaceState {
  root: string;
  /** `~/projects/acme`-style path for the header. */
  label: string;
  repos: WorkspaceRepo[];
  /** The one repo picked with `:repo` (its normal board shows), or null for the workspace board. */
  focus: RepoSlug | null;
}

export interface AppState {
  repoDir: string;
  /** Set when the launch directory is not inside a GitHub repo and repos were found below it. */
  workspace: WorkspaceState | null;
  /** Context of the launch repo (null until open). Other repos' contexts live in the store's cache. */
  ctx: Ctx | null;
  /** Set once the Ctx is open; used for the header and terminal title. */
  repo: RepoSlug | null;
  /** Agent session (Tern pane id) the Session scope is about, when launched with one. */
  sessionPane: string | null;
  /** Display title of that pane. */
  sessionTitle: string | null;
  /** Agent panes `:session` can switch between (best first). */
  sessionCandidates: { id: string; title: string }[];
  /** Run inside Tern with no pane given and no agent pane found: the Session scope explains how to point stk at one. */
  sessionMissing: boolean;
  /** Session scope data (PRs mentioned in the session pane). */
  session: Resource<SessionData> | undefined;
  /** Error while opening the repo (not a repo, gh missing...). */
  fatal: string | null;
  screen: Screen;
  /** Board cache per repo scope (launch repo). */
  boards: Partial<Record<BoardScope, Resource<Board>>>;
  /** PR detail cache of the active repo (current PR screen, else the board cursor's repo, else launch) by number. */
  prs: Record<number, Resource<PrDetail>>;
  /** Diff cache of the active repo by `diffKey(n, file)`. */
  diffs: Record<string, Resource<FileDiff>>;
  /** All PR details, keyed `owner/name#n`. */
  prCache: Record<string, Resource<PrDetail>>;
  /** All diffs, keyed `owner/name#n:file`. */
  diffCache: Record<string, Resource<FileDiff>>;
  /** Lazy commit histories, keyed `owner/name#n`; never shared across repositories. */
  commitCache: Record<string, Resource<PrCommit[]>>;
  /** Board cursor (`owner/name#n`) so Esc from a PR returns to the same row. */
  boardCursor: string | null;
  sheet: Sheet;
  toasts: Toast[];
  /** True while a text input has focus: global keys must not fire. */
  inputFocused: boolean;
  /** The line the dock shows: the `:` palette's while it is open, else the screen's `/` search (see setSearchLine), else null. */
  searchLine: SearchLine | null;
  /** Label of a running mutation (shows `working…` in docks), else null. */
  busy: string | null;
  /** Latest merge job per PR (`owner/name#n`, running or just finished); fed by the job files, so it also reflects jobs from earlier TUI runs. */
  jobs: Record<string, Job>;
  /** Saved preferences (`prefs.json`): per-repo board tab and merge method, notification mode, reduced motion. */
  prefs: Prefs;
}

export const diffKey = (n: number, file: string) => `${n}:${file}`;

export type Outcome<T> = { ok: true; value: T } | { ok: false; error: StkError | Error };

const errInfo = (e: unknown): { error: string; errorCode: Resource<unknown>["errorCode"] } =>
  e instanceof StkError
    ? { error: e.message, errorCode: e.code }
    : { error: e instanceof Error ? e.message : String(e), errorCode: "internal" };

/** Board refresh period. */
const BOARD_POLL_MS = 120_000;

export interface StoreOptions {
  /** Open this PR's page first. */
  pr?: number;
  /** Launch repo by slug (no local clone needed). */
  gh?: RepoSlug;
  /** Tern pane of the agent session behind the Session scope. */
  sessionPane?: string;
  /** Preferences file; default `prefsPath()`, null keeps them in memory only. */
  prefsFile?: string | null;
}

const NO_REPO: RepoSlug = { owner: "", name: "" };

/** The repo the PR-scoped caches/actions currently refer to: current PR page, else cursor row, else launch. */
export function activeRepoKey(s: Pick<AppState, "screen" | "boardCursor" | "repo">): RepoKey | null {
  if (s.screen.kind === "pr") return repoKey(s.screen.repo);
  if (s.boardCursor) return s.boardCursor.slice(0, s.boardCursor.lastIndexOf("#"));
  return s.repo ? repoKey(s.repo) : null;
}

export const MERGE_METHODS: readonly MergeMethod[] = ["squash", "merge", "rebase"];

/** The remembered merge method of the active repo (default squash). */
export function mergeMethodOf(s: Pick<AppState, "prefs" | "screen" | "boardCursor" | "repo">): MergeMethod {
  const key = activeRepoKey(s);
  return (key && s.prefs.repos[key.toLowerCase()]?.mergeMethod) || "squash";
}

/** Every PR the store has loaded (all boards, session, cached details), deduped by repo+number. No network. */
export function paletteItems(s: Pick<AppState, "boards" | "session" | "prCache" | "repo">): PaletteItem[] {
  const lists: PaletteItem[][] = [];
  for (const b of Object.values(s.boards)) {
    if (!b.data) continue;
    const { repo } = b.data;
    // multi-repo boards tag rows with their own repo
    const rows: (BoardPr & { repo?: RepoSlug })[] = b.data.prs;
    lists.push(rows.map((pr) => toItem(repoKey(pr.repo ?? repo), pr)));
  }
  const g = s.session?.data?.groups;
  if (g) lists.push([...g.open, ...g.merged, ...g.closed].map((pr) => toItem(repoKey(pr.repo), pr)));
  lists.push(Object.values(s.prCache).flatMap((r) => (r.data ? [toItem(repoKey(r.data.repo), r.data.pr)] : [])));
  return dedupeItems(lists);
}

export class Store {
  private state: AppState;
  private listeners = new Set<() => void>();
  /** Latest request token per resource key; older responses are dropped. */
  private tokens = new Map<string, number>();
  private seq = 0;
  private toastSeq = 0;
  private timer: NodeJS.Timeout | undefined;
  /** Context per repo key (in-flight opens are shared). */
  private ctxs = new Map<RepoKey, Promise<Ctx>>();
  private launchKey: RepoKey | null = null;
  private launchSlug: RepoSlug | undefined;
  /** Where preferences persist; null = not at all. */
  private prefsFile: string | null;
  // PR detail prefetch: low-priority queue (concurrency PREFETCH_CONCURRENCY), deduped with user loads via `inflight`.
  private prefetchQueue: { key: string; repo: RepoSlug; n: number }[] = [];
  private prefetchActive = 0;
  private prefetchBudget = PREFETCH_BUDGET;
  private prefetchWindowAt = Date.now();
  /** Board rows' `updatedAt` by PR key; a cached detail with the same stamp is current. */
  private boardStamp = new Map<string, string>();
  /** Epoch ms until which GitHub is rate limited (0 = not). */
  private rateLimitedUntil = 0;
  private terminalFocused = true;
  private pollMissed = false;
  /** Diffs every refresh against the last snapshot of each PR and announces changes (toast or macOS notification). */
  private watcher = new PrWatcher({
    toast: (text, kind) => void this.toast(text, kind),
    focused: () => this.terminalFocused,
    mode: (focused) => this.notifyMode(focused),
    screenPr: () => (this.state.screen.kind === "pr" ? { repo: this.state.screen.repo, n: this.state.screen.n } : null),
  });
  private inflight = new Map<string, Promise<PrDetail>>();
  private commitInflight = new Map<string, Promise<void>>();
  /** Only expanded, mounted PR views opt into automatic history refreshes. */
  private visibleCommits = new Set<string>();
  /** Open PRs in display order (Next up first), for neighbour prefetch on cursor dwell. */
  private prefetchOrder: { repo: RepoSlug; n: number }[] = [];
  private dwellTimer: ReturnType<typeof setTimeout> | null = null;
  /** Job file watchers by job id, stopped when the job ends or the store is disposed. */
  private jobWatchers = new Map<string, () => void>();
  /** Stack merge plans by `owner/name#top:method:force`, with the member head shas they were planned on. */
  private stackInfoCache = new Map<string, { at: number; out: Outcome<StackInfo>; heads: [number, string][] }>();

  constructor(repoDir: string, initial: StoreOptions = {}) {
    this.launchSlug = initial.gh;
    this.prefsFile = initial.prefsFile === undefined ? prefsPath() : initial.prefsFile;
    const sessionPane = initial.sessionPane ?? null;
    const scope: TuiScope = sessionPane ? "session" : "mine";
    this.state = {
      repoDir,
      workspace: null,
      ctx: null,
      repo: initial.gh ?? null,
      sessionPane,
      sessionTitle: null,
      sessionCandidates: [],
      sessionMissing: false,
      session: undefined,
      fatal: null,
      screen: initial.pr ? { kind: "pr", n: initial.pr, repo: initial.gh ?? NO_REPO, scope } : { kind: "board", scope },
      boards: {},
      prs: {},
      diffs: {},
      prCache: {},
      diffCache: {},
      commitCache: {},
      boardCursor: initial.pr && initial.gh ? prKey(repoKey(initial.gh), initial.pr) : null,
      sheet: null,
      toasts: [],
      inputFocused: false,
      searchLine: null,
      busy: null,
      jobs: {},
      prefs: this.prefsFile ? loadPrefs(this.prefsFile) : { repos: {} },
    };
    setReducedMotionPref(this.state.prefs.reducedMotion ?? false);
  }

  // ---------- plumbing ----------

  getState = (): AppState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)) {
    const p = typeof patch === "function" ? patch(this.state) : patch;
    let next = { ...this.state, ...p };
    if (p.prCache) {
      for (const [key, resource] of Object.entries(p.prCache)) {
        const previousHead = this.state.prCache[key]?.data?.pr.headSha;
        const head = resource.data?.pr.headSha;
        if (head && previousHead && head !== previousHead && next.commitCache[key]) {
          this.tokens.set(`commits:${key}`, ++this.seq);
          this.commitInflight.delete(key);
          next.commitCache = { ...next.commitCache, [key]: { status: "idle", refreshing: false } };
        }
      }
    }
    // Number-keyed views (what pr.tsx / sheets.tsx read) of the active repo's caches.
    if ("prCache" in p || "diffCache" in p || "screen" in p || "boardCursor" in p || "repo" in p) {
      const key = activeRepoKey(next);
      const prs: AppState["prs"] = {};
      const diffs: AppState["diffs"] = {};
      if (key) {
        const pre = `${key}#`;
        for (const [k, v] of Object.entries(next.prCache)) if (k.startsWith(pre)) prs[Number(k.slice(pre.length))] = v;
        for (const [k, v] of Object.entries(next.diffCache)) if (k.startsWith(pre)) diffs[k.slice(pre.length)] = v;
      }
      next = { ...next, prs, diffs };
    }
    this.state = next;
    for (const l of this.listeners) l();
  }

  /**
   * Load a keyed resource. First load shows `loading`; reloads keep `data` and set `refreshing`.
   * A response is applied only if no newer request for the same key started meanwhile.
   */
  private async load<T>(
    key: string,
    read: () => Resource<T> | undefined,
    write: (r: Resource<T>) => void,
    fetch: () => Promise<T>,
  ): Promise<void> {
    const token = ++this.seq;
    this.tokens.set(key, token);
    const prev = read();
    write(prev?.data !== undefined ? { ...prev, refreshing: true } : { status: "loading", refreshing: false });
    try {
      const data = await fetch();
      if (this.tokens.get(key) === token) write({ status: "ready", data, at: Date.now(), refreshing: false });
    } catch (e) {
      if (this.tokens.get(key) !== token) return;
      this.noteRateLimit(e);
      const info = errInfo(e);
      write(prev?.data !== undefined ? { ...prev, ...info, status: "ready", refreshing: false } : { status: "error", ...info, refreshing: false });
    }
  }

  /** Repo of the PR page / cursor row / launch repo; actions called without a repo use this. */
  private activeRepo(): RepoSlug | null {
    const s = this.state;
    if (s.screen.kind === "pr") return s.screen.repo;
    if (s.boardCursor) {
      const key = activeRepoKey(s)!;
      const i = key.indexOf("/");
      return { owner: key.slice(0, i), name: key.slice(i + 1) };
    }
    return s.repo;
  }

  /** Context for a repo: the launch ctx, or one opened (and cached) by slug. */
  private ctxFor(repo: RepoSlug): Promise<Ctx> {
    const key = repoKey(repo);
    let p = this.ctxs.get(key);
    if (!p) {
      const local = this.workspaceRepo(key);
      p = local ? openWorkspaceCtx(exec, local) : openCtxForSlug(exec, repo.owner, repo.name);
      this.ctxs.set(key, p);
      p.catch(() => this.ctxs.delete(key));
    }
    return p;
  }

  // ---------- lifecycle ----------

  /** Open the launch repo context, load the first screen and start the 60 s board refresh. */
  async init(): Promise<void> {
    let ownRoot: string | null = null;
    try {
      let ctx: Ctx;
      let slug = this.launchSlug;
      if (slug) {
        ctx = await this.ctxFor(slug);
      } else {
        ctx = await openCtx(exec, this.state.repoDir);
        ownRoot = ctx.root;
        slug = ctx.slug ?? (await repoSlug(exec, ctx.root!));
        this.ctxs.set(repoKey(slug), Promise.resolve(ctx));
      }
      this.launchKey = repoKey(slug);
      this.set((s) => ({
        ctx,
        repo: slug,
        screen:
          s.screen.kind === "pr" && !s.screen.repo.owner
            ? { ...s.screen, repo: slug }
            : s.screen.kind === "board" && !s.sessionPane
              ? { kind: "board", scope: this.savedScope(slug) ?? s.screen.scope }
              : s.screen,
        boardCursor: s.screen.kind === "pr" && !s.boardCursor ? prKey(repoKey(slug), s.screen.n) : s.boardCursor,
      }));
    } catch (e) {
      // Not inside a GitHub repo: a workspace board over the repos below the directory, else the error.
      if (!this.launchSlug && (await this.enterWorkspace(errInfo(e).error, ownRoot))) {
        // workspace board; scopes below load through loadScope
      } else if (!this.state.sessionPane) {
        // A session board needs no launch repo; repo scopes then report it themselves.
        return;
      }
    }
    void this.loadSessionTitle();
    this.resumeJobs();
    const s = this.state.screen;
    await Promise.all([this.loadScope(s.scope), s.kind === "pr" ? this.loadPr(s.n) : Promise.resolve()]);
    this.timer = setInterval(() => this.poll(), BOARD_POLL_MS);
  }

  /**
   * Scan the launch directory for repos. Found: enter workspace mode (default scope Session inside Tern, else Mine)
   * and return true. None: set `fatal` (the open error plus what was searched) unless a session board can carry on.
   */
  private async enterWorkspace(openError: string, ownRoot: string | null): Promise<boolean> {
    const scan = await discoverWorkspace(this.state.repoDir).catch(() => null);
    // the launch dir is itself the only repo found: its own failure (gh offline...) is the error, not a workspace of one
    if (scan && ownRoot && scan.repos.length === 1 && scan.repos[0]!.dir === ownRoot) {
      if (!this.state.sessionPane) this.set({ fatal: openError });
      return false;
    }
    if (!scan || scan.repos.length === 0) {
      if (!this.state.sessionPane) this.set({ fatal: scan ? `${openError}\n\n${emptyWorkspaceMessage(scan)}` : `${openError}\n\nRun stk inside a clone, or pass --repo DIR or --gh owner/name.` });
      return false;
    }
    // Inside Tern the pane is the session; the Session scope then spans every repo the session mentions.
    const resolved = this.state.sessionPane ? { pane: this.state.sessionPane, missing: false } : await this.resolveSessionPane();
    const sessionPane = resolved.pane;
    const scope: TuiScope = sessionPane || resolved.missing ? "session" : "mine";
    this.set((s) => ({
      workspace: { root: scan.root, label: homeLabel(scan.root), repos: scan.repos, focus: null },
      sessionPane,
      sessionMissing: resolved.missing,
      screen: s.screen.kind === "board" ? { kind: "board", scope } : s.screen,
    }));
    return true;
  }

  /** Repo `owner/name` of the workspace, case-insensitively. */
  private workspaceRepo(key: RepoKey): WorkspaceRepo | undefined {
    const lc = key.toLowerCase();
    return this.state.workspace?.repos.find((r) => repoKey(r.slug).toLowerCase() === lc);
  }

  /** `:repo`: show one workspace repo's normal board (`slug`), or the workspace board again (null). */
  async setRepoFocus(slug: RepoSlug | null): Promise<void> {
    const ws = this.state.workspace;
    if (!ws) return;
    const found = slug ? this.workspaceRepo(repoKey(slug)) : null;
    if (slug && !found) return void this.toast(`${repoKey(slug)} is not in this workspace`, "error");
    const scope: TuiScope = found ? this.savedScope(found.slug) ?? "mine" : this.state.sessionPane || this.state.sessionMissing ? "session" : "mine";
    let ctx: Ctx | null = null;
    if (found) {
      try {
        ctx = await this.ctxFor(found.slug);
      } catch (e) {
        return void this.toast(errInfo(e).error, "error");
      }
    }
    this.set((s) => ({
      workspace: { ...ws, focus: found ? found.slug : null },
      ctx,
      repo: found ? found.slug : null,
      boards: {},
      boardCursor: null,
      screen: { kind: "board", scope },
      sheet: s.sheet?.kind === "palette" ? null : s.sheet,
    }));
    void this.loadScope(scope, { force: true });
  }

  /** Board refresh tick: skipped while rate limited, and while the terminal is unfocused (caught up on focus). */
  private poll(): void {
    if (this.rateLimited()) return;
    // an unfocused pane only keeps polling when notifications are on: they are why anyone wants fresh data now
    if (!this.terminalFocused && this.notifyMode(false) === "off") {
      this.pollMissed = true;
      return;
    }
    void this.refresh();
  }

  /** Terminal focus reports (xterm `CSI I` / `CSI O`): an unfocused pane does not poll GitHub. */
  setTerminalFocused(focused: boolean): void {
    this.terminalFocused = focused;
    if (focused && this.pollMissed) {
      this.pollMissed = false;
      this.poll();
    }
  }

  private rateLimited(): boolean {
    return Date.now() < this.rateLimitedUntil;
  }

  /** On a GitHub rate-limit error: stop polling and prefetching until the reset; cached data stays visible. */
  private noteRateLimit(e: unknown): void {
    const until = rateLimitReset(e);
    if (until === null) return;
    this.rateLimitedUntil = until;
    this.prefetchQueue.length = 0;
  }

  dispose(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    for (const stop of this.jobWatchers.values()) stop();
    this.jobWatchers.clear();
  }

  /** Agent pane for a stk run inside Tern without `--session-pane`: the best of `agentPanes` from `$TERN_PANE`. */
  private async resolveSessionPane(): Promise<{ pane: string | null; missing: boolean }> {
    const origin = process.env.TERN_PANE;
    if (!origin) return { pane: null, missing: false };
    const panes = await agentPanes(exec, origin).catch(() => []);
    const clean = (t: string) => cleanPaneTitle(t);
    this.set({ sessionCandidates: panes.map((p) => ({ id: p.id, title: clean(p.title) })), sessionTitle: panes[0] ? clean(panes[0].title) : null });
    return { pane: panes[0]?.id ?? null, missing: panes.length === 0 };
  }

  /** `:session`: point the Session scope at another agent pane. */
  setSessionPane(id: string): void {
    const c = this.state.sessionCandidates.find((x) => x.id === id);
    if (!c || id === this.state.sessionPane) return;
    this.set({ sessionPane: id, sessionTitle: c.title, sessionMissing: false, session: undefined, screen: { kind: "board", scope: "session" } });
    void this.loadScope("session", { force: true });
  }

  /** Pane title and the other agent panes from `tern ls --json`, best effort. */
  private async loadSessionTitle(): Promise<void> {
    const pane = this.state.sessionPane;
    if (!pane) return;
    try {
      const r = await exec(["tern", "ls", "--json"]);
      if (r.code !== 0) return;
      const found = this.findPaneTitle(JSON.parse(r.stdout), pane);
      if (found) this.set({ sessionTitle: cleanPaneTitle(found) });
      if (!this.state.sessionCandidates.length && process.env.TERN_PANE) {
        const panes = await agentPanes(exec, pane).catch(() => []);
        this.set({ sessionCandidates: panes.map((p) => ({ id: p.id, title: cleanPaneTitle(p.title) })) });
      }
    } catch {
      /* the header falls back to the pane id */
    }
  }

  private findPaneTitle(node: unknown, pane: string): string | null {
    if (Array.isArray(node)) {
      for (const x of node) {
        const t = this.findPaneTitle(x, pane);
        if (t) return t;
      }
    } else if (node && typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (String(o.id) === pane && typeof o.title === "string") return o.title;
      for (const v of Object.values(o)) {
        const t = this.findPaneTitle(v, pane);
        if (t) return t;
      }
    }
    return null;
  }

  // ---------- loading ----------

  /** Load whichever board a scope shows (repo list or session). */
  loadScope(scope: TuiScope, opts: { force?: boolean } = {}): Promise<void> {
    if (scope === "session") return this.loadSession(opts);
    const ws = this.state.workspace;
    return ws && !ws.focus ? this.loadWorkspaceBoard(scope, opts) : this.loadBoard(scope, opts);
  }

  /** Load the workspace board for a scope: one board query per discovered repo, merged; rows carry their repo. */
  async loadWorkspaceBoard(scope: BoardScope, opts: { force?: boolean } = {}): Promise<void> {
    const ws = this.state.workspace;
    if (!ws) return;
    if (this.state.boards[scope]?.data && !opts.force) return;
    await this.load<Board>(
      `board:${scope}`,
      () => this.state.boards[scope],
      (r) => {
        if (this.state.workspace?.focus) return; // a repo was picked while this loaded
        this.set((s) => ({ boards: { ...s.boards, [scope]: r } }));
        if (r.status === "ready" && !r.refreshing && r.data) {
          const failed = new Set(("errors" in r.data ? (r.data as WorkspaceBoard).errors : []).map((e) => repoKey(e.repo).toLowerCase()));
          this.observeBoard(scope, r.data.prs, null, ws.repos.map((x) => x.slug).filter((x) => !failed.has(repoKey(x).toLowerCase())));
          this.prefetchBoard(null, r.data.prs);
        }
      },
      () => listWorkspaceBoard((r) => this.ctxFor(r.slug), ws.repos, scope),
    );
  }

  /** Load the launch repo's board for a scope. Reuses the cache unless `force`. */
  async loadBoard(scope: BoardScope, opts: { force?: boolean } = {}): Promise<void> {
    const ctx = this.state.ctx;
    if (!ctx) {
      this.set((s) => ({
        boards: { ...s.boards, [scope]: { status: "error", error: "not inside a GitHub repository (run stk in one, or pass --repo DIR)", refreshing: false } },
      }));
      return;
    }
    const cur = this.state.boards[scope];
    if (cur?.data && !opts.force) return;
    await this.load<Board>(
      `board:${scope}`,
      () => this.state.boards[scope],
      (r) => {
        this.set((s) => ({
          boards: { ...s.boards, [scope]: r },
          repo: r.data?.repo ?? s.repo,
        }));
        if (r.status === "ready" && !r.refreshing && r.data) {
          this.observeBoard(scope, r.data.prs, r.data.repo, [r.data.repo]);
          this.prefetchBoard(r.data.repo, r.data.prs);
        }
      },
      () => listBoard(ctx, scope),
    );
  }

  /** Load the PRs of the agent session. */
  async loadSession(opts: { force?: boolean } = {}): Promise<void> {
    const pane = this.state.sessionPane;
    if (!pane) {
      // No agent pane found: an empty board whose empty state explains how to point stk at one.
      if (this.state.sessionMissing && !this.state.session?.data) this.set({ session: { status: "ready", data: { groups: { open: [], merged: [], closed: [] }, errors: [] }, refreshing: false } as Resource<SessionData> });
      return;
    }
    if (this.state.session?.data && !opts.force) return;
    await this.load<SessionData>(
      "session",
      () => this.state.session,
      (r) => {
        this.set({ session: r });
        if (r.status === "ready" && !r.refreshing && r.data) {
          this.watcher.observeRows([...r.data.groups.open, ...r.data.groups.merged, ...r.data.groups.closed], null);
          const open = r.data.groups.open;
          const next = open.filter((x) => x.rank?.next).sort((a, b) => b.rank.score - a.rank.score);
          const rest = open.filter((x) => !next.includes(x));
          this.prefetchBoard(null, [...next, ...rest]);
        }
      },
      () => sessionPrs(exec, pane),
    );
  }

  /** Load a PR's detail. Reuses the cache unless `force`; stale (>60 s) cached data renders now and refreshes in the background. */
  async loadPr(n: number, opts: { force?: boolean; repo?: RepoSlug } = {}): Promise<void> {
    const repo = opts.repo ?? this.activeRepo();
    if (!repo) return;
    const key = prKey(repoKey(repo), n);
    const cur = this.state.prCache[key];
    if (cur?.data && !opts.force) {
      if (cur.refreshing || this.inflight.has(key) || Date.now() - (cur.at ?? 0) < PREFETCH_FRESH_MS) {
        this.prefetchStack(repo, cur.data);
        return;
      }
    }
    // A prefetch for this PR is already running: reuse it instead of starting a second fetch.
    const running = this.inflight.get(key);
    if (running && !opts.force) {
      try {
        await running;
      } catch (e) {
        if (!this.state.prCache[key]?.data) this.set((s) => ({ prCache: { ...s.prCache, [key]: { status: "error", ...errInfo(e), refreshing: false } } }));
      }
      return;
    }
    let ctx: Ctx;
    try {
      ctx = await this.ctxFor(repo);
    } catch (e) {
      this.set((s) => ({ prCache: { ...s.prCache, [key]: { status: "error", ...errInfo(e), refreshing: false } } }));
      return;
    }
    let loaded = false;
    await this.load<PrDetail>(
      `pr:${key}`,
      () => this.state.prCache[key],
      (r) => {
        this.set((s) => ({ prCache: { ...s.prCache, [key]: r } }));
        if (r.status === "ready" && !r.refreshing && r.data) {
          loaded = !r.error;
          this.watcher.observeDetail(repo, n, r.data);
          this.prefetchStack(repo, r.data);
          this.recheckMergeability(repo, n, r.data);
        }
      },
      () => prDetail(ctx, n),
    );
    if (loaded && this.visibleCommits.has(key) && !this.rateLimited()) await this.loadCommits(n, { repo, force: true });
  }

  /** Register the expanded section while its PR view is mounted; cached history survives closing it. */
  setCommitsVisible(n: number, repo: RepoSlug, visible: boolean): void {
    const key = prKey(repoKey(repo), n);
    if (visible) this.visibleCommits.add(key);
    else this.visibleCommits.delete(key);
  }

  /** History is fetched on opening; only expanded, mounted sections refresh with PR detail. */
  async loadCommits(n: number, opts: { force?: boolean; repo?: RepoSlug } = {}): Promise<void> {
    const repo = opts.repo ?? this.activeRepo();
    if (!repo) return;
    const key = prKey(repoKey(repo), n);
    const running = this.commitInflight.get(key);
    if (running) return running;
    if (this.state.commitCache[key]?.data && !opts.force) return;
    const request = this.load<PrCommit[]>(
      `commits:${key}`,
      () => this.state.commitCache[key],
      (r) => this.set((s) => ({ commitCache: { ...s.commitCache, [key]: r } })),
      async () => {
        const checkCooldown = () => {
          if (this.rateLimited()) throw new StkError("GitHub rate limit reached · commit history paused until reset", "rate-limited", { resetAt: this.rateLimitedUntil });
        };
        checkCooldown();
        const ctx = await this.ctxFor(repo);
        checkCooldown();
        return prCommits(ctx, n);
      },
    );
    this.commitInflight.set(key, request);
    try {
      await request;
    } finally {
      if (this.commitInflight.get(key) === request) this.commitInflight.delete(key);
    }
  }

  /** Effective notification mode for a focus state (the saved preference, else toast while focused and system when not). */
  private notifyMode(focused: boolean): NotifyMode {
    return notifyMode(this.state.prefs, { focused });
  }

  /**
   * Feed a board refresh to the change watcher. Only the user's own and review boards count. A PR that left the own
   * board is looked up once (its detail then announces the merge / close, unless stk did it).
   */
  private observeBoard(scope: BoardScope, prs: (BoardPr & { repo?: RepoSlug })[], fallback: RepoSlug | null, covered: RepoSlug[]): void {
    if (scope === "all") return;
    for (const g of this.watcher.observeRows(prs, fallback, scope === "mine" ? covered : undefined)) void this.loadPr(g.n, { force: true, repo: g.repo });
  }

  /** PRs already given their one delayed refetch while GitHub computes mergeability. */
  private mergeabilityRetried = new Set<string>();

  /** A detail that says "checking for conflicts…" is refetched once, ~5 s later, when GitHub has had time to compute it. */
  private recheckMergeability(repo: RepoSlug, n: number, d: PrDetail): void {
    const key = prKey(repoKey(repo), n);
    if (!d.blockers?.some((b) => b.kind === "checking")) return void this.mergeabilityRetried.delete(key);
    if (this.mergeabilityRetried.has(key)) return;
    this.mergeabilityRetried.add(key);
    setTimeout(() => void this.loadPr(n, { force: true, repo }), 5000).unref?.();
  }

  // ---------- prefetch ----------

  /**
   * Queue PR details in the background (low priority, deduped). A PR whose cached detail carries the board row's
   * `updatedAt` has not changed and is never refetched; without a board row, a detail younger than PREFETCH_FRESH_MS
   * is kept. Each queued fetch spends the hourly budget; nothing is queued while rate limited.
   */
  private prefetch(repo: RepoSlug, n: number): void {
    const key = prKey(repoKey(repo), n);
    const cur = this.state.prCache[key];
    if (cur?.status === "loading" || cur?.refreshing || this.inflight.has(key) || this.rateLimited()) return;
    if (cur?.data) {
      const stamp = this.boardStamp.get(key);
      if (stamp !== undefined ? cur.data.pr.updatedAt === stamp : Date.now() - (cur.at ?? 0) < PREFETCH_FRESH_MS) return;
    }
    if (this.prefetchQueue.some((q) => q.key === key)) return;
    if (Date.now() - this.prefetchWindowAt >= PREFETCH_WINDOW_MS) {
      this.prefetchWindowAt = Date.now();
      this.prefetchBudget = PREFETCH_BUDGET;
    }
    if (this.prefetchBudget <= 0) return;
    this.prefetchBudget--;
    this.prefetchQueue.push({ key, repo, n });
    this.pumpPrefetch();
  }

  private pumpPrefetch(): void {
    while (this.prefetchActive < PREFETCH_CONCURRENCY && this.prefetchQueue.length > 0) {
      const job = this.prefetchQueue.shift()!;
      const cur = this.state.prCache[job.key];
      if (this.inflight.has(job.key) || cur?.status === "loading" || cur?.refreshing) continue;
      this.prefetchActive++;
      void this.runPrefetch(job).finally(() => {
        this.prefetchActive--;
        this.pumpPrefetch();
      });
    }
  }

  private async runPrefetch({ key, repo, n }: { key: string; repo: RepoSlug; n: number }): Promise<void> {
    const token = ++this.seq;
    // Same token slot as loadPr (`pr:${key}`), so a forced user load supersedes this prefetch and vice versa.
    this.tokens.set(`pr:${key}`, token);
    const p = this.ctxFor(repo).then((ctx) => prDetail(ctx, n));
    this.inflight.set(key, p);
    try {
      const data = await p;
      // Skip if a user-initiated load superseded this one.
      if (this.tokens.get(`pr:${key}`) !== token) return;
      this.set((s) => ({ prCache: { ...s.prCache, [key]: { status: "ready", data, at: Date.now(), refreshing: false } } }));
      this.watcher.observeDetail(repo, n, data);
      this.prefetchStack(repo, data);
      if (this.visibleCommits.has(key) && !this.rateLimited() && this.state.commitCache[key]?.status === "idle") void this.loadCommits(n, { repo, force: true });
    } catch (e) {
      this.noteRateLimit(e); // other failures are silent: a user open will load (and report errors) itself
    } finally {
      if (this.inflight.get(key) === p) this.inflight.delete(key);
    }
  }

  /** After the board loads: record each row's `updatedAt`, then warm open PRs in display order (up to PREFETCH_BOARD_LIMIT) whose detail is missing or older than their row. Never resets the budget. */
  private prefetchBoard(repo: RepoSlug | null, prs: (BoardPr & { repo?: RepoSlug })[]): void {
    for (const p of prs) {
      const r = p.repo ?? repo;
      if (r) this.boardStamp.set(prKey(repoKey(r), p.number), p.updatedAt);
    }
    // Display order approximation: stack trees (root first, then children), newest tree first.
    const open = prs.filter((p) => p.state === "OPEN");
    const heads = new Map(open.map((p) => [p.headRef, p]));
    const kids = new Map<BoardPr, BoardPr[]>();
    const roots: BoardPr[] = [];
    for (const p of open) {
      const parent = heads.get(p.baseRef);
      if (parent && parent !== p) kids.set(parent, [...(kids.get(parent) ?? []), p]);
      else roots.push(p);
    }
    const walk = (p: BoardPr): BoardPr[] => [p, ...(kids.get(p) ?? []).flatMap(walk)];
    const stamp = (t: BoardPr[]) => Math.max(...t.map((p) => Date.parse(p.updatedAt) || 0));
    const trees = roots.map(walk);
    // Session boards arrive already ordered (Next up first); keep it. Repo boards: newest tree first.
    if (repo) trees.sort((a, b) => stamp(b) - stamp(a));
    this.prefetchOrder = trees.flat().flatMap((p) => {
      const r = (p as BoardPr & { repo?: RepoSlug }).repo ?? repo;
      return r ? [{ repo: r, n: p.number }] : [];
    });
    for (const x of this.prefetchOrder.slice(0, PREFETCH_BOARD_LIMIT)) this.prefetch(x.repo, x.n);
  }

  /** When the PR on screen has a stack, warm the other members (nearest first). */
  private prefetchStack(repo: RepoSlug, d: PrDetail): void {
    const s = this.state.screen;
    if (s.kind !== "pr" || s.n !== d.pr.number || repoKey(s.repo) !== repoKey(repo) || !d.stack) return;
    const at = d.stack.prs.indexOf(d.pr.number);
    const others = d.stack.entries.filter((e) => e.number !== d.pr.number && e.state === "OPEN");
    others.sort((a, b) => Math.abs(d.stack!.prs.indexOf(a.number) - at) - Math.abs(d.stack!.prs.indexOf(b.number) - at));
    for (const e of others) this.prefetch(repo, e.number);
  }

  /** Cursor dwell: warm the PR under the cursor and its neighbours. */
  private scheduleDwellPrefetch(key: string | null): void {
    if (this.dwellTimer) clearTimeout(this.dwellTimer);
    this.dwellTimer = null;
    const m = key ? /^(.+)\/([^/#]+)#(\d+)$/.exec(key) : null;
    if (!m) return;
    const owner = m[1]!, name = m[2]!, n = Number(m[3]);
    this.dwellTimer = setTimeout(() => {
      this.dwellTimer = null;
      if (this.state.boardCursor !== key) return;
      const i = this.prefetchOrder.findIndex((x) => x.n === n && repoKey(x.repo) === `${owner}/${name}`);
      this.prefetch({ owner, name }, n);
      if (i >= 0) for (const x of [this.prefetchOrder[i - 1], this.prefetchOrder[i + 1]]) if (x) this.prefetch(x.repo, x.n);
    }, PREFETCH_DWELL_MS);
  }

  /** Load one file's patch (cached by repo + PR number + path). */
  async loadDiff(n: number, file: string, opts: { force?: boolean; repo?: RepoSlug } = {}): Promise<void> {
    const repo = opts.repo ?? this.activeRepo();
    if (!repo) return;
    const key = `${prKey(repoKey(repo), n)}:${file}`;
    if (this.state.diffCache[key]?.data && !opts.force) return;
    let ctx: Ctx;
    try {
      ctx = await this.ctxFor(repo);
    } catch (e) {
      this.set((s) => ({ diffCache: { ...s.diffCache, [key]: { status: "error", ...errInfo(e), refreshing: false } } }));
      return;
    }
    await this.load<FileDiff>(
      `diff:${key}`,
      () => this.state.diffCache[key],
      (r) => this.set((s) => ({ diffCache: { ...s.diffCache, [key]: r } })),
      async () => {
        const res = await prFiles(ctx, n, file);
        const hit = res.files[0];
        if (!hit) throw new StkError(`no diff for ${file}`, "gh-failed");
        return hit;
      },
    );
  }

  /** Reload whatever is on screen (background: cached data stays visible). */
  async refresh(): Promise<void> {
    const s = this.state.screen;
    if (s.kind === "board") await this.loadScope(s.scope, { force: true });
    else await Promise.all([this.loadPr(s.n, { force: true, repo: s.repo }), this.loadScope(s.scope, { force: true })]);
  }

  // ---------- navigation ----------

  setScope(scope: TuiScope): void {
    if (scope === "session" && !this.state.sessionPane && !this.state.sessionMissing) return;
    this.set({ screen: { kind: "board", scope } });
    const repo = this.state.repo;
    if (repo && repoPrefs(this.state.prefs, repo).scope !== scope) this.updatePrefs(withRepoPrefs(this.state.prefs, repo, { scope }));
    void this.loadScope(scope);
  }

  // ---------- preferences ----------

  /** Replace the preferences and persist them (best effort: an unwritable config dir must not break the TUI). */
  updatePrefs(next: Prefs): void {
    this.set({ prefs: next });
    if (!this.prefsFile) return;
    try {
      savePrefs(next, this.prefsFile);
    } catch {}
  }

  /** Notification mode (`:notify`); saved. */
  setNotify(mode: NotifyMode): void {
    this.updatePrefs({ ...this.state.prefs, notify: mode });
  }

  /** Reduced motion (`:reduced-motion`); saved and applied at once. */
  setReducedMotion(on: boolean): void {
    setReducedMotionPref(on);
    this.updatePrefs({ ...this.state.prefs, reducedMotion: on });
  }

  /** Remember a merge method for a repo. */
  setMergeMethod(repo: RepoSlug, mergeMethod: MergeMethod): void {
    this.updatePrefs(withRepoPrefs(this.state.prefs, repo, { mergeMethod }));
  }

  /** Next merge method (squash, merge, rebase) for the active repo; remembered. */
  cycleMergeMethod(): void {
    const repo = this.activeRepo();
    if (repo) this.setMergeMethod(repo, MERGE_METHODS[(MERGE_METHODS.indexOf(mergeMethodOf(this.state)) + 1) % MERGE_METHODS.length]!);
  }

  /** The remembered board tab of a repo, when it can be shown (Session needs a session pane). */
  private savedScope(repo: RepoSlug | null): TuiScope | undefined {
    const scope = repoPrefs(this.state.prefs, repo).scope;
    return scope === "session" && !this.state.sessionPane && !this.state.sessionMissing ? undefined : scope;
  }

  /** Open a PR page. `repo` defaults to the active repo (launch repo from a board). `focus` places the cursor (default: top). */
  openPr(n: number, repo?: RepoSlug, focus?: PrFocus): void {
    const r = repo ?? this.activeRepo();
    if (!r) return;
    const s = this.state.screen;
    this.set({ screen: { kind: "pr", n, repo: r, scope: s.scope, focus }, boardCursor: prKey(repoKey(r), n) });
    void this.loadPr(n, { repo: r });
  }

  /** Esc/backspace from a PR: back to the board it came from (session board when launched with a session), refreshing it silently. */
  back(): void {
    const s = this.state.screen;
    if (s.kind !== "pr") return;
    this.set({ screen: { kind: "board", scope: s.scope } });
    void this.loadScope(s.scope, { force: true });
  }

  setBoardCursor(key: string | null): void {
    if (key !== this.state.boardCursor) {
      this.set({ boardCursor: key });
      if (this.state.screen.kind === "board") this.scheduleDwellPrefetch(key);
    }
  }

  /** Board cursor key for a PR. */
  cursorKey(repo: RepoSlug, n: number): string {
    return prKey(repoKey(repo), n);
  }

  // ---------- sheets, toasts, focus ----------

  openSheet(sheet: Exclude<Sheet, null>): void {
    this.set({ sheet });
  }

  /** Close the palette and open the PR it picked (any repo). */
  openPaletteTarget(repo: string, n: number): void {
    const i = repo.indexOf("/");
    this.set({ sheet: null });
    this.openPr(n, { owner: repo.slice(0, i), name: repo.slice(i + 1) });
  }

  /** GitHub-side PR search for the palette, scoped to the active repo's owner. Throws StkError (incl. rate-limited). */
  async searchGithub(query: string): Promise<PaletteItem[]> {
    const owner = this.activeRepo()?.owner;
    if (!owner) throw new StkError("no repository to scope the search to", "gh-failed");
    return searchPalette({ exec }, owner, query);
  }

  closeSheet(): void {
    if (this.state.sheet) this.set({ sheet: null });
  }

  /** Show a toast; returns its id. Auto-dismisses (4 s, errors 7 s). */
  toast(text: string, kind: Toast["kind"] = "info"): number {
    const id = ++this.toastSeq;
    this.set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, kind }] }));
    setTimeout(() => this.dismissToast(id), kind === "error" ? 7000 : 4000);
    return id;
  }

  dismissToast(id: number): void {
    this.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  /** Palette commands that act on page-local state (PR page toggles) reach the screen through here. */
  private pageCommandListeners = new Set<(id: PageCommandId) => void>();
  onPageCommand(fn: (id: PageCommandId) => void): () => void {
    this.pageCommandListeners.add(fn);
    return () => void this.pageCommandListeners.delete(fn);
  }
  emitPageCommand(id: PageCommandId): void {
    if (this.state.screen.kind !== "pr") return void this.toast("Open a pull request first");
    for (const fn of this.pageCommandListeners) fn(id);
  }

  /**
   * Each publisher (the palette, a screen's `/` search) owns its own slot, so a screen re-publishing its committed
   * search while the palette is open cannot replace the palette's line, and closing the palette restores the search.
   */
  private searchLines = new Map<string, SearchLine>();
  setSearchLine(owner: string, line: SearchLine | null): void {
    if (line) this.searchLines.set(owner, line);
    else this.searchLines.delete(owner);
    const shown = this.searchLines.get(PALETTE_LINE) ?? [...this.searchLines.values()].at(-1) ?? null;
    if (shown !== this.state.searchLine) this.set({ searchLine: shown });
  }

  /** Text inputs call this on focus/blur so global keys can be gated. */
  setInputFocused(v: boolean): void {
    if (v !== this.state.inputFocused) this.set({ inputFocused: v });
  }

  // ---------- mutations ----------

  /**
   * Run a mutation in `repo` (default: the active repo): sets `busy`, returns an Outcome (never throws),
   * toasts failures unless `quiet`, and refreshes the board and the PR page afterwards when `n` is given
   * (also after failures of multi-step operations, since part of them may have landed).
   */
  async run<T>(
    label: string,
    fn: (ctx: Ctx) => Promise<T>,
    opts: { n?: number; quiet?: boolean; success?: string; repo?: RepoSlug } = {},
  ): Promise<Outcome<T>> {
    const repo = opts.repo ?? this.activeRepo();
    if (!repo) return { ok: false, error: new Error("repository not open") };
    this.set({ busy: label });
    let out: Outcome<T>;
    try {
      const ctx = await this.ctxFor(repo);
      const value = await fn(ctx);
      out = { ok: true, value };
      if (opts.success) this.toast(inContext(repo, opts.n, opts.success), "success");
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      out = { ok: false, error };
      if (!opts.quiet) this.toast(inContext(repo, opts.n, error.message), "error");
    }
    this.set({ busy: null });
    if (opts.n !== undefined) {
      this.watcher.markSelf(repo, opts.n);
      this.dropStackInfo(repoKey(repo));
      void this.loadScope(this.state.screen.scope, { force: true });
      void this.loadPr(opts.n, { force: true, repo });
    }
    return out;
  }

  review(n: number, event: ReviewEvent, body = "", repo?: RepoSlug) {
    return this.run("reviewing", (c) => review(c, n, event, body), { n, repo, success: `Review sent on #${n}` });
  }

  /** Close / reopen / ready / back to draft / re-run failed checks. */
  prAction(n: number, action: PrAction, repo?: RepoSlug) {
    const doing: Record<PrAction, [string, string]> = {
      close: ["closing", `Closed #${n}`],
      reopen: ["reopening", `Reopened #${n}`],
      ready: ["marking ready", `#${n} is ready for review`],
      draft: ["converting to draft", `#${n} is a draft again`],
      rerun: ["re-running checks", `Re-running failed checks on #${n}`],
      "update-branch": ["updating branch", `Updated the branch of #${n}`],
    };
    return this.run(doing[action][0], (c) => prAction(c, n, action), { n, repo, success: doing[action][1] });
  }

  /** `:gh <args>` in `repo` (default: the active repo). Throws StkError (bad line, confirmation required). */
  async gh(line: string, o: { n: number | null; confirmed: boolean; repo?: RepoSlug }): Promise<GhResult> {
    const repo = o.repo ?? this.activeRepo();
    if (!repo) throw new StkError("repository not open", "usage");
    return ghProxy(await this.ctxFor(repo), line, o);
  }

  /** Change a PR's base branch. */
  retargetBase(n: number, base: string, repo?: RepoSlug) {
    return this.run("changing base", (c) => retargetBase(c, n, base), { n, repo, success: `#${n} now targets ${base}` });
  }

  reply(n: number, threadId: string, body: string, repo?: RepoSlug) {
    return this.run("replying", (c) => reply(c, threadId, body), { n, repo, success: "Reply sent" });
  }

  resolveThread(n: number, threadId: string, repo?: RepoSlug) {
    return this.run("resolving", (c) => resolve(c, threadId), { n, repo, success: "Thread resolved" });
  }

  /** `:fix`: open an omp agent in a new Tern tab, in the PR's worktree, on a review thread or failing check. */
  async fixWithAgent(pr: FixPr, target: FixTarget, repo?: RepoSlug): Promise<void> {
    const o = await this.run("starting agent", (c) => startFix(c, pr, target), { repo, quiet: true });
    if (o.ok) this.toast(`Agent started in a new tab (${o.value.worktree})`, "success");
    else this.toast(`Could not start the agent: ${o.error.message}`, "error");
  }

  openWorktree(n: number, create = false, repo?: RepoSlug): Promise<Outcome<OpenResult>> {
    return this.run("opening worktree", (c) => openWorktree(c, n, { create }), { n, repo, quiet: true });
  }

  /** Dry run: what would a (force) merge do. Errors are returned, not toasted. */
  mergeDryRun(n: number, method: MergeMethod, force: boolean, repo?: RepoSlug): Promise<Outcome<MergeDryRun>> {
    return this.run("checking", (c) => merge(c, n, { method, force, dryRun: true }), { repo, quiet: true });
  }

  /** Start a detached merge job and return at once; progress arrives through `state.jobs`. */
  startMerge(n: number, method: MergeMethod, force: boolean, repo?: RepoSlug): Promise<Outcome<{ jobId: string }>> {
    return this.startMergeJob("merge", n, method, force, repo);
  }

  /** Start a detached stack merge job (survives closing the TUI). */
  startStackMerge(n: number, method: MergeMethod, force: boolean, repo?: RepoSlug): Promise<Outcome<{ jobId: string }>> {
    return this.startMergeJob("stack-merge", n, method, force, repo);
  }

  /**
   * Start a detached merge-when-ready job: it waits (up to 24 h, surviving this TUI) for the blockers to clear and
   * then merges without bypassing anything. `stack`: land the stack up to `n`.
   */
  startMergeWhenReady(n: number, method: MergeMethod, stack: boolean, repo?: RepoSlug): Promise<Outcome<{ jobId: string }>> {
    return this.startMergeJob("merge-when-ready", n, method, false, repo, undefined, stack);
  }

  /** The waiting merge-when-ready job covering PR `n`, if any. */
  waitingMergeJob(n: number, repo?: RepoSlug): Job | undefined {
    const r = repo ?? this.activeRepo();
    return r ? Object.values(this.state.jobs).find((j) => j.kind === "merge-when-ready" && j.status === "running" && j.waiting !== undefined && jobCovers(j, r, n)) : undefined;
  }

  /** Cancel the waiting merge-when-ready job of PR `n`; the job's end toasts "Merge when ready cancelled". */
  cancelMergeWhenReady(n: number, repo?: RepoSlug): boolean {
    const job = this.waitingMergeJob(n, repo);
    if (!job) {
      this.toast(`#${n} is not waiting to merge`);
      return false;
    }
    try {
      return cancelJob(job.id);
    } catch (e) {
      this.toast(e instanceof Error ? e.message : String(e), "error");
      return false;
    }
  }

  /** How `:rerun-required` would get #n's missing required checks to report (nothing runs). Errors are toasted. */
  planRerunRequired(n: number, repo?: RepoSlug): Promise<Outcome<RerunRequiredPlan>> {
    return this.run("checking required checks", (c) => planRerunRequired(c, n), { repo });
  }

  rerunRequired(plan: RerunRequiredPlan, repo?: RepoSlug): Promise<Outcome<RerunRequiredResult>> {
    return this.run("re-triggering checks", (c) => rerunRequired(c, plan), { n: plan.number, repo, success: `Re-triggering required checks on #${plan.number}` });
  }

  /** Plan `:pr` for the branch checked out in the launch directory. Errors are toasted. */
  planCreatePr(repo?: RepoSlug): Promise<Outcome<CreatePrPlan>> {
    return this.run("planning pull request", (c) => planCreatePr(c), { repo });
  }

  async createPr(plan: CreatePrPlan, repo?: RepoSlug): Promise<Outcome<CreatePrResult>> {
    const out = await this.run("creating pull request", (c) => createPullRequest(c, plan), { repo });
    if (out.ok) {
      this.toast(`Created #${out.value.number} · ${out.value.branch} → ${out.value.base}`, "success");
      void this.loadScope(this.state.screen.scope, { force: true });
    }
    return out;
  }

  planStackSubmit(repo?: RepoSlug): Promise<Outcome<StackSubmitPlan>> {
    return this.run("planning stack", (c) => planStackSubmit(c), { repo });
  }

  /** Create the missing PRs of a local chain and make it a GitHub stack. */
  async stackSubmit(plan: StackSubmitPlan, repo?: RepoSlug): Promise<Outcome<StackSubmitResult>> {
    const r = repo ?? this.activeRepo();
    const out = await this.run("submitting stack", (c) => stackSubmit(c, plan), { repo });
    if (out.ok && r) {
      const prs = out.value.stack.prs;
      this.toast(`Created GitHub stack · ${prs.map((x) => `#${x}`).join(" → ")}`, "success");
      void this.refetchStack(r, prs);
      setTimeout(() => void this.refetchStack(r, prs), STACK_RECHECK_MS);
    } else if (!out.ok) void this.loadScope(this.state.screen.scope, { force: true });
    return out;
  }

  /** Make a classic chain (bottom first) a GitHub stack; refreshes the board, the PR page and the cached plans. */
  async createStack(prs: number[], n: number, repo?: RepoSlug): Promise<Outcome<CreateStackResult>> {
    const r = repo ?? this.activeRepo();
    const out = await this.run("creating stack", (c) => createStack(c, prs), {
      n,
      repo,
      success: `Created GitHub stack · ${prs.map((x) => `#${x}`).join(" → ")}`,
    });
    if (out.ok && r) {
      void this.refetchStack(r, prs);
      // GitHub can take a moment to report the new membership: look once more shortly after
      setTimeout(() => void this.refetchStack(r, prs), STACK_RECHECK_MS);
    }
    return out;
  }

  /** Force-refetch every member's detail (never the updatedAt short-circuit: stack changes do not bump it), the plans and the board. */
  async refetchStack(repo: RepoSlug, prs: number[]): Promise<void> {
    this.dropStackInfo(repoKey(repo));
    await Promise.all([...prs.map((p) => this.loadPr(p, { force: true, repo })), this.loadScope(this.state.screen.scope, { force: true })]);
  }

  /** Start a detached stack rebase job (`gh stack rebase` + `push` in the worktree of #n's branch). */
  startRebaseStack(n: number, opts: { stash?: boolean; repo?: RepoSlug } = {}): Promise<Outcome<{ jobId: string }>> {
    return this.startMergeJob("rebase-stack", n, "squash", false, opts.repo, opts.stash);
  }

  private async startMergeJob(kind: Job["kind"], n: number, method: MergeMethod, force: boolean, repo?: RepoSlug, stash?: boolean, stack?: boolean): Promise<Outcome<{ jobId: string }>> {
    const r = repo ?? this.activeRepo();
    if (!r) return { ok: false, error: new Error("repository not open") };
    try {
      const ctx = await this.ctxFor(r);
      const { id } = await startJob({ kind, repo: r, pr: n, method, force, ...(stash ? { stash } : {}), ...(stack ? { stack } : {}), ...(ctx.root ? { repoDir: ctx.root } : {}) });
      this.trackJob(id);
      return { ok: true, value: { jobId: id } };
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      this.toast(error.message, "error");
      return { ok: false, error };
    }
  }

  /** Follow a job file: mirror it into `state.jobs`; on its end toast, reload the PR and the board. */
  private trackJob(id: string): void {
    if (this.jobWatchers.has(id)) return;
    const stop = watchJob(id, (job) => {
      const key = prKey(repoKey(job.repo), job.pr);
      // before the job lands in state, so a sheet re-planning on its end never reads the old plan
      if (job.status !== "running") this.dropStackInfo(repoKey(job.repo));
      this.set((s) => ({ jobs: { ...s.jobs, [key]: job } }));
      if (job.status === "running") return;
      this.jobWatchers.get(id)?.();
      this.jobWatchers.delete(id);
      this.finishJob(job, claimNotify(job.id));
    });
    this.jobWatchers.set(id, stop);
  }

  /** Reload what a finished job touched; toast its end only when `announce` (this viewer won the claim). */
  private finishJob(job: Job, announce: boolean): void {
    if (announce) {
      if (job.status === "done") this.toast(inContext(job.repo, job.pr, mergeOutcomeText(job)), !mergeOutcomeOk(job.outcome) ? "error" : job.outcome === "enqueued" ? "info" : "success");
      else this.toast(inContext(job.repo, job.pr, jobFailureText(job)), job.errorCode === "cancelled" ? "info" : "error");
    }
    const repo = job.repo;
    this.dropStackInfo(repoKey(repo));
    const scr = this.state.screen;
    // a stack job moves several PRs without bumping updatedAt: refetch every member (and the open page), plans included
    const members = new Set([job.pr, ...(job.prs ?? []), ...(scr.kind === "pr" && jobCovers(job, repo, scr.n) ? [scr.n] : [])]);
    void this.refetchStack(repo, [...members]);
  }

  /** Pick up running jobs, and announce ones that ended moments ago that nobody announced yet; older ones stay quiet. */
  private resumeJobs(): void {
    const now = Date.now();
    for (const job of listJobs()) {
      if (job.status === "running") this.trackJob(job.id);
      else if (now - job.updatedAt < STARTUP_NOTIFY_MS) {
        this.set((s) => ({ jobs: { ...s.jobs, [prKey(repoKey(job.repo), job.pr)]: job } }));
        if (claimStartupNotify(job, now)) this.finishJob(job, true);
      }
    }
  }

  /**
   * Merge plan for the stack ending at `n`. Cached 30s per repo/top/method/force and dropped when a member's head
   * moved (per the PR cache) or a job/mutation ended, so reopening the sheet is instant.
   */
  async stackInfo(n: number, method: MergeMethod, force: boolean, upTo: number | "top" = "top", repo?: RepoSlug): Promise<Outcome<StackInfo>> {
    const r = repo ?? this.activeRepo();
    const rk = r ? repoKey(r) : null;
    const key = rk ? `${rk}#${n}:${method}:${force}:${upTo}` : null;
    const hit = key ? this.stackInfoCache.get(key) : undefined;
    if (hit && rk) {
      const fresh = Date.now() - hit.at < STACK_INFO_TTL_MS;
      const moved = hit.heads.some(([m, sha]) => {
        const known = this.state.prCache[prKey(rk, m)]?.data?.pr.headSha;
        return known !== undefined && known !== sha;
      });
      if (fresh && !moved) return hit.out;
      this.stackInfoCache.delete(key!);
    }
    const out = await this.run("planning", (c) => stackInfo(c, n, { method, force, upTo }), { repo, quiet: true });
    if (key && out.ok) {
      this.stackInfoCache.set(key, { at: Date.now(), out, heads: out.value.stack.prs.map((p) => [p.number, p.headSha] as [number, string]) });
    }
    return out;
  }

  /** Stack members the store already knows for `n` (open ones on the line through it, bottom first), without any request: the sheet's first paint. */
  stackPreview(n: number, repo?: RepoSlug): StackEntry[] {
    const r = repo ?? this.activeRepo();
    if (!r) return [];
    const d = this.state.prCache[prKey(repoKey(r), n)]?.data;
    const open = d?.stack?.entries.filter((e) => e.state === "OPEN" && d.stack!.prs.includes(e.number)) ?? [];
    if (open.some((e) => e.number === n)) return open;
    const b = Object.values(this.state.boards).flatMap((r) => r?.data?.prs ?? []).find((p) => p.number === n);
    const pr = d?.pr ?? b;
    return pr ? [{ number: n, title: pr.title, state: "OPEN", isDraft: pr.isDraft, checks: "none" }] : [];
  }

  private dropStackInfo(rk: RepoKey): void {
    for (const k of this.stackInfoCache.keys()) if (k.startsWith(`${rk}#`)) this.stackInfoCache.delete(k);
  }
}

// ---------- React bindings ----------

export const StoreContext = createContext<Store | null>(null);

export function useStoreInstance(): Store {
  const s = useContext(StoreContext);
  if (!s) throw new Error("StoreContext missing");
  return s;
}

/** The running merge job covering PR `n` of `repo`, if any. */
export function runningJobOf(s: AppState, repo: RepoSlug | null, n: number): Job | undefined {
  if (!repo) return undefined;
  return Object.values(s.jobs).find((j) => j.status === "running" && jobCovers(j, repo, n));
}

/** Select a slice of state; re-renders only when the selected value changes (Object.is). */
export function useStore<T>(selector: (s: AppState) => T): T {
  const store = useStoreInstance();
  const last = useRef<{ s: AppState; sel: (s: AppState) => T; v: T } | null>(null);
  const get = () => {
    const s = store.getState();
    // Cache per (state, selector): selectors close over props (e.g. board scope), so a new selector must re-run.
    if (last.current?.s === s && last.current.sel === selector) return last.current.v;
    const v = selector(s);
    last.current = { s, sel: selector, v: last.current && Object.is(last.current.v, v) ? last.current.v : v };
    return last.current.v;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}
