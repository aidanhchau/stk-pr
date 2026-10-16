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
type Store = Map<string, Map<string, Head[]>>;

export const stateDir = (): string => process.env.STK_STATE_DIR || join(homedir(), ".cache", "stk");
export const provenanceFile = () => join(stateDir(), "restack-provenance.json");

/** One repo in the store: the GitHub slug plus the checkout, so two clones of a repo do not vouch for each other. */
export const provenanceKey = (slug: { owner: string; name: string } | undefined, root: string): string => `${slug ? `${slug.owner}/${slug.name}` : "-"}@${root}`;

const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);

/** Everything well-formed in the file; anything else (missing, truncated, wrong shape) is dropped. Maps, so names like `constructor` or `__proto__` are plain keys. */
function readStore(): Store {
  const out: Store = new Map();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(provenanceFile(), "utf8"));
  } catch {
    return out;
  }
  const repos = (raw as { repos?: unknown } | null)?.repos;
  if (!repos || typeof repos !== "object") return out;
  for (const [repo, branches] of Object.entries(repos as Record<string, unknown>)) {
    if (!branches || typeof branches !== "object") continue;
    for (const [branch, heads] of Object.entries(branches as Record<string, unknown>)) {
      if (!Array.isArray(heads)) continue;
      const good = heads.filter((h): h is Head => !!h && isSha((h as Head).sha) && Number.isFinite((h as Head).at));
      if (good.length === 0) continue;
      const mine = out.get(repo) ?? new Map<string, Head[]>();
      out.set(repo, mine);
      mine.set(branch, good.map((h) => ({ sha: h.sha, at: h.at })));
    }
  }
  return out;
}

/** The heads recorded for each branch of `repo`; empty when there is nothing usable. */
export function loadProvenance(repo: string): Map<string, string[]> {
  return new Map([...(readStore().get(repo) ?? [])].map(([branch, heads]) => [branch, heads.map((h) => h.sha)]));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const STALE_LOCK_MS = 60_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A lock is only broken when it is old and its owner is gone; an unreadable owner counts as alive. */
function breakStaleLock(lock: string): void {
  try {
    if (Date.now() - statSync(lock).mtimeMs <= STALE_LOCK_MS) return;
    const pid = Number(readFileSync(join(lock, "pid"), "utf8"));
    if (Number.isInteger(pid) && pid > 0 && !pidAlive(pid)) rmSync(lock, { recursive: true, force: true });
  } catch {
    /* released meanwhile, or owner unknown: leave it */
  }
}

/**
 * Cross-process mutex (mkdir is atomic). Runs `fn` only while holding the lock; if it cannot be taken within about two
 * seconds, `fn` is skipped and false is returned, so there is never an unlocked read-merge-write.
 */
function withLock(fn: () => void): boolean {
  const lock = `${provenanceFile()}.lock`;
  for (let i = 0; i < 100; i++) {
    try {
      mkdirSync(lock);
    } catch {
      breakStaleLock(lock);
      sleepSync(20);
      continue;
    }
    try {
      writeFileSync(join(lock, "pid"), String(process.pid));
      fn();
      return true;
    } finally {
      rmSync(lock, { recursive: true, force: true });
    }
  }
  return false;
}

/**
 * Remember that `heads` (a branch and a head it had on origin before being replaced) were published. Read-merge-write under a
 * lock, written to a temp file and renamed, so concurrent stk processes never see or leave half a file. Best effort: if the
 * lock cannot be taken or the write fails, nothing is recorded, and that must not fail a restack that already pushed.
 */
export function recordProvenance(repo: string, heads: { branch: string; sha: string }[], now = Date.now()): void {
  if (heads.length === 0) return;
  try {
    mkdirSync(stateDir(), { recursive: true });
    withLock(() => {
      const store = readStore();
      for (const { branch, sha } of heads) {
        const branches = store.get(repo) ?? new Map<string, Head[]>();
        store.set(repo, branches);
        branches.set(branch, [...(branches.get(branch) ?? []).filter((h) => h.sha !== sha), { sha, at: now }]);
      }
      const out: Record<string, Record<string, Head[]>> = Object.create(null);
      for (const [r, branches] of store) {
        const kept: Record<string, Head[]> = Object.create(null);
        for (const [branch, list] of branches) {
          const fresh = list.filter((h) => now - h.at <= KEEP_MS).slice(-MAX_HEADS_PER_BRANCH);
          if (fresh.length) kept[branch] = fresh;
        }
        if (Object.keys(kept).length) out[r] = kept;
      }
      const tmp = `${provenanceFile()}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, repos: out }));
      renameSync(tmp, provenanceFile());
    });
  } catch {
    /* provenance is an optimisation of the preflight, never a reason to fail */
  }
}
