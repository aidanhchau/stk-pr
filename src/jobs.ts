/**
 * Detached merge jobs. Every merge (single, force, stack) runs as `stk job run <id>` in its own process, so it
 * survives closing the TUI or the terminal pane. Progress lives in `~/.cache/stk/jobs/<id>.json`
 * (override the directory with STK_JOBS_DIR); the TUI and `stk jobs` only read that file.
 */
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, watch, writeFileSync, writeSync, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { merge, openCtx, openCtxForSlug, rebaseStack, stackInfo, stackMerge, type Ctx, type MergeDryRun, type MergeProgress } from "./service";
import { exec } from "./exec";
import { StkError, type PlanStep, type MergeMethod, type MergeOutcome, type RepoSlug, type StepResult } from "./types";
import { rateLimitReset } from "./github";
import { WHEN_READY_MAX_MS, WHEN_READY_POLL_MS, waitVerdict, type WaitVerdict } from "./watch";

export type JobKind = "merge" | "stack-merge" | "rebase-stack" | "merge-when-ready";
export type JobStatus = "running" | "done" | "failed";

export interface Job {
  id: string;
  kind: JobKind;
  repo: RepoSlug;
  /** The PR the user merged (for a stack: the top-most PR to merge). */
  pr: number;
  method: MergeMethod;
  force: boolean;
  /** Local checkout the runner should use; without it the runner resolves one from the repo slug. */
  repoDir?: string;
  /** rebase-stack: local checkouts of rebased branches that now differ from origin (left untouched), for the end-of-job message. */
  note?: string;
  status: JobStatus;
  steps: StepResult[];
  /** Planned step count of a stack merge (what `steps.length` counts toward). */
  total?: number;
  /** The steps the job computed at start (what `steps` settle, by identity). */
  plan?: PlanStep[];
  /** Every PR the job merges (the selected one plus its downstack PRs). */
  prs?: number[];
  /** Latest phase of the asynchronous merge GitHub is working on. */
  progress?: MergeProgress;
  /** Set when the job is done; see MergeOutcome. */
  outcome?: MergeOutcome;
  /** PRs that actually landed (not counting merge-queue entries). */
  merged?: number[];
  error?: string;
  errorCode?: string;
  errorData?: unknown;
  pid: number;
  startedAt: number;
  updatedAt: number;
  /** When some viewer claimed the right to announce this job's end (see `claimNotify`); read from the `<id>.notified` marker. */
  notifiedAt?: number;
  /** merge-when-ready: merge the stack up to `pr` instead of the single PR. */
  stack?: boolean;
  /** merge-when-ready: what the job is waiting for (`checks pending`). Unset once it starts merging; cancelling is only possible while set. */
  waiting?: string;
}

export type JobSpec = Pick<Job, "kind" | "repo" | "pr" | "method" | "force" | "repoDir" | "stack">;

export interface JobOpts {
  /** Is this process alive? Default: `kill(pid, 0)`. */
  alive?: (pid: number) => boolean;
}

/** Jobs older than this are deleted when listing. */
const KEEP_MS = 24 * 60 * 60_000;

export const jobsDir = (): string => process.env.STK_JOBS_DIR || join(homedir(), ".cache", "stk", "jobs");
const fileOf = (id: string) => join(jobsDir(), `${id}.json`);
const markerOf = (id: string) => join(jobsDir(), `${id}.notified`);

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Atomic replace so readers never see half a file. */
function write(job: Job): void {
  mkdirSync(jobsDir(), { recursive: true });
  const tmp = `${fileOf(job.id)}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(job));
  renameSync(tmp, fileOf(job.id));
}

function readRaw(id: string): Job | null {
  let job: Job;
  try {
    job = JSON.parse(readFileSync(fileOf(id), "utf8")) as Job;
  } catch {
    return null;
  }
  try {
    const at = Number(readFileSync(markerOf(id), "utf8"));
    job.notifiedAt = Number.isFinite(at) && at > 0 ? at : 1;
  } catch {
    /* unclaimed */
  }
  return job;
}

/**
 * Announce a job's end once across every TUI viewer: the first caller creates the `<id>.notified` marker
 * (O_EXCL, atomic) and gets true; everyone else gets false and stays quiet.
 */
export function claimNotify(id: string): boolean {
  try {
    mkdirSync(jobsDir(), { recursive: true });
    const fd = openSync(markerOf(id), "wx");
    try {
      writeSync(fd, String(Date.now()));
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/** A job that ended no longer than this ago, and that nobody announced yet, is still announced to a viewer that starts now. */
export const STARTUP_NOTIFY_MS = 60_000;

/** Startup rule: announce an ended job only if it ended recently and no viewer claimed it; claims it when true. */
export function claimStartupNotify(job: Job, now = Date.now()): boolean {
  return job.status !== "running" && !job.notifiedAt && now - job.updatedAt < STARTUP_NOTIFY_MS && claimNotify(job.id);
}

/** A job whose runner died without finishing is failed here, so nothing waits on it forever. */
function reconcile(job: Job, opts: JobOpts): Job {
  if (job.status !== "running" || (opts.alive ?? pidAlive)(job.pid)) return job;
  const failed: Job = { ...job, status: "failed", error: "runner exited", errorCode: "step-failed", updatedAt: Date.now() };
  // Re-read: the runner may have finished between our read and the pid check.
  const now = readRaw(job.id);
  if (now && now.status !== "running") return now;
  write(failed);
  return failed;
}

export function readJob(id: string, opts: JobOpts = {}): Job | null {
  const job = readRaw(id);
  return job ? reconcile(job, opts) : null;
}

/** Recent jobs, newest first. */
export function listJobs(filter: { repo?: RepoSlug; pr?: number } & JobOpts = {}): Job[] {
  let names: string[];
  try {
    names = readdirSync(jobsDir());
  } catch {
    return [];
  }
  const out: Job[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -5);
    const job = readJob(id, filter);
    if (!job) continue;
    if (job.status !== "running" && Date.now() - job.updatedAt > KEEP_MS) {
      try {
        unlinkSync(fileOf(id));
        unlinkSync(markerOf(id));
      } catch {
        /* already gone */
      }
      continue;
    }
    const r = filter.repo;
    if (r && (job.repo.owner.toLowerCase() !== r.owner.toLowerCase() || job.repo.name.toLowerCase() !== r.name.toLowerCase())) continue;
    if (filter.pr !== undefined && job.pr !== filter.pr && !job.prs?.includes(filter.pr)) continue;
    out.push(job);
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/** Spawn `stk job run <id>` detached from this process (and its terminal). Returns the runner's pid. */
function spawnRunner(id: string): number {
  const cli = join(import.meta.dir, "cli.ts");
  const proc = Bun.spawn([process.execPath, cli, "job", "run", id], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
    env: process.env,
  });
  proc.unref();
  return proc.pid;
}

/**
 * Create the job file and start its detached runner. Refuses when the PR already has a running job; `stackPrs` (the
 * other PRs of the stack a stack job works on) extends that to a running job on any of them.
 */
export async function startJob(spec: JobSpec, opts: JobOpts & { spawn?: (id: string) => number; stackPrs?: number[] } = {}): Promise<{ id: string }> {
  const covered = [spec.pr, ...(opts.stackPrs ?? [])];
  const running = listJobs({ repo: spec.repo, alive: opts.alive }).find((j) => j.status === "running" && covered.some((n) => jobCovers(j, spec.repo, n)));
  if (running) throw new StkError(running.pr === spec.pr ? `#${spec.pr} is already being merged` : `#${running.pr} is already being merged in this stack`, "usage");
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 6)}`;
  const now = Date.now();
  // Sub-millisecond start time so jobs started in the same millisecond still sort newest first.
  const job: Job = { id, ...spec, status: "running", steps: [], pid: process.pid, startedAt: performance.timeOrigin + performance.now(), updatedAt: now };
  write(job);
  try {
    // After spawn the runner is the only writer: it records its own pid, progress and outcome. Writing here again
    // could overwrite a fast runner's finished state with this stale "running" snapshot.
    (opts.spawn ?? spawnRunner)(id);
  } catch (e) {
    write({ ...job, status: "failed", error: `could not start the merge runner: ${e instanceof Error ? e.message : String(e)}`, updatedAt: Date.now() });
    throw new StkError(`could not start the merge runner: ${e instanceof Error ? e.message : String(e)}`, "gh-failed");
  }
  return { id };
}

/**
 * Call `cb` with the job now and whenever its file changes (fs.watch, with a 1 s poll as fallback for missed events).
 * Returns the stop function. Terminal jobs keep being reported once; callers stop on `status !== "running"`.
 */
export function watchJob(id: string, cb: (job: Job) => void, opts: JobOpts = {}): () => void {
  let last = "";
  let stopped = false;
  const check = () => {
    if (stopped) return;
    const job = readJob(id, opts);
    if (!job) return;
    const s = JSON.stringify(job);
    if (s === last) return;
    last = s;
    cb(job);
  };
  let w: FSWatcher | undefined;
  try {
    mkdirSync(jobsDir(), { recursive: true });
    w = watch(jobsDir(), (_event, name) => {
      if (!name || String(name).startsWith(id)) check();
    });
    w.on("error", () => {});
  } catch {
    /* polling alone still works */
  }
  const poll = setInterval(check, 1000);
  queueMicrotask(check);
  return () => {
    stopped = true;
    clearInterval(poll);
    w?.close();
  };
}

// ---------- runner ----------

export type JobUpdate = (patch: Partial<Job>) => void;
/** Performs the merge. Throws to fail the job (a StkError keeps its code and data). */
export type JobRunner = (job: Job, update: JobUpdate, ctx: () => Promise<Ctx>) => Promise<void>;

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** `STK_FAKE_MERGE=1`: three fake steps, never touches gh or git (pty smoke tests). `STK_FAKE_MERGE_MS` sets the step length. */
export const fakeRunner: JobRunner = async (job, update) => {
  const ms = Number(process.env.STK_FAKE_MERGE_MS) || 2000;
  const steps: StepResult[] = [];
  update({ total: 3, prs: [job.pr] });
  for (let i = 0; i < 3; i++) {
    update({ progress: { pr: job.pr, phase: i === 0 ? "requested" : "pending", message: `fake step ${i + 1}` } });
    await sleep(ms);
    steps.push({ step: { kind: "merge", pr: job.pr, method: job.method, admin: job.force, bypass: [] }, ok: true, detail: `fake step ${i + 1}/3` });
    update({ steps: [...steps] });
  }
  update({ progress: { pr: job.pr, phase: "merged" } });
};

export const serviceRunner: JobRunner = async (job, update, ctx) => {
  const c = await ctx();
  const { method, force } = job;
  const onProgress = (progress: MergeProgress) => update({ progress });
  if (job.kind === "merge") {
    update({ prs: [job.pr] });
    const r = await merge(c, job.pr, { method, force, onProgress });
    update({ outcome: r.status, merged: r.status === "merged" ? [job.pr] : [] });
    return;
  }
  if (job.kind === "rebase-stack") {
    const r = await rebaseStack(c, job.pr, { onStep: (message) => update({ progress: { pr: job.pr, phase: "pending", message } }) });
    update({ prs: r.prs, ...(r.note ? { note: r.note } : {}) });
    return;
  }
  const info = await stackInfo(c, job.pr, { method, force, upTo: job.pr });
  const planned = info.plan.flatMap((s) => (s.kind === "merge" ? (s.includes ?? [s.pr]) : []));
  // an empty plan records the PR that blocks it (the bottom one) so the outcome can name it
  update({ plan: info.plan, total: info.plan.length, prs: planned.length ? planned : info.stack.prs.slice(0, 1).map((p) => p.number) });
  const steps: StepResult[] = [];
  const r = await stackMerge(c, job.pr, {
    upTo: job.pr,
    method,
    force,
    onStep: (s) => {
      steps.push(s);
      update({ steps: [...steps] });
    },
    onProgress,
    // the plan is made again between merges of a forced native stack; the job file keeps what ran plus what is left
    onPlan: (p) => update({ plan: p, total: p.length }),
  });
  const queued = new Set(r.results.flatMap((s) => (s.step.kind === "merge" && s.enqueued ? (s.step.includes ?? [s.step.pr]) : [])));
  const outcome: MergeOutcome = r.merged.includes(job.pr) ? "merged" : queued.has(job.pr) ? "enqueued" : r.merged.length ? "partial" : "none";
  update({ outcome, merged: r.merged });
};

const ctxOf = (job: Job) => async (): Promise<Ctx> => {
  if (job.repoDir) {
    try {
      return { ...(await openCtx(exec, job.repoDir)), slug: job.repo };
    } catch (e) {
      if (!(e instanceof StkError)) throw e;
    }
  }
  return openCtxForSlug(exec, job.repo.owner, job.repo.name);
};

// ---------- merge when ready ----------

const isCancelled = (id: string): boolean => readRaw(id)?.errorCode === "cancelled";

/**
 * Cancel a merge-when-ready job that is still waiting: the runner notices the record and stops. Returns false when
 * there is nothing to cancel (unknown, ended, other kind); throws once the job has started merging, which is not
 * stoppable.
 */
export function cancelJob(id: string, opts: JobOpts = {}): boolean {
  const job = readJob(id, opts);
  if (!job || job.status !== "running" || job.kind !== "merge-when-ready") return false;
  if (job.waiting === undefined) throw new StkError(`#${job.pr} is already merging: too late to cancel`, "usage");
  const { waiting: _waiting, ...rest } = job;
  write({ ...rest, status: "failed", error: "cancelled", errorCode: "cancelled", updatedAt: Date.now() });
  return true;
}

export interface WhenReadyDeps {
  now: () => number;
  /** Wait `ms`; the default wakes early when the job is cancelled. */
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  maxMs: number;
  /** Does the merge once nothing blocks (default: the same code as a plain merge / stack merge). */
  perform: JobRunner;
}

/** Sleep in short slices so a cancel is noticed within seconds, not at the next 60 s poll. */
async function sleepUnlessCancelled(id: string, ms: number): Promise<void> {
  for (let left = ms; left > 0 && !isCancelled(id); left -= 2000) await sleep(Math.min(2000, left));
}

const spanText = (ms: number): string => (ms >= 3_600_000 ? `${Math.round(ms / 3_600_000)}h` : `${Math.max(1, Math.round(ms / 60_000))}m`);

/** The verdict for the job's target right now: one dry-run merge for a PR, one plan for a stack (up to `job.pr`). */
async function whenReadyVerdict(c: Ctx, job: Job): Promise<WaitVerdict> {
  const n = job.pr;
  if (!job.stack) {
    let dry: MergeDryRun;
    try {
      dry = await merge(c, n, { method: job.method, force: false, dryRun: true });
    } catch (e) {
      const ended = e instanceof StkError && e.code === "usage" ? /is (merged|closed), not open/.exec(e.message) : null;
      if (ended) throw new StkError(`#${n} was ${ended[1]} by someone else`, "usage");
      throw e;
    }
    if (dry.wouldMerge) return { verdict: "ready" };
    return dry.blockers.length === 0 ? { verdict: "hard", reason: dry.note ?? `#${n} cannot be merged on its own` } : waitVerdict(dry.blockers, n);
  }
  const info = await stackInfo(c, n, { method: job.method, force: false, upTo: n });
  if (!info.stop) return info.plan.some((s) => s.kind === "merge") ? { verdict: "ready" } : { verdict: "hard", reason: `nothing to merge for #${n}` };
  const bs = info.blockers[info.stop.pr] ?? [];
  return bs.length > 0 ? waitVerdict(bs, info.stop.pr) : { verdict: "wait", reason: info.stop.reason };
}

/**
 * `merge-when-ready`: poll the PR (or stack plan up to it) and merge through the normal path once nothing blocks it.
 * Never bypasses: force is always false. Soft blockers (pending checks, review, threads...) are waited out; a hard
 * one (conflict, changes requested, failing checks, draft, closed) fails the job with the reason. A rate limit
 * pauses polling until its reset. Gives up after `maxMs` (24 h).
 */
export function makeWhenReadyRunner(deps: Partial<WhenReadyDeps> = {}): JobRunner {
  const { now = Date.now, pollMs = WHEN_READY_POLL_MS, maxMs = WHEN_READY_MAX_MS, perform = serviceRunner } = deps;
  return async (job, update, ctx) => {
    const nap = deps.sleep ?? ((ms: number) => sleepUnlessCancelled(job.id, ms));
    const cancelled = () => new StkError("cancelled", "usage");
    const c = await ctx();
    const start = now();
    let failures = 0;
    update({ waiting: "checking", prs: [job.pr] });
    for (;;) {
      if (isCancelled(job.id)) throw cancelled();
      let verdict: WaitVerdict;
      let delay = pollMs;
      try {
        verdict = await whenReadyVerdict(c, job);
        failures = 0;
      } catch (e) {
        const reset = rateLimitReset(e);
        if (reset !== null) {
          verdict = { verdict: "wait", reason: `GitHub rate limited · polling resumes ${new Date(reset).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, "").toLowerCase()}` };
          delay = Math.max(pollMs, reset - Date.now());
        } else if (e instanceof StkError && e.code === "usage") {
          throw e;
        } else if (++failures >= 5) {
          throw e;
        } else {
          verdict = { verdict: "wait", reason: `retrying after an error: ${e instanceof Error ? e.message : String(e)}` };
        }
      }
      if (verdict.verdict === "hard") throw new StkError(verdict.reason, "blocked");
      if (verdict.verdict === "ready") {
        update({ waiting: undefined });
        if (isCancelled(job.id)) throw cancelled();
        try {
          await perform({ ...job, kind: job.stack ? "stack-merge" : "merge" }, update, ctx);
          return;
        } catch (e) {
          // blockers came back between the check and the merge request: keep waiting
          if (!(e instanceof StkError && e.code === "blocked")) throw e;
          verdict = { verdict: "wait", reason: e.message };
        }
      }
      if (now() + delay - start > maxMs) throw new StkError(`gave up after ${spanText(maxMs)}: ${verdict.reason}`, "merge-timeout");
      update({ waiting: verdict.reason });
      await nap(delay);
    }
  };
}

export const whenReadyRunner: JobRunner = makeWhenReadyRunner();

/** Entry of `stk job run <id>`: claim the job, run it, record the outcome. Returns false when the job does not exist. */
export async function runJob(id: string, runner?: JobRunner): Promise<boolean> {
  const first = readRaw(id);
  if (!first) return false;
  let job: Job = { ...first, status: "running", pid: process.pid };
  // a cancelled job stays cancelled: nothing the runner does afterwards may overwrite that record
  const update: JobUpdate = (patch) => {
    if (isCancelled(id)) return;
    job = { ...job, ...patch, updatedAt: Date.now() };
    write(job);
  };
  update({});
  const run = runner ?? (process.env.STK_FAKE_MERGE ? fakeRunner : job.kind === "merge-when-ready" ? whenReadyRunner : serviceRunner);
  try {
    await run(job, update, ctxOf(job));
    update({ status: "done" });
  } catch (e) {
    if (e instanceof StkError) {
      const results = (e.data as { results?: StepResult[] } | undefined)?.results;
      update({ status: "failed", error: e.message, errorCode: e.code, errorData: e.data, waiting: undefined, ...(results ? { steps: results } : {}), progress: failedProgress(job, e.message) });
    } else {
      update({ status: "failed", error: e instanceof Error ? e.message : String(e), errorCode: "internal", waiting: undefined, progress: failedProgress(job, e instanceof Error ? e.message : String(e)) });
    }
  }
  return true;
}

function failedProgress(job: Job, message: string): MergeProgress | undefined {
  return job.progress && job.progress.phase !== "merged" ? { ...job.progress, phase: "failed", message } : job.progress;
}

// ---------- display ----------

/** One-line status of a running job: `step 2/5`, `waiting for GitHub`, ... */
export function jobStatusText(job: Job): string {
  const waiting = job.kind === "merge-when-ready" && job.waiting !== undefined;
  const base =
    job.kind === "rebase-stack"
      ? `rebasing stack #${job.pr}…`
      : waiting
        ? `waiting to merge${job.stack ? " stack" : ""} #${job.pr}`
        : job.kind === "stack-merge" || job.stack
          ? `merging stack #${job.pr}…`
          : `merging #${job.pr}…`;
  const p = job.progress;
  const detail = waiting
    ? job.waiting
    : p && p.phase !== "merged" && p.phase !== "failed"
      ? p.phase === "enqueued"
        ? "queued by GitHub"
        : p.message || (p.phase === "pending" ? "waiting for GitHub" : "requested")
      : "";
  const step = !waiting && job.total && job.total > 0 ? `${Math.min(job.steps.length + 1, job.total)}/${job.total}` : "";
  return [base, step, detail].filter(Boolean).join(" · ");
}

/** Dock variant of `jobStatusText`: no PR number (the page already says which), `merging stack · 2/5`. */
export function jobDockText(job: Job): string {
  return jobStatusText(job).replace(/ #\d+…/, "");
}

/** Does this job (running or not) concern PR `n` of `repo`? */
export const jobCovers = (job: Job, repo: RepoSlug, n: number): boolean =>
  job.repo.owner.toLowerCase() === repo.owner.toLowerCase() &&
  job.repo.name.toLowerCase() === repo.name.toLowerCase() &&
  (job.pr === n || !!job.prs?.includes(n));
