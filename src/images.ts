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
import { imageInfo, NativeImage } from "@opentui/core";
import { exec, execBytes } from "./exec";
import { Failure, guardedGet, MAX_BYTES, statusReason, TIMEOUT_MS } from "./image-net";
import { createVariantCache } from "./image-variants";
import type { RasterPixelsReply, RasterRequest } from "./raster-worker";
import type { SvgPixelsReply, SvgPngReply, SvgRequest } from "./svg-worker";

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
  /** The SVG source, for re-rasterising at the size it is drawn at (`data` is a size-independent fallback). */
  svg?: string;
}

const looksSvg = (b: Uint8Array): boolean => /<svg[\s>]/i.test(new TextDecoder().decode(b.subarray(0, 4096)));

const WORKER_DEADLINE_MS = 15_000;

/**
 * A worker that takes one job at a time from a queue. Past the deadline one stuck job would block everything behind it, so the worker is
 * killed, every waiting job fails, and a fresh worker starts on the next job. Jobs wait for the worker's `{ ready: true }`.
 */
function createJobWorker<Req extends { id: number }, Rep extends { id: number }>(file: string) {
  let worker: Worker | null = null;
  let ready = false;
  let nextId = 1;
  const waiting: Req[] = [];
  const pending = new Map<number, { ok: (r: Rep) => void; fail: (e: Failure) => void }>();

  const reset = (reason: string) => {
    worker?.terminate();
    worker = null;
    ready = false;
    waiting.length = 0;
    for (const p of pending.values()) p.fail(new Failure(reason));
    pending.clear();
  };
  const start = (): Worker => {
    if (worker) return worker;
    const w = new Worker(new URL(file, import.meta.url).href);
    w.onmessage = ({ data }: MessageEvent<Rep | { ready: true }>) => {
      if ("ready" in data) {
        ready = true;
        for (const r of waiting.splice(0)) w.postMessage(r);
        return;
      }
      const p = pending.get(data.id);
      pending.delete(data.id);
      if (!p) return;
      if ("error" in data) p.fail(new Failure("unsupported"));
      else p.ok(data);
    };
    w.onerror = () => reset("unsupported");
    worker = w;
    return w;
  };

  return {
    run(req: Omit<Req, "id">): Promise<Rep> {
      const { promise, resolve, reject } = Promise.withResolvers<Rep>();
      const job = { ...req, id: nextId++ } as Req;
      const timer = setTimeout(() => reset("timeout"), WORKER_DEADLINE_MS);
      pending.set(job.id, { ok: resolve, fail: reject });
      const w = start();
      if (ready) w.postMessage(job);
      else waiting.push(job);
      return promise.finally(() => clearTimeout(timer));
    },
  };
}

const svgWorker = createJobWorker<SvgRequest, SvgPngReply | SvgPixelsReply>("./svg-worker.ts");
const rasterWorker = createJobWorker<RasterRequest, RasterPixelsReply>("./raster-worker.ts");

/** A size-independent 1.2k-2.4k px wide PNG of an SVG. */
async function rasterize(svg: string): Promise<Decoded> {
  const r = await svgWorker.run({ svg });
  if (!("png" in r)) throw new Failure("unsupported");
  return { data: r.png, width: r.width, height: r.height };
}

async function decodeBytes(bytes: Uint8Array): Promise<Decoded> {
  if (looksSvg(bytes)) {
    const svg = new TextDecoder().decode(bytes);
    return { ...(await rasterize(svg)), svg };
  }
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
  /** `src` rendered at exactly `w`x`h` px (SVGs re-rasterised, big rasters downscaled once), prepared off the render path: undefined while that is being made, when the base image already fits, or when the cache is full of renderings in use. Asks for it the first time and notifies subscribers when done. */
  variant(src: string, w: number, h: number): NativeImage | undefined;
  /** Keeps that rendering cached until released: pin what is on screen, so visible images never evict each other. */
  pinVariant(src: string, w: number, h: number): () => void;
  subscribe(fn: () => void): () => void;
  version(): number;
}

const variantKey = (src: string, w: number, h: number) => `${src}\0${w}x${h}`;

/**
 * Bounded cache. Entries are kept by recency of use, so what the page is showing is what stays. A URL that was evicted and is asked
 * for again is re-fetched, but at most `maxFetches` times a session: past that it stays an error, so a page showing more images than the
 * cache holds cannot loop downloading.
 */
export function createImageStore(
  load: (src: string) => Promise<ImageState>,
  o: { maxEntries?: number; concurrency?: number; maxFetches?: number; maxVariants?: number; makeVariant?: (d: Decoded, w: number, h: number) => Promise<NativeImage | null> } = {},
): ImageStore {
  const { maxEntries = 64, concurrency = 3, maxFetches = 3, maxVariants = 24, makeVariant } = o;
  const states = new Map<string, ImageState>();
  const fetches = new Map<string, number>();
  const variants = createVariantCache<NativeImage>({
    max: maxVariants,
    notify: () => {
      version++;
      for (const l of listeners) l();
    },
  });
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
    variant(src, w, h) {
      const st = states.get(src);
      if (st?.status !== "ready" || !makeVariant) return undefined;
      return variants.get(variantKey(src, w, h), src, () => makeVariant(st, w, h));
    },
    pinVariant: (src, w, h) => variants.pin(variantKey(src, w, h)),
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

/** Cell-box sized pixels of `d`, prepared off the UI thread: SVGs are rasterised at exactly that width, rasters downscaled once (never upscaled). null: the base image is already right. */
async function makeVariant(d: Decoded, w: number, h: number): Promise<NativeImage | null> {
  if (d.svg !== undefined) {
    const r = await svgWorker.run({ svg: d.svg, targetWidth: w });
    if (!("pixels" in r)) return null;
    return NativeImage.fromRgba(r.pixels, r.pxWidth, r.pxHeight);
  }
  if (w >= d.width && h >= d.height) return null;
  const r = await rasterWorker.run({ data: d.data, width: Math.min(w, d.width), height: Math.min(h, d.height) });
  return NativeImage.fromRgba(r.pixels, r.pxWidth, r.pxHeight);
}

const store = createImageStore(loadReal, { makeVariant });
export const imageState = store.peek;
export const requestImage = store.request;
export const imageVariant = store.variant;
export const pinImageVariant = store.pinVariant;
export const subscribeImages = store.subscribe;
export const imagesVersion = store.version;
