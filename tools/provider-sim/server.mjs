#!/usr/bin/env node
/**
 * deepsea provider simulator: a loopback HTTP server that stands in for model
 * providers when DeepSea runs with DSH_PROVIDER_SIMULATOR=<its URL> (the
 * harness then sends every provider request here, the provider's host leading
 * the path: /openrouter.ai/api/v1/chat/completions). See README.md.
 *
 *   node server.mjs --db <sqlite file> [--port <n>] [--catalog <pi-ai providers dir>] [--host 127.0.0.1]
 *
 * Simulator endpoints of its own, under /_sim/: status, accounts
 * (?provider=), and account (POST {provider, kind, credential, state}) to
 * create or change one.
 */
import { readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { deepseek, initialState, openrouter, providerFor } from './providers.mjs'
import { openStore } from './store.mjs'

const BODY_LIMIT = 32 * 1024 * 1024

/**
 * Model catalogs and prices from pi-ai's generated provider files (the same
 * catalog DeepSea uses), keyed by pi-ai provider id. Without a directory, an
 * empty catalog: every model is free.
 */
export async function loadCatalog(dir) {
  const byProvider = new Map()
  if (dir) {
    for (const file of readdirSync(dir).filter(f => f.endsWith('.models.js'))) {
      const module = await import(pathToFileURL(join(dir, file)).href)
      const value = Object.values(module)[0]
      const models = Array.isArray(value) ? value : Object.values(value ?? {})
      byProvider.set(file.slice(0, -'.models.js'.length), models)
    }
  }
  return {
    models: provider => byProvider.get(provider) ?? [],
    cost: (provider, model) => byProvider.get(provider)?.find(m => m.id === model)?.cost,
    providers: () => [...byProvider.keys()],
  }
}

/** Build the simulator (not listening). */
export async function createSimulator({ db, catalogDir, log = () => {} }) {
  const store = openStore(db)
  const catalog = await loadCatalog(catalogDir)
  const started = new Date().toISOString()
  const ctx = {
    store,
    json(res, status, value, headers = {}) {
      res.writeHead(status, { 'content-type': 'application/json', ...headers })
      res.end(JSON.stringify(value))
    },
    /** A provider-style error body (OpenAI and Anthropic clients both read error.message). */
    error(res, status, type, message, headers = {}) {
      ctx.json(res, status, { type: 'error', error: { type, code: status, message } }, headers)
    },
  }
  const handlers = { openrouter: openrouter(ctx, catalog), deepseek: deepseek(ctx, catalog) }

  const readBody = req => new Promise((resolve, reject) => {
    const parts = []
    let size = 0
    req.on('data', (c) => { size += c.length; if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy() } else parts.push(c) })
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })

  const admin = async (req, res, path, text) => {
    if (path === '/_sim/status') return ctx.json(res, 200, { ok: true, pid: process.pid, started, db, providers: Object.keys(handlers), catalog: catalog.providers().length })
    if (path === '/_sim/accounts') {
      const provider = new URL(req.url, 'http://sim').searchParams.get('provider') ?? undefined
      return ctx.json(res, 200, { accounts: store.accounts(provider) })
    }
    if (path === '/_sim/account' && req.method === 'POST') {
      const { provider, kind = 'key', credential, state } = JSON.parse(text || '{}')
      if (!handlers[provider] || !credential) return ctx.error(res, 400, 'invalid_request', 'provider and credential are required')
      const account = store.account(provider, kind, credential, () => initialState(provider, credential))
      return ctx.json(res, 200, state ? store.update(account.id, s => ({ ...s, ...state })) : account)
    }
    return ctx.error(res, 404, 'not_found', `no ${path}`)
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://sim')
    const started = Date.now()
    res.on('finish', () => log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`))
    try {
      const text = req.method === 'GET' || req.method === 'HEAD' ? '' : await readBody(req)
      if (url.pathname.startsWith('/_sim/')) return await admin(req, res, url.pathname, text)
      const [, host, ...rest] = url.pathname.split('/')
      const provider = providerFor(host)
      if (!provider) return ctx.error(res, 501, 'not_simulated', `${host || '(no host)'} is not simulated`)
      let body = {}
      if (text) {
        try { body = JSON.parse(text) } catch { return ctx.error(res, 400, 'invalid_request_error', 'the body is not JSON') }
      }
      return await handlers[provider](req, res, `/${rest.join('/')}`, body)
    } catch (error) {
      log(`error: ${error?.stack ?? error}`)
      if (!res.headersSent) ctx.error(res, 500, 'api_error', String(error?.message ?? error))
      else res.end()
    }
  })
  return { server, store, catalog }
}

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 0 }
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '')
    if (!['db', 'port', 'catalog', 'host'].includes(key) || argv[i + 1] === undefined) throw new Error(`unexpected argument ${argv[i]}`)
    out[key] = key === 'port' ? Number(argv[i + 1]) : argv[i + 1]
  }
  if (!out.db) throw new Error('--db is required')
  if (out.host !== '127.0.0.1' && out.host !== 'localhost') throw new Error('the simulator listens on loopback only')
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const say = line => process.stderr.write(`${new Date().toISOString()} ${line}\n`)
  const { server, store } = await createSimulator({ db: args.db, catalogDir: args.catalog, log: say })
  server.listen(args.port, args.host, () => {
    const { port } = server.address()
    // The first stdout line is the simulator's URL, for whoever started it.
    process.stdout.write(`http://${args.host}:${port}\n`)
    say(`provider simulator pid ${process.pid} on http://${args.host}:${port}, db ${args.db}`)
  })
  const stop = (signal) => { say(`${signal}: stopping`); server.close(() => { store.close(); process.exit(0) }) }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { process.stderr.write(`provider simulator: ${error?.message ?? error}\n`); process.exit(1) })
}
