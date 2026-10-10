import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readlinkSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'dsd-test-'))
process.env.DEEPSEA_ROOT = join(root, 'deepsea')
process.env.DEEPSEA_LOG_ROOT = join(root, 'logs')
test.after(() => rmSync(root, { recursive: true, force: true }))

const { checkNamedId, displayName, parseThrowaway, resolveRef, writeState, writeVariant } = await import('../lib/variants.mjs')
const { formatFlatYaml, parseArgs, parseFlatYaml } = await import('../lib/util.mjs')
const { parseLock } = await import('../lib/harness.mjs')
const { openRunLog, prune } = await import('../lib/logs.mjs')
const { homeOf, logDirOf, variantName } = await import('../lib/paths.mjs')

test('variant ids: named ids are plain, throwaway ids are <parent>-<6 hex>', () => {
  for (const id of ['release', 'personal', 'my-test', 'a1']) assert.doesNotThrow(() => checkNamedId(id))
  for (const id of ['Release', 'a.b', '-x', 'x-', 'a--b', '', 'personal-3f9a1c']) assert.throws(() => checkNamedId(id), id)
  assert.deepEqual(parseThrowaway('personal-3f9a1c'), { parent: 'personal', hex: '3f9a1c' })
  assert.deepEqual(parseThrowaway('my-test-00aa11'), { parent: 'my-test', hex: '00aa11' })
  assert.equal(parseThrowaway('personal'), undefined)
  assert.equal(parseThrowaway('personal-3f9a1'), undefined)
})

test('display names leave release out', () => {
  assert.equal(displayName('release'), 'DeepSea')
  assert.equal(displayName('personal'), 'DeepSea Personal')
  assert.equal(displayName('my-test'), 'DeepSea My Test')
  assert.equal(displayName('release-3f9a1c'), 'DeepSea 3f9a1c')
  assert.equal(displayName('personal-3f9a1c'), 'DeepSea Personal 3f9a1c')
  assert.equal(variantName('personal-3f9a1c'), 'io.github.taliesinb.deepsea.personal-3f9a1c')
})

test('flat YAML round-trips the values variant.yml holds', () => {
  const config = { id: 'personal-3f9a1c', parent: 'personal', throwaway: true, port: 3210, source: 'topic/base', note: 'has spaces # and a hash', version: '1.0' }
  assert.deepEqual(parseFlatYaml(formatFlatYaml(config, 'header')), config)
  assert.deepEqual(parseFlatYaml('# c\n\nkey: value # trailing\n'), { key: 'value' })
})

test('arguments: valued flags take the next word or =value; others are booleans', () => {
  assert.deepEqual(parseArgs(['run', 'personal', '--source', 'HEAD~1', '--detach', '--timeout=30'], ['source', 'timeout']),
    { _: ['run', 'personal'], source: 'HEAD~1', detach: true, timeout: '30' })
  assert.throws(() => parseArgs(['--source'], ['source']))
})

test('harness.lock needs url and commit', () => {
  assert.deepEqual(parseLock('# c\nurl ../h\nbranch b\ncommit abc\n'), { url: '../h', branch: 'b', commit: 'abc' })
  assert.throws(() => parseLock('url ../h\n'))
})

test('references: full id, unique hex part, or the caller\'s one running throwaway', async () => {
  const { currentOwner } = await import('../lib/variants.mjs')
  const owner = currentOwner()
  for (const id of ['personal', 'personal-3f9a1c', 'release-3f0000']) {
    mkdirSync(homeOf(id), { recursive: true })
    writeVariant(id, { id, ownerSession: owner.session, ownerCheckout: owner.checkout })
  }
  assert.equal(resolveRef('personal').id, 'personal')
  assert.equal(resolveRef('9a1c').id, 'personal-3f9a1c')
  assert.throws(() => resolveRef('3f'), /several/)
  assert.throws(() => resolveRef('nope'), /no variant/)
  assert.throws(() => resolveRef(undefined), /none of your throwaways is running/)
  // A state whose pid is not the recorded process does not count as running.
  writeState('personal-3f9a1c', { pid: process.pid, signature: 'not-this-process' })
  assert.throws(() => resolveRef(undefined), /none of your throwaways is running/)
  // The command line shows the test file as it was passed (often relative); its name is enough.
  writeState('personal-3f9a1c', { pid: process.pid, signature: 'dsd.test.mjs' })
  assert.equal(resolveRef(undefined).id, 'personal-3f9a1c')
  // Another agent's running throwaway is never the default, but can be named.
  writeVariant('release-3f0000', { id: 'release-3f0000', ownerSession: 'session-another-agent', ownerCheckout: '/elsewhere' })
  writeState('release-3f0000', { pid: process.pid, signature: 'dsd.test.mjs' })
  assert.equal(resolveRef(undefined).id, 'personal-3f9a1c')
  assert.equal(resolveRef('3f00').id, 'release-3f0000')
})

test('run logs: <ts>-<pid>.log, a latest link, identity first; pruning keeps recent and newest', () => {
  const dir = join(logDirOf('personal-3f9a1c'), 'server')
  const log = openRunLog(dir, { tag: 'pending' })
  log.identify('io.github.taliesinb.deepsea.personal-3f9a1c server pid 42')
  log.rename(42)
  log.close()
  const files = readdirSync(dir)
  assert.ok(files.some(f => /^\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-42\.log$/.test(f)), files.join(','))
  assert.match(readlinkSync(join(dir, 'latest.log')), /-42\.log$/)
  const old = join(root, 'prune')
  mkdirSync(old)
  for (let i = 0; i < 5; i++) {
    const f = join(old, `2020-01-0${i + 1}T00-00-00-${i}.log`)
    writeFileSync(f, '')
    utimesSync(f, new Date('2020-01-01'), new Date('2020-01-01'))
  }
  writeFileSync(join(old, 'notes.txt'), '')
  prune(old, { keep: 2, days: 14 })
  assert.deepEqual(readdirSync(old).sort(), ['2020-01-04T00-00-00-3.log', '2020-01-05T00-00-00-4.log', 'notes.txt'])
})

test('check: added lines with their numbers; built-in patterns flag leaks but not the allowed forms', async () => {
  const { addedLines, scan, BUILTIN_PATTERNS } = await import('../commands/check.mjs')
  // The leaks are assembled from pieces, so this file passes the check it tests.
  const [path, address, tailnet, mail] = ['/Users/' + 'alice', ['192', '168', '1', '4'].join('.'), 'tail123' + '.ts.net', 'bob' + '@corp.io']
  const diff = ['--- a/a.md', '+++ b/a.md', '@@ -0,0 +1,7 @@',
    `+see ${path}/x and /Users/USER/ok`, `+host ${address}, loopback 127.0.0.1`, `+node.example.ts.net vs box.${tailnet}`,
    `+mail ${mail} or user@example.com`, '+pnpm@11.7.0 react@18.3.1 "@deepsea/login"', '+++ starts with two pluses', '+last'].join('\n')
  const lines = addedLines(diff)
  assert.equal(lines.length, 7)
  assert.deepEqual(lines.at(-2), { file: 'a.md', line: 6, text: '++ starts with two pluses' })
  assert.deepEqual(scan(lines, BUILTIN_PATTERNS).map(h => `${h.line}:${h.match}`), [`1:${path}`, `2:${address}`, `3:${tailnet}`, `4:${mail}`])
  assert.deepEqual(scan([{ file: 'LICENSE', line: 1, text: mail }], BUILTIN_PATTERNS), [])
})

test('gc: own stopped throwaways go; another agent\'s only after an hour; expired ones go running or not', async () => {
  const { gcReason } = await import('../commands/manage.mjs')
  const me = process.env.DSH_SESSION_ID
  process.env.DSH_SESSION_ID = 'session-me'
  try {
    const now = Date.now()
    const v = (config, running = false) => ({ id: 'none-000000', throwaway: true, running, config })
    assert.equal(gcReason(v({ ownerSession: 'session-me' })), 'stopped')
    assert.equal(gcReason(v({ ownerSession: 'session-me' }, true)), undefined)
    assert.equal(gcReason(v({ ownerSession: 'session-other' }), now), 'stopped over an hour ago')  // no activity recorded: old
    assert.equal(gcReason(v({ ownerSession: 'session-other', expires: new Date(now - 1000).toISOString() }, true), now), 'expired')
    assert.equal(gcReason({ id: 'release', throwaway: false, config: {} }), undefined)
  } finally {
    if (me === undefined) delete process.env.DSH_SESSION_ID; else process.env.DSH_SESSION_ID = me
  }
})

test('topics.txt: sections, bases and topics with parents', async () => {
  const { parseTopics } = await import('../commands/topics.mjs')
  assert.deepEqual(parseTopics('# c\n[harness]\nbase v1 # tag\ntopic topic/a\ntopic topic/b topic/a\n\n[deepsea]\nbase topic/base\n'), {
    harness: { base: 'v1', topics: [{ name: 'topic/a', parent: undefined }, { name: 'topic/b', parent: 'topic/a' }] },
    deepsea: { base: 'topic/base', topics: [] },
  })
})

test('app sources: this checkout, a path, or a commit; a missing one is refused', async () => {
  const { appSource, appDirOf, appSocketOf } = await import('../lib/app.mjs')
  const { DsdError } = await import('../lib/util.mjs')
  assert.match(appDirOf('release-3f9a1c'), /deepsea-app-release-3f9a1c$/)
  assert.match(appSocketOf('release-3f9a1c'), /release-3f9a1c\/run\/app\.sock$/)
  assert.throws(() => appSource('/nonexistent-deepsea-checkout'), /has no apps\/macos/)
  assert.throws(() => appSource('no-such-ref-for-deepsea-tests'), e => e instanceof DsdError && /no app source|has no apps\/macos/.test(e.message))
})

test('app requests: one JSON line out, one in; errors carry the app\'s code', async () => {
  const { createServer } = await import('node:net')
  const { appRequest } = await import('../lib/appsocket.mjs')
  const socket = join(mkdtempSync(join(tmpdir(), 'dsd-sock-')), 's')
  const seen = []
  const server = createServer(conn => conn.on('data', (chunk) => {
    const request = JSON.parse(chunk.toString().trim())
    seen.push(request)
    conn.write(request.op === 'hello' ? `${JSON.stringify({ id: request.id, ok: true, value: { pid: 1 } })}\n` : `${JSON.stringify({ id: request.id, ok: false, error: { code: 'offline', message: 'the offline page is showing' } })}\n`)
  }))
  await new Promise(resolve => server.listen(socket, resolve))
  try {
    assert.deepEqual(await appRequest(socket, 'hello'), { pid: 1 })
    await assert.rejects(appRequest(socket, 'eval', { js: 'return 1' }), /eval: offline: the offline page is showing/)
    assert.deepEqual(seen.map(r => [r.op, r.js]), [['hello', undefined], ['eval', 'return 1']])
    await assert.rejects(appRequest(`${socket}-missing`, 'hello'), /cannot reach the app/)
  } finally { server.close() }
})

test('integration: merges in order, reuses unchanged merges, stops at a conflict, moves a checked-out branch with its worktree', async () => {
  const { execFileSync } = await import('node:child_process')
  const { planIntegration, moveBranch } = await import('../lib/integrate.mjs')
  const repo = mkdtempSync(join(tmpdir(), 'dsd-integrate-'))
  const g = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim()
  try {
    g('init', '-q', '-b', 'main')
    writeFileSync(join(repo, 'shared.txt'), 'base\n'); g('add', '.'); g('commit', '-qm', 'base')
    for (const topic of ['a', 'b']) {
      g('checkout', '-qb', `topic/${topic}`, 'main')
      writeFileSync(join(repo, `${topic}.txt`), `${topic}\n`); g('add', '.'); g('commit', '-qm', topic)
    }
    g('checkout', '-q', 'main')
    const first = planIntegration(repo, 'main', ['topic/a', 'topic/b'], 'integration/main')
    assert.equal(first.conflict, undefined)
    assert.deepEqual(first.steps.map(s => s.reused), [false, false])
    assert.equal(g('show', `${first.tip}:b.txt`), 'b')
    assert.equal(moveBranch(repo, 'integration/main', first.tip), undefined)
    const again = planIntegration(repo, 'main', ['topic/a', 'topic/b'], 'integration/main')
    assert.equal(again.tip, first.tip)
    assert.deepEqual(again.steps.map(s => s.reused), [true, true])
    // Two topics editing the same line: the plan stops at the second, nothing is moved.
    for (const topic of ['c', 'd']) {
      g('checkout', '-qb', `topic/${topic}`, 'main')
      writeFileSync(join(repo, 'shared.txt'), `${topic}\n`); g('add', '.'); g('commit', '-qm', topic)
    }
    g('checkout', '-q', 'main')
    const clash = planIntegration(repo, 'main', ['topic/c', 'topic/d'], 'integration/main')
    assert.deepEqual(clash.conflict, { topic: 'topic/d', files: ['shared.txt'] })
    assert.equal(g('rev-parse', 'integration/main'), first.tip)
    // A checked-out integration branch moves with its worktree; local changes are refused.
    g('checkout', '-q', 'integration/main')
    const next = planIntegration(repo, 'main', ['topic/a', 'topic/b', 'topic/c'], 'integration/main')
    moveBranch(repo, 'integration/main', next.tip)
    assert.equal(g('rev-parse', 'HEAD'), next.tip)
    assert.equal(g('status', '--porcelain'), '')
    writeFileSync(join(repo, 'a.txt'), 'edited\n')
    assert.throws(() => moveBranch(repo, 'integration/main', first.tip), /uncommitted changes/)
  } finally { rmSync(repo, { recursive: true, force: true }) }
})
