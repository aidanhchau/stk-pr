/**
 * Pure comment-body cleaner/layout for bot and human GitHub comments (no TUI imports).
 *
 *   parseComment(body) -> { title, badge, blocks }   strip HTML/comments/badges/footers, structure markdown
 *   layoutBlocks(blocks, width, opts) -> Span[][]    wrapped lines ([] = blank line)
 *
 * Supported: headings, **bold**, `code`, [text](url) -> text, fenced code, dash, star and numbered bullets (hanging indent),
 * <details><summary> -> foldable block, tables -> aligned columns, `![P1 Badge](..)` -> P1 pill, an image standing alone on its line -> image block
 * (badges, bot buttons and images inline in prose are dropped).
 */

/** `author` / `rail`: a human's name and conversation rail, coloured per person by the view. */
export type SpanStyle = "plain" | "bold" | "subhead" | "code" | "pill" | "muted" | "add" | "del" | "warn" | "link" | "author" | "rail" | "image";
export interface Span {
  text: string;
  style: SpanStyle;
  /** `style: "image"` only: the first row of a drawn image (`rows` tall, `cols` wide). Its following rows hold fill spans without this field. */
  image?: { src: string; cols: number; rows: number };
}

export type Block =
  | { t: "p"; spans: Span[]; indent: number; bullet: string | null; heading: boolean; level?: number }
  | { t: "code"; text: string; diff?: boolean }
  | { t: "suggestion"; lines: string[] }
  | { t: "table"; rows: string[][] }
  | { t: "details"; summary: Span[]; body: Block[] }
  | { t: "image"; src: string; alt: string }
  | { t: "blank" };

export interface Comment {
  /** First meaningful line, plain text; includes a trailing ` · High Severity` style qualifier when present. */
  title: string;
  /** Priority badge text such as `P1`, if the title carried a badge image. */
  badge: string | null;
  blocks: Block[];
}

const PILL_OPEN = "\uE000";
const PILL_CLOSE = "\uE001";
const SUM_OPEN = "\uE002";
const SUM_CLOSE = "\uE003";
const DET_END = "\uE004";
const FENCE_OPEN = "\uE010";
const FENCE_CLOSE = "\uE011";
/** Prefixes a stashed fence body that came from a ```suggestion block. */
const SUGGEST = "\uE012";
const DIFF = "\uE013";
/** Wraps the index of a stashed standalone image (`IMAGES`) in the text. */
const IMG_OPEN = "\uE020";
const IMG_CLOSE = "\uE021";
const IMG_RE = new RegExp(`${IMG_OPEN}(\\d+)${IMG_CLOSE}`, "g");

/** An image kept by `preprocess`: an http(s) source that is content, not a badge or button. */
interface ImageRef {
  src: string;
  alt: string;
}

const FENCE_RE = /^[ \t]*(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)^[ \t]*\1[ \t]*$/gm;
const TAGS = "sub|sup|div|p|br|hr|span|picture|source|img|a|b|i|strong|em|u|ul|ol|li|blockquote|h[1-6]|table|thead|tbody|tr|td|th|details|summary|kbd|center";

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };

function stripTags(s: string): string {
  return s
    .replace(new RegExp(`</?(?:${TAGS})\\b[^>]*>`, "gi"), "")
    .replace(/&(nbsp|amp|lt|gt|quot|#39);/g, (_, e: string) => ENTITIES[e]!);
}

/** Boilerplate lines bots append; matched against a raw (pre-inline) line. */
const FOOTER_RES = [
  /^\s*Useful\? React with/i,
  /Was this helpful\?\s*React with/i,
  /^\s*Sent by Cursor Automation/i,
  /^\s*Reviewed by \[?Cursor Bugbot/i,
  /cursor\.com\/dashboard\/bugbot/i,
];
const BUTTON_TEXT = /^(Fix in|Open in|View Automation|View in|Devin Review|Review in)/i;

function isFooter(line: string): boolean {
  if (FOOTER_RES.some((r) => r.test(line))) return true;
  const t = line.replace(/&nbsp;|\u00a0/g, " ").trim();
  if (!t) return false;
  const links = [...t.matchAll(/\[([^\]]*)\]\([^)]*\)/g)];
  if (links.length && t.replace(/\[([^\]]*)\]\([^)]*\)/g, "").trim() === "" && links.every((l) => BUTTON_TEXT.test(l[1]!.trim()))) return true;
  return BUTTON_TEXT.test(t) && t.length < 30 && /[↗⬈]|\bin web\b|\bautomation\b/i.test(t);
}

/** A unified diff: a `diff --git` header, or a hunk header followed by +/- lines. */
export function looksLikeDiff(body: string): boolean {
  const lines = body.split("\n");
  if (lines.some((l) => l.startsWith("diff --git "))) return true;
  const at = lines.findIndex((l) => /^@@ .* @@/.test(l));
  return at >= 0 && lines.slice(at + 1).some((l) => /^[+-]/.test(l));
}

const BADGE_HOSTS = /(?:^|\.)(?:shields\.io|badgen\.net|badge\.fury\.io|codecov\.io|coveralls\.io|static\.devin\.ai|pr-comments-assets\.blacksmith\.sh|vercel\.com|netlify\.com|snyk\.io)$/i;

/** Badges and bot buttons: images that are chrome, not content. They are dropped wherever they sit. */
function isChrome(src: string, alt: string, height: number | null): boolean {
  if (BUTTON_TEXT.test(alt.trim()) || (height !== null && height <= 48)) return true;
  try {
    const u = new URL(src);
    return BADGE_HOSTS.test(u.hostname) || (u.hostname === "cursor.com" && u.pathname.startsWith("/assets/")) || /\/badge(?:\.svg|\/|$)/i.test(u.pathname);
  } catch {
    return true;
  }
}

const attr = (tag: string, name: string): string | null => {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").replace(/&amp;/g, "&") : null;
};

/** Raw markdown/HTML -> normalized markdown lines with markers for fences, details, pills and images. */
function preprocess(src: string): { text: string; fences: string[]; images: ImageRef[] } {
  let s = src.replace(/\r/g, "").replace(/\t/g, "  ");
  const fences: string[] = [];
  const images: ImageRef[] = [];
  const stash = (body: string, info = "") => {
    const lang = info.replace(/^[`~]+/, "").trim();
    const mark = /^suggestion\b/i.test(lang) ? SUGGEST : /^(?:diff|patch)\b/i.test(lang) || looksLikeDiff(body) ? DIFF : "";
    return `\n${FENCE_OPEN}${fences.push(mark + body.replace(/\n$/, "")) - 1}${FENCE_CLOSE}\n`;
  };
  s = s.replace(FENCE_RE, (_m, _f, info: string, body: string) => stash(body, info));
  // unterminated fence: the rest is code
  s = s.replace(/^[ \t]*(?:`{3,}|~{3,})([^\n]*)\n([\s\S]*)$/m, (_m, info: string, body: string) => stash(body, info));
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<!--[\s\S]*$/, "");
  /** Content images become a marker; whether it stands alone is decided per line in `parseLines`. Only http(s) sources survive. */
  const keep = (src: string | null, alt: string, height: number | null): string => {
    if (!src || !/^https?:\/\//i.test(src) || isChrome(src, alt, height)) return "";
    return `${IMG_OPEN}${images.push({ src, alt: alt.trim() }) - 1}${IMG_CLOSE}`;
  };
  s = s.replace(/\[(!\[[^\]]*\]\([^)]*\))\]\([^)]*\)/g, "$1"); // [![alt](img)](href): the image alone
  s = s.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt: string, dest: string) => {
    const b = /^(P\d)\b/.exec(alt.trim());
    if (b) return `${PILL_OPEN}${b[1]}${PILL_CLOSE}`;
    return keep(/^\s*<?([^\s>]*)/.exec(dest)?.[1] || null, alt, null);
  });
  // <a> wrapping only pictures/images, a bare <picture>, a bare <img>
  s = s.replace(/<a\b[^>]*>(?:\s|&nbsp;|<picture[\s\S]*?<\/picture>|<img\b[^>]*>)*<\/a>|<picture[\s\S]*?<\/picture>|<img\b[^>]*>/gi, (m) => {
    const tags = [...m.matchAll(/<img\b[^>]*>/gi)].map((t) => t[0]);
    return tags.map((t) => keep(attr(t, "src"), attr(t, "alt") ?? "", Number(attr(t, "height")) || null)).join(" ");
  });
  // innermost <details> first, repeatedly
  const det = /<details\b[^>]*>((?:(?!<details\b)[\s\S])*?)<\/details>/i;
  for (let guard = 0; guard < 50 && det.test(s); guard++) {
    s = s.replace(det, (_m, inner: string) => {
      const sm = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(inner);
      const rest = sm ? inner.replace(sm[0], "") : inner;
      const summary = stripTags(sm ? sm[1]! : "Details").replace(IMG_RE, "").replace(/\s+/g, " ").trim() || "Details";
      return `\n${SUM_OPEN}${summary}${SUM_CLOSE}\n${rest}\n${DET_END}\n`;
    });
  }
  s = s
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|blockquote|h[1-6]|tr|ul|ol|table)>/gi, "\n")
    .replace(/<hr\s*\/?>/gi, "\n---\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<\/?(?:b|strong)\b[^>]*>/gi, "**")
    .replace(/<\/?code\b[^>]*>/gi, "`");
  return { text: stripTags(s), fences, images };
}

// ---------- inline ----------

const INLINE_RE = new RegExp(
  [
    `${PILL_OPEN}([^${PILL_CLOSE}]*)${PILL_CLOSE}`, // 1 pill
    "(`+)([^`]+?)\\2", // 2,3 code
    "\\*\\*([\\s\\S]+?)\\*\\*", // 4 bold
    "__([^_]+?)__", // 5 bold
    "\\[([^\\]]*)\\]\\(((?:[^()\\s]|\\([^)]*\\))*)(?:\\s+\"[^\"]*\")?\\)", // 6,7 link
    "(?<![\\w*])\\*([^*\\s](?:[^*]*[^*\\s])?)\\*(?![\\w*])", // 8 em
  ].join("|"),
  "g",
);

function push(out: Span[], text: string, style: SpanStyle) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.style === style && style !== "pill") last.text += text;
  else out.push({ text, style });
}

function inline(text: string, base: SpanStyle = "plain", out: Span[] = []): Span[] {
  let at = 0;
  const re = new RegExp(INLINE_RE.source, "g"); // recursion below needs its own lastIndex
  for (let m: RegExpExecArray | null; (m = re.exec(text)); ) {
    push(out, text.slice(at, m.index), base);
    at = m.index + m[0].length;
    if (m[1] !== undefined) push(out, m[1], "pill");
    else if (m[3] !== undefined) push(out, m[3], "code");
    else if (m[4] !== undefined || m[5] !== undefined) inline(m[4] ?? m[5]!, "bold", out);
    else if (m[6] !== undefined) inline(m[6], base === "plain" ? "link" : base, out);
    else if (m[8] !== undefined) inline(m[8], base, out);
  }
  push(out, text.slice(at), base);
  return out;
}

/** Collapse whitespace runs; trim the span list's edges. */
function tidy(spans: Span[]): Span[] {
  const out: Span[] = [];
  for (const s of spans) {
    const text = s.text.replace(/[ \u00a0]+/g, " ");
    if (text) out.push({ ...s, text });
  }
  while (out.length && out[0]!.style !== "pill") {
    out[0]!.text = out[0]!.text.trimStart();
    if (out[0]!.text) break;
    out.shift();
  }
  while (out.length) {
    const l = out[out.length - 1]!;
    l.text = l.text.trimEnd();
    if (l.text) break;
    out.pop();
  }
  return out;
}

export const plain = (spans: Span[]): string => spans.map((s) => s.text).join("");

// ---------- blocks ----------

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parseLines(lines: string[], fences: string[], images: ImageRef[]): Block[] {
  const blocks: Block[] = [];
  const blank = () => {
    if (blocks.length && blocks[blocks.length - 1]!.t !== "blank") blocks.push({ t: "blank" });
  };
  let i = 0;
  const stack: { summary: Span[]; body: Block[] }[] = [];
  const cur = (): Block[] => (stack.length ? stack[stack.length - 1]!.body : blocks);
  const add = (b: Block) => {
    const t = cur();
    if (b.t === "blank" && (!t.length || t[t.length - 1]!.t === "blank")) return;
    t.push(b);
  };
  while (i < lines.length) {
    const raw = lines[i]!;
    i++;
    if (raw.startsWith(SUM_OPEN)) {
      stack.push({ summary: tidy(inline(raw.slice(1, raw.indexOf(SUM_CLOSE)))), body: [] });
      continue;
    }
    if (raw.trim() === DET_END) {
      const d = stack.pop();
      if (d) {
        while (d.body.length && d.body[d.body.length - 1]!.t === "blank") d.body.pop();
        add({ t: "details", summary: d.summary, body: d.body });
      }
      continue;
    }
    const f = /^\uE010(\d+)\uE011$/.exec(raw.trim());
    if (f) {
      const body = fences[Number(f[1])]!;
      if (body.startsWith(SUGGEST)) {
        const s = body.slice(SUGGEST.length);
        add({ t: "suggestion", lines: s === "" ? [] : s.split("\n") });
      } else if (body.startsWith(DIFF)) {
        for (const l of body.slice(DIFF.length).split("\n")) add({ t: "code", text: l, diff: true });
      } else for (const l of body.split("\n")) add({ t: "code", text: l });
      continue;
    }
    if (isFooter(raw)) continue;
    let line = raw.replace(/^\s*(?:>\s?)+/, "");
    if (/^\s*\[!(?:NOTE|TIP|WARNING|IMPORTANT|CAUTION)\]\s*$/i.test(line)) continue;
    if (!line.trim()) {
      add({ t: "blank" });
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      add({ t: "blank" });
      continue;
    }
    if (line.includes(IMG_OPEN)) {
      const refs = [...line.matchAll(IMG_RE)].map((m) => images[Number(m[1])]!);
      line = line.replace(IMG_RE, "");
      // an image on a line of its own is content; in prose, a table or a heading it is dropped
      if (!line.trim()) {
        for (const r of refs) add({ t: "image", ...r });
        continue;
      }
    }
    // table: consecutive |...| rows
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[][] = [];
      i--;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!.replace(/^\s*(?:>\s?)+/, ""))) {
        const cells = lines[i]!.replace(/^\s*(?:>\s?)+/, "").replace(IMG_RE, "").trim().slice(1, -1).split("|").map((c) => plain(tidy(inline(c))));
        i++;
        if (cells.every((c) => /^:?-{2,}:?$/.test(c) || c === "")) continue;
        rows.push(cells);
      }
      if (rows.length) add({ t: "table", rows });
      continue;
    }
    const h = /^\s*(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      add({ t: "blank" });
      add({ t: "p", spans: tidy(inline(h[2]!, level <= 2 ? "bold" : "subhead")), indent: 0, bullet: null, heading: true, level });
      continue;
    }
    const b = BULLET.exec(line);
    if (b) {
      const indent = Math.min(8, Math.floor(b[1]!.length / 2) * 2);
      const mark = /^\d/.test(b[2]!) ? b[2]! : "•";
      add({ t: "p", spans: fixedItem(tidy(inline(b[3]!))), indent, bullet: mark, heading: false });
      continue;
    }
    line = line.trim();
    const spans = tidy(inline(line));
    if (!spans.length) continue;
    add({ t: "p", spans, indent: 0, bullet: null, heading: false });
  }
  while (stack.length) {
    const d = stack.pop()!;
    add({ t: "details", summary: d.summary, body: d.body });
  }
  while (blocks.length && blocks[blocks.length - 1]!.t === "blank") blocks.pop();
  while (blocks.length && blocks[0]!.t === "blank") blocks.shift();
  return blocks;
}

/** Bugbot Autofix `✅ Fixed: ...` items: a green check, muted text. */
function fixedItem(spans: Span[]): Span[] {
  const first = spans[0];
  if (!first || !/^✅\s*/.test(first.text)) return spans;
  const rest = first.text.replace(/^✅\s*/, "");
  return [{ text: "✓ ", style: "add" }, ...(rest ? [{ text: rest, style: "muted" as const }] : []), ...spans.slice(1).map((x): Span => (x.style === "plain" ? { ...x, style: "muted" } : x))];
}

/** Lines that are a bold lead-in on their own (`**High Severity**`) stay separate paragraphs. */
function isStandalone(b: { spans: Span[] }): boolean {
  return b.spans.length > 0 && b.spans.every((s) => s.style === "bold" || s.style === "pill");
}

const cache = new Map<string, Comment>();

/** Parsed comments are immutable; bodies repeat across renders, so memoize (bounded). */
export function parseComment(body: string): Comment {
  const hit = cache.get(body);
  if (hit) return hit;
  const c = parseUncached(body);
  if (cache.size > 400) cache.clear();
  cache.set(body, c);
  return c;
}

/** Bot output that carries no information: superseded runs, quota notices, empty review wrappers. */
export const isNoise = (c: Comment): boolean =>
  /^(Stale( Bugbot)? comment|Newer findings are available|You have reached your Codex usage limits|💡 Codex Review$)/i.test(c.title);

function parseUncached(body: string): Comment {
  const { text, fences, images } = preprocess(body);
  const blocks = parseLines(text.split("\n"), fences, images);
  const idx = blocks.findIndex((b) => b.t === "p" || b.t === "details");
  let title = "";
  let badge: string | null = null;
  const first = blocks[idx];
  if (first?.t === "p") {
    const pill = first.spans.find((s) => s.style === "pill");
    badge = pill?.text ?? null;
    title = plain(first.spans.filter((s) => s.style !== "pill")).trim();
    const next = blocks[idx + 1];
    const after = next?.t === "blank" ? blocks[idx + 2] : next;
    if (first.heading && after?.t === "p" && isStandalone(after) && plain(after.spans).length <= 24 && /severity|risk|priority/i.test(plain(after.spans))) {
      title += ` · ${plain(after.spans).trim()}`;
    }
  } else if (first?.t === "details") {
    title = plain(first.summary);
  } else if (blocks[0]?.t === "image") {
    title = `▣ ${blocks[0].alt || "image"}`;
  }
  return { title, badge, blocks };
}

/**
 * Blocks minus the leading title: a heading or bold-only first paragraph (plus a following `**High Severity**` line), which a row already shows as its title.
 * A plain first paragraph is the comment itself and stays.
 */
export function withoutTitle(blocks: Block[]): Block[] {
  const idx = blocks.findIndex((b) => b.t === "p" || b.t === "details");
  const first = blocks[idx];
  if (first?.t !== "p") return blocks;
  const emojiLead = first.spans.some((s) => s.style === "bold") && first.spans.every((s) => s.style === "bold" || /^[\s\p{Extended_Pictographic}\uFE0F]*$/u.test(s.text));
  if (!(first.heading || emojiLead || isStandalone(first))) return blocks;
  let end = idx + 1;
  const after = blocks[blocks[end]?.t === "blank" ? end + 1 : end];
  if (first.heading && after?.t === "p" && isStandalone(after) && plain(after.spans).length <= 24 && /severity|risk|priority/i.test(plain(after.spans))) end = blocks.indexOf(after) + 1;
  while (blocks[end]?.t === "blank") end++;
  return [...blocks.slice(0, idx), ...blocks.slice(end)];
}

/** One-line preview: `P1 · Title` (cleaned first meaningful line). */
export function preview(c: Comment): string {
  return [c.badge, c.title].filter(Boolean).join(" · ");
}

// ---------- layout ----------

const width = (s: string): number => (typeof Bun !== "undefined" ? Bun.stringWidth(s) : s.length);

function words(spans: Span[]): { text: string; style: SpanStyle; space: boolean }[] {
  const out: { text: string; style: SpanStyle; space: boolean }[] = [];
  let space = false;
  for (const s of spans) {
    if (s.style === "pill") {
      // pills are atomic
      out.push({ text: s.style === "pill" ? ` ${s.text} ` : s.text, style: s.style, space: space || /^\s/.test(s.text) });
      space = false;
      continue;
    }
    for (const part of s.text.split(/( +)/)) {
      if (part === "") continue;
      if (part[0] === " ") space = true;
      else {
        out.push({ text: part, style: s.style, space });
        space = false;
      }
    }
  }
  return out;
}

/** Greedy wrap of styled spans; continuation lines are prefixed with `hang` spaces, the first with `first` (text or styled spans). */
export function wrapSpans(spans: Span[], w: number, first: string | Span[] = "", hang = ""): Span[][] {
  const lines: Span[][] = [];
  const lead: Span[] = typeof first === "string" ? (first ? [{ text: first, style: "plain" }] : []) : first.map((s) => ({ ...s }));
  let line: Span[] = lead;
  let used = width(plain(lead));
  let fresh = true;
  const flush = () => {
    lines.push(line);
    line = hang ? [{ text: hang, style: "plain" }] : [];
    used = width(hang);
    fresh = true;
  };
  const add = (text: string, style: SpanStyle, space: boolean) => {
    const sep = !fresh && space ? " " : "";
    const last = line[line.length - 1];
    if (sep) {
      if (last && last.style === style && style !== "pill") last.text += sep;
      else line.push({ text: sep, style: "plain" });
    }
    const l2 = line[line.length - 1];
    if (l2 && l2.style === style && style !== "pill") l2.text += text;
    else line.push({ text, style });
    used += width(sep) + width(text);
    fresh = false;
  };
  for (const wd of words(spans)) {
    let { text } = wd;
    const gap = !fresh && wd.space ? 1 : 0;
    if (used + gap + width(text) <= w) {
      add(text, wd.style, wd.space);
      continue;
    }
    if (!fresh) flush();
    while (width(text) > Math.max(1, w - used)) {
      const room = Math.max(1, w - used);
      let cut = 0;
      let cw = 0;
      for (const ch of text) {
        if (cw + width(ch) > room) break;
        cw += width(ch);
        cut += ch.length;
      }
      if (cut === 0) cut = text.codePointAt(0)! > 0xffff ? 2 : 1;
      add(text.slice(0, cut), wd.style, false);
      text = text.slice(cut);
      flush();
    }
    if (text) add(text, wd.style, false);
  }
  if (!fresh || !lines.length) lines.push(line);
  return lines;
}

/** Clip styled spans to `n` cells with a trailing ellipsis (never a middle splice). */
export function clipSpans(spans: Span[], n: number): Span[] {
  if (spans.reduce((a, s) => a + width(s.text), 0) <= n) return spans;
  const out: Span[] = [];
  let room = Math.max(1, n - 1);
  for (const s of spans) {
    let text = "";
    for (const ch of s.text) {
      if (width(text) + width(ch) > room) break;
      text += ch;
    }
    if (text) out.push({ ...s, text });
    room -= width(text);
    if (text !== s.text) break;
  }
  out.push({ text: "…", style: "muted" });
  return out;
}

/** Prose measure: paragraphs, headings and lists wrap here even in a wider pane (code and tables use the full width). */
export const PROSE_MEASURE = 84;

export interface LayoutOpts {
  /** Expand `<details>` blocks (otherwise a single `▸ summary` line). */
  details: boolean;
  /** Lines a ```suggestion block replaces (see `suggestionTarget`); omitted when the diff hunk is unavailable. */
  removed?: string[];
  /** Also open `Preview (...)` details that hold a diff; they stay collapsed otherwise (autofix previews are long). */
  previews?: boolean;
  /** Max prose width; defaults to `PROSE_MEASURE`. */
  measure?: number;
  /** Where images are drawn. Without it an image is one muted `▣ alt` line (previews, search text). */
  images?: ImageEnv;
}

/** What the layout needs to know about an image to reserve rows for it; structurally the `ImageState` of `../images`. */
export interface ImageEnv {
  lookup(src: string): { status: "loading" } | { status: "error"; reason: string } | { status: "ready"; width: number; height: number };
  /** Terminal cell size in pixels. */
  cell: { w: number; h: number };
}

export const MAX_IMAGE_ROWS = 30;
export const MAX_IMAGE_COLS = 100;

/** Cells an image of `width`x`height` logical px occupies: at most `maxCols` wide, never upscaled past its own size, `maxRows` tall. */
export function fitImage(width: number, height: number, maxCols: number, cell: { w: number; h: number }, maxRows = MAX_IMAGE_ROWS): { cols: number; rows: number } {
  const heightFor = (cols: number) => Math.max(1, Math.round((cols * cell.w * height) / (width * cell.h)));
  let cols = Math.max(1, Math.min(maxCols, MAX_IMAGE_COLS, Math.floor(width / cell.w)));
  if (heightFor(cols) > maxRows) cols = Math.max(1, Math.floor((maxRows * cell.h * width) / (height * cell.w)));
  return { cols, rows: Math.min(maxRows, heightFor(cols)) };
}

/** The drawn image a layout row starts, with the columns of indent before it; null for any other row. */
export function imageStart(row: Span[]): { image: NonNullable<Span["image"]>; indent: number } | null {
  const at = row.findIndex((s) => s.image);
  return at < 0 ? null : { image: row[at]!.image!, indent: row.slice(0, at).reduce((n, s) => n + width(s.text), 0) };
}

/** Rows below an image's first row that the image covers. */
export const isImageFill = (row: Span[]): boolean => row.some((s) => s.style === "image" && !s.image);

/** Layout rows grouped into display lines: a drawn image and its fill rows count as one line (for caps and `N lines`). */
export function lineUnits(rows: Span[][]): Span[][][] {
  const out: Span[][][] = [];
  for (const r of rows) {
    if (isImageFill(r) && out.length) out[out.length - 1]!.push(r);
    else out.push([r]);
  }
  return out;
}

function codeLines(text: string, w: number, diff = false): Span[][] {
  const out: Span[][] = [];
  const t = text.replace(/\s+$/, "");
  if (!t) return [[]];
  const body = t.trimStart();
  const style: SpanStyle = !diff ? "code" : /^(?:\+\+\+|---|diff --git|index )/.test(body) ? "muted" : body.startsWith("+") ? "add" : body.startsWith("-") ? "del" : body.startsWith("@@") ? "muted" : "code";
  for (let at = 0; at < t.length; at += Math.max(1, w)) out.push([{ text: t.slice(at, at + Math.max(1, w)), style }]);
  return out;
}

export function layoutBlocks(blocks: Block[], w: number, opts: LayoutOpts): Span[][] {
  const out: Span[][] = [];
  const blank = () => {
    if (out.length && out[out.length - 1]!.length) out.push([]);
  };
  w = Math.max(8, w);
  const pw = Math.max(8, Math.min(w, opts.measure ?? PROSE_MEASURE));
  /** "list" | "para" | "head" for the previous prose block; drives the blank lines between kinds. */
  let prev: "list" | "para" | "head" | null = null;
  let afterTopHead = false;
  for (const b of blocks) {
    if (b.t === "blank") {
      blank();
      continue;
    }
    if (afterTopHead) blank();
    afterTopHead = false;
    const kind = b.t === "p" ? (b.heading ? "head" : b.bullet ? "list" : "para") : null;
    if (kind === "head" || (kind && prev && prev !== "head" && kind !== prev)) blank();
    prev = kind;
    switch (b.t) {
      case "p": {
        const pad = " ".repeat(b.indent);
        const first: Span[] = [...(pad ? [{ text: pad, style: "plain" as const }] : []), ...(b.bullet ? [{ text: `${b.bullet} `, style: "muted" as const }] : [])];
        const hang = b.bullet ? `${pad}${" ".repeat(width(b.bullet) + 1)}` : pad;
        out.push(...wrapSpans(b.spans, pw, first, hang));
        if (b.heading && (b.level ?? 1) <= 2) afterTopHead = true;
        break;
      }
      case "code":
        out.push(...codeLines(b.text.replace(/^/, "  "), w, b.diff));
        break;
      case "suggestion": {
        out.push([{ text: "suggested change", style: "muted" }]);
        const rows = (sign: string, lines: string[], style: "del" | "add") => {
          for (const l of lines) {
            const room = Math.max(1, w - 2);
            for (let at = 0, first = true; first || at < l.length; at += room, first = false) out.push([{ text: `${first ? sign : " "} ${l.slice(at, at + room)}`, style }]);
          }
        };
        rows("-", opts.removed ?? [], "del");
        rows("+", b.lines, "add");
        break;
      }
      case "table": {
        const cols = Math.max(...b.rows.map((r) => r.length));
        const ws = Array.from({ length: cols }, (_, c) => Math.max(...b.rows.map((r) => width(r[c] ?? ""))));
        const total = ws.reduce((x, y) => x + y, 0) + 2 * (cols - 1);
        if (total > w) {
          // too wide for aligned columns: one wrapped entry per row, first cell bold
          for (const r of b.rows.slice(b.rows.length > 1 ? 1 : 0)) {
            const spans: Span[] = [{ text: r[0] ?? "", style: "bold" }];
            if (r.length > 1) spans.push({ text: ` ${r.slice(1).join(" · ")}`, style: "plain" });
            out.push(...wrapSpans(spans, w, "", "  "));
          }
          break;
        }
        b.rows.forEach((r, ri) => {
          const text = r.map((c, ci) => c + " ".repeat(ws[ci]! - width(c))).join("  ").trimEnd();
          out.push([{ text, style: ri === 0 && b.rows.length > 1 ? "bold" : "plain" }]);
        });
        break;
      }
      case "image": {
        blank();
        const label = b.alt || "image";
        const meta = opts.images?.lookup(b.src);
        if (opts.images && meta?.status === "ready") {
          const { cols, rows } = fitImage(meta.width, meta.height, w, opts.images.cell);
          out.push([{ text: label, style: "image", image: { src: b.src, cols, rows } }]);
          for (let r = 1; r < rows; r++) out.push([{ text: "", style: "image" }]);
        } else {
          const note = meta?.status === "loading" ? " · loading image" : meta?.status === "error" ? ` · ${meta.reason}` : "";
          out.push(...wrapSpans([{ text: `▣ ${label}${note}`, style: "muted" }], w));
        }
        blank();
        break;
      }
      case "details": {
        const preview = /^Preview\b/i.test(plain(b.summary)) && b.body.some((x) => x.t === "code" && x.diff);
        if (!opts.details || (preview && !opts.previews)) {
          out.push(...wrapSpans([{ text: `▸ ${plain(b.summary)}`, style: "muted" }], w));
        } else {
          out.push(...wrapSpans([{ text: `▾ ${plain(b.summary)}`, style: "muted" }], w));
          for (const l of layoutBlocks(b.body, w - 2, opts)) out.push(l.length ? [{ text: "  ", style: "plain" }, ...l] : l);
        }
        break;
      }
    }
  }
  while (out.length && !out[out.length - 1]!.length) out.pop();
  return out;
}

/** What became of the inline findings a review opened: `1 finding · resolved`, `2 findings · 1 open`, `outdated`. */
export function findingsSpan(f: { total: number; open: number; resolved: number; outdated: number } | undefined): Span | null {
  if (!f || !f.total) return null;
  const n = `${f.total} ${f.total === 1 ? "finding" : "findings"}`;
  if (f.open > 0) return { text: `${n} · ${f.open} open`, style: "del" };
  if (f.outdated === f.total) return { text: "outdated", style: "muted" };
  if (f.outdated > 0) return { text: `${n} · ${f.resolved} resolved, ${f.outdated} outdated`, style: "muted" };
  return { text: `${n} · resolved`, style: "add" };
}

// ---------- names / paths ----------

const BOT_NAMES: Record<string, string> = {
  "chatgpt-codex-connector": "codex",
  "devin-ai-integration": "devin",
  cursor: "bugbot",
  "github-actions": "actions",
  "linear-code": "linear",
};

/** `chatgpt-codex-connector[bot]` -> `codex`; other logins lose a `[bot]` suffix only. */
export function shortAuthor(login: string): string {
  const base = login.replace(/\[bot\]$/, "");
  return BOT_NAMES[base] ?? base;
}

/** `a/b/c/d/file.ts` -> `…/d/file.ts` when longer than `max` cells (keeps at least the last two segments when they fit). */
export function shortPath(path: string, max: number): string {
  if (path.length <= max) return path;
  const parts = path.split("/");
  let out = parts[parts.length - 1]!;
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = `${parts[i]}/${out}`;
    if (next.length + 2 > max) break;
    out = next;
  }
  if (out === path) return path;
  return out.length + 2 <= max ? `…/${out}` : `…${out.slice(-(max - 1))}`;
}

// ---------- fix references + thread trail ----------

const SHA = "[0-9a-f]{7,40}";
const COMMIT_URL_RE = new RegExp(`/commit/(${SHA})\\b`, "i");
const FIX_PHRASE_RE = new RegExp(`\\b(?:fixed|addressed|resolved|handled|done)\\b[^\\n.]{0,24}?\\b(?:in|by|with|via)\\b[\\s\`\\[(]*(?:commit\\s+)?[\\s\`\\[(]*(${SHA})\\b`, "i");

/** A 7-40 hex sha mentioned as the fix in a comment (`fixed in abc1234`, `Addressed in \`abc1234\``, a /commit/<sha> URL), lowercase; null if none. Needs a digit so words like `defaced` don't match. */
export function findFixRef(body: string): string | null {
  for (const re of [FIX_PHRASE_RE, COMMIT_URL_RE]) {
    const m = re.exec(body);
    if (m && /\d/.test(m[1]!)) return m[1]!.toLowerCase();
  }
  return null;
}

interface TrailThread {
  isResolved: boolean;
  isOutdated: boolean;
  resolvedBy: string | null;
  comments: { author: string; mine: boolean; body: string }[];
}

/** The newest fix commit referenced in a thread's replies (the opening comment is the finding, not the fix). */
export function threadFix(th: Pick<TrailThread, "comments">): string | null {
  for (let i = th.comments.length - 1; i > 0; i--) {
    const sha = findFixRef(th.comments[i]!.body);
    if (sha) return sha;
  }
  return null;
}

/** `devin flagged · you replied · resolved by octo-dev` — who raised it, whether the PR author answered, who spoke last, and its state. */
export function threadTrail(th: TrailThread, prAuthor: string): string {
  const first = th.comments[0];
  const parts: string[] = [];
  if (first) parts.push(`${shortAuthor(first.author)} flagged`);
  const reply = th.comments.slice(1).find((c) => c.author === prAuthor);
  if (reply) parts.push(reply.mine ? "you replied" : `${shortAuthor(prAuthor)} replied`);
  const last = th.comments[th.comments.length - 1];
  if (last && th.comments.length > 1 && last.author !== first?.author && last.author !== prAuthor) parts.push(`last ${shortAuthor(last.author)}`);
  parts.push(th.isResolved ? (th.resolvedBy ? `resolved by ${th.resolvedBy}` : "resolved") : "open");
  if (th.isOutdated) parts.push("outdated");
  return parts.join(" · ");
}

/** Lines a suggestion replaces: the last `span` lines of the hunk's new-side (context and added) lines. Empty when there is no hunk. */
export function suggestionTarget(diffHunk: string | null, span: number): string[] {
  if (!diffHunk) return [];
  const side: string[] = [];
  for (const l of diffHunk.replace(/\r/g, "").split("\n")) {
    if (l.startsWith("@@") || l.startsWith("-") || l.startsWith("\\")) continue;
    side.push(l.slice(1));
  }
  return side.slice(-Math.max(1, span));
}
