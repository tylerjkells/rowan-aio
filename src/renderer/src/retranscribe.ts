/**
 * Feed a meeting's saved audio back to the main process as 16kHz mono PCM.
 * The main process keeps only the playback file (webm, or wav for recovered
 * recordings) and has no decoder, so the renderer decodes it with Web Audio
 * and streams the samples over IPC. Re-transcription and voice recognition
 * on older meetings both start this way.
 */

const RATE = 16000

interface PcmSink {
  begin: (id: string) => Promise<boolean>
  pcm: (id: string, chunk: ArrayBuffer) => void
  finish: (id: string) => Promise<unknown>
  cancel: (id: string) => Promise<void>
}

async function streamMeetingAudio(
  id: string,
  onPhase: (phase: string) => void,
  sink: PcmSink,
  handoff: string
): Promise<void> {
  onPhase('Loading the recording…')
  const res = await fetch(`scribe-media://${id}`)
  if (!res.ok) throw new Error('The audio file for this meeting is missing.')
  const encoded = await res.arrayBuffer()

  onPhase('Decoding audio…')
  // a 1-frame offline context still decodes; decodeAudioData resamples to its rate
  const ctx = new OfflineAudioContext(1, 1, RATE)
  const decoded = await ctx.decodeAudioData(encoded)

  const ok = await sink.begin(id)
  if (!ok) throw new Error('This meeting is busy; try again in a moment.')

  try {
    onPhase('Preparing audio for the engine…')
    const n = decoded.length
    const channels = decoded.numberOfChannels
    const chunkFrames = RATE * 10
    const mono = new Float32Array(chunkFrames)
    const other = new Float32Array(chunkFrames)
    for (let start = 0; start < n; start += chunkFrames) {
      const len = Math.min(chunkFrames, n - start)
      decoded.copyFromChannel(mono, 0, start)
      for (let c = 1; c < channels; c++) {
        decoded.copyFromChannel(other, c, start)
        for (let i = 0; i < len; i++) mono[i] += other[i]
      }
      const out = new Int16Array(len)
      for (let i = 0; i < len; i++) {
        const v = Math.max(-1, Math.min(1, mono[i] / channels))
        out[i] = Math.round(v * 32767)
      }
      sink.pcm(id, out.buffer)
      // let the IPC queue drain so a long meeting doesn't pile up in memory
      if (start % (chunkFrames * 6) === 0) await new Promise((r) => setTimeout(r, 0))
    }
    onPhase(handoff)
    await sink.finish(id)
  } catch (err) {
    await sink.cancel(id).catch(() => {})
    throw err
  }
}

/** Re-transcribe a meeting from its saved audio; the normal pipeline takes it from there. */
export async function retranscribeMeeting(
  id: string,
  onPhase: (phase: string) => void
): Promise<void> {
  const m = window.scribe.meetings
  await streamMeetingAudio(
    id,
    onPhase,
    {
      begin: m.retranscribeBegin,
      pcm: m.retranscribePcm,
      finish: m.retranscribeFinish,
      cancel: m.retranscribeCancel
    },
    'Handing off to the transcription engine…'
  )
}

/**
 * Tell the voices apart in a meeting. Straight after a recording its
 * transcription audio is still on disk; for an older one the recording is
 * decoded and streamed in first.
 */
export async function identifyMeetingVoices(
  id: string,
  onPhase: (phase: string) => void
): Promise<void> {
  const v = window.scribe.voice
  if ((await v.identify(id)) === 'done') return
  await streamMeetingAudio(
    id,
    onPhase,
    { begin: v.begin, pcm: v.pcm, finish: v.finish, cancel: v.cancel },
    'Listening for voices…'
  )
}
