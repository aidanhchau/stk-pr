import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.STK_PREFS_FILE ??= join(mkdtempSync(join(tmpdir(), "stk-test-prefs-")), "prefs.json");
