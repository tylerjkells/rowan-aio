import fixWebmDuration from 'fix-webm-duration'
import type { AutoEndReason, EnergySample, Meeting, RecordingMode } from '../../shared/types'

/**
 * Recording engine. Mixes microphone (+ system loopback audio in virtual mode)
 * through a 48kHz AudioContext into:
 *  - a MediaRecorder webm/opus blob for playback, and
 *  - a 16kHz mono Int16 PCM stream (via MediaStreamTrackProcessor, downsampled
 *    3:1) streamed to the main process for Whisper.
 *
 * MediaStreamTrackProcessor is used instead of an AudioWorklet on purpose:
 * worklet modules cannot be loaded from file:// origins, which is how the
 * packaged app serves its UI.
 */

const CAPTURE_RATE = 48000

/**
 * RMS level (as reported by readLevel) below which a source counts as silent.
 * Well under speech but above the noise floor of a live-but-idle mic, so a
 * quiet room does not read as sound.
 */
const SILENCE_LEVEL = 0.02
const SILENCE_SAMPLE_MS = 500

export interface RecorderHandles {
  /** live meeting id assigned by the main process */
  id: string
  mode: RecordingMode
  /** analyser for the mic signal (level meter) */
  micAnalyser: AnalyserNode
  /** analyser for system audio; null for in-person mode */
  sysAnalyser: AnalyserNode | null
  startedAt: number
  /** elapsed recording time excluding paused stretches */
  elapsedMs: () => number
  /** how long every source has been below the silence floor (0 while paused) */
  silentMs: () => number
  isPaused: () => boolean
  pause: () => void
  resume: () => void
  /** pass a reason when the app stopped the recording on the user's behalf */
  stop: (autoEnd?: AutoEndReason | null) => Promise<Meeting>
  cancel: () => Promise<void>
}

export async function startRecording(mode: RecordingMode): Promise<RecorderHandles> {
  const micStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  })

  let sysStream: MediaStream | null = null
  if (mode === 'virtual') {
    try {
      // The main process display-media handler answers this with a screen
      // source configured for loopback audio; we only keep the audio track.
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      display.getVideoTracks().forEach((t) => t.stop())
      const audioTracks = display.getAudioTracks()
      if (audioTracks.length === 0) {
        micStream.getTracks().forEach((t) => t.stop())
        throw new Error('System audio capture returned no audio track.')
      }
      sysStream = new MediaStream(audioTracks)
    } catch (err) {
      micStream.getTracks().forEach((t) => t.stop())
      throw err instanceof Error ? err : new Error('Could not capture system audio')
    }
  }

  const ctx = new AudioContext({ sampleRate: CAPTURE_RATE })
  const mix = ctx.createGain()

  const micSource = ctx.createMediaStreamSource(micStream)
  const micAnalyser = ctx.createAnalyser()
  micAnalyser.fftSize = 512
  micSource.connect(micAnalyser)
  micSource.connect(mix)

  let sysAnalyser: AnalyserNode | null = null
  let sysSource: MediaStreamAudioSourceNode | null = null
  if (sysStream) {
    sysSource = ctx.createMediaStreamSource(sysStream)
    sysAnalyser = ctx.createAnalyser()
    sysAnalyser.fftSize = 512
    sysSource.connect(sysAnalyser)
    sysSource.connect(mix)
  }

  // Single mixed mono track feeding both outputs
  const dest = ctx.createMediaStreamDestination()
  dest.channelCount = 1
  mix.connect(dest)
  const mixedTrack = dest.stream.getAudioTracks()[0]

  if (typeof MediaStreamTrackProcessor !== 'function') {
    micStream.getTracks().forEach((t) => t.stop())
    sysStream?.getTracks().forEach((t) => t.stop())
    ctx.close()
    throw new Error('Audio capture is not supported by this runtime (MediaStreamTrackProcessor missing).')
  }

  // Playback copy: webm/opus via MediaRecorder
  const chunks: Blob[] = []
  const recorder = new MediaRecorder(dest.stream, {
    mimeType: 'audio/webm;codecs=opus',
    audioBitsPerSecond: 64000
  })
  recorder.ondataavailable = (e) => {
    if (e.data.size > 0) chunks.push(e.data)
  }

  // Whisper copy: 48k float -> 16k int16, streamed to disk in the main process
  const id = await window.scribe.rec.begin(mode)
  const frameSource = new MediaStreamTrackProcessor({ track: mixedTrack })
  const reader = frameSource.readable.getReader()

  let pending = new Float32Array(0)
  let outBuf: number[] = []
  let stopped = false
  let paused = false
  let scratch = new Float32Array(4096)

  const pump = (async (): Promise<void> => {
    for (;;) {
      const { value: frame, done } = await reader.read()
      if (done || stopped) {
        frame?.close()
        break
      }
      if (paused) {
        // drop frames so the whisper WAV stays in sync with the paused webm
        frame.close()
        continue
      }
      const n = frame.numberOfFrames
      const channels = frame.numberOfChannels
      if (scratch.length < n) scratch = new Float32Array(n)
      const mono = scratch.subarray(0, n)
      frame.copyTo(mono, { planeIndex: 0, format: 'f32-planar' })
      if (channels > 1) {
        // average in the second channel so stereo system audio keeps both sides
        const right = new Float32Array(n)
        frame.copyTo(right, { planeIndex: 1, format: 'f32-planar' })
        for (let i = 0; i < n; i++) mono[i] = (mono[i] + right[i]) / 2
      }
      frame.close()

      const joined = new Float32Array(pending.length + n)
      joined.set(pending)
      joined.set(mono, pending.length)
      const usable = joined.length - (joined.length % 3)
      for (let i = 0; i < usable; i += 3) {
        const avg = (joined[i] + joined[i + 1] + joined[i + 2]) / 3
        const clamped = Math.max(-1, Math.min(1, avg))
        outBuf.push(Math.round(clamped * 32767))
      }
      pending = joined.slice(usable)
      if (outBuf.length >= 16000) {
        window.scribe.rec.pcm(id, Int16Array.from(outBuf).buffer)
        outBuf = []
      }
    }
  })().catch(() => {
    // reader cancelled during teardown
  })

  recorder.start(1000)
  const startedAt = Date.now()
  let pausedAt: number | null = null
  let pausedTotal = 0

  // Windows loopback capture latches onto the output device that was default
  // when it started. If the user switches outputs mid-meeting (speakers ->
  // AirPods), re-acquire the loopback stream and splice it into the mix.
  let defaultOutLabel: string | null = null
  let reacquiring = false

  async function currentDefaultOutputLabel(): Promise<string | null> {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      const def = devices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')
      return def?.label ?? null
    } catch {
      return null
    }
  }

  async function reacquireSystemAudio(): Promise<void> {
    if (reacquiring || stopped || mode !== 'virtual') return
    reacquiring = true
    try {
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
      display.getVideoTracks().forEach((t) => t.stop())
      const audioTracks = display.getAudioTracks()
      if (audioTracks.length === 0 || stopped) {
        audioTracks.forEach((t) => t.stop())
        return
      }
      const nextStream = new MediaStream(audioTracks)
      const nextSource = ctx.createMediaStreamSource(nextStream)
      if (sysAnalyser) nextSource.connect(sysAnalyser)
      nextSource.connect(mix)
      sysSource?.disconnect()
      sysStream?.getTracks().forEach((t) => t.stop())
      sysStream = nextStream
      sysSource = nextSource
    } catch {
      // keep the existing capture if re-acquisition fails
    } finally {
      reacquiring = false
    }
  }

  let deviceWatch: ReturnType<typeof setInterval> | null = null
  if (mode === 'virtual') {
    currentDefaultOutputLabel().then((label) => (defaultOutLabel = label))
    deviceWatch = setInterval(async () => {
      if (stopped || pausedAt !== null) return
      const label = await currentDefaultOutputLabel()
      if (label && defaultOutLabel && label !== defaultOutLabel) {
        defaultOutLabel = label
        await reacquireSystemAudio()
      } else if (label && !defaultOutLabel) {
        defaultOutLabel = label
      }
    }, 3000)
  }

  // Per-source loudness timeline for speaker attribution ("Me" vs "Them").
  // Only meaningful in virtual mode where mic and system audio are separate.
  const energy: EnergySample[] = []
  const micLevelBuf = new Uint8Array(micAnalyser.fftSize)
  const sysLevelBuf = sysAnalyser ? new Uint8Array(sysAnalyser.fftSize) : null
  const energyTimer = sysAnalyser
    ? setInterval(() => {
        if (pausedAt !== null || stopped) return
        energy.push({
          t: Math.round((pausedAt ?? Date.now()) - startedAt - pausedTotal),
          mic: readLevel(micAnalyser, micLevelBuf),
          sys: readLevel(sysAnalyser!, sysLevelBuf!)
        })
      }, 250)
    : null

  // Silence watch, for the auto-end rule: track the last moment either source
  // carried sound. Paused stretches keep pushing the marker forward, so
  // pausing on purpose never trips the automatic stop.
  let lastSoundAt = Date.now()
  const silenceMicBuf = new Uint8Array(micAnalyser.fftSize)
  const silenceSysBuf = sysAnalyser ? new Uint8Array(sysAnalyser.fftSize) : null
  const silenceTimer = setInterval(() => {
    if (stopped) return
    if (pausedAt !== null) {
      lastSoundAt = Date.now()
      return
    }
    const level = Math.max(
      readLevel(micAnalyser, silenceMicBuf),
      sysAnalyser && silenceSysBuf ? readLevel(sysAnalyser, silenceSysBuf) : 0
    )
    if (level > SILENCE_LEVEL) lastSoundAt = Date.now()
  }, SILENCE_SAMPLE_MS)

  function elapsedMs(): number {
    return (pausedAt ?? Date.now()) - startedAt - pausedTotal
  }

  function pause(): void {
    if (pausedAt !== null || stopped) return
    pausedAt = Date.now()
    paused = true
    if (recorder.state === 'recording') recorder.pause()
  }

  function resume(): void {
    if (pausedAt === null || stopped) return
    pausedTotal += Date.now() - pausedAt
    pausedAt = null
    paused = false
    if (recorder.state === 'paused') recorder.resume()
  }

  async function teardown(): Promise<void> {
    stopped = true
    if (energyTimer) clearInterval(energyTimer)
    if (deviceWatch) clearInterval(deviceWatch)
    clearInterval(silenceTimer)
    try {
      await reader.cancel()
    } catch {
      // already closed
    }
    await pump
    micStream.getTracks().forEach((t) => t.stop())
    sysStream?.getTracks().forEach((t) => t.stop())
    ctx.close()
  }

  async function stop(autoEnd: AutoEndReason | null = null): Promise<Meeting> {
    const durationMs = elapsedMs()
    const raw = await new Promise<Blob>((resolve) => {
      recorder.onstop = () => resolve(new Blob(chunks, { type: 'audio/webm' }))
      recorder.stop()
    })
    // MediaRecorder writes no duration header; patch it in so playback and
    // seeking work correctly regardless of file length. Guard the module's
    // export shape and surface failures instead of swallowing them.
    let blob = raw
    try {
      const mod = fixWebmDuration as unknown as { default?: typeof fixWebmDuration }
      const fix = typeof mod === 'function' ? mod : mod.default
      if (typeof fix === 'function') {
        blob = await fix(raw, durationMs, { logger: false })
      } else {
        console.warn('fix-webm-duration export not callable; saving unpatched webm')
      }
    } catch (err) {
      console.warn('webm duration patch failed; saving unpatched webm', err)
    }
    await teardown()
    // flush remaining downsampled samples after the pump has fully drained
    if (outBuf.length > 0) {
      window.scribe.rec.pcm(id, Int16Array.from(outBuf).buffer)
      outBuf = []
    }
    const webm = await blob.arrayBuffer()
    return window.scribe.rec.finish(id, webm, durationMs, energy.length ? energy : null, autoEnd)
  }

  async function cancel(): Promise<void> {
    try {
      recorder.stop()
    } catch {
      // recorder may already be inactive
    }
    await teardown()
    await window.scribe.rec.cancel(id)
  }

  return {
    id,
    mode,
    micAnalyser,
    sysAnalyser,
    startedAt,
    elapsedMs,
    silentMs: () => Math.max(0, Date.now() - lastSoundAt),
    isPaused: () => pausedAt !== null,
    pause,
    resume,
    stop,
    cancel
  }
}

/** 0..1 RMS level from an analyser, for level meters. */
export function readLevel(analyser: AnalyserNode, buf: Uint8Array<ArrayBuffer>): number {
  analyser.getByteTimeDomainData(buf)
  let sum = 0
  for (let i = 0; i < buf.length; i++) {
    const v = (buf[i] - 128) / 128
    sum += v * v
  }
  return Math.min(1, Math.sqrt(sum / buf.length) * 3)
}
