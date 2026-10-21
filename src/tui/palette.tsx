/** `:` / ctrl-k PR switcher: vim-style command line at the bottom, results growing upward. Fuzzy over loaded PRs; GitHub only on request. */
import { useKeyboard } from "@opentui/react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { baseCandidates, commandHint, rankBases, rankCommands, rankRepos, rankSessionPanes, type BaseRow, type RankedCommand, type RepoRow, type SessionRow } from "../commands";
import { ageOf, itemKey, parseTarget, rankPrs, type PaletteItem, type Ranked } from "../fuzzy";
import { commandFacts, commandTarget, confirmBase, ghPreview, runCommand, runGh, trunkOf } from "./commands";
import { PALETTE_LINE, paletteItems, useStore, useStoreInstance } from "./store";
import { SectionLabel } from "./ui";
import { G, clip, reducedMotion, useLayout, useTheme, type Palette } from "./theme";

const ROWS = 10;
/** Dock = rule + content row + the blank last row the command line takes over. */
const DOCK_ROWS = 3;
const LOCAL_LIMIT = 50;
const DEBOUNCE_MS = 250;
const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

type Gh = { status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "done"; items: PaletteItem[] };

type Row =
  | { kind: "pr"; r: Ranked }
  | { kind: "cmd"; c: RankedCommand }
  | { kind: "suggest"; base: string; rebase: boolean }
  | { kind: "gh-cmd"; args: string }
  | { kind: "repo"; r: RepoRow }
  | { kind: "repo-cmd" }
  | { kind: "session"; r: SessionRow }
  | { kind: "session-cmd" }
  | { kind: "base"; b: BaseRow }
  | { kind: "direct"; repo: string; n: number }
  | { kind: "gh" };

function stateGlyph(p: Palette, it: PaletteItem): [string, string] {
  if (it.state === "MERGED") return [G.dot, p.merged];
  if (it.state === "CLOSED") return [G.cross, p.closed];
  return it.isDraft ? [G.ring, p.draft] : [G.dot, p.open];
}

/** Title split into plain / bold runs by matched positions. */
function highlight(title: string, positions: number[]): ReactNode[] {
  const hit = new Set(positions);
  const out: ReactNode[] = [];
  let run = "";
  let bold = false;
  const flush = () => {
    if (!run) return;
    out.push(bold ? <strong key={out.length}>{run}</strong> : <span key={out.length}>{run}</span>);
    run = "";
  };
  for (let i = 0; i < title.length; i++) {
    const b = hit.has(i);
    if (b !== bold) flush();
    bold = b;
    run += title[i];
  }
  flush();
  return out;
}

function Spin() {
  const [t, setT] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const id = setInterval(() => setT((x) => x + 1), 90);
    return () => clearInterval(id);
  }, []);
  return <>{reducedMotion() ? "…" : FRAMES[t % FRAMES.length]}</>;
}

export function PaletteSheet() {
  const p = useTheme();
  const store = useStoreInstance();
  const { width: W, contentWidth, gutter, margin } = useLayout();
  const boards = useStore((s) => s.boards);
  const session = useStore((s) => s.session);
  const prCache = useStore((s) => s.prCache);
  const repo = useStore((s) => s.repo);
  const workspace = useStore((s) => s.workspace);
  const sessionPanes = useStore((s) => s.sessionCandidates);
  const sessionPane = useStore((s) => s.sessionPane);
  const prefs = useStore((s) => s.prefs);
  const [query, setQuery] = useState(() => {
    const sheet = store.getState().sheet;
    return sheet?.kind === "palette" ? (sheet.query ?? "") : "";
  });
  const [cursor, setCursor] = useState(0);
  /** `:base` second stage: pick the new base branch. */
  const [stage, setStage] = useState<"base" | null>(null);
  const [gh, setGh] = useState<{ query: string; state: Gh }>({ query: "", state: { status: "idle" } });
  const top = useRef(0);
  const token = useRef(0);
  const timer = useRef<NodeJS.Timeout | undefined>(undefined);

  useEffect(() => {
    store.setInputFocused(true);
    return () => {
      store.setInputFocused(false);
      clearTimeout(timer.current);
      token.current++;
    };
  }, [store]);

  const facts = useMemo(() => commandFacts(store.getState()), [store]);
  const target = useMemo(() => commandTarget(store.getState()), [store]);
  const items = useMemo(() => paletteItems({ boards, session, prCache, repo }), [boards, session, prCache, repo]);
  const q = query.trim();
  const ghState: Gh = gh.query === q ? gh.state : { status: "idle" };

  const trunk = useMemo(() => (target ? trunkOf(store.getState(), target.repo) : "main"), [store, target]);
  const rows = useMemo(() => {
    const out: Row[] = [];
    if (stage === "base" && target) {
      const cands = baseCandidates(trunk, items, `${target.repo.owner}/${target.repo.name}`, [target.pr.headRef]);
      return rankBases(cands, q).map((b): Row => ({ kind: "base", b }));
    }
    const repoArgs = workspace ? /^repo(\s+(.*))?$/is.exec(query) : null;
    if (workspace && repoArgs?.[1] !== undefined) {
      const cands = workspace.repos.map((x) => `${x.slug.owner}/${x.slug.name}`);
      return rankRepos(cands, repoArgs[2] ?? "").map((r): Row => ({ kind: "repo", r }));
    }
    const sessionArgs = sessionPanes.length > 0 ? /^session(\s+(.*))?$/is.exec(query) : null;
    if (sessionArgs?.[1] !== undefined) return rankSessionPanes(sessionPanes, sessionArgs[2] ?? "").map((r): Row => ({ kind: "session", r }));
    const ghArgs = /^gh(\s+(.*))?$/s.exec(query);
    if (ghArgs) return [{ kind: "gh-cmd" as const, args: (ghArgs[2] ?? "").trim() }];
    if (facts?.baseMerged && (!q || "base".startsWith(q.toLowerCase()) || "retarget".startsWith(q.toLowerCase()))) out.push({ kind: "suggest", base: trunk, rebase: facts.nativeStack });
    const ref = parseTarget(q);
    if (ref) out.push({ kind: "direct", repo: `${ref.owner}/${ref.name}`, n: ref.number });
    else if (/^#?\d+$/.test(q) && repo) out.push({ kind: "direct", repo: `${repo.owner}/${repo.name}`, n: Number(q.replace("#", "")) });
    if (workspace && q && "repo".startsWith(q.toLowerCase())) out.push({ kind: "repo-cmd" });
    if (sessionPanes.length > 0 && q && "session".startsWith(q.toLowerCase())) out.push({ kind: "session-cmd" });
    if (!/^#?\d+$/.test(q)) for (const c of rankCommands(q, facts)) out.push({ kind: "cmd", c });
    const local = rankPrs(items, q, LOCAL_LIMIT);
    const seen = new Set(local.map((r) => itemKey(r.item)));
    for (const r of local) out.push({ kind: "pr", r });
    if (ghState.status === "done") for (const it of ghState.items) if (!seen.has(itemKey(it))) out.push({ kind: "pr", r: { item: it, positions: [], score: 0 } });
    if (q) out.push({ kind: "gh" });
    return out;
  }, [items, q, query, ghState, facts, repo, stage, target, trunk, workspace, sessionPanes]);

  const sel = Math.min(cursor, Math.max(0, rows.length - 1));
  top.current = sel < top.current ? sel : sel >= top.current + ROWS ? sel - ROWS + 1 : Math.min(top.current, Math.max(0, rows.length - ROWS));

  const searchGithub = () => {
    if (!q || ghState.status === "loading") return;
    const mine = q;
    const t = ++token.current;
    setGh({ query: mine, state: { status: "loading" } });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      store.searchGithub(mine).then(
        (res) => t === token.current && setGh({ query: mine, state: { status: "done", items: res } }),
        (e) => t === token.current && setGh({ query: mine, state: { status: "error", message: e instanceof Error ? e.message : String(e) } }),
      );
    }, DEBOUNCE_MS);
  };

  const activate = (i: number) => {
    const row = rows[i];
    if (!row) return;
    if (row.kind === "gh") searchGithub();
    else if (row.kind === "repo-cmd") {
      setQuery("repo ");
      setCursor(0);
      top.current = 0;
    } else if (row.kind === "session-cmd") {
      setQuery("session ");
      setCursor(0);
      top.current = 0;
    } else if (row.kind === "session") {
      store.closeSheet();
      store.setSessionPane(row.r.id);
    } else if (row.kind === "repo") {
      store.closeSheet();
      void store.setRepoFocus(row.r.slug === null ? null : { owner: row.r.slug.slice(0, row.r.slug.indexOf("/")), name: row.r.slug.slice(row.r.slug.indexOf("/") + 1) });
    }
    else if (row.kind === "gh-cmd") {
      if (!row.args) return;
      store.closeSheet();
      runGh(store, row.args);
    } else if (row.kind === "suggest") {
      store.closeSheet();
      if (row.rebase) runCommand(store, "rebase-stack");
      else confirmBase(store, row.base);
    } else if (row.kind === "base") {
      store.closeSheet();
      confirmBase(store, row.b.name);
    } else if (row.kind === "cmd" && row.c.def.id === "base") {
      setStage("base");
      setQuery("");
      setCursor(0);
      top.current = 0;
    } else if (row.kind === "cmd") {
      store.closeSheet();
      runCommand(store, row.c.def.id);
    }
    else if (row.kind === "direct") store.openPaletteTarget(row.repo, row.n);
    else store.openPaletteTarget(row.r.item.repo, row.r.item.number);
  };

  useKeyboard((key) => {
    const move = (d: number) => setCursor((c) => Math.max(0, Math.min(rows.length - 1, Math.min(c, rows.length - 1) + d)));
    if (stage && (key.name === "escape" || (key.name === "backspace" && query === ""))) {
      setStage(null);
      setQuery("");
      setCursor(0);
    } else if (key.name === "escape" || (key.ctrl && key.name === "k") || (key.name === "backspace" && query === "")) store.closeSheet();
    else if (key.name === "down" || (key.ctrl && key.name === "n")) move(1);
    else if (key.name === "up" || (key.ctrl && key.name === "p")) move(-1);
    else if (key.name === "return" || key.name === "enter") activate(sel);
  });

  const inner = contentWidth - 2;

  const renderRow = (row: Row, i: number) => {
    const selected = i === sel;
    const bg = selected ? p.sel : p.surface;
    const muted = selected ? p.mutedOnSel : p.muted;
    let body: ReactNode;
    if (row.kind === "gh") {
      const label =
        ghState.status === "loading"
          ? ["Searching GitHub…", null]
          : ghState.status === "error"
            ? [ghState.message, "err"]
            : ghState.status === "done"
              ? [`${ghState.items.length} result${ghState.items.length === 1 ? "" : "s"} from GitHub · search again`, null]
              : [`Search GitHub for “${clip(q, 40)}”`, null];
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{ghState.status === "loading" ? <Spin /> : G.arrow}</span>
          <span fg={label[1] ? p.error : selected ? p.ink : p.cobalt}>{` ${label[0]}`}</span>
        </text>
      );
    } else if (row.kind === "gh-cmd") {
      const pre = row.args ? ghPreview(store.getState(), row.args) : null;
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={pre && !pre.ok ? p.error : p.ink}>{!pre ? "gh <args>  e.g. gh pr view {n}" : pre.ok ? pre.display : pre.error}</span>
          <span fg={muted}>{pre?.ok ? (pre.mutating ? "  (asks first)" : "  ⏎ run") : ""}</span>
        </text>
      );
    } else if (row.kind === "repo-cmd") {
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={p.ink}>repo</span>
          <span fg={muted}>  pick a repository of this workspace</span>
        </text>
      );
    } else if (row.kind === "session-cmd") {
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={p.ink}>session</span>
          <span fg={muted}>  pick the agent pane behind the Session tab</span>
        </text>
      );
    } else if (row.kind === "session") {
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={p.ink}>{highlight(row.r.title, row.r.positions)}</span>
          <span fg={muted}>{`  agent pane${row.r.id === sessionPane ? " · current" : ""}`}</span>
        </text>
      );
    } else if (row.kind === "repo") {
      const slug = row.r.slug;
      const active = (slug ?? "") === (workspace?.focus ? `${workspace.focus.owner}/${workspace.focus.name}` : "");
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={p.ink}>{slug === null ? "all" : highlight(slug, row.r.positions)}</span>
          <span fg={muted}>{`  ${slug === null ? `workspace board (${workspace?.repos.length ?? 0} repos)` : "repo board"}${active ? " · current" : ""}`}</span>
        </text>
      );
    } else if (row.kind === "suggest") {
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={p.ink}>{row.rebase ? `Base merged ${G.sep} rebase stack` : `Base merged ${G.sep} retarget to ${row.base}`}</span>
        </text>
      );
    } else if (row.kind === "base") {
      const hint = row.b.free ? "use this branch" : row.b.name === trunk ? "default branch" : "open PR branch";
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={p.ink}>{highlight(row.b.name, row.b.positions)}</span>
          <span fg={muted}>{`  ${hint}`}</span>
        </text>
      );
    } else if (row.kind === "cmd") {
      const { def } = row.c;
      const at = def.scope === "none" ? "" : target ? ` #${target.n}` : "";
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.cobalt}>{`${G.arrow} `}</span>
          <span fg={p.ink}>{highlight(def.name, row.c.positions)}</span>
          <span fg={muted}>{`${at}  ${commandHint(def, prefs)}${def.destructive ? " (asks first)" : ""}`}</span>
        </text>
      );
    } else if (row.kind === "direct") {
      body = (
        <text wrapMode="none" truncate>
          <span fg={p.open}>{G.arrow}</span>
          <span fg={p.ink}>{` Open ${row.repo}#${row.n}`}</span>
        </text>
      );
    } else {
      const it = row.r.item;
      const [glyph, gfg] = stateGlyph(p, it);
      const num = `#${it.number}`;
      const repoName = it.repo.slice(it.repo.indexOf("/") + 1);
      const age = it.updatedAt ? ageOf(it.updatedAt) : "";
      let meta = [repoName, it.author, age].filter(Boolean).join(` ${G.sep} `);
      let titleW = inner - 2 - num.length - 1 - meta.length - 2;
      if (titleW < 16) {
        meta = clip([repoName, age].filter(Boolean).join(` ${G.sep} `), Math.max(0, Math.floor(inner / 3)));
        titleW = inner - 2 - num.length - 1 - meta.length - 2;
      }
      const title = clip(it.title, Math.max(4, titleW));
      body = (
        <text wrapMode="none" truncate>
          <span fg={gfg}>{`${glyph} `}</span>
          <span fg={muted}>{`${num} `}</span>
          <span fg={p.ink}>{highlight(title, row.r.positions)}</span>
          <span fg={muted}>{`${" ".repeat(Math.max(2, titleW - title.length + 2))}${meta}`}</span>
        </text>
      );
    }
    return (
      <box key={row.kind === "pr" ? itemKey(row.r.item) : row.kind === "cmd" ? `cmd:${row.c.def.id}` : row.kind === "base" ? `base:${row.b.name}` : row.kind === "repo" ? `repo:${row.r.slug ?? "*"}` : row.kind === "session" ? `session:${row.r.id}` : row.kind} height={1} flexShrink={0} backgroundColor={bg} paddingLeft={1} paddingRight={1} marginLeft={-1} marginRight={-1}>
        {body}
      </box>
    );
  };

  // The command line lives in the dock (row 1); the panel above is results only.
  const placeholder = stage ? `new base for #${target?.n ?? ""}: branch name` : "go to PR, run a command, or gh …";
  useEffect(() => {
    store.setSearchLine(PALETTE_LINE, {
      query,
      active: true,
      info: `${items.length} loaded`,
      prefix: stage ? `base ${G.arrow} ` : ":",
      hint: "↑↓ select · ⏎ run · esc",
      placeholder,
      onInput: (v: string) => {
        setQuery(v);
        setCursor(0);
        top.current = 0;
      },
    });
  }, [store, query, stage, items.length, placeholder]);
  useEffect(() => () => store.setSearchLine(PALETTE_LINE, null), [store]);

  const shown = rows.slice(top.current, top.current + ROWS);
  const hint = rows.length === 0 ? (stage ? "No branches loaded" : q ? "No loaded PRs match" : "No pull requests loaded yet") : null;
  const pad = margin + gutter;
  const groupOf = (r: Row): string | null => (stage ? null : r.kind === "cmd" || r.kind === "suggest" || r.kind === "gh-cmd" || r.kind === "repo-cmd" || r.kind === "session-cmd" ? "Commands" : r.kind === "base" || r.kind === "repo" || r.kind === "session" ? null : "PRs");
  const body: ReactNode[] = [];
  let lastGroup: string | null = null;
  shown.forEach((r, i) => {
    const g = groupOf(r);
    if (g && g !== lastGroup) body.push(<SectionLabel key={`g:${g}`} label={g} />);
    lastGroup = g;
    body.push(renderRow(r, top.current + i));
  });

  return (
    <>
      <box position="absolute" left={0} bottom={DOCK_ROWS} width={W} zIndex={50} flexDirection="column" backgroundColor={p.surface} onMouseDown={(e) => e.stopPropagation()}>
        <box height={1} flexShrink={0}>
          <text fg={p.rule} wrapMode="none">{"─".repeat(W)}</text>
        </box>
        <box flexDirection="column" paddingLeft={pad + 1} paddingRight={pad + 1}>
          {hint ? <text fg={p.muted}>{hint}</text> : body}
        </box>
      </box>
    </>
  );
}
