/**
 * Published-tip provenance: the heads a member branch had on origin before a restack replaced them.
 *
 * A restack rewrites branches in a throwaway checkout and deliberately leaves the user's local branches at their old tips.
 * Those tips are published history, but nothing in git says so once origin moved on, and the next job would take them for
 * unpushed work. So after every verified leased push the replaced heads are remembered here, keyed by repo and branch, in
 * `$STK_STATE_DIR/restack-provenance.json` (default `~/.cache/stk`). The file only ever clears a tip that the preflight
 * also finds as a real commit in the repo; a missing or corrupt file is simply empty.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Heads kept per branch, newest last. */
export const MAX_HEADS_PER_BRANCH = 20;
/** Entries older than this are dropped on the next write. */
export const KEEP_MS = 30 * 24 * 60 * 60_000;

interface Head {
  sha: string;
  at: number;
}
type Store = Record<string, Record<string, Head[]>>;

export const stateDir = (): string => process.env.STK_STATE_DIR || join(homedir(), ".cache", "stk");
export const provenanceFile = () => join(stateDir(), "restack-provenance.json");

/** One repo in the store: the GitHub slug plus the checkout, so two clones of a repo do not vouch for each other. */
export const provenanceKey = (slug: { owner: string; name: string } | undefined, root: string): string => `${slug ? `${slug.owner}/${slug.name}` : "-"}@${root}`;

const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);

/** Everything well-formed in the file; anything else (missing, truncated, wrong shape) is dropped. */
function readStore(): Store {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(provenanceFile(), "utf8"));
  } catch {
    return {};
  }
  const out: Store = {};
  const repos = (raw as { repos?: unknown } | null)?.repos;
  if (!repos || typeof repos !== "object") return out;
  for (const [repo, branches] of Object.entries(repos as Record<string, unknown>)) {
    if (!branches || typeof branches !== "object") continue;
    for (const [branch, heads] of Object.entries(branches as Record<string, unknown>)) {
      if (!Array.isArray(heads)) continue;
      const good = heads.filter((h): h is Head => !!h && isSha((h as Head).sha) && Number.isFinite((h as Head).at));
      if (good.length) (out[repo] ??= {})[branch] = good.map((h) => ({ sha: h.sha, at: h.at }));
    }
  }
  return out;
}

/** The heads recorded for each branch of `repo`; empty when there is nothing usable. */
export function loadProvenance(repo: string): Record<string, string[]> {
  const mine = readStore()[repo] ?? {};
  return Object.fromEntries(Object.entries(mine).map(([branch, heads]) => [branch, heads.map((h) => h.sha)]));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Cross-process mutex (mkdir is atomic). A stale or stuck lock is broken, and after a while we write anyway: the rename keeps the file whole either way. */
function withLock<T>(fn: () => T): T {
  const lock = `${provenanceFile()}.lock`;
  let held = false;
  for (let i = 0; i < 100 && !held; i++) {
    try {
      mkdirSync(lock);
      held = true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) rmSync(lock, { recursive: true, force: true });
      } catch {
        /* released meanwhile */
      }
      sleepSync(20);
    }
  }
  try {
    return fn();
  } finally {
    if (held) rmSync(lock, { recursive: true, force: true });
  }
}

/**
 * Remember that `heads` (a branch and a head it had on origin before being replaced) were published. Read-merge-write under a
 * lock, written to a temp file and renamed, so concurrent stk processes never see or leave half a file. Best effort: a
 * failure to persist must not fail a restack that already pushed.
 */
export function recordProvenance(repo: string, heads: { branch: string; sha: string }[], now = Date.now()): void {
  if (heads.length === 0) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    withLock(() => {
      const store = readStore();
      for (const { branch, sha } of heads) {
        const list = ((store[repo] ??= {})[branch] ??= []).filter((h) => h.sha !== sha);
        list.push({ sha, at: now });
        store[repo]![branch] = list;
      }
      for (const [r, branches] of Object.entries(store)) {
        for (const [branch, list] of Object.entries(branches)) {
          const kept = list.filter((h) => now - h.at <= KEEP_MS).slice(-MAX_HEADS_PER_BRANCH);
          if (kept.length) branches[branch] = kept;
          else delete branches[branch];
        }
        if (Object.keys(branches).length === 0) delete store[r];
      }
      const tmp = `${provenanceFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, repos: store }));
      renameSync(tmp, provenanceFile());
    });
  } catch {
    /* provenance is an optimisation of the preflight, never a reason to fail */
  }
}
