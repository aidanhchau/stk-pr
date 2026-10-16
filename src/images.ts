/**
 * Images in PR bodies and comments: resolve a URL to bytes through `gh` (private repos), decode to something the terminal can draw, cache.
 * No TUI imports; the view reads `peekImage` and re-renders on `subscribeImages`.
 *
 *   github.com/<o>/<r>/blob|raw/<ref>/<path>, raw.githubusercontent.com/...  -> `gh api repos/<o>/<r>/contents/<path>?ref=<ref>` (raw media type)
 *   github.com/user-attachments/assets/<id>, github.com/<o>/<r>/assets/...    -> GET with the `gh auth token` bearer; the redirect to the signed
 *                                                                                storage URL is followed WITHOUT the token
 *   anything else (https)                                                      -> plain fetch
 * SVGs are rasterised in a worker (see svg-worker.ts); PNG/JPEG/WebP/GIF pass through. Failures are cached like successes.
 */
import { imageInfo } from "@opentui/core";
import { exec, execBytes } from "./exec";
import type { SvgReply, SvgRequest } from "./svg-worker";

export type Source =
  | { kind: "contents"; host: string; owner: string; repo: string; /** Ref/path splits, shortest ref first (branch names may hold slashes). */ candidates: { ref: string; path: string }[] }
  | { kind: "attachment"; host: string; url: string }
  | { kind: "url"; url: string };

/** github.com, `$GH_HOST` and GHES-style hosts; never Pages or the usercontent CDNs. */
function isGithubHost(host: string): boolean {
  if (host === "github.com" || host === process.env.GH_HOST?.toLowerCase()) return true;
  return host.includes("github") && !host.endsWith(".github.io") && !host.includes("githubusercontent");
}

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

/** Where an http(s) image URL's bytes come from; null for anything that is not http(s). */
export function resolveSource(raw: string): Source | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  const host = u.hostname.toLowerCase();
  const segs = u.pathname.split("/").filter(Boolean).map(decode);
  if (host === "raw.githubusercontent.com" && segs.length >= 4) {
    const candidates = splits(segs.slice(2));
    if (candidates.length) return { kind: "contents", host: "github.com", owner: segs[0]!, repo: segs[1]!, candidates };
  }
  if (isGithubHost(host)) {
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

const TIMEOUT_MS = 20_000;
const MAX_BYTES = 25 * 1024 * 1024;

class Failure extends Error {}

const statusReason = (code: number): string => (code === 404 || code === 401 || code === 403 ? String(code === 401 ? 403 : code) : code >= 500 ? "server error" : `HTTP ${code}`);

const tokens = new Map<string, Promise<string | null>>();
/** `gh auth token` for `host`, held in memory only. */
function ghToken(host: string): Promise<string | null> {
  let t = tokens.get(host);
  if (!t) {
    t = exec(["gh", "auth", "token", ...(host === "github.com" ? [] : ["--hostname", host])]).then((r) => (r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null));
    tokens.set(host, t);
  }
  return t;
}

async function readBody(res: Response): Promise<Uint8Array> {
  const len = Number(res.headers.get("content-length") ?? 0);
  if (len > MAX_BYTES) throw new Failure("too large");
  const bytes = await res.bytes();
  if (bytes.length > MAX_BYTES) throw new Failure("too large");
  return bytes;
}

async function plainFetch(url: string, headers?: Record<string, string>): Promise<Uint8Array> {
  const res = await fetch(url, { headers: { accept: "image/*,*/*;q=0.8", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Failure(statusReason(res.status));
  return readBody(res);
}

async function fetchContents(s: Extract<Source, { kind: "contents" }>): Promise<Uint8Array> {
  let last = "404";
  for (const { ref, path } of s.candidates) {
    const endpoint = `repos/${s.owner}/${s.repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`;
    const argv = ["gh", "api", "-H", "Accept: application/vnd.github.raw", ...(s.host === "github.com" ? [] : ["--hostname", s.host]), endpoint];
    const r = await execBytes(argv, TIMEOUT_MS);
    if (r.code === 0) {
      if (r.stdout.length > MAX_BYTES) throw new Failure("too large");
      return r.stdout;
    }
    const status = /HTTP (\d{3})/.exec(r.stderr)?.[1];
    if (r.code === 127) throw new Failure("gh not found");
    last = status ? statusReason(Number(status)) : "gh failed";
    if (status !== "404") break;
  }
  throw new Failure(last);
}

async function fetchAttachment(s: Extract<Source, { kind: "attachment" }>): Promise<Uint8Array> {
  const token = await ghToken(s.host);
  if (!token) return plainFetch(s.url);
  const res = await fetch(s.url, { headers: { authorization: `Bearer ${token}`, accept: "image/*,*/*;q=0.8" }, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
  const loc = res.headers.get("location");
  if (res.status >= 300 && res.status < 400 && loc) return plainFetch(new URL(loc, s.url).href);
  if (!res.ok) throw new Failure(statusReason(res.status));
  return readBody(res);
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

let worker: Worker | null = null;
let nextId = 1;
const pending = new Map<number, { ok: (d: Decoded) => void; fail: (e: Failure) => void }>();

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
  w.onerror = () => {
    worker = null;
    for (const p of pending.values()) p.fail(new Failure("unsupported"));
    pending.clear();
  };
  worker = w;
  return w;
}

function rasterize(svg: string): Promise<Decoded> {
  const { promise, resolve, reject } = Promise.withResolvers<Decoded>();
  const id = nextId++;
  pending.set(id, { ok: resolve, fail: reject });
  const req: SvgRequest = { id, svg };
  svgWorker().postMessage(req);
  return promise;
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

const MAX_ENTRIES = 64;
const CONCURRENCY = 3;

const states = new Map<string, ImageState>();
const listeners = new Set<() => void>();
const queue: (() => void)[] = [];
let running = 0;
let version = 0;

const set = (src: string, st: ImageState) => {
  states.delete(src);
  states.set(src, st);
  // bounded, oldest first; a finished entry is never evicted while loading entries could be
  for (const [k, v] of states) {
    if (states.size <= MAX_ENTRIES) break;
    if (v.status !== "loading" && k !== src) states.delete(k);
  }
  version++;
  for (const l of listeners) l();
};

async function load(src: string): Promise<ImageState> {
  try {
    const source = resolveSource(src);
    if (!source) return { status: "error", reason: "unsupported" };
    const bytes = source.kind === "contents" ? await fetchContents(source) : source.kind === "attachment" ? await fetchAttachment(source) : await plainFetch(source.url);
    return { status: "ready", ...(await decodeBytes(bytes)) };
  } catch (e) {
    if (e instanceof Failure) return { status: "error", reason: e.message };
    const name = e instanceof Error ? e.name : "";
    return { status: "error", reason: name === "TimeoutError" || name === "AbortError" ? "timeout" : "network" };
  }
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    running++;
    queue.shift()!();
  }
}

/** Current state of `src`; the first call starts the load (deduped, at most a few at a time). Errors are cached, so there is no retry loop. */
export function peekImage(src: string): ImageState {
  const hit = states.get(src);
  if (hit) return hit;
  const loading: ImageState = { status: "loading" };
  states.set(src, loading);
  queue.push(() =>
    void load(src).then((st) => {
      running--;
      set(src, st);
      pump();
    }),
  );
  pump();
  return loading;
}

/** `useSyncExternalStore` pair: bumps whenever any image finishes loading. */
export const subscribeImages = (fn: () => void): (() => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};
export const imagesVersion = (): number => version;
