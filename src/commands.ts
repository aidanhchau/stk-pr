/** Palette commands: the `:` command line offers actions next to PR search. Pure; the TUI binds the actions. */
import { fuzzyMatch, type PaletteItem } from "./fuzzy";
import type { Prefs } from "./prefs";

export type CommandId =
  | "merge"
  | "merge-stack"
  | "merge-when-ready"
  | "cancel-merge"
  | "approve"
  | "request-changes"
  | "comment"
  | "open-github"
  | "refresh"
  | "toggle-bots"
  | "toggle-noise"
  | "copy-branch"
  | "copy-url"
  | "worktree"
  | "close"
  | "reopen"
  | "ready"
  | "draft"
  | "rerun"
  | "update-branch"
  | "base"
  | "rebase-stack"
  | "create-stack"
  | "rerun-required"
  | "create-pr"
  | "stack-submit"
  | "fix"
  | "notify-toast"
  | "notify-system"
  | "notify-off"
  | "motion-on"
  | "motion-off";

export interface CommandDef {
  id: CommandId;
  name: string;
  /** Extra names that match like `name` (`:approve` ≡ `:lgtm`). */
  aliases: string[];
  /** One line shown muted next to the name. */
  hint: string;
  /** Asks for confirmation before running. */
  destructive: boolean;
  /** `pr`: acts on the PR page's PR or the board's selected row. `page`: only on a PR page. `none`: anywhere. */
  scope: "pr" | "page" | "none";
}

const def = (id: CommandId, name: string, hint: string, scope: CommandDef["scope"], extra: Partial<Pick<CommandDef, "aliases" | "destructive">> = {}): CommandDef => ({
  id,
  name,
  hint,
  scope,
  aliases: extra.aliases ?? [],
  destructive: extra.destructive ?? false,
});

export const COMMANDS: readonly CommandDef[] = [
  def("merge", "merge", "merge this PR", "pr"),
  def("merge-stack", "merge stack", "merge the stack up to this PR", "pr", { aliases: ["stack"] }),
  def("merge-when-ready", "merge when ready", "wait for checks and reviews, then merge", "pr", { aliases: ["merge-when-ready", "auto-merge", "automerge"] }),
  def("cancel-merge", "cancel merge", "stop waiting to merge this PR", "pr", { aliases: ["cancel-merge", "cancel auto-merge", "cancel-auto-merge"] }),
  def("approve", "approve", "approve this PR", "pr", { aliases: ["lgtm"] }),
  def("request-changes", "request changes", "request changes on this PR", "pr", { aliases: ["reject"] }),
  def("comment", "comment", "leave a review comment", "pr"),
  def("open-github", "open in github", "open the PR in the browser", "pr", { aliases: ["browser", "web"] }),
  def("refresh", "refresh", "reload from GitHub", "none", { aliases: ["reload"] }),
  def("toggle-bots", "toggle bots", "hide / show bot comments", "page", { aliases: ["bots"] }),
  def("toggle-noise", "toggle noise", "hide / show noise and minimized comments", "page", { aliases: ["noise"] }),
  def("copy-branch", "copy branch", "copy the head branch name", "pr", { aliases: ["branch"] }),
  def("copy-url", "copy url", "copy the PR URL", "pr", { aliases: ["link", "url"] }),
  def("worktree", "worktree", "open the existing worktree", "pr", { aliases: ["checkout"] }),
  def("close", "close pr", "close without merging", "pr", { aliases: ["close"], destructive: true }),
  def("reopen", "reopen pr", "reopen a closed PR", "pr", { aliases: ["reopen"] }),
  def("ready", "ready for review", "mark the draft ready", "pr", { aliases: ["ready", "undraft"] }),
  def("draft", "convert to draft", "back to draft", "pr", { aliases: ["draft"], destructive: true }),
  def("update-branch", "update branch", "merge the base branch into the PR branch", "pr", { aliases: ["update", "sync", "rebase"] }),
  def("base", "base", "change the base branch", "pr", { aliases: ["retarget", "change base"] }),
  def("rebase-stack", "rebase stack", "rebase the native stack onto its trunk in a temporary checkout", "pr", { aliases: ["rebase-stack", "restack", "base", "retarget", "change base"] }),
  def("create-stack", "create GitHub stack", "make this chain of PRs a GitHub stack", "pr", { aliases: ["create-stack", "stack create", "make stack"] }),
  def("fix", "fix", "fix the selected thread or failing check with an omp agent (new tab)", "page", { aliases: ["agent", "omp", "fix with agent"] }),
  def("rerun", "rerun failed checks", "re-run the failing workflow runs", "pr", { aliases: ["rerun", "retry", "rerun checks"] }),
  def("rerun-required", "rerun required check", "re-trigger a required check that never reported", "pr", { aliases: ["rerun-required", "retrigger", "required check"] }),
  def("create-pr", "create pr", "open a PR for the current branch", "none", { aliases: ["pr", "create-pr", "new pr"] }),
  def("stack-submit", "stack submit", "create PRs for the local branch chain and make a GitHub stack", "none", { aliases: ["stack-submit", "submit stack"] }),
  def("notify-toast", "notify toast", "notifications as in-app toasts", "none", { aliases: ["notifications toast"] }),
  def("notify-system", "notify system", "notifications as system notifications", "none", { aliases: ["notifications system"] }),
  def("notify-off", "notify off", "no notifications", "none", { aliases: ["notifications off"] }),
  def("motion-on", "reduced-motion on", "turn animations off", "none", { aliases: ["reduced motion on", "no motion"] }),
  def("motion-off", "reduced-motion off", "turn animations on", "none", { aliases: ["reduced motion off"] }),
];

/** Row detail of a command: its hint, plus the current setting for the preference commands. */
export function commandHint(c: CommandDef, prefs: Pick<Prefs, "notify" | "reducedMotion">): string {
  if (c.id === "notify-toast" || c.id === "notify-system" || c.id === "notify-off") {
    const mode = c.id.slice("notify-".length);
    if (prefs.notify === mode) return `${c.hint} · current`;
    return prefs.notify === undefined && mode !== "off" ? `${c.hint} · auto: system when unfocused, else toast` : c.hint;
  }
  if (c.id === "motion-on" || c.id === "motion-off") {
    return (prefs.reducedMotion === true) === (c.id === "motion-on") ? `${c.hint} · current` : c.hint;
  }
  return c.hint;
}

/** What the UI knows about the PR a command would act on (null: there is no target). */
export interface PrFacts {
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  /** True when a check on the PR is failing. */
  failingChecks: boolean;
  /** The PR's branch is behind its base (merge blocker "behind"). */
  behind: boolean;
  /** The PR's base branch is the head of a merged PR: it should be retargeted. */
  baseMerged: boolean;
  /** The PR is a member of a multi-PR stack. */
  inStack: boolean;
  /** The PR is in a GitHub-native stack (its base cannot be edited; only a stack rebase moves it). */
  nativeStack: boolean;
  /** The PR is in a classic chain of 2+ open PRs that is not a GitHub stack. */
  classicStack?: boolean;
  /** A required check never reported on the PR's head (blocker `required-check`). */
  requiredCheckMissing?: boolean;
  /** stk already has a worktree for the PR's branch. */
  hasWorktree: boolean;
  /** A merge-when-ready job is waiting on this PR. */
  waitingToMerge?: boolean;
  /** On the PR page (not a board row). */
  onPage: boolean;
}

/** Whether `c` makes sense right now. */
export function available(c: CommandDef, f: PrFacts | null): boolean {
  if (c.scope === "none") return true;
  if (!f) return false;
  if (c.scope === "page") return f.onPage;
  const open = f.state === "OPEN";
  switch (c.id) {
    case "merge":
    case "merge-stack":
    case "approve":
    case "request-changes":
    case "comment":
      return open;
    case "merge-when-ready":
      return open && !f.isDraft && f.waitingToMerge !== true;
    case "cancel-merge":
      return f.waitingToMerge === true;
    case "worktree":
      return f.hasWorktree;
    case "close":
      return open;
    case "reopen":
      return f.state === "CLOSED";
    case "ready":
      return open && f.isDraft;
    case "draft":
      return open && !f.isDraft;
    case "rerun":
      return f.failingChecks;
    case "rerun-required":
      return open && f.requiredCheckMissing === true;
    case "update-branch":
      return open && f.behind;
    case "base":
      return open && !f.nativeStack;
    case "rebase-stack":
      return open && f.inStack;
    case "create-stack":
      return open && f.classicStack === true;
    default:
      return true;
  }
}

export interface RankedCommand {
  def: CommandDef;
  /** Indices into `def.name` for highlighting. */
  positions: number[];
}

/**
 * Commands the query names: the query is a prefix of the name, of one of its words, or of an alias
 * (`mer` → merge, merge stack; `stack` → merge stack; `lgtm` → approve). Prefix matches only, so
 * ordinary title searches do not drag commands in. Empty query: none.
 */
export function rankCommands(query: string, f: PrFacts | null): RankedCommand[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: { r: RankedCommand; rank: number }[] = [];
  COMMANDS.forEach((c, order) => {
    if (!available(c, f)) return;
    const words = c.name.split(" ");
    const byName = c.name.startsWith(q) ? 0 : words.some((w) => w.startsWith(q)) ? 1 : -1;
    const byAlias = c.aliases.some((a) => a.startsWith(q)) ? 2 : -1;
    const rank = byName >= 0 ? byName : byAlias;
    if (rank < 0) return;
    const m = byName >= 0 ? fuzzyMatch(q, c.name) : null;
    out.push({ r: { def: c, positions: m?.positions ?? [] }, rank: rank * 100 + order });
  });
  return out.sort((a, b) => a.rank - b.rank).map((x) => x.r);
}

// ---------- `:base` second stage ----------

/** Base-branch choices: the repo's default branch first, then other open PRs' head branches (loaded data). */
export function baseCandidates(trunk: string, items: PaletteItem[], repo: string, exclude: string[]): string[] {
  const out = [trunk];
  for (const it of items) {
    if (it.repo.toLowerCase() !== repo.toLowerCase() || it.state !== "OPEN" || !it.headRef) continue;
    if (!out.includes(it.headRef) && !exclude.includes(it.headRef)) out.push(it.headRef);
  }
  return out;
}

/** True when `base` is the head branch of a merged PR in `repo` (and no loaded open PR still heads it). */
export function isMergedBase(items: PaletteItem[], repo: string, base: string): boolean {
  const same = items.filter((i) => i.repo.toLowerCase() === repo.toLowerCase() && i.headRef === base);
  return same.some((i) => i.state === "MERGED") && !same.some((i) => i.state === "OPEN");
}

export interface BaseRow {
  name: string;
  positions: number[];
  /** A branch typed by the user that is not in the list. */
  free: boolean;
}

/** Fuzzy-filter `branches` (order kept for an empty query); a typed name that matches none exactly is offered last. */
export function rankBases(branches: string[], query: string): BaseRow[] {
  const q = query.trim();
  if (!q) return branches.map((name) => ({ name, positions: [], free: false }));
  const hits: (BaseRow & { score: number })[] = [];
  for (const name of branches) {
    const m = fuzzyMatch(q, name);
    if (m) hits.push({ name, positions: m.positions, free: false, score: m.score + (name === branches[0] ? 0.5 : 0) });
  }
  const rows: BaseRow[] = hits.sort((a, b) => b.score - a.score);
  if (!branches.includes(q)) rows.push({ name: q, positions: [], free: true });
  return rows;
}

// ---------- `:repo` (workspace boards) ----------

export interface RepoRow {
  /** `owner/name`, or null for the whole workspace (`:repo all`). */
  slug: string | null;
  positions: number[];
}

/** Repo choices for `:repo <query>`: fuzzy over `owner/name`; the workspace row ("all") leads when the query is empty or a prefix of "all". */
export function rankRepos(slugs: string[], query: string): RepoRow[] {
  const q = query.trim();
  const all: RepoRow = { slug: null, positions: [] };
  if (!q) return [all, ...slugs.map((slug) => ({ slug, positions: [] }))];
  const hits: (RepoRow & { score: number })[] = [];
  for (const slug of slugs) {
    const m = fuzzyMatch(q, slug);
    if (m) hits.push({ slug, positions: m.positions, score: m.score });
  }
  const rows: RepoRow[] = hits.sort((a, b) => b.score - a.score);
  return "all".startsWith(q.toLowerCase()) ? [all, ...rows] : rows;
}

export interface SessionRow {
  id: string;
  title: string;
  positions: number[];
}

/** Agent-pane choices for `:session <query>`: fuzzy over the pane title; the given (best-first) order when the query is empty. */
export function rankSessionPanes(panes: { id: string; title: string }[], query: string): SessionRow[] {
  const q = query.trim();
  if (!q) return panes.map((p) => ({ ...p, positions: [] }));
  const hits: (SessionRow & { score: number })[] = [];
  for (const p of panes) {
    const m = fuzzyMatch(q, p.title);
    if (m) hits.push({ ...p, positions: m.positions, score: m.score });
  }
  return hits.sort((a, b) => b.score - a.score);
}
