/** Full-screen view of one image from a PR body or comment: fitted to the terminal, sent at the size it is drawn at. Esc (app), q or a click close it. */
import { useKeyboard } from "@opentui/react";
import { useEffect } from "react";
import { imageState } from "../images";
import { useImageCell } from "./image-density";
import { fitInto } from "./image-fit";
import { useStoreInstance, type Sheet as SheetState } from "./store";
import { useTermSize, useTheme } from "./theme";
import { Txt } from "./ui";
import { useImageSource } from "./use-image";

/** Cells kept free around the image: a title row + gap above, a gap + hint row below, and a column either side. */
const CHROME_ROWS = 4;
const CHROME_COLS = 4;

export function ImageSheet({ sheet }: { sheet: Extract<NonNullable<SheetState>, { kind: "image" }> }) {
  const store = useStoreInstance();
  const p = useTheme();
  const { width: W, height: H } = useTermSize();
  const cell = useImageCell();
  // opened over an inline reply: its input gives up the keys (Esc/q reach this sheet) and takes them back on close
  useEffect(() => {
    const was = store.getState().inputFocused;
    store.setInputFocused(false);
    return () => store.setInputFocused(was);
  }, [store]);
  useKeyboard((k) => {
    if (k.name === "q" && !k.ctrl && !k.meta) store.closeSheet();
  });
  const info = imageState(sheet.src);
  const fit = info?.status === "ready" ? fitInto(info.width, info.height, W - CHROME_COLS, H - CHROME_ROWS, cell) : null;
  const img = useImageSource(sheet.src, fit?.cols ?? 1, fit?.rows ?? 1);
  return (
    <box position="absolute" left={0} top={0} width={W} height={H} zIndex={50} backgroundColor={p.ground} flexDirection="column" onMouseDown={() => store.closeSheet()}>
      <box height={1} flexShrink={0} flexDirection="row" paddingLeft={2} paddingRight={2} marginTop={1}>
        <box flexGrow={1} flexShrink={1} overflow="hidden" height={1}>
          <Txt tone="ink" truncate>
            {sheet.alt || "image"}
          </Txt>
        </box>
        <box flexShrink={0} marginLeft={2}>
          <Txt tone="muted">esc close</Txt>
        </box>
      </box>
      <box flexGrow={1} flexShrink={1} alignItems="center" justifyContent="center">
        {img && fit ? (
          <image source={img.source} fit="fill" protocol="auto" width={fit.cols} height={fit.rows} flexShrink={0} />
        ) : (
          <Txt tone="muted">{info?.status === "error" ? `could not load image · ${info.reason}` : "loading image"}</Txt>
        )}
      </box>
      <box height={1} flexShrink={0} />
    </box>
  );
}
