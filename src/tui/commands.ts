/** TUI bindings of the `:` palette commands: resolve the PR a command acts on (PR page, else board cursor) and run it. */
import { planGh } from "../ghproxy";
import { isMergedBase, stateActions, type CommandId, type PrFacts } from "../commands";
import { nativeUpTo, type PullRequest, type Blocker } from "../types";
import { jobCovers } from "../jobs";
import { waitVerdict } from "../watch";
import { describeBlocker, describeRerunStep, describeSubmitEntry, type BoardPr, type RepoSlug } from "../service";
import { openInBrowser } from "./pr";
import { mergeMethodOf, paletteItems, repoKey, type AppState, type Store } from "./store";

export interface CommandTarget {
  n: number;
  repo: RepoSlug;
  pr: PullRequest;
  /** Known merge blockers (board rows and loaded PR pages carry them). */
  blockers: Blocker[] | null;
}

/** The repo's default branch from any loaded board or PR page; "main" when nothing says. */
export function trunkOf(s: AppState, repo: RepoSlug): string {
  for (const b of Object.values(s.boards)) if (b.data && repoKey(b.data.repo) === repoKey(repo)) return b.data.trunk;
  for (const r of Object.values(s.prCache)) if (r.data && repoKey(r.data.repo) === repoKey(repo) && r.data.stack) return r.data.stack.trunk;
  return "main";
}

const slugOf = (key: string): RepoSlug => ({ owner: key.slice(0, key.indexOf("/")), name: key.slice(key.indexOf("/") + 1) });

/** The PR a command would act on: the open PR page's, else the board's selected row. Null when none is loaded. */
export function commandTarget(s: AppState): CommandTarget | null {
  if (s.screen.kind === "pr") {
    const repo = s.screen.repo;
    const d = s.prCache[`${repoKey(repo)}#${s.screen.n}`]?.data;
    return d ? { n: s.screen.n, repo, pr: d.pr, blockers: d.blockers } : null;
  }
  const cur = s.boardCursor;
  if (!cur || cur.startsWith("fold:")) return null;
  const hash = cur.lastIndexOf("#");
  const n = Number(cur.slice(hash + 1));
  const repo = hash > 0 ? slugOf(cur.slice(0, hash)) : s.repo;
  if (!repo || !Number.isInteger(n)) return null;
  const key = `${repoKey(repo)}#${n}`;
  const detail = s.prCache[key]?.data;
  if (detail) return { n, repo, pr: detail.pr, blockers: detail.blockers };
  const rows: (BoardPr & { repo?: RepoSlug })[] = [];
  for (const b of Object.values(s.boards)) if (b.data) rows.push(...b.data.prs);
  const g = s.session?.data?.groups;
  if (g) rows.push(...g.open, ...g.merged, ...g.closed);
  const hit = rows.find((r) => r.number === n && repoKey(r.repo ?? s.repo ?? repo) === repoKey(repo));
  return hit ? { n, repo, pr: hit, blockers: hit.blockers } : null;
}

/** Stack membership from the loaded boards when the PR's own stack is not: another open PR of the repo sits on its head or under its base. */
function linkedByRefs(s: AppState, t: CommandTarget): boolean {
  const rk = repoKey(t.repo);
  const rows: (BoardPr & { repo?: RepoSlug })[] = [];
  for (const b of Object.values(s.boards)) if (b.data) rows.push(...b.data.prs);
  const g = s.session?.data?.groups;
  if (g) rows.push(...g.open);
  return rows.some(
    (r) => r.state === "OPEN" && r.number !== t.n && repoKey(r.repo ?? s.repo ?? t.repo) === rk && (r.baseRef === t.pr.headRef || r.headRef === t.pr.baseRef),
  );
}

/** Open PRs of the classic (non-native) chain the target is in, bottom first; empty otherwise, and for a forked tree (GitHub stacks are one line). */
const classicChainOf = (s: AppState, t: CommandTarget): number[] => {
  const st = s.prCache[`${repoKey(t.repo)}#${t.n}`]?.data?.stack;
  return st && !st.native && st.forks.length === 0 && st.prs.length > 1 ? st.prs : [];
};

const nativeStackOf = (s: AppState, t: CommandTarget): boolean => {
  const st = s.prCache[`${repoKey(t.repo)}#${t.n}`]?.data?.stack;
  return !!st?.native && st.entries.length > 1;
};

export function commandFacts(s: AppState): PrFacts | null {
  const t = commandTarget(s);
  if (!t) return null;
  return {
    state: t.pr.state,
    isDraft: t.pr.isDraft,
    failingChecks: t.pr.checks.some((c) => c.state === "fail"),
    requiredCheckMissing: (t.blockers ?? []).some((b) => b.kind === "required-check"),
    inStack: (s.prCache[`${repoKey(t.repo)}#${t.n}`]?.data?.stack?.entries.length ?? 0) > 1 || linkedByRefs(s, t),
    nativeStack: nativeStackOf(s, t),
    classicStack: classicChainOf(s, t).length > 1,
    baseMerged: isMergedBase(paletteItems(s), repoKey(t.repo), t.pr.baseRef),
    behind: (t.blockers ?? []).some((b) => b.kind === "behind"),
    hasWorktree: t.pr.worktree !== null,
    waitingToMerge: Object.values(s.jobs).some((j) => j.kind === "merge-when-ready" && j.status === "running" && j.waiting !== undefined && jobCovers(j, t.repo, t.n)),
    onPage: s.screen.kind === "pr",
  };
}

/** pbcopy locally; OSC 52 over SSH / off macOS (the terminal owns the clipboard). */
export function copyText(store: Store, what: string, text: string): void {
  let ok = false;
  if (process.platform === "darwin" && !process.env.SSH_TTY) ok = Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(text) }).exitCode === 0;
  if (!ok) {
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    ok = true;
  }
  store.toast(`Copied ${what}`, "success");
}

const blockerWords = (bs: Blocker[]): string =>
  bs
    .map((b) => (b.kind === "checks" ? "checks" : b.kind === "review" ? "review" : b.kind === "threads" ? "open threads" : b.kind === "base-not-trunk" ? describeBlocker(b) : b.kind))
    .join(", ");

/** `p`: open the state sheet for the current target; a merged PR (nothing to change) or no target toasts instead. */
export function openStateSheet(store: Store): void {
  const s = store.getState();
  const t = commandTarget(s);
  if (!t) return void store.toast("No pull request selected", "error");
  if (stateActions(commandFacts(s)).length === 0) return void store.toast(`#${t.n} is ${t.pr.state.toLowerCase()}; its state can’t change`, "info");
  store.openSheet({ kind: "state" });
}

/** Run a palette command against the current target. Destructive ones go through the confirm sheet. */
export function runCommand(store: Store, id: CommandId): void {
  const s = store.getState();
  if (id === "refresh") return void store.refresh();
  if (id === "notify-toast" || id === "notify-system" || id === "notify-off") {
    const mode = id === "notify-toast" ? "toast" : id === "notify-system" ? "system" : "off";
    store.setNotify(mode);
    return void store.toast(`Notifications: ${mode}`);
  }
  if (id === "motion-on" || id === "motion-off") {
    store.setReducedMotion(id === "motion-on");
    return void store.toast(`Reduced motion ${id === "motion-on" ? "on" : "off"}`);
  }
  if (id === "toggle-bots" || id === "toggle-noise" || id === "fix") return store.emitPageCommand(id);
  if (id === "create-pr") return void createPrFlow(store);
  if (id === "stack-submit") return void stackSubmitFlow(store);
  const t = commandTarget(s);
  if (!t) return void store.toast("No pull request selected", "error");
  const { n, repo, pr } = t;
  const label = `#${n}`;
  const confirm = (title: string, body: string, action: string, run: () => void) =>
    store.openSheet({ kind: "confirm", title, body, label: action, onConfirm: run });
  switch (id) {
    case "merge": {
      if (t.blockers?.length) return void store.toast(`Can’t merge ${label}: ${blockerWords(t.blockers)}`, "error");
      const method = mergeMethodOf(store.getState());
      return confirm(`Merge ${label}`, `${pr.title}\n${method}-merge into ${pr.baseRef}`, "Merge", () => void store.startMerge(n, method, false, repo).then((o) => o.ok && store.toast(`Merging ${label} in the background`)));
    }
    case "merge-stack":
      return store.openSheet({ kind: "stack", n, repo });
    case "merge-when-ready":
      return mergeWhenReady(store, t);
    case "cancel-merge":
      return void store.cancelMergeWhenReady(n, repo);
    case "approve":
      return store.openSheet({ kind: "review", n, event: "APPROVE", repo });
    case "request-changes":
      return store.openSheet({ kind: "review", n, event: "REQUEST_CHANGES", repo });
    case "comment":
      return store.openSheet({ kind: "review", n, event: "COMMENT", repo });
    case "open-github":
      return openInBrowser(store, pr.url);
    case "copy-branch":
      return copyText(store, pr.headRef, pr.headRef);
    case "copy-url":
      return copyText(store, "PR URL", pr.url);
    case "worktree":
      return store.openSheet({ kind: "worktree", n, repo });
    case "close":
      return confirm(`Close ${label}`, `${pr.title}\nClose without merging.`, "Close PR", () => void store.prAction(n, "close", repo));
    case "draft":
      return confirm(`Convert ${label} to draft`, `${pr.title}\nReviewers are no longer asked to review it.`, "Convert", () => void store.prAction(n, "draft", repo));
    case "reopen":
      return void store.prAction(n, "reopen", repo);
    case "ready":
      return void store.prAction(n, "ready", repo);
    case "rebase-stack":
      return void store.startRebaseStack(n, { repo }).then((o) => o.ok && store.toast(`Rebasing stack of #${n} in the background`));
    case "create-stack": {
      const chain = classicChainOf(s, t);
      if (chain.length < 2) return void store.toast("Not part of a chain of PRs", "error");
      return confirm("Create GitHub stack", chain.map((x) => `#${x}`).join(" → "), "Create stack", () => void store.createStack(chain, n, repo));
    }
    case "base":
      return; // the palette's second stage picks the branch, then calls confirmBase
    case "rerun":
      return void store.prAction(n, "rerun", repo);
    case "rerun-required":
      return void rerunRequiredFlow(store, n, repo);
    case "update-branch":
      return void store.prAction(n, "update-branch", repo);
  }
}

/**
 * `:merge-when-ready`: confirm, then start the detached job that waits for the blockers to clear and merges. A
 * stack member (its base is not the trunk) waits for the stack plan up to it; a PR with a hard blocker (conflict,
 * changes requested, failing checks, draft) is refused here, since waiting could not fix it.
 */
function mergeWhenReady(store: Store, t: CommandTarget): void {
  const { n, repo, pr } = t;
  const label = `#${n}`;
  const d = store.getState().prCache[`${repoKey(repo)}#${n}`]?.data;
  const stack = nativeUpTo(d?.stack, n) !== null || !!t.blockers?.some((b) => b.kind === "base-not-trunk");
  let waitingFor = "the stack to be ready";
  if (!stack) {
    const v = waitVerdict(t.blockers ?? [], n);
    if (v.verdict === "ready") return void store.toast(`Nothing blocks ${label} · merge it now`);
    if (v.verdict === "hard") return void store.toast(`Can’t wait for ${label}: ${v.reason}`, "error");
    waitingFor = v.reason;
  }
  const method = mergeMethodOf(store.getState());
  store.openSheet({
    kind: "confirm",
    title: `Merge ${stack ? "stack up to " : ""}${label} when ready`,
    body: `${pr.title}\nWaits for ${waitingFor}, then ${method}-merges into ${stack ? "the trunk" : pr.baseRef}.\nNothing is bypassed; gives up after 24 h or if a conflict or requested change appears.`,
    label: "Merge when ready",
    onConfirm: () => void store.startMergeWhenReady(n, method, stack, repo).then((o) => o.ok && store.toast(`Waiting to merge ${label}`)),
  });
}

/** `:pr`: plan the PR of the launch directory's branch, then the create sheet (editable title, draft toggle). */
async function createPrFlow(store: Store): Promise<void> {
  const o = await store.planCreatePr();
  if (o.ok) store.openSheet({ kind: "create-pr", plan: o.value });
}

/** `:stack-submit`: plan the local chain, show it, create the PRs and the stack on confirm. */
async function stackSubmitFlow(store: Store): Promise<void> {
  const o = await store.planStackSubmit();
  if (!o.ok) return;
  const plan = o.value;
  const lines = plan.entries.map(describeSubmitEntry);
  store.openSheet({
    kind: "confirm",
    title: "Submit stack",
    body: `${plan.entries.length} branches onto ${plan.trunk}, bottom first\n${lines.join("\n")}`,
    label: "Submit stack",
    onConfirm: () => void store.stackSubmit(plan),
  });
}

/** `:rerun-required`: work out the path (re-run a workflow, re-request a suite, or an empty commit), show it, run it on confirm. */
async function rerunRequiredFlow(store: Store, n: number, repo: RepoSlug): Promise<void> {
  const o = await store.planRerunRequired(n, repo);
  if (!o.ok) return;
  const plan = o.value;
  store.openSheet({
    kind: "confirm",
    title: `Re-trigger required checks on #${n}`,
    body: `Missing: ${plan.contexts.join(", ")}\n${plan.steps.map(describeRerunStep).join("\n")}`,
    label: plan.steps.some((s) => s.kind === "empty-commit") ? "Push commit" : "Re-run",
    onConfirm: () => void store.rerunRequired(plan, repo),
  });
}

/** Confirm sheet that retargets the target PR onto `base`. */
export function confirmBase(store: Store, base: string): void {
  const t = commandTarget(store.getState());
  if (!t) return void store.toast("No pull request selected", "error");
  if (base === t.pr.baseRef) return void store.toast(`#${t.n} already targets ${base}`);
  store.openSheet({
    kind: "confirm",
    title: `Change base of #${t.n}`,
    body: `#${t.n}: ${t.pr.baseRef} → ${base}\n${t.pr.title}`,
    label: "Change base",
    onConfirm: () => void store.retargetBase(t.n, base, t.repo),
  });
}

/** What `:gh <args>` would run for the current target, for the palette preview. */
export function ghPreview(s: AppState, args: string): { ok: true; display: string; mutating: boolean } | { ok: false; error: string } {
  const t = commandTarget(s);
  const r = planGh(args, { repo: t?.repo ?? s.repo, n: t?.n ?? null });
  return r.ok ? { ok: true, display: r.plan.display, mutating: r.plan.mutating } : r;
}

/** Run `:gh <args>`: read-only at once, mutating after a confirm sheet; output opens in a scrollable sheet. */
export function runGh(store: Store, args: string): void {
  const s = store.getState();
  const t = commandTarget(s);
  const pre = ghPreview(s, args);
  if (!pre.ok) return void store.toast(pre.error, "error");
  const go = async () => {
    try {
      const r = await store.gh(args, { n: t?.n ?? null, confirmed: true, repo: t?.repo });
      store.openSheet({ kind: "output", title: r.code === 0 ? "gh" : `gh · exit ${r.code}`, command: r.command, output: r.output, code: r.code });
      if (r.mutating) void store.refresh();
    } catch (e) {
      store.toast(e instanceof Error ? e.message : String(e), "error");
    }
  };
  if (pre.mutating) store.openSheet({ kind: "confirm", title: "Run gh command", body: `${pre.display}\nThis can change things on GitHub.`, label: "Run", onConfirm: () => void go() });
  else void go();
}
