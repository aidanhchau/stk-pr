#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { exec as realExec } from "./exec";
import {
  describeBlockers,
  listBoard,
  merge,
  openCtx,
  sessionPrs,
  openWorktree,
  prDetail,
  prFiles,
  reply,
  resolve,
  review,
  stackInfo,
  stackMerge,
  type BoardPr,
  type Ctx,
  type ReviewEvent,
  type SessionPr,
} from "./service";
import { jobStatusText, listJobs, runJob } from "./jobs";
import { agentPanes } from "./session";
import { doctorOk, doctorText, runDoctor, versionText } from "./doctor";
import { StkError, mergeOutcomeText, type Blocker, type Exec, type MergeMethod } from "./types";

export interface CliDeps {
  exec: Exec;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

const HELP = `stk - worktree-first GitHub PR tool

usage: stk [--repo DIR] [--json] <command>

  prs [--mine|--review|--all]          list open PRs with blockers (default --mine)
  pr <n> [--patches]                   PR, blockers, review threads, files, stack
  diff <n> [--file PATH]               per-file diffs with patches
  open <n> [--create]                  find (or create) the worktree for a PR branch
  review <n> (--approve|--request-changes|--comment) [-m BODY]
  reply <threadId> -m BODY             reply to a review thread
  resolve <threadId>                   resolve a review thread
  merge <n> [--method squash|merge|rebase] [--force] [--dry-run]
  stack <n> [--merge] [--force] [--method M]   show the plan, or execute it with --merge
  jobs [--gh OWNER/NAME] [--json]      recent merge jobs (merges run detached and survive closing the TUI)
  session [--pane ID]                  PRs mentioned in a Tern pane's agent session (default: the agent pane next to $TERN_PANE)
  doctor                               check gh, auth, Tern, rate limits, cache and repo detection (--json; exit 1 on a failure)
  tui [--pr N] [--gh OWNER/NAME] [--session-pane ID]   terminal UI (also the default with no command)

Outside a GitHub repo, tui opens a workspace board over the repos found below the directory (3 levels deep;
Mine / Review requests / Session across all of them; :repo or R picks one, :repo all returns). --repo DIR scans DIR instead.

--force merges via GitHub's merge-async API with bypass_rules (bypasses checks/review/threads you may bypass; never conflicts or drafts).
--json prints one line: {"ok":true,"data":...} or {"ok":false,"error":{"code","message"}}.
`;

const usage = (msg: string): never => {
  throw new StkError(`${msg}\n\n${HELP}`, "usage");
};

// ---------- helpers ----------

function parseNumber(s: string | undefined, what: string): number {
  if (!s || !/^\d+$/.test(s)) usage(`${what} must be a PR number`);
  return Number(s);
}

function parseMethod(s: string | undefined): MergeMethod {
  if (s === undefined) return "squash";
  if (s === "squash" || s === "merge" || s === "rebase") return s;
  return usage(`--method must be squash, merge or rebase (got ${s})`);
}

const prLine = (p: BoardPr | (Omit<BoardPr, "blockers"> & { blockers?: Blocker[] })) => {
  const bs = p.blockers?.length ? `  [${p.blockers.map((b) => b.kind).join(",")}]` : "";
  return `#${p.number} ${p.title} (${p.headRef} -> ${p.baseRef})${p.isDraft ? " [draft]" : ""}${bs}${p.worktree ? `  @ ${p.worktree}` : ""}`;
};

type Result = { data: unknown; text: string };

// ---------- commands ----------

interface Opts {
  repo?: string;
  json?: boolean;
  help?: boolean;
  version?: boolean;
  mine?: boolean;
  review?: boolean;
  all?: boolean;
  patches?: boolean;
  file?: string;
  create?: boolean;
  approve?: boolean;
  "request-changes"?: boolean;
  comment?: boolean;
  message?: string;
  method?: string;
  force?: boolean;
  "dry-run"?: boolean;
  merge?: boolean;
  pr?: string;
  gh?: string;
  pane?: string;
  "session-pane"?: string;
}

async function cmdPrs(ctx: Ctx, o: Opts): Promise<Result> {
  const modes = [o.mine, o.review, o.all].filter(Boolean).length;
  if (modes > 1) usage("choose one of --mine, --review, --all");
  const board = await listBoard(ctx, o.review ? "review" : o.all ? "all" : "mine");
  return {
    data: board,
    text: board.prs.length ? board.prs.map(prLine).join("\n") : "no open PRs",
  };
}

async function cmdPr(ctx: Ctx, o: Opts, args: string[]): Promise<Result> {
  const n = parseNumber(args[0], "pr");
  const d = await prDetail(ctx, n);
  if (o.patches) {
    const patches = new Map((await prFiles(ctx, n)).files.map((f) => [f.path, f]));
    d.files = d.files.map((f) => {
      const full = patches.get(f.path);
      return full ? { ...f, oldPath: full.oldPath, patch: full.patch } : f;
    });
  }
  const { pr, blockers: bs, threads, files, stack } = d;
  const lines = [prLine({ ...pr, blockers: bs }), pr.url];
  if (bs.length) lines.push(`blockers: ${describeBlockers(bs)}`);
  if (stack) lines.push(`stack: ${stack.prs.map((x) => `#${x}`).join(" <- ")} (onto ${stack.trunk})`);
  lines.push("", `files (${files.length}):`);
  for (const f of files) lines.push(`  +${f.additions} -${f.deletions} ${f.path}`);
  const open = threads.filter((t) => !t.isResolved);
  lines.push("", `threads: ${open.length} unresolved / ${threads.length} total`);
  for (const t of threads) {
    lines.push(`- ${t.id}${t.isResolved ? " (resolved)" : ""} ${t.path ?? ""}${t.line ? `:${t.line}` : ""}`);
    for (const c of t.comments) lines.push(`    ${c.author}: ${c.body.replace(/\s*\n\s*/g, " ")}`);
  }
  return { data: d, text: lines.join("\n") };
}

async function cmdDiff(ctx: Ctx, o: Opts, args: string[]): Promise<Result> {
  const d = await prFiles(ctx, parseNumber(args[0], "diff"), o.file);
  return { data: d, text: d.files.map((f) => f.patch).join("\n") };
}

async function cmdOpen(ctx: Ctx, o: Opts, args: string[]): Promise<Result> {
  const d = await openWorktree(ctx, parseNumber(args[0], "open"), { create: o.create });
  const text = d.worktree
    ? d.created
      ? `created ${d.worktree}`
      : d.worktree
    : `no worktree for ${d.branch} (use --create)`;
  return { data: d, text };
}

async function cmdReview(ctx: Ctx, o: Opts, args: string[]): Promise<Result> {
  const n = parseNumber(args[0], "review");
  const picks = [
    o.approve && "APPROVE",
    o["request-changes"] && "REQUEST_CHANGES",
    o.comment && "COMMENT",
  ].filter((x): x is ReviewEvent => !!x);
  if (picks.length !== 1) usage("review needs exactly one of --approve, --request-changes, --comment");
  const d = await review(ctx, n, picks[0]!, o.message ?? "");
  return { data: d, text: `submitted ${d.event} on #${n}` };
}

async function cmdReply(ctx: Ctx, o: Opts, args: string[]): Promise<Result> {
  const id = args[0];
  if (!id) usage("reply needs a thread id");
  const d = await reply(ctx, id!, o.message ?? "");
  return { data: d, text: `replied to ${id}` };
}

async function cmdResolve(ctx: Ctx, args: string[]): Promise<Result> {
  const id = args[0];
  if (!id) usage("resolve needs a thread id");
  const d = await resolve(ctx, id!);
  return { data: d, text: `resolved ${id}` };
}

async function cmdMerge(ctx: Ctx, o: Opts, args: string[]): Promise<Result> {
  const n = parseNumber(args[0], "merge");
  const method = parseMethod(o.method);
  const force = !!o.force;

  if (o["dry-run"]) {
    const d = await merge(ctx, n, { method, force, dryRun: true });
    const unbypassable = d.blockers.filter((b) => b.kind === "conflict" || b.kind === "draft");
    return {
      data: d,
      text: d.wouldMerge
        ? `would ${force ? "force-merge" : "merge"} #${n} (${method})${d.bypass.length ? `, bypassing ${describeBlockers(d.bypass)}` : ""}`
        : `would NOT merge #${n}: ${describeBlockers(force ? unbypassable : d.blockers)}`,
    };
  }
  const d = await merge(ctx, n, { method, force });
  const verb = d.status === "enqueued" ? "queued" : force ? "force-merged" : "merged";
  const text = `${verb} #${n} (${method}${force ? ", bypass rules" : ""})${force && d.bypassed.length ? `, bypassed: ${describeBlockers(d.bypassed)}` : ""}`;
  return { data: d, text: d.note ? `${text}\n${d.note}` : text };
}

async function cmdStack(ctx: Ctx, o: Opts, args: string[], deps: CliDeps, json: boolean): Promise<Result> {
  const n = parseNumber(args[0], "stack");
  const method = parseMethod(o.method);
  const force = !!o.force;

  if (!o.merge) {
    const d = await stackInfo(ctx, n, { method, force });
    const { stack, forks, plan } = d;
    const lines = [`stack onto ${stack.trunk}: ${stack.prs.map((p) => `#${p.number}`).join(" <- ")}`];
    for (const f of forks) lines.push(`fork: #${f.parent} has children ${f.children.map((c) => `#${c}`).join(", ")}`);
    for (const s of plan) lines.push(`  ${s.kind} ${"pr" in s ? `#${s.pr}` : s.branch}`);
    if (plan.length === 0) lines.push("  (nothing mergeable)");
    return { data: d, text: lines.join("\n") };
  }

  const r = await stackMerge(ctx, n, {
    method,
    force,
    onStep: (s) => {
      if (!json) deps.stdout(`${s.ok ? "ok  " : "FAIL"} ${s.detail}\n`);
    },
  });
  const count = `merged ${r.merged.length}/${r.total.length}`;
  return {
    data: { results: r.results },
    text: r.remaining.length
      ? `${count}; stopped before ${r.remaining.map((p) => `#${p}`).join(", ")} (blocked)`
      : count,
  };
}

async function cmdSession(deps: CliDeps, o: Opts): Promise<Result> {
  const origin = process.env.TERN_PANE;
  const pane = o.pane ?? (origin ? (await agentPanes(deps.exec, origin).catch(() => []))[0]?.id : undefined);
  if (!pane) usage(origin ? "no agent pane found next to this pane; pass --pane ID" : "session needs --pane ID (or run inside a Tern pane)");
  const d = await sessionPrs(deps.exec, pane!);
  const section = (title: string, prs: SessionPr[]) =>
    prs.length ? [`${title} (${prs.length})`, ...prs.map((p) => `  ${p.repo.owner}/${p.repo.name}${prLine(p).replace(/^/, " ")}`)] : [];
  const lines = [
    ...section("Open", d.groups.open),
    ...section("Merged", d.groups.merged),
    ...section("Closed", d.groups.closed),
    ...d.errors.map((e) => `! ${e.repo.owner}/${e.repo.name}: ${e.message}`),
  ];
  return { data: d, text: lines.length ? lines.join("\n") : "no PRs mentioned in this session" };
}

function parseSlug(s: string): { owner: string; name: string } {
  const m = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (!m) usage(`--gh must be OWNER/NAME (got ${s})`);
  return { owner: m![1]!, name: m![2]! };
}

// ---------- entry ----------

const OPTIONS = {
  repo: { type: "string" },
  json: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  mine: { type: "boolean" },
  review: { type: "boolean" },
  all: { type: "boolean" },
  patches: { type: "boolean" },
  file: { type: "string" },
  create: { type: "boolean" },
  approve: { type: "boolean" },
  "request-changes": { type: "boolean" },
  comment: { type: "boolean" },
  message: { type: "string", short: "m" },
  method: { type: "string" },
  force: { type: "boolean" },
  "dry-run": { type: "boolean" },
  merge: { type: "boolean" },
  pr: { type: "string" },
  gh: { type: "string" },
  pane: { type: "string" },
  "session-pane": { type: "string" },
  version: { type: "boolean" },
} as const;

function parse(argv: string[]) {
  return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true, strict: true });
}

export async function main(argv: string[], deps: CliDeps): Promise<number> {
  const json = argv.includes("--json");
  const emitError = (code: string, message: string, data?: unknown): number => {
    if (json) {
      deps.stdout(`${JSON.stringify({ ok: false, error: { code, message, ...(data !== undefined ? { data } : {}) } })}\n`);
    } else {
      deps.stderr(`error: ${message}\n`);
    }
    return 1;
  };

  try {
    let parsed: { values: Opts; positionals: string[] };
    try {
      parsed = parse(argv);
    } catch (e) {
      return emitError("usage", `${e instanceof Error ? e.message : String(e)}\n\n${HELP}`);
    }
    const { values: o, positionals } = parsed;
    const [cmd, ...args] = positionals;
    if (o.version || cmd === "version") {
      const version = await versionText(deps.exec);
      deps.stdout(json ? `${JSON.stringify({ ok: true, data: { version } })}\n` : `stk ${version}\n`);
      return 0;
    }
    if (!o.help && !json && (cmd === "tui" || cmd === undefined)) {
      if (!process.stdout.isTTY) usage("the TUI needs a terminal; use --json commands in scripts");
      const pr = o.pr === undefined ? undefined : parseNumber(o.pr, "--pr");
      // Lazy: React/OpenTUI (and its native lib) must not load on the JSON CLI paths.
      const gh = o.gh === undefined ? undefined : parseSlug(o.gh);
      const { runTui } = await import("./tui/main");
      return await runTui({ repoDir: o.repo ?? process.cwd(), pr, gh, sessionPane: o["session-pane"] });
    }
    if (o.help || cmd === "help") {
      deps.stdout(json ? `${JSON.stringify({ ok: true, data: { help: HELP } })}\n` : HELP);
      return 0;
    }
    if (cmd === "doctor") {
      const checks = await runDoctor({ exec: deps.exec, cwd: o.repo ?? process.cwd() });
      const ok = doctorOk(checks);
      deps.stdout(json ? `${JSON.stringify({ ok: true, data: { healthy: ok, checks } })}\n` : `${doctorText(checks)}\n`);
      return ok ? 0 : 1;
    }
    if (cmd === "session") {
      const result = await cmdSession(deps, o);
      deps.stdout(json ? `${JSON.stringify({ ok: true, data: result.data })}\n` : `${result.text}\n`);
      return 0;
    }
    if (cmd === "job") {
      // Hidden: the detached runner `startJob` spawns.
      if (args[0] !== "run" || !args[1]) usage("usage: stk job run <id>");
      if (!(await runJob(args[1]!))) throw new StkError(`no such job: ${args[1]}`, "usage");
      return 0;
    }
    if (cmd === "jobs") {
      const jobs = listJobs(o.gh === undefined ? {} : { repo: parseSlug(o.gh) });
      const line = (j: (typeof jobs)[number]) =>
        `${j.id}  ${j.repo.owner}/${j.repo.name}#${j.pr}  ${j.kind}  ${j.status === "running" ? jobStatusText(j) : j.status === "failed" ? `failed: ${j.error ?? ""}` : mergeOutcomeText(j)}`;
      deps.stdout(json ? `${JSON.stringify({ ok: true, data: { jobs } })}\n` : `${jobs.length ? jobs.map(line).join("\n") : "no recent merge jobs"}\n`);
      return 0;
    }
    const known = ["prs", "pr", "diff", "open", "review", "reply", "resolve", "merge", "stack"];
    if (!cmd || !known.includes(cmd)) usage(cmd ? `unknown command: ${cmd}` : "missing command");

    const ctx = await openCtx(deps.exec, o.repo ?? process.cwd());

    let result: Result;
    switch (cmd) {
      case "prs": result = await cmdPrs(ctx, o); break;
      case "pr": result = await cmdPr(ctx, o, args); break;
      case "diff": result = await cmdDiff(ctx, o, args); break;
      case "open": result = await cmdOpen(ctx, o, args); break;
      case "review": result = await cmdReview(ctx, o, args); break;
      case "reply": result = await cmdReply(ctx, o, args); break;
      case "resolve": result = await cmdResolve(ctx, args); break;
      case "merge": result = await cmdMerge(ctx, o, args); break;
      default: result = await cmdStack(ctx, o, args, deps, json); break;
    }
    deps.stdout(json ? `${JSON.stringify({ ok: true, data: result.data })}\n` : `${result.text}\n`);
    return 0;
  } catch (e) {
    if (e instanceof StkError) return emitError(e.code, e.message, e.data);
    return emitError("internal", e instanceof Error ? e.message : String(e));
  }
}

if (import.meta.main) {
  const code = await main(Bun.argv.slice(2), {
    exec: realExec,
    stdout: (s) => void process.stdout.write(s),
    stderr: (s) => void process.stderr.write(s),
  });
  process.exit(code);
}
