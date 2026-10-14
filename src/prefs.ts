/**
 * User preferences: `$XDG_CONFIG_HOME/stk/prefs.json` (default `~/.config/stk/prefs.json`; `STK_PREFS_FILE`
 * overrides the whole path). Per repo (`owner/name`, lowercased): the last board tab and the merge method.
 * Global: notification mode and reduced motion. A missing, unreadable or corrupt file yields the defaults and
 * is never an error; unknown or invalid fields are dropped on load.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { MergeMethod } from "./types";

export type NotifyMode = "toast" | "system" | "off";
export type PrefScope = "mine" | "review" | "all" | "session";

export interface RepoPrefs {
  scope?: PrefScope;
  mergeMethod?: MergeMethod;
}

export interface Prefs {
  /** Unset = automatic: see `notifyMode`. */
  notify?: NotifyMode;
  reducedMotion?: boolean;
  repos: Record<string, RepoPrefs>;
}

export const DEFAULT_PREFS: Prefs = Object.freeze({ repos: Object.freeze({}) as Record<string, RepoPrefs> });

const NOTIFY_MODES: readonly string[] = ["toast", "system", "off"];
const SCOPES: readonly string[] = ["mine", "review", "all", "session"];
const METHODS: readonly string[] = ["squash", "merge", "rebase"];

export function prefsPath(env: Record<string, string | undefined> = process.env): string {
  if (env.STK_PREFS_FILE) return env.STK_PREFS_FILE;
  const base = env.XDG_CONFIG_HOME || join(env.HOME || homedir(), ".config");
  return join(base, "stk", "prefs.json");
}

export const repoPrefsKey = (r: { owner: string; name: string }): string => `${r.owner}/${r.name}`.toLowerCase();

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Validate parsed JSON into Prefs, keeping only well-formed fields. */
export function normalizePrefs(raw: unknown): Prefs {
  const out: Prefs = { repos: {} };
  if (!isRecord(raw)) return out;
  if (typeof raw.notify === "string" && NOTIFY_MODES.includes(raw.notify)) out.notify = raw.notify as NotifyMode;
  if (typeof raw.reducedMotion === "boolean") out.reducedMotion = raw.reducedMotion;
  if (isRecord(raw.repos)) {
    for (const [key, v] of Object.entries(raw.repos)) {
      if (!isRecord(v)) continue;
      const rp: RepoPrefs = {};
      if (typeof v.scope === "string" && SCOPES.includes(v.scope)) rp.scope = v.scope as PrefScope;
      if (typeof v.mergeMethod === "string" && METHODS.includes(v.mergeMethod)) rp.mergeMethod = v.mergeMethod as MergeMethod;
      if (rp.scope || rp.mergeMethod) out.repos[key.toLowerCase()] = rp;
    }
  }
  return out;
}

/** Read the prefs file; defaults when it is missing or corrupt. */
export function loadPrefs(file: string = prefsPath()): Prefs {
  try {
    return normalizePrefs(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { repos: {} };
  }
}

/** Atomic write (temp file + rename). Throws on I/O failure; callers that persist opportunistically catch. */
export function savePrefs(prefs: Prefs, file: string = prefsPath()): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(prefs, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

export function repoPrefs(prefs: Prefs, repo: { owner: string; name: string } | null | undefined): RepoPrefs {
  return (repo && prefs.repos[repoPrefsKey(repo)]) || {};
}

/** A copy of `prefs` with `patch` merged into one repo's entry. */
export function withRepoPrefs(prefs: Prefs, repo: { owner: string; name: string }, patch: RepoPrefs): Prefs {
  const key = repoPrefsKey(repo);
  return { ...prefs, repos: { ...prefs.repos, [key]: { ...prefs.repos[key], ...patch } } };
}

/** Effective notification mode: the saved one, else system while the Tern window is unfocused and toast otherwise. */
export function notifyMode(prefs: Pick<Prefs, "notify">, ctx: { focused: boolean }): NotifyMode {
  return prefs.notify ?? (ctx.focused ? "toast" : "system");
}
