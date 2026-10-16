/** `stk --version` and `stk doctor`: one line per environment check, each with a fix hint. */
import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pkg from "../package.json";
import { clockTime, repoSlug } from "./github";
import { jobsDir } from "./jobs";
import { discoverWorkspace, emptyWorkspaceMessage, homeLabel } from "./repos";
import { openCtx } from "./service";
import type { Exec } from "./types";

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  id: string;
  status: CheckStatus;
  /** What was found, one line. */
  message: string;
  /** What to do about a warning or failure. */
  fix?: string;
}

export interface DoctorOpts {
  exec: Exec;
  /** Directory the repo/workspace detection starts from. */
  cwd: string;
  env?: Record<string, string | undefined>;
  /** Directory of omp session transcripts; default `~/.omp/agent/sessions`. */
  sessionsDir?: string;
  /** Directories that must be writable; default the jobs dir and `~/.cache/stk`. */
  cacheDirs?: string[];
  now?: () => number;
}

const MARK: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };

// ---------- version ----------

const SRC_ROOT = join(import.meta.dir, "..");

/** `0.1.0`, plus ` (abc1234)` when run from a git clone. */
export async function versionText(exec: Exec, root: string = SRC_ROOT, version: string = pkg.version): Promise<string> {
  try {
    statSync(join(root, ".git"));
  } catch {
    return version;
  }
  const r = await exec(["git", "rev-parse", "--short", "HEAD"], { cwd: root });
  const sha = r.code === 0 ? r.stdout.trim() : "";
  return sha ? `${version} (${sha})` : version;
}

// ---------- checks ----------

const firstLine = (s: string) => s.split("\n").find((l) => l.trim())?.trim() ?? "";
const check = (id: string, status: CheckStatus, message: string, fix?: string): DoctorCheck => ({ id, status, message, ...(fix ? { fix } : {}) });

async function checkGh(exec: Exec): Promise<DoctorCheck> {
  const r = await exec(["gh", "--version"]);
  const v = r.code === 0 ? /gh version (\S+)/.exec(r.stdout)?.[1] : undefined;
  if (!v) return check("gh", "fail", "gh is not installed", "install the GitHub CLI: brew install gh");
  return check("gh", "ok", `gh ${v}`);
}

async function checkAuth(exec: Exec): Promise<DoctorCheck> {
  const r = await exec(["gh", "auth", "status"]);
  const text = `${r.stdout}\n${r.stderr}`;
  const user = /Logged in to \S+ (?:account|as) (\S+)/.exec(text)?.[1];
  if (r.code !== 0 || !user) return check("gh-auth", "fail", "gh is not logged in", "run: gh auth login");
  const scopesLine = /Token scopes:\s*(.+)/.exec(text)?.[1];
  if (!scopesLine) {
    return check("gh-auth", "warn", `logged in as ${user}; token scopes not reported (fine-grained token?)`, "make sure the token can read and write pull requests, or run: gh auth login");
  }
  const scopes = [...scopesLine.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  if (!scopes.includes("repo")) {
    return check("gh-auth", "fail", `logged in as ${user}; token lacks the repo scope (has ${scopes.join(", ") || "none"})`, "run: gh auth refresh -s repo");
  }
  return check("gh-auth", "ok", `logged in as ${user} (scopes: ${scopes.join(", ")})`);
}

async function checkTern(exec: Exec, env: Record<string, string | undefined>): Promise<DoctorCheck> {
  const r = await exec(["tern", "--version"]);
  const v = r.code === 0 ? firstLine(r.stdout) : "";
  const pane = env.TERN_PANE;
  if (!v) return check("tern", "warn", `tern is not on PATH${pane ? ` (but $TERN_PANE=${pane})` : ""}; the Session board and pane integration need Tern`, "install Tern, or ignore this outside Tern");
  if (!pane) return check("tern", "warn", `${v}; $TERN_PANE is not set (not running inside a Tern pane)`, "run stk from a Tern pane to get the Session board");
  return check("tern", "ok", `${v}, pane ${pane}`);
}

function checkTranscripts(dir: string): DoctorCheck {
  try {
    if (statSync(dir).isDirectory()) return check("omp-transcripts", "ok", `omp transcripts at ${homeLabel(dir)}`);
  } catch {}
  return check("omp-transcripts", "warn", `omp transcripts directory not found (${homeLabel(dir)}); the Session board needs it`, "start an omp session once, or ignore this if you don't use omp");
}

interface RateReading {
  limit: number;
  remaining: number;
  /** Epoch ms. */
  reset: number;
}

/** GraphQL: a 1-point `{rateLimit}` probe read from its `X-RateLimit-*` headers (works while exhausted). */
async function graphqlRate(exec: Exec): Promise<RateReading | null> {
  const r = await exec(["gh", "api", "-i", "graphql", "-f", "query={rateLimit{resetAt}}"]);
  const num = (name: string) => {
    const m = new RegExp(`^x-ratelimit-${name}:\\s*(\\d+)`, "im").exec(r.stdout);
    return m ? Number(m[1]) : null;
  };
  const limit = num("limit");
  const remaining = num("remaining");
  const reset = num("reset");
  return limit === null || remaining === null || reset === null ? null : { limit, remaining, reset: reset * 1000 };
}

/** REST core: `gh api rate_limit` (free). */
async function restRate(exec: Exec): Promise<RateReading | null> {
  const r = await exec(["gh", "api", "rate_limit"]);
  if (r.code !== 0) return null;
  try {
    const body: { resources?: { core?: { limit: number; remaining: number; reset: number } } } = JSON.parse(r.stdout);
    const core = body.resources?.core;
    return core ? { limit: core.limit, remaining: core.remaining, reset: core.reset * 1000 } : null;
  } catch {
    return null;
  }
}

function rateCheck(id: string, label: string, r: RateReading | null, now: number): DoctorCheck {
  if (!r) return check(id, "warn", `${label} rate limit could not be read`, "check gh auth and network: gh api rate_limit");
  const msg = `${label} rate limit ${r.remaining}/${r.limit} left, resets ${clockTime(r.reset)}`;
  if (r.remaining === 0 && r.reset > now) return check(id, "fail", `${label} rate limit exhausted, resets ${clockTime(r.reset)}`, "wait for the reset; stk pauses polling until then");
  if (r.remaining < r.limit * 0.1) return check(id, "warn", msg, "close extra stk/gh sessions or wait for the reset");
  return check(id, "ok", msg);
}

function checkCache(dirs: string[]): DoctorCheck {
  const bad: string[] = [];
  for (const d of dirs) {
    try {
      mkdirSync(d, { recursive: true });
      const probe = join(d, `.doctor-${process.pid}`);
      writeFileSync(probe, "");
      unlinkSync(probe);
    } catch (e) {
      bad.push(`${homeLabel(d)} (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  if (bad.length) return check("cache", "fail", `not writable: ${bad.join("; ")}`, "fix permissions, or point STK_JOBS_DIR at a writable directory");
  return check("cache", "ok", `cache and jobs dirs writable (${dirs.map(homeLabel).join(", ")})`);
}

/** Terminals known to implement the kitty keyboard protocol (⌘⏎ and friends reach stk as real chords there). */
function checkKeyboard(env: Record<string, string | undefined>): DoctorCheck {
  const prog = env.TERM_PROGRAM ?? "";
  const term = env.TERM ?? "";
  const known =
    env.TERN_PANE ? "Tern"
    : env.KITTY_WINDOW_ID || term === "xterm-kitty" ? "kitty"
    : /^(ghostty|WezTerm|iTerm\.app)$/.test(prog) ? prog
    : /^(foot|alacritty|xterm-ghostty)/.test(term) ? term
    : null;
  if (known) return check("keyboard", "ok", `${known}: kitty keyboard protocol expected`);
  if (prog === "Apple_Terminal") return check("keyboard", "warn", "Terminal.app has no kitty keyboard protocol; ⌘⏎ is unavailable (ctrl/meta+⏎ still confirm)", "use Tern, kitty, Ghostty, WezTerm or iTerm2");
  return check("keyboard", "warn", `cannot tell whether ${prog || term || "this terminal"} supports the kitty keyboard protocol; ⌘⏎ may arrive as ctrl/meta+⏎`, "use a terminal with kitty keyboard support (Tern, kitty, Ghostty, WezTerm, iTerm2)");
}

async function checkWorkspace(exec: Exec, dir: string): Promise<DoctorCheck> {
  try {
    const ctx = await openCtx(exec, dir);
    try {
      const slug = ctx.slug ?? (await repoSlug(exec, ctx.root!));
      return check("repo", "ok", `repo ${slug.owner}/${slug.name} at ${homeLabel(ctx.root!)}`);
    } catch (e) {
      return check("repo", "warn", `git repo at ${homeLabel(ctx.root!)} but its GitHub repo could not be resolved: ${firstLine(e instanceof Error ? e.message : String(e))}`, "check gh auth and that the repo has a GitHub remote");
    }
  } catch {
    const scan = await discoverWorkspace(dir).catch(() => null);
    if (scan && scan.repos.length > 0) {
      return check("repo", "ok", `workspace of ${scan.repos.length} repo${scan.repos.length === 1 ? "" : "s"} under ${homeLabel(scan.root)}`);
    }
    return check("repo", "warn", scan ? firstLine(emptyWorkspaceMessage(scan)) : `not a git repository: ${homeLabel(dir)}`, "run stk inside a clone, or pass --repo DIR or --gh owner/name");
  }
}

/** Run every check (concurrently); results are in a stable display order. */
export async function runDoctor(o: DoctorOpts): Promise<DoctorCheck[]> {
  const env = o.env ?? process.env;
  const home = env.HOME ?? homedir();
  const now = (o.now ?? Date.now)();
  const cacheDirs = o.cacheDirs ?? [...new Set([jobsDir(), join(home, ".cache", "stk")])];
  return Promise.all([
    checkGh(o.exec),
    checkAuth(o.exec),
    checkTern(o.exec, env),
    checkTranscripts(o.sessionsDir ?? join(home, ".omp/agent/sessions")),
    graphqlRate(o.exec).then((r) => rateCheck("rate-graphql", "GraphQL", r, now)),
    restRate(o.exec).then((r) => rateCheck("rate-rest", "REST", r, now)),
    checkCache(cacheDirs),
    checkKeyboard(env),
    checkWorkspace(o.exec, o.cwd),
  ]);
}

export function doctorText(checks: DoctorCheck[]): string {
  return checks.map((c) => `${MARK[c.status]} ${c.message}${c.fix && c.status !== "ok" ? `\n    → ${c.fix}` : ""}`).join("\n");
}

export const doctorOk = (checks: DoctorCheck[]): boolean => checks.every((c) => c.status !== "fail");
