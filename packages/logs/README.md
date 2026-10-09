# @deepsea/logs

Where DeepSea writes its logs and how (LAYOUT.md §5): the one implementation
shared by plugins and `dsd`. Plain Node, no dependencies: `dsd` imports it by
path, a plugin links it in its package.json:

```json
"dependencies": { "@deepsea/logs": "link:../../packages/logs" }
```

| Export | Does |
|---|---|
| `pluginLogDirectory(name, home)` | `~/Library/Logs/<variant name>/plugins/<name>/` for a DeepSea home, `<home>/logs/plugins/<name>/` for any other |
| `createTrace({ enabled, name, plugin, home })` | a plugin trace: `trace(event)` appends JSON lines to `<ts>-<pid>.jsonl` there; a no-op unless enabled; never throws |
| `openRunLog(dir, { tag, ext, identity })` | a run log `<ts>-<tag>.<ext>` (0600 in a 0700 directory), its identity on the first line, `latest.<ext>`, pruning; `rename(tag)` for a tag known later |
| `variantOf(home)`, `variantName(id)`, `variantLogDirectory(home)`, `logRoot()`, `machineLogDirectory()` | the pieces: the variant from `DEEPSEA_VARIANT` or the home's place in `DEEPSEA_ROOT` (default `~/.deepsea`), the log root from `DEEPSEA_LOG_ROOT` or the platform default |
| `fileStamp()`, `isoLocal()`, `prune(dir)` | `2026-10-07T19-04-14`, `2026-10-07T19:04:14+01:00`, the newest 20 runs plus anything younger than 14 days |

Pass the plugin's home as `resolveDshHome()` (`@deepseek-ai/dsh-home-paths`).
The macOS app keeps its own Swift copy of these rules (apps/macos,
`Paths.swift`).
