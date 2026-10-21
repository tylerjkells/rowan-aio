import { app } from 'electron'
import { spawn, spawnSync, type ChildProcess } from 'child_process'
import { createHash } from 'crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type WriteStream
} from 'fs'
import { cpus } from 'os'
import { delimiter, join } from 'path'
import { Readable } from 'stream'
import { pipeline } from 'stream/promises'
import { getSettings } from './settings'
import { hasActiveRecording, meetingDir, meetingsRoot, pcmToWav, readMeeting } from './store'
import type { Meeting, TranscriptSegment, VoiceEngineStatus, VoiceMeta } from '../shared/types'

// ---------------------------------------------------------------------------
// Voice identification. After a meeting is transcribed, a local engine works
// out who spoke when and takes a voiceprint (192 numbers) of each voice. A
// voiceprint you have put a name to — by renaming "Speaker 2" in a
// transcript, or your own voice on a call's microphone channel — is
// remembered, and later meetings recognize that voice by itself. Everything
// stays on this machine: the engine, the recordings, and the voiceprints.
//
// The engine is sherpa-onnx (Apache-2.0) with pyannote segmentation 3.0
// (MIT) and NeMo TitaNet-small (CC-BY-4.0), downloaded on first use the same
// way the transcription engine is. It runs in a child process (worker.cjs)
// so its synchronous native calls never stall the app.
// ---------------------------------------------------------------------------

const ENGINE_VERSION = '1.13.8'
const MODEL = 'nemo_en_titanet_small'

interface AddonPackage {
  url: string
  /** npm's sha512 integrity for the tarball */
  sha512: string
}

const ADDON: Partial<Record<string, AddonPackage>> = {
  'win32-x64': {
    url: `https://registry.npmjs.org/sherpa-onnx-win-x64/-/sherpa-onnx-win-x64-${ENGINE_VERSION}.tgz`,
    sha512:
      'oZF1c9VPOKtMwn83Bboc5XSWL+76BRoyB3eUuVnCknBKxwSULZU2Foia9VHWzU+n4I12rPsP6z6H9Rp1hD9o8g=='
  }
}

const SEG_ARCHIVE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2'
/** the same model file on its own, for a Windows tar that can't open .bz2 */
const SEG_DIRECT_URL =
  'https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx'
const SEG_BYTES = 5_992_913
const EMB_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx'
const EMB_BYTES = 40_257_283

/** clustering cut inside the engine; model-specific (TitaNet over-splits at the default 0.5) */
const CLUSTER_THRESHOLD = 0.8

// Matching thresholds, cosine distance between L2-normalized TitaNet-small
// voiceprints, calibrated on real meeting audio: the same speaker across
// recordings measured a median 0.25 (90th percentile 0.38), different
// speakers never under 0.44 (1st percentile 0.65).
const STRONG_MATCH = 0.4
const POSSIBLE_MATCH = 0.55
/** a strong match also needs the runner-up this much farther away */
const MATCH_MARGIN = 0.1
/** speech a voice needs before it is matched or remembered (short clips were every hard case) */
const MIN_PRINT_SEC = 8

function voiceDir(): string {
  const dir = join(app.getPath('userData'), 'engine', 'voice')
  mkdirSync(dir, { recursive: true })
  return dir
}

const addonDir = (): string => join(voiceDir(), 'package')
const segModelPath = (): string => join(voiceDir(), 'segmentation.onnx')
const embModelPath = (): string => join(voiceDir(), `${MODEL}.onnx`)
const workerPath = (): string => join(voiceDir(), 'worker.cjs')

function platformKey(): string {
  return `${process.platform}-${process.arch}`
}

function sizeIs(file: string, bytes: number): boolean {
  try {
    return statSync(file).size === bytes
  } catch {
    return false
  }
}

export function voiceEngineStatus(): VoiceEngineStatus {
  const supported = !!ADDON[platformKey()]
  const ready =
    supported &&
    existsSync(join(addonDir(), 'sherpa-onnx.node')) &&
    sizeIs(segModelPath(), SEG_BYTES) &&
    sizeIs(embModelPath(), EMB_BYTES)
  return { supported, ready, people: knownPeople() }
}

/** switched on in Settings and the engine is downloaded */
export function voiceIdActive(): boolean {
  return getSettings().voiceId && voiceEngineStatus().ready
}

// ---- setup ----

export interface VoiceSetupProgress {
  percent: number
  detail: string
  done?: boolean
  error?: string
}

async function download(
  url: string,
  dest: string,
  label: string,
  onProgress: (p: VoiceSetupProgress) => void
): Promise<void> {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${label}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  let received = 0
  const tmp = dest + '.part'
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      received += chunk.byteLength
      onProgress({
        percent: total ? Math.round((received / total) * 100) : -1,
        detail: `${label}: ${(received / 1048576).toFixed(0)} MB${total ? ` of ${(total / 1048576).toFixed(0)} MB` : ''}`
      })
      controller.enqueue(chunk)
    }
  })
  await pipeline(Readable.fromWeb(res.body.pipeThrough(counter) as never), createWriteStream(tmp))
  if (total && statSync(tmp).size !== total) {
    rmSync(tmp, { force: true })
    throw new Error(`${label} arrived incomplete; try again.`)
  }
  rmSync(dest, { force: true })
  renameSync(tmp, dest)
}

/** Windows 10+ ships bsdtar in System32; a Git Bash tar earlier in PATH can't read every format */
function untar(archive: string, into: string): Promise<void> {
  const tar =
    process.platform === 'win32'
      ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      : 'tar'
  return new Promise((resolve, reject) => {
    const p = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true })
    let err = ''
    p.stderr.on('data', (d) => (err += d))
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Unpacking failed: ${err}`))))
    p.on('error', reject)
  })
}

function sha512(file: string): string {
  return createHash('sha512').update(readFileSync(file)).digest('base64')
}

export async function setupVoiceEngine(
  onProgress: (p: VoiceSetupProgress) => void
): Promise<VoiceEngineStatus> {
  const pkg = ADDON[platformKey()]
  if (!pkg) throw new Error('Voice recognition is only available on 64-bit Windows.')
  const dir = voiceDir()

  if (!existsSync(join(addonDir(), 'sherpa-onnx.node'))) {
    const tgz = join(dir, 'engine.tgz')
    await download(pkg.url, tgz, 'Voice engine', onProgress)
    if (sha512(tgz) !== pkg.sha512) {
      rmSync(tgz, { force: true })
      throw new Error('The voice engine download did not match its published checksum.')
    }
    onProgress({ percent: -1, detail: 'Unpacking the voice engine…' })
    rmSync(addonDir(), { recursive: true, force: true })
    await untar(tgz, dir) // the npm tarball unpacks into package/
    rmSync(tgz, { force: true })
    if (!existsSync(join(addonDir(), 'sherpa-onnx.node'))) {
      throw new Error('The voice engine unpacked, but its main file is missing.')
    }
  }

  if (!sizeIs(segModelPath(), SEG_BYTES)) {
    const archive = join(dir, 'segmentation.tar.bz2')
    const unpacked = join(dir, 'seg-unpack')
    try {
      await download(SEG_ARCHIVE_URL, archive, 'Speech detection model', onProgress)
      rmSync(unpacked, { recursive: true, force: true })
      mkdirSync(unpacked, { recursive: true })
      await untar(archive, unpacked)
      renameSync(join(unpacked, 'sherpa-onnx-pyannote-segmentation-3-0', 'model.onnx'), segModelPath())
    } catch {
      // older Windows tar builds can't read .bz2: fetch the bare model instead
      await download(SEG_DIRECT_URL, segModelPath(), 'Speech detection model', onProgress)
    } finally {
      rmSync(archive, { force: true })
      rmSync(unpacked, { recursive: true, force: true })
    }
    if (!sizeIs(segModelPath(), SEG_BYTES)) {
      rmSync(segModelPath(), { force: true })
      throw new Error('The speech detection model did not download correctly.')
    }
  }

  if (!sizeIs(embModelPath(), EMB_BYTES)) {
    await download(EMB_URL, embModelPath(), 'Voiceprint model', onProgress)
    if (!sizeIs(embModelPath(), EMB_BYTES)) {
      rmSync(embModelPath(), { force: true })
      throw new Error('The voiceprint model did not download correctly.')
    }
  }

  onProgress({ percent: 100, detail: 'Ready', done: true })
  return voiceEngineStatus()
}

// ---- running the engine ----

export interface VoiceResult {
  durationSec: number
  model: string
  segments: { start: number; end: number; voice: number }[]
  voices: { voice: number; seconds: number; cleanSeconds: number; embedding: number[] | null }[]
}

/** keep the installed worker in step with the one bundled in this build */
function installWorker(): void {
  const bundled = join(app.getAppPath(), 'out', 'voice', 'worker.cjs')
  const code = readFileSync(bundled)
  if (!existsSync(workerPath()) || !code.equals(readFileSync(workerPath()))) {
    writeFileSync(workerPath(), code)
  }
}

/** the engine run in progress, so quitting the app doesn't leave it behind */
let running: ChildProcess | null = null

app.on('will-quit', () => {
  const pid = running?.pid
  if (!pid) return
  // each block of a long meeting runs in a process of the worker's own: end the tree
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true })
  } else {
    running?.kill()
  }
})

/** one engine run at a time: each can take over a gigabyte of memory */
let engineQueue: Promise<unknown> = Promise.resolve()

/** run the engine on a 16 kHz mono WAV in its own process, after any run ahead of it */
export function runVoiceEngine(wav: string, onProgress: (percent: number) => void): Promise<VoiceResult> {
  const run = engineQueue.then(() => runEngineNow(wav, onProgress))
  engineQueue = run.catch(() => undefined)
  return run
}

function runEngineNow(wav: string, onProgress: (percent: number) => void): Promise<VoiceResult> {
  installWorker()
  const job = join(voiceDir(), `job-${process.pid}-${Date.now()}`)
  const input = {
    addonDir: addonDir(),
    segModel: segModelPath(),
    embModel: embModelPath(),
    wav,
    // leave room for the app, and for a meeting being recorded right now
    threads: hasActiveRecording()
      ? 2
      : Math.max(2, Math.min(4, cpus().length - 2)),
    threshold: CLUSTER_THRESHOLD,
    model: MODEL
  }
  writeFileSync(`${job}.in.json`, JSON.stringify(input))

  // The worker only reports between 20-minute blocks, so a shorter meeting
  // would sit at 0% until it's done. In between, the bar moves on an estimate
  // from the audio's length: about 4 minutes per hour of audio on 4 threads.
  // It eases off as it nears the end rather than stopping, and never goes
  // back.
  const audioSec = Math.max(1, (statSync(wav).size - 44) / 32000)
  const expectedMs = audioSec * 73 * (4 / input.threads)
  const startedAt = Date.now()
  let reported = 0
  let shown = 0
  const show = (): void => {
    const t = (Date.now() - startedAt) / expectedMs
    const estimate = t < 1 ? 80 * t : 80 + 5 * (1 - Math.exp(1 - t))
    const percent = Math.round(Math.max(reported, estimate))
    if (percent > shown) {
      shown = percent
      onProgress(percent)
    }
  }
  const ticker = setInterval(show, 1000)

  return new Promise<VoiceResult>((resolve, reject) => {
    const p = spawn(process.execPath, [workerPath(), `${job}.in.json`, `${job}.out.json`], {
      windowsHide: true,
      // the engine's DLLs sit next to the addon
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        PATH: `${addonDir()}${delimiter}${process.env.PATH ?? ''}`
      }
    })
    running = p
    let stderr = ''
    p.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr += s
      const m = s.match(/progress (\d+)/g)
      if (m) {
        reported = Number(m[m.length - 1].split(' ')[1])
        show()
      }
    })
    p.on('error', (err) => {
      clearInterval(ticker)
      reject(err)
    })
    p.on('close', (code) => {
      clearInterval(ticker)
      if (running === p) running = null
      try {
        if (code !== 0) {
          let msg = /error (.+)/.exec(stderr)?.[1] ?? stderr.trim().split('\n').pop() ?? ''
          // the engine's own words for a model it can't load
          msg = msg.replace(/Please check your config!?/i, 'it could not load its model files.')
          reject(new Error(`The voice engine stopped (${code})${msg ? `: ${msg}` : ''}`))
          return
        }
        resolve(JSON.parse(readFileSync(`${job}.out.json`, 'utf8')) as VoiceResult)
      } catch (err) {
        reject(err)
      } finally {
        rmSync(`${job}.in.json`, { force: true })
        rmSync(`${job}.out.json`, { force: true })
      }
    })
  })
}

// ---- voiceprints ----
// Each meeting keeps its voices' prints in voices.json. The named ones also
// go into one small library file (voiceprints.json) that matching reads.

interface MeetingPrints {
  model: string
  voices: VoiceResult['voices']
}

interface PrintEntry {
  meetingId: string
  voice: number
  /** a person's name as written in the transcript, or 'me' */
  name: string
  /** confirmed (you named it, or your microphone) vs. inferred (the AI) */
  confirmed: boolean
  seconds: number
  embedding: number[]
}

interface PrintLibrary {
  model: string
  entries: PrintEntry[]
}

const printsPath = (meetingId: string): string => join(meetingDir(meetingId), 'voices.json')
const libraryPath = (): string => join(app.getPath('userData'), 'voiceprints.json')

function readPrints(meetingId: string): MeetingPrints | null {
  try {
    return JSON.parse(readFileSync(printsPath(meetingId), 'utf8')) as MeetingPrints
  } catch {
    return null
  }
}

function readLibrary(): PrintLibrary {
  try {
    const lib = JSON.parse(readFileSync(libraryPath(), 'utf8')) as PrintLibrary
    // prints from another model are not comparable; meetings since deleted are gone
    if (lib.model !== MODEL) return { model: MODEL, entries: [] }
    return { model: MODEL, entries: lib.entries.filter((e) => existsSync(meetingDir(e.meetingId))) }
  } catch {
    return { model: MODEL, entries: [] }
  }
}

function writeLibrary(lib: PrintLibrary): void {
  writeFileSync(libraryPath(), JSON.stringify(lib))
}

/** how many people the library can recognize (you included) */
function knownPeople(): number {
  try {
    return new Set(readLibrary().entries.map((e) => personKey(e.name))).size
  } catch {
    return 0
  }
}

/** names merged on the People page count as one person */
function personKey(name: string): string {
  const key = name.trim().toLowerCase()
  if (key === 'me') return 'me'
  const aliases = getSettings().personAliases
  return (aliases[key] ?? name).trim().toLowerCase()
}

function isPlaceholder(name: string | undefined): boolean {
  return !name || /^speaker \d+$/i.test(name.trim())
}

function normalize(v: ArrayLike<number>): number[] {
  let s = 0
  for (let i = 0; i < v.length; i++) s += v[i] * v[i]
  const n = Math.sqrt(s) || 1
  return Array.from(v, (x) => x / n)
}

function distance(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return 1 - dot
}

/**
 * Rewrite the library's entries for one meeting from its voices' current
 * names. Called whenever names change: a fresh run, a rename, the AI.
 */
export function syncVoiceprints(meeting: Meeting): void {
  try {
    const lib = readLibrary()
    const prints = readPrints(meeting.id)
    lib.entries = lib.entries.filter((e) => e.meetingId !== meeting.id)
    if (prints && prints.model === MODEL) {
      for (const [k, meta] of Object.entries(meeting.voices ?? {})) {
        // a voiceprint match only repeats what the library already knows
        if (isPlaceholder(meta.name) || !meta.source || meta.source === 'voice') continue
        const p = prints.voices.find((v) => v.voice === Number(k))
        if (!p?.embedding || p.cleanSeconds < MIN_PRINT_SEC) continue
        lib.entries.push({
          meetingId: meeting.id,
          voice: p.voice,
          name: meta.name,
          confirmed: meta.source === 'you' || meta.source === 'mic',
          seconds: p.cleanSeconds,
          embedding: p.embedding
        })
      }
    }
    writeLibrary(lib)
  } catch {
    // the library is a convenience; a failed write only means fewer matches later
  }
}

export interface VoiceMatch {
  name: string
  distance: number
  strong: boolean
  /** how many meetings the person's voiceprint comes from */
  meetings: number
}

/**
 * The library's best guess for a voiceprint. Each person is the normalized
 * average of their prints — the confirmed ones when they have any, so a
 * wrong guess can never outvote a name you set yourself.
 */
export function matchVoice(embedding: number[], excludeMeeting?: string): VoiceMatch | null {
  const people = new Map<string, { name: string; confirmed: PrintEntry[]; inferred: PrintEntry[] }>()
  for (const e of readLibrary().entries) {
    if (e.meetingId === excludeMeeting) continue
    const key = personKey(e.name)
    const person = people.get(key) ?? { name: e.name, confirmed: [], inferred: [] }
    ;(e.confirmed ? person.confirmed : person.inferred).push(e)
    if (e.confirmed) person.name = e.name
    people.set(key, person)
  }
  const target = normalize(embedding)
  const scored = [...people.values()]
    .map((p) => {
      const use = p.confirmed.length > 0 ? p.confirmed : p.inferred
      const dim = use[0].embedding.length
      const sum = new Array<number>(dim).fill(0)
      for (const e of use) {
        const n = normalize(e.embedding)
        for (let i = 0; i < dim; i++) sum[i] += n[i]
      }
      return {
        name: p.name,
        distance: distance(target, normalize(sum)),
        meetings: new Set(use.map((e) => e.meetingId)).size
      }
    })
    .sort((a, b) => a.distance - b.distance)
  const [best, second] = scored
  if (!best || best.distance >= POSSIBLE_MATCH) return null
  const strong =
    best.distance < STRONG_MATCH && (!second || second.distance - best.distance >= MATCH_MARGIN)
  return { ...best, distance: Math.round(best.distance * 1000) / 1000, strong }
}

/** forget every voiceprint: the library and each meeting's prints (transcripts keep their names) */
export function forgetVoiceprints(): void {
  rmSync(libraryPath(), { force: true })
  for (const entry of readdirSync(meetingsRoot(), { withFileTypes: true })) {
    if (entry.isDirectory()) rmSync(printsPath(entry.name), { force: true })
  }
}

// ---- applying a run to a meeting ----

function overlapMs(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

/**
 * Put a run's voices onto a transcript: each line goes to the voice that
 * talks most over it; your own voice is the one on your microphone (calls)
 * or the one matching your voiceprint; other voices take a remembered name
 * when the match is strong, else "Speaker 1", "Speaker 2", … in order of
 * appearance. Names you gave voices in an earlier run of this meeting carry
 * over by voiceprint.
 */
export function applyVoices(
  meeting: Meeting,
  result: VoiceResult
): Pick<Meeting, 'transcript' | 'voices'> {
  const transcript: TranscriptSegment[] = (meeting.transcript ?? []).map((s) => ({ ...s }))
  const diar = result.segments.map((s) => ({ from: s.start * 1000, to: s.end * 1000, voice: s.voice }))

  for (const seg of transcript) {
    const totals = new Map<number, number>()
    for (const d of diar) {
      const o = overlapMs(seg.from, seg.to, d.from, d.to)
      if (o > 0) totals.set(d.voice, (totals.get(d.voice) ?? 0) + o)
    }
    let voice: number | undefined
    let best = 0
    for (const [v, ms] of totals) {
      if (ms > best) {
        best = ms
        voice = v
      }
    }
    if (voice === undefined) {
      // a line the engine heard no speech in: borrow the nearest voice within a breath
      let nearest = 1500
      for (const d of diar) {
        const gap = d.to < seg.from ? seg.from - d.to : d.from > seg.to ? d.from - seg.to : 0
        if (gap < nearest) {
          nearest = gap
          voice = d.voice
        }
      }
    }
    if (voice === undefined) delete seg.voice
    else seg.voice = voice
  }

  const voices: Record<string, VoiceMeta> = {}
  const printOf = (v: number): VoiceResult['voices'][number] | undefined =>
    result.voices.find((x) => x.voice === v)

  // names given in an earlier run of this meeting, by voiceprint
  const earlier = readPrints(meeting.id)
  const carried = new Map<number, string>()
  if (earlier && earlier.model === result.model && meeting.voices) {
    for (const [k, meta] of Object.entries(meeting.voices)) {
      if (meta.source !== 'you' || isPlaceholder(meta.name)) continue
      const old = earlier.voices.find((x) => x.voice === Number(k))?.embedding
      if (!old) continue
      for (const v of result.voices) {
        if (v.embedding && !carried.has(v.voice) && distance(normalize(old), normalize(v.embedding)) < STRONG_MATCH) {
          carried.set(v.voice, meta.name)
        }
      }
    }
  }

  // on a call, your microphone says which voice is yours
  let mine: number | null = null
  if (meeting.mode === 'virtual') {
    let bestShare = 0.6
    for (const v of result.voices) {
      let me = 0
      let all = 0
      for (const seg of transcript) {
        if (seg.voice !== v.voice) continue
        const ms = seg.to - seg.from
        all += ms
        if (seg.speaker === 'me') me += ms
      }
      if (all > 0 && me / all > bestShare) {
        bestShare = me / all
        mine = v.voice
      }
    }
  }

  // a voice that owns no line (a cough, a blip of crosstalk) gets no label,
  // so the placeholders shown run Speaker 1, 2, 3 without gaps
  const heard = new Set(transcript.map((s) => s.voice))
  let placeholder = 0
  for (const v of result.voices) {
    if (!heard.has(v.voice)) continue
    const meta: VoiceMeta = { name: '', seconds: Math.round(v.seconds) }
    const carriedName = carried.get(v.voice)
    const match =
      v.embedding && v.cleanSeconds >= MIN_PRINT_SEC ? matchVoice(v.embedding, meeting.id) : null
    if (v.voice === mine) {
      meta.name = 'me'
      meta.source = 'mic'
    } else if (carriedName) {
      meta.name = carriedName
      meta.source = 'you'
    } else if (match?.strong) {
      meta.name = match.name
      meta.source = 'voice'
      meta.match = { name: match.name, distance: match.distance, strong: true }
    } else {
      placeholder++
      meta.name = `Speaker ${placeholder}`
      if (match) meta.match = { name: match.name, distance: match.distance, strong: false }
    }
    voices[String(v.voice)] = meta
  }

  // relabel: your microphone's lines stay yours; everything else follows its voice
  for (const seg of transcript) {
    if (seg.speaker === 'me' || seg.voice === undefined) continue
    const meta = voices[String(seg.voice)]
    if (meta) seg.speaker = meta.name
  }

  return { transcript, voices }
}

/** save a finished engine run's voiceprints for a meeting; returns what to write back to it */
export function saveVoiceRun(meeting: Meeting, result: VoiceResult): Pick<Meeting, 'transcript' | 'voices'> {
  const patch = applyVoices(meeting, result)
  writeFileSync(printsPath(meeting.id), JSON.stringify({ model: result.model, voices: result.voices }))
  return patch
}

/**
 * After a rename in the transcript: a voice whose lines now carry the new
 * name is that person, as confirmed by you.
 */
export function confirmVoiceNames(meeting: Meeting): Meeting['voices'] {
  if (!meeting.voices || !meeting.transcript) return meeting.voices
  const voices = { ...meeting.voices }
  for (const k of Object.keys(voices)) {
    const lines = meeting.transcript.filter((s) => s.voice === Number(k))
    if (lines.length === 0) continue
    const counts = new Map<string, number>()
    for (const s of lines) {
      if (s.speaker) counts.set(s.speaker, (counts.get(s.speaker) ?? 0) + 1)
    }
    const [top, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0]
    if (!top || n < lines.length / 2) continue
    if (top !== voices[k].name) {
      voices[k] = {
        ...voices[k],
        name: top,
        source: isPlaceholder(top) ? undefined : 'you'
      }
    }
  }
  return voices
}

// ---- running on an old meeting: the renderer decodes its audio and streams it here ----

const decoding = new Map<string, { stream: WriteStream; bytes: number }>()

export function beginVoicePcm(id: string): boolean {
  if (decoding.has(id) || !readMeeting(id)) return false
  decoding.set(id, { stream: createWriteStream(join(meetingDir(id), 'voice-input.pcm')), bytes: 0 })
  return true
}

export function appendVoicePcm(id: string, chunk: Buffer): void {
  const d = decoding.get(id)
  if (!d) return
  d.stream.write(chunk)
  d.bytes += chunk.length
}

/** seal the streamed audio into a WAV for the engine; the caller deletes it after */
export async function finishVoicePcm(id: string): Promise<string> {
  const d = decoding.get(id)
  if (!d) throw new Error('No audio was streamed for this meeting.')
  decoding.delete(id)
  await new Promise<void>((resolve, reject) =>
    d.stream.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()))
  )
  const raw = join(meetingDir(id), 'voice-input.pcm')
  const wav = join(meetingDir(id), 'voice-input.wav')
  await pcmToWav(raw, wav, d.bytes)
  rmSync(raw, { force: true })
  return wav
}

export function cancelVoicePcm(id: string): void {
  const d = decoding.get(id)
  if (!d) return
  d.stream.destroy()
  decoding.delete(id)
  rmSync(join(meetingDir(id), 'voice-input.pcm'), { force: true })
}

/** meetings whose voiceprints exist (their audio has been through the engine) */
export function hasVoiceprints(meetingId: string): boolean {
  return existsSync(printsPath(meetingId))
}

/** the voice report the AI reads when naming speakers */
export function voiceReport(meeting: Meeting): string {
  const lines: string[] = []
  for (const [k, meta] of Object.entries(meeting.voices ?? {})) {
    const n = Number(k) + 1
    const mins = `${Math.floor(meta.seconds / 60)}m ${meta.seconds % 60}s of speech`
    let status: string
    if (meta.source === 'mic') status = 'the app user, recognized from their own microphone'
    else if (meta.source === 'you') status = `named "${meta.name}" by the app user (certain)`
    else if (meta.source === 'voice' && meta.match)
      status = `recognized by voiceprint as ${meta.match.name} (strong match)`
    else if (meta.match) status = `possibly ${meta.match.name} by voiceprint (weak match, not certain)`
    else status = 'no voiceprint on file'
    lines.push(`Voice ${n} (${mins}): ${status}`)
  }
  return lines.join('\n')
}

