/**
 * Workspace board: the PRs of every repo found under a directory (see `discoverWorkspace`), merged into one list.
 * One `listBoard` query per repo per refresh; rows carry their repo, like the session board's.
 */
import { listBoard, openCtx, slugCtx, type Board, type BoardPr, type BoardScope, type Ctx, type RepoSlug } from "./service";
import type { WorkspaceRepo } from "./repos";
import { StkError, type Exec } from "./types";

export type WorkspacePr = BoardPr & { repo: RepoSlug };

/** A `Board` whose rows span repos; `repo` is empty (the rows say which repo they belong to). */
export interface WorkspaceBoard extends Board {
  prs: WorkspacePr[];
  /** Repos whose board could not be loaded (the others are still shown). */
  errors: { repo: RepoSlug; message: string }[];
}

export const NO_REPO: RepoSlug = { owner: "", name: "" };
const slugKey = (r: RepoSlug) => `${r.owner}/${r.name}`.toLowerCase();
const LIST_CONCURRENCY = 4;

export type RepoBoard = { repo: RepoSlug; board: Board } | { repo: RepoSlug; error: string };

/** Merge per-repo boards: newest activity first, ties by repo then PR number (newest number first). */
export function mergeBoards(parts: RepoBoard[]): WorkspaceBoard {
  const prs: WorkspacePr[] = [];
  const errors: WorkspaceBoard["errors"] = [];
  for (const part of parts) {
    if ("error" in part) errors.push({ repo: part.repo, message: part.error });
    else for (const p of part.board.prs) prs.push({ ...p, repo: part.repo });
  }
  prs.sort(
    (a, b) =>
      (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
      slugKey(a.repo).localeCompare(slugKey(b.repo)) ||
      b.number - a.number,
  );
  return { repo: NO_REPO, trunk: "", prs, errors };
}

/** Context for a discovered repo: its checkout (worktrees included), or repo-less when the checkout is unusable. */
export async function openWorkspaceCtx(exec: Exec, repo: WorkspaceRepo): Promise<Ctx> {
  try {
    return { ...(await openCtx(exec, repo.dir)), slug: repo.slug };
  } catch (e) {
    if (!(e instanceof StkError)) throw e;
    return slugCtx(exec, repo.slug);
  }
}

/**
 * One board per repo (at most LIST_CONCURRENCY at once), merged. A rate limit aborts the whole load (the caller
 * backs off); other failures are reported per repo, unless every repo failed, which throws the first.
 */
export async function listWorkspaceBoard(ctxFor: (repo: WorkspaceRepo) => Promise<Ctx>, repos: WorkspaceRepo[], scope: BoardScope): Promise<WorkspaceBoard> {
  const out: RepoBoard[] = new Array(repos.length);
  let next = 0;
  let limited = null as StkError | null;
  let firstError: unknown;
  const worker = async () => {
    for (let i = next++; i < repos.length && !limited; i = next++) {
      const r = repos[i]!;
      try {
        out[i] = { repo: r.slug, board: await listBoard(await ctxFor(r), scope) };
      } catch (e) {
        if (e instanceof StkError && e.code === "rate-limited") limited = e;
        firstError ??= e;
        out[i] = { repo: r.slug, error: e instanceof Error ? e.message : String(e) };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, repos.length) }, worker));
  if (limited) throw limited;
  if (out.length > 0 && out.every((p) => "error" in p)) throw firstError;
  return mergeBoards(out);
}
