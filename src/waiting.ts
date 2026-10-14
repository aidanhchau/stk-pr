/** Pure helpers for the stack sheet's waiting states (used by the TUI sheets). */

const DOTS = ["·", "··", "···"] as const;

/** `Planning ···`: the dots cycle with `tick`; the label is padded to the widest frame so nothing shifts. `still` gives `Planning…`. */
export function waitLabel(word: string, tick: number, still = false): string {
  if (still) return `${word}…`;
  return `${word} ${DOTS[((tick % 3) + 3) % 3]!.padEnd(3, " ")}`;
}

/** Request token: `next()` starts a request, `current(t)` says whether its result is still the latest (stale ones are dropped). */
export function requestToken(): { next(): number; current(t: number): boolean } {
  let latest = 0;
  return { next: () => ++latest, current: (t) => t === latest };
}

/** Blocker reasons that force cannot bypass (a draft or merge conflict). */
export const UNBYPASSABLE = /\b(is a draft|has merge conflicts|conflict)/i;

/** The reason shown under a stack row: the "#N is blocked: " prefix dropped, `bypass: ` when force will bypass it. */
export function rowReason(reason: string, n: number, force: boolean): { text: string; hard: boolean } {
  const text = reason.replace(new RegExp(`^#${n} (is blocked: )?`), "");
  const hard = UNBYPASSABLE.test(text);
  return { text: force && !hard ? `bypass: ${text}` : text, hard };
}
