// Maps a GitHub owner/name to a local checkout, so a PR link can open with worktrees.
import { mkdir, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Exec } from "./types";

export interface ResolveOpts {
  /** Search roots; default $STK_ROOTS (colon list) else the standard layout. */
  roots?: string[];
  /** Cache file; default ~/.cache/stk/repos.json. */
  cacheFile?: string;
  /** Directory depth below each root that is searched for repos. */
  depth?: number;
}

/** Parse a git remote URL into owner/name (github.com only is not enforced; GHES hosts work). */
export function parseRemote(url: string): { owner: string; name: string } | null {
  const m =
    /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?[^/:]+[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

export function defaultRoots(env: Record<string, string | undefined> = process.env): string[] {
  if (env.STK_ROOTS) return env.STK_ROOTS.split(":").filter(Boolean);
  const home = env.HOME ?? homedir();
  return ["projects", "src", "code", "dev"].map((d) => join(home, d));
}


/** True when `dir`'s origin remote is owner/name. */
async function hasOrigin(exec: Exec, dir: string, owner: string, name: string): Promise<boolean> {
  const r = await exec(["git", "remote", "get-url", "origin"], { cwd: dir });
  if (r.code !== 0) return false;
  const s = parseRemote(r.stdout);
  return !!s && s.owner.toLowerCase() === owner.toLowerCase() && s.name.toLowerCase() === name.toLowerCase();
}

async function readCache(file: string): Promise<Record<string, string>> {
  try {
    const j = JSON.parse(await Bun.file(file).text()) as unknown;
    return j && typeof j === "object" ? (j as Record<string, string>) : {};
  } catch {
    return {};
  }
}

async function writeCache(file: string, cache: Record<string, string>): Promise<void> {
  try {
    await mkdir(dirname(file), { recursive: true });
    await Bun.write(file, JSON.stringify(cache, null, 1));
  } catch {
    // the cache is an optimisation only
  }
}

/** Repo candidates under roots: dir -> whether `.git` is a directory (main clone) or a file (worktree). */
async function candidates(roots: string[], depth: number): Promise<{ main: string[]; linked: string[] }> {
  const main = new Set<string>();
  const linked = new Set<string>();
  const seen = new Set<string>();
  const walk = async (dir: string, d: number): Promise<void> => {
    if (seen.has(dir)) return;
    seen.add(dir);
    const g = await stat(join(dir, ".git")).catch(() => null);
    if (g) {
      (g.isDirectory() ? main : linked).add(dir);
      return;
    }
    if (d >= depth) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && e.name !== "node_modules")
        .map((e) => walk(join(dir, e.name), d + 1)),
    );
  };
  await Promise.all(roots.map((r) => walk(r, 0)));
  return { main: [...main].sort(), linked: [...linked].sort() };
}

async function firstMatch(exec: Exec, dirs: string[], owner: string, name: string): Promise<string | null> {
  const BATCH = 12;
  for (let i = 0; i < dirs.length; i += BATCH) {
    const batch = dirs.slice(i, i + BATCH);
    const ok = await Promise.all(batch.map((d) => hasOrigin(exec, d, owner, name)));
    const hit = batch.find((_, j) => ok[j]);
    if (hit) return hit;
  }
  return null;
}

/** Local repo dir whose `origin` is owner/name (main clone preferred over worktrees), or null. */
export async function resolveRepo(
  exec: Exec,
  owner: string,
  name: string,
  opts: ResolveOpts = {},
): Promise<string | null> {
  const file = opts.cacheFile ?? join(process.env.HOME ?? homedir(), ".cache/stk/repos.json");
  const key = `${owner}/${name}`.toLowerCase();
  const cache = await readCache(file);
  const cached = cache[key];
  if (cached && (await hasOrigin(exec, cached, owner, name))) return cached;

  const { main, linked } = await candidates(opts.roots ?? defaultRoots(), opts.depth ?? 2);
  const found = (await firstMatch(exec, main, owner, name)) ?? (await firstMatch(exec, linked, owner, name));
  if (found) {
    cache[key] = found;
    await writeCache(file, cache);
  } else if (cached) {
    delete cache[key];
    await writeCache(file, cache);
  }
  return found;
}

// ---------- workspace discovery ----------

/** A GitHub repo found under a workspace directory. */
export interface WorkspaceRepo {
  slug: { owner: string; name: string };
  /** Checkout to run git in: the main clone when the scan met it, else the first worktree. */
  dir: string;
  /** Linked worktrees the scan met (excluding `dir`). */
  worktrees: string[];
}

export interface WorkspaceScan {
  /** Absolute directory that was scanned. */
  root: string;
  /** Repos by GitHub slug, sorted by `owner/name` (case-insensitive). */
  repos: WorkspaceRepo[];
  /** Directories read. */
  scanned: number;
  /** Git checkouts met that have no GitHub remote. */
  noRemote: string[];
  depth: number;
}

const WORKSPACE_DEPTH = 3;
const SKIP_DIRS = new Set(["node_modules", "archive"]);

/** `url = <url>` of the `origin` remote (else the first remote) in git config text. */
function configRemote(text: string): string | null {
  let section: string | null = null;
  let first: string | null = null;
  let origin: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const head = /^\[remote\s+"([^"]+)"\]$/.exec(line);
    if (head) section = head[1]!;
    else if (line.startsWith("[")) section = null;
    else if (section !== null) {
      const m = /^url\s*=\s*(.+)$/.exec(line);
      if (!m) continue;
      first ??= m[1]!.trim();
      if (section === "origin") origin ??= m[1]!.trim();
    }
  }
  return origin ?? first;
}

/** True for github.com, `$GH_HOST` and hosts that name GitHub (GHES, ghe.com). */
function isGithubUrl(url: string): boolean {
  const host = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]/i.exec(url.trim())?.[1]?.toLowerCase();
  return !!host && (host === "github.com" || host === process.env.GH_HOST?.toLowerCase() || host.includes("github"));
}

const readText = (file: string): Promise<string | null> => Bun.file(file).text().catch(() => null);

interface Checkout {
  /** Repo identity: the common git dir (shared by a clone and its linked worktrees). */
  common: string;
  linked: boolean;
  slug: { owner: string; name: string } | null;
}

/** Read a checkout's remote straight from `.git` (no git process). `isDir`: whether `.git` is a directory. */
async function readCheckout(dir: string, isDir: boolean): Promise<Checkout | null> {
  let gitDir = join(dir, ".git");
  let common = gitDir;
  let linked = false;
  if (!isDir) {
    const pointer = await readText(gitDir);
    const m = pointer ? /^gitdir:\s*(.+)$/m.exec(pointer) : null;
    if (!m) return null;
    gitDir = resolve(dir, m[1]!.trim());
    const cd = await readText(join(gitDir, "commondir"));
    common = cd ? resolve(gitDir, cd.trim()) : gitDir;
    linked = !!cd;
  }
  const url = configRemote((await readText(join(common, "config"))) ?? "");
  const parsed = url && isGithubUrl(url) ? parseRemote(url) : null;
  return { common, linked, slug: parsed };
}

/**
 * Find the GitHub repos under `dir` (default depth 3): every checkout with a GitHub remote, linked worktrees folded
 * into their repo. A checkout with a GitHub remote is not descended into; one without (e.g. a monorepo root with
 * repos below it) is. Skips dot-dirs, node_modules and archive/. Reads `.git/config` directly: no git processes.
 */
export async function discoverWorkspace(dir: string, opts: { depth?: number } = {}): Promise<WorkspaceScan> {
  const root = resolve(dir);
  const depth = opts.depth ?? WORKSPACE_DEPTH;
  const found = new Map<string, { slug: { owner: string; name: string }; mains: Set<string>; linked: Set<string> }>();
  const noRemote: string[] = [];
  let scanned = 0;

  const walk = async (d: string, level: number): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => null);
    if (!entries) return;
    scanned++;
    const git = entries.find((e) => e.name === ".git");
    if (git && (git.isDirectory() || git.isFile())) {
      const c = await readCheckout(d, git.isDirectory());
      if (c?.slug) {
        const key = `${c.slug.owner}/${c.slug.name}`.toLowerCase();
        const f = found.get(key) ?? { slug: c.slug, mains: new Set<string>(), linked: new Set<string>() };
        (c.linked ? f.linked : f.mains).add(d);
        found.set(key, f);
        return;
      }
      noRemote.push(d);
    }
    if (level >= depth) return;
    await Promise.all(
      entries
        .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !SKIP_DIRS.has(e.name))
        .map((e) => walk(join(d, e.name), level + 1)),
    );
  };
  await walk(root, 0);

  const repos = [...found.values()]
    .map((f): WorkspaceRepo => {
      const [dirOf, ...rest] = [...[...f.mains].sort(), ...[...f.linked].sort()];
      return { slug: f.slug, dir: dirOf!, worktrees: rest };
    })
    .sort((a, b) => `${a.slug.owner}/${a.slug.name}`.toLowerCase().localeCompare(`${b.slug.owner}/${b.slug.name}`.toLowerCase()));
  return { root, repos, scanned, noRemote: noRemote.sort(), depth };
}

/** Message for a scan that found nothing: what was searched and how to point stk at a repo. */
export function emptyWorkspaceMessage(scan: WorkspaceScan): string {
  const lines = [`No GitHub repositories found under ${scan.root} (searched ${scan.scanned} director${scan.scanned === 1 ? "y" : "ies"}, up to ${scan.depth} levels deep; skipped dot-dirs, node_modules, archive).`];
  if (scan.noRemote.length) {
    const shown = scan.noRemote.slice(0, 5).map((p) => `  ${p}`);
    lines.push(`Git checkouts without a GitHub remote (${scan.noRemote.length}):`, ...shown, ...(scan.noRemote.length > 5 ? [`  … ${scan.noRemote.length - 5} more`] : []));
  }
  lines.push("Run stk inside a clone, or pass --repo DIR (a checkout or a folder of checkouts) or --gh owner/name.");
  return lines.join("\n");
}

/** `~/projects/acme`-style display of a path under $HOME. */
export function homeLabel(path: string): string {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}
