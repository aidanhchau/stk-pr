# stk

A terminal UI for GitHub pull requests, built for worktrees and stacked PRs. It lists your PRs with what blocks each one, shows review threads and diffs, merges (optionally forcing past failing checks), and merges a stack of PRs bottom-up. Merges run as detached jobs, so they survive closing the terminal. There is also a scriptable CLI with `--json` output.

stk talks to GitHub only through the [`gh` CLI](https://cli.github.com), so it uses your existing login and works with GitHub Enterprise hosts `gh` is signed in to.

## Install

Requires [Bun](https://bun.sh) 1.3.14 or newer (`bun upgrade`) and `git`, plus the GitHub CLI signed in with `gh auth login`.

```
bun add -g stk-pr
stk doctor        # checks gh, auth, rate limits, cache dirs and repo detection
```

From a clone: `bun install && bun link`, or run `bun src/cli.ts <command>` without linking.

Optional pieces, each used by one feature and hidden or reported by `stk doctor` when missing:

| Tool | Used for |
| --- | --- |
| [`gh-stack`](https://github.com/github/gh-stack) (`gh extension install github/gh-stack`) | Rebasing and creating native GitHub stacks |
| Tern terminal | The Session scope, `:fix` and the launcher plugin in `plugin/` |
| omp coding agent | Session transcripts for the Session scope, and the agent started by `:fix` |

Everything else works with only `gh` and `git`. Outside Tern there is no Session tab and `:fix` reports that it needs Tern.

## Configuration

| Variable | Meaning |
| --- | --- |
| `STK_ROOTS` | Colon-separated directories searched for local clones of a PR's repo. Default: `~/projects`, `~/src`, `~/code`, `~/dev`. |
| `STK_PREFS_FILE` | Preferences file. Default `$XDG_CONFIG_HOME/stk/prefs.json` (`~/.config/stk/prefs.json`): last board tab and merge method per repo, notification mode, reduced motion. |
| `STK_OPEN` | Command used to open URLs. Default: the system opener. |
| `STK_ASCII` | Set to use ASCII glyphs instead of Unicode symbols. |
| `STK_REDUCED_MOTION` / `NO_MOTION` | Disable animation. |
| `STK_JOBS_DIR` | Where merge jobs are recorded. Default `~/.cache/stk/jobs`. |
| `STK_OMP_SESSIONS` | omp transcript directory for the Session scope. Default `~/.omp/agent/sessions`. |
| `STK_PUSH_COMMANDS` | Comma-separated names of wrapper scripts that run `gh pr create`; PR URLs in their output count as created in a session. |
| `STK_WATCH_COMMANDS` | Comma-separated names of PR-watching commands taking `owner/repo#N` or `N`; PRs they name count as acted on in a session. |
| `STK_CMD` | Read by the Tern plugin, in Tern's own environment: the command that starts stk. Default `stk`. |

## Terminal UI

```
stk
stk tui [--repo DIR] [--pr N] [--gh OWNER/NAME] [--session-pane ID]
```

With no command, `stk` starts the UI. `--pr N` opens that PR directly and `--gh OWNER/NAME` picks the repo by slug (no local clone needed). `--session-pane ID` adds a Session scope for that Tern pane.

### Workspace board

Started outside a GitHub repo (in a folder of clones, say `~/projects`), stk scans the directory up to 3 levels deep for git checkouts and linked worktrees (reading `.git/config`, with no git process per directory; dot-dirs, `node_modules` and `archive/` are skipped), maps each to its GitHub slug and folds worktrees into their repo. The board then spans all of them: Mine and Review requests run one list query per repo per refresh, and every row carries its repo. `R` or `:repo` picks one repo (fuzzy) and `:repo all` returns.

The board has three repo scopes (Mine, Review requests, All) and, inside Tern or with `--session-pane`, a Session scope. PR data loads per PR; a file's diff is fetched only when that file is opened, and commit history only when its section is expanded.

Large boards keep the same continuous list and search across all loaded PRs: cursor movement reuses unchanged rows rather than rebuilding every PR row. Board refreshes fetch branch rules and unresolved-thread counts concurrently; initial loading still waits for GitHub's PR list and readiness data.

### Images

An image standing on its own line in a PR description, comment, review or review thread (`![alt](url)`, or an `<img>` / `<picture>` optionally wrapped in `<a>` or `<p align>`) is drawn in the page, at most about 100 columns wide and 30 rows tall, never larger than its own size. Until it arrives the row reads `▣ alt · loading image`; if it cannot be shown it reads `▣ alt · 404` (or `unsupported`, `timeout`, `too large`). PNG, JPEG, WebP, GIF and SVG work; SVGs are rendered on a white background (diagrams are usually authored for GitHub's light page) with your system fonts, in a worker so the UI never stalls. Images inside `<details>` appear when the details are open, collapsed one-line rows never show them, and a drawn image counts as one line toward the description's `N lines` and the 8-line cap.

Drawing uses the terminal's graphics: the kitty protocol (kitty, Ghostty, WezTerm, Tern), else sixel, else half-block cells; inside tmux it falls back to half-blocks. Badges (shields.io and similar), bot buttons (`Fix in Cursor`, `Open in Web`, Devin Review, …), `P1`-style severity pills and images inline in prose are not drawn, as before.

Private images go through `gh`: `github.com/<owner>/<repo>/blob/<ref>/<path>` and `raw.githubusercontent.com` URLs (the usual way a diagram committed to a private repo is embedded) are read with `gh api repos/<owner>/<repo>/contents/<path>?ref=<ref>`, and `github.com/user-attachments/assets/...` uploads are fetched with the token from `gh auth token` (sent to GitHub only, not to the storage host GitHub redirects to; held in memory, never written or logged). Other `https` images are fetched directly. Results, failures included, are cached for the session, so a broken link is not retried on every redraw.

### Keys

`?` opens the same list in the UI.

Everywhere:

| Key | Action |
| --- | --- |
| `?` | Help |
| `r` | Refresh |
| `:`, `ctrl-k` | Go to PR / run a command. Type a title, `#123`, `owner/repo#9` or a PR URL; or a command (`merge`, `approve`, `request changes`, `comment`, `close pr`, `reopen pr`, `ready for review`, `convert to draft`, `rerun failed checks`, `copy branch`, `copy url`, …) that acts on the PR page's PR or the selected board row. Close and convert-to-draft ask first. Searches loaded PRs only; the last row searches GitHub on request. |
| `/`, `n`, `N` | Search this page (line at the bottom), next / previous match |
| `q` | Quit |
| `esc` | Close sheet / back |
| `h`, `backspace` | Back (PR screen) |

Board:

| Key | Action |
| --- | --- |
| `⏎`, `l` | Open PR |
| `1` `2` `3`, `tab` | Switch scope (`shift-tab` goes backwards) |
| `/` | Filter by title, branch, number |
| `w` | Worktree sheet |
| `o` | Open PR in the browser |
| `S` | Merge stack (when the PR is stacked) |
| `d` | Toggle density |

PR:

| Key | Action |
| --- | --- |
| `a` | Approve |
| `x` | Request changes |
| `C` | Comment |
| `c` | Reply to thread |
| `e` | Resolve thread |
| `m` | Merge |
| `M` | Force merge |
| `t` | Cycle merge method |
| `S` | Merge stack |
| `w` | Worktree sheet |
| `o` | Open the selected commit, comment or PR in the browser (also click `#n` or `github ↗`) |
| `⏎`, `l` | Toggle the selected section or commit's checks; open a file diff or check log |

Dragging across text with the mouse copies it to the clipboard when you release (via `pbcopy` on macOS, OSC 52 over SSH). The first click on an item moves the cursor to it; clicking it again opens or toggles it, and a one-cell slip still counts as a click. Dragging never toggles anything, so drag to select text in a comment without collapsing it.

In Activity, each person's name is in their own colour (the PR author in blue), with a matching rail down their expanded comments and the findings under their reviews. Bots are dimmed. Two or more bot comments in a row fold into one `▸ N bot comments` row (open it with `⏎` or `za`). A bot review with an open finding, or a thread still open, is never folded.

Commits starts collapsed beneath Activity. Expand it with `⏎`, a second click or `zo` to load chronological subjects, short SHAs, authors and per-commit check summaries. Expand a commit to see passing, failing, pending and skipped checks; `⏎` on a check opens its logs and `o` on a commit opens GitHub. Loaded commits and checks participate in `/` search, and `za/zo/zc` and `zR/zM` control their folds. History refreshes with successful PR-detail loads only while its section is expanded and mounted; collapsing it or leaving the page stops history polling but retains its cache. A changed head invalidates stale results. Known GitHub cooldowns pause history requests, including retries, and show a local error until reset.

Checks is explicitly for the current head. A missing repository-required context appears as **expected**, not passing; skipped or absent results are never labeled “all passing.” Commit-history results are historical and do not establish merge readiness for a rebased head.

Diff and lists use vim motions:

| Key | Action |
| --- | --- |
| `j` `k` / `↓` `↑` | Move (`5j` takes a count). On a PR page `↓` `↑` scroll the page instead and only `j` `k` move between items |
| `gg` `G` | Top / bottom (`12G` goes to line 12) |
| `ctrl-d` `ctrl-u` | Half page down / up |
| `ctrl-f` `ctrl-b` | Page down / up |
| `l` `⏎` | Open |
| `h` `esc` `⌫` | Back |
| `{` `}` | Previous / next section |
| `/` `n` `N` | Search, next, previous match |
| `]f` `[f` | Next / previous file (diff) |
| `]c` `[c` | Next / previous hunk (diff) |
| `za` `zo` `zc` | Toggle / open / close fold |

Sheets (force merge, review, stack, worktree):

| Key | Action |
| --- | --- |
| `⏎` | Confirm |
| `⌘⏎` | Confirm force merge |
| `t` | Merge method |
| `f` | Force (stack sheet) |
| `j` `k` | Options / scroll |
| `i`, `esc` | Edit text / leave edit |

### Command palette

`:` or `ctrl-k` opens the palette: go to a PR by title, `#123`, `owner/repo#9` or URL, or run a command on the open or selected PR: `merge`, `merge stack`, `approve`, `request changes`, `comment`, `close pr`, `reopen pr`, `ready for review`, `convert to draft`, `update branch`, `base` (retarget), `rebase stack`, `create GitHub stack`, `rerun failed checks`, `open in github`, `copy branch`, `copy url`, `worktree`, `fix` (hand a thread or failing check to an omp agent in a new Tern tab).

### Merge when ready

`:merge-when-ready` (also `:auto-merge`) on an open PR starts a detached job that waits for what blocks it (pending checks, missing review, open threads) and then merges through the normal path. It never bypasses anything and never uses `--force`. It polls every 60 s, pauses while GitHub rate limits, and gives up after 24 h, or at once when a conflict, requested changes, failing checks, a draft or a closed PR makes waiting pointless; the job then fails with the reason. On a PR in a stack it waits for the stack plan up to that PR and lands it with the PRs below. The dock shows `● waiting to merge #2391 · checks pending`; `:cancel-merge` stops it. Other entry points: `w` in the merge sheet (`m` on a PR blocked only by things that can clear) and the stack sheet's "Merge when ready" button (`w`) when the plan stops on pending or missing checks; `c` there cancels the wait.

### Notifications

While the TUI runs, every board, session and PR refresh is compared with the previous one for each PR you own or review. A toast like `widgets #2391 · checks passed` appears when checks finish (pass or fail), a review arrives (approved, changes requested or commented, with its author), the PR becomes mergeable, it is merged or closed by someone else, or a new unresolved thread appears. No extra GitHub requests are made for this. With the terminal unfocused the event is posted as a macOS notification instead (`osascript`, title "stk"), and the board keeps refreshing while unfocused so the notification can arrive. The `notify` preference (`toast`, `system` or `off`; unset = toast when focused, system when not) is set from the palette. Several stk panes announce an event once: the first one claims it in `~/.cache/stk/notified` (override with `STK_NOTIFIED_DIR`).

### Session view (optional, needs Tern)

`stk session [--pane ID]` (default `$TERN_PANE`) lists the PRs mentioned in a Tern pane's agent session, grouped Open / Merged / Closed across repos. It reads the omp transcript (`<STK_OMP_SESSIONS>/<cwd-slug>/*.jsonl`) whose title matches the pane title in `tern ls --json`; if none matches, it falls back to `tern capture <pane> --scrollback`. The UI shows the same thing as the Session scope, which only exists when stk runs inside Tern (or gets `--session-pane`).

Each PR's repo is mapped to a local clone by `src/repos.ts`, searching `$STK_ROOTS`, and cached in `~/.cache/stk/repos.json`. With no local clone the PR opens repo-less: reading, reviewing and merging work through `gh -R`, but worktree and stack actions ask you to set `STK_ROOTS`.

## CLI

```
stk [--repo DIR] [--json] <command>
```

| Command | What it does |
| --- | --- |
| `prs [--mine\|--review\|--all]` | List open PRs with blockers. Default `--mine`. |
| `pr <n> [--patches]` | PR, blockers, review threads, files, stack. |
| `diff <n> [--file PATH]` | Per-file diffs with patches. |
| `open <n> [--create]` | Find the worktree for the PR branch; `--create` makes one if missing. |
| `review <n> (--approve\|--request-changes\|--comment) [-m BODY]` | Submit a review. |
| `reply <threadId> -m BODY` | Reply to a review thread. |
| `resolve <threadId>` | Resolve a review thread. |
| `merge <n> [--method squash\|merge\|rebase] [--force] [--dry-run]` | Merge a PR. Default method is squash. `--dry-run` reports what would happen. |
| `stack <n> [--merge] [--force] [--method M]` | Show the stack merge plan, or run it with `--merge`. |
| `jobs [--gh OWNER/NAME]` | Recent merge jobs. |
| `session [--pane ID]` | PRs mentioned in a Tern pane's agent session. |
| `doctor` | Check the environment; exit 1 on a failure. |

`--json` prints one line: `{"ok":true,"data":...}` or `{"ok":false,"error":{"code","message"}}`.

### What `--force` bypasses

`--force` merges through GitHub's merge-async API with `bypass_rules: true`. That bypasses failing or pending checks, missing review, and unresolved threads, as far as your repository permissions allow. It never bypasses a merge conflict or a draft PR; those still block. Every merge runs as a detached job (`stk jobs`), so it keeps going after you close the TUI.

## Stack merge

`stk stack <n>` prints the plan. `stk stack <n> --merge` runs it, stopping at the first failing step. The plan merges the stack bottom-up and ends before the first PR that is blocked (or has a conflict or draft, even with `--force`). The bottom PR is merged directly. Before any step runs, every restack is preflighted: origin must still be at the PR head recorded when the plan was made, and the local branch tip must equal it or be an ancestor of it. A stale clean local branch is fast-forwarded; a branch that is ahead or diverged is refused (`diverged`), so a bad branch cannot leave a half-merged stack.

The stack sheet draws the stack top PR first with the base branch at the bottom (`main ← #2462 ← #2463`), numbers the merge order, marks the PR it was opened from, and gives each PR one status: approved, ready, needs review, failing checks, conflicts or draft (`will bypass` once force covers it). One sentence says what will happen (`Merges #2462 into main, then #2463, squashing each; bypasses review on both.`), and each plan step says why it is there. On a native stack, every merge after the first is preceded by a rebase of the PRs above it (`gh stack`), because GitHub leaves them on the merged branch and will not let their base be changed. That rebase runs in a worktree of the branch: a worktree on a detached HEAD at the branch's current tip (what agents leave behind) counts, and is switched to the branch first. When no worktree has it, `c` in the sheet creates one. An error is shown once, in full, and `r` plans again.

For each PR above it:

1. Retarget the PR from its parent branch to the trunk.
2. Restack (skipped with `--method merge`): fetch, then `git rebase --onto origin/<trunk> <old-parent-head> <branch>`. If the branch is checked out in a worktree, that worktree is used and must be clean; otherwise a temporary worktree is used and removed. A conflict aborts the rebase and stops the run.
3. Push with `--force-with-lease=refs/heads/<branch>:<sha>`, where `<sha>` is the remote head recorded when the plan was made, then verify with `git ls-remote` that origin matches the local tip.
4. Wait for checks on the newly pushed SHA (up to 30 minutes), including required contexts that have not registered yet. Passing results from the previous head cannot satisfy this wait.
5. Merge it (with `--admin` if `--force` and it has bypassable blockers).

A GitHub-native stack lands as one merge when nothing needs bypassing. With `--force`, GitHub only lets rules be bypassed on the bottom-most unmerged PR, so each PR that needs a bypass is merged alone. Before any split forced merge, stk preflights the local checkout, the gh-stack extension, and clean checked-out worktrees for every remaining selected PR branch (`stk worktree <n>`); it also refuses dirty worktrees on upper branches the rebase would touch. Between those separate merge calls stk re-reads the stack from GitHub, rebases the remaining PRs onto the trunk with `gh stack rebase` and `gh stack push` when they are still on the merged branch, waits while GitHub is still checking the next PR for conflicts (a landed merge changes its base, and GitHub may restack it itself), plans again so the next merge pins the current head SHA, and continues until the target PR lands. A conflict check that hasn't finished after about 12 seconds, a rebase conflict, or a PR that is no longer mergeable stops the run with the reason; prerequisites are checked again before each rebase. Merging only part of a stack leaves PRs above the selected target unmerged; use `:rebase-stack` if their base has merged.

## Tern plugin (optional)

`plugin/` is a small launcher for the Tern terminal; stk works fine without it. Link it with `tern plugin link <path-to-stk>/plugin`. It needs `stk` on Tern's PATH, or set `STK_CMD` (for example `bun /path/to/stk/src/cli.ts`) in Tern's environment. Each command opens the UI in a split beside the focused pane (a new tab if the split fails).

| Command | Action |
| --- | --- |
| `stk: PR board` | Open the board for the focused pane's repo, or focus the stk pane already running there. |
| `stk: Session PRs` | Open the UI on the focused pane's session PRs. |
| `stk: Open PR…` | Prompt for a PR number and open it. |
| `stk: Toggle OMP restyle` | Load or unload `omp.css`, a restyle of omp's pane; the choice persists. |

GitHub PR links (`https://github.com/<owner>/<repo>/pull/<n>`) clicked in any pane open in stk, with the clicked pane as the session pane. Option-click keeps the browser.

## Worktrees

If a worktree already exists for a PR's branch, stk uses it and never fetches or checks out anything. `stk open <n> --create` (and `w` in the UI, after confirm) fetches the branch and runs `git worktree add` under `<repo>/../.stk-worktrees/<branch>`, with `/` in the branch name replaced by `-`.

## Development

```
bun test
bun run typecheck
```

After editing `plugin/`, run `tern plugin reload`.

## Release

Bump `version` in `package.json` in a PR and merge it. The `Publish` workflow then publishes to npm (trusted publishing, no token) and tags `v<version>`; a push to `main` without a version bump skips publishing.

- From npm: `bun update -g stk-pr`.
- From GitHub: `bun add -g github:aidanhchau/stk-pr` installs the current `main`. If `stk-pr` was installed from npm, run `bun remove -g stk-pr` first: with both a registry package and a GitHub install of the same name, bun fails with a DependencyLoop error.

## License

MIT, see [LICENSE](LICENSE).
