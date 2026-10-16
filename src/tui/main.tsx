/** TUI entry. Imported lazily by cli.ts so JSON CLI paths never load React/OpenTUI. */
import { CliRenderEvents, createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { EventEmitter } from "node:events";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { installImageDensity, watchImageCapabilities } from "./image-density";
import { Store, StoreContext } from "./store";
import { envTheme, palettes } from "./theme";

/**
 * Every component that reads keys or the terminal size subscribes to the renderer, so a busy screen legitimately has
 * dozens of listeners; Node's default cap of 10 then prints a leak warning straight over the TUI. Raise the cap, and
 * send any runtime warning to a log file instead of stderr (which is the screen while the TUI runs).
 */
function quietWarnings(): void {
  EventEmitter.defaultMaxListeners = 100;
  const dir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "stk");
  process.removeAllListeners("warning");
  process.on("warning", (w) => {
    try {
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "warnings.log"), `${new Date().toISOString()} ${w.name}: ${w.message}\n`);
    } catch {}
  });
}

export interface TuiOptions {
  repoDir: string;
  /** Open this PR's page first. */
  pr?: number;
  /** Launch repo by slug instead of a local clone (`--gh owner/name`); `repoDir` is ignored for it. */
  gh?: { owner: string; name: string };
  /** Tern pane of the agent session: opens the Session scope and makes it the PR page's back target. */
  sessionPane?: string;
}

/** Runs until the user quits; resolves 0 after the terminal is restored. */
export async function runTui(opts: TuiOptions): Promise<number> {
  // xterm title stack: save the current title now, restore it on exit (OSC 2 is set by App once the repo is known).
  process.stdout.write("\x1b[22;0t");
  quietWarnings();
  installImageDensity();
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    backgroundColor: palettes[envTheme()].ground,
  });
  renderer.setMaxListeners(100);
  watchImageCapabilities(renderer);
  (renderer.keyInput as unknown as EventEmitter).setMaxListeners?.(100);
  const store = new Store(opts.repoDir, { pr: opts.pr, gh: opts.gh, sessionPane: opts.sessionPane });
  // Terminal focus reports: an unfocused pane stops polling GitHub (see Store.poll).
  renderer.on(CliRenderEvents.FOCUS, () => store.setTerminalFocused(true));
  renderer.on(CliRenderEvents.BLUR, () => store.setTerminalFocused(false));
  // Copy on select: a finished mouse drag copies its text. pbcopy locally (works in every terminal); OSC 52 over
  // SSH or off macOS, where the terminal owns the clipboard.
  renderer.on(CliRenderEvents.SELECTION, (sel: { getSelectedText(): string }) => {
    const text = sel.getSelectedText();
    if (!text.trim()) return;
    let ok = false;
    if (process.platform === "darwin" && !process.env.SSH_TTY) {
      ok = Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(text) }).exitCode === 0;
    }
    if (!ok) ok = renderer.copyToClipboardOSC52(text);
    store.toast(ok ? `Copied ${text.length} character${text.length === 1 ? "" : "s"}` : "Couldn’t copy the selection", ok ? "success" : "error");
  });
  createRoot(renderer).render(
    <StoreContext.Provider value={store}>
      <App />
    </StoreContext.Provider>,
  );
  await renderer.closed;
  store.dispose();
  process.stdout.write("\x1b[23;0t");
  return 0;
}
