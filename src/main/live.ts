import { writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import type { TranscriptSegment, WhisperModel } from '../shared/types'

const SAMPLE_RATE = 16000
const BYTES_PER_SEC = SAMPLE_RATE * 2 // 16-bit mono
// Whisper decodes 30s windows and pads anything shorter, so a chunk just
// under 30s costs one window; a 45s chunk cost two.
const CUT_TARGET_SEC = 29
const CUT_SEARCH_SEC = 8
const MIN_TAIL_SEC = 1

/** one whisper run over a chunk's wav; injected so tests can stand in for the engine */
export type TranscribeChunk = (
  wavFile: string,
  model: WhisperModel,
  opts: { threads: number; prompt?: string }
) => Promise<TranscriptSegment[]>

export interface LiveTranscriberOptions {
  /** where chunk wavs are written while they transcribe */
  dir: string
  model: WhisperModel
  onUpdate: (segments: TranscriptSegment[], transcribedMs: number) => void
  transcribe: TranscribeChunk
  /** threads for a chunk while the meeting is live, leaving the call its share of the CPU */
  liveThreads: number
  /** threads for the whole machine, once the recording stopped */
  catchUpThreads: number
  /** user vocabulary prepended to each chunk's decoding context */
  vocab?: string
  /** whether another recording is live, so catching up should leave it CPU */
  otherRecordingLive?: () => boolean
}

interface Chunk {
  pcm: Buffer
  offsetMs: number
  index: number
}

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(BYTES_PER_SEC, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

/** RMS of a 16-bit PCM span */
function rms(buf: Buffer, start: number, end: number): number {
  let sum = 0
  let n = 0
  for (let i = start; i + 1 < end; i += 2) {
    const v = buf.readInt16LE(i)
    sum += v * v
    n++
  }
  return n ? Math.sqrt(sum / n) : 0
}

/**
 * Transcribes a recording incrementally while it is still being captured.
 * PCM is accumulated and cut into chunks just under Whisper's 30s window, at
 * the quietest moment near the end of each, so words are not split
 * mid-utterance. Each chunk is transcribed with the previous chunk's tail as
 * decoding context.
 *
 * While the meeting is live, chunks run one at a time on a share of the CPU.
 * Once it stops, any backlog runs two chunks at a time across the machine
 * (whisper gains less from more threads than from a second chunk), and
 * results are still added to the transcript in order.
 */
export class LiveTranscriber {
  private buffers: Buffer[] = []
  private bytesBuffered = 0
  /** end of the audio cut into chunks so far */
  private offsetMs = 0
  private chunkIndex = 0
  private pending: Chunk[] = []
  private running = 0
  /** chunks transcribed ahead of an earlier one still running, by index */
  private landed = new Map<number, { segments: TranscriptSegment[]; endMs: number }>()
  /** each transcribed chunk's text, the decoding context for the chunk after it */
  private texts = new Map<number, string>()
  /** the next chunk to add to the transcript */
  private nextIndex = 0
  private failed = false
  private finished = false
  private vocab: string
  /** end of the audio transcribed so far */
  private doneMs = 0
  private onDrainProgress: ((percent: number) => void) | null = null
  private idle: (() => void)[] = []
  readonly segments: TranscriptSegment[] = []

  constructor(private o: LiveTranscriberOptions) {
    this.vocab = o.vocab ?? ''
  }

  /** swap the spelling hints, e.g. once the calendar event is known; applies from the next chunk */
  setVocab(vocab: string): void {
    this.vocab = vocab
  }

  feed(chunk: Buffer): void {
    if (this.failed || this.finished) return
    this.buffers.push(chunk)
    this.bytesBuffered += chunk.length
    if (this.bytesBuffered >= CUT_TARGET_SEC * BYTES_PER_SEC) {
      this.cut(false)
    }
  }

  /** slice off a chunk at a good boundary and queue it for transcription */
  private cut(force: boolean): void {
    const whole = Buffer.concat(this.buffers)
    let cutAt = whole.length
    if (!force) {
      // look for the quietest 300ms window in the last CUT_SEARCH_SEC
      const searchStart = Math.max(0, whole.length - CUT_SEARCH_SEC * BYTES_PER_SEC)
      const win = Math.floor(0.3 * BYTES_PER_SEC) & ~1
      let best = Infinity
      let bestPos = whole.length
      for (let pos = searchStart; pos + win <= whole.length; pos += win) {
        const level = rms(whole, pos, pos + win)
        if (level < best) {
          best = level
          bestPos = pos + win / 2
        }
      }
      cutAt = Math.floor(bestPos) & ~1
    }
    const chunk = whole.subarray(0, cutAt)
    const rest = whole.subarray(cutAt)
    this.buffers = rest.length ? [Buffer.from(rest)] : []
    this.bytesBuffered = rest.length
    if (chunk.length < MIN_TAIL_SEC * BYTES_PER_SEC) return

    this.pending.push({ pcm: Buffer.from(chunk), offsetMs: this.offsetMs, index: this.chunkIndex++ })
    this.offsetMs += (chunk.length / BYTES_PER_SEC) * 1000
    this.pump()
  }

  /** how many chunks run at once, and on how many threads each */
  private plan(): { workers: number; threads: number } {
    const catchingUp = this.finished && !(this.o.otherRecordingLive?.() ?? false)
    if (!catchingUp) return { workers: 1, threads: this.o.liveThreads }
    if (this.o.catchUpThreads < 4) return { workers: 1, threads: this.o.catchUpThreads }
    return { workers: 2, threads: Math.floor(this.o.catchUpThreads / 2) }
  }

  /** start queued chunks while there is room */
  private pump(): void {
    while (!this.failed && this.pending.length > 0) {
      const { workers, threads } = this.plan()
      if (this.running >= workers) break
      const chunk = this.pending.shift()!
      this.running++
      this.runChunk(chunk, threads)
        .catch(() => {
          this.failed = true
        })
        .finally(() => {
          this.running--
          this.pump()
        })
    }
    if (this.running === 0 && (this.failed || this.pending.length === 0)) {
      for (const resolve of this.idle.splice(0)) resolve()
    }
  }

  private async runChunk(chunk: Chunk, threads: number): Promise<void> {
    const { pcm, offsetMs, index } = chunk
    const wav = join(this.o.dir, `live-${index}.wav`)
    try {
      writeFileSync(wav, Buffer.concat([wavHeader(pcm.length), pcm]))
      // the chunk before this one, when it's done; a chunk run alongside it goes without
      const prev = this.texts.get(index - 1) ?? ''
      const segs = await this.o.transcribe(wav, this.o.model, {
        threads,
        prompt: [this.vocab, prev.slice(-200)].filter(Boolean).join(' ') || undefined
      })
      if (this.failed) return
      // whisper pads short chunks to its 30s window; clamp times to real audio
      const chunkMs = (pcm.length / BYTES_PER_SEC) * 1000
      this.texts.set(index, segs.map((s) => s.text).join(' '))
      this.landed.set(index, {
        endMs: offsetMs + chunkMs,
        segments: segs.map((s) => ({
          from: Math.round(Math.min(s.from, chunkMs) + offsetMs),
          to: Math.round(Math.min(s.to, chunkMs) + offsetMs),
          text: s.text,
          ...(s.turn ? { turn: true } : {})
        }))
      })
      this.commit()
    } finally {
      rmSync(wav, { force: true })
    }
  }

  /** add finished chunks to the transcript in recording order */
  private commit(): void {
    let added = false
    for (let next = this.landed.get(this.nextIndex); next; next = this.landed.get(this.nextIndex)) {
      this.landed.delete(this.nextIndex)
      this.texts.delete(this.nextIndex - 1)
      this.segments.push(...next.segments)
      this.doneMs = next.endMs
      this.nextIndex++
      added = true
    }
    if (!added) return
    this.o.onUpdate([...this.segments], Math.round(this.doneMs))
    this.reportDrain()
  }

  /**
   * The recording stopped: flush the remaining audio. Chunks still queued
   * keep transcribing in the background; collect them with drained().
   */
  end(): void {
    if (this.finished) return
    this.finished = true
    if (this.bytesBuffered > 0) this.cut(true)
    // the backlog can spread across the machine now
    this.pump()
  }

  /**
   * Wait for the queue to drain, hearing how much of the recording is
   * transcribed (0-100) as each chunk lands. Returns the full transcript, or
   * null if any chunk failed (caller should fall back to whole-file
   * transcription).
   */
  async drained(onProgress?: (percent: number) => void): Promise<TranscriptSegment[] | null> {
    this.end()
    this.onDrainProgress = onProgress ?? null
    this.reportDrain()
    if (this.running > 0 || (!this.failed && this.pending.length > 0)) {
      await new Promise<void>((resolve) => this.idle.push(resolve))
    }
    if (this.failed) return null
    return this.segments
  }

  private reportDrain(): void {
    if (!this.onDrainProgress || this.offsetMs <= 0) return
    this.onDrainProgress(Math.min(100, Math.round((this.doneMs / this.offsetMs) * 100)))
  }

  abort(): void {
    this.failed = true
    this.finished = true
    this.buffers = []
    this.pending = []
  }
}
