/**
 * Network side of image loading. Comment authors choose the URLs, so they are fetched as untrusted input:
 * https only, every resolved address must be public, redirects are followed by hand (re-validated each hop), credentials ride only on the
 * first hop to a trusted GitHub host, and bodies are size-capped while streaming.
 * Known limit: the address check resolves DNS separately from the fetch, so a DNS-rebinding host can still slip through.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export class Failure extends Error {}

export const TIMEOUT_MS = 20_000;
export const MAX_BYTES = 25 * 1024 * 1024;
const MAX_HOPS = 5;

export const statusReason = (code: number): string =>
  code === 404 ? "404" : code === 401 || code === 403 ? "403" : code >= 500 ? "server error" : `HTTP ${code}`;

/** Hextets of an IPv6 literal (with `::` expanded and a trailing dotted v4 folded in), or null. */
function hextets(ip: string): number[] | null {
  let s = ip.toLowerCase().split("%")[0]!;
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const o = v4[1]!.split(".").map(Number);
    s = s.slice(0, -v4[1]!.length) + (((o[0]! << 8) | o[1]!).toString(16) + ":" + ((o[2]! << 8) | o[3]!).toString(16));
  }
  const [head, tail, extra] = s.split("::");
  if (extra !== undefined) return null;
  const a = head ? head.split(":") : [];
  const b = tail ? tail.split(":") : [];
  const fill = tail === undefined ? 0 : 8 - a.length - b.length;
  if (fill < 0 || (tail === undefined && a.length !== 8)) return null;
  const out = [...a, ...Array<string>(fill).fill("0"), ...b].map((h) => parseInt(h, 16));
  return out.length === 8 && out.every((n) => n >= 0 && n <= 0xffff) ? out : null;
}

function privateV4(o: number[]): boolean {
  const [a, b, c] = o as [number, number, number];
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // this-net, private, loopback, multicast/reserved/broadcast
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local, cloud metadata
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

/** Loopback, private, link-local, CGNAT, unique-local, multicast, reserved and metadata addresses; unparseable input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) return privateV4(ip.split(".").map(Number));
  if (kind !== 6) return true;
  const h = hextets(ip);
  if (!h) return true;
  const [a, b, c, d, e, f, g, i] = h as [number, number, number, number, number, number, number, number];
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && (f === 0 || f === 0xffff)) {
    // ::, ::1, then ::ffff:a.b.c.d and v4-compatible ::a.b.c.d judged as the v4 address
    return f === 0 && g === 0 && i <= 1 ? true : privateV4([g >> 8, g & 255, i >> 8, i & 255]);
  }
  // unique-local, link-local, multicast, NAT64, 6to4, Teredo
  return (a & 0xfe00) === 0xfc00 || (a & 0xffc0) === 0xfe80 || (a & 0xff00) === 0xff00 || (a === 0x64 && b === 0xff9b) || a === 0x2002 || (a === 0x2001 && b === 0);
}

/** Throws unless `url` is https and every address its host resolves to is public. */
export async function assertPublic(url: URL): Promise<void> {
  if (url.protocol !== "https:") throw new Failure("unsupported");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Failure("blocked");
    return;
  }
  const found = await lookup(host, { all: true }).catch(() => []);
  if (!found.length) throw new Failure("network");
  if (found.some((a) => isPrivateAddress(a.address))) throw new Failure("blocked");
}

/** Reads a body, giving up (and cancelling the stream) past `MAX_BYTES`. */
export async function readCapped(res: Response): Promise<Uint8Array> {
  if (Number(res.headers.get("content-length") ?? 0) > MAX_BYTES) {
    await res.body?.cancel();
    throw new Failure("too large");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of res.body ?? []) {
    total += chunk.length;
    if (total > MAX_BYTES) {
      await res.body?.cancel();
      throw new Failure("too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * GET `start` following up to 5 redirects by hand. `auth` (a bearer token) is sent on the first request only, and only when `trustFirst`
 * says that request's host is a GitHub host the user is signed in to (not address-checked: it may be an internal GHES). Every other hop is
 * anonymous and must resolve to public addresses.
 */
export async function guardedGet(start: string, o: { auth?: string; trustFirst?: boolean } = {}): Promise<Uint8Array> {
  let url = new URL(start);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (url.protocol !== "https:") throw new Failure("unsupported");
    const first = hop === 0;
    if (!(first && o.trustFirst)) await assertPublic(url);
    const headers: Record<string, string> = { accept: "image/*,*/*;q=0.8" };
    if (first && o.trustFirst && o.auth) headers.authorization = `Bearer ${o.auth}`;
    const res = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    const loc = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && loc) {
      await res.body?.cancel();
      url = new URL(loc, url);
      continue;
    }
    if (!res.ok) {
      await res.body?.cancel();
      throw new Failure(statusReason(res.status));
    }
    return readCapped(res);
  }
  throw new Failure("too many redirects");
}
