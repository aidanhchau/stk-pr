import type { Store } from "./store";

/** Open a URL in the default browser. Spawns directly (never an OSC 8 link: the Tern plugin routes GitHub PR links back into stk). `STK_OPEN` overrides the opener. */
export function openUrl(url: string) {
  const opener = process.env.STK_OPEN ?? (process.platform === "darwin" ? "open" : "xdg-open");
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    /* no opener available */
  }
}

export function openInBrowser(store: Store, url: string) {
  openUrl(url);
  store.toast("Opened in browser");
}
