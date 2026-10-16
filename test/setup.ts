import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STK_PREFS_FILE ??= join(mkdtempSync(join(tmpdir(), "stk-test-prefs-")), "prefs.json");
// Keeps restack provenance off the developer's real ~/.cache/stk.
process.env.STK_STATE_DIR ??= mkdtempSync(join(tmpdir(), "stk-test-state-"));
