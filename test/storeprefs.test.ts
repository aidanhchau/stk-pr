import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPrefs } from "../src/prefs";
import { runCommand } from "../src/tui/commands";
import { Store, mergeMethodOf } from "../src/tui/store";
import { reducedMotion } from "../src/tui/theme";

const repo = { owner: "Acme", name: "Web" };
const fileIn = () => join(mkdtempSync(join(tmpdir(), "stk-storeprefs-")), "prefs.json");
/** The store's private scope resolver, as init/setRepoFocus use it. */
const savedScope = (s: Store) => (s as unknown as { savedScope(r: typeof repo): string | undefined }).savedScope(repo);

describe("Store preferences", () => {
  test("changing the board tab saves it per repo; a new store loads it", () => {
    const prefsFile = fileIn();
    const store = new Store("/nonexistent", { gh: repo, prefsFile });
    store.setScope("review");
    expect(loadPrefs(prefsFile).repos["acme/web"]).toEqual({ scope: "review" });

    const next = new Store("/nonexistent", { gh: repo, prefsFile });
    expect(next.getState().prefs.repos["acme/web"]?.scope).toBe("review");
    expect(savedScope(next)).toBe("review");
  });

  test("a saved Session tab is ignored without a session pane", () => {
    const prefsFile = fileIn();
    writeFileSync(prefsFile, JSON.stringify({ repos: { "acme/web": { scope: "session" } } }));
    expect(savedScope(new Store("/nonexistent", { gh: repo, prefsFile }))).toBeUndefined();
    expect(savedScope(new Store("/nonexistent", { gh: repo, prefsFile, sessionPane: "3" }))).toBe("session");
  });

  test("merge method cycles squash → merge → rebase → squash and persists", () => {
    const prefsFile = fileIn();
    const store = new Store("/nonexistent", { gh: repo, prefsFile });
    expect(mergeMethodOf(store.getState())).toBe("squash");
    store.cycleMergeMethod();
    expect(mergeMethodOf(store.getState())).toBe("merge");
    store.cycleMergeMethod();
    expect(loadPrefs(prefsFile).repos["acme/web"]?.mergeMethod).toBe("rebase");
    expect(mergeMethodOf(new Store("/nonexistent", { gh: repo, prefsFile }).getState())).toBe("rebase");
    store.cycleMergeMethod();
    expect(mergeMethodOf(store.getState())).toBe("squash");
  });

  test("prefsFile null keeps everything in memory", () => {
    const store = new Store("/nonexistent", { gh: repo, prefsFile: null });
    store.cycleMergeMethod();
    expect(mergeMethodOf(store.getState())).toBe("merge");
  });

  test("an unwritable prefs path does not break the store", () => {
    const store = new Store("/nonexistent", { gh: repo, prefsFile: "/proc/nope/prefs.json" });
    store.cycleMergeMethod();
    expect(mergeMethodOf(store.getState())).toBe("merge");
  });

  test("saved reduced motion reaches the theme", () => {
    const prefsFile = fileIn();
    writeFileSync(prefsFile, JSON.stringify({ reducedMotion: true, repos: {} }));
    new Store("/nonexistent", { gh: repo, prefsFile });
    expect(reducedMotion()).toBe(true);
    new Store("/nonexistent", { gh: repo, prefsFile: null });
    expect(reducedMotion()).toBe(false);
  });

  test(":notify and :reduced-motion save and apply at once", () => {
    const prefsFile = fileIn();
    const store = new Store("/nonexistent", { gh: repo, prefsFile });
    runCommand(store, "notify-off");
    expect(store.getState().prefs.notify).toBe("off");
    expect(loadPrefs(prefsFile).notify).toBe("off");
    runCommand(store, "notify-system");
    expect(loadPrefs(prefsFile).notify).toBe("system");
    runCommand(store, "motion-on");
    expect(reducedMotion()).toBe(true);
    expect(loadPrefs(prefsFile).reducedMotion).toBe(true);
    runCommand(store, "motion-off");
    expect(reducedMotion()).toBe(false);
    expect(loadPrefs(prefsFile).reducedMotion).toBe(false);
  });
});
