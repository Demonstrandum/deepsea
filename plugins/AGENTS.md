# AGENTS.md — plugins

One directory per plugin, each an installable npm package. Names follow
[LAYOUT.md](../LAYOUT.md) §1: directory `plugins/<name>`, package
`@deepsea/<name>`, loader row id `deepsea-<name>`.

## A plugin directory

```
plugins/<name>/
  package.json        name, dsh.bundle.patch (and dsh.client for a browser half), scripts
  cordis.patch.yml    the bundle row(s) this package inserts when installed
  index.js            host half (Node): apply(ctx, config)
  src/client/         browser half, if any (TypeScript/TSX)
  build.mjs           builds lib/client.js (esbuild)
  tests/              node:test, run by `pnpm test`
  README.md           what it does, configuration, how it works, limits
```

The harness topics a plugin needs are declared in its package.json,
`"deepsea": { "requires": ["<harness topic>", …] }`; `dsd topics` reads them.

Dependencies on the harness are `link:` devDependencies through the
`harness` link (`link:../../harness/packages/...`), for types and tests only.

## Host half

- Register through `ctx` (tools, commands, Fetch routes, listeners); wrap
  anything Cordis does not manage in `ctx.effect(() => … return dispose)`.
- `inject` names required services; an optional one is reached with
  `ctx.inject([name], callback)` or `ctx.get(name)`.
- Export a `Config` schema; invalid configuration fails the load before
  `apply` runs. A later patch layer replaces a row's whole `config`.
- Host module edits need a server restart; module-source hot reload is off.
- State goes under `$DSH_HOME/plugins/<name>/`, traces and logs under the
  variant's log directory (LAYOUT.md §4-5), scratch under
  `$TMPDIR/deepsea-<name>-…`.
- **Machine-wide plugins.** A plugin that acts on something outside its
  variant (a browser it drives, local model servers it starts and stops, a
  Tailscale Serve path, a licensed external program) declares it in
  package.json: `"deepsea": { "machineWide": "<what it controls>" }`.
  `dsd run … --plugins all` leaves such plugins out of throwaway variants
  (naming one includes it), so a throwaway never acts on a resource a real
  variant is using.
- Fetch routes (`ctx.connection.fetch.register`) sit behind DSH's own
  authentication; a state-changing route takes POST with a JSON body so a
  cross-site form cannot reach it without a CORS preflight.

## Browser half

- Declared by `{ "dsh": { "client": { "platform": "web" } } }` and the
  `./client` export (`lib/client.js`); the bundle must exist when the server
  starts.
- The bundle is a CJS module wrapped in
  `window.__ModuleLoader__.load({ id: '<package name>', factory })`. Only the
  shell's platform modules stay external: `react`, `react/jsx-runtime`,
  `react-dom`, `react-dom/client`, `@deepseek-ai/cordis`,
  `@deepseek-ai/dsh-client-store`, `@deepseek-ai/dsh-client-ui-slots`,
  `@deepseek-ai/dsh-client-ui-primitives`. Everything else is inlined.
  Mirror: `harness/packages/client/web/src/platform.ts`.
- Runtime imports of other `@deepseek-ai/*` client packages are forbidden;
  `import type {}` is how slot declarations are pulled in.
- UI is contributed through slots (`ctx.slots.inject(name, () =>
  ctx.slots.register(...))`); components never see `ctx`. Reference:
  `harness/docs/subsystems/slots.md`.
- Rebuilding `lib/client.js` hot-swaps every browser running the plugin.

## Testing

- `pnpm test` (node:test) for host logic and pure client helpers;
  `pnpm typecheck` against the linked harness packages.
- Exercise a plugin in a throwaway home (`DSH_HOME=$(mktemp -d)`) or a
  variant set aside for trials — never in the instance the user is working
  in.
