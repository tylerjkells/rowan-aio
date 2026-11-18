import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { SyncEngine } from '../src/main/sync/engine'
import { HubError } from '../src/main/sync/hub'
import { FakeServer, type FakeHub } from './fakeHub'

// ---------------------------------------------------------------------------
// Two (or three) PCs, each a temp folder laid out like the app's userData,
// syncing through one in-memory hub.
// ---------------------------------------------------------------------------

const roots: string[] = []
process.on('exit', () => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

type Meeting = Record<string, unknown> & { id: string }

function meeting(id: string, over: Partial<Meeting> = {}): Meeting {
  return {
    id,
    title: `Meeting ${id}`,
    createdAt: new Date().toISOString(),
    durationMs: 60_000,
    mode: 'virtual',
    stage: 'ready',
    hasAudio: false,
    transcript: [{ from: 0, to: 1000, text: 'hello there' }],
    summary: { tldr: 'A short meeting.', actionItems: [] },
    ...over
  }
}

const DEFAULT_PORTABLE = { yourName: '', theme: 'studio', people: [] as string[], syncAudioDays: 7 }

class PC {
  readonly root = mkdtempSync(join(tmpdir(), 'rowan-sync-'))
  readonly hub: FakeHub
  engine: SyncEngine
  written: string[] = []

  constructor(
    readonly server: FakeServer,
    user = 'u1',
    /** the settings this "version" of the app knows; undefined knows all */
    private readonly knownSettings?: string[]
  ) {
    roots.push(this.root)
    this.hub = server.hub(user)
    this.engine = this.makeEngine()
  }

  private makeEngine(): SyncEngine {
    return new SyncEngine(this.root, this.hub, {
      readPortableSettings: () => {
        const all = this.portable()
        if (!this.knownSettings) return all
        return Object.fromEntries(Object.entries(all).filter(([k]) => this.knownSettings!.includes(k)))
      },
      applyPortableSettings: (v) => this.setPortable(v),
      fileWritten: (rel) => this.written.push(rel),
      audioDays: () => Number(this.portable().syncAudioDays ?? 7)
    })
  }

  /** a restart: the engine reloads its state from disk */
  restart(): void {
    this.engine = this.makeEngine()
  }

  portable(): Record<string, unknown> {
    try {
      return JSON.parse(readFileSync(join(this.root, 'settings.json'), 'utf8'))
    } catch {
      return { ...DEFAULT_PORTABLE }
    }
  }

  setPortable(v: Record<string, unknown>): void {
    writeFileSync(join(this.root, 'settings.json'), JSON.stringify({ ...this.portable(), ...v }, null, 2))
  }

  path(...rel: string[]): string {
    return join(this.root, ...rel)
  }

  putMeeting(m: Meeting): void {
    mkdirSync(this.path('meetings', m.id), { recursive: true })
    writeFileSync(this.path('meetings', m.id, 'meeting.json'), JSON.stringify(m, null, 2))
  }

  getMeeting(id: string): Meeting | null {
    try {
      return JSON.parse(readFileSync(this.path('meetings', id, 'meeting.json'), 'utf8'))
    } catch {
      return null
    }
  }

  editMeeting(id: string, patch: Partial<Meeting>): void {
    this.putMeeting({ ...(this.getMeeting(id) as Meeting), ...patch })
  }

  meetingIds(): string[] {
    if (!existsSync(this.path('meetings'))) return []
    return readdirSync(this.path('meetings')).filter((d) => existsSync(this.path('meetings', d, 'meeting.json'))).sort()
  }

  putFile(rel: string, value: unknown): void {
    mkdirSync(join(this.root, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(this.path(...rel.split('/')), JSON.stringify(value, null, 2))
  }

  getFile<T = unknown>(rel: string): T | null {
    try {
      return JSON.parse(readFileSync(this.path(...rel.split('/')), 'utf8'))
    } catch {
      return null
    }
  }

  putBytes(rel: string, data: Buffer): void {
    mkdirSync(join(this.root, ...rel.split('/').slice(0, -1)), { recursive: true })
    writeFileSync(this.path(...rel.split('/')), data)
  }

  /** pretend a file was last written at a given time */
  age(rel: string, iso: string): void {
    const t = new Date(iso)
    utimesSync(this.path(...rel.split('/')), t, t)
  }

  sync(): Promise<void> {
    return this.engine.run()
  }
}

function setup(): { server: FakeServer; a: PC; b: PC } {
  const server = new FakeServer()
  return { server, a: new PC(server), b: new PC(server) }
}

function liveDocs(server: FakeServer, user = 'u1', collection = 'meeting'): string[] {
  return [...server.docsOf(user).values()]
    .filter((d) => d.collection === collection && !d.deleted)
    .map((d) => d.doc_id)
    .sort()
}

test('a library uploads from one PC and arrives whole on another', async () => {
  const { a, b } = setup()
  a.putMeeting(meeting('m1'))
  a.putMeeting(meeting('m2', { notes: 'second' }))
  a.putFile('planner.json', { items: [{ id: 'p1', title: 'Board refresh', status: 'now' }] })
  a.putFile('toolbox/toolbox.json', { guides: [], images: [{ id: 'i1', name: 'Logo', file: 'i1.png' }], files: [], queries: [] })
  a.setPortable({ yourName: 'Tyler', people: ['Priya', 'Sam'] })
  await a.sync()

  await b.sync()
  assert.deepEqual(b.meetingIds(), ['m1', 'm2'])
  assert.deepEqual(b.getMeeting('m2'), a.getMeeting('m2'))
  assert.deepEqual(b.getFile('planner.json'), a.getFile('planner.json'))
  assert.deepEqual(b.getFile('toolbox/toolbox.json'), a.getFile('toolbox/toolbox.json'))
  assert.equal(b.portable().yourName, 'Tyler')
  assert.deepEqual(b.portable().people, ['Priya', 'Sam'])
  assert.ok(b.written.includes('planner.json'), 'the planner module is told its file changed')
})

test('edits to different parts of the same meeting on two PCs both survive', async () => {
  const { a, b } = setup()
  a.putMeeting(meeting('m1'))
  await a.sync()
  await b.sync()

  a.editMeeting('m1', { notes: 'Follow up with Priya' })
  b.editMeeting('m1', { title: 'Enrollment ops weekly' })
  await a.sync()
  await b.sync()
  await a.sync()

  for (const pc of [a, b]) {
    const m = pc.getMeeting('m1') as Meeting
    assert.equal(m.notes, 'Follow up with Priya')
    assert.equal(m.title, 'Enrollment ops weekly')
  }
})

test('planner items added on both PCs at once are all kept', async () => {
  const { a, b } = setup()
  a.putFile('planner.json', { items: [{ id: 'p1', title: 'One', status: 'now' }] })
  await a.sync()
  await b.sync()

  a.putFile('planner.json', { items: [{ id: 'p1', title: 'One', status: 'done' }, { id: 'p2', title: 'From A', status: 'next' }] })
  b.putFile('planner.json', { items: [{ id: 'p1', title: 'One (renamed)', status: 'now' }, { id: 'p3', title: 'From B', status: 'later' }] })
  await a.sync()
  await b.sync()
  await a.sync()

  const items = (a.getFile<{ items: { id: string; title: string; status: string }[] }>('planner.json') as { items: { id: string; title: string; status: string }[] }).items
  assert.deepEqual(items.map((i) => i.id).sort(), ['p1', 'p2', 'p3'])
  assert.deepEqual(items.find((i) => i.id === 'p1'), { id: 'p1', title: 'One (renamed)', status: 'done' })
  assert.deepEqual(b.getFile('planner.json'), a.getFile('planner.json'))
})

test('the same field edited on both PCs goes to the newer edit', async () => {
  const { a, b } = setup()
  a.putFile('links.json', [{ id: 'l1', name: 'Tableau', url: 'https://a' }])
  await a.sync()
  await b.sync()

  a.putFile('links.json', [{ id: 'l1', name: 'Tableau (old edit)', url: 'https://a' }])
  a.age('links.json', '2026-11-18T11:00:00Z') // before the hub's clock
  b.putFile('links.json', [{ id: 'l1', name: 'Tableau (new edit)', url: 'https://a' }])
  await b.sync() // lands in the hub at 12:00+
  await a.sync() // A's edit is older than the hub's copy: the hub's wins
  await b.sync()

  for (const pc of [a, b]) {
    assert.equal((pc.getFile<{ name: string }[]>('links.json') as { name: string }[])[0].name, 'Tableau (new edit)')
  }
})

test('a meeting deleted on one PC leaves the other, into its sync trash', async () => {
  const { server, a, b } = setup()
  for (const id of ['m1', 'm2', 'm3']) a.putMeeting(meeting(id))
  await a.sync()
  await b.sync()

  rmSync(a.path('meetings', 'm2'), { recursive: true })
  await a.sync()
  await b.sync()

  assert.deepEqual(b.meetingIds(), ['m1', 'm3'])
  assert.deepEqual(liveDocs(server), ['m1', 'm3'])
  const trashDay = readdirSync(b.path('sync-trash'))[0]
  assert.ok(existsSync(b.path('sync-trash', trashDay, 'meetings', 'm2', 'meeting.json')))
})

test('an edit beats a deletion made elsewhere, in either order', async () => {
  const { a, b } = setup()
  a.putMeeting(meeting('m1'))
  a.putMeeting(meeting('m2'))
  await a.sync()
  await b.sync()

  // B edits first, then A's deletion is refused and the meeting comes back
  b.editMeeting('m1', { notes: 'kept' })
  await b.sync()
  rmSync(a.path('meetings', 'm1'), { recursive: true })
  await a.sync()
  assert.equal(a.getMeeting('m1')?.notes, 'kept')

  // A deletes first, then B's later edit brings it back everywhere
  rmSync(a.path('meetings', 'm2'), { recursive: true })
  await a.sync()
  b.editMeeting('m2', { notes: 'still needed' })
  await b.sync()
  await a.sync()
  assert.equal(a.getMeeting('m2')?.notes, 'still needed')
  assert.equal(b.getMeeting('m2')?.notes, 'still needed')
})

test('many deletions at once wait for a yes, and can be undone', async () => {
  const { server, a, b } = setup()
  const ids = Array.from({ length: 10 }, (_, i) => `m${i}`)
  for (const id of ids) a.putMeeting(meeting(id))
  await a.sync()
  await b.sync()

  for (const id of ids.slice(0, 8)) rmSync(a.path('meetings', id), { recursive: true })
  await a.sync()
  assert.equal(a.engine.heldCount, 8)
  assert.equal(liveDocs(server).length, 10, 'nothing deleted in the hub yet')

  a.engine.restoreDeletes()
  await a.sync()
  assert.deepEqual(a.meetingIds(), ids)
  assert.equal(a.engine.heldCount, 0)

  for (const id of ids.slice(0, 8)) rmSync(a.path('meetings', id), { recursive: true })
  await a.sync()
  a.engine.confirmDeletes()
  await a.sync()
  assert.equal(a.engine.heldCount, 0)
  assert.deepEqual(liveDocs(server), ['m8', 'm9'])
  await b.sync()
  assert.deepEqual(b.meetingIds(), ['m8', 'm9'])
})

test('a meeting still being processed is not synced until it is done', async () => {
  const { server, a, b } = setup()
  a.putMeeting(meeting('m1', { stage: 'transcribing', progress: 40 }))
  await a.sync()
  assert.deepEqual(liveDocs(server), [])

  a.editMeeting('m1', { stage: 'ready', progress: undefined })
  await a.sync()
  await b.sync()
  assert.equal(b.getMeeting('m1')?.stage, 'ready')

  // and an incoming change waits while this PC works on the meeting
  b.editMeeting('m1', { stage: 'summarizing' })
  a.editMeeting('m1', { notes: 'from A' })
  await a.sync()
  await b.sync()
  assert.equal(b.getMeeting('m1')?.notes, undefined)
  b.editMeeting('m1', { stage: 'ready' })
  await b.sync()
  assert.equal(b.getMeeting('m1')?.notes, 'from A')
})

test('an unreadable meeting file is never taken for a deletion', async () => {
  const { server, a } = setup()
  a.putMeeting(meeting('m1'))
  await a.sync()
  writeFileSync(a.path('meetings', 'm1', 'meeting.json'), '{ half a fi')
  await a.sync()
  assert.deepEqual(liveDocs(server), ['m1'])
})

test("a new PC's default settings never override the library's", async () => {
  const { a, b } = setup()
  a.setPortable({ yourName: 'Tyler', theme: 'dusk', people: ['Priya'] })
  await a.sync()
  b.setPortable({ ...DEFAULT_PORTABLE }) // written just now: newer than A's
  await b.sync()
  assert.equal(b.portable().yourName, 'Tyler')
  assert.equal(b.portable().theme, 'dusk')
  assert.deepEqual(b.portable().people, ['Priya'])
})

test('a PC that already had its own library merges it in on first sync', async () => {
  const { a, b } = setup()
  a.putMeeting(meeting('m1', { notes: 'from A' }))
  a.putMeeting(meeting('m2'))
  await a.sync()

  b.putMeeting(meeting('m1', { tags: ['restored'] }))
  b.putMeeting(meeting('m3'))
  await b.sync()
  await a.sync()

  for (const pc of [a, b]) assert.deepEqual(pc.meetingIds(), ['m1', 'm2', 'm3'])
  const m1 = b.getMeeting('m1') as Meeting
  assert.equal(m1.notes, 'from A')
  assert.deepEqual(m1.tags, ['restored'])
  assert.deepEqual(a.getMeeting('m1'), b.getMeeting('m1'))
})

test('attachments follow: added, replaced, and removed', async () => {
  const { a, b } = setup()
  a.putBytes('toolbox/images/i1.png', Buffer.from('png-v1'))
  a.putBytes('link-thumbs/l1.jpg', Buffer.from('jpeg'))
  await a.sync()
  await b.sync()
  assert.equal(readFileSync(b.path('toolbox', 'images', 'i1.png'), 'utf8'), 'png-v1')
  assert.equal(readFileSync(b.path('link-thumbs', 'l1.jpg'), 'utf8'), 'jpeg')

  b.putBytes('toolbox/images/i1.png', Buffer.from('png-v2'))
  await b.sync()
  await a.sync()
  assert.equal(readFileSync(a.path('toolbox', 'images', 'i1.png'), 'utf8'), 'png-v2')

  rmSync(a.path('link-thumbs', 'l1.jpg'))
  await a.sync()
  await b.sync()
  assert.ok(!existsSync(b.path('link-thumbs', 'l1.jpg')))
})

test('recent audio syncs, old audio stays home, and the window ages it out', async () => {
  const { server, a, b } = setup()
  const old = new Date(Date.now() - 30 * 864e5).toISOString()
  a.putMeeting(meeting('new', { hasAudio: true }))
  a.putBytes('meetings/new/audio.webm', Buffer.from('recent recording'))
  a.putMeeting(meeting('old', { hasAudio: true, createdAt: old }))
  a.putBytes('meetings/old/audio.webm', Buffer.from('old recording'))
  await a.sync()
  assert.deepEqual([...server.files.keys()].filter((k) => k.includes('/audio/')), ['u1/audio/new.webm'])

  await b.sync()
  assert.equal(readFileSync(b.path('meetings', 'new', 'audio.webm'), 'utf8'), 'recent recording')
  assert.ok(!existsSync(b.path('meetings', 'old', 'audio.webm')), 'old audio stays on the PC that has it')

  // turning the hub copy off removes it there, but nobody loses their file
  a.setPortable({ syncAudioDays: 0 })
  await a.sync()
  await b.sync()
  assert.equal([...server.files.keys()].filter((k) => k.includes('/audio/')).length, 0)
  assert.ok(existsSync(a.path('meetings', 'new', 'audio.webm')))
  assert.ok(existsSync(b.path('meetings', 'new', 'audio.webm')))
  assert.equal(b.portable().syncAudioDays, 0, 'the window is the same on every PC')
})

test('"delete audio, keep notes" on one PC removes the audio everywhere', async () => {
  const { server, a, b } = setup()
  a.putMeeting(meeting('m1', { hasAudio: true }))
  a.putBytes('meetings/m1/audio.webm', Buffer.from('rec'))
  await a.sync()
  await b.sync()
  assert.ok(existsSync(b.path('meetings', 'm1', 'audio.webm')))

  rmSync(a.path('meetings', 'm1', 'audio.webm'))
  a.editMeeting('m1', { hasAudio: false })
  await a.sync()
  await b.sync()
  assert.ok(!existsSync(b.path('meetings', 'm1', 'audio.webm')))
  assert.equal(server.files.size, 0)
})

test('Ask questions asked on two PCs at once are both kept', async () => {
  const { a, b } = setup()
  const qa = (q: string): { q: string; a: string } => ({ q, a: `answer to ${q}` })
  a.putFile('ask.json', [qa('first')])
  await a.sync()
  await b.sync()
  a.putFile('ask.json', [qa('first'), qa('from A')])
  b.putFile('ask.json', [qa('first'), qa('from B')])
  await a.sync()
  await b.sync()
  await a.sync()
  const qs = (a.getFile<{ q: string }[]>('ask.json') as { q: string }[]).map((x) => x.q)
  assert.deepEqual(qs.sort(), ['first', 'from A', 'from B'])
  assert.deepEqual(a.getFile('ask.json'), b.getFile('ask.json'))
})

test("one person's library is invisible to another", async () => {
  const server = new FakeServer()
  const tyler = new PC(server, 'u1')
  const colleague = new PC(server, 'u2')
  tyler.putMeeting(meeting('m1'))
  tyler.putBytes('toolbox/images/i1.png', Buffer.from('img'))
  await tyler.sync()
  await colleague.sync()
  assert.deepEqual(colleague.meetingIds(), [])
  assert.ok(!existsSync(colleague.path('toolbox', 'images', 'i1.png')))
  await assert.rejects(colleague.hub.download('u1/files/x'), HubError)
})

test('a quiet pass sends nothing, and a restart picks up where it left off', async () => {
  const { a } = setup()
  a.putMeeting(meeting('m1'))
  a.putFile('planner.json', { items: [] })
  await a.sync()
  const before = a.hub.pushes
  await a.sync()
  a.restart()
  await a.sync()
  assert.equal(a.hub.pushes, before)
})

test('offline: the pass fails cleanly and catches up later', async () => {
  const { server, a, b } = setup()
  a.putMeeting(meeting('m1'))
  server.offline = true
  await assert.rejects(a.sync(), (err: unknown) => err instanceof HubError && err.kind === 'network')
  assert.deepEqual(a.meetingIds(), ['m1'])
  server.offline = false
  await a.sync()
  await b.sync()
  assert.deepEqual(b.meetingIds(), ['m1'])
})

test('a third PC joining late gets everything, including deletions', async () => {
  const { server, a, b } = setup()
  a.putMeeting(meeting('m1'))
  a.putMeeting(meeting('m2'))
  await a.sync()
  await b.sync()
  rmSync(b.path('meetings', 'm1'), { recursive: true })
  b.editMeeting('m2', { notes: 'edited on B' })
  await b.sync()
  const c = new PC(server)
  await c.sync()
  assert.deepEqual(c.meetingIds(), ['m2'])
  assert.equal(c.getMeeting('m2')?.notes, 'edited on B')
})

test('a setting only a newer version knows survives an older PC, without ping-pong', async () => {
  const server = new FakeServer()
  const newer = new PC(server)
  const older = new PC(server, 'u1', ['yourName', 'theme', 'people', 'syncAudioDays'])
  newer.setPortable({ yourName: 'Tyler', brandNewSetting: 'on' })
  await newer.sync()
  await older.sync()
  older.setPortable({ theme: 'slate' })
  await older.sync()
  await newer.sync()
  assert.equal(newer.portable().brandNewSetting, 'on')
  assert.equal(newer.portable().theme, 'slate')
  const settle = newer.hub.pushes + older.hub.pushes
  for (let i = 0; i < 3; i++) {
    await older.sync()
    await newer.sync()
  }
  assert.equal(newer.hub.pushes + older.hub.pushes, settle)
})
