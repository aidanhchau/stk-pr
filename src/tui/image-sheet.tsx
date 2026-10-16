/** Full-screen view of one image from a PR body or comment: fitted to the terminal, sent at the size it is drawn at. Esc (app), q or a click close it. */
import { useKeyboard } from "@opentui/react";
import { useSyncExternalStore } from "react";
import { imageState, imageVariant, imagesVersion, subscribeImages } from "../images";
import { useImageCell, imageTarget } from "./image-density";
import { fitInto } from "./image-fit";
import { useStoreInstance, type Sheet as SheetState } from "./store";
import { useTermSize, useTheme } from "./theme";
import { Txt } from "./ui";

/** Cells kept free around the image: a title row + gap above, a gap + hint row below, and a column either side. */
const CHROME_ROWS = 4;
const CHROME_COLS = 4;

export function ImageSheet({ sheet }: { sheet: Extract<NonNullable<SheetState>, { kind: "image" }> }) {
  const store = useStoreInstance();
  const p = useTheme();
  const { width: W, height: H } = useTermSize();
  const cell = useImageCell();
  useSyncExternalStore(subscribeImages, imagesVersion);
  useKeyboard((k) => {
    if (k.name === "q" && !k.ctrl && !k.meta) store.closeSheet();
  });
  const img = imageState(sheet.src);
  const ready = img?.status === "ready" ? img : null;
  const fit = ready ? fitInto(ready.width, ready.height, W - CHROME_COLS, H - CHROME_ROWS, cell) : null;
  const target = fit ? imageTarget(fit.cols, fit.rows) : null;
  const variant = target ? imageVariant(sheet.src, target.w, target.h) : undefined;
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
        {ready && fit ? (
          <image source={variant ?? ready.data} fit="fill" protocol="auto" width={fit.cols} height={fit.rows} flexShrink={0} />
        ) : (
          <Txt tone="muted">{img?.status === "error" ? `could not load image · ${img.reason}` : "loading image"}</Txt>
        )}
      </box>
      <box height={1} flexShrink={0} />
    </box>
  );
}
