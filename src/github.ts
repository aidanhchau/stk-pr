// GitHub layer: everything goes through the `gh` CLI via an injected Exec.
import type { StackRef } from "./stack";
import type { PaletteItem } from "./fuzzy";
import { fetchCommitHistory } from "./commit-history";
import {
  type RepoSlug,
  StkError,
  type Check,
  type CheckState,
  type ConversationEntry,
  type Exec,
  type MergeMethod,
  type MergeProgress,
  type Mergeable,
  type MergeState,
  type PullRequest,
  type PrCommit,
  type RepoRules,
  type ReviewDecision,
} from "./types";

const PR_FIELDS =
  "number,title,url,author,state,isDraft,headRefName,baseRefName,headRefOid,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt,updatedAt";

/** Where gh runs: inside a checkout (string cwd), or repo-less against owner/name. */
export type Where = string | RepoSlug;

/**
 * Builds the gh argv for `where`. A slug target adds `-R owner/name` to `pr` commands and
 * passes it positionally to `repo view`; `api` calls carry the slug in their endpoint/query.
 */
export function ghInvocation(where: Where, args: string[]): { argv: string[]; cwd?: string } {
  if (typeof where === "string") return { argv: ["gh", ...args], cwd: where };
  const slug = `${where.owner}/${where.name}`;
  if (args[0] === "pr") return { argv: ["gh", ...args, "-R", slug] };
  if (args[0] === "run") return { argv: ["gh", ...args, "-R", slug] };
  if (args[0] === "repo" && args[1] === "view") return { argv: ["gh", "repo", "view", slug, ...args.slice(2)] };
  return { argv: ["gh", ...args] };
}

// ---------- rate limits ----------

const RATE_LIMIT_RE = /rate limit/i;
/** Short local clock time ("4:45pm") for a reset epoch. */
export const clockTime = (ms: number): string =>
  new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase();
/** Reset used when GitHub does not say (secondary limits, or `rate_limit` itself unreadable). */
const FALLBACK_RESET_MS = 60_000;
let knownReset: { resource: "graphql" | "core"; at: number } | null = null;
/** Test hook: forget the cached reset time. */
export const forgetRateLimit = (): void => {
  knownReset = null;
};

/** Epoch ms when a `rate-limited` error lifts; null for any other error. */
export function rateLimitReset(e: unknown): number | null {
  if (!(e instanceof StkError) || e.code !== "rate-limited") return null;
  const d = e.data;
  return d && typeof d === "object" && "resetAt" in d && typeof d.resetAt === "number" ? d.resetAt : Date.now() + FALLBACK_RESET_MS;
}

interface RateLimitBody {
  resources?: Record<string, { remaining: number; reset: number }>;
}

/**
 * StkError `rate-limited` for a GitHub rate-limit failure, `data.resetAt` the epoch ms when calls work again.
 * GraphQL: the reset comes from the `X-RateLimit-*` headers of a `{rateLimit{resetAt}}` probe, which GitHub
 * answers even while exhausted; `gh api rate_limit` can lag and report spare points while GraphQL refuses.
 * REST: from `gh api rate_limit` (free). Not exhausted by either reading = a secondary limit, retried after
 * a minute. The result is reused until it passes.
 */
export async function rateLimitError(exec: Exec, text: string): Promise<StkError> {
  const resource = /graphql/i.test(text) ? "graphql" : "core";
  let resetAt = knownReset && knownReset.resource === resource && knownReset.at > Date.now() ? knownReset.at : 0;
  if (!resetAt) {
    resetAt = Date.now() + FALLBACK_RESET_MS;
    try {
      if (resource === "graphql") {
        const r = await exec(["gh", "api", "-i", "graphql", "-f", "query={rateLimit{resetAt}}"]);
        const remaining = /^x-ratelimit-remaining:\s*(\d+)/im.exec(r.stdout);
        const reset = /^x-ratelimit-reset:\s*(\d+)/im.exec(r.stdout);
        if (remaining?.[1] === "0" && reset && Number(reset[1]) * 1000 > Date.now()) resetAt = Number(reset[1]) * 1000;
      } else {
        const r = await exec(["gh", "api", "rate_limit"]);
        const res = parseJson<RateLimitBody>(r.stdout, "rate_limit").resources?.core;
        if (r.code === 0 && res && res.remaining === 0 && res.reset * 1000 > Date.now()) resetAt = res.reset * 1000;
      }
    } catch {
      // keep the fallback
    }
    knownReset = { resource, at: resetAt };
  }
  return new StkError(`GitHub rate limit reached · resets ${clockTime(resetAt)}`, "rate-limited", { resetAt });
}

/** The error for a failed gh call: `rate-limited` when GitHub says so, else `gh-failed` with its stderr. */
async function ghFailure(exec: Exec, stderr: string, stdout: string, fallback: string): Promise<StkError> {
  if (RATE_LIMIT_RE.test(stderr) || RATE_LIMIT_RE.test(stdout.slice(0, 2000))) return rateLimitError(exec, stderr || stdout);
  if (/Cannot change the base branch because the pull request is part of a stack/i.test(stderr)) {
    return new StkError("GitHub doesn't allow changing the base of a stacked PR; use Rebase stack.", "gh-failed");
  }
  return new StkError(stderr.trim() || fallback, "gh-failed");
}

async function gh(exec: Exec, where: Where, args: string[], stdin?: string): Promise<string> {
  const { argv, cwd } = ghInvocation(where, args);
  const opts: { cwd?: string; stdin?: string } = {};
  if (cwd !== undefined) opts.cwd = cwd;
  if (stdin !== undefined) opts.stdin = stdin;
  const r = await exec(argv, opts);
  if (r.code !== 0) throw await ghFailure(exec, r.stderr, r.stdout, `gh ${args.join(" ")} failed`);
  return r.stdout;
}

function parseJson<T>(text: string, what: string): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new StkError(`could not parse gh output for ${what}`, "gh-failed");
  }
}

// ---------- check mapping ----------

const SKIP_CONCLUSIONS: Record<string, true> = { NEUTRAL: true, SKIPPED: true, STALE: true };
interface RollupItem {
  __typename?: string;
  name?: string;
  status?: string;
  conclusion?: string | null;
  detailsUrl?: string | null;
  context?: string;
  state?: string;
  targetUrl?: string | null;
}

export function mapCheck(item: RollupItem): Check {
  const isContext = item.context !== undefined && item.name === undefined;
  if (isContext) {
    const s = (item.state ?? "").toUpperCase();
    let state: CheckState = "pending";
    if (s === "SUCCESS") state = "pass";
    else if (s === "FAILURE" || s === "ERROR") state = "fail";
    return { name: item.context ?? "", state, url: item.targetUrl || null };
  }
  const status = (item.status ?? "").toUpperCase();
  const conclusion = (item.conclusion ?? "").toUpperCase();
  let state: CheckState;
  if (status !== "COMPLETED") state = "pending";
  else if (conclusion === "SUCCESS") state = "pass";
  else if (SKIP_CONCLUSIONS[conclusion]) state = "skipped";
  else state = "fail"; // FAIL_CONCLUSIONS and anything unknown
  return { name: item.name ?? "", state, url: item.detailsUrl || null };
}

interface RawPr {
  number: number;
  title: string;
  url?: string;
  author?: { login?: string } | null;
  state: string;
  isDraft: boolean;
  headRefName: string;
  baseRefName: string;
  headRefOid: string;
  createdAt?: string;
  updatedAt?: string;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  statusCheckRollup?: RollupItem[] | null;
  body?: string | null;
}

const MERGE_STATES: readonly MergeState[] = ["BEHIND", "BLOCKED", "CLEAN", "DIRTY", "DRAFT", "HAS_HOOKS", "UNKNOWN", "UNSTABLE"];

function mapPr(raw: RawPr): PullRequest {
  const mergeable: Mergeable =
    raw.mergeable === "MERGEABLE" || raw.mergeable === "CONFLICTING" ? raw.mergeable : "UNKNOWN";
  // absent (hand-built fixtures) stays absent; an unrecognised value from GitHub reads as still computing
  const mergeState: MergeState | undefined =
    raw.mergeStateStatus === undefined ? undefined : MERGE_STATES.includes(raw.mergeStateStatus as MergeState) ? (raw.mergeStateStatus as MergeState) : "UNKNOWN";
  const rd = raw.reviewDecision;
  const reviewDecision: ReviewDecision =
    rd === "APPROVED" || rd === "CHANGES_REQUESTED" || rd === "REVIEW_REQUIRED" ? rd : null;
  const state = raw.state.toUpperCase();
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url ?? "",
    author: raw.author?.login ?? "",
    state: state === "MERGED" ? "MERGED" : state === "CLOSED" ? "CLOSED" : "OPEN",
    isDraft: raw.isDraft,
    headRef: raw.headRefName,
    baseRef: raw.baseRefName,
    headSha: raw.headRefOid,
    createdAt: raw.createdAt ?? "",
    updatedAt: raw.updatedAt ?? raw.createdAt ?? "",
    mergeable,
    ...(mergeState ? { mergeState } : {}),
    reviewDecision,
    checks: (raw.statusCheckRollup ?? []).map(mapCheck),
    unresolvedThreads: 0,
    body: raw.body ?? "",
    worktree: null,
  };
}

// ---------- repo ----------

export async function trunkFor(exec: Exec, cwd: Where): Promise<string> {
  const out = await gh(exec, cwd, ["repo", "view", "--json", "defaultBranchRef"]);
  const j = parseJson<{ defaultBranchRef?: { name?: string } }>(out, "repo view");
  const name = j.defaultBranchRef?.name;
  if (!name) throw new StkError("could not determine default branch", "gh-failed");
  return name;
}

const slugCache = new WeakMap<Exec, Map<string, Promise<{ owner: string; name: string }>>>();

/** `gh repo view --json owner,name`, memoized per exec + cwd (failures are not cached). */
export function repoSlug(exec: Exec, cwd: Where): Promise<{ owner: string; name: string }> {
  if (typeof cwd !== "string") return Promise.resolve({ owner: cwd.owner, name: cwd.name });
  const byCwd = slugCache.get(exec) ?? new Map<string, Promise<{ owner: string; name: string }>>();
  slugCache.set(exec, byCwd);
  let p = byCwd.get(cwd);
  if (!p) {
    const fresh = gh(exec, cwd, ["repo", "view", "--json", "owner,name"]).then((out) => {
      const j = parseJson<{ owner: { login: string }; name: string }>(out, "repo view");
      return { owner: j.owner.login, name: j.name };
    });
    fresh.catch(() => byCwd.delete(cwd));
    byCwd.set(cwd, fresh);
    p = fresh;
  }
  return p;
}

// ---------- listing ----------

export async function listPrs(
  exec: Exec,
  cwd: Where,
  opts: { author?: string; state?: "open"; search?: string } = {},
): Promise<PullRequest[]> {
  const args = ["pr", "list", "--json", PR_FIELDS, "--limit", "100"];
  if (opts.author) args.push("--author", opts.author);
  if (opts.state) args.push("--state", opts.state);
  if (opts.search) args.push("--search", opts.search);
  const raw = parseJson<RawPr[]>(await gh(exec, cwd, args), "pr list");
  return raw.map(mapPr);
}

export async function unresolvedThreadCounts(
  exec: Exec,
  cwd: Where,
  numbers: number[],
): Promise<Map<number, number>> {
  const counts = new Map<number, number>();
  if (numbers.length === 0) return counts;
  const { owner, name } = await repoSlug(exec, cwd);
  const aliases = numbers
    .map(
      (n) =>
        `pr${n}: pullRequest(number: ${n}) { reviewThreads(first: 100) { nodes { isResolved } } }`,
    )
    .join("\n    ");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n    ${aliases}\n  } }`;
  const out = await gh(exec, cwd, ["api", "graphql", "-f", `query=${query}`]);
  const j = parseJson<{
    data?: {
      repository?: Record<string, { reviewThreads: { nodes: { isResolved: boolean }[] } } | null>;
    };
  }>(out, "graphql threads");
  const repo = j.data?.repository ?? {};
  for (const n of numbers) {
    const nodes = repo[`pr${n}`]?.reviewThreads.nodes ?? [];
    counts.set(n, nodes.filter((t) => !t.isResolved).length);
  }
  return counts;
}

export function withThreads(prs: PullRequest[], counts: Map<number, number>): PullRequest[] {
  return prs.map((p) => ({ ...p, unresolvedThreads: counts.get(p.number) ?? p.unresolvedThreads }));
}

export type FileStatus = "A" | "M" | "D" | "R";

/** File list entry from `gh pr view --json files` (no patch; see prDiff for that). */
export interface PrFileInfo {
  path: string;
  /** gh does not report the previous path of a rename. */
  oldPath: string | null;
  additions: number;
  deletions: number;
  status: FileStatus;
}

const CHANGE_STATUS: Record<string, FileStatus> = { ADDED: "A", DELETED: "D", RENAMED: "R" };

/** One `gh pr view` call: PR fields plus its changed files. Thread counts are left at 0. */
export async function viewPr(
  exec: Exec,
  cwd: Where,
  number: number,
): Promise<{ pr: PullRequest; files: PrFileInfo[] }> {
  const out = await gh(exec, cwd, ["pr", "view", String(number), "--json", `${PR_FIELDS},body,files`]);
  const raw = parseJson<RawPr & { files?: { path: string; additions: number; deletions: number; changeType?: string }[] }>(
    out,
    `pr view ${number}`,
  );
  const files = (raw.files ?? []).map((f) => ({
    path: f.path,
    oldPath: null,
    additions: f.additions,
    deletions: f.deletions,
    status: CHANGE_STATUS[(f.changeType ?? "").toUpperCase()] ?? "M",
  }));
  return { pr: mapPr(raw), files };
}

export async function getPr(exec: Exec, cwd: Where, number: number): Promise<PullRequest> {
  const [out, counts] = await Promise.all([
    gh(exec, cwd, ["pr", "view", String(number), "--json", PR_FIELDS]),
    unresolvedThreadCounts(exec, cwd, [number]),
  ]);
  const pr = mapPr(parseJson<RawPr>(out, `pr view ${number}`));
  return withThreads([pr], counts)[0]!;
}

/** Open PRs' branch topology only: skips statusCheckRollup, which makes `pr list` slow. */
export async function listPrRefs(exec: Exec, cwd: Where): Promise<StackRef[]> {
  const out = await gh(exec, cwd, [
    "pr", "list", "--state", "open", "--json", "number,headRefName,baseRefName", "--limit", "200",
  ]);
  const raw = parseJson<{ number: number; headRefName: string; baseRefName: string }[]>(out, "pr list refs");
  return raw.map((r) => ({ number: r.number, state: "OPEN" as const, headRef: r.headRefName, baseRef: r.baseRefName }));
}

// ---------- diff ----------

export interface FileDiff {
  path: string;
  oldPath: string | null;
  additions: number;
  deletions: number;
  patch: string;
}

export async function prDiff(exec: Exec, cwd: Where, number: number): Promise<string> {
  return gh(exec, cwd, ["pr", "diff", String(number)]);
}

export function splitDiffByFile(text: string): FileDiff[] {
  const files: FileDiff[] = [];
  const chunks = text.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "));
  for (const chunk of chunks) {
    const lines = chunk.split("\n");
    const header = lines[0]!.slice("diff --git ".length);
    let path: string;
    let oldPath: string | null = null;
    const same = /^a\/(.+) b\/\1$/.exec(header);
    if (same) path = same[1]!;
    else {
      const m = /^a\/(.+?) b\/(.+)$/.exec(header);
      path = m ? m[2]! : header;
      oldPath = m ? m[1]! : null;
    }
    let renameFrom: string | null = null;
    let renameTo: string | null = null;
    let inHunk = false;
    let additions = 0;
    let deletions = 0;
    let minus: string | null = null;
    let plus: string | null = null;
    for (let i = 1; i < lines.length; i++) {
      const l = lines[i]!;
      if (!inHunk) {
        if (l.startsWith("rename from ")) renameFrom = l.slice(12);
        else if (l.startsWith("rename to ")) renameTo = l.slice(10);
        else if (l.startsWith("--- ")) minus = l.slice(4);
        else if (l.startsWith("+++ ")) plus = l.slice(4);
        else if (l.startsWith("@@")) inHunk = true;
        continue;
      }
      if (l.startsWith("+")) additions++;
      else if (l.startsWith("-")) deletions++;
    }
    if (renameFrom !== null && renameTo !== null) {
      oldPath = renameFrom;
      path = renameTo;
    } else {
      // new/deleted files: take the real path from ---/+++ (handles spaces)
      if (plus && plus !== "/dev/null") path = plus.replace(/^b\//, "");
      else if (minus && minus !== "/dev/null") path = minus.replace(/^a\//, "");
      oldPath = null;
    }
    files.push({ path, oldPath, additions, deletions, patch: chunk });
  }
  return files;
}

// ---------- review threads + conversation ----------

export interface ThreadComment {
  author: string;
  isBot: boolean;
  body: string;
  createdAt: string;
  url: string;
  /** The authenticated viewer wrote this comment. */
  mine: boolean;
}

export interface ReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  /** First line of a multi-line range (the original one when outdated); null for single-line threads. */
  startLine: number | null;
  /** Login of whoever resolved the thread; null when open or unknown. */
  resolvedBy: string | null;
  /** Diff hunk the first comment was left on, ending at the commented line. */
  diffHunk: string | null;
  comments: ThreadComment[];
}

export interface Discussion {
  threads: ReviewThread[];
  /** PR-level comments (minimized ones flagged), non-empty review bodies and APPROVED/CHANGES_REQUESTED reviews, oldest first. */
  conversation: ConversationEntry[];
}

interface GqlActor {
  login: string;
  __typename?: string;
}
interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}
interface GqlComment {
  author: GqlActor | null;
  body: string;
  createdAt: string;
  url: string;
  diffHunk?: string | null;
  viewerDidAuthor?: boolean;
  isMinimized?: boolean;
  minimizedReason?: string | null;
  pullRequestReview?: { id: string } | null;
}
interface GqlThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine?: number | null;
  startLine?: number | null;
  originalStartLine?: number | null;
  resolvedBy?: { login: string } | null;
  comments: Page<GqlComment>;
}
interface GqlReview {
  id?: string;
  author: GqlActor | null;
  state: string;
  body: string;
  submittedAt: string | null;
  url: string;
}
interface GqlPr {
  reviewThreads: Page<GqlThread>;
  reviews: Page<GqlReview>;
  comments: Page<GqlComment>;
}

const EMPTY_PAGE = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };

const ACTOR = "author { login __typename }";
const DISCUSSION_QUERY = `query($o: String!, $r: String!, $n: Int!, $tc: String, $rc: String, $cc: String) {
  repository(owner: $o, name: $r) { pullRequest(number: $n) {
    reviewThreads(first: 100, after: $tc) { pageInfo { hasNextPage endCursor } nodes {
      id isResolved isOutdated path line originalLine startLine originalStartLine resolvedBy { login }
      comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${ACTOR} body createdAt url diffHunk viewerDidAuthor pullRequestReview { id } } }
    } }
    reviews(first: 100, after: $rc) { pageInfo { hasNextPage endCursor } nodes { id ${ACTOR} state body submittedAt url } }
    comments(first: 100, after: $cc) { pageInfo { hasNextPage endCursor } nodes { ${ACTOR} body createdAt url isMinimized minimizedReason } }
  } }
}`;
const THREAD_COMMENTS_QUERY = `query($id: ID!, $c: String) {
  node(id: $id) { ... on PullRequestReviewThread {
    comments(first: 100, after: $c) { pageInfo { hasNextPage endCursor } nodes { ${ACTOR} body createdAt url diffHunk viewerDidAuthor } }
  } }
}`;

const isBotActor = (a: GqlActor | null): boolean => !!a && (a.__typename === "Bot" || a.login.endsWith("[bot]"));
const actorName = (a: GqlActor | null): string => a?.login ?? "ghost";

/** Pure mapping of accumulated GraphQL pages into the app's shape. */
export function mapDiscussion(pr: GqlPr): Discussion {
  const threads: ReviewThread[] = pr.reviewThreads.nodes.map((t) => ({
    id: t.id,
    isResolved: t.isResolved,
    isOutdated: !!t.isOutdated,
    path: t.path ?? null,
    line: t.line ?? null,
    startLine: t.line != null ? (t.startLine ?? null) : null,
    resolvedBy: t.resolvedBy?.login ?? null,
    diffHunk: t.comments.nodes[0]?.diffHunk ?? null,
    comments: t.comments.nodes.map((c) => ({
      author: actorName(c.author),
      isBot: isBotActor(c.author),
      body: c.body,
      createdAt: c.createdAt,
      url: c.url,
      mine: !!c.viewerDidAuthor,
    })),
  }));
  const findingsByReview = new Map<string, NonNullable<ConversationEntry["findings"]>>();
  for (const t of pr.reviewThreads.nodes) {
    const rid = t.comments.nodes[0]?.pullRequestReview?.id;
    if (!rid) continue;
    const f = findingsByReview.get(rid) ?? { total: 0, open: 0, resolved: 0, outdated: 0, threadIds: [] };
    f.total++;
    if (t.isResolved) f.resolved++;
    else if (t.isOutdated) f.outdated++;
    else f.open++;
    f.threadIds.push(t.id);
    findingsByReview.set(rid, f);
  }
  const conversation: ConversationEntry[] = [];
  for (const c of pr.comments.nodes) {
    conversation.push({
      kind: "comment",
      id: c.url,
      author: actorName(c.author),
      isBot: isBotActor(c.author),
      body: c.body,
      createdAt: c.createdAt,
      url: c.url,
      minimized: !!c.isMinimized,
      ...(c.isMinimized && c.minimizedReason ? { minimizedReason: c.minimizedReason.toLowerCase() } : {}),
    });
  }
  for (const r of pr.reviews.nodes) {
    if (!r.submittedAt) continue;
    // An empty-body review is only worth a line when its state says something.
    if (!r.body.trim() && r.state !== "APPROVED" && r.state !== "CHANGES_REQUESTED") continue;
    conversation.push({
      kind: "review",
      id: r.url,
      author: actorName(r.author),
      isBot: isBotActor(r.author),
      state: r.state,
      body: r.body,
      createdAt: r.submittedAt,
      url: r.url,
      minimized: false,
      ...(r.id && findingsByReview.has(r.id) ? { findings: findingsByReview.get(r.id)! } : {}),
    });
  }
  conversation.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  return { threads, conversation };
}

/** Review threads, reviews and issue comments in one paginated GraphQL query (one request unless something exceeds 100). */
export async function prDiscussion(exec: Exec, cwd: Where, number: number): Promise<Discussion> {
  const { owner, name } = await repoSlug(exec, cwd);
  const acc: GqlPr = { reviewThreads: { ...EMPTY_PAGE, nodes: [] }, reviews: { ...EMPTY_PAGE, nodes: [] }, comments: { ...EMPTY_PAGE, nodes: [] } };
  const cursors: Record<"tc" | "rc" | "cc", string | null> = { tc: null, rc: null, cc: null };
  const done = { tc: false, rc: false, cc: false };
  for (;;) {
    const args = ["api", "graphql", "-f", `query=${DISCUSSION_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${number}`];
    for (const k of ["tc", "rc", "cc"] as const) if (cursors[k]) args.push("-f", `${k}=${cursors[k]}`);
    const j = parseJson<{ data?: { repository?: { pullRequest?: Partial<GqlPr> | null } } }>(await gh(exec, cwd, args), "discussion");
    const pr = j.data?.repository?.pullRequest;
    if (!pr) break;
    const pairs = [
      ["tc", "reviewThreads"],
      ["rc", "reviews"],
      ["cc", "comments"],
    ] as const;
    for (const [k, field] of pairs) {
      if (done[k]) continue;
      const page = (pr[field] ?? EMPTY_PAGE) as Page<never>;
      (acc[field].nodes as unknown[]).push(...page.nodes);
      if (page.pageInfo.hasNextPage) cursors[k] = page.pageInfo.endCursor;
      else done[k] = true;
    }
    if (done.tc && done.rc && done.cc) break;
  }
  // threads whose comment list overflowed the first page
  await Promise.all(
    acc.reviewThreads.nodes.map(async (t) => {
      let page = t.comments.pageInfo;
      while (page.hasNextPage) {
        const j = parseJson<{ data?: { node?: { comments?: Page<GqlComment> } | null } }>(
          await gh(exec, cwd, ["api", "graphql", "-f", `query=${THREAD_COMMENTS_QUERY}`, "-f", `id=${t.id}`, "-f", `c=${page.endCursor}`]),
          "thread comments",
        );
        const more = j.data?.node?.comments;
        if (!more) break;
        t.comments.nodes.push(...more.nodes);
        page = more.pageInfo;
      }
    }),
  );
  return mapDiscussion(acc);
}

export async function replyToThread(
  exec: Exec,
  cwd: Where,
  threadId: string,
  body: string,
): Promise<void> {
  const query = `mutation($id: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } }
  }`;
  await gh(exec, cwd, ["api", "graphql", "-f", `query=${query}`, "-f", `id=${threadId}`, "-f", `body=${body}`]);
}

export async function resolveThread(exec: Exec, cwd: Where, threadId: string): Promise<void> {
  const query = `mutation($id: ID!) {
    resolveReviewThread(input: {threadId: $id}) { thread { id isResolved } }
  }`;
  await gh(exec, cwd, ["api", "graphql", "-f", `query=${query}`, "-f", `id=${threadId}`]);
}

// ---------- reviews ----------

export interface ReviewInput {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments?: { path: string; line: number; body: string }[];
}

export async function submitReview(
  exec: Exec,
  cwd: Where,
  number: number,
  review: ReviewInput,
): Promise<void> {
  const payload: Record<string, unknown> = { event: review.event, body: review.body };
  if (review.comments && review.comments.length > 0) {
    payload.comments = review.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: "RIGHT",
      body: c.body,
    }));
  }
  await gh(
    exec,
    cwd,
    [
      "api",
      "--method",
      "POST",
      typeof cwd === "string"
        ? `repos/{owner}/{repo}/pulls/${number}/reviews`
        : `repos/${cwd.owner}/${cwd.name}/pulls/${number}/reviews`,
      "--input",
      "-",
    ],
    JSON.stringify(payload),
  );
}

// ---------- merge / retarget / checks ----------

export interface MergeAsyncOptions {
  method: MergeMethod;
  /** Head SHA the PR must still have; GitHub rejects the merge if the head moved. */
  sha?: string;
  /** Bypass repository rules the caller is allowed to bypass (the force merge). */
  bypass?: boolean;
}

/** Where a merge-async request stands. `sha` is the merge commit once merged. */
export interface MergeAsyncState {
  status: "pending" | "merged" | "enqueued" | "failed";
  uuid?: string;
  message?: string;
  sha?: string;
}

export interface MergeWaitOptions extends MergeAsyncOptions {
  onProgress?: (p: MergeProgress) => void;
  /** Defaults to 2s. */
  pollMs?: number;
  /** Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Test seam for the poll delay. */
  sleep?: (ms: number) => Promise<void>;
}

async function slugOf(exec: Exec, where: Where): Promise<RepoSlug> {
  return typeof where === "string" ? repoSlug(exec, where) : where;
}

/** `gh api -i`: gh exits nonzero on 4xx but still prints the response, so status and body are parsed from stdout. */
async function ghApiRaw(
  exec: Exec,
  where: Where,
  args: string[],
  stdin?: string,
): Promise<{ status: number; body: unknown; text: string }> {
  const { argv, cwd } = ghInvocation(where, ["api", "-i", ...args]);
  const opts: { cwd?: string; stdin?: string } = {};
  if (cwd !== undefined) opts.cwd = cwd;
  if (stdin !== undefined) opts.stdin = stdin;
  const r = await exec(argv, opts);
  const m = /^HTTP\/\S+\s+(\d{3})/.exec(r.stdout);
  if (!m) throw await ghFailure(exec, r.stderr, r.stdout, `gh ${args.join(" ")} failed`);
  const split = /\r?\n\r?\n/.exec(r.stdout);
  const text = split ? r.stdout.slice(split.index + split[0].length).trim() : "";
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // non-JSON error body; `text` carries it
  }
  const status = Number(m[1]);
  if ((status === 403 || status === 429) && RATE_LIMIT_RE.test(text)) throw await rateLimitError(exec, text);
  return { status, body, text };
}

interface RawMergeAsync {
  status?: string;
  details?: { message?: string; uuid?: string; sha?: string };
  message?: string;
}

function mapMergeAsync(raw: RawMergeAsync | null, text: string): MergeAsyncState {
  const status = raw?.status;
  if (status !== "pending" && status !== "merged" && status !== "enqueued" && status !== "failed") {
    throw new StkError(`unexpected merge-async response: ${text.slice(0, 200) || "(empty)"}`, "gh-failed");
  }
  const d = raw?.details;
  return {
    status,
    ...(d?.uuid ? { uuid: d.uuid } : {}),
    ...(d?.message ? { message: d.message } : {}),
    ...(d?.sha ? { sha: d.sha } : {}),
  };
}

function apiError(res: { status: number; body: unknown; text: string }, what: string): StkError {
  const body = res.body as RawMergeAsync | null;
  // GitHub's JSON body carries the reason (`details.message` for merge-async, `message` for plain API errors); the HTTP code only helps when there is none
  const msg = body?.details?.message ?? body?.message;
  if (msg) return new StkError(`${what} failed: ${msg}`, "gh-failed");
  return new StkError(`${what} failed (HTTP ${res.status})${res.text ? `: ${res.text}` : ""}`, "gh-failed");
}

/**
 * Requests an asynchronous merge. 202 = new request, 409 = one is already pending (its uuid comes back),
 * 200 = already merged/enqueued; anything else (400 unmergeable, 422, ...) throws. For a PR in a native
 * stack GitHub merges every open downstack PR along with it.
 */
export async function requestMergeAsync(
  exec: Exec,
  where: Where,
  number: number,
  opts: MergeAsyncOptions,
): Promise<MergeAsyncState> {
  const { owner, name } = await slugOf(exec, where);
  const payload: Record<string, unknown> = { merge_method: opts.method };
  if (opts.sha) payload.sha = opts.sha;
  if (opts.bypass) payload.bypass_rules = true;
  const res = await ghApiRaw(
    exec,
    where,
    ["-X", "PUT", `repos/${owner}/${name}/pulls/${number}/merge-async`, "--input", "-"],
    JSON.stringify(payload),
  );
  if (res.status === 200 || res.status === 202 || res.status === 409) {
    return mapMergeAsync(res.body as RawMergeAsync | null, res.text);
  }
  throw apiError(res, `merge of #${number}`);
}

export async function mergeAsyncStatus(exec: Exec, where: Where, number: number, uuid: string): Promise<MergeAsyncState> {
  const { owner, name } = await slugOf(exec, where);
  const res = await ghApiRaw(exec, where, [`repos/${owner}/${name}/pulls/${number}/merge-async/${uuid}`]);
  if (res.status !== 200) throw apiError(res, `merge status of #${number}`);
  return mapMergeAsync(res.body as RawMergeAsync | null, res.text);
}

/**
 * Merges via merge-async and resolves only on a final state: `merged`, or `enqueued` (merge queue; not
 * merged yet). `failed` throws gh-failed; running past the timeout throws merge-timeout carrying the uuid.
 * Never passes --delete-branch: stacked children depend on the branch until retargeted.
 */
export async function mergeAsync(
  exec: Exec,
  where: Where,
  number: number,
  opts: MergeWaitOptions,
): Promise<{ status: "merged" | "enqueued"; uuid?: string; sha?: string; message?: string }> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? 2000;
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000;
  const emit = (phase: MergeProgress["phase"], s: MergeAsyncState) =>
    opts.onProgress?.({ pr: number, phase, ...(s.uuid ? { uuid: s.uuid } : {}), ...(s.message ? { message: s.message } : {}) });

  let state = await requestMergeAsync(exec, where, number, opts);
  emit("requested", state);
  const uuid = state.uuid;
  const started = Date.now();
  while (state.status === "pending") {
    if (!uuid) throw new StkError(`merge of #${number} is pending but GitHub returned no request id`, "gh-failed");
    if (Date.now() - started >= timeoutMs) {
      throw new StkError(
        `merge of #${number} still pending after ${Math.round(timeoutMs / 1000)}s (request ${uuid})`,
        "merge-timeout",
        { uuid, pr: number },
      );
    }
    await sleep(pollMs);
    state = await mergeAsyncStatus(exec, where, number, uuid);
    if (state.status === "pending") emit("pending", { ...state, uuid: state.uuid ?? uuid });
  }
  const final = { ...state, uuid: state.uuid ?? uuid };
  if (state.status === "failed") {
    emit("failed", final);
    throw new StkError(`merge of #${number} failed: ${state.message ?? "no reason given"}`, "gh-failed", { uuid });
  }
  emit(state.status, final);
  return { status: state.status, ...(final.uuid ? { uuid: final.uuid } : {}), ...(state.sha ? { sha: state.sha } : {}), ...(state.message ? { message: state.message } : {}) };
}

// ---------- native stacks ----------

/** What a stack list shows of one PR; `checks` is the rollup (failure wins, then pending). */
export interface PrSummary {
  number: number;
  /** Head branch, so a base branch can be traced back to the PR that owns it. */
  headRef?: string;
  title: string;
  state: PullRequest["state"];
  isDraft: boolean;
  checks: "pass" | "fail" | "pending" | "none";
  /** Set when GitHub reports conflicts with the base, or has not computed mergeability yet. */
  mergeIssue?: "conflict" | "checking" | "blocked";
}

export interface NativeStackEntry extends PrSummary {
  position: number;
}

export interface NativeStack {
  /** Stack entries, bottom (position 1) first, including merged ones. */
  entries: NativeStackEntry[];
  /** Position of the queried PR. */
  position: number;
}

interface GqlSummary {
  number: number;
  title: string;
  state: string;
  headRefName?: string;
  isDraft: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  statusCheckRollup?: { state: string } | null;
}

const SUMMARY_FIELDS = "number headRefName title state isDraft mergeable mergeStateStatus statusCheckRollup { state }";

function mapSummary(p: GqlSummary): PrSummary {
  const r = p.statusCheckRollup?.state;
  const checks = !r ? "none" : r === "SUCCESS" ? "pass" : r === "FAILURE" || r === "ERROR" ? "fail" : "pending";
  const open = p.state !== "MERGED" && p.state !== "CLOSED";
  const mergeIssue = !open ? undefined : p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY" ? "conflict" : p.mergeStateStatus === "UNKNOWN" ? "checking" : undefined;
  return {
    number: p.number,
    ...(p.headRefName ? { headRef: p.headRefName } : {}),
    title: p.title,
    state: p.state === "MERGED" ? "MERGED" : p.state === "CLOSED" ? "CLOSED" : "OPEN",
    isDraft: p.isDraft,
    checks,
    ...(mergeIssue ? { mergeIssue } : {}),
  };
}

const NATIVE_STACK_QUERY = `query($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) { pullRequest(number: $n) {
    stackEntry { position }
    stack { size entries(first: 100) { nodes { position pullRequest { ${SUMMARY_FIELDS} } } } }
  } }
}`;

/**
 * GitHub's native stacked-PR membership for `number` (GraphQL `PullRequest.stack`, the same data as REST
 * `pull.stack`), or null when the PR is not in a stack of 2+ PRs. One query also carries every member's
 * title, state, draft flag and checks rollup, so callers need no per-member lookups.
 */
export async function nativeStack(exec: Exec, where: Where, number: number): Promise<NativeStack | null> {
  const { owner, name } = await slugOf(exec, where);
  const out = await gh(exec, where, [
    "api", "graphql", "-f", `query=${NATIVE_STACK_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${number}`,
  ]);
  const j = parseJson<{
    data?: {
      repository?: {
        pullRequest?: {
          stackEntry?: { position: number } | null;
          stack?: { size: number; entries: { nodes: { position: number; pullRequest: GqlSummary | null }[] } } | null;
        } | null;
      };
    };
  }>(out, `native stack of #${number}`);
  const pr = j.data?.repository?.pullRequest;
  if (!pr?.stack || !pr.stackEntry || pr.stack.size < 2) return null;
  const entries = pr.stack.entries.nodes.flatMap((e): NativeStackEntry[] =>
    e.pullRequest ? [{ ...mapSummary(e.pullRequest), position: e.position }] : [],
  );
  entries.sort((a, b) => a.position - b.position);
  return { entries, position: pr.stackEntry.position };
}

const MEMBER_FIELDS = `number title url state isDraft headRefName baseRefName headRefOid mergeable mergeStateStatus reviewDecision createdAt updatedAt
  author { login }
  statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name status conclusion detailsUrl } ... on StatusContext { context state targetUrl } } } }
  reviewThreads(first: 100) { nodes { isResolved } }`;

const NATIVE_STACK_DETAIL_QUERY = `query($o: String!, $r: String!, $n: Int!) {
  repository(owner: $o, name: $r) { defaultBranchRef { name } pullRequest(number: $n) {
    stackEntry { position }
    stack { size entries(first: 100) { nodes { position pullRequest { ${MEMBER_FIELDS} } } } }
  } }
}`;

export interface NativeStackDetail {
  trunk: string;
  /** Position of the queried PR. */
  position: number;
  /** Every member (merged ones included), bottom first, with checks, review state and unresolved-thread counts filled. */
  members: { position: number; pr: PullRequest }[];
}

/**
 * The native stack of `number` with every member's full planning data (mergeable, review decision, check rollup,
 * unresolved threads, head sha) and the repo's default branch, in ONE GraphQL call. Null when not in a 2+ stack.
 */
export async function nativeStackDetail(exec: Exec, where: Where, number: number): Promise<NativeStackDetail | null> {
  const { owner, name } = await slugOf(exec, where);
  const out = await gh(exec, where, [
    "api", "graphql", "-f", `query=${NATIVE_STACK_DETAIL_QUERY}`, "-f", `o=${owner}`, "-f", `r=${name}`, "-F", `n=${number}`,
  ]);
  type GqlMember = Omit<RawPr, "statusCheckRollup" | "author"> & {
    author?: { login?: string } | null;
    statusCheckRollup?: { contexts: { nodes: RollupItem[] } } | null;
    reviewThreads: { nodes: { isResolved: boolean }[] };
  };
  const j = parseJson<{
    data?: {
      repository?: {
        defaultBranchRef?: { name?: string } | null;
        pullRequest?: {
          stackEntry?: { position: number } | null;
          stack?: { size: number; entries: { nodes: { position: number; pullRequest: GqlMember | null }[] } } | null;
        } | null;
      } | null;
    };
  }>(out, `native stack of #${number}`);
  const repo = j.data?.repository;
  const pr = repo?.pullRequest;
  if (!pr?.stack || !pr.stackEntry || pr.stack.size < 2) return null;
  const trunk = repo?.defaultBranchRef?.name;
  if (!trunk) throw new StkError("could not determine default branch", "gh-failed");
  const members = pr.stack.entries.nodes.flatMap((e) => {
    const m = e.pullRequest;
    if (!m) return [];
    const mapped = mapPr({ ...m, statusCheckRollup: m.statusCheckRollup?.contexts.nodes ?? [] });
    return [{ position: e.position, pr: { ...mapped, unresolvedThreads: m.reviewThreads.nodes.filter((t) => !t.isResolved).length } }];
  });
  members.sort((a, b) => a.position - b.position);
  return { trunk, position: pr.stackEntry.position, members };
}

/**
 * Create a GitHub stack from open PRs, bottom to top (REST `POST /repos/{o}/{r}/stacks`, body `{pull_requests}`).
 * GitHub answers 201 with the stack, 404 for unknown PRs and 422 when they cannot form a stack (each base must be the
 * previous PR's head, the bottom's base the trunk).
 */
export async function createPrStack(exec: Exec, where: Where, prs: number[]): Promise<{ number: number; size: number }> {
  const { owner, name } = await slugOf(exec, where);
  const res = await ghApiRaw(exec, where, ["-X", "POST", `repos/${owner}/${name}/stacks`, "--input", "-"], JSON.stringify({ pull_requests: prs }));
  if (res.status === 201 || res.status === 200) {
    const b = res.body as { number?: number; pull_requests?: unknown[] } | null;
    return { number: b?.number ?? 0, size: b?.pull_requests?.length ?? prs.length };
  }
  const msg = (res.body as { message?: string } | null)?.message;
  if (res.status === 404) throw new StkError(`GitHub could not find ${prs.map((n) => `#${n}`).join(", ")} or the stacks API is not enabled for this repository${msg ? `: ${msg}` : ""}`, "gh-failed");
  if (res.status === 422) throw new StkError(`GitHub cannot make these PRs a stack${msg ? `: ${msg}` : ""}`, "gh-failed");
  throw apiError(res, "creating the stack");
}

/** Full planning data (checks, review state, unresolved threads) of several PRs in ONE aliased GraphQL call, in `numbers` order. */
export async function prDetails(exec: Exec, where: Where, numbers: number[]): Promise<PullRequest[]> {
  if (numbers.length === 0) return [];
  const { owner, name } = await slugOf(exec, where);
  const aliases = numbers.map((n) => `pr${n}: pullRequest(number: ${n}) { ${MEMBER_FIELDS} }`).join("\n    ");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n    ${aliases}\n  } }`;
  const out = await gh(exec, where, ["api", "graphql", "-f", `query=${query}`]);
  type GqlMember = Omit<RawPr, "statusCheckRollup" | "author"> & {
    author?: { login?: string } | null;
    statusCheckRollup?: { contexts: { nodes: RollupItem[] } } | null;
    reviewThreads: { nodes: { isResolved: boolean }[] };
  };
  const j = parseJson<{ data?: { repository?: Record<string, GqlMember | null> | null } }>(out, "pr details");
  return numbers.map((n) => {
    const m = j.data?.repository?.[`pr${n}`];
    if (!m) throw new StkError(`PR #${n} was not found`, "gh-failed");
    const mapped = mapPr({ ...m, statusCheckRollup: m.statusCheckRollup?.contexts.nodes ?? [] });
    return { ...mapped, unresolvedThreads: m.reviewThreads.nodes.filter((t) => !t.isResolved).length };
  });
}

/** Full PR commit history, oldest first; each commit includes its own paginated check results. */
export async function commitHistory(exec: Exec, where: Where, number: number): Promise<PrCommit[]> {
  const repo = await slugOf(exec, where);
  return fetchCommitHistory(async <T>(query: string, variables: Record<string, string | number>): Promise<T> => {
    const args = ["api", "graphql", "-f", `query=${query}`];
    for (const [key, value] of Object.entries(variables)) args.push(typeof value === "number" ? "-F" : "-f", `${key}=${value}`);
    return parseJson<T>(await gh(exec, where, args), "commit history");
  }, repo, number, mapCheck);
}

/** Commits `base` has that `head` lacks (REST compare, `behind_by`); one call, for the opened PR only. */
export async function behindBy(exec: Exec, where: Where, base: string, head: string): Promise<number> {
  const { owner, name } = await slugOf(exec, where);
  const res = await ghApiRaw(exec, where, [`repos/${owner}/${name}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`]);
  if (res.status !== 200) throw apiError(res, `compare ${base}...${head}`);
  return (res.body as { behind_by?: number } | null)?.behind_by ?? 0;
}

/**
 * What the rules on `branch` require (REST `rules/branches/{branch}`, ONE call): required status check contexts and
 * whether the pull_request rule demands code owner review. Rulesets only; classic branch protection is not listed.
 */
export async function branchRules(exec: Exec, where: Where, branch: string): Promise<RepoRules> {
  const { owner, name } = await slugOf(exec, where);
  const res = await ghApiRaw(exec, where, [`repos/${owner}/${name}/rules/branches/${encodeURIComponent(branch)}`]);
  if (res.status !== 200) throw apiError(res, `rules of ${branch}`);
  type Rule = { type?: string; parameters?: { require_code_owner_review?: boolean; required_status_checks?: { context?: string }[] } };
  const rules = Array.isArray(res.body) ? (res.body as Rule[]) : [];
  const requiredChecks: string[] = [];
  for (const r of rules) {
    if (r.type !== "required_status_checks") continue;
    for (const c of r.parameters?.required_status_checks ?? []) if (c.context && !requiredChecks.includes(c.context)) requiredChecks.push(c.context);
  }
  return { requiredChecks, codeOwnerReview: rules.some((r) => r.type === "pull_request" && r.parameters?.require_code_owner_review === true) };
}

/**
 * Merges the base branch into the PR head (`PUT pulls/{n}/update-branch`). `expectedHeadSha` makes GitHub reject
 * the update (422) if the head moved. 202 = queued; anything else throws.
 */
export async function updateBranch(exec: Exec, where: Where, number: number, expectedHeadSha: string): Promise<void> {
  const { owner, name } = await slugOf(exec, where);
  const res = await ghApiRaw(
    exec,
    where,
    ["-X", "PUT", `repos/${owner}/${name}/pulls/${number}/update-branch`, "--input", "-"],
    JSON.stringify({ expected_head_sha: expectedHeadSha }),
  );
  if (res.status !== 202 && res.status !== 200) throw apiError(res, `update-branch of #${number}`);
}

/** Title, state, draft flag and checks rollup of several PRs in one aliased GraphQL query; unknown numbers are absent. */
export async function prSummaries(exec: Exec, where: Where, numbers: number[]): Promise<Map<number, PrSummary>> {
  const out = new Map<number, PrSummary>();
  if (numbers.length === 0) return out;
  const { owner, name } = await slugOf(exec, where);
  const aliases = numbers.map((n) => `pr${n}: pullRequest(number: ${n}) { ${SUMMARY_FIELDS} }`).join("\n    ");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n    ${aliases}\n  } }`;
  const text = await gh(exec, where, ["api", "graphql", "-f", `query=${query}`]);
  const j = parseJson<{ data?: { repository?: Record<string, GqlSummary | null> | null } }>(text, "pr summaries");
  const repo = j.data?.repository ?? {};
  for (const n of numbers) {
    const p = repo[`pr${n}`];
    if (p) out.set(n, mapSummary(p));
  }
  return out;
}

export async function retargetPr(
  exec: Exec,
  cwd: Where,
  number: number,
  base: string,
): Promise<void> {
  await gh(exec, cwd, ["pr", "edit", String(number), "--base", base]);
}

interface BucketCheck {
  name: string;
  state: string;
  bucket: string;
  workflow?: string;
  link?: string | null;
}

function mapBucket(c: BucketCheck): Check {
  const state: CheckState =
    c.bucket === "pass"
      ? "pass"
      : c.bucket === "pending"
        ? "pending"
        : c.bucket === "skipping"
          ? "skipped"
          : "fail"; // fail, cancel
  return { name: c.name, state, url: c.link ?? null };
}

export async function waitChecks(
  exec: Exec,
  cwd: Where,
  number: number,
  opts: {
    timeoutMs: number;
    intervalMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
    /** Required contexts must report success on the pushed head, even before CI registers them. */
    requiredChecks?: readonly string[];
    expectedHeadSha?: string;
  },
): Promise<Check[]> {
  const interval = opts.intervalMs ?? 15_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const deadline = now() + opts.timeoutMs;
  const readHead = async (): Promise<string> => {
    const out = await gh(exec, cwd, ["pr", "view", String(number), "--json", "headRefOid"]);
    const sha = parseJson<{ headRefOid?: string }>(out, "PR head").headRefOid;
    if (!sha) throw new StkError(`could not read the head of #${number}`, "gh-failed");
    return sha;
  };
  for (;;) {
    // gh exits 8 while checks are pending and 1 on failures; stdout is still valid JSON.
    const fields = opts.requiredChecks?.length ? "name,state,bucket,workflow" : "name,state,bucket";
    const head = opts.expectedHeadSha ? await readHead() : null;
    const { argv, cwd: runIn } = ghInvocation(cwd, ["pr", "checks", String(number), "--json", fields]);
    const r = await exec(argv, runIn === undefined ? {} : { cwd: runIn });
    const text = r.stdout.trim();
    const noChecks = /no checks reported/i.test(r.stderr + r.stdout);
    if (!text.startsWith("[") && !noChecks) throw await ghFailure(exec, r.stderr, r.stdout, "gh pr checks failed");
    const reported = noChecks ? [] : parseJson<BucketCheck[]>(text, "pr checks");
    const checks = reported.map(mapBucket);
    for (const context of opts.requiredChecks ?? []) {
      const matches = reported.filter((c) => c.name === context || (c.workflow && `${c.workflow} / ${c.name}` === context));
      if (!matches.length || matches.every((c) => c.bucket === "skipping")) checks.push({ name: context, state: "pending", url: null });
    }
    const headMatches = !opts.expectedHeadSha || head === opts.expectedHeadSha;
    if (headMatches && !checks.some((c) => c.state === "pending")) {
      // The check call is PR-scoped: ensure its head did not change between reads.
      if (!opts.expectedHeadSha || (await readHead()) === opts.expectedHeadSha) return checks;
    }
    if (now() + interval > deadline) {
      throw new StkError(`timed out waiting for checks on #${number}`, "gh-failed");
    }
    await sleep(interval);
  }
}

// ---------- session PRs (repo-less, one GraphQL query per repo) ----------

export type SessionFetchedPr = PullRequest & { mergedAt: string | null; closedAt: string | null };

const SESSION_PR_FIELDS = `number title url state isDraft headRefName baseRefName headRefOid
      mergeable mergeStateStatus reviewDecision mergedAt closedAt createdAt updatedAt author { login }
      reviewThreads(first: 100) { nodes { isResolved } }
      commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
        __typename
        ... on CheckRun { name status conclusion detailsUrl }
        ... on StatusContext { context state targetUrl }
      } } } } } }`;

interface SessionRawPr extends Omit<RawPr, "statusCheckRollup"> {
  mergedAt?: string | null;
  closedAt?: string | null;
  reviewThreads?: { nodes: { isResolved: boolean }[] };
  commits?: { nodes: { commit: { statusCheckRollup: { contexts: { nodes: RollupItem[] } } | null } }[] };
}

/** The given PRs of one repo in a single query. Missing/inaccessible PRs are omitted. */
export async function fetchSessionPrs(
  exec: Exec,
  slug: RepoSlug,
  numbers: number[],
): Promise<{ trunk: string | null; prs: SessionFetchedPr[] }> {
  if (numbers.length === 0) return { trunk: null, prs: [] };
  const aliases = numbers.map((n) => `pr${n}: pullRequest(number: ${n}) { ${SESSION_PR_FIELDS} }`).join("\n    ");
  const query = `query { repository(owner: ${JSON.stringify(slug.owner)}, name: ${JSON.stringify(slug.name)}) {
    defaultBranchRef { name }
    ${aliases}
  } }`;
  // gh exits nonzero when some aliases are NOT_FOUND but still prints partial data; accept that.
  const { argv } = ghInvocation(slug, ["api", "graphql", "-f", `query=${query}`]);
  const r = await exec(argv, {});
  const text = r.stdout.trim();
  if (!text.startsWith("{")) throw await ghFailure(exec, r.stderr, r.stdout, "gh api graphql failed");
  const j = parseJson<{ data?: { repository?: Record<string, unknown> | null } }>(text, "session prs");
  const repo = j.data?.repository;
  if (!repo) throw new StkError(`${slug.owner}/${slug.name}: repository not found or not accessible`, "gh-failed");
  const trunk = (repo.defaultBranchRef as { name?: string } | null | undefined)?.name ?? null;
  const prs: SessionFetchedPr[] = [];
  for (const n of numbers) {
    const raw = repo[`pr${n}`] as SessionRawPr | null | undefined;
    if (!raw) continue;
    const rollup = raw.commits?.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
    const pr = mapPr({ ...raw, statusCheckRollup: rollup });
    pr.unresolvedThreads = (raw.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length;
    prs.push({ ...pr, mergedAt: raw.mergedAt ?? null, closedAt: raw.closedAt ?? null });
  }
  return { trunk, prs };
}

/**
 * `gh search prs` over one owner (REST search bucket, 30/min; no GraphQL points). Explicit user action only.
 * Rate limits surface as StkError `rate-limited`.
 */
export async function searchPrs(exec: Exec, owner: string, query: string, limit = 20): Promise<PaletteItem[]> {
  const r = await exec([
    "gh", "search", "prs", "--owner", owner,
    "--json", "number,title,repository,state,author,updatedAt,url",
    "--limit", String(limit),
    "--", query,
  ]);
  if (r.code !== 0) throw await ghFailure(exec, r.stderr, r.stdout, "gh search prs failed");
  const rows = parseJson<
    {
      number: number;
      title: string;
      repository: { nameWithOwner: string };
      state: string;
      author: { login: string } | null;
      updatedAt: string;
    }[]
  >(r.stdout, "search prs");
  return rows.map((x) => ({
    repo: x.repository.nameWithOwner,
    number: x.number,
    title: x.title,
    headRef: "",
    author: x.author?.login ?? "",
    state: x.state === "merged" ? "MERGED" : x.state === "closed" ? "CLOSED" : "OPEN",
    isDraft: false,
    updatedAt: x.updatedAt,
  }));
}

// ---------- PR state mutations ----------

export async function closePr(exec: Exec, where: Where, n: number): Promise<void> {
  await gh(exec, where, ["pr", "close", String(n)]);
}

export async function reopenPr(exec: Exec, where: Where, n: number): Promise<void> {
  await gh(exec, where, ["pr", "reopen", String(n)]);
}

/** Marks a draft PR ready for review; `undo` converts a ready PR back to draft. */
export async function markReady(exec: Exec, where: Where, n: number, undo = false): Promise<void> {
  await gh(exec, where, ["pr", "ready", String(n), ...(undo ? ["--undo"] : [])]);
}

/** Re-runs the failed jobs of every workflow run with a failing/cancelled check on the PR's head. */
export async function rerunFailedChecks(exec: Exec, where: Where, n: number): Promise<{ runs: number[] }> {
  // gh exits nonzero while checks fail or are pending; stdout is still valid JSON.
  const { argv, cwd } = ghInvocation(where, ["pr", "checks", String(n), "--json", "name,bucket,link"]);
  const r = await exec(argv, cwd === undefined ? {} : { cwd });
  const text = r.stdout.trim();
  if (!text.startsWith("[")) throw await ghFailure(exec, r.stderr, r.stdout, `gh pr checks ${n} failed`);
  const checks = parseJson<{ name: string; bucket?: string; link?: string }[]>(text, "pr checks");
  const runs: number[] = [];
  for (const c of checks) {
    if (c.bucket !== "fail" && c.bucket !== "cancel") continue;
    const m = /\/actions\/runs\/(\d+)/.exec(c.link ?? "");
    const id = m ? Number(m[1]) : NaN;
    if (Number.isFinite(id) && !runs.includes(id)) runs.push(id);
  }
  if (runs.length === 0) throw new StkError("no failing checks to re-run", "gh-failed");
  for (const id of runs) await gh(exec, where, ["run", "rerun", String(id), "--failed"]);
  return { runs };
}

// ---------- re-running a required check that never reported ----------

export interface CheckRunInfo {
  name: string;
  status: string;
  conclusion: string | null;
  /** App that produced the run (`github-actions`, `depot`, ...). */
  app: string | null;
  suiteId: number | null;
  /** Workflow run id when the check run is a GitHub Actions job. */
  workflowRunId: number | null;
}

export interface CheckSuiteInfo {
  id: number;
  app: string | null;
  status: string;
  conclusion: string | null;
  runCount: number;
}

export interface WorkflowRunInfo {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
}

async function apiGet<T>(exec: Exec, where: Where, path: string, what: string): Promise<T> {
  const { owner, name } = await slugOf(exec, where);
  const res = await ghApiRaw(exec, where, [`repos/${owner}/${name}/${path}`]);
  if (res.status !== 200) throw apiError(res, what);
  return res.body as T;
}

/** Check runs reported on a commit. */
export async function commitCheckRuns(exec: Exec, where: Where, sha: string): Promise<CheckRunInfo[]> {
  const b = await apiGet<{ check_runs?: { name: string; status: string; conclusion: string | null; details_url?: string | null; app?: { slug?: string } | null; check_suite?: { id?: number } | null }[] }>(
    exec, where, `commits/${sha}/check-runs?per_page=100`, "listing check runs",
  );
  return (b.check_runs ?? []).map((r) => {
    const m = /\/actions\/runs\/(\d+)/.exec(r.details_url ?? "");
    return { name: r.name, status: r.status, conclusion: r.conclusion, app: r.app?.slug ?? null, suiteId: r.check_suite?.id ?? null, workflowRunId: m ? Number(m[1]) : null };
  });
}

/** Check suites on a commit (one per app that was asked to check it). */
export async function commitCheckSuites(exec: Exec, where: Where, sha: string): Promise<CheckSuiteInfo[]> {
  const b = await apiGet<{ check_suites?: { id: number; status: string; conclusion: string | null; latest_check_runs_count?: number; app?: { slug?: string } | null }[] }>(
    exec, where, `commits/${sha}/check-suites?per_page=100`, "listing check suites",
  );
  return (b.check_suites ?? []).map((s) => ({ id: s.id, app: s.app?.slug ?? null, status: s.status, conclusion: s.conclusion, runCount: s.latest_check_runs_count ?? 0 }));
}

/** GitHub Actions workflow runs of a commit. */
export async function headWorkflowRuns(exec: Exec, where: Where, sha: string): Promise<WorkflowRunInfo[]> {
  const b = await apiGet<{ workflow_runs?: { id: number; name?: string | null; status: string; conclusion: string | null }[] }>(
    exec, where, `actions/runs?head_sha=${sha}&per_page=100`, "listing workflow runs",
  );
  return (b.workflow_runs ?? []).map((r) => ({ id: r.id, name: r.name ?? "", status: r.status, conclusion: r.conclusion }));
}

/** Job names of one workflow run. */
export async function workflowRunJobs(exec: Exec, where: Where, runId: number): Promise<string[]> {
  const b = await apiGet<{ jobs?: { name: string }[] }>(exec, where, `actions/runs/${runId}/jobs?per_page=100`, `listing jobs of run ${runId}`);
  return (b.jobs ?? []).map((j) => j.name);
}

/** `gh run rerun`: every job, or only the failed ones. */
export async function rerunWorkflowRun(exec: Exec, where: Where, runId: number, failedOnly: boolean): Promise<void> {
  await gh(exec, where, ["run", "rerun", String(runId), ...(failedOnly ? ["--failed"] : [])]);
}

/** Asks GitHub to have the app re-run its check suite (`POST check-suites/{id}/rerequest`, 201). */
export async function rerequestCheckSuite(exec: Exec, where: Where, suiteId: number): Promise<void> {
  const { owner, name } = await slugOf(exec, where);
  const res = await ghApiRaw(exec, where, ["-X", "POST", `repos/${owner}/${name}/check-suites/${suiteId}/rerequest`]);
  if (res.status !== 201 && res.status !== 200 && res.status !== 204) throw apiError(res, `re-requesting check suite ${suiteId}`);
}

// ---------- creating a PR ----------

export interface CreatePrInput {
  head: string;
  base: string;
  title: string;
  body: string;
  draft: boolean;
}

/** `gh pr create` for a branch that is already on origin; the body goes through stdin. */
export async function createPr(exec: Exec, where: Where, o: CreatePrInput): Promise<{ number: number; url: string }> {
  const args = ["pr", "create", "--head", o.head, "--base", o.base, "--title", o.title, "--body-file", "-"];
  if (o.draft) args.push("--draft");
  const out = await gh(exec, where, args, o.body);
  const url = out.trim().split("\n").pop()?.trim() ?? "";
  const m = /\/pull\/(\d+)/.exec(url);
  if (!m) throw new StkError(`gh pr create did not print a PR URL: ${out.trim().slice(0, 200) || "(empty)"}`, "gh-failed");
  return { number: Number(m[1]), url };
}
