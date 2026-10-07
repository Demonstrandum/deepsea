# dsd — the DeepSea developer CLI

**Status: design, not implemented yet.**

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
non-zero with a one-line reason.

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
runs the parent's build unless given `--source <commit | worktree path>`; a
worktree source runs in place, so a plugin under development can be rebuilt
and reloaded. Plugins that declare themselves machine-wide
(plugins/AGENTS.md) are left out unless `--with <name>`.

## Builds

Variants run immutable builds, one per commit, in `~/.deepsea/_builds/`
(LAYOUT.md §2): `harness-<commit>/` and `deepsea-<commit>/`. `dsd` makes a
build once, under a lock, and never rebuilds one in place; moving a variant
to a new commit is a stop and a start. A topic worktree's `harness/` is the
build of the harness commit it pins, so plugin topics never build the
harness themselves. `dsd gc` removes builds nothing uses.

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
| `dsd run <v> [--throwaway \| --throwaway-app \| --throwaway-server]` | start it, building first if needed; prints id, home, URL, token, pids, app path, automation socket |
| `dsd stop <ref> [--keep]` | stop it; a throwaway's home and build are removed unless `--keep` |
| `dsd list [--builds]` | variants, what is running, ports, ids; with `--builds`, the builds and what uses each |
| `dsd logs <ref> [app \| relay \| server \| plugin <name>] [--follow]` | the current run's log |
| `dsd gc` | remove throwaways whose processes are gone, their macOS leftovers, and builds nothing uses |
| `dsd drive [-v <ref>] <op> …` | one operation on a running throwaway (below) |
| `dsd script <file.mjs> [-v <ref>]` | run a script with the same operations as a JS API |
| `dsd topics check \| integrate \| rebase` | topic branches (AGENTS.md) |
| `dsd worktree add \| list \| remove <topic>` | topic worktrees in `<repo>-worktrees/` |

`run` modes:

| Mode | Runs |
|---|---|
| (none) | the installed named variant: its LaunchAgent and app |
| `--throwaway` | server, relay and app, as child processes |
| `--throwaway-app` | server and app (connected straight to the server), no relay |
| `--throwaway-server` | server only, in the foreground; cleaned up when the command exits |

Rules:

- `run` refuses a variant that is running in any form (server port, relay
  job, app process with its bundle id).
- No server starts from a tree that is being built: named variants run
  immutable builds, and a worktree source is refused while a build runs in
  it.
- Readiness is the server's own report, never a fixed sleep.
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
does not choose.

| Layer | Operations |
|---|---|
| App automation socket (`apps/macos`, throwaway apps only) | `load`, `reload`, `wait`, `eval`, `resize`, `view desktop\|mobile`, `appearance light\|dark`, `click`, `type` (real input events in the app's own window), `describe`, `snapshot` (element or window), `window-info`, `quit` |
| Page helpers (test-driver plugin, browser half) | `open-session`, `new-session`, `archive`, `select-model`, `set-mode`, `enter`, `submit`, `last-card`, `list-sessions` |
| Server driver (test-driver plugin, host half; throwaway homes only) | `health`, `create-session`, `command`, `prompt --wait`, `events` |

A throwaway started with `--throwaway-server` has no app; window operations
fail with "no app in this throwaway".

## Implementation order

1. Shared builds (`_builds/`, the build lock, worktree `harness/` from a
   build), `run --throwaway-server`, `stop`, `list`, `gc`, the machine-wide
   plugin rule, and the test-driver's server half. This comes first, before
   agents work on topics in parallel.
2. `apps/macos` builds, `run --throwaway-app`, the automation socket,
   `drive`, `script`.
3. Named variants: `new`, `build --install`, `run`.
4. `topics` and `worktree`.
