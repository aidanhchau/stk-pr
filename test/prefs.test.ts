import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrefs, notifyMode, prefsPath, repoPrefs, savePrefs, withRepoPrefs } from "../src/prefs";

const tmp = () => mkdtempSync(join(tmpdir(), "stk-prefs-"));

describe("prefs", () => {
  test("path honours STK_PREFS_FILE, XDG_CONFIG_HOME, then ~/.config", () => {
    expect(prefsPath({ STK_PREFS_FILE: "/x/p.json", XDG_CONFIG_HOME: "/xdg" })).toBe("/x/p.json");
    expect(prefsPath({ XDG_CONFIG_HOME: "/xdg", HOME: "/h" })).toBe("/xdg/stk/prefs.json");
    expect(prefsPath({ HOME: "/h" })).toBe("/h/.config/stk/prefs.json");
  });

  test("missing file gives defaults", () => {
    const p = loadPrefs(join(tmp(), "nope.json"));
    expect(p).toEqual({ repos: {} });
    expect(notifyMode(p, { focused: true })).toBe("toast");
    expect(notifyMode(p, { focused: false })).toBe("system");
  });

  test("round trip creates directories and leaves no temp file", () => {
    const dir = tmp();
    const file = join(dir, "nested", "stk", "prefs.json");
    let p = withRepoPrefs({ repos: {} }, { owner: "Acme", name: "Web" }, { scope: "review" });
    p = withRepoPrefs(p, { owner: "acme", name: "web" }, { mergeMethod: "rebase" });
    p = { ...p, notify: "off", reducedMotion: true };
    savePrefs(p, file);
    expect(readdirSync(join(dir, "nested", "stk"))).toEqual(["prefs.json"]);
    const back = loadPrefs(file);
    expect(back).toEqual({ notify: "off", reducedMotion: true, repos: { "acme/web": { scope: "review", mergeMethod: "rebase" } } });
    expect(repoPrefs(back, { owner: "ACME", name: "Web" })).toEqual({ scope: "review", mergeMethod: "rebase" });
    expect(repoPrefs(back, { owner: "o", name: "other" })).toEqual({});
    expect(repoPrefs(back, null)).toEqual({});
    expect(notifyMode(back, { focused: false })).toBe("off");
  });

  test("overwrite replaces the previous content", () => {
    const file = join(tmp(), "prefs.json");
    savePrefs({ notify: "toast", repos: {} }, file);
    savePrefs({ notify: "system", repos: {} }, file);
    expect(JSON.parse(readFileSync(file, "utf8")).notify).toBe("system");
  });

  test("corrupt files fall back to defaults", () => {
    const file = join(tmp(), "prefs.json");
    for (const text of ["{not json", "", "null", "[]", '"str"', "42"]) {
      writeFileSync(file, text);
      expect(loadPrefs(file)).toEqual({ repos: {} });
    }
  });

  test("invalid fields are dropped, valid ones kept", () => {
    const file = join(tmp(), "prefs.json");
    writeFileSync(
      file,
      JSON.stringify({
        notify: "loud",
        reducedMotion: "yes",
        repos: { "O/R": { scope: "bogus", mergeMethod: "squash" }, bad: 3, "o/empty": { scope: 9 }, "o/ok": { scope: "session" } },
      }),
    );
    expect(loadPrefs(file)).toEqual({ repos: { "o/r": { mergeMethod: "squash" }, "o/ok": { scope: "session" } } });
  });
});
