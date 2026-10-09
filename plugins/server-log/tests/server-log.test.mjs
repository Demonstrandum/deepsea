import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, render, timestamp } from '../index.js'

const exporter = { colors: false }
const message = (type, args, name = 'deepsea-billing') => ({ sn: 1, ts: Date.parse('2026-10-09T20:13:24.115Z'), type, level: 1, name, args })

test('lines carry the local time, level and logger name; placeholders and objects are formatted', () => {
  assert.match(timestamp(Date.now()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/)
  const line = render(message('warn', ['usage read failed: %s (%d tries)', 'timeout', 3]), exporter)
  assert.match(line, / warn  deepsea-billing  usage read failed: timeout \(3 tries\)$/)
  assert.match(render(message('info', ['state', { a: 1 }]), exporter), /info  deepsea-billing  state \{"a":1\}$/)
})

test('a multi-line message (a stack) gets the prefix on every line', () => {
  const error = new Error('boom')
  const lines = render(message('error', [error]), exporter).split('\n')
  assert.ok(lines.length > 1)
  for (const line of lines) assert.match(line, / error deepsea-billing  /)
  assert.match(lines[0], /Error: boom$/)
})

test('config: a level, nothing else', () => {
  const v = Config['~standard'].validate
  assert.deepEqual(v({}), { value: { level: 'debug' } })
  assert.deepEqual(v({ level: 'warn' }), { value: { level: 'warn' } })
  assert.ok(v({ level: 'loud' }).issues)
  assert.ok(v({ file: '/x' }).issues)
})
