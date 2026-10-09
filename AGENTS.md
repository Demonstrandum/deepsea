# AGENTS.md — DeepSea

**DeepSea** is a customized DeepSeek Harness (DSH): a fork of DSH kept as
topic branches over upstream releases (`harness/`), plus the plugins, native
apps and tools in this repository. This file is the starting point for agents
working here. Names, identifiers and disk locations are defined in
[LAYOUT.md](LAYOUT.md); plugin conventions in
[plugins/AGENTS.md](plugins/AGENTS.md).

> **Running instances are not yours to change.** You are probably talking to
> the user through a DeepSea or DSH instance running on this machine. Its
> home (`~/.deepsea…`, `~/.dsh…`), its profile patches (`patchReload: live`
> applies edits the moment they are saved), its installed plugin bundles
> (rebuilding one hot-swaps the browser) and its server process are off
> limits unless the user explicitly asks. Trial work goes into a throwaway
> home or a variant the user has named for the purpose.

## Ground rules

- **Remotes.** This repository is public as `taliesinb/deepsea`, the harness
  fork as `taliesinb/deepsea-harness`. Push only when the user asks, following
  the local policy (Commits, below). Topic and integration branches are
  rebased and rebuilt, so their pushes use `--force-with-lease`.
- **Public.** Everything tracked is published: no
  host names, tailnet or MagicDNS names, macOS account names, logins, LAN
  addresses, personal names or `/Users/<login>` paths in code, comments, docs
  or commit messages. Use `<host>`, `<user>`, `<node>.example.ts.net`,
  `/Users/USER/…`, `user@example.com`. Machine-specific facts go in
  `private/`. The one personal name is the copyright holder in `LICENSE`.
- **`private/`** is git-ignored and machine-local: research, handoff notes,
  bookkeeping (for example which commits a topic was assembled from). Never
  reference its contents from tracked files beyond naming a path.
- **Features are plugins.** Change the harness only where no plugin seam
  exists, and then as a topic (below), never as a loose commit.
- **No explanatory text in the UI.** Labels, placeholders, short status lines
  and error messages only; explanations go in the README.
- **Docs own their layer.** A plugin's README owns that plugin; recipes own
  system-level stories; this file owns conventions. Cross-reference, do not
  duplicate.
- **Commits.** Commit only when the user asks. The local policy for commits
  and pushes, if there is one, is the main checkout's `private/AGENTS.md`. Features often require rounds of experimentation from the user to dial in behaviors, and we do not wish these to produce chains of small commits.

## Repository layout

See LAYOUT.md §3. In short: `plugins/<name>/` (one installable package
each), `apps/macos/` and `apps/linux/` (native shells), `tools/dsd/` (the
developer CLI, `dsd`), `tools/` (bootstrap and uninstall),
`recipes/`, `harness.lock` (the harness repository and the commit pinned),
`harness` (git-ignored link to that commit's build), `private/` (git ignored). 

## Topic branches

Both this repository and the harness fork are kept as **topic branches**:

- A topic is one feature or one tight cluster of related plugins, on its own
  branch `topic/<name>`, based on its parent (`topic/base` here; an upstream
  release tag or another topic in the harness).
- `topics.txt` lists the harness topics in merge order with their parents.
  This repository's topics are simply its `topic/*` branches: a topic
  declares the harness topics it needs in its plugins' package.json
  (`"deepsea": { "requires": ["billing-metadata"] }`), so starting a topic
  edits no shared file. `dsd topics` lists both, with what each requires and
  how far it is behind its parent.
- `dsd topics` will also check every pair of topics for conflicts without
  touching a working tree, rebuild the integration branch
  `integration/<harness base>` by merging the topics in order, and
  regenerate generated files (lockfiles, notices, translation records)
  once, at integration (not built yet).
- **Only `topic/base` touches shared files and the harness pin.** Plugin
  topics add their own directories; registries that list plugins or recipes
  are derived by scanning, not edited by hand, so topics do not conflict.
- **`topic/base` is append-only while topics are in progress.** A change to
  base is a new commit, and each topic takes it with a plain `git rebase
  topic/base`; rewriting base would force every topic through `--onto`.
  Folding base's commits into their final form waits until no topic is in
  progress.
- **Final form first.** A topic's commits introduce names, paths and wording
  in their final form. Unless it has already been pushed, a rename or tweak found later should be folded into the
  commit that introduced the thing (`git commit --fixup` /
  `--fixup=amend:`, then `git rebase -i --autosquash`) before the topic is
  considered done, not left as a trailing commit. Consult the user if this rule would involve complex rebasing, affect already-pushed work, or cross multiple topics. 
- Child topics are rebased with `git rebase --onto <new parent> <old parent
  tip> <child>` after their parent is rewritten; otherwise the parent's old
  commits are replayed.
- Work on a topic in its own worktree (LAYOUT.md §2), so agents can work on
  topics in parallel without sharing a working tree.
- **Every commit is scanned** by the pre-commit hook (`dsd check --staged`):
  local account paths, private addresses, tailnet names, email addresses,
  and the machine-local patterns in `private/check-patterns.txt`. A hit
  blocks the commit.

## The plugin model in one page

DSH is a tree of Cordis plugins. A plugin exports `apply(ctx, config)` (or
`{ name, inject, apply }`, or a `Service` subclass); everything it registers
through `ctx` is undone when it unloads; a plugin whose `inject` names a
missing service waits silently. A plugin package may have a browser half
(`./client`, declared by `dsh.client` in package.json) that the web shell
loads as a client plugin and that contributes UI through typed slots. Details
and conventions: [plugins/AGENTS.md](plugins/AGENTS.md).

Authoritative references for the fork of DSH itself, which is rooted in `harness/`:

| Topic | Path |
|---|---|
| First plugin, tools, config, packaging | `docs/user/develop/basic/` |
| Services and events | `docs/user/develop/framework/` |
| Cordis tutorial / primer / API | `docs/cordis-tutorial/`, `docs/cordis-primer.md`, `docs/cordis-api/` |
| Architecture, profile and bundle layering | `docs/architecture.md` |
| Config schema catalog | `docs/config-catalog.md` |
| Tool catalog | `docs/tool-catalog.md` |
| Web client, slots, client modules | `docs/subsystems/web-client.md`, `slots.md`, `client-modules.md` |
| Client house rules | `packages/client/AGENTS.md` |
| CLI flags, profiles, layer precedence | `apps/cli/reference/README.md` |

Verify against the checkout; this file summarizes, the code is the truth.

## Recipes

After any non-trivial completed task, write or update a recipe in
`recipes/`: one topic per file, exact commands and configuration, the reasons
behind non-obvious choices, and what failed and why. Index it here.
(The recipe set is being decided; none exist yet.)
