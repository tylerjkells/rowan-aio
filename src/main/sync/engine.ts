import { createHash, randomUUID } from 'crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, extname, join } from 'path'
import { gunzipSync, gzipSync } from 'zlib'
import { equal, hashOf, merge3, sanitize } from './merge'
import { HubError, type DocRef, type Hub, type PushDoc, type RemoteDoc, type RemoteKey } from './hub'

// ---------------------------------------------------------------------------
// The sync engine. Every PC keeps its full library on disk exactly as before;
// the engine mirrors it into the hub and folds in what other devices changed.
//
//  - Documents: each meeting.json, a fixed list of workspace JSON files, and
//    the portable part of Settings. Each is one row in the hub with a revision
//    number. A pass pulls rows changed since the last pass and three-way
//    merges them into the local file (against the last version both sides
//    agreed on, kept gzipped in sync/base), then pushes anything changed
//    here. A push names the revision it was made from; if the hub moved on in
//    the meantime it is refused, pulled, merged, and pushed again.
//  - Attachments (toolbox files, link thumbnails, prep files) go to file
//    storage under their content hash, with a small row recording which hash
//    each path holds.
//  - Audio: recordings from the last N days only. Older audio stays on the
//    PCs that have it; the hub copy is removed as it ages out.
//
// Nothing here knows about Electron: index.ts wires it to the app, and the
// tests drive it with temp folders and an in-memory hub.
// ---------------------------------------------------------------------------

export type SyncArea =
  | 'meetings'
  | 'settings'
  | 'planner'
  | 'links'
  | 'dashboards'
  | 'people'
  | 'brand'
  | 'tickets'
  | 'toolbox'
  | 'today'
  | 'ask'

/** workspace files synced whole, and the parts of the app each one feeds */
export const SYNCED_FILES: Record<string, SyncArea[]> = {
  'planner.json': ['planner', 'today'],
  'links.json': ['links', 'today'],
  'dashboards.json': ['dashboards'],
  'directory.json': ['people'],
  'brand.json': ['brand'],
  'tickets.json': ['tickets'],
  'team-tickets.json': ['tickets'],
  'status-update.json': ['tickets'],
  'ask.json': ['ask'],
  'prep.json': ['today'],
  'recap.json': ['today'],
  'toolbox/toolbox.json': ['toolbox']
}

/** folders of attachments, synced through file storage */
export const BLOB_DIRS: Record<string, SyncArea[]> = {
  'toolbox/guides': ['toolbox'],
  'toolbox/images': ['toolbox'],
  'toolbox/files': ['toolbox'],
  'link-thumbs': ['links'],
  prep: ['today']
}

/** the Supabase free plan's per-file limit; bigger files stay on their PC */
export const MAX_FILE_BYTES = 50 * 1024 * 1024

/** meetings this PC is still working on are never synced mid-flight */
const BUSY_STAGES = new Set(['recorded', 'transcribing', 'identifying', 'summarizing'])

/** re-list rows from a little before the cursor: a slow write can land late */
const LOOKBACK_MS = 2 * 60_000
const PAGE = 500
const FETCH_BATCH = 25
const PUSH_MAX_DOCS = 50
const PUSH_MAX_BYTES = 1_500_000
/** more local deletions than this (and a fifth of the library) wait for a yes */
const DELETE_GUARD_MIN = 5
const DELETE_GUARD_SHARE = 0.2
const TRASH_KEEP_DAYS = 30

export interface SyncChange {
  areas: Set<SyncArea>
  /** meetings written or newly given audio */
  meetings: string[]
  /** meetings removed because another device deleted them */
  removedMeetings: string[]
}

export interface SyncHooks {
  readPortableSettings(): Record<string, unknown>
  applyPortableSettings(v: Record<string, unknown>): void
  /** called the moment a synced file is rewritten, so in-memory copies drop */
  fileWritten(rel: string): void
  /** days of recordings kept in the hub; 0 keeps none */
  audioDays(): number
  progress?(text: string | null): void
}

interface DocState {
  rev: number
  /** hash of the last version this PC and the hub agreed on */
  hash: string
  /** hash of the local file when it last had this size and mtime */
  lhash?: string
  mtime?: number
  size?: number
}

interface BlobState {
  rev: number
  hash: string
  bytes: number
  lhash?: string
  mtime?: number
  size?: number
}

interface AudioState {
  rev: number
  ext: string
  bytes: number
  createdAt: string
  /** gone from the hub (aged out or removed); never uploaded again */
  deleted?: boolean
}

interface SyncState {
  version: 1
  userId: string
  device: string
  cursor: { at: string; rev: number }
  docs: Record<string, DocState>
  blobs: Record<string, BlobState>
  audio: Record<string, AudioState>
  /** documents to fetch again on the next pass (refused pushes, deferred merges) */
  retry: string[]
  /** local deletions waiting for the user to confirm or undo */
  held: string[]
  confirmDeletes?: boolean
  lastSyncAt?: string
}

interface LocalDoc {
  body: unknown
  mtime: number
  size: number
}

type Inspection =
  | { state: 'missing' }
  | { state: 'unreadable' }
  | { state: 'busy' }
  | { state: 'present'; lhash: string; mtime: number; size: number; read: () => LocalDoc }

interface MeetingMeta {
  mtime: number
  size: number
  lhash: string
  stage: string
  createdAt: string
  hasAudio: boolean
}

const EPOCH = '1970-01-01T00:00:00.000Z'

function keyOf(collection: string, id: string): string {
  return `${collection}:${id}`
}

function splitKey(key: string): DocRef {
  const i = key.indexOf(':')
  return { collection: key.slice(0, i), doc_id: key.slice(i + 1) }
}

function sha256(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** write beside, then rename over: a crash never leaves half a file */
function writeAtomic(path: string, data: string | Buffer): { mtime: number; size: number } {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.sync-tmp`
  writeFileSync(tmp, data)
  try {
    renameSync(tmp, path)
  } catch {
    // a reader holding the file open on Windows: fall back to a plain write
    writeFileSync(path, data)
    rmSync(tmp, { force: true })
  }
  const st = statSync(path)
  return { mtime: st.mtimeMs, size: st.size }
}

function mimeOf(path: string): string {
  const ext = extname(path).toLowerCase()
  const known: Record<string, string> = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.html': 'text/html',
    '.pdf': 'application/pdf',
    '.webm': 'audio/webm',
    '.wav': 'audio/wav'
  }
  return known[ext] ?? 'application/octet-stream'
}

export class SyncEngine {
  private state: SyncState
  private readonly syncDir: string
  private readonly baseDir: string
  private readonly meetingsDir: string
  private meta = new Map<string, MeetingMeta>()
  private change: SyncChange = { areas: new Set(), meetings: [], removedMeetings: [] }
  /** files over the size limit, kept on this PC only */
  tooLarge = new Set<string>()

  constructor(
    private readonly root: string,
    private readonly hub: Hub,
    private readonly hooks: SyncHooks
  ) {
    this.syncDir = join(root, 'sync')
    this.baseDir = join(this.syncDir, 'base')
    this.meetingsDir = join(root, 'meetings')
    this.state = this.loadState()
  }

  // ---- state -------------------------------------------------------------

  private statePath(): string {
    return join(this.syncDir, 'state.json')
  }

  private loadState(): SyncState {
    try {
      const s = JSON.parse(readFileSync(this.statePath(), 'utf8')) as SyncState
      if (s.version === 1 && s.userId === this.hub.userId) {
        return { ...s, retry: s.retry ?? [], held: s.held ?? [], audio: s.audio ?? {}, blobs: s.blobs ?? {} }
      }
    } catch {
      // first sync on this PC
    }
    rmSync(this.baseDir, { recursive: true, force: true })
    return {
      version: 1,
      userId: this.hub.userId,
      device: randomUUID(),
      cursor: { at: EPOCH, rev: 0 },
      docs: {},
      blobs: {},
      audio: {},
      retry: [],
      held: []
    }
  }

  private saveState(): void {
    writeAtomic(this.statePath(), JSON.stringify(this.state))
  }

  /** the account this PC's library last synced with, if any */
  static ownerOf(root: string): string | null {
    try {
      const s = JSON.parse(readFileSync(join(root, 'sync', 'state.json'), 'utf8')) as SyncState
      return s.userId ?? null
    } catch {
      return null
    }
  }

  get lastSyncAt(): string | null {
    return this.state.lastSyncAt ?? null
  }

  get heldCount(): number {
    return this.state.held.length
  }

  private basePath(key: string): string {
    return join(this.baseDir, `${createHash('sha1').update(key).digest('hex')}.json.gz`)
  }

  private readBase(key: string): unknown {
    try {
      return JSON.parse(gunzipSync(readFileSync(this.basePath(key))).toString('utf8'))
    } catch {
      return undefined
    }
  }

  private setBase(key: string, body: unknown, rev: number, local: { lhash: string; mtime?: number; size?: number }): void {
    mkdirSync(this.baseDir, { recursive: true })
    writeFileSync(this.basePath(key), gzipSync(JSON.stringify(body)))
    this.state.docs[key] = { rev, hash: hashOf(body), ...local }
  }

  private dropDoc(key: string): void {
    delete this.state.docs[key]
    rmSync(this.basePath(key), { force: true })
  }

  private noteArea(...areas: SyncArea[]): void {
    for (const a of areas) this.change.areas.add(a)
  }

  /** what changed since the last call; the caller refreshes the app */
  takeChange(): SyncChange {
    const c = this.change
    this.change = { areas: new Set(), meetings: [], removedMeetings: [] }
    return c
  }

  // ---- trash -------------------------------------------------------------

  /** things removed because another device deleted them land here for a month */
  private trash(abs: string, rel: string): void {
    if (!existsSync(abs)) return
    const day = new Date().toISOString().slice(0, 10)
    let dest = join(this.root, 'sync-trash', day, rel)
    if (existsSync(dest)) dest = `${dest}.${Date.now()}`
    try {
      mkdirSync(dirname(dest), { recursive: true })
      renameSync(abs, dest)
    } catch {
      rmSync(abs, { recursive: true, force: true })
    }
  }

  purgeTrash(): void {
    const dir = join(this.root, 'sync-trash')
    if (!existsSync(dir)) return
    const cutoff = Date.now() - TRASH_KEEP_DAYS * 864e5
    for (const day of readdirSync(dir)) {
      const t = Date.parse(day)
      if (Number.isFinite(t) && t < cutoff) rmSync(join(dir, day), { recursive: true, force: true })
    }
  }

  // ---- local documents ---------------------------------------------------

  private docPath(collection: string, id: string): string | null {
    if (collection === 'meeting') {
      if (!/^[\w-]+$/.test(id)) return null
      return join(this.meetingsDir, id, 'meeting.json')
    }
    if (collection === 'file' && SYNCED_FILES[id]) return join(this.root, ...id.split('/'))
    return null
  }

  private areasOf(collection: string, id: string): SyncArea[] {
    if (collection === 'meeting') return ['meetings', 'today']
    if (collection === 'settings') return ['settings', 'people', 'today']
    return SYNCED_FILES[id] ?? []
  }

  /** read a meeting's sync-relevant facts, parsing only when the file changed */
  private meetingMeta(id: string): MeetingMeta | 'missing' | 'unreadable' {
    const path = join(this.meetingsDir, id, 'meeting.json')
    let st
    try {
      st = statSync(path)
    } catch {
      this.meta.delete(id)
      return 'missing'
    }
    const cached = this.meta.get(id)
    if (cached && cached.mtime === st.mtimeMs && cached.size === st.size) return cached
    try {
      const body = sanitize(JSON.parse(readFileSync(path, 'utf8')))
      if (!isObj(body)) return 'unreadable'
      const m: MeetingMeta = {
        mtime: st.mtimeMs,
        size: st.size,
        lhash: hashOf(body),
        stage: String(body.stage ?? ''),
        createdAt: String(body.createdAt ?? ''),
        hasAudio: body.hasAudio === true
      }
      this.meta.set(id, m)
      return m
    } catch {
      return 'unreadable'
    }
  }

  private readDoc(path: string): LocalDoc {
    const st = statSync(path)
    return { body: sanitize(JSON.parse(readFileSync(path, 'utf8'))), mtime: st.mtimeMs, size: st.size }
  }

  private inspect(key: string): Inspection {
    const { collection, doc_id: id } = splitKey(key)
    if (collection === 'settings') {
      // fields a newer version syncs (and this one doesn't know) ride along
      // untouched, so two versions never undo each other
      const base = this.state.docs[key] ? this.readBase(key) : undefined
      const body = sanitize({ ...(isObj(base) ? base : {}), ...this.hooks.readPortableSettings() })
      let mtime = 0
      try {
        mtime = statSync(join(this.root, 'settings.json')).mtimeMs
      } catch {
        // never saved
      }
      return { state: 'present', lhash: hashOf(body), mtime, size: 0, read: () => ({ body, mtime, size: 0 }) }
    }
    const path = this.docPath(collection, id)
    if (!path) return { state: 'missing' }
    if (collection === 'meeting') {
      const m = this.meetingMeta(id)
      if (m === 'missing' || m === 'unreadable') return { state: m }
      if (BUSY_STAGES.has(m.stage)) return { state: 'busy' }
      return { state: 'present', lhash: m.lhash, mtime: m.mtime, size: m.size, read: () => this.readDoc(path) }
    }
    let st
    try {
      st = statSync(path)
    } catch {
      return { state: 'missing' }
    }
    const ds = this.state.docs[key]
    if (ds?.lhash && ds.mtime === st.mtimeMs && ds.size === st.size) {
      return { state: 'present', lhash: ds.lhash, mtime: st.mtimeMs, size: st.size, read: () => this.readDoc(path) }
    }
    try {
      const doc = this.readDoc(path)
      return { state: 'present', lhash: hashOf(doc.body), mtime: doc.mtime, size: doc.size, read: () => doc }
    } catch {
      return { state: 'unreadable' }
    }
  }

  private writeDoc(collection: string, id: string, body: unknown): { mtime: number; size: number } {
    if (collection === 'settings') {
      this.hooks.applyPortableSettings(isObj(body) ? body : {})
      return { mtime: Date.now(), size: 0 }
    }
    const path = this.docPath(collection, id)
    if (!path) throw new Error(`not a synced document: ${collection}:${id}`)
    const stat = writeAtomic(path, JSON.stringify(body, null, 2))
    if (collection === 'file') this.hooks.fileWritten(id)
    if (collection === 'meeting') this.meta.delete(id)
    return stat
  }

  private localDocKeys(): string[] {
    const keys = ['settings:portable']
    for (const rel of Object.keys(SYNCED_FILES)) {
      if (existsSync(join(this.root, ...rel.split('/')))) keys.push(keyOf('file', rel))
    }
    if (existsSync(this.meetingsDir)) {
      for (const e of readdirSync(this.meetingsDir, { withFileTypes: true })) {
        if (e.isDirectory() && existsSync(join(this.meetingsDir, e.name, 'meeting.json'))) {
          keys.push(keyOf('meeting', e.name))
        }
      }
    }
    return keys
  }

  private audioFile(id: string): string | null {
    for (const name of ['audio.webm', 'audio.wav']) {
      const p = join(this.meetingsDir, id, name)
      if (existsSync(p)) return p
    }
    return null
  }

  // ---- applying what the hub has -----------------------------------------

  private applyDoc(d: RemoteDoc): void {
    const key = keyOf(d.collection, d.doc_id)
    if (d.collection === 'settings' && d.doc_id !== 'portable') return
    if (d.collection !== 'settings' && !this.docPath(d.collection, d.doc_id)) return
    const ds = this.state.docs[key]
    const insp = this.inspect(key)
    if (insp.state === 'busy' || insp.state === 'unreadable') {
      // this PC is mid-way through the meeting (or the file is broken): later
      this.state.retry.push(key)
      return
    }
    const local = insp.state === 'present' ? insp.read() : null
    const areas = this.areasOf(d.collection, d.doc_id)

    if (d.deleted) {
      if (!local) {
        this.dropDoc(key)
      } else if (ds && insp.state === 'present' && insp.lhash === ds.hash) {
        // unchanged here since we last agreed: follow the deletion
        if (d.collection === 'meeting') {
          this.trash(join(this.meetingsDir, d.doc_id), join('meetings', d.doc_id))
          this.meta.delete(d.doc_id)
          this.change.removedMeetings.push(d.doc_id)
        } else {
          this.trash(this.docPath(d.collection, d.doc_id) as string, d.doc_id)
          if (d.collection === 'file') this.hooks.fileWritten(d.doc_id)
        }
        this.dropDoc(key)
        this.noteArea(...areas)
      } else {
        // edited here since: keep it, and it goes back up on this pass
        this.dropDoc(key)
        this.state.docs[key] = { rev: d.rev, hash: '' }
      }
      return
    }

    if (d.collection === 'meeting' && isObj(d.body) && BUSY_STAGES.has(String(d.body.stage))) return

    if (!local) {
      // new to this PC, or deleted here while the other side kept editing:
      // either way the hub's copy is what we want
      const stat = this.writeDoc(d.collection, d.doc_id, d.body)
      this.setBase(key, d.body, d.rev, { lhash: hashOf(d.body), ...stat })
      if (d.collection === 'meeting') this.change.meetings.push(d.doc_id)
      this.noteArea(...areas)
      return
    }

    const base = ds ? this.readBase(key) : undefined
    // a real conflict goes to the newer edit; with no shared history the hub
    // wins, so a fresh PC's defaults never override the library
    const prefer = ds && local.mtime > Date.parse(d.updated_at) ? 'local' : 'remote'
    const merged = merge3(base, local.body, d.body, prefer)
    let stat = { mtime: local.mtime, size: local.size }
    if (!equal(merged, local.body)) {
      stat = this.writeDoc(d.collection, d.doc_id, merged)
      if (d.collection === 'meeting') {
        // audio deleted on another device ("delete audio, keep notes")
        if (isObj(local.body) && isObj(merged) && local.body.hasAudio === true && merged.hasAudio === false) {
          const audio = this.audioFile(d.doc_id)
          if (audio) rmSync(audio, { force: true })
        }
        this.change.meetings.push(d.doc_id)
      }
      this.noteArea(...areas)
    }
    this.setBase(key, d.body, d.rev, {
      lhash: hashOf(merged),
      ...(d.collection === 'settings' ? {} : stat)
    })
  }

  private knownRev(k: RemoteKey): number | undefined {
    if (k.collection === 'blob') return this.state.blobs[k.doc_id]?.rev
    if (k.collection === 'audio') return this.state.audio[k.doc_id]?.rev
    return this.state.docs[keyOf(k.collection, k.doc_id)]?.rev
  }

  private async pull(): Promise<void> {
    const st = this.state
    const lookback = Math.max(0, Date.parse(st.cursor.at) - LOOKBACK_MS)
    let at = new Date(lookback).toISOString()
    let rev = 0
    let cursor = st.cursor
    // a meeting still being processed here waits; everything else is fetched again
    const waiting = st.retry.filter((k) => k.startsWith('meeting:') && this.inspect(k).state === 'busy')
    const wanted = new Set<string>(st.retry.filter((k) => !waiting.includes(k)))
    for (;;) {
      const page = await this.hub.changes(at, rev, PAGE)
      for (const k of page) {
        const t = Date.parse(k.updated_at)
        const c = Date.parse(cursor.at)
        if (t > c || (t === c && k.rev > cursor.rev)) cursor = { at: k.updated_at, rev: k.rev }
        if (this.knownRev(k) !== k.rev) wanted.add(keyOf(k.collection, k.doc_id))
      }
      if (page.length < PAGE) break
      const last = page[page.length - 1]
      at = last.updated_at
      rev = last.rev
    }
    st.retry = waiting

    const keys = [...wanted]
    let done = 0
    for (let i = 0; i < keys.length; i += FETCH_BATCH) {
      if (keys.length > FETCH_BATCH) this.hooks.progress?.(`Downloading: ${done} of ${keys.length}`)
      const docs = await this.hub.fetch(keys.slice(i, i + FETCH_BATCH).map(splitKey))
      for (const d of docs) {
        if (d.collection === 'blob') await this.applyBlob(d)
        else if (d.collection === 'audio') this.applyAudio(d)
        else this.applyDoc(d)
      }
      done += Math.min(FETCH_BATCH, keys.length - i)
      this.saveState()
    }
    st.cursor = cursor
  }

  // ---- pushing local changes ----------------------------------------------

  /**
   * Keys whose deletion may go ahead now. A pass that would delete many
   * things at once (a missing folder, a botched restore) holds them all
   * until the user says delete or restore.
   */
  private gateDeletes(kind: string, keys: string[], total: number): string[] {
    const st = this.state
    // held items that came back on their own no longer need an answer
    st.held = st.held.filter((k) => !k.startsWith(`${kind}:`) || keys.includes(k))
    if (keys.length === 0) return []
    const allowed = st.confirmDeletes ? keys.filter((k) => st.held.includes(k)) : []
    const rest = keys.filter((k) => !allowed.includes(k))
    if (rest.length > DELETE_GUARD_MIN && rest.length > total * DELETE_GUARD_SHARE) {
      st.held = [...new Set([...st.held, ...rest])]
      return allowed
    }
    return [...allowed, ...rest]
  }

  private async pushDocs(): Promise<void> {
    const st = this.state
    const pending: { key: string; doc: PushDoc; size: number; local?: LocalDoc }[] = []
    const present = new Set<string>()

    for (const key of this.localDocKeys()) {
      const insp = this.inspect(key)
      if (insp.state !== 'missing') present.add(key)
      if (insp.state !== 'present') continue
      const ds = st.docs[key]
      if (ds && insp.lhash === ds.hash) {
        if (ds.lhash !== insp.lhash || ds.mtime !== insp.mtime) {
          st.docs[key] = { ...ds, lhash: insp.lhash, mtime: insp.mtime, size: insp.size }
        }
        continue
      }
      let local: LocalDoc
      try {
        local = insp.read()
      } catch {
        continue
      }
      const { collection, doc_id } = splitKey(key)
      const doc: PushDoc = { collection, doc_id, body: local.body, deleted: false, base_rev: ds?.rev ?? null }
      pending.push({ key, doc, size: JSON.stringify(local.body).length, local })
    }

    const meetingKeys = Object.keys(st.docs).filter((k) => k.startsWith('meeting:'))
    for (const k of meetingKeys) if (!present.has(k) && st.docs[k].hash === '') this.dropDoc(k)
    const gone = meetingKeys.filter((k) => !present.has(k) && st.docs[k])
    for (const key of this.gateDeletes('meeting', gone, meetingKeys.length)) {
      const { collection, doc_id } = splitKey(key)
      pending.push({ key, doc: { collection, doc_id, body: null, deleted: true, base_rev: st.docs[key].rev }, size: 100 })
    }

    const total = pending.length
    let done = 0
    while (pending.length) {
      const batch: typeof pending = []
      let bytes = 0
      while (pending.length && batch.length < PUSH_MAX_DOCS && (batch.length === 0 || bytes + pending[0].size <= PUSH_MAX_BYTES)) {
        const next = pending.shift()!
        bytes += next.size
        batch.push(next)
      }
      if (total > PUSH_MAX_DOCS) this.hooks.progress?.(`Uploading: ${done} of ${total}`)
      const results = await this.hub.push(batch.map((b) => b.doc), st.device)
      for (const r of results) {
        const item = batch.find((b) => b.doc.collection === r.collection && b.doc.doc_id === r.doc_id)
        if (!item) continue
        if (!r.ok) {
          st.retry.push(item.key)
          continue
        }
        if (item.doc.deleted) {
          this.dropDoc(item.key)
          st.held = st.held.filter((k) => k !== item.key)
          if (r.collection === 'meeting') await this.dropAudio(r.doc_id)
        } else {
          const local = item.local as LocalDoc
          this.setBase(item.key, item.doc.body, r.rev, {
            lhash: hashOf(item.doc.body),
            ...(r.collection === 'settings' ? {} : { mtime: local.mtime, size: local.size })
          })
        }
      }
      done += batch.length
      this.saveState()
    }
  }

  // ---- attachments --------------------------------------------------------

  private blobArea(rel: string): SyncArea[] {
    for (const [dir, areas] of Object.entries(BLOB_DIRS)) if (rel.startsWith(`${dir}/`)) return areas
    return []
  }

  private blobAllowed(rel: string): boolean {
    return (
      this.blobArea(rel).length > 0 &&
      !rel.split('/').some((s) => s === '..' || s === '.' || s === '' || /[\\:]/.test(s))
    )
  }

  private blobObject(hash: string): string {
    return `${this.hub.userId}/files/${hash}`
  }

  private localBlobs(): Map<string, { abs: string; mtime: number; size: number }> {
    const out = new Map<string, { abs: string; mtime: number; size: number }>()
    const walk = (abs: string, rel: string): void => {
      let entries
      try {
        entries = readdirSync(abs, { withFileTypes: true })
      } catch {
        return
      }
      for (const e of entries) {
        const a = join(abs, e.name)
        const r = `${rel}/${e.name}`
        if (e.isDirectory()) walk(a, r)
        else if (e.isFile() && !e.name.endsWith('.sync-tmp')) {
          const st = statSync(a)
          out.set(r, { abs: a, mtime: st.mtimeMs, size: st.size })
        }
      }
    }
    for (const dir of Object.keys(BLOB_DIRS)) walk(join(this.root, ...dir.split('/')), dir)
    return out
  }

  private blobHash(rel: string, info: { abs: string; mtime: number; size: number }): string {
    const bs = this.state.blobs[rel]
    if (bs?.lhash && bs.mtime === info.mtime && bs.size === info.size) return bs.lhash
    return sha256(readFileSync(info.abs))
  }

  private blobReferenced(hash: string, except: string): boolean {
    return Object.entries(this.state.blobs).some(([rel, b]) => rel !== except && b.hash === hash)
  }

  private async applyBlob(d: RemoteDoc): Promise<void> {
    const rel = d.doc_id
    if (!this.blobAllowed(rel)) return
    const st = this.state
    const bs = st.blobs[rel]
    const abs = join(this.root, ...rel.split('/'))
    let info: { abs: string; mtime: number; size: number } | null = null
    try {
      const s = statSync(abs)
      info = { abs, mtime: s.mtimeMs, size: s.size }
    } catch {
      // not here
    }
    const lhash = info ? this.blobHash(rel, info) : null

    if (d.deleted) {
      if (info && bs && lhash === bs.hash) {
        this.trash(abs, rel)
        this.noteArea(...this.blobArea(rel))
        delete st.blobs[rel]
      } else if (info) {
        st.blobs[rel] = { rev: d.rev, hash: '', bytes: 0 }
      } else {
        delete st.blobs[rel]
      }
      return
    }

    const body = isObj(d.body) ? d.body : {}
    const hash = String(body.hash ?? '')
    const bytes = Number(body.bytes ?? 0)
    if (info && lhash === hash) {
      st.blobs[rel] = { rev: d.rev, hash, bytes, lhash, mtime: info.mtime, size: info.size }
      return
    }
    const changedHere = info !== null && (!bs || lhash !== bs.hash)
    if (changedHere && bs && info && info.mtime > Date.parse(d.updated_at)) {
      // both sides replaced it and ours is newer: keep it, it goes back up
      st.blobs[rel] = { rev: d.rev, hash, bytes }
      return
    }
    let data: Buffer
    try {
      data = await this.hub.download(this.blobObject(hash))
    } catch (err) {
      if (err instanceof HubError && err.kind === 'missing') {
        st.retry.push(keyOf('blob', rel))
        return
      }
      throw err
    }
    if (sha256(data) !== hash) {
      st.retry.push(keyOf('blob', rel))
      return
    }
    if (changedHere) this.trash(abs, rel)
    const stat = writeAtomic(abs, data)
    st.blobs[rel] = { rev: d.rev, hash, bytes, lhash: hash, ...stat }
    this.noteArea(...this.blobArea(rel))
  }

  private async pushBlobs(): Promise<void> {
    const st = this.state
    const local = this.localBlobs()
    this.tooLarge = new Set([...this.tooLarge].filter((p) => !p.startsWith('blob:')))
    for (const [rel, info] of local) {
      const bs = st.blobs[rel]
      const lhash = this.blobHash(rel, info)
      if (bs && lhash === bs.hash) {
        if (bs.lhash !== lhash || bs.mtime !== info.mtime) st.blobs[rel] = { ...bs, lhash, mtime: info.mtime, size: info.size }
        continue
      }
      if (info.size > MAX_FILE_BYTES) {
        this.tooLarge.add(`blob:${rel}`)
        continue
      }
      await this.hub.upload(this.blobObject(lhash), readFileSync(info.abs), mimeOf(rel))
      const [r] = await this.hub.push(
        [{ collection: 'blob', doc_id: rel, body: { hash: lhash, bytes: info.size }, deleted: false, base_rev: bs?.rev ?? null }],
        st.device
      )
      if (!r?.ok) {
        st.retry.push(keyOf('blob', rel))
        continue
      }
      const old = bs?.hash
      st.blobs[rel] = { rev: r.rev, hash: lhash, bytes: info.size, lhash, mtime: info.mtime, size: info.size }
      if (old && old !== lhash && !this.blobReferenced(old, rel)) {
        await this.hub.remove([this.blobObject(old)]).catch(() => {})
      }
      this.saveState()
    }

    for (const rel of Object.keys(st.blobs)) if (!local.has(rel) && st.blobs[rel].hash === '') delete st.blobs[rel]
    const gone = Object.keys(st.blobs)
      .filter((rel) => !local.has(rel))
      .map((rel) => keyOf('blob', rel))
    for (const key of this.gateDeletes('blob', gone, Object.keys(st.blobs).length)) {
      const rel = splitKey(key).doc_id
      const bs = st.blobs[rel]
      const [r] = await this.hub.push(
        [{ collection: 'blob', doc_id: rel, body: null, deleted: true, base_rev: bs.rev }],
        st.device
      )
      if (!r?.ok) {
        st.retry.push(key)
        continue
      }
      delete st.blobs[rel]
      st.held = st.held.filter((k) => k !== key)
      if (!this.blobReferenced(bs.hash, rel)) await this.hub.remove([this.blobObject(bs.hash)]).catch(() => {})
      this.saveState()
    }
  }

  // ---- audio ---------------------------------------------------------------

  private audioObject(id: string, ext: string): string {
    return `${this.hub.userId}/audio/${id}${ext}`
  }

  private applyAudio(d: RemoteDoc): void {
    const prev = this.state.audio[d.doc_id]
    if (d.deleted) {
      this.state.audio[d.doc_id] = {
        rev: d.rev,
        ext: prev?.ext ?? '',
        bytes: 0,
        createdAt: prev?.createdAt ?? '',
        deleted: true
      }
      return
    }
    const body = isObj(d.body) ? d.body : {}
    if (!/^[\w-]+$/.test(d.doc_id)) return
    this.state.audio[d.doc_id] = {
      rev: d.rev,
      ext: body.ext === '.wav' ? '.wav' : '.webm',
      bytes: Number(body.bytes ?? 0),
      createdAt: String(body.createdAt ?? '')
    }
  }

  /** take a recording out of the hub (it aged out, or its meeting or audio was deleted) */
  private async dropAudio(id: string): Promise<void> {
    const as = this.state.audio[id]
    if (!as || as.deleted) return
    await this.hub.remove([this.audioObject(id, as.ext)]).catch(() => {})
    const [r] = await this.hub.push(
      [{ collection: 'audio', doc_id: id, body: null, deleted: true, base_rev: as.rev }],
      this.state.device
    )
    if (r?.ok) this.state.audio[id] = { ...as, rev: r.rev, bytes: 0, deleted: true }
    else this.state.retry.push(keyOf('audio', id))
  }

  private async syncAudio(): Promise<void> {
    const st = this.state
    const days = Math.max(0, this.hooks.audioDays())
    const cutoff = Date.now() - days * 864e5
    const inWindow = (createdAt: string): boolean => days > 0 && Date.parse(createdAt) >= cutoff
    this.tooLarge = new Set([...this.tooLarge].filter((p) => !p.startsWith('audio:')))

    // age out and follow deletions first, so space frees before new uploads
    for (const [id, as] of Object.entries(st.audio)) {
      if (as.deleted) continue
      const m = this.meetingMeta(id)
      if (!inWindow(as.createdAt) || (typeof m === 'object' && !m.hasAudio)) await this.dropAudio(id)
    }

    const ids = existsSync(this.meetingsDir)
      ? readdirSync(this.meetingsDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
      : []
    for (const id of ids) {
      const m = this.meetingMeta(id)
      if (typeof m !== 'object' || !m.hasAudio || BUSY_STAGES.has(m.stage) || !inWindow(m.createdAt)) continue
      const as = st.audio[id]
      const file = this.audioFile(id)
      if (!file) {
        if (!as || as.deleted) continue
        let data: Buffer
        try {
          data = await this.hub.download(this.audioObject(id, as.ext))
        } catch (err) {
          if (err instanceof HubError && err.kind === 'missing') continue
          throw err
        }
        writeAtomic(join(this.meetingsDir, id, `audio${as.ext}`), data)
        this.change.meetings.push(id)
        this.noteArea('meetings')
        continue
      }
      if (as?.deleted) continue
      const size = statSync(file).size
      if (as && as.bytes === size) continue
      if (size > MAX_FILE_BYTES) {
        this.tooLarge.add(`audio:${id}`)
        continue
      }
      const ext = extname(file)
      await this.hub.upload(this.audioObject(id, ext), readFileSync(file), mimeOf(file))
      const [r] = await this.hub.push(
        [{ collection: 'audio', doc_id: id, body: { ext, bytes: size, createdAt: m.createdAt }, deleted: false, base_rev: as?.rev ?? null }],
        st.device
      )
      if (r?.ok) st.audio[id] = { rev: r.rev, ext, bytes: size, createdAt: m.createdAt }
      else st.retry.push(keyOf('audio', id))
      this.saveState()
    }
  }

  // ---- the pass ----------------------------------------------------------

  /** one full pass: pull, push, attachments, audio. Throws HubError on trouble. */
  async run(): Promise<void> {
    try {
      await this.pull()
      await this.pushDocs()
      if (this.state.retry.length) {
        // refused pushes: fold in what beat us to it, then send the merge
        await this.pull()
        await this.pushDocs()
      }
      await this.pushBlobs()
      await this.syncAudio()
      this.state.confirmDeletes = false
      this.state.lastSyncAt = new Date().toISOString()
    } finally {
      this.hooks.progress?.(null)
      this.saveState()
    }
  }

  /** the user said yes: let held deletions reach the hub on the next pass */
  confirmDeletes(): void {
    this.state.confirmDeletes = true
    this.saveState()
  }

  /** the user said no: bring the held items back from the hub */
  restoreDeletes(): void {
    const st = this.state
    for (const key of st.held) {
      const { collection, doc_id } = splitKey(key)
      if (collection === 'blob') delete st.blobs[doc_id]
      else this.dropDoc(key)
      st.retry.push(key)
    }
    st.held = []
    this.saveState()
  }
}
