/** Root layout, routing between screens, global keys. Screens plug into the chrome via their `Chrome` export. */
import { useKeyboard, useRenderer } from "@opentui/react";
import { createElement, useEffect } from "react";
import { Board, boardChrome } from "./board";
import { runCommand } from "./commands";
import { Pr, prCapturesBack, prChrome } from "./pr";
import { Sheets } from "./sheets";
import { useStore, useStoreInstance } from "./store";
import { ThemeContext, palettes, useThemeName, useLayout, useTheme } from "./theme";
import { Dock, DockCommands, DockCount, DockInput, DockModeHint, ErrorState, Page, ToastArea } from "./ui";

export function App() {
  const store = useStoreInstance();
  const renderer = useRenderer();
  const name = useThemeName();
  const p = palettes[name];

  useEffect(() => {
    void store.init();
    return () => store.dispose();
  }, [store]);

  const label = useHeaderLabel();
  useEffect(() => {
    if (label) renderer.setTerminalTitle(`stk · ${label}`);
  }, [renderer, label]);

  // Global keys. Handlers run before focused elements and see every key, so gate on inputFocused / sheet.
  useKeyboard((key) => {
    const s = store.getState();
    if (key.name === "escape") {
      if (s.inputFocused) return; // the input's owner handles Esc (blur/cancel)
      if (s.sheet) store.closeSheet();
      else if (s.screen.kind === "pr" && !prCapturesBack()) store.back();
      return;
    }
    if (s.inputFocused) return;
    // `:` is the PR switcher (vim command line); ctrl-k is an alias.
    if (!s.sheet && !key.meta && ((key.sequence === ":" && !key.ctrl) || (key.name === "k" && key.ctrl))) {
      store.openSheet({ kind: "palette" });
      return;
    }
    if (s.sheet) return;
    // ⌘⇧C copies the PR URL (kitty `super`; shift may arrive as name "C" or as the flag). Plain c / C stay with the screens.
    if (key.super && key.shift && !key.ctrl && !key.meta && key.name?.toLowerCase() === "c") return void runCommand(store, "copy-url");
    if (key.name === "q" && !key.ctrl && !key.meta) renderer.destroy();
    else if ((key.name === "backspace" || key.name === "h") && s.screen.kind === "pr" && !prCapturesBack()) store.back();
    else if (key.sequence === "?") store.openSheet({ kind: "help" });
    else if (key.name === "r" && !key.ctrl && !key.meta) void store.refresh();
  });

  return (
    <ThemeContext.Provider value={{ name, p }}>
      <Shell />
    </ThemeContext.Provider>
  );
}

/** `session · <pane title>` on the session board, else the repo of the screen (a PR may live outside the launch repo). */
function useHeaderLabel(): string | null {
  return useStore((s) => {
    const ws = s.workspace;
    const wsLabel = ws ? `workspace ${ws.label} (${ws.repos.length} ${ws.repos.length === 1 ? "repo" : "repos"})` : null;
    if (s.screen.kind === "board" && s.screen.scope === "session") {
      const session = s.sessionMissing ? "session · no agent pane found" : `session · ${s.sessionTitle ?? s.sessionPane ?? ""}`;
      return wsLabel ? `${wsLabel} · ${session}` : session;
    }
    const r = s.screen.kind === "pr" && s.screen.repo.owner ? s.screen.repo : s.repo;
    if (wsLabel && !ws!.focus && s.screen.kind === "board") return wsLabel;
    return r ? `${r.owner}/${r.name}${ws ? ` · ${wsLabel}` : ""}` : wsLabel;
  });
}

function Shell() {
  const p = useTheme();
  const screen = useStore((s) => s.screen);
  const sheet = useStore((s) => s.sheet);
  const fatal = useStore((s) => s.fatal);
  const searchLine = useStore((s) => s.searchLine);
  const label = useHeaderLabel();
  const { width, height } = useLayout();
  const chrome = screen.kind === "board" ? boardChrome : prChrome;

  return (
    <box width={width} height={height} flexDirection="column" backgroundColor={p.ground}>
      <Page>
        <box height={1} flexDirection="row" flexShrink={0}>
          <box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden" marginRight={2}>
            <text fg={p.muted} wrapMode="none" truncate>
              {label ? `stk · ${label}` : "stk"}
            </text>
          </box>
          <box flexShrink={0}>{createElement(chrome.HeaderRight)}</box>
        </box>
        <box height={1} flexShrink={0} />
        {fatal ? (
          <ErrorState title="Couldn’t open this repository" detail={fatal} hint="Press q to quit" />
        ) : screen.kind === "board" ? (
          <Board scope={screen.scope} />
        ) : (
          <Pr key={`${screen.repo.owner}/${screen.repo.name}#${screen.n}`} n={screen.n} />
        )}
      </Page>
      <Dock
        top={searchLine?.active ? <DockInput line={searchLine} /> : <DockCommands />}
        right={searchLine?.active ? null : createElement(chrome.DockRight)}
        status={searchLine ? <DockModeHint line={searchLine} /> : createElement(chrome.DockLeft)}
        count={searchLine ? <DockCount line={searchLine} /> : null}
      />
      <ToastArea />
      {sheet && <Sheets sheet={sheet} />}
    </box>
  );
}
