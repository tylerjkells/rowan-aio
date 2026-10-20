/**
 * Voice identification worker: "who spoke when" plus one voiceprint per
 * voice, for a 16 kHz mono WAV. Runs as a child of the app in Node mode
 * (ELECTRON_RUN_AS_NODE=1) so the native engine's synchronous calls never
 * block the app, and a crash in it can't take the app down.
 *
 * Usage: worker.cjs <input.json> <output.json>
 *   input:  { addonDir, segModel, embModel, wav, threads, threshold, model }
 *   output: { durationSec, model, segments: [{start, end, voice}],
 *             voices: [{voice, seconds, cleanSeconds, embedding | null}] }
 *
 * The engine is sherpa-onnx (Apache-2.0): pyannote segmentation 3.0 finds
 * speech and speaker changes, NeMo TitaNet-small turns speech into 192-number
 * voiceprints, and clustering groups them. Built on the findings of a spike
 * against real meeting audio; see the thresholds below.
 *
 * Long recordings are diarized in 20-minute blocks, each in its own short
 * child process (worker.cjs --block …): the engine's working memory is
 * native and is not handed back between blocks, so a 55-minute pass peaked
 * at 2.7 GB in one process. A block's process peaks near 1.1 GB and exits;
 * the blocks' voices are then joined by voiceprint. Measured on a 55-minute
 * recording: 1.13 GB peak, about 4 minutes on 4 cores.
 */
import { spawnSync } from 'child_process'
import { closeSync, openSync, readFileSync, readSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'

interface Input {
  addonDir: string
  segModel: string
  embModel: string
  wav: string
  threads: number
  /** cosine-distance cut for clustering inside a block (model-specific: 0.8 for TitaNet) */
  threshold: number
  model: string
}

interface RawSegment {
  start: number
  end: number
  speaker: number
}

/** a voice found in one block, before voices are joined across blocks */
interface RawVoice {
  segments: RawSegment[]
  clean: [number, number][]
  cleanSec: number
  totalSec: number
  embedding: number[] | null
}

const BLOCK_SEC = 20 * 60
/** two voices this close are the same person (different speakers measured >= 0.44) */
const SAME_VOICE = 0.4
/** a short, noisy voice may join a bigger one this close */
const SAME_VOICE_LOOSE = 0.55
/** speech a voice needs before its voiceprint is trusted on its own */
const RELIABLE_SEC = 4
/** audio fed to the voiceprint model per voice, longest clean stretches first */
const MAX_EMBED_SEC = 120
/** clean pieces shorter than this carry too little voice to embed */
const MIN_PIECE_SEC = 0.3
/**
 * longest audio fed to the voiceprint model in one go. Its memory grows with
 * clip length (120 s at once took 1.1 GB, 30 s about 0.3 GB); a long voice is
 * printed in equal windows and averaged, which measured within 0.003 of the
 * one-shot print on real voices
 */
const EMBED_WINDOW_SEC = 30

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Addon = any

function l2norm(v: ArrayLike<number>): number[] {
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

function round(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** stretches of a segment no other voice talks over (overlap blurs a voiceprint) */
function overlapFree(seg: RawSegment, all: RawSegment[]): [number, number][] {
  let pieces: [number, number][] = [[seg.start, seg.end]]
  for (const o of all) {
    if (o === seg || o.speaker === seg.speaker || o.end <= seg.start || o.start >= seg.end) continue
    pieces = pieces.flatMap(([a, b]): [number, number][] => {
      if (o.end <= a || o.start >= b) return [[a, b]]
      const out: [number, number][] = []
      if (o.start > a) out.push([a, o.start])
      if (o.end < b) out.push([o.end, b])
      return out
    })
  }
  return pieces.filter(([a, b]) => b - a >= MIN_PIECE_SEC)
}

/** the longest clean stretches, up to the per-voice cap */
function capped(clean: [number, number][]): [number, number][] {
  const sorted = [...clean].sort((x, y) => y[1] - y[0] - (x[1] - x[0]))
  const out: [number, number][] = []
  let acc = 0
  for (const [a, b] of sorted) {
    if (acc >= MAX_EMBED_SEC) break
    const take = Math.min(b - a, MAX_EMBED_SEC - acc)
    out.push([a, a + take])
    acc += take
  }
  return out.sort((x, y) => x[0] - y[0])
}

/** a WAV's length from its header, without loading the audio */
function wavSeconds(file: string): number {
  const fd = openSync(file, 'r')
  try {
    const head = Buffer.alloc(4096)
    const n = readSync(fd, head, 0, head.length, 0)
    if (n < 12 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') {
      throw new Error('The audio file is not a WAV.')
    }
    let byteRate = 0
    for (let at = 12; at + 8 <= n; ) {
      const id = head.toString('ascii', at, at + 4)
      const size = head.readUInt32LE(at + 4)
      if (id === 'fmt ') byteRate = head.readUInt32LE(at + 16)
      if (id === 'data') return byteRate ? size / byteRate : 0
      at += 8 + size + (size % 2)
    }
    throw new Error('The audio file has no data chunk.')
  } finally {
    closeSync(fd)
  }
}

/** the engine plus the recording, loaded once per process */
function open(input: Input): {
  addon: Addon
  sr: number
  samples: Float32Array
  embed: (ranges: [number, number][]) => number[] | null
} {
  // the engine's own JS wrapper guesses at node_modules paths; load the addon directly
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const addon: Addon = require(join(input.addonDir, 'sherpa-onnx.node'))
  // false: copy into a V8-owned buffer. Electron's memory cage rejects the
  // engine's external buffers ("External buffers are not allowed").
  const wave = addon.readWave(input.wav, false)
  const sr: number = wave.sampleRate
  const samples: Float32Array = wave.samples
  const extractor = addon.createSpeakerEmbeddingExtractor({
    model: input.embModel,
    numThreads: input.threads,
    debug: 0,
    provider: 'cpu'
  })
  const embedOnce = (ranges: [number, number][]): number[] | null => {
    const stream = addon.speakerEmbeddingExtractorCreateStream(extractor)
    for (const [a, b] of ranges) {
      const s = Math.max(0, Math.floor(a * sr))
      const e = Math.min(samples.length, Math.floor(b * sr))
      if (e > s) addon.acceptWaveformOnline(stream, { samples: samples.subarray(s, e), sampleRate: sr })
    }
    addon.inputFinished(stream)
    if (!addon.speakerEmbeddingExtractorIsReady(extractor, stream)) return null
    return l2norm(addon.speakerEmbeddingExtractorComputeEmbedding(extractor, stream, false))
  }
  const embed = (ranges: [number, number][]): number[] | null => {
    const total = ranges.reduce((t, [a, b]) => t + (b - a), 0)
    if (total <= 0) return null
    // equal windows, so none is a sliver
    const size = total / Math.ceil(total / EMBED_WINDOW_SEC)
    const windows: [number, number][][] = [[]]
    let filled = 0
    for (const [from, to] of ranges) {
      let a = from
      while (to - a > 1e-6) {
        const take = Math.min(to - a, size - filled)
        windows[windows.length - 1].push([a, a + take])
        a += take
        filled += take
        if (filled >= size - 1e-6) {
          windows.push([])
          filled = 0
        }
      }
    }
    let sum: number[] | null = null
    for (const w of windows) {
      const sec = w.reduce((t, [a, b]) => t + (b - a), 0)
      const e = sec > 0 ? embedOnce(w) : null
      if (!e) continue
      sum ??= new Array<number>(e.length).fill(0)
      for (let i = 0; i < e.length; i++) sum[i] += e[i] * sec
    }
    return sum ? l2norm(sum) : null
  }
  return { addon, sr, samples, embed }
}

/** --block mode: diarize one stretch of the recording and voiceprint what it finds */
function runBlock(input: Input, fromSec: number, toSec: number, outFile: string): void {
  const { addon, sr, samples, embed } = open(input)
  const diarizer = addon.createOfflineSpeakerDiarization({
    segmentation: { pyannote: { model: input.segModel }, numThreads: input.threads, debug: 0, provider: 'cpu' },
    embedding: { model: input.embModel, numThreads: input.threads, debug: 0, provider: 'cpu' },
    clustering: { numClusters: -1, threshold: input.threshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  const expected = addon.getOfflineSpeakerDiarizationSampleRate(diarizer)
  if (expected !== sr) throw new Error(`The engine needs ${expected} Hz audio; this file is ${sr} Hz.`)
  const from = Math.floor(fromSec * sr)
  const to = Math.min(samples.length, Math.floor(toSec * sr))
  // no speech found is a normal result, not an error
  const found = (addon.offlineSpeakerDiarizationProcess(diarizer, samples.subarray(from, to)) ??
    []) as RawSegment[]
  const segs = found.map((s) => ({ start: s.start + fromSec, end: s.end + fromSec, speaker: s.speaker }))
  const bySpeaker = new Map<number, RawSegment[]>()
  for (const s of segs) {
    const list = bySpeaker.get(s.speaker) ?? []
    list.push(s)
    bySpeaker.set(s.speaker, list)
  }
  const voices: RawVoice[] = []
  for (const list of bySpeaker.values()) {
    const clean = list.flatMap((s) => overlapFree(s, segs))
    voices.push({
      segments: list,
      clean,
      cleanSec: clean.reduce((t, [x, y]) => t + (y - x), 0),
      totalSec: list.reduce((t, s) => t + (s.end - s.start), 0),
      embedding: embed(capped(clean))
    })
  }
  writeFileSync(outFile, JSON.stringify(voices))
}

function main(): void {
  if (process.argv[2] === '--block') {
    const [, , , inFile, outFile, from, to] = process.argv
    runBlock(JSON.parse(readFileSync(inFile, 'utf8')) as Input, Number(from), Number(to), outFile)
    return
  }

  const inFile = process.argv[2]
  const outFile = process.argv[3]
  const input = JSON.parse(readFileSync(inFile, 'utf8')) as Input
  // the engine and audio load here only after the blocks are done, so this
  // process holds nothing big while a block's process runs
  const durationSec = wavSeconds(input.wav)

  // ---- diarize block by block, each in a process of its own ----
  const raw: RawVoice[] = []
  const blocks = Math.max(1, Math.ceil(durationSec / BLOCK_SEC))
  for (let b = 0; b < blocks; b++) {
    process.stderr.write(`progress ${Math.round((b / blocks) * 85)}\n`)
    const from = b * BLOCK_SEC
    const to = Math.min(durationSec, (b + 1) * BLOCK_SEC)
    if (to - from < 1) continue
    const blockOut = `${outFile}.block${b}.json`
    const child = spawnSync(
      process.execPath,
      [__filename, '--block', inFile, blockOut, String(from), String(to)],
      { env: process.env, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
    )
    if (child.status !== 0) {
      const why = /error (.+)/.exec(child.stderr ?? '')?.[1] ?? child.error?.message ?? `exit ${child.status}`
      throw new Error(`Block ${b + 1} of ${blocks} failed: ${why}`)
    }
    raw.push(...(JSON.parse(readFileSync(blockOut, 'utf8')) as RawVoice[]))
    rmSync(blockOut, { force: true })
  }
  process.stderr.write('progress 88\n')

  // ---- join voices across blocks (and any a long block split in two) ----
  interface Joined {
    members: RawVoice[]
    centroid: number[] | null
    seconds: number
  }
  const joined: Joined[] = []
  const recentre = (j: Joined): void => {
    const withEmb = j.members.filter((m) => m.embedding)
    if (withEmb.length === 0) return
    const dim = withEmb[0].embedding!.length
    const sum = new Array<number>(dim).fill(0)
    for (const m of withEmb) {
      for (let i = 0; i < dim; i++) sum[i] += m.embedding![i] * m.cleanSec
    }
    j.centroid = l2norm(sum)
  }
  const nearest = (emb: number[]): [Joined | null, number] => {
    let best: Joined | null = null
    let bestD = Infinity
    for (const j of joined) {
      if (!j.centroid) continue
      const d = distance(emb, j.centroid)
      if (d < bestD) {
        bestD = d
        best = j
      }
    }
    return [best, bestD]
  }
  // reliable voices first, biggest first, so small fragments join real people
  for (const r of [...raw].sort((a, b) => b.cleanSec - a.cleanSec)) {
    const reliable = r.embedding && r.cleanSec >= RELIABLE_SEC
    const [best, d] = r.embedding ? nearest(r.embedding) : [null, Infinity]
    if (best && d < (reliable ? SAME_VOICE : SAME_VOICE_LOOSE)) {
      best.members.push(r)
      best.seconds += r.totalSec
      recentre(best)
    } else {
      const j: Joined = { members: [r], centroid: null, seconds: r.totalSec }
      recentre(j)
      joined.push(j)
    }
  }

  // ---- number voices by first appearance; final voiceprint from the joined audio ----
  const embed = joined.some((j) => j.members.length > 1) ? open(input).embed : null
  const firstStart = (j: Joined): number =>
    Math.min(...j.members.flatMap((m) => m.segments.map((s) => s.start)))
  joined.sort((a, b) => firstStart(a) - firstStart(b))
  const segments: { start: number; end: number; voice: number }[] = []
  const voices: { voice: number; seconds: number; cleanSeconds: number; embedding: number[] | null }[] = []
  joined.forEach((j, voice) => {
    for (const m of j.members) {
      for (const s of m.segments) segments.push({ start: round(s.start), end: round(s.end), voice })
    }
    const clean = j.members.flatMap((m) => m.clean)
    const emb = j.members.length > 1 && embed ? embed(capped(clean)) : j.members[0].embedding
    voices.push({
      voice,
      seconds: round(j.seconds),
      cleanSeconds: round(clean.reduce((t, [x, y]) => t + (y - x), 0)),
      embedding: emb ? emb.map((x) => Math.round(x * 1e5) / 1e5) : null
    })
  })
  segments.sort((a, b) => a.start - b.start)
  process.stderr.write('progress 100\n')

  writeFileSync(outFile, JSON.stringify({ durationSec: round(durationSec), model: input.model, segments, voices }))
}

try {
  main()
} catch (err) {
  process.stderr.write(`error ${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
}
