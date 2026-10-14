// PRs mentioned in a Tern pane's agent session.
//
// Source 1 (preferred): the omp session transcript. omp writes ~/.omp/agent/sessions/<cwd-slug>/*.jsonl and
// keeps the session title on line 1 (and in the session header); Tern shows that same title as the pane
// title, so `tern ls --json` (pane -> title/cwd) identifies the file exactly. The transcript holds every
// prompt and tool output verbatim, so it survives scrollback limits and restarts.
// The transcript is parsed structurally (see `parseTranscript`): only PRs the session created, acted on or
// discussed count; URLs that merely appear in tool output (listings, file contents, fixtures) do not.
// Source 2 (fallback): `tern capture <pane> --scrollback --surfaces` text, for non-omp panes or titles
// that no transcript matches.
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Exec, SessionPrRef } from "./types";

const PR_URL = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/g;

/**
 * Extracts GitHub pull request URLs (plain, `/files`, `/commits`, `#discussion…` forms, `gh pr create`
 * output) from text; deduped, in order of first mention. `firstSeen` is the 0-based line of that mention.
 */
export function extractPrRefs(text: string): SessionPrRef[] {
  const seen = new Set<string>();
  const out: SessionPrRef[] = [];
  let line = 0;
  let scanned = 0;
  for (const m of text.matchAll(PR_URL)) {
    const idx = m.index ?? 0;
    for (let i = text.indexOf("\n", scanned); i !== -1 && i < idx; i = text.indexOf("\n", i + 1)) line++;
    scanned = idx;
    const owner = m[1]!;
    const name = m[2]!;
    const number = Number(m[3]);
    const key = `${owner}/${name}#${number}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ owner, name, number, firstSeen: line });
  }
  return out;
}

interface PaneInfo {
  title: string;
  cwd: string | null;
}

interface TernBlock {
  id: number;
  title?: string;
  cwd?: string | null;
  command?: string | null;
  focused?: boolean;
}

interface TernLs {
  sessions?: { id?: number; tabs?: { id?: number; blocks?: TernBlock[] }[] }[];
}

/** Finds a pane in `tern ls --json` output. */
export function findPane(ls: TernLs, paneId: string): PaneInfo | null {
  const sessions = ls.sessions ?? [];
  for (const s of sessions) {
    for (const t of s.tabs ?? []) {
      for (const b of t.blocks ?? []) {
        if (String(b.id) === paneId) return { title: b.title ?? "", cwd: b.cwd ?? null };
      }
    }
  }
  return null;
}

/** An stk pane (never an agent session): titled `stk ...` or launched through stk's CLI. */
function isStkPane(b: TernBlock): boolean {
  return /^stk\b/i.test(b.title ?? "") || /\bstk\b.*\bcli\.ts\b|\bstk tui\b/.test(b.command ?? "");
}

/** A pane that may hold an agent session, with where it sits relative to the pane stk runs in. */
export interface PaneCandidate {
  id: string;
  title: string;
  cwd: string | null;
  /** 0 = same tab as the origin pane, 1 = same Tern window (session) other tab, 2 = elsewhere. */
  distance: 0 | 1 | 2;
  focused: boolean;
}

/** Non-stk panes of `tern ls --json` with their distance from `originId`, in listing order. */
export function paneCandidates(ls: TernLs, originId: string): PaneCandidate[] {
  const all: { b: TernBlock; tab: number; win: number }[] = [];
  (ls.sessions ?? []).forEach((s, si) => (s.tabs ?? []).forEach((t, ti) => (t.blocks ?? []).forEach((b) => all.push({ b, tab: ti * 1 + si * 1e6, win: si }))));
  const origin = all.find((x) => String(x.b.id) === originId);
  return all
    .filter((x) => !isStkPane(x.b))
    .map((x) => ({
      id: String(x.b.id),
      title: x.b.title ?? "",
      cwd: x.b.cwd ?? null,
      distance: (!origin ? 2 : x.tab === origin.tab ? 0 : x.win === origin.win ? 1 : 2) as 0 | 1 | 2,
      focused: !!x.b.focused,
    }));
}

/**
 * Orders agent panes best first. `mtimes` holds the transcript mtime of every pane that has an omp transcript;
 * panes without one are not agent panes and are dropped. The origin pane itself leads when it is an agent pane;
 * then panes of the same tab (the focused one first), then the same Tern window, then the rest, most recently
 * active transcript first. Tern exposes no cross-tab focus history, so a fresh tab resolves to the most recently
 * written session of its window.
 */
export function rankAgentPanes(cands: PaneCandidate[], originId: string, mtimes: ReadonlyMap<string, number>): PaneCandidate[] {
  return cands
    .filter((c) => mtimes.has(c.id))
    .sort((a, b) => {
      const self = Number(b.id === originId) - Number(a.id === originId);
      if (self) return self;
      if (a.distance !== b.distance) return a.distance - b.distance;
      const foc = a.distance === 0 ? Number(b.focused) - Number(a.focused) : 0;
      return foc || mtimes.get(b.id)! - mtimes.get(a.id)!;
    });
}

/** Agent panes reachable from Tern pane `originId`, best first (see `rankAgentPanes`); empty outside Tern or when none exist. */
export async function agentPanes(exec: Exec, originId: string, opts: SessionOpts = {}): Promise<PaneCandidate[]> {
  const r = await exec(["tern", "ls", "--json"]);
  if (r.code !== 0) return [];
  let ls: TernLs;
  try {
    ls = JSON.parse(r.stdout);
  } catch {
    return [];
  }
  const cands = paneCandidates(ls, originId);
  const dir = opts.sessionsDir ?? ompSessionsDir();
  const mtimes = new Map<string, number>();
  await Promise.all(
    cands.map(async (c) => {
      const hit = await findTranscript({ title: c.title, cwd: c.cwd }, dir);
      if (hit) mtimes.set(c.id, hit.mtime);
    }),
  );
  return rankAgentPanes(cands, originId, mtimes);
}

/** Session title and cwd from the first lines of an omp transcript (`title` record, `session` header). */
export function transcriptHead(head: string): { title: string | null; cwd: string | null } {
  let title: string | null = null;
  let cwd: string | null = null;
  for (const line of head.split("\n").slice(0, 3)) {
    try {
      const j = JSON.parse(line) as { type?: string; title?: string; cwd?: string };
      if (j.type === "title" && j.title) title ??= j.title;
      if (j.type === "session") {
        title ??= j.title ?? null;
        cwd = j.cwd ?? null;
      }
    } catch {
      // truncated tail of the 8 KB head, or not JSON
    }
  }
  return { title, cwd };
}

export interface SessionOpts {
  /** Default ~/.omp/agent/sessions. */
  sessionsDir?: string;
}

/** The newest omp transcript whose title is `pane.title`, preferring one started in the pane's cwd. */
async function findTranscript(pane: PaneInfo, sessionsDir: string): Promise<{ path: string; mtime: number } | null> {
  if (!pane.title) return null;
  const dirs = await readdir(sessionsDir).catch(() => [] as string[]);
  const hits: { path: string; cwdMatch: boolean; mtime: number }[] = [];
  await Promise.all(
    dirs.map(async (d) => {
      const files = await readdir(join(sessionsDir, d)).catch(() => [] as string[]);
      await Promise.all(
        files
          .filter((f) => f.endsWith(".jsonl"))
          .map(async (f) => {
            const path = join(sessionsDir, d, f);
            const head = transcriptHead(await Bun.file(path).slice(0, 8192).text().catch(() => ""));
            if (head.title !== pane.title) return;
            const st = await stat(path).catch(() => null);
            if (st) hits.push({ path, cwdMatch: !!pane.cwd && head.cwd === pane.cwd, mtime: st.mtimeMs });
          }),
      );
    }),
  );
  hits.sort((a, b) => Number(b.cwdMatch) - Number(a.cwdMatch) || b.mtime - a.mtime);
  return hits[0] ?? null;
}

// ---------- structural transcript parsing ----------

export type MentionRole = "created" | "acted" | "discussed";
export interface Mention {
  /** JSONL line index (0-based) of the first / last qualifying mention. */
  first: number;
  last: number;
  count: number;
  role: MentionRole;
}
export interface SessionRef extends SessionPrRef {
  mention: Mention;
}

const ROLE_RANK: Record<MentionRole, number> = { created: 3, acted: 2, discussed: 1 };
export const roleRank = (r: MentionRole): number => ROLE_RANK[r];

const PLACEHOLDER_OWNERS = new Set(["owner", "o", "example", "foo", "org", "user", "username", "your-org", "your-org-name", "acme", "org-name", "x"]);
const PLACEHOLDER_NAMES = new Set(["repo", "r", "example", "bar", "baz", "repository", "your-repo", "repo-name", "name", "project"]);

/** `owner/repo`, `o/r`, `example/*`, `foo/bar` style stand-ins used in docs and test fixtures. */
export function isPlaceholderRepo(owner: string, name: string): boolean {
  const o = owner.toLowerCase();
  const n = name.toLowerCase();
  return PLACEHOLDER_OWNERS.has(o) || PLACEHOLDER_NAMES.has(n) || o.startsWith("example") || n.startsWith("example");
}

interface Event {
  line: number;
  role: MentionRole;
  owner: string;
  name: string;
  number: number;
}
/** A reference whose repo is the git repo containing `cwd` (`gh pr merge 12` with no -R). */
interface CwdEvent {
  line: number;
  role: MentionRole;
  cwd: string;
  number: number;
}
/** `widgets #12`: owner is learned from other, fully qualified references to a repo of that name. */
interface ShortEvent {
  line: number;
  name: string;
  number: number;
}

export interface ParsedTranscript {
  events: Event[];
  cwdEvents: CwdEvent[];
  shortEvents: ShortEvent[];
  /** repo name (lowercase) -> owner (original case), from every full reference anywhere in the transcript. */
  owners: Map<string, string>;
}

type Segment = string[];

/** Drops heredoc bodies; they hold scripts and fixtures, not commands. */
function stripHeredocs(cmd: string): string {
  return cmd.replace(/(<<-?\s*['"]?(\w+)['"]?)([^\n]*)\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, "$3");
}

/** Minimal shell splitter: quotes, escapes, and `&& || ; | & ( )` / newline as segment separators. */
export function shellSegments(command: string): Segment[] {
  const src = stripHeredocs(command);
  const segs: Segment[] = [];
  let cur: string[] = [];
  let tok = "";
  let has = false;
  const endTok = () => {
    if (has) cur.push(tok);
    tok = "";
    has = false;
  };
  const endSeg = () => {
    endTok();
    if (cur.length) segs.push(cur);
    cur = [];
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "\\") {
      if (src[i + 1] === "\n") i++;
      else if (i + 1 < src.length) {
        tok += src[++i];
        has = true;
      }
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const end = j === -1 ? src.length : j;
      tok += src.slice(i + 1, end);
      has = true;
      i = end;
    } else if (c === '"') {
      has = true;
      for (i++; i < src.length && src[i] !== '"'; i++) {
        if (src[i] === "\\" && i + 1 < src.length) i++;
        tok += src[i];
      }
    } else if (c === " " || c === "\t") endTok();
    else if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")") endSeg();
    else if (c === "&") {
      if (src[i - 1] === ">" || src[i + 1] === ">") {
        tok += c;
        has = true;
      } else endSeg();
    } else {
      tok += c;
      has = true;
    }
  }
  endSeg();
  return segs;
}

const PR_URL_ONE = /github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/;
const FULL_REF = /(?<![\w./-])([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)\b/g;
const SHORT_REF = /(?<![\w/.#-])([A-Za-z][\w.-]*)[ \t]?#(\d+)\b/g;
const PR_SUBCOMMANDS = new Set(["merge", "close", "edit", "review", "comment", "ready", "reopen", "checks", "view", "diff", "update-branch"]);
/** gh pr flags that consume the next token. */
const VALUE_FLAGS = new Set([
  "-R", "--repo", "-b", "--body", "-t", "--title", "-F", "--body-file", "-m", "--message", "-B", "--base", "-H", "--head",
  "-a", "--assignee", "-l", "--label", "-r", "--reviewer", "--add-reviewer", "--remove-reviewer", "--add-label", "--remove-label",
  "--subject", "--match-head-commit", "--jq", "-q", "--json", "--template", "--interval", "-i", "--author-email", "-A", "--milestone", "-M", "--add-assignee", "--remove-assignee",
]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

interface SegmentHit {
  role: MentionRole;
  owner?: string;
  name?: string;
  cwd?: string | null;
  number: number;
}

interface CmdInfo {
  hits: SegmentHit[];
  /** The command runs `gh pr create` or a `$STK_PUSH_COMMANDS` wrapper, so PR URLs in its output were created by it. */
  creates: boolean;
  /** Runs gh/git/a push wrapper at all (gates the literal "Created pull request" output text). */
  vcs: boolean;
}

function expandPath(p: string, cwd: string | null): string | null {
  if (!p || /[$`*]/.test(p)) return null;
  if (p === "~" || p.startsWith("~/")) return join(process.env.HOME ?? homedir(), p.slice(1));
  if (isAbsolute(p)) return p;
  return cwd ? resolve(cwd, p) : null;
}

/** Splits `gh pr <sub>` arguments into the -R repo and first positional. */
function ghPrTarget(args: string[]): { repo: string | null; positional: string | null } {
  let repo: string | null = null;
  let positional: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("-")) {
      const eq = a.indexOf("=");
      const flag = eq === -1 ? a : a.slice(0, eq);
      const val = eq === -1 ? (VALUE_FLAGS.has(flag) ? args[++i] : undefined) : a.slice(eq + 1);
      if (flag === "-R" || flag === "--repo") repo = val ?? null;
    } else if (positional === null) positional = a;
  }
  return { repo, positional };
}

function repoOfSlug(s: string | null): { owner: string; name: string } | null {
  const m = s?.match(/^(?:[^/]+\/)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  return m ? { owner: m[1]!, name: m[2]! } : null;
}

/** Directory of omp session transcripts: `$STK_OMP_SESSIONS`, else `~/.omp/agent/sessions`. */
export function ompSessionsDir(): string {
  return process.env.STK_OMP_SESSIONS || join(process.env.HOME ?? homedir(), ".omp/agent/sessions");
}

/** Command names from a comma-separated env var: wrappers around `gh pr create` (push) or PR watchers taking `owner/repo#N` / `N` arguments (watch). */
function customCommands(envVar: "STK_PUSH_COMMANDS" | "STK_WATCH_COMMANDS"): Set<string> {
  return new Set((process.env[envVar] ?? "").split(",").map((x) => x.trim()).filter(Boolean));
}

/** What a bash command does to PRs: acted-on targets and whether it creates PRs. */
export function analyzeCommand(command: string, startCwd: string | null): CmdInfo {
  const info: CmdInfo = { hits: [], creates: false, vcs: false };
  let cwd = startCwd;
  for (const seg of shellSegments(command)) {
    let i = 0;
    while (i < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[i]!)) i++;
    const t = seg.slice(i);
    const head = t[0] ? basename(t[0]) : "";
    if (head === "cd") {
      cwd = t[1] ? expandPath(t[1], cwd) : null;
      continue;
    }
    if (customCommands("STK_PUSH_COMMANDS").has(head)) {
      info.creates = info.vcs = true;
    } else if (head === "git") {
      info.vcs = true;
    } else if (customCommands("STK_WATCH_COMMANDS").has(head)) {
      const rest = t.slice(1);
      for (let k = 0; k < rest.length; k++) {
        const a = rest[k]!;
        if (a.startsWith("-") || /^\d*>/.test(a)) continue;
        let m = a.match(PR_URL_ONE);
        if (m) {
          info.hits.push({ role: "acted", owner: m[1]!, name: m[2]!, number: Number(m[3]) });
        } else if ((m = a.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#(\d+)$/))) {
          info.hits.push({ role: "acted", owner: m[1]!, name: m[2]!, number: Number(m[3]) });
        } else if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(a) && /^#?\d+$/.test(rest[k + 1] ?? "")) {
          const [owner, name] = a.split("/") as [string, string];
          info.hits.push({ role: "acted", owner, name, number: Number(rest[++k]!.replace("#", "")) });
        } else if (/^#?\d+$/.test(a)) {
          info.hits.push({ role: "acted", cwd, number: Number(a.replace("#", "")) });
        }
      }
    } else if (head === "gh") {
      info.vcs = true;
      if (t[1] === "pr" && t[2] === "create") info.creates = true;
      else if (t[1] === "pr" && PR_SUBCOMMANDS.has(t[2] ?? "")) {
        const { repo, positional } = ghPrTarget(t.slice(3));
        if (positional === null) continue;
        const url = positional.match(PR_URL_ONE);
        if (url) info.hits.push({ role: "acted", owner: url[1]!, name: url[2]!, number: Number(url[3]) });
        else if (/^\d+$/.test(positional)) {
          const r = repoOfSlug(repo);
          info.hits.push(r ? { role: "acted", ...r, number: Number(positional) } : { role: "acted", cwd, number: Number(positional) });
        }
      } else if (t[1] === "api") {
        const path = t.find((x) => /repos\/[^/]+\/[^/]+\/pulls\/\d+/.test(x));
        const m = path?.match(/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)/);
        if (!m) continue;
        const xi = t.findIndex((x) => x === "-X" || x === "--method");
        const method = (xi === -1 ? t.find((x) => x.startsWith("--method="))?.slice(9) ?? t.find((x) => x.startsWith("-X") && x.length > 2)?.slice(2) : t[xi + 1])?.toUpperCase();
        const hasFields = t.some((x) => ["-f", "-F", "--field", "--raw-field", "--input"].includes(x));
        if (method ? MUTATING.has(method) : hasFields) info.hits.push({ role: "acted", owner: m[1]!, name: m[2]!, number: Number(m[3]) });
      }
    }
  }
  return info;
}

const texts = (content: unknown): string[] =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content.flatMap((b) => (b && b.type === "text" && typeof b.text === "string" ? [b.text as string] : []))
      : [];

/**
 * Walks an omp JSONL transcript and collects PR references that count: URLs / `owner/repo#n` / `widgets #n` in
 * user and assistant text (`discussed`), PR-targeting gh / `$STK_WATCH_COMMANDS` commands the assistant ran (`acted`), and PR
 * URLs in the output of `gh pr create` / `$STK_PUSH_COMMANDS` wrappers (`created`). URLs in other tool output are only used to
 * learn which owner a short repo name belongs to.
 */
export function parseTranscript(text: string, sessionCwd: string | null = null): ParsedTranscript {
  const events: Event[] = [];
  const cwdEvents: CwdEvent[] = [];
  const shortEvents: ShortEvent[] = [];
  const ownerVotes = new Map<string, Map<string, number>>();
  const learn = (owner: string, name: string) => {
    const votes = ownerVotes.get(name.toLowerCase()) ?? new Map<string, number>();
    votes.set(owner, (votes.get(owner) ?? 0) + 1);
    ownerVotes.set(name.toLowerCase(), votes);
  };
  const calls = new Map<string, CmdInfo>();

  const scanText = (t: string, line: number) => {
    for (const m of t.matchAll(new RegExp(PR_URL_ONE, "g"))) {
      learn(m[1]!, m[2]!);
      events.push({ line, role: "discussed", owner: m[1]!, name: m[2]!, number: Number(m[3]) });
    }
    const noUrls = t.replace(/https?:\/\/\S+/g, " ");
    for (const m of noUrls.matchAll(FULL_REF)) {
      learn(m[1]!, m[2]!);
      events.push({ line, role: "discussed", owner: m[1]!, name: m[2]!, number: Number(m[3]) });
    }
    for (const m of noUrls.replace(FULL_REF, " ").matchAll(SHORT_REF)) shortEvents.push({ line, name: m[1]!, number: Number(m[2]) });
  };

  const lines = text.split("\n");
  for (let line = 0; line < lines.length; line++) {
    const raw = lines[line]!;
    if (!raw.startsWith("{")) continue;
    let rec: { type?: string; message?: { role?: string; content?: unknown; toolCallId?: string } };
    try {
      rec = JSON.parse(raw);
    } catch {
      continue;
    }
    const msg = rec.type === "message" ? rec.message : undefined;
    if (!msg) continue;
    if (msg.role === "user") {
      for (const t of texts(msg.content)) scanText(t, line);
    } else if (msg.role === "assistant") {
      for (const t of texts(msg.content)) scanText(t, line);
      for (const b of Array.isArray(msg.content) ? msg.content : []) {
        if (b?.type !== "toolCall") continue;
        const args = (b.arguments ?? {}) as { command?: unknown; cwd?: unknown };
        if (b.name !== "bash" || typeof args.command !== "string") continue;
        const info = analyzeCommand(args.command, typeof args.cwd === "string" ? (expandPath(args.cwd, sessionCwd) ?? sessionCwd) : sessionCwd);
        if (typeof b.id === "string") calls.set(b.id, info);
        for (const h of info.hits) {
          if (h.owner && h.name) {
            learn(h.owner, h.name);
            events.push({ line, role: h.role, owner: h.owner, name: h.name, number: h.number });
          } else if (h.cwd) cwdEvents.push({ line, role: h.role, cwd: h.cwd, number: h.number });
        }
      }
    } else if (msg.role === "toolResult") {
      const info = typeof msg.toolCallId === "string" ? calls.get(msg.toolCallId) : undefined;
      for (const t of texts(msg.content)) {
        const created = !!info && (info.creates || (info.vcs && /Created pull request/i.test(t)));
        for (const m of t.matchAll(new RegExp(PR_URL_ONE, "g"))) {
          learn(m[1]!, m[2]!);
          if (created) events.push({ line, role: "created", owner: m[1]!, name: m[2]!, number: Number(m[3]) });
        }
      }
    }
  }
  const owners = new Map<string, string>();
  for (const [name, votes] of ownerVotes) owners.set(name, [...votes.entries()].sort((a, b) => b[1] - a[1])[0]![0]);
  return { events, cwdEvents, shortEvents, owners };
}

/** Folds parsed events into one ref per PR with mention stats; placeholders and unresolvable refs are dropped. */
export function summarizeMentions(parsed: ParsedTranscript, repoOfCwd: (cwd: string) => { owner: string; name: string } | null): SessionRef[] {
  const all: Event[] = [...parsed.events];
  for (const e of parsed.cwdEvents) {
    const r = repoOfCwd(e.cwd);
    if (r) all.push({ line: e.line, role: e.role, ...r, number: e.number });
  }
  for (const e of parsed.shortEvents) {
    const owner = parsed.owners.get(e.name.toLowerCase());
    if (owner) all.push({ line: e.line, role: "discussed", owner, name: e.name, number: e.number });
  }
  all.sort((a, b) => a.line - b.line);
  const out = new Map<string, SessionRef>();
  // One mention per (record, PR): a message that links a PR twice, or watches it, counts once.
  const seenInLine = new Set<string>();
  for (const e of all) {
    if (isPlaceholderRepo(e.owner, e.name)) continue;
    const key = `${e.owner}/${e.name}#${e.number}`.toLowerCase();
    const cur = out.get(key);
    if (!cur) {
      out.set(key, { owner: e.owner, name: e.name, number: e.number, firstSeen: e.line, mention: { first: e.line, last: e.line, count: 1, role: e.role } });
      seenInLine.add(`${e.line}:${key}`);
      continue;
    }
    const m = cur.mention;
    if (roleRank(e.role) > roleRank(m.role)) m.role = e.role;
    if (seenInLine.has(`${e.line}:${key}`)) continue;
    seenInLine.add(`${e.line}:${key}`);
    m.count++;
    m.last = e.line;
  }
  return [...out.values()];
}

const remoteSlug = (url: string): { owner: string; name: string } | null => {
  const m = url.trim().match(/github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return m ? { owner: m[1]!, name: m[2]! } : null;
};

/** PRs the agent session running in Tern pane `paneId` created, acted on or discussed, in order of first mention. */
export async function sessionPrRefs(exec: Exec, paneId: string, opts: SessionOpts = {}): Promise<SessionRef[]> {
  const ls = await exec(["tern", "ls", "--json"]);
  let pane: PaneInfo | null = null;
  if (ls.code === 0) {
    try {
      pane = findPane(JSON.parse(ls.stdout), paneId);
    } catch {
      // fall through to capture
    }
  }
  if (pane) {
    const hit = await findTranscript(pane, opts.sessionsDir ?? ompSessionsDir());
    if (hit) {
      const parsed = parseTranscript(await Bun.file(hit.path).text(), pane.cwd);
      const repos = new Map<string, { owner: string; name: string } | null>();
      await Promise.all(
        [...new Set(parsed.cwdEvents.map((e) => e.cwd))].map(async (cwd) => {
          const r = await exec(["git", "-C", cwd, "remote", "get-url", "origin"]).catch(() => null);
          repos.set(cwd, r && r.code === 0 ? remoteSlug(r.stdout) : null);
        }),
      );
      const refs = summarizeMentions(parsed, (cwd) => repos.get(cwd) ?? null);
      if (refs.length > 0) return refs;
    }
  }
  const cap = await exec(["tern", "capture", paneId, "--scrollback", "--surfaces"]);
  if (cap.code !== 0) throw new Error(`Tern pane ${paneId} not found or unreadable (${cap.stderr.trim() || "tern capture failed"}); it may have been closed`);
  // Raw terminal text has no structure: every non-placeholder URL is a single 'discussed' mention.
  return extractPrRefs(cap.stdout)
    .filter((r) => !isPlaceholderRepo(r.owner, r.name))
    .map((r) => ({ ...r, mention: { first: r.firstSeen, last: r.firstSeen, count: 1, role: "discussed" as const } }));
}
