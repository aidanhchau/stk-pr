/** Pure PR-palette logic used by the TUI: fuzzy scoring, ranking, dedupe, direct-target parsing. */

export interface PaletteItem {
  /** `owner/name` */
  repo: string;
  number: number;
  title: string;
  headRef: string;
  author: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  isDraft: boolean;
  /** ISO timestamp; "" when unknown. */
  updatedAt: string;
}

export interface Ranked {
  item: PaletteItem;
  /** Indices into `item.title` that matched the query (sorted), for highlighting. */
  positions: number[];
  score: number;
}

export const itemKey = (i: { repo: string; number: number }): string => `${i.repo}#${i.number}`.toLowerCase();

const isWordChar = (c: string) => /[a-z0-9]/i.test(c);

/** Bonus for matching at text[j]: start of a word beats the middle of one. */
function boundary(text: string, j: number): number {
  if (j === 0) return 8;
  const prev = text[j - 1]!;
  const cur = text[j]!;
  if (!isWordChar(prev)) return 8;
  if (prev === prev.toLowerCase() && cur !== cur.toLowerCase()) return 6; // camelCase hump
  return 0;
}

/**
 * Quality gate for queries of 3+ chars: the match starts at a word start and no matched char floats alone
 * (each sits in a contiguous run of 2+), unless every char is a word start (an acronym).
 */
function tight(text: string, pos: number[]): boolean {
  if (boundary(text, pos[0]!) === 0) return false;
  if (pos.every((j) => boundary(text, j) > 0)) return true;
  return pos.every((j, i) => pos[i - 1] === j - 1 || pos[i + 1] === j + 1);
}

/**
 * Case-insensitive subsequence match of `q` in `text`, maximising: +1 per char, +4 per contiguous follow-up,
 * boundary bonus for word starts. DP over (query index, text index); text is short so O(m·n) is fine.
 */
export function fuzzyMatch(q: string, text: string): { score: number; positions: number[] } | null {
  const m = q.length;
  const n = text.length;
  if (m === 0) return { score: 0, positions: [] };
  if (m > n) return null;
  const ql = q.toLowerCase();
  const tl = text.toLowerCase();
  const NEG = -1e9;
  // best[i][j]: best score with q[i] matched at text[j]; from[i][j]: previous text index.
  const best: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(NEG));
  const from: number[][] = Array.from({ length: m }, () => new Array<number>(n).fill(-1));
  for (let i = 0; i < m; i++) {
    let run = NEG; // best[i-1][k] for k < j, with its index
    let runAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j > 0 && best[i - 1]![j - 1]! > run) {
        run = best[i - 1]![j - 1]!;
        runAt = j - 1;
      }
      if (ql[i] !== tl[j]) continue;
      const here = 1 + boundary(text, j);
      if (i === 0) {
        best[0]![j] = here;
        continue;
      }
      if (run <= NEG / 2) continue;
      // Either extend a contiguous run from j-1 or jump from the best earlier match.
      const contig = j > 0 && best[i - 1]![j - 1]! > NEG / 2 ? best[i - 1]![j - 1]! + here + 4 : NEG;
      const jump = run + here;
      if (contig >= jump) {
        best[i]![j] = contig;
        from[i]![j] = j - 1;
      } else {
        best[i]![j] = jump;
        from[i]![j] = runAt;
      }
    }
  }
  let end = -1;
  let top = NEG;
  for (let j = 0; j < n; j++) if (best[m - 1]![j]! > top) ((top = best[m - 1]![j]!), (end = j));
  if (end < 0 || top <= NEG / 2) return null;
  const positions = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) {
    positions[i] = j;
    j = from[i]![j]!;
  }
  if (m >= 3 && !tight(text, positions)) return null;
  // Shorter texts win ties: a tighter match of the same chars is a better hit.
  return { score: top - n * 0.01, positions };
}

/** A pull request addressed directly by `owner/name#123` or a github.com/…/pull/123 URL. */
export function parseTarget(query: string): { owner: string; name: string; number: number } | null {
  const q = query.trim();
  const ref = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(q);
  if (ref) return { owner: ref[1]!, name: ref[2]!, number: Number(ref[3]) };
  const url = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/.exec(q);
  if (url) return { owner: url[1]!, name: url[2]!, number: Number(url[3]) };
  return null;
}

const FIELD_WEIGHT = { title: 1, headRef: 0.6, author: 0.6, repo: 0.5 } as const;
/** Score of an exact `#n` / `n` hit: above any fuzzy score of a normal title. */
const EXACT_NUMBER = 10_000;

function scoreItem(item: PaletteItem, terms: string[], num: number | null, hash: boolean): Ranked | null {
  let total = 0;
  let positions: number[] = [];
  if (num !== null && item.number === num) total += EXACT_NUMBER;
  else if (num !== null && hash && String(item.number).startsWith(String(num))) total += 50;
  const matchedByNumber = total > 0;
  if (matchedByNumber && terms.length === 1) return { item, positions, score: total };
  const repoName = item.repo.slice(item.repo.indexOf("/") + 1);
  for (const term of terms) {
    let bestScore = -Infinity;
    let bestPos: number[] = [];
    const tryField = (text: string, weight: number, isTitle: boolean) => {
      const m = fuzzyMatch(term, text);
      if (m && m.score * weight > bestScore) {
        bestScore = m.score * weight;
        bestPos = isTitle ? m.positions : [];
      }
    };
    tryField(item.title, FIELD_WEIGHT.title, true);
    tryField(item.headRef, FIELD_WEIGHT.headRef, false);
    tryField(item.author, FIELD_WEIGHT.author, false);
    tryField(repoName, FIELD_WEIGHT.repo, false);
    if (bestScore === -Infinity) return null;
    total += bestScore;
    positions = positions.concat(bestPos);
  }
  return { item, positions: [...new Set(positions)].sort((a, b) => a - b), score: total };
}

/**
 * Rank PRs for a palette query: exact `#n`/number hit first, then fuzzy score over title, headRef, author and
 * repo name (every whitespace-separated term must match), ties broken by newest `updatedAt`. Empty query: newest first.
 */
export function rankPrs(items: PaletteItem[], query: string, limit = Infinity): Ranked[] {
  const q = query.trim();
  const stamp = (i: PaletteItem) => Date.parse(i.updatedAt) || 0;
  const newest = (a: Ranked, b: Ranked) => b.score - a.score || stamp(b.item) - stamp(a.item);
  if (!q) return items.map((item) => ({ item, positions: [], score: 0 })).sort(newest).slice(0, limit);
  const numeric = /^(#)?(\d+)$/.exec(q);
  const num = numeric ? Number(numeric[2]) : null;
  const terms = q.replace(/^#/, "").split(/\s+/).filter(Boolean);
  const out: Ranked[] = [];
  for (const item of items) {
    const r = scoreItem(item, terms, num, !!numeric?.[1]);
    if (r) out.push(r);
  }
  return out.sort(newest).slice(0, limit);
}

/** Merge sources, dropping duplicates by repo+number; the entry with the newest `updatedAt` wins. */
export function dedupeItems(lists: PaletteItem[][]): PaletteItem[] {
  const by = new Map<string, PaletteItem>();
  for (const list of lists)
    for (const it of list) {
      const k = itemKey(it);
      const cur = by.get(k);
      if (!cur || (Date.parse(it.updatedAt) || 0) > (Date.parse(cur.updatedAt) || 0)) by.set(k, it);
    }
  return [...by.values()];
}

/** `now` / `5m` / `3h` / `2d` / `4w` / `7mo` / `2y` since an ISO time; "" for a bad stamp. */
export function ageOf(iso: string, now = Date.now()): string {
  const s = (now - Date.parse(iso)) / 1000;
  if (!(s >= 0)) return "";
  if (s < 60) return "now";
  const t: [number, string][] = [[60, "m"], [3600, "h"], [86400, "d"], [604800, "w"], [2592000, "mo"], [31536000, "y"]];
  for (let i = t.length - 1; i >= 0; i--) if (s >= t[i]![0]) return `${Math.floor(s / t[i]![0])}${t[i]![1]}`;
  return "now";
}

/** Palette row of a loaded PR; `repo` is `owner/name`. */
export function toItem(repo: string, pr: Pick<PaletteItem, "number" | "title" | "headRef" | "author" | "state" | "isDraft" | "updatedAt">): PaletteItem {
  return { repo, number: pr.number, title: pr.title, headRef: pr.headRef, author: pr.author, state: pr.state, isDraft: pr.isDraft, updatedAt: pr.updatedAt };
}
