/** Confirm sheet for destructive palette commands (close PR, convert to draft, merge). */
import type { ScrollBoxRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/react";
import { useRef, useState } from "react";
import { copyText } from "./commands";
import { useStoreInstance, type Sheet as SheetState } from "./store";
import { G, useTermSize } from "./theme";
import { Pill, Sheet, Txt, useVimNav } from "./ui";

export function ConfirmSheet({ sheet }: { sheet: Extract<NonNullable<SheetState>, { kind: "confirm" }> }) {
  const store = useStoreInstance();
  const confirm = () => {
    store.closeSheet();
    sheet.onConfirm();
  };
  useKeyboard((k) => {
    if (k.name === "return" || k.name === "enter") confirm();
  });
  const lines = sheet.body.split("\n");
  return (
    <Sheet title={sheet.title} width={64}>
      <box height={1} flexShrink={0} />
      {lines.map((l, i) => (
        <box key={i} height={1} flexShrink={0} overflow="hidden">
          <Txt tone={i === 0 ? "ink" : "muted"} truncate>
            {l}
          </Txt>
        </box>
      ))}
      <box height={1} flexShrink={0} marginTop={1} flexDirection="row" justifyContent="space-between">
        <Txt tone="muted">Cancel esc</Txt>
        <Pill label={sheet.label} hint="⏎" variant="primary" onPress={confirm} />
      </box>
    </Sheet>
  );
}

/** Scrollable output of a `:gh` command; `y` copies it. */
export function OutputSheet({ sheet }: { sheet: Extract<NonNullable<SheetState>, { kind: "output" }> }) {
  const store = useStoreInstance();
  const { height: H, width: W } = useTermSize();
  const scroll = useRef<ScrollBoxRenderable>(null);
  const [cursor, setCursor] = useState(0);
  const inner = Math.min(W < 80 ? 64 : 100, W - 2) - 8;
  const lines = sheet.output.split("\n").flatMap((l) => (l.length <= inner ? [l] : (l.match(new RegExp(`.{1,${inner}}`, "g")) ?? [l])));
  const viewH = Math.max(4, Math.min(lines.length, H - 14));
  const scrollTo = (c: number) => {
    setCursor(c);
    scroll.current?.scrollTo(c);
  };
  useVimNav({ count: lines.length, cursor, setCursor: scrollTo, pageSize: viewH, enabled: true, sheet: true });
  useKeyboard((k) => {
    if (k.name === "y" && !k.ctrl && !k.meta) copyText(store, "output", sheet.output);
  });
  return (
    <Sheet title={sheet.title} meta={lines.length > viewH ? "j/k scroll" : undefined} width={100}>
      <box height={1} flexShrink={0} />
      <box height={1} flexShrink={0} overflow="hidden">
        <Txt tone="muted" truncate>{`$ ${sheet.command}`}</Txt>
      </box>
      <box height={1} flexShrink={0} />
      <scrollbox ref={scroll} height={viewH} flexShrink={0} scrollY>
        <box flexDirection="column">
          {lines.map((l, i) => (
            <box key={i} height={1} flexShrink={0} overflow="hidden">
              <Txt tone={sheet.code === 0 ? "ink" : "error"}>{l || " "}</Txt>
            </box>
          ))}
        </box>
      </scrollbox>
      <box height={1} flexShrink={0} marginTop={1} flexDirection="row" justifyContent="space-between">
        <Txt tone="muted">{`y copy ${G.sep} exit ${sheet.code}`}</Txt>
        <Txt tone="muted">Close esc</Txt>
      </box>
    </Sheet>
  );
}
