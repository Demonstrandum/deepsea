# dsd — the DeepSea developer CLI

**Status: stage 1 implemented** (shared harness builds, `link`, throwaway
servers, `stop`, `list`, `gc`); everything else below is design. See
"Implementation order".

`dsd` builds, runs, inspects and drives DeepSea variants (LAYOUT.md §1), and
runs the topic-branch workflow. It is a command-line program for developers
and agents (`bash`), not a tool the model calls.

```
pnpm dsd <command> …        # inside the repository
pnpm link --global          # once, to put `dsd` on PATH
```

`dsd` resolves the checkout it lives in from its own path, so it works from
any directory, and a copy in a topic worktree acts on that worktree. Output
for programs is JSON on stdout; messages go to stderr; a failure exits
non-zero with a one-line reason (2 for a usage error). Plain Node, no
dependencies, so it runs on a fresh checkout before anything is installed.

Environment: `DEEPSEA_ROOT` (default `~/.deepsea`) and `DEEPSEA_LOG_ROOT`
(LAYOUT.md §5) move everything dsd writes, for tests and sandboxes.

## Variants

A variant is defined by `~/.deepsea/<v>/variant.yml`, written by `dsd new`:

```yaml
id: personal
display: DeepSea Personal        # derived; "DeepSea" for release
color: "#30A46C"                 # app glyph and title tint
ports: 3210                      # first port of its block (LAYOUT.md §7)
source: topic/base               # a commit or ref, run as an immutable build
plugins: all                     # or a list of plugin names
serve: true                      # Tailscale Serve path /deepsea-personal/
```

**Throwaway variants** (`--throwaway…`) are copies of a named variant's
configuration with a fresh id `<parent>-<hex>` and an empty home. They take
free ports, have no Serve path, no LaunchAgent and no LaunchServices
registration, and their app uses a non-persistent WebKit store, so removing
the home and the temporary build directory removes everything. A throwaway
runs the shared build of the pinned harness commit (`--source <ref>` takes the
pin from a commit of this repository, `--harness <ref>` names a harness
commit) and loads plugins in place from the checkout dsd runs in, so a topic
worktree's dsd tests that worktree's plugins as they are, and a rebuilt
client bundle hot-swaps into the open page. `--plugins <names|all>` selects
them: each plugin's own bundle patch, its package name replaced by the
absolute path of its entry module, is passed to the server; a plugin never
installed or built is installed and built first. `all` leaves machine-wide
plugins (plugins/AGENTS.md) out; naming one includes it.

`--scripted` loads `plugins/scripted-model` and makes its `scripted/script`
model the throwaway's default: every prompt is then a JSONL script of the
exact reply (text, reasoning, tool calls, usage, provider errors), so a
throwaway can run real turns, tool calls and their UI with no API key and
the same result every time (plugins/scripted-model/README.md).

## Builds

Variants run immutable builds, one per commit, in `~/.deepsea/_builds/`
(LAYOUT.md §2): `harness-<commit>/` and `deepsea-<commit>/`. `dsd` makes a
build once, under a lock, and never rebuilds one in place; moving a variant
to a new commit is a stop and a start. A checkout's `harness` link points at
the build of the commit its `harness.lock` pins (`dsd link`), so plugin
topics never build the harness themselves. `dsd gc --builds` removes builds
nothing uses.

A harness build is a detached worktree of the harness repository at
`harness-<12 hex>/`, then `pnpm install --frozen-lockfile` and `pnpm run
build`. Beside it, `harness-<12 hex>.json` records `building`, `ready` or
`failed` (only `ready` is used) and `harness-<12 hex>.lock/` holds the
builder's pid: a second agent waits, and a lock whose process is gone is
taken over. Build logs: `~/Library/Logs/io.github.taliesinb.deepsea/builds/`.

**Referring to a variant** (every command that takes `<ref>`):

- the full id: `personal`, `personal-3f9a1c`;
- a unique part of a throwaway's hex: `3f9a`;
- nothing, when exactly one throwaway is running; with several, `dsd` stops
  and lists them, so one agent never drives another's throwaway.

## Commands

| Command | Does |
|---|---|
| `dsd new <v> [--from <v>] [--color <hex>] [--source <ref>]` | create a named variant: home, `variant.yml`, port block, and the home's `logs` / `support` / `source` links (LAYOUT.md §4) |
| `dsd build <v> [--install \| --throwaway]` | make sure the builds of its source exist, then build its apps (client, server host, relay) from `apps/macos`; `--install` installs them (LAYOUT.md §6); `--throwaway` builds the apps into a temporary directory |
| `dsd run <v> [--throwaway \| --throwaway-app \| --throwaway-server] [--detach] [--scripted] [--plugins <names\|all>] [--source <ref>] [--harness <ref>] [--keep]` | start it, building first if needed (a throwaway always gets plugins/test-driver); prints id, home, URL, login URL (with token), pids, log, app path, automation socket. `--source` takes the harness pin from a commit of this repository; `--harness` names a harness commit directly |
| `dsd stop [<ref>] [--keep]` | stop it; a throwaway's home, logs and macOS leftovers are removed unless `--keep` |
| `dsd list [--builds]` | variants, what is running, ports, ids; with `--builds`, the builds and what uses each |
| `dsd logs <ref> [app \| relay \| server \| plugin <name>] [--follow]` | the current run's log |
| `dsd gc [--builds] [--dry-run]` | remove throwaways: the caller's own once stopped, another agent's once stopped for an hour, any past its time limit (with macOS leftovers); with `--builds`, also builds nothing uses |
| `dsd builds [list \| make [<harness ref>]]` | list builds, or make one (default: the pinned commit) |
| `dsd link` | point this checkout's `harness` at the build of its pinned commit, building it if needed |
| `dsd drive [-v <ref>] <op> …` | one operation on a running throwaway, as JSON (below) |
| `dsd script <file.mjs> [-v <ref>]` | run a script with the same operations as a JS API |
| `dsd topics [list]` | both repositories' topics: parents, commits, what each requires, how far behind; `check`, `integrate`, `rebase` not built yet |
| `dsd worktree add <topic> [--from <ref>] \| list \| remove <topic>` | a topic's worktree in `<repo>-worktrees/<topic>/`: branch `topic/<topic>` (from `topic/base`), `harness` link, pre-commit check; `remove` refuses uncommitted changes and keeps the branch |
| `dsd check [--staged \| <rev range>] [--install-hook]` | scan added lines for local paths, private addresses, tailnet names, email addresses and `private/check-patterns.txt`; the pre-commit hook runs `--staged` |

`run` modes:

| Mode | Runs |
|---|---|
| (none) | the installed named variant: its LaunchAgent and app |
| `--throwaway` | server, relay and app, as child processes |
| `--throwaway-app` | server and app (connected straight to the server), no relay |
| `--throwaway-server` | server only: in the foreground until Ctrl-C, SIGTERM or the server's exit, then cleaned up; with `--detach`, until `dsd stop`, or `dsd gc` after `--ttl` minutes (default 120) |

A throwaway's home holds `variant.yml` (id, parent, harness commit, the
creating agent's session and checkout, the expiry of a detached one),
`run/state.json` (pid, port, URL, token, log; 0600), a web profile patch
that turns telemetry and the first-run API-key dialog off and puts the
default workspace inside the home, `settings.yaml`
acknowledging the first-run notice, and the `logs` and `source` links (LAYOUT.md §4).

Rules:

- `run` refuses a variant that is running in any form (server port, relay
  job, app process with its bundle id).
- No server starts from a tree that is being built: named variants run
  immutable builds, and a worktree source is refused while a build runs in
  it.
- Readiness is the server's own report, never a fixed sleep (stage 1: the
  launch URL in its log, then an HTTP answer).
- dsd signals a process only while its command line still matches what dsd
  started, so a recycled pid is never signalled.
- `--plugins` rebuilds a plugin's browser half when its sources are newer
  than `lib/client.js`.
- dsd warns when run inside a different checkout than its own.
- `stop`, `build --install` and `run` refuse the variant hosting the calling
  agent unless `--self`; every operation on a named variant is logged, and a
  second agent's conflicting operation waits for or refuses the first.
- `topics rebase` and `topics integrate` take a lock, and refuse to rewrite
  a topic whose worktree has uncommitted work.
- Throwaway apps start hidden (an invisible window that still renders, never
  taking focus) unless `--visible`.

**Inheriting into a throwaway** (empty by default):

| Flag | Copies |
|---|---|
| `--inherit-sessions "id,…" \| "*"` | those sessions, the attachments they reference, their workspace entries; `*` reports the size first |
| `--inherit-api-keys "anthropic,…" \| "*"` | stored API keys for those providers |
| `--inherit-logins "anthropic,…" \| "*"` | sign-ins, access token only: the throwaway works until it expires (hours). Copying the refresh token would let the throwaway's first refresh sign the parent out (providers rotate it), so that needs `--allow-refresh` |

## Driving a throwaway

`dsd drive` routes each operation to the layer that can do it; the caller
does not choose. Without `-v`, it drives the caller's one running throwaway.

| Layer | Operations |
|---|---|
| Server driver (plugins/test-driver, loaded into every throwaway; done) | `health`, `create-session`, `prompt`, `wait`, `command`, `events`, `cancel`, `sessions`, `invoke`, `url` |
| App automation socket (`apps/macos`, throwaway apps only) | `load`, `reload`, `wait-page`, `eval`, `resize`, `view desktop\|mobile`, `appearance light\|dark`, `click`, `type` (real input events in the app's own window), `describe`, `snapshot` (element or window), `window-info`, `quit` |
| Page helpers (test-driver plugin, browser half) | `open-session`, `new-session`, `archive`, `select-model`, `set-mode`, `enter`, `submit`, `last-card`, `list-sessions` |

The server driver's operations:

| Operation | Does |
|---|---|
| `health` | pid, port, home, uptime, loader rows that failed or are stuck |
| `create-session [--cwd <dir>] [--preset <p>] [--model <provider/model[:effort]>] [--title <t>]` | a new session; its id is also remembered as `last` |
| `prompt <session> <text \| -> [--no-wait] [--steer] [--timeout <s>]` | send a prompt (`-`: from stdin, e.g. a scripted-model script) and, unless `--no-wait`, wait for the turn and summarize it: text, reasoning, tool calls with outcomes and output, command results, how the turn ended |
| `wait <session> [--since <seq>] [--timeout <s>]` | wait for the agent to go idle, then summarize from `since` |
| `command <session> <line>` | run a slash command; its result |
| `events <session> [--since <seq>] [--types <a,b/*>] [--limit <n>]` | raw session events |
| `cancel <session>`, `sessions`, `invoke <namespace> <method> [<json>]`, `url` | cancel a turn; the session list; any gateway method; the login URL |

`<session>` is an id or `last`. `prompt` and `wait` exit 3 when the turn
ended with an error (a failed scripted `expect`, say) and 4 when the wait
timed out, so a shell script can test a turn by its exit status. The plugin's
README has the HTTP operations and the safety rules (throwaway homes only,
loopback, a per-process token, no browser origin).

A throwaway started with `--throwaway-server` has no app; window operations
fail with "no app in this throwaway".

## Implementation order

1. Shared builds (`_builds/`, the build lock, the `harness` link),
   `run --throwaway-server` with `--plugins` and the machine-wide rule,
   `stop`, `list`, `gc` with ownership and time limits, `worktree`,
   `topics list`, `check`, `--scripted`, `drive` with the test-driver's
   server half (done). This comes first, before agents work on topics in
   parallel.
2. `apps/macos` builds, `run --throwaway-app`, the automation socket, the
   app and page operations of `drive`, `script`.
3. Named variants: `new`, `build --install`, `run`.
4. `topics check | integrate | rebase`, `exec` (commands in a build with a throwaway home).
