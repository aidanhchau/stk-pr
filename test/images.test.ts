import { describe, expect, test } from "bun:test";
import { resolveSource } from "../src/images";

const SHA = "ebb07850d77813b35601e9f26f634903c7629d59";

describe("resolveSource", () => {
  test("blob URL, with or without ?raw=true, reads the contents API at the sha", () => {
    const want = { kind: "contents", host: "github.com", owner: "getanalog-ai", repo: "pr-diagrams", candidates: [{ ref: SHA, path: "maple-gtm/aidan/seo-oct15-cycle/change.svg" }] };
    expect(resolveSource(`https://github.com/getanalog-ai/pr-diagrams/blob/${SHA}/maple-gtm/aidan/seo-oct15-cycle/change.svg?raw=true`)).toEqual(want as never);
    expect(resolveSource(`https://github.com/getanalog-ai/pr-diagrams/blob/${SHA}/maple-gtm/aidan/seo-oct15-cycle/change.svg`)).toEqual(want as never);
    expect(resolveSource(`https://github.com/getanalog-ai/pr-diagrams/raw/${SHA}/maple-gtm/aidan/seo-oct15-cycle/change.svg`)).toEqual(want as never);
  });

  test("raw.githubusercontent.com maps to github.com; refs/heads/ is dropped", () => {
    expect(resolveSource(`https://raw.githubusercontent.com/o/r/${SHA}/a/b.png`)).toEqual({ kind: "contents", host: "github.com", owner: "o", repo: "r", candidates: [{ ref: SHA, path: "a/b.png" }] } as never);
    const s = resolveSource("https://raw.githubusercontent.com/o/r/refs/heads/main/a/b.png");
    expect(s).toMatchObject({ kind: "contents", candidates: [{ ref: "main", path: "a/b.png" }, { ref: "main/a", path: "b.png" }] });
  });

  test("a branch ref may hold slashes: candidates run from the shortest ref; a sha has one", () => {
    const s = resolveSource("https://github.com/o/r/blob/aidan/feature/docs/x.svg");
    expect(s).toMatchObject({
      kind: "contents",
      candidates: [
        { ref: "aidan", path: "feature/docs/x.svg" },
        { ref: "aidan/feature", path: "docs/x.svg" },
        { ref: "aidan/feature/docs", path: "x.svg" },
      ],
    });
    expect(resolveSource(`https://github.com/o/r/blob/${SHA}/a/b/c.png`)).toMatchObject({ candidates: [{ ref: SHA, path: "a/b/c.png" }] });
  });

  test("percent-encoded paths are decoded (the caller re-encodes per segment)", () => {
    expect(resolveSource("https://github.com/o/r/blob/main/my%20docs/a%20b.png")).toMatchObject({
      candidates: [
        { ref: "main", path: "my docs/a b.png" },
        { ref: "main/my docs", path: "a b.png" },
      ],
    });
  });

  test("a GitHub Enterprise host keeps its hostname", () => {
    expect(resolveSource("https://github.corp.example/o/r/blob/main/a.png")).toMatchObject({ kind: "contents", host: "github.corp.example", owner: "o", repo: "r" });
  });

  test("user-attachments and legacy /assets uploads need the gh token", () => {
    const u = "https://github.com/user-attachments/assets/9f0bb401-fa25-4f82-b903-11056abf6ce2";
    expect(resolveSource(u)).toEqual({ kind: "attachment", host: "github.com", url: u });
    expect(resolveSource("https://github.com/o/r/assets/123/abc-def")).toMatchObject({ kind: "attachment" });
  });

  test("everything else passes through; non-http(s) is rejected", () => {
    expect(resolveSource("https://example.com/a.png")).toEqual({ kind: "url", url: "https://example.com/a.png" });
    expect(resolveSource("https://private-user-images.githubusercontent.com/1/x.png?jwt=abc")).toMatchObject({ kind: "url" });
    expect(resolveSource("https://octocat.github.io/blob/a/b/c.png")).toMatchObject({ kind: "url" });
    expect(resolveSource("data:image/png;base64,AAAA")).toBeNull();
    expect(resolveSource("./local.png")).toBeNull();
    expect(resolveSource("file:///tmp/a.png")).toBeNull();
  });
});
