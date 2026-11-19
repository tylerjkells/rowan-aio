import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonical, equal, merge3, sanitize } from '../src/main/sync/merge'

test('canonical ignores key order', () => {
  assert.equal(canonical({ b: 1, a: [1, { d: 2, c: 3 }] }), canonical({ a: [1, { c: 3, d: 2 }], b: 1 }))
  assert.ok(equal({ x: 1, y: undefined }, { x: 1 }))
})

test('edits to different fields both survive', () => {
  const base = { title: 'Weekly', notes: '', tags: ['ops'] }
  const local = { ...base, notes: 'Follow up with Priya' }
  const remote = { ...base, title: 'Weekly ops sync' }
  assert.deepEqual(merge3(base, local, remote, 'remote'), {
    title: 'Weekly ops sync',
    notes: 'Follow up with Priya',
    tags: ['ops']
  })
})

test('the same field changed on both sides goes to the preferred side', () => {
  const base = { title: 'A' }
  assert.deepEqual(merge3(base, { title: 'L' }, { title: 'R' }, 'local'), { title: 'L' })
  assert.deepEqual(merge3(base, { title: 'L' }, { title: 'R' }, 'remote'), { title: 'R' })
})

test('items with ids merge one by one, keeping additions from both sides', () => {
  const base = [
    { id: 'a', title: 'Dashboard', status: 'now' },
    { id: 'b', title: 'Data pull', status: 'next' }
  ]
  const local = [
    { id: 'c', title: 'New here', status: 'now' },
    { id: 'a', title: 'Dashboard v2', status: 'now' },
    { id: 'b', title: 'Data pull', status: 'next' }
  ]
  const remote = [
    { id: 'a', title: 'Dashboard', status: 'done' },
    { id: 'b', title: 'Data pull', status: 'next' },
    { id: 'd', title: 'New there', status: 'later' }
  ]
  const merged = merge3(base, local, remote, 'remote') as { id: string; title: string; status: string }[]
  assert.deepEqual(
    merged.map((x) => x.id).sort(),
    ['a', 'b', 'c', 'd']
  )
  assert.deepEqual(merged.find((x) => x.id === 'a'), { id: 'a', title: 'Dashboard v2', status: 'done' })
})

test('a local insert at the top keeps its place when the other side only edited', () => {
  const base = [{ id: 'a', n: 1 }, { id: 'b', n: 1 }]
  const local = [{ id: 'z', n: 1 }, ...base]
  const remote = [{ id: 'a', n: 2 }, { id: 'b', n: 1 }]
  assert.deepEqual(
    (merge3(base, local, remote, 'remote') as { id: string }[]).map((x) => x.id),
    ['z', 'a', 'b']
  )
})

test('an item deleted on one side and untouched on the other is deleted', () => {
  const base = [{ id: 'a' }, { id: 'b' }]
  assert.deepEqual(merge3(base, [{ id: 'a' }], base, 'remote'), [{ id: 'a' }])
})

test('an item deleted on one side but edited on the other is kept', () => {
  const base = [{ id: 'a', t: 1 }, { id: 'b', t: 1 }]
  const local = [{ id: 'a', t: 1 }]
  const remote = [{ id: 'a', t: 1 }, { id: 'b', t: 2 }]
  assert.deepEqual(merge3(base, local, remote, 'local'), [{ id: 'a', t: 1 }, { id: 'b', t: 2 }])
})

test('lists of names merge as sets', () => {
  const base = ['Ana', 'Ben', 'Cy']
  const local = ['Ana', 'Cy', 'Dee'] // removed Ben, added Dee
  const remote = ['Ana', 'Ben', 'Cy', 'Eve'] // added Eve
  assert.deepEqual(merge3(base, local, remote, 'remote'), ['Ana', 'Cy', 'Eve', 'Dee'])
})

test('appends on both sides are both kept (Ask history)', () => {
  const q = (s: string): { q: string } => ({ q: s })
  const base = [q('one')]
  const merged = merge3(base, [q('one'), q('two')], [q('one'), q('three')], 'remote')
  assert.deepEqual(merged, [q('one'), q('three'), q('two')])
})

test('with no shared history the hub wins conflicts, but nothing is dropped', () => {
  const local = { yourName: '', people: [], theme: 'studio', onlyHere: 1 }
  const remote = { yourName: 'Tyler', people: ['Priya'], theme: 'dusk' }
  assert.deepEqual(merge3(undefined, local, remote, 'remote'), {
    yourName: 'Tyler',
    people: ['Priya'],
    theme: 'dusk',
    onlyHere: 1
  })
})

test('a transcript changed on both sides is taken whole from one side', () => {
  const seg = (t: string): { from: number; to: number; text: string } => ({ from: 0, to: 1, text: t })
  const base = { transcript: [seg('a'), seg('b')] }
  const local = { transcript: [seg('a'), seg('B!')] }
  const remote = { transcript: [seg('A!'), seg('b')] }
  assert.deepEqual(merge3(base, local, remote, 'remote'), remote)
})

test('action items changed in place on both sides merge item by item', () => {
  const item = (task: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ task, owner: 'Me', due: null, ...extra })
  const base = { summary: { actionItems: [item('a'), item('b'), item('c')] } }
  const local = { summary: { actionItems: [item('a', { done: true }), item('b'), item('c')] } }
  const remote = { summary: { actionItems: [item('a'), item('b'), item('c', { tracked: true })] } }
  assert.deepEqual(merge3(base, local, remote, 'remote'), {
    summary: { actionItems: [item('a', { done: true }), item('b'), item('c', { tracked: true })] }
  })
})

test('a re-summarized list of action items is taken whole from one side', () => {
  const item = (task: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ task, owner: null, due: null, ...extra })
  const base = { actionItems: [item('a'), item('b')] }
  const local = { actionItems: [item('a', { tracked: true }), item('b')] }
  const remote = { actionItems: [item('x'), item('y')] }
  assert.deepEqual(merge3(base, local, remote, 'remote'), remote)
})

test('sanitize removes what Postgres jsonb rejects', () => {
  assert.equal(sanitize('a\u0000b'), 'ab')
  assert.equal(sanitize('x\ud800y'), 'x�y')
  assert.equal(sanitize('ok 😀'), 'ok 😀')
  assert.deepEqual(sanitize({ a: undefined, b: [undefined, 1] }), { b: [null, 1] })
})
