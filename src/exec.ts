import type { Exec } from "./types";

// Tern's daemon runs with a minimal PATH; make gh/git findable wherever they were installed.
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", `${process.env.HOME}/.local/bin`, `${process.env.HOME}/.bun/bin`];
const pathDirs = (process.env.PATH ?? "").split(":").filter(Boolean);
process.env.PATH = [...pathDirs, ...EXTRA_PATH.filter((d) => !pathDirs.includes(d))].join(":");

/** Real process runner. Never throws on nonzero exit; spawn failures become code 127. */
export const exec: Exec = async (argv, opts = {}) => {
  try {
    const proc = Bun.spawn([...argv], {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  } catch (e) {
    return { code: 127, stdout: "", stderr: e instanceof Error ? e.message : String(e) };
  }
};
