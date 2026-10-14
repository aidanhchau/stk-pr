/**
 * `:fix`: hand a review thread or a failing check to an omp agent in a new Tern tab, started in the PR's
 * worktree (created through `openWorktree` when missing) with the context prefilled as its first prompt.
 *
 * Mechanism: `tern new tab --cwd <worktree> -- omp @<prompt file> Proceed`. The prompt goes through a file
 * (`~/.cache/stk/agentfix/…md`, omp's `@file` message syntax) so no quoting survives between stk, tern and
 * omp; the one-word message after it makes omp start the turn. `tern new tab` works from any process inside a
 * Tern pane (it finds the window through the pane's environment); outside Tern it fails and the error is shown.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ReviewThread } from "./github";
import { openWorktree, type Ctx } from "./service";
import type { Check, Exec } from "./types";

export interface FixPr {
  number: number;
  title: string;
  url: string;
  headRef: string;
  baseRef: string;
}

export type FixTarget = { kind: "thread"; thread: ReviewThread } | { kind: "check"; check: Check; log: string | null };

/** Longest log tail put in a prompt. */
export const LOG_TAIL_CHARS = 6000;

/** The last `max` characters of `text`, cut at a line start, with a marker when anything was dropped. */
export function logTail(text: string, max = LOG_TAIL_CHARS): string {
  const t = text.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trimEnd();
  if (t.length <= max) return t;
  const cut = t.slice(t.length - max);
  const nl = cut.indexOf("\n");
  return `[… earlier log truncated]\n${nl >= 0 ? cut.slice(nl + 1) : cut}`;
}

/** A fence longer than any backtick run inside `text`. */
function fence(text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  return "`".repeat(longest + 1);
}

const block = (text: string, lang = ""): string => {
  const f = fence(text);
  return `${f}${lang}\n${text}\n${f}`;
};

/** `path:line` (or `path:start-line` for a range); "(no file)" for a thread without one. */
export function threadLocation(t: ReviewThread): string {
  if (!t.path) return "(no file)";
  if (t.line === null) return t.path;
  return t.startLine !== null && t.startLine !== t.line ? `${t.path}:${t.startLine}-${t.line}` : `${t.path}:${t.line}`;
}

function prHeader(pr: FixPr): string {
  return [`PR #${pr.number}: ${pr.title}`, `URL: ${pr.url}`, `Branch: ${pr.headRef} (base ${pr.baseRef})`].join("\n");
}

/** The first prompt of the agent that fixes a review thread. Pure. */
export function threadPrompt(pr: FixPr, t: ReviewThread): string {
  const comments = t.comments.map((c) => `${c.author}${c.isBot ? " (bot)" : ""}:\n${c.body.trim()}`).join("\n\n---\n\n");
  const parts = [prHeader(pr), "", `Review thread: ${threadLocation(t)}${t.isOutdated ? " (outdated: the code has changed since)" : ""}`, `Thread id: ${t.id}`, "", "Comments:", "", comments];
  if (t.diffHunk) parts.push("", "Diff hunk:", "", block(t.diffHunk, "diff"));
  parts.push("", "Fix this review comment, push, and reply on the thread.");
  return parts.join("\n");
}

/** The first prompt of the agent that fixes a failing check. Pure. */
export function checkPrompt(pr: FixPr, c: Check, log: string | null): string {
  const parts = [prHeader(pr), "", `Failing check: ${c.name}`];
  if (c.url) parts.push(`Check URL: ${c.url}`);
  parts.push("", log ? "Failed log (tail):" : "No log could be fetched; open the check URL or run `gh run view --log-failed`.");
  if (log) parts.push("", block(logTail(log)));
  parts.push("", "Fix this failing check, push, and confirm it passes.");
  return parts.join("\n");
}

export const fixPrompt = (pr: FixPr, target: FixTarget): string => (target.kind === "thread" ? threadPrompt(pr, target.thread) : checkPrompt(pr, target.check, target.log));

/** The Actions run (and job) a check URL points at, or null for external checks. */
export function parseRunUrl(url: string | null): { owner: string; name: string; run: string; job: string | null } | null {
  const m = url ? /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/actions\/runs\/(\d+)(?:\/job\/(\d+))?/.exec(url) : null;
  return m ? { owner: m[1]!, name: m[2]!, run: m[3]!, job: m[4] ?? null } : null;
}

/** `gh run view --log-failed` of the check's run (its job when the URL names one); null when it has no Actions run or gh fails. */
export async function failedLog(exec: Exec, c: Check, cwd?: string): Promise<string | null> {
  const r = parseRunUrl(c.url);
  if (!r) return null;
  const args = ["gh", "run", "view", r.run, "-R", `${r.owner}/${r.name}`, ...(r.job ? ["--job", r.job] : []), "--log-failed"];
  const out = await exec(args, cwd ? { cwd } : {});
  return out.code === 0 && out.stdout.trim() ? out.stdout : null;
}

/** argv that opens the prompt file in omp in a new Tern tab at `cwd`. */
export function ternTabArgv(cwd: string, promptFile: string): string[] {
  return ["tern", "new", "tab", "--cwd", cwd, "--", "omp", `@${promptFile}`, "Proceed"];
}

/** Where a prompt is written; the name is made of shell-safe characters only. */
export function promptPath(pr: FixPr, now = Date.now(), home = homedir()): string {
  return join(home, ".cache", "stk", "agentfix", `pr${pr.number}-${now}.md`);
}

export interface FixStarted {
  worktree: string;
  promptFile: string;
}

/**
 * Open (creating if missing) the PR's worktree, build the prompt (fetching the failed log for a check) and open an omp
 * tab there. Throws `Error` with tern's message when the tab can't be opened (e.g. outside Tern).
 */
export async function startFix(ctx: Ctx, pr: FixPr, target: FixTarget): Promise<FixStarted> {
  const wt = await openWorktree(ctx, pr.number, { create: true });
  if (!wt.worktree) throw new Error(`no worktree for ${pr.headRef}`);
  const resolved = target.kind === "check" ? { ...target, log: await failedLog(ctx.exec, target.check, wt.worktree) } : target;
  const promptFile = promptPath(pr);
  mkdirSync(join(promptFile, ".."), { recursive: true });
  writeFileSync(promptFile, fixPrompt(pr, resolved));
  const r = await ctx.exec(ternTabArgv(wt.worktree, promptFile));
  if (r.code !== 0) throw new Error(`tern new tab failed: ${r.stderr.trim() || r.stdout.trim() || `exit ${r.code}`}`);
  return { worktree: wt.worktree, promptFile };
}
