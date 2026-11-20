import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { LiveTranscriber, type TranscribeChunk } from '../src/main/live'
import type { TranscriptSegment } from '../src/shared/types'

const BYTES_PER_SEC = 32000

/** loud audio with a half-second pause every 7 seconds, for clean cut points */
function speech(seconds: number): Buffer {
  const samples = seconds * 16000
  const buf = Buffer.alloc(samples * 2)
  for (let i = 0; i < samples; i++) {
    const inPause = (i / 16000) % 7 > 6.5
    buf.writeInt16LE(inPause ? 0 : i % 2 ? 8000 : -8000, i * 2)
  }
  return buf
}

interface Call {
  index: number
  threads: number
  prompt?: string
  ms: number
}

/**
 * A stand-in engine: one segment per chunk naming the chunk, spanning its
 * audio (plus a little whisper padding past the end), after a delay.
 */
function fakeEngine(delay: (index: number) => number, fail?: (index: number) => boolean) {
  const calls: Call[] = []
  let running = 0
  let maxRunning = 0
  const transcribe: TranscribeChunk = async (wav, _model, opts) => {
    const index = Number(/live-(\d+)\.wav$/.exec(wav)![1])
    const ms = ((statSync(wav).size - 44) / BYTES_PER_SEC) * 1000
    calls.push({ index, threads: opts.threads, prompt: opts.prompt, ms })
    running++
    maxRunning = Math.max(maxRunning, running)
    await new Promise((r) => setTimeout(r, delay(index)))
    running--
    if (fail?.(index)) throw new Error('engine failed')
    return [{ from: 0, to: ms + 500, text: `chunk ${index}.` }]
  }
  return { transcribe, calls, maxRunning: () => maxRunning, running: () => running }
}

function make(engine: ReturnType<typeof fakeEngine>, updates: TranscriptSegment[][] = []) {
  const dir = mkdtempSync(join(tmpdir(), 'live-test-'))
  const live = new LiveTranscriber({
    dir,
    model: 'small.en',
    onUpdate: (segs) => updates.push(segs),
    transcribe: engine.transcribe,
    liveThreads: 6,
    catchUpThreads: 8,
    vocab: 'Rowan, KPI'
  })
  return { live, dir }
}

function feed(live: LiveTranscriber, pcm: Buffer): void {
  for (let i = 0; i < pcm.length; i += 3200) live.feed(pcm.subarray(i, i + 3200))
}

test('chunks stay under one 30s window and cover the whole recording in order', async () => {
  const engine = fakeEngine(() => 1)
  const { live, dir } = make(engine)
  feed(live, speech(100))
  const segs = await live.drained()
  rmSync(dir, { recursive: true, force: true })

  assert.ok(segs)
  assert.deepEqual(
    segs.map((s) => s.text),
    segs.map((_, i) => `chunk ${i}.`)
  )
  for (const c of engine.calls) assert.ok(c.ms <= 30_000, `chunk ${c.index} is ${c.ms}ms`)
  // contiguous: each chunk starts where the last ended, clamped to real audio
  for (let i = 1; i < segs.length; i++) assert.equal(segs[i].from, segs[i - 1].to)
  assert.equal(segs[0].from, 0)
  assert.equal(segs[segs.length - 1].to, 100_000)
  // cuts land in the pauses
  for (const s of segs.slice(0, -1)) assert.ok((s.to / 1000) % 7 > 6.4, `cut at ${s.to}ms`)
})

test('while live, one chunk at a time with the previous chunk as context', async () => {
  const engine = fakeEngine(() => 5)
  const { live, dir } = make(engine)
  feed(live, speech(70))
  // let the chunks cut so far finish before stopping
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(engine.maxRunning(), 1)
  assert.ok(engine.calls.every((c) => c.threads === 6))
  assert.equal(engine.calls[0].prompt, 'Rowan, KPI')
  assert.equal(engine.calls[1].prompt, 'Rowan, KPI chunk 0.')
  await live.drained()
  rmSync(dir, { recursive: true, force: true })
})

test('after stopping, the backlog gets the whole machine and lands in order', async () => {
  const engine = fakeEngine((i) => 20 - i * 2)
  const updates: TranscriptSegment[][] = []
  const { live, dir } = make(engine, updates)
  feed(live, speech(200))
  // stop immediately: every chunk but the first (already running) is backlog
  const segs = await live.drained()
  rmSync(dir, { recursive: true, force: true })

  assert.ok(segs)
  assert.equal(engine.maxRunning(), 1)
  assert.deepEqual(
    segs.map((s) => s.text),
    segs.map((_, i) => `chunk ${i}.`)
  )
  assert.equal(engine.calls[0].threads, 6)
  assert.ok(engine.calls.slice(1).every((c) => c.threads === 8))
  // context carries through the backlog too
  assert.equal(engine.calls[3].prompt, 'Rowan, KPI chunk 2.')
  // every update is a prefix of the final transcript, in order
  for (const u of updates) assert.deepEqual(u, segs.slice(0, u.length))
})

test('a failed chunk makes drained() return null so the caller falls back', async () => {
  const engine = fakeEngine(
    () => 2,
    (i) => i === 2
  )
  const { live, dir } = make(engine)
  feed(live, speech(120))
  const segs = await live.drained()
  // nothing still running after it gives up
  assert.equal(engine.running(), 0)
  rmSync(dir, { recursive: true, force: true })
  assert.equal(segs, null)
})

test('drained() on a recording too short to cut still returns its audio', async () => {
  const engine = fakeEngine(() => 1)
  const { live, dir } = make(engine)
  feed(live, speech(5))
  const segs = await live.drained()
  rmSync(dir, { recursive: true, force: true })
  assert.deepEqual(segs, [{ from: 0, to: 5000, text: 'chunk 0.' }])
})
