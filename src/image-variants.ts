/**
 * Bounded cache of pixel-exact renderings of an image (one per source and drawn size), made one at a time off the render path.
 *
 * - Outstanding work is bounded: at most `max` slots exist (pending ones included) and jobs run serially, a moment after they were asked for.
 * - Sizes that nobody shows any more are never made: a job that is still waiting when a newer size of the same group (source) was asked for,
 *   and that no mounted view pinned, is dropped. A window drag asks for many sizes and only the last gets rendered.
 * - Admission is stable: slots in use (`pin`) are never evicted, and when every slot is pinned or working a new size is refused (the caller
 *   keeps showing the base image) instead of evicting a visible neighbour that would immediately ask for itself back.
 */

export interface Disposable {
  dispose(): void;
}

export interface VariantCache<T extends Disposable> {
  /** The made value, or undefined while it is being made, when none is needed (`make` gave null), when it failed, or when the cache is full of slots in use. Asks for it the first time. */
  get(key: string, group: string, make: () => Promise<T | null>): T | undefined;
  /** Keeps `key` from being evicted until the returned release is called. Pin what is mounted. */
  pin(key: string): () => void;
}

const PENDING = Symbol("pending");
type Value<T> = T | null | typeof PENDING;

/** Jobs wait this long before starting, so the views that asked for them have pinned (and a resize has settled on its size). */
const START_DELAY_MS = 30;

export function createVariantCache<T extends Disposable>(o: { max: number; notify: () => void; startDelayMs?: number }): VariantCache<T> {
  const { max, notify, startDelayMs = START_DELAY_MS } = o;
  /** In recency order, oldest first. */
  const slots = new Map<string, { value: Value<T>; group: string; make: () => Promise<T | null> }>();
  const pins = new Map<string, number>();
  const latest = new Map<string, string>();
  const queue: string[] = [];
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const drop = (key: string) => {
    const s = slots.get(key);
    slots.delete(key);
    if (!s) return;
    if (latest.get(s.group) === key) latest.delete(s.group);
    if (s.value !== PENDING) s.value?.dispose();
  };

  const room = (): boolean => {
    for (const [key] of slots) {
      if (slots.size < max) break;
      if (!pins.has(key)) drop(key);
    }
    return slots.size < max;
  };

  const run = async () => {
    if (running) return;
    running = true;
    try {
      for (let key = queue.shift(); key !== undefined; key = queue.shift()) {
        const slot = slots.get(key);
        if (!slot || slot.value !== PENDING) continue;
        if (!pins.has(key) && latest.get(slot.group) !== key) {
          drop(key);
          continue;
        }
        let made: T | null = null;
        try {
          made = await slot.make();
        } catch {}
        if (slots.get(key) !== slot) made?.dispose();
        else {
          slot.value = made;
          notify();
        }
      }
    } finally {
      running = false;
    }
  };

  return {
    get(key, group, make) {
      const hit = slots.get(key);
      if (hit) {
        slots.delete(key);
        slots.set(key, hit);
        return hit.value === PENDING ? undefined : (hit.value ?? undefined);
      }
      if (!room()) return undefined;
      slots.set(key, { value: PENDING, group, make });
      latest.set(group, key);
      queue.push(key);
      timer ??= setTimeout(() => {
        timer = null;
        void run();
      }, startDelayMs);
      return undefined;
    },
    pin(key) {
      pins.set(key, (pins.get(key) ?? 0) + 1);
      return () => {
        const n = (pins.get(key) ?? 1) - 1;
        if (n > 0) pins.set(key, n);
        else pins.delete(key);
      };
    },
  };
}
