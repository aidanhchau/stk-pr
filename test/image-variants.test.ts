import { describe, expect, test } from "bun:test";
import { createVariantCache, type Disposable } from "../src/image-variants";

interface Fake extends Disposable {
  disposed: boolean;
}
const fake = (): Fake => ({ disposed: false, dispose() { this.disposed = true; } });
const tick = () => Bun.sleep(8);

const cache = (max: number) => {
  let notified = 0;
  const c = createVariantCache<Fake>({ max, startDelayMs: 0, notify: () => notified++ });
  return { c, notified: () => notified };
};

describe("variant cache", () => {
  test("made once, undefined until done, then handed out and announced", async () => {
    const { c, notified } = cache(4);
    const img = fake();
    let made = 0;
    const make = async () => (made++, img);
    expect(c.get("a1", "a", make)).toBeUndefined();
    expect(c.get("a1", "a", make)).toBeUndefined();
    await tick();
    expect(made).toBe(1);
    expect(notified()).toBe(1);
    expect(c.get("a1", "a", make)).toBe(img);
  });

  test("null (none needed) and failure both read as undefined, once", async () => {
    const { c } = cache(4);
    let made = 0;
    expect(c.get("n", "n", async () => (made++, null))).toBeUndefined();
    expect(c.get("f", "f", async () => { made++; throw new Error("x"); })).toBeUndefined();
    await tick();
    expect(c.get("n", "n", async () => (made++, null))).toBeUndefined();
    expect(c.get("f", "f", async () => (made++, null))).toBeUndefined();
    expect(made).toBe(2);
  });

  test("a size nobody pinned is not made once a newer size of the same group was asked for", async () => {
    const { c } = cache(8);
    const made: string[] = [];
    for (const w of [100, 110, 120, 130]) c.get(`a${w}`, "a", async () => (made.push(`a${w}`), fake()));
    c.get("b1", "b", async () => (made.push("b1"), fake()));
    await tick();
    expect(made).toEqual(["a130", "b1"]);
  });

  test("a pinned size is made even when superseded", async () => {
    const { c } = cache(8);
    const made: string[] = [];
    c.get("a1", "a", async () => (made.push("a1"), fake()));
    c.pin("a1");
    c.get("a2", "a", async () => (made.push("a2"), fake()));
    await tick();
    expect(made).toEqual(["a1", "a2"]);
  });

  test("bounded: unpinned least recently used go first and are disposed; pinned stay", async () => {
    const { c } = cache(2);
    const made: Fake[] = [];
    const make = async () => (made.push(fake()), made.at(-1)!);
    c.get("x", "x", make);
    c.pin("x");
    c.get("y", "y", make);
    await tick();
    c.get("z", "z", make);
    await tick();
    expect(made.map((m) => m.disposed)).toEqual([false, true, false]);
    expect(c.get("x", "x", make)).toBe(made[0]);
  });

  test("admission is stable: with every slot pinned a new size is refused, not swapped in", async () => {
    const { c, notified } = cache(2);
    const made: Fake[] = [];
    const make = async () => (made.push(fake()), made.at(-1)!);
    for (const k of ["p", "q"]) {
      c.get(k, k, make);
      c.pin(k);
    }
    await tick();
    const before = notified();
    for (let i = 0; i < 5; i++) expect(c.get("r", "r", make)).toBeUndefined();
    await tick();
    expect(made).toHaveLength(2);
    expect(made.some((m) => m.disposed)).toBe(false);
    expect(notified()).toBe(before);
    expect(c.get("p", "p", make)).toBe(made[0]);
  });

  test("releasing a pin makes the slot evictable again", async () => {
    const { c } = cache(1);
    const make = async () => fake();
    c.get("p", "p", make);
    const release = c.pin("p");
    await tick();
    expect(c.get("q", "q", make)).toBeUndefined();
    release();
    c.get("q", "q", make);
    await tick();
    expect(c.get("q", "q", make)).toBeDefined();
  });
});
