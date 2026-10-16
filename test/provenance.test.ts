import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEEP_MS, MAX_HEADS_PER_BRANCH, loadProvenance, provenanceFile, provenanceKey, recordProvenance } from "../src/provenance";

let dir: string;
let saved: string | undefined;
const sha = (n: number) => n.toString(16).padStart(40, "0");

beforeEach(() => {
  saved = process.env.STK_STATE_DIR;
  dir = mkdtempSync(join(tmpdir(), "stk-prov-"));
  process.env.STK_STATE_DIR = join(dir, "nested", "state");
});
afterEach(() => {
  if (saved === undefined) delete process.env.STK_STATE_DIR;
  else process.env.STK_STATE_DIR = saved;
  rmSync(dir, { recursive: true, force: true });
});

describe("restack provenance store", () => {
  test("missing file or directory is empty", () => {
    expect(loadProvenance("r")).toEqual({});
  });

  test("records are keyed by repo and branch, appended without duplicates", () => {
    recordProvenance("r1", [{ branch: "a", sha: sha(1) }]);
    recordProvenance("r1", [{ branch: "a", sha: sha(2) }, { branch: "b", sha: sha(3) }]);
    recordProvenance("r1", [{ branch: "a", sha: sha(1) }]);
    recordProvenance("r2", [{ branch: "a", sha: sha(9) }]);
    expect(loadProvenance("r1")).toEqual({ a: [sha(2), sha(1)], b: [sha(3)] });
    expect(loadProvenance("r2")).toEqual({ a: [sha(9)] });
    expect(provenanceKey({ owner: "o", name: "n" }, "/x")).toBe("o/n@/x");
  });

  test("keeps only the newest heads per branch and prunes old entries", () => {
    const now = Date.now();
    recordProvenance("r", [{ branch: "old", sha: sha(1) }], now - KEEP_MS - 1000);
    for (let i = 0; i < MAX_HEADS_PER_BRANCH + 5; i++) recordProvenance("r", [{ branch: "a", sha: sha(100 + i) }], now);
    const got = loadProvenance("r");
    expect(got.old).toBeUndefined();
    expect(got.a).toHaveLength(MAX_HEADS_PER_BRANCH);
    expect(got.a![MAX_HEADS_PER_BRANCH - 1]).toBe(sha(100 + MAX_HEADS_PER_BRANCH + 4));
  });

  test("a corrupt or wrongly shaped file is treated as empty and replaced on the next write", () => {
    mkdirSync(process.env.STK_STATE_DIR!, { recursive: true });
    for (const junk of ["{nope", "null", '{"repos":[]}', '{"repos":{"r":{"a":[{"sha":"zz","at":1},5,{"sha":"' + sha(1) + '","at":"x"}]}}}']) {
      writeFileSync(provenanceFile(), junk);
      expect(loadProvenance("r")).toEqual({});
    }
    recordProvenance("r", [{ branch: "a", sha: sha(1) }]);
    expect(loadProvenance("r")).toEqual({ a: [sha(1)] });
    expect(JSON.parse(readFileSync(provenanceFile(), "utf8")).version).toBe(1);
  });

  test("concurrent writers from several processes never corrupt the file", async () => {
    const script = `import { recordProvenance } from ${JSON.stringify(join(import.meta.dir, "../src/provenance"))};
      const [i] = process.argv.slice(2);
      for (let k = 0; k < 10; k++) recordProvenance("r", [{ branch: "p" + i, sha: (Number(i) * 100 + k).toString(16).padStart(40, "0") }]);`;
    const file = join(dir, "writer.ts");
    writeFileSync(file, script);
    const procs = [0, 1, 2, 3].map((i) => Bun.spawn(["bun", file, String(i)], { env: process.env, stdout: "ignore", stderr: "pipe" }));
    await Promise.all(procs.map((p) => p.exited));
    const got = loadProvenance("r");
    // the file parses, and with the lock every writer's last head survived
    for (let i = 0; i < 4; i++) expect(got[`p${i}`]!.at(-1)).toBe((i * 100 + 9).toString(16).padStart(40, "0"));
  });
});
