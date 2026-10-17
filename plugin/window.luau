--!strict
-- stk window half: launches the stk TUI (standalone terminal app) in a split beside the focused
-- pane, plus the optional omp restyle. All PR logic lives in the CLI.

-- The command that starts stk: `stk` on the login shell's PATH (install with `bun link` or `bun add -g`),
-- or whatever STK_CMD says in the Tern daemon's environment (e.g. "bun /path/to/stk/src/cli.ts").
local STK = tern.getenv("STK_CMD") or "stk"
local RESTYLE_KEY = "omp_restyle"
local RESTYLE_SHEET = "omp"

local function focused_pane(cx: WindowCx): (number?, string?)
	local id = cx.session:focused()
	for _, pane in cx.session:panes() do
		if pane.pane == id and pane.cwd ~= nil and pane.cwd ~= "" then return id, pane.cwd end
	end
	return nil, nil
end

-- Nearest ancestor with a .git (file in worktrees, dir in clones); falls back to dir so the
-- CLI can show its own "not a git repository" error.
local function repo_dir(dir: string): string
	local at = dir
	while at ~= "" and at ~= "/" do
		local ok, found = pcall(tern.fs.exists, at .. "/.git")
		if ok and found then return at end
		at = string.match(at, "^(.*)/[^/]*$") or ""
	end
	return dir
end

local function sh_quote(s: string): string
	return "'" .. string.gsub(s, "'", "'\\''") .. "'"
end

local function tui_command(repo: string, pr: number?): string
	local line = STK .. " tui --repo " .. sh_quote(repo)
	if pr then line = line .. " --pr " .. tostring(pr) end
	return line
end

-- A pane already running the stk TUI for this repo (program is bun/stk, or the TUI set a title
-- containing "stk"), in the repo dir.
local function existing_tui(cx: WindowCx, repo: string): number?
	for _, p in cx.session:panes() do
		local cwd = p.cwd or ""
		if cwd == repo and not p.parked then
			local program = string.lower(p.program or "")
			local title = string.lower(p.title or "")
			if program == "stk" or string.find(title, "stk", 1, true) then
				return p.pane
			end
		end
	end
	return nil
end

-- Since Tern 0.9.0, cx.layout:split returns nil and cx.layout:close does nothing for panes opened after the
-- session daemon's handover (the window's plugin API doesn't know their ids), while the `tern` CLI still finds
-- them, under the pane id or that id plus the host bit (2^44). `tern split` on an unknown id still spawns a
-- detached shell, so `tern inspect` picks the id first. Plugin processes don't inherit the app's PATH, so
-- prefer the binary inside the app bundle.
local TERN_APP_BIN = "/Applications/Tern.app/Contents/MacOS/tern"
local TERN_BIN = if tern.fs.exists(TERN_APP_BIN) then TERN_APP_BIN else "tern"
local HOST_BIT = 2 ^ 44

local function cli_failure(result: ProcessResult): string
	local why = string.gsub(result.stderr, "%s+$", "")
	return if why ~= "" then why else "tern exited " .. tostring(result.status)
end

-- Finds the id the `tern` CLI knows `pane` by (the pane id or that id plus the host bit); `done(block, why, cx)`
-- gets nil and the reason when there is none. tern.process.run raises when the binary can't be spawned; that is
-- reported through `done` too (with `cx`).
local function cli_block(cx: WindowCx, pane: number, done: (number?, string, WindowCx?) -> ())
	local started, err = pcall(tern.process.run, { TERN_BIN, "inspect", "--json" }, { timeout_ms = 10000 }, function(found: ProcessResult, fcx: WindowCx?)
		local ok, parsed = pcall(tern.json.decode, found.stdout)
		if found.status ~= 0 or not ok then return done(nil, cli_failure(found), fcx) end
		for _, info in parsed.panes or {} do
			if info.pane == pane or info.pane == pane + HOST_BIT then return done(info.pane, "", fcx) end
		end
		done(nil, "no such pane in tern inspect", fcx)
	end)
	if not started then done(nil, tostring(err), cx) end
end

-- Runs a Tern CLI command asynchronously; only its result is handled on the window thread.
local function run_cli(cx: WindowCx?, args: { string }, done: (boolean, string, WindowCx?) -> ())
	local argv = { TERN_BIN }
	for _, arg in args do table.insert(argv, arg) end
	local ran, err = pcall(tern.process.run, argv, { timeout_ms = 10000 }, function(result: ProcessResult, ncx: WindowCx?)
		done(result.status == 0, if result.status == 0 then "" else cli_failure(result), ncx)
	end)
	if not ran then done(false, tostring(err), cx) end
end

-- Runs `tern <build(block)>` against `pane`; `done(ok, why, cx)` gets the verdict.
local function tern_cli(cx: WindowCx, pane: number, build: (string) -> { string }, done: (boolean, string, WindowCx?) -> ())
	cli_block(cx, pane, function(block: number?, why: string, fcx: WindowCx?)
		if block == nil then return done(false, why, fcx) end
		run_cli(fcx, build(string.format("%d", block)), done)
	end)
end

local function split_args(block: string, launch: Launch): { string }
	local args = { "split", block, "right" }
	if launch.cwd then
		table.insert(args, "--cwd")
		table.insert(args, launch.cwd)
	end
	for _, arg in { "--", tern.getenv("SHELL") or "/bin/zsh", "-lic", launch.command or STK } do table.insert(args, arg) end
	return args
end

-- Opens `launch` in a split to the right of `pane`. The window API first; the CLI for panes it doesn't know.
-- Only when neither can split does it open a tab, and says why.
local function split_right(cx: WindowCx, pane: number, launch: Launch)
	if cx.layout:split(pane, "right", launch) ~= nil then return end
	tern_cli(cx, pane, function(block: string): { string }
		return split_args(block, launch)
	end, function(ok: boolean, why: string, ncx: WindowCx?)
		if ok then return end
		local wcx = ncx or cx
		if wcx.layout:new_tab(launch) == nil then
			wcx:toast("error", "Could not open the stk TUI", why)
		else
			wcx:toast("warn", "Opened stk in a new tab: could not split", why)
		end
	end)
end

local function launch(cx: WindowCx, pane: number, repo: string, pr: number?)
	split_right(cx, pane, { cwd = repo, command = tui_command(repo, pr) })
end

-- Launch the TUI beside `pane` with `--session-pane` naming `pane` as the CLI knows it: stk reads the session
-- with `tern capture`, which doesn't know the window API's id for panes opened after the daemon's handover.
-- Use the CLI for the split too: native cx.layout:split can exceed the window callback's budget on a cold
-- shell launch, even from a timer. Recheck the source after inspect; never launch beside a new focused pane.
local function launch_session(cx: WindowCx, pane: number, args: string)
	cli_block(cx, pane, function(block: number?, why: string, fcx: WindowCx?)
		if fcx == nil then return end
		if block == nil then
			fcx:toast("error", "Could not open the stk TUI", why)
			return
		end
		for _, source in fcx.session:panes() do
			if source.pane == pane then
				local id = string.format("%d", block)
				local line = STK .. " tui " .. args .. (if args == "" then "" else " ") .. "--session-pane " .. id
				local launch: Launch = { command = line }
				if source.cwd and source.cwd ~= "" then launch.cwd = source.cwd end
				run_cli(fcx, split_args(id, launch), function(ok: boolean, err: string, ncx: WindowCx?)
					if not ok and ncx then ncx:toast("error", "Could not open the stk TUI", err) end
				end)
				return
			end
		end
	end)
end

-- stk panes (TUI launched by this plugin) close without Tern's "Close this block?" prompt, see the
-- close_pane override below.
local function is_stk_pane(p: PaneInfo): boolean
	local title = string.lower(p.title or "")
	return string.sub(title, 1, 3) == "stk" or string.find(string.lower(p.program or ""), "stk", 1, true) ~= nil
end

-- GitHub PR links (…/pull/N, optional /files, /commits, ?query, #anchor) open in the TUI;
-- ⌥-click keeps the browser. Copy the source pane and arguments, then defer all pane enumeration and
-- process spawning beyond route.link's 50 ms budget; timer callbacks receive a fresh window context.
tern.route.link(function(link: LinkRequest, cx: WindowCx)
	local owner, name, num = string.match(link.url, "^https://github%.com/([^/]+)/([^/]+)/pull/(%d+)")
	if not owner or not name or not num then return nil end
	if link.mods.alt then return nil end
	local pane: number? = link.pane
	if pane == nil then pane = cx.session:focused() end
	if pane == nil then return nil end
	local args = "--gh " .. sh_quote(owner .. "/" .. name) .. " --pr " .. num
	tern.timer(0, function(freshCx: WindowCx?)
		if freshCx == nil then return end
		for _, source in freshCx.session:panes() do
			if source.pane == pane then
				launch_session(freshCx, pane, args)
				return
			end
		end
		-- The clicked pane was closed before the timer fired; don't launch beside a different pane.
	end)
	return { handled = true }
end)

-- Closing a stk TUI pane skips Tern's confirmation (`tern close` is the raw close; cx.layout:close silently
-- does nothing for panes the window API doesn't know, see tern_cli). The override runs on a 50 ms budget, so
-- the close happens in the CLI's callback.
tern.override("close_pane", function(cx: WindowCx)
	local id = cx.session:focused()
	for _, p in cx.session:panes() do
		if p.pane == id and p.kind ~= "browser" and is_stk_pane(p) then
			tern_cli(cx, p.pane, function(block: string): { string } return { "close", block } end, function(ok: boolean, why: string, ncx: WindowCx?)
				if not ok and ncx then ncx:toast("error", "Could not close the stk pane", why) end
			end)
			return true
		end
	end
	return nil
end)

-- ── commands ────────────────────────────────────────────────────────────────

tern.command({
	id = "board",
	title = "stk: PR board",
	icon = "merge",
	keys = { "alt+cmd+m" },
	run = function(cx: WindowCx)
		local pane, cwd = focused_pane(cx)
		if not pane or not cwd then
			cx:toast("error", "No focused directory", "Focus a terminal inside a repository.")
			return
		end
		local repo = repo_dir(cwd)
		local running = existing_tui(cx, repo)
		if running then
			cx.layout:focus(running)
			return
		end
		launch(cx, pane, repo, nil)
	end,
})

tern.command({
	id = "session-prs",
	title = "stk: Session PRs",
	icon = "merge",
	keys = { "alt+cmd+shift+m" },
	run = function(cx: WindowCx)
		local pane = cx.session:focused()
		if not pane then
			cx:toast("error", "No focused pane")
			return
		end
		launch_session(cx, pane, "")
	end,
})

tern.command({
	id = "open-pr",
	title = "stk: Open PR…",
	icon = "merge",
	run = function(cx: WindowCx)
		local pane, cwd = focused_pane(cx)
		if not pane or not cwd then
			cx:toast("error", "No focused directory", "Focus a terminal inside a repository.")
			return
		end
		local repo = repo_dir(cwd)
		cx:prompt({ placeholder = "PR number", icon = "merge", action = "open" }):next(function(text, _err, ncx)
			if not text or not ncx then return end
			local n = tonumber(string.match(text, "^%s*#?(%d+)%s*$") or "")
			if not n or n < 1 then
				ncx:toast("error", "Not a PR number", text)
				return
			end
			launch(ncx, pane, repo, n)
		end)
	end,
})

local function restyle_source(): string?
	local ok, src = pcall(tern.fs.read, "omp.css")
	if ok and type(src) == "string" then return src end
	return nil
end

local function apply_restyle(on: boolean)
	if on then
		local src = restyle_source()
		if src then tern.css(RESTYLE_SHEET, src) end
	else
		tern.css(RESTYLE_SHEET, "") -- same name replaces: empty source unloads the rules
	end
end

tern.command({
	id = "toggle-omp-restyle",
	title = "stk: Toggle OMP restyle",
	icon = "palette",
	run = function(cx: WindowCx)
		local on = tern.kv.get(RESTYLE_KEY) ~= true
		if on and not restyle_source() then
			cx:toast("error", "omp.css not found", "Expected next to plugin.toml.")
			return
		end
		tern.kv.set(RESTYLE_KEY, on)
		apply_restyle(on)
		cx:toast("info", if on then "OMP restyle on" else "OMP restyle off")
	end,
})

-- Restore the persisted choice in every new window (runs once per plugin per window).
tern.on("window_start", function(_cx: WindowCx)
	if tern.kv.get(RESTYLE_KEY) == true then apply_restyle(true) end
end)

