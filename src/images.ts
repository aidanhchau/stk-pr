/**
 * Images in PR bodies and comments: resolve a URL to bytes through `gh` (private repos), decode to something the terminal can draw, cache.
 * No TUI imports; the view reads `imageState` / `requestImage` and re-renders on `subscribeImages`.
 *
 *   github.com/<o>/<r>/blob|raw/<ref>/<path>, raw.githubusercontent.com/...  -> `gh api --hostname H repos/<o>/<r>/contents/<path>?ref=<ref>`
 *   github.com/user-attachments/assets/<id>, github.com/<o>/<r>/assets/...    -> GET with the `gh auth token` bearer on the first hop only
 *   anything else                                                              -> anonymous GET
 * Only https is ever fetched. Credentials are used only for github.com and the GitHub host of the PR on screen (`setPrHost`); a lookalike
 * such as github.attacker.example is just another anonymous URL. SVGs are rasterised in a worker (svg-worker.ts); PNG/JPEG/WebP/GIF pass through.
 */
import { imageInfo } from "@opentui/core";
import { exec, execBytes } from "./exec";
import { Failure, guardedGet, MAX_BYTES, statusReason, TIMEOUT_MS } from "./image-net";
import type { SvgReply, SvgRequest } from "./svg-worker";

export type Source =
  | { kind: "contents"; host: string; owner: string; repo: string; /** Ref/path splits, shortest ref first (branch names may hold slashes). */ candidates: { ref: string; path: string }[] }
  | { kind: "attachment"; host: string; url: string }
  | { kind: "url"; url: string };

/** Hosts whose URLs get the user's GitHub credentials: github.com and the GitHub host of the PR being viewed. */
export const isTrustedHost = (host: string, prHost: string | null | undefined): boolean => host === "github.com" || (!!prHost && host === prHost.toLowerCase());

const SHA_RE = /^[0-9a-f]{7,40}$/i;

function splits(rest: string[]): { ref: string; path: string }[] {
  const names = rest[0] === "refs" && (rest[1] === "heads" || rest[1] === "tags") ? rest.slice(2) : rest;
  const max = SHA_RE.test(names[0] ?? "") ? 1 : 3;
  const out: { ref: string; path: string }[] = [];
  for (let k = 1; k <= Math.min(max, names.length - 1); k++) out.push({ ref: names.slice(0, k).join("/"), path: names.slice(k).join("/") });
  return out;
}

const decode = (s: string): string => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Where an https image URL's bytes come from; null for anything else (http included: nothing is fetched or authenticated in clear text). */
export function resolveSource(raw: string, prHost?: string | null): Source | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean).map(decode);
  if (host === "raw.githubusercontent.com" && segs.length >= 4) {
    const candidates = splits(segs.slice(2));
    if (candidates.length) return { kind: "contents", host: "github.com", owner: segs[0]!, repo: segs[1]!, candidates };
  }
  if (isTrustedHost(host, prHost)) {
    if (segs[0] === "user-attachments" && segs[1] === "assets") return { kind: "attachment", host, url: u.href };
    if (segs[2] === "assets" && segs.length >= 4) return { kind: "attachment", host, url: u.href };
    if ((segs[2] === "blob" || segs[2] === "raw") && segs.length >= 5) {
      const candidates = splits(segs.slice(3));
      if (candidates.length) return { kind: "contents", host, owner: segs[0]!, repo: segs[1]!, candidates };
    }
  }
  return { kind: "url", url: u.href };
}

// ---------- fetching ----------

let prHost: string | null = null;
/** The GitHub host of the PR on screen (credentials may go there); set by the view. */
export const setPrHost = (host: string | null): void => void (prHost = host?.toLowerCase() ?? null);

const tokens = new Map<string, Promise<string | null>>();
/** `gh auth token` for `host`, held in memory only. */
function ghToken(host: string): Promise<string | null> {
  let t = tokens.get(host);
  if (!t) {
    t = exec(["gh", "auth", "token", "--hostname", host]).then((r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null));
    tokens.set(host, t);
  }
  return t;
}

async function fetchContents(s: Extract<Source, { kind: "contents" }>): Promise<Uint8Array> {
  let last = "404";
  for (const { ref, path } of s.candidates) {
    const endpoint = `repos/${s.owner}/${s.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const argv = ["gh", "api", "--hostname", s.host, "-H", "Accept: application/vnd.github.raw", endpoint];
    const r = await execBytes(argv, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    if (r.overflow) throw new Failure("too large");
    if (r.code === 0) return r.stdout;
    const status = /HTTP (\d{3})/.exec(r.stderr)?.[1];
    if (r.code === 127) throw new Failure("gh not found");
    last = status ? statusReason(Number(status)) : "gh failed";
    if (status !== "404") break;
  }
  throw new Failure(last);
}

async function fetchAttachment(s: Extract<Source, { kind: "attachment" }>): Promise<Uint8Array> {
  const auth = (await ghToken(s.host)) ?? undefined;
  return guardedGet(s.url, { auth, trustFirst: true });
}

// ---------- decoding ----------

export interface Decoded {
  /** PNG/JPEG/WebP/GIF bytes the renderer can decode. */
  data: Uint8Array;
  /** Logical size in pixels: the SVG's own size, or the raster's. Never upscale past it. */
  width: number;
  height: number;
}

const looksSvg = (b: Uint8Array): boolean => /<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 4096)));

const SVG_DEADLINE_MS = 15_000;
let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { ok: (d: Decoded) => void; fail: (e: Failure) => void }>();

/** Fails every queued job and drops the worker (a fresh one starts on the next SVG). */
function resetWorker(reason: string) {
  worker?.terminate();
  worker = null;
  for (const p of pending.values()) p.fail(new Failure(reason));
  pending.clear();
}

function svgWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./svg-worker.ts", import.meta.url).href);
  w.onmessage = ({ data }: MessageEvent<SvgReply>) => {
    const p = pending.get(data.id);
    pending.delete(data.id);
    if (!p) return;
    if ("error" in data) p.fail(new Failure("unsupported"));
    else p.ok({ data: data.png, width: data.width, height: data.height });
  };
  w.onerror = () => resetWorker("unsupported");
  worker = w;
  return w;
}

function rasterize(svg: string): Promise<Decoded> {
  const { promise, resolve, reject } = Promise.withResolvers<Decoded>();
  const id = nextId++;
  // one stuck render would block the worker's queue: past the deadline, kill the worker and fail everything waiting on it
  const timer = setTimeout(() => resetWorker("timeout"), SVG_DEADLINE_MS);
  pending.set(id, { ok: resolve, fail: reject });
  svgWorker().postMessage({ id, svg } satisfies SvgRequest);
  return promise.finally(() => clearTimeout(timer));
}

async function decodeBytes(bytes: Uint8Array): Promise<Decoded> {
  if (looksSvg(bytes)) return rasterize(new TextDecoder().decode(bytes));
  try {
    const info = imageInfo(bytes);
    return { data: bytes, width: info.width, height: info.height };
  } catch {
    throw new Failure("unsupported");
  }
}

// ---------- state ----------

export type ImageState = { status: "loading" } | { status: "error"; reason: string } | ({ status: "ready" } & Decoded);

export interface ImageStore {
  /** The state of `src` if it was ever requested (and not evicted); never starts a load. */
  peek(src: string): ImageState | undefined;
  /** Like `peek`, but starts the load the first time. */
  request(src: string): ImageState;
  subscribe(fn: () => void): () => void;
  version(): number;
}

/**
 * Bounded cache. Entries are kept by recency of use, so what the page is showing is what stays. A URL that was evicted and is asked
 * for again is re-fetched, but at most `maxFetches` times a session: past that it stays an error, so a page showing more images than the
 * cache holds cannot loop downloading.
 */
export function createImageStore(load: (src: string) => Promise<ImageState>, o: { maxEntries?: number; concurrency?: number; maxFetches?: number } = {}): ImageStore {
  const { maxEntries = 64, concurrency = 3, maxFetches = 3 } = o;
  const states = new Map<string, ImageState>();
  const fetches = new Map<string, number>();
  const listeners = new Set<() => void>();
  const queue: (() => void)[] = [];
  let running = 0;
  let version = 0;

  const touch = (src: string, st: ImageState) => {
    states.delete(src);
    states.set(src, st);
  };
  const evict = () => {
    for (const [k, v] of states) {
      if (states.size <= maxEntries) break;
      if (v.status !== "loading") states.delete(k);
    }
  };
  const pump = () => {
    while (running < concurrency && queue.length) {
      running++;
      queue.shift()!();
    }
  };

  return {
    peek(src) {
      const hit = states.get(src);
      if (hit) touch(src, hit);
      return hit;
    },
    request(src) {
      const hit = states.get(src);
      if (hit) {
        touch(src, hit);
        return hit;
      }
      const n = fetches.get(src) ?? 0;
      if (n >= maxFetches) {
        const st: ImageState = { status: "error", reason: "too many images" };
        touch(src, st);
        return st;
      }
      fetches.delete(src);
      fetches.set(src, n + 1);
      if (fetches.size > 4096) fetches.delete(fetches.keys().next().value!);
      const loading: ImageState = { status: "loading" };
      touch(src, loading);
      queue.push(
        () =>
          void load(src).then((st) => {
            running--;
            touch(src, st);
            evict();
            version++;
            for (const l of listeners) l();
            pump();
          }),
      );
      pump();
      return loading;
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    version: () => version,
  };
}

async function loadReal(src: string): Promise<ImageState> {
  try {
    const source = resolveSource(src, prHost);
    if (!source) return { status: "error", reason: "unsupported" };
    const bytes = source.kind === "contents" ? await fetchContents(source) : source.kind === "attachment" ? await fetchAttachment(source) : await guardedGet(source.url);
    return { status: "ready", ...(await decodeBytes(bytes)) };
  } catch (e) {
    if (e instanceof Failure) return { status: "error", reason: e.message };
    const name = e instanceof Error ? e.name : "";
    return { status: "error", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}

const store = createImageStore(loadReal);
export const imageState = store.peek;
export const requestImage = store.request;
export const subscribeImages = store.subscribe;
export const imagesVersion = store.version;
