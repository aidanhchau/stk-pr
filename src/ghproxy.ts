/** `:gh <args>`: run `gh` from the palette with the current repo / PR filled in. Pure planning here; execution in service.ts. */

export interface GhContext {
  repo: { owner: string; name: string } | null;
  /** PR number for `{n}` (current PR page or selected board row). */
  n: number | null;
}

export interface GhPlan {
  /** Full argv including the leading `gh`. */
  argv: string[];
  /** Shell-quoted command line for previews and confirm sheets. */
  display: string;
  /** Changes something on GitHub (or unknown): needs confirmation. */
  mutating: boolean;
}

export type GhPlanResult = { ok: true; plan: GhPlan } | { ok: false; error: string };

/** Split a command line the way a shell would for quotes and backslashes (no expansion). */
export function tokenize(line: string): string[] | null {
  const out: string[] = [];
  let cur = "";
  let has = false;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length && /["\\$`]/.test(line[i + 1]!)) cur += line[++i];
      else cur += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      has = true;
    } else if (c === "\\" && i + 1 < line.length) {
      cur += line[++i];
      has = true;
    } else if (/\s/.test(c)) {
      if (has || cur) out.push(cur);
      cur = "";
      has = false;
    } else {
      cur += c;
      has = true;
    }
  }
  if (quote) return null;
  if (has || cur) out.push(cur);
  return out;
}

const quoteArg = (a: string): string => (/^[\w@%+=:,./{}-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

/** Command groups whose subcommands take `-R owner/name`. */
const REPO_FLAG = new Set(["pr", "issue", "run", "workflow", "release", "label", "cache", "secret", "variable", "ruleset", "project"]);

/** Read-only subcommands per group (`*`: every subcommand). Everything else asks first. */
const READ_ONLY: Record<string, readonly string[] | "*"> = {
  pr: ["view", "list", "diff", "checks", "status"],
  issue: ["view", "list", "status"],
  run: ["view", "list", "watch"],
  workflow: ["view", "list"],
  release: ["view", "list"],
  label: ["list"],
  repo: ["view", "list"],
  cache: ["list"],
  secret: ["list"],
  variable: ["list", "get"],
  ruleset: ["list", "view", "check"],
  search: "*",
  status: "*",
  browse: "*",
  version: "*",
  help: "*",
  alias: ["list"],
  config: ["get", "list"],
  auth: ["status"],
  extension: ["list", "search"],
  "ssh-key": ["list"],
  "gpg-key": ["list"],
};

const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field", "--input"]);

/** `gh api`: read-only only for an explicit GET, or no method and no body fields. */
function apiMutates(args: string[]): boolean {
  let method: string | null = null;
  let fields = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-X" || a === "--method") method = (args[++i] ?? "").toUpperCase();
    else if (a.startsWith("--method=")) method = a.slice(9).toUpperCase();
    else if (a.startsWith("-X") && a.length > 2) method = a.slice(2).toUpperCase();
    else if (FIELD_FLAGS.has(a)) fields = true;
    else if (/^(--field|--raw-field|--input)=/.test(a) || (/^-[fF]./.test(a) && !a.startsWith("--"))) fields = true;
  }
  if (method) return method !== "GET" && method !== "HEAD";
  return fields;
}

/** True when running `args` (after `gh`) could change anything, or is not known to be read-only. */
export function isMutating(args: string[]): boolean {
  const [group, ...rest] = args.filter((a, i) => i > 0 || !a.startsWith("-"));
  if (!group) return false;
  if (group === "api") return apiMutates(args.slice(args.indexOf("api") + 1));
  const known = READ_ONLY[group];
  if (known === "*") return false;
  if (!known) return true;
  const sub = rest.find((a) => !a.startsWith("-"));
  return !(sub && known.includes(sub));
}

const hasRepoFlag = (args: string[]) => args.some((a) => a === "-R" || a === "--repo" || a.startsWith("--repo=") || (a.startsWith("-R") && a.length > 2));

/**
 * Turn the text after `:gh ` into a runnable plan: `{n}` → PR number; `-R owner/name` appended for subcommands
 * that take it (unless given); `gh api` placeholders `{owner}` / `{repo}` expanded; `gh repo view` gets the slug.
 */
export function planGh(line: string, ctx: GhContext): GhPlanResult {
  const toks = tokenize(line);
  if (!toks) return { ok: false, error: "unterminated quote" };
  const args = toks[0] === "gh" ? toks.slice(1) : toks;
  if (args.length === 0) return { ok: false, error: "gh needs a command, e.g. gh pr view {n}" };
  if (args.some((a) => a.includes("{n}"))) {
    if (ctx.n === null) return { ok: false, error: "{n} needs a pull request: open one or select a board row" };
    for (let i = 0; i < args.length; i++) args[i] = args[i]!.replaceAll("{n}", String(ctx.n));
  }
  const group = args.find((a) => !a.startsWith("-"));
  const slug = ctx.repo ? `${ctx.repo.owner}/${ctx.repo.name}` : null;
  if (group === "api" && ctx.repo) {
    for (let i = 0; i < args.length; i++) args[i] = args[i]!.replaceAll("{owner}", ctx.repo.owner).replaceAll("{repo}", ctx.repo.name);
  }
  const mutating = isMutating(args);
  if (slug && group) {
    if (REPO_FLAG.has(group) && !hasRepoFlag(args)) args.push("-R", slug);
    else if (group === "repo" && args.filter((a) => !a.startsWith("-")).length === 2 && args[args.indexOf("repo") + 1] === "view") args.push(slug);
  }
  const argv = ["gh", ...args];
  return { ok: true, plan: { argv, display: argv.map(quoteArg).join(" "), mutating } };
}

/** Environment for a non-interactive gh: no prompts, no colour, no pager, no update nag. */
export const GH_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: "1",
  NO_COLOR: "1",
  CLICOLOR: "0",
  GH_PAGER: "cat",
  PAGER: "cat",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
};

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s: string): string => s.replace(ANSI, "");

export interface GhResult {
  command: string;
  code: number;
  mutating: boolean;
  /** stdout then stderr, ANSI stripped, with a hint when gh wanted a prompt. */
  output: string;
}

const PROMPT_FAILURE = /prompt(s)? disabled|could not prompt|must (provide|specify)|unable to prompt|--title|--body/i;

export function formatGhOutput(stdout: string, stderr: string, code: number): string {
  const out = stripAnsi(stdout).replace(/\s+$/, "");
  const err = stripAnsi(stderr).replace(/\s+$/, "");
  let text = [out, err].filter(Boolean).join("\n");
  if (code !== 0 && PROMPT_FAILURE.test(err)) text += "\n\n(gh cannot prompt here: pass every input as flags)";
  return text || (code === 0 ? "(no output)" : "(no output)");
}
