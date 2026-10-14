import { StkError, type Check, type PrCommit, type RepoSlug } from "./types";

interface Page<T> {
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}
interface Context {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string | null;
  state?: string;
  detailsUrl?: string | null;
  targetUrl?: string | null;
  databaseId?: number | null;
  startedAt?: string | null;
  createdAt?: string;
  checkSuite?: { app?: { databaseId?: number | null } | null } | null;
}
interface Commit {
  id: string;
  oid: string;
  messageHeadline: string;
  committedDate: string;
  url: string;
  author: { name?: string; user?: { login?: string } | null } | null;
  statusCheckRollup: { contexts: Page<Context> } | null;
}

type Query = <T>(query: string, variables: Record<string, string | number>) => Promise<T>;
const CONTEXT_FIELDS = `__typename
  ... on CheckRun { databaseId name status conclusion detailsUrl startedAt checkSuite { app { databaseId } } }
  ... on StatusContext { context state targetUrl createdAt }`;
const HISTORY_QUERY = `query($o: String!, $r: String!, $n: Int!, $c: String) {
  repository(owner: $o, name: $r) { pullRequest(number: $n) {
    commits(first: 100, after: $c) { pageInfo { hasNextPage endCursor } nodes { commit {
      id oid messageHeadline committedDate url author { name user { login } }
      statusCheckRollup { contexts(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${CONTEXT_FIELDS} } } }
    } } }
  } }
}`;
const CONTEXTS_QUERY = `query($id: ID!, $c: String!) { node(id: $id) { ... on Commit {
  statusCheckRollup { contexts(first: 100, after: $c) { pageInfo { hasNextPage endCursor } nodes { ${CONTEXT_FIELDS} } } }
} } }`;

function nextCursor<T>(page: Page<T>): string | null {
  if (!page.pageInfo.hasNextPage) return null;
  if (!page.pageInfo.endCursor) throw new StkError("GitHub returned an incomplete commit history page", "gh-failed");
  return page.pageInfo.endCursor;
}

/** Rollups may contain old runs: keep the newest run per app/name, not whichever page arrived last. */
function latestChecks(contexts: Context[], map: (context: Context) => Check): Check[] {
  const latest = new Map<string, Context>();
  for (const context of contexts) {
    const key = context.context !== undefined
      ? `status:${context.context}`
      : `check:${context.checkSuite?.app?.databaseId ?? ""}:${context.name ?? ""}`;
    const previous = latest.get(key);
    const newer = previous && context.databaseId != null && previous.databaseId != null
      ? context.databaseId >= previous.databaseId
      : (context.createdAt ?? context.startedAt ?? "") >= (previous?.createdAt ?? previous?.startedAt ?? "");
    if (!previous || newer) latest.set(key, context);
  }
  return [...latest.values()].map(map);
}

/** Complete chronological PR history, including every page of each commit's check/status contexts. */
export async function fetchCommitHistory(query: Query, repo: RepoSlug, number: number, map: (context: Context) => Check): Promise<PrCommit[]> {
  const commits = new Map<string, PrCommit>();
  let cursor: string | null = null;
  do {
    const variables: Record<string, string | number> = { o: repo.owner, r: repo.name, n: number };
    if (cursor) variables.c = cursor;
    const result = await query<{ data?: { repository?: { pullRequest?: { commits: Page<{ commit: Commit }> } | null } | null }; errors?: { message: string }[] }>(HISTORY_QUERY, variables);
    if (result.errors?.length) throw new StkError(result.errors.map((e) => e.message).join("; "), "gh-failed");
    const page = result.data?.repository?.pullRequest?.commits;
    if (!page) throw new StkError(`commit history of #${number} was not found`, "gh-failed");
    for (const { commit } of page.nodes) {
      const contexts = [...(commit.statusCheckRollup?.contexts.nodes ?? [])];
      let after = commit.statusCheckRollup ? nextCursor(commit.statusCheckRollup.contexts) : null;
      while (after) {
        const more = await query<{ data?: { node?: { statusCheckRollup?: { contexts: Page<Context> } | null } | null }; errors?: { message: string }[] }>(CONTEXTS_QUERY, { id: commit.id, c: after });
        if (more.errors?.length) throw new StkError(more.errors.map((e) => e.message).join("; "), "gh-failed");
        const next = more.data?.node?.statusCheckRollup?.contexts;
        if (!next) throw new StkError(`checks for commit ${commit.oid} were not found`, "gh-failed");
        contexts.push(...next.nodes);
        const following = nextCursor(next);
        if (following === after) throw new StkError("GitHub repeated a commit checks page", "gh-failed");
        after = following;
      }
      commits.set(commit.oid, {
        sha: commit.oid, message: commit.messageHeadline, author: commit.author?.user?.login ?? commit.author?.name ?? "",
        committedAt: commit.committedDate, url: commit.url, checks: latestChecks(contexts, map),
      });
    }
    const next = nextCursor(page);
    if (next && next === cursor) throw new StkError("GitHub repeated a commit history page", "gh-failed");
    cursor = next;
  } while (cursor);
  return [...commits.values()];
}
