/**
 * The simulator's accounts and generations, in one SQLite database shared by
 * every simulator process of this machine (WAL, a busy timeout, and immediate
 * transactions for every read-modify-write, so concurrent writers are safe).
 *
 * An account is created the first time a credential is used: an API key
 * string, or an email address given to a simulated sign-in. Its `state` is a
 * provider-specific JSON object (credit, balance, usage windows, plan); money
 * is in micro-dollars (integers), so totals never drift.
 *
 * Tokens a simulated sign-in issues (authorization codes, OAuth access and
 * refresh tokens) are rows of their own, each tied to an account, with an
 * expiry and a revoked flag.
 */
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY,
  provider TEXT NOT NULL,
  kind TEXT NOT NULL,
  credential TEXT NOT NULL,
  created TEXT NOT NULL,
  state TEXT NOT NULL,
  UNIQUE (provider, kind, credential)
);
CREATE TABLE IF NOT EXISTS generations (
  id TEXT PRIMARY KEY,
  account INTEGER NOT NULL REFERENCES accounts(id),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  created TEXT NOT NULL,
  input INTEGER NOT NULL,
  output INTEGER NOT NULL,
  cache_read INTEGER NOT NULL,
  cache_write INTEGER NOT NULL,
  cost_micros INTEGER NOT NULL,
  streamed INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
  token TEXT PRIMARY KEY,
  account INTEGER NOT NULL REFERENCES accounts(id),
  kind TEXT NOT NULL,
  created TEXT NOT NULL,
  expires TEXT,
  revoked INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL DEFAULT '{}'
);
`

const row = r => r === undefined ? undefined : { ...r, state: JSON.parse(r.state) }

/**
 * Open (creating if needed) the store at `file`.
 * @param {string} file - the database path.
 */
export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;')
  db.exec(SCHEMA)
  const find = db.prepare('SELECT * FROM accounts WHERE provider = ? AND kind = ? AND credential = ?')
  const byId = db.prepare('SELECT * FROM accounts WHERE id = ?')
  const insert = db.prepare('INSERT INTO accounts (provider, kind, credential, created, state) VALUES (?, ?, ?, ?, ?)')
  const write = db.prepare('UPDATE accounts SET state = ? WHERE id = ?')

  /** Run `fn` in an immediate transaction (one writer at a time across processes). */
  const transaction = (fn) => {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    file,
    /**
     * The account a credential names, created with `initial()` the first time.
     * @param {string} provider @param {'key'|'email'} kind @param {string} credential
     * @param {() => object} initial - the new account's state.
     */
    account(provider, kind, credential, initial) {
      return transaction(() => {
        const existing = find.get(provider, kind, credential)
        if (existing) return row(existing)
        insert.run(provider, kind, credential, new Date().toISOString(), JSON.stringify(initial()))
        return row(find.get(provider, kind, credential))
      })
    },
    /** An account by id, or undefined. */
    get(id) { return row(byId.get(id)) },
    /** Change an account's state atomically: `mutate(state)` returns the new state. */
    update(id, mutate) {
      return transaction(() => {
        const current = row(byId.get(id))
        if (!current) throw new Error(`no account ${id}`)
        const state = mutate(structuredClone(current.state))
        write.run(JSON.stringify(state), id)
        return { ...current, state }
      })
    },
    /** Accounts, optionally of one provider. */
    accounts(provider) {
      const rows = provider === undefined
        ? db.prepare('SELECT * FROM accounts ORDER BY id').all()
        : db.prepare('SELECT * FROM accounts WHERE provider = ? ORDER BY id').all(provider)
      return rows.map(row)
    },
    /** Record one response: its id, tokens and cost. */
    recordGeneration(g) {
      db.prepare(`INSERT INTO generations (id, account, provider, model, created, input, output, cache_read, cache_write, cost_micros, streamed)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(g.id, g.account, g.provider, g.model, new Date().toISOString(),
        g.input, g.output, g.cacheRead ?? 0, g.cacheWrite ?? 0, g.costMicros, g.streamed ? 1 : 0)
    },
    /** One recorded response, or undefined. */
    generation(id) { return db.prepare('SELECT * FROM generations WHERE id = ?').get(id) },
    /**
     * Record a token: `kind` ('code', 'access', 'refresh'), valid for `seconds`
     * (none: until used or revoked), with `data` of its own.
     */
    issueToken({ token, account, kind, seconds, data = {} }) {
      const now = Date.now()
      db.prepare('INSERT INTO tokens (token, account, kind, created, expires, data) VALUES (?, ?, ?, ?, ?, ?)').run(token, account, kind,
        new Date(now).toISOString(), seconds === undefined ? null : new Date(now + seconds * 1000).toISOString(), JSON.stringify(data))
    },
    /** A token's row (`data` parsed), or undefined. */
    token(value) {
      const r = db.prepare('SELECT * FROM tokens WHERE token = ?').get(value)
      return r === undefined ? undefined : { ...r, revoked: r.revoked === 1, data: JSON.parse(r.data) }
    },
    /** Use a single-use token of `kind` up: its row, or undefined when unknown, used, expired or of another kind. */
    consumeToken(value, kind) {
      return transaction(() => {
        const r = db.prepare('SELECT * FROM tokens WHERE token = ?').get(value)
        if (!r || r.kind !== kind || r.revoked === 1 || (r.expires !== null && Date.parse(r.expires) <= Date.now())) return undefined
        db.prepare('UPDATE tokens SET revoked = 1 WHERE token = ?').run(value)
        return { ...r, revoked: true, data: JSON.parse(r.data) }
      })
    },
    close() { db.close() },
  }
}
