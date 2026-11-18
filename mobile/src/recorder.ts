import type { Meeting } from '../../src/shared/types'
import { HubError, type Hub } from './api'
import { getDoc, pushNew } from './data'

// ---------------------------------------------------------------------------
// Recording on the phone. Audio is saved to this app's own storage every few
// seconds as it is recorded, so a crash, a locked screen or iOS closing the
// app loses at most those few seconds. Finished recordings (and voice memos
// picked from Files) wait here until they are uploaded: the audio goes to
// the hub, then a meeting marked "uploaded", which one of the person's PCs
// takes, transcribes and summarizes like any other recording.
// ---------------------------------------------------------------------------

/** the hub's per-file limit on the free plan */
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
/** speech-quality AAC/Opus: about 21 MB an hour, so ~2h20m fits under the limit */
const BITRATE = 48_000
const SLICE_MS = 4_000

export interface PendingRecording {
  id: string
  title: string
  notes: string
  /** ISO time the recording started (or the memo was made) */
  startedAt: string
  durationMs: number
  /** container type, e.g. audio/mp4 */
  mime: string
  ext: '.m4a' | '.webm' | '.wav'
  state: 'recording' | 'ready' | 'failed'
  error?: string
  /** the recording stopped on its own (screen locked, app closed) */
  interrupted?: boolean
}

interface Chunk {
  rec: string
  seq: number
  /** ms since the recording started */
  at: number
  data: Blob
}

// ---- storage -------------------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null

/** the recording running right now, which is never mistaken for an abandoned one */
let activeId: string | null = null

function db(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open('rowan-recorder', 1)
      req.onupgradeneeded = () => {
        const d = req.result
        d.createObjectStore('recordings', { keyPath: 'id' })
        d.createObjectStore('chunks', { keyPath: ['rec', 'seq'] })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  }
  return dbPromise
}

function tx<T>(stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return db().then(
    (d) =>
      new Promise<T>((resolve, reject) => {
        const t = d.transaction(stores, mode)
        const req = run(t)
        t.oncomplete = () => resolve(req ? (req.result as T) : (undefined as T))
        t.onerror = () => reject(t.error)
        t.onabort = () => reject(t.error)
      })
  )
}

function saveMeta(r: PendingRecording): Promise<unknown> {
  return tx(['recordings'], 'readwrite', (t) => t.objectStore('recordings').put(r))
}

function saveChunk(c: Chunk): Promise<unknown> {
  return tx(['chunks'], 'readwrite', (t) => t.objectStore('chunks').put(c))
}

function chunksOf(id: string): Promise<Chunk[]> {
  return tx<Chunk[]>(['chunks'], 'readonly', (t) =>
    t.objectStore('chunks').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
  )
}

export async function forget(id: string): Promise<void> {
  await tx(['recordings', 'chunks'], 'readwrite', (t) => {
    t.objectStore('recordings').delete(id)
    t.objectStore('chunks').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))
  })
}

/**
 * Recordings waiting to be sent. One still marked "recording" belongs to a
 * session that ended without stopping (iOS closed the app): it is finished
 * here with whatever audio was saved.
 */
export async function pending(): Promise<PendingRecording[]> {
  const live = activeId
  const all = await tx<PendingRecording[]>(['recordings'], 'readonly', (t) => t.objectStore('recordings').getAll())
  for (const r of all) {
    if (r.state === 'recording' && r.id !== live) {
      const chunks = await chunksOf(r.id)
      if (chunks.length === 0) {
        await forget(r.id)
        r.state = 'failed'
        continue
      }
      r.state = 'ready'
      r.interrupted = true
      r.durationMs = chunks[chunks.length - 1].at
      await saveMeta(r)
    }
  }
  return all
    .filter((r) => r.state !== 'recording')
    .filter((r) => !(r.state === 'failed' && !r.error))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export async function updatePending(id: string, patch: Partial<Pick<PendingRecording, 'title' | 'notes'>>): Promise<void> {
  const all = await tx<PendingRecording[]>(['recordings'], 'readonly', (t) => t.objectStore('recordings').getAll())
  const r = all.find((x) => x.id === id)
  if (r) await saveMeta({ ...r, ...patch })
}

// ---- recording ----------------------------------------------------------------------

function pickMime(): { mime: string; ext: PendingRecording['ext'] } {
  // iPhone records AAC in MP4; elsewhere Opus in WebM. The PC reads both.
  const options: [string, PendingRecording['ext']][] = [
    ['audio/mp4', '.m4a'],
    ['audio/webm;codecs=opus', '.webm'],
    ['audio/webm', '.webm']
  ]
  for (const [mime, ext] of options) if (MediaRecorder.isTypeSupported(mime)) return { mime, ext }
  return { mime: '', ext: '.m4a' }
}

export function defaultTitle(when = new Date()): string {
  return `In-person meeting · ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`
}

export class LiveRecording {
  readonly id = crypto.randomUUID()
  private recorder: MediaRecorder | null = null
  private stream: MediaStream | null = null
  private analyser: AnalyserNode | null = null
  private audioCtx: AudioContext | null = null
  private wakeLock: WakeLockSentinel | null = null
  private seq = 0
  private startedAt = 0
  private meta!: PendingRecording
  private writes: Promise<unknown> = Promise.resolve()
  private stopping: Promise<PendingRecording> | null = null
  /** called if the recording ends without Stop (screen locked, call came in) */
  onInterrupted: (() => void) | null = null

  async start(title: string): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true }
    })
    const { mime, ext } = pickMime()
    this.recorder = new MediaRecorder(this.stream, { ...(mime ? { mimeType: mime } : {}), audioBitsPerSecond: BITRATE })
    this.startedAt = Date.now()
    this.meta = {
      id: this.id,
      title,
      notes: '',
      startedAt: new Date(this.startedAt).toISOString(),
      durationMs: 0,
      mime: (this.recorder.mimeType || mime || 'audio/mp4').split(';')[0],
      ext,
      state: 'recording'
    }
    await saveMeta(this.meta)
    activeId = this.id
    this.recorder.ondataavailable = (e) => {
      if (e.data.size === 0) return
      const chunk: Chunk = { rec: this.id, seq: this.seq++, at: Date.now() - this.startedAt, data: e.data }
      this.writes = this.writes.then(() => saveChunk(chunk)).catch(() => {})
    }
    this.recorder.onstop = () => {
      if (!this.stopping) this.onInterrupted?.()
    }
    this.stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (!this.stopping) this.onInterrupted?.()
    })
    this.recorder.start(SLICE_MS)
    this.meter()
    await this.keepAwake()
    document.addEventListener('visibilitychange', this.onVisible)
  }

  private onVisible = (): void => {
    // the screen lock is released when the app is hidden; take it back
    if (document.visibilityState === 'visible' && !this.stopping) void this.keepAwake()
  }

  private async keepAwake(): Promise<void> {
    try {
      this.wakeLock = await navigator.wakeLock?.request('screen')
    } catch {
      // not available here: the screen may dim, and locking it stops the recording
    }
  }

  private meter(): void {
    try {
      this.audioCtx = new AudioContext()
      const src = this.audioCtx.createMediaStreamSource(this.stream as MediaStream)
      this.analyser = this.audioCtx.createAnalyser()
      this.analyser.fftSize = 512
      src.connect(this.analyser)
    } catch {
      this.analyser = null
    }
  }

  /** 0..1 loudness right now, for the level meter */
  level(): number {
    if (!this.analyser) return 0
    const buf = new Uint8Array(this.analyser.fftSize)
    this.analyser.getByteTimeDomainData(buf)
    let sum = 0
    for (const v of buf) sum += ((v - 128) / 128) ** 2
    return Math.min(1, Math.sqrt(sum / buf.length) * 4)
  }

  elapsedMs(): number {
    return this.startedAt ? Date.now() - this.startedAt : 0
  }

  get running(): boolean {
    return this.recorder?.state === 'recording'
  }

  setNotes(notes: string): void {
    this.meta.notes = notes
    this.writes = this.writes.then(() => saveMeta(this.meta)).catch(() => {})
  }

  setTitle(title: string): void {
    this.meta.title = title
    this.writes = this.writes.then(() => saveMeta(this.meta)).catch(() => {})
  }

  /** stop and keep it (also used after an interruption) */
  stop(interrupted = false): Promise<PendingRecording> {
    if (!this.stopping) {
      this.stopping = (async () => {
        const rec = this.recorder
        if (rec && rec.state !== 'inactive') {
          await new Promise<void>((resolve) => {
            rec.addEventListener('stop', () => resolve(), { once: true })
            rec.stop()
          })
        }
        this.release()
        await this.writes
        const chunks = await chunksOf(this.id)
        const last = chunks[chunks.length - 1]
        this.meta = {
          ...this.meta,
          state: chunks.length ? 'ready' : 'failed',
          // after an interruption the clock kept running while nothing was recorded
          durationMs: !last ? 0 : interrupted ? last.at : Math.max(last.at, Date.now() - this.startedAt),
          ...(interrupted ? { interrupted: true } : {})
        }
        if (chunks.length) await saveMeta(this.meta)
        else await forget(this.id)
        return this.meta
      })()
    }
    return this.stopping
  }

  async discard(): Promise<void> {
    this.stopping ??= Promise.resolve(this.meta)
    if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop()
    this.release()
    await this.writes
    await forget(this.id)
  }

  private release(): void {
    if (activeId === this.id) activeId = null
    document.removeEventListener('visibilitychange', this.onVisible)
    this.stream?.getTracks().forEach((t) => t.stop())
    void this.audioCtx?.close().catch(() => {})
    void this.wakeLock?.release().catch(() => {})
    this.wakeLock = null
  }
}

// ---- voice memos ---------------------------------------------------------------------

function extFor(file: File): PendingRecording['ext'] {
  const name = file.name.toLowerCase()
  if (file.type.includes('wav') || name.endsWith('.wav')) return '.wav'
  if (file.type.includes('webm') || name.endsWith('.webm')) return '.webm'
  return '.m4a'
}

function mediaDuration(file: Blob): Promise<number> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file)
    const a = new Audio()
    const done = (ms: number): void => {
      URL.revokeObjectURL(url)
      resolve(ms)
    }
    a.preload = 'metadata'
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : 0)
    a.onerror = () => done(0)
    setTimeout(() => done(0), 8000)
    a.src = url
  })
}

/** a recording made elsewhere (Voice Memos → Save to Files), queued like one made here */
export async function importAudio(file: File): Promise<PendingRecording> {
  const id = crypto.randomUUID()
  const startedAt = new Date(file.lastModified || Date.now())
  const base = file.name.replace(/\.[^.]+$/, '').trim()
  const meta: PendingRecording = {
    id,
    title: base && !/^(new recording|recording)\b/i.test(base) ? base : defaultTitle(startedAt),
    notes: '',
    startedAt: startedAt.toISOString(),
    durationMs: await mediaDuration(file),
    mime: file.type || 'audio/mp4',
    ext: extFor(file),
    state: 'ready'
  }
  await saveChunk({ rec: id, seq: 0, at: meta.durationMs, data: file })
  await saveMeta(meta)
  return meta
}

// ---- sending -----------------------------------------------------------------------------

export async function audioOf(id: string): Promise<Blob> {
  const chunks = await chunksOf(id)
  return new Blob(
    chunks.sort((a, b) => a.seq - b.seq).map((c) => c.data),
    { type: chunks[0]?.data.type || 'audio/mp4' }
  )
}

/**
 * Send a recording: audio first, then its manifest row, then the meeting
 * that asks a PC to transcribe it. Safe to repeat after a failure partway.
 */
export async function send(hub: Hub, r: PendingRecording, onProgress?: (fraction: number) => void): Promise<void> {
  const audio = await audioOf(r.id)
  if (audio.size === 0) throw new Error('This recording has no audio.')
  if (audio.size > MAX_UPLOAD_BYTES) {
    throw new Error('This recording is over the hub’s 50 MB limit (about two hours), so it can’t be sent.')
  }
  try {
    await hub.upload(`${hub.userId}/audio/${r.id}${r.ext}`, audio, r.mime.split(';')[0] || 'audio/mp4', onProgress)
    if (!(await getDoc(hub, 'audio', r.id))) {
      await pushNew(hub, 'audio', r.id, { ext: r.ext, bytes: audio.size, createdAt: r.startedAt })
    }
    if (!(await getDoc(hub, 'meeting', r.id))) {
      const meeting: Meeting = {
        id: r.id,
        title: r.title.trim() || defaultTitle(new Date(r.startedAt)),
        createdAt: r.startedAt,
        durationMs: r.durationMs,
        mode: 'in-person',
        stage: 'uploaded',
        hasAudio: true,
        source: 'phone',
        ...(r.notes.trim() ? { notes: r.notes } : {})
      }
      await pushNew(hub, 'meeting', r.id, meeting)
    }
  } catch (err) {
    await saveMeta({ ...r, state: 'failed', error: err instanceof Error ? err.message : String(err) })
    throw err instanceof HubError && err.kind === 'network'
      ? new Error('Couldn’t reach the hub. It’s saved on this phone; send it again when you’re online.')
      : err
  }
  await forget(r.id)
}
