// ---------------------------------------------------------------------------
// Recordings made on a PC are WebM files holding Opus audio (Chromium's
// MediaRecorder). Safari on the iPhone won't play WebM, but it does play the
// same Opus audio inside Apple's own CAF container. So the phone repackages
// it: the audio packets are copied as they are, nothing is re-encoded, and it
// takes a moment even for an hour. If that still doesn't play, the last
// resort decodes the audio (WebCodecs) into a plain WAV file.
// ---------------------------------------------------------------------------

export interface OpusTrack {
  channels: number
  /** samples at 48 kHz to drop from the start (the encoder's look-ahead) */
  preSkip: number
  /** OpusHead, as the decoder's description */
  head: Uint8Array
  packets: Uint8Array[]
}

// ---- WebM -------------------------------------------------------------------

const ID = {
  ebml: 0x1a45dfa3,
  segment: 0x18538067,
  tracks: 0x1654ae6b,
  trackEntry: 0xae,
  trackNumber: 0xd7,
  codecId: 0x86,
  codecPrivate: 0x63a2,
  audio: 0xe1,
  channels: 0x9f,
  cluster: 0x1f43b675,
  blockGroup: 0xa0,
  block: 0xa1,
  simpleBlock: 0xa3
}

/** masters walked into rather than skipped (MediaRecorder leaves Segment and Cluster sizes unknown) */
const DESCEND = new Set([ID.segment, ID.tracks, ID.trackEntry, ID.audio, ID.cluster, ID.blockGroup])

function vint(b: Uint8Array, at: number, keepMarker: boolean): { value: number; length: number; unknown: boolean } {
  const first = b[at]
  let length = 1
  while (length <= 8 && !(first & (0x80 >> (length - 1)))) length++
  if (length > 8 || at + length > b.length) throw new Error('bad EBML number')
  let value = keepMarker ? first : first & (0xff >> length)
  let allOnes = value === 0xff >> length
  for (let i = 1; i < length; i++) {
    value = value * 256 + b[at + i]
    if (b[at + i] !== 0xff) allOnes = false
  }
  return { value, length, unknown: !keepMarker && allOnes }
}

/** frames in a laced block: sizes of each frame, and where they start */
function unlace(b: Uint8Array, start: number, end: number, lacing: number): Uint8Array[] {
  if (lacing === 0) return [b.subarray(start, end)]
  const count = b[start] + 1
  let at = start + 1
  const sizes: number[] = []
  if (lacing === 2) {
    // Xiph: each size is a run of 255s and a final byte
    for (let i = 0; i < count - 1; i++) {
      let size = 0
      while (b[at] === 255) size += b[at++]
      sizes.push(size + b[at++])
    }
  } else if (lacing === 6) {
    // EBML: the first size, then signed differences
    const first = vint(b, at, false)
    at += first.length
    sizes.push(first.value)
    for (let i = 1; i < count - 1; i++) {
      const d = vint(b, at, false)
      at += d.length
      const bias = 2 ** (7 * d.length - 1) - 1
      sizes.push(sizes[i - 1] + d.value - bias)
    }
  }
  const rest = end - at - sizes.reduce((a, n) => a + n, 0)
  if (lacing === 4) {
    // fixed: equal parts
    const each = (end - at) / count
    for (let i = 0; i < count; i++) sizes.push(each)
  } else sizes.push(rest)
  const out: Uint8Array[] = []
  for (const size of sizes) {
    out.push(b.subarray(at, at + size))
    at += size
  }
  return out
}

/** the Opus audio in a WebM file, or null when it holds something else */
export function readWebmOpus(b: Uint8Array): OpusTrack | null {
  let at = 0
  let current: { number: number; codec: string; priv: Uint8Array | null; channels: number } | null = null
  let opus: { number: number; priv: Uint8Array; channels: number } | null = null
  const packets: Uint8Array[] = []
  while (at < b.length) {
    let id: ReturnType<typeof vint>
    let size: ReturnType<typeof vint>
    try {
      id = vint(b, at, true)
      size = vint(b, at + id.length, false)
    } catch {
      break // a cut-off tail: keep what came before it
    }
    const body = at + id.length + size.length
    if (id.value === ID.trackEntry) {
      if (current?.codec === 'A_OPUS' && current.priv && !opus) opus = { number: current.number, priv: current.priv, channels: current.channels }
      current = { number: 0, codec: '', priv: null, channels: 0 }
    }
    if (DESCEND.has(id.value)) {
      at = body
      continue
    }
    if (size.unknown) break
    const end = Math.min(body + size.value, b.length)
    switch (id.value) {
      case ID.trackNumber:
        if (current) current.number = b.subarray(body, end).reduce((n, x) => n * 256 + x, 0)
        break
      case ID.codecId:
        if (current) current.codec = new TextDecoder().decode(b.subarray(body, end)).replace(/\0+$/, '')
        break
      case ID.codecPrivate:
        if (current) current.priv = b.slice(body, end)
        break
      case ID.channels:
        if (current) current.channels = b.subarray(body, end).reduce((n, x) => n * 256 + x, 0)
        break
      case ID.simpleBlock:
      case ID.block: {
        if (!opus && current?.codec === 'A_OPUS' && current.priv) opus = { number: current.number, priv: current.priv, channels: current.channels }
        if (!opus) break
        const t = vint(b, body, false)
        if (t.value !== opus.number) break
        const flags = b[body + t.length + 2]
        packets.push(...unlace(b, body + t.length + 3, end, flags & 0x06))
        break
      }
      default:
        break
    }
    at = end
  }
  if (!opus || !packets.length) return null
  const head = opus.priv
  // OpusHead: magic, version, channels, pre-skip (little-endian), rate, gain, mapping
  const magicOk = new TextDecoder().decode(head.subarray(0, 8)) === 'OpusHead'
  const channels = magicOk ? head[9] : opus.channels || 2
  const preSkip = magicOk ? head[10] | (head[11] << 8) : 0
  return { channels, preSkip, head, packets }
}

// ---- Opus packets --------------------------------------------------------------

/** samples (at 48 kHz) in one Opus packet, from its table-of-contents byte */
export function opusSamples(packet: Uint8Array): number {
  if (!packet.length) return 0
  const toc = packet[0]
  const config = toc >> 3
  const ms =
    config < 12 ? [10, 20, 40, 60][config % 4] : config < 16 ? [10, 20][config % 2] : [2.5, 5, 10, 20][config % 4]
  const code = toc & 3
  const frames = code === 0 ? 1 : code < 3 ? 2 : packet.length > 1 ? packet[1] & 0x3f : 0
  return Math.round(ms * 48) * frames
}

// ---- CAF ------------------------------------------------------------------------

/** a base-128 number, high bits first, as CAF's packet table wants */
function berLength(n: number): number {
  let len = 1
  while (n >= 128 ** len) len++
  return len
}

function writeBer(out: Uint8Array, at: number, n: number): number {
  const len = berLength(n)
  for (let i = len - 1; i >= 0; i--) {
    out[at + (len - 1 - i)] = (Math.floor(n / 128 ** i) % 128) | (i > 0 ? 0x80 : 0)
  }
  return at + len
}

/** the Opus packets in Apple's Core Audio Format, which Safari plays */
export function opusToCaf(track: OpusTrack): Blob {
  const sizes = track.packets.map((p) => p.length)
  const frames = track.packets.map(opusSamples)
  const constant = frames.every((f) => f === frames[0]) ? frames[0] : 0
  const total = frames.reduce((a, n) => a + n, 0)
  const dataBytes = sizes.reduce((a, n) => a + n, 0)
  const tableBytes = sizes.reduce((a, n) => a + berLength(n), 0) + (constant ? 0 : frames.reduce((a, n) => a + berLength(n), 0))
  const priming = Math.min(track.preSkip, total)

  const head = new Uint8Array(8 + 12 + 32 + 12 + 12 + 12 + 24 + tableBytes + 12 + 4)
  const v = new DataView(head.buffer)
  let at = 0
  const fourcc = (s: string): void => {
    for (let i = 0; i < 4; i++) head[at++] = s.charCodeAt(i)
  }
  const chunk = (type: string, size: number): void => {
    fourcc(type)
    v.setBigInt64(at, BigInt(size))
    at += 8
  }
  fourcc('caff')
  v.setUint16(at, 1)
  v.setUint16(at + 2, 0)
  at += 4

  chunk('desc', 32)
  v.setFloat64(at, 48000)
  at += 8
  fourcc('opus')
  v.setUint32(at, 0) // format flags
  v.setUint32(at + 4, 0) // bytes per packet: they vary
  v.setUint32(at + 8, constant) // frames per packet, 0 when they vary
  v.setUint32(at + 12, track.channels)
  v.setUint32(at + 16, 0) // bits per channel: compressed
  at += 20

  chunk('chan', 12)
  v.setUint32(at, track.channels === 1 ? (100 << 16) | 1 : (101 << 16) | 2) // mono / stereo layout tags
  v.setUint32(at + 4, 0)
  v.setUint32(at + 8, 0)
  at += 12

  chunk('pakt', 24 + tableBytes)
  v.setBigInt64(at, BigInt(sizes.length))
  v.setBigInt64(at + 8, BigInt(total - priming))
  v.setInt32(at + 16, priming)
  v.setInt32(at + 20, 0)
  at += 24
  for (let i = 0; i < sizes.length; i++) {
    at = writeBer(head, at, sizes[i])
    if (!constant) at = writeBer(head, at, frames[i])
  }

  chunk('data', 4 + dataBytes)
  v.setUint32(at, 0) // edit count
  at += 4
  return new Blob([head.subarray(0, at), ...track.packets.map((p) => p.slice())], { type: 'audio/x-caf' })
}

// ---- WAV, decoded (the last resort) ------------------------------------------------

/** 16 kHz mono: plenty for speech, a third of the size of 48 kHz */
const WAV_RATE = 16000

interface DecoderLike {
  configure(c: { codec: string; sampleRate: number; numberOfChannels: number; description?: BufferSource }): void
  decode(chunk: unknown): void
  flush(): Promise<void>
  close(): void
}

/** decode with the browser's own Opus decoder (WebCodecs) into a WAV file; null when there is none */
export async function opusToWav(track: OpusTrack, onProgress?: (fraction: number) => void): Promise<Blob | null> {
  const w = window as unknown as {
    AudioDecoder?: new (init: { output: (d: AudioDataLike) => void; error: (e: unknown) => void }) => DecoderLike
    EncodedAudioChunk?: new (init: { type: 'key'; timestamp: number; data: Uint8Array }) => unknown
  }
  if (!w.AudioDecoder || !w.EncodedAudioChunk) return null
  const total = track.packets.reduce((a, p) => a + opusSamples(p), 0)
  const out = new Int16Array(Math.ceil(total / 3) + WAV_RATE)
  let written = 0
  let skip = track.preSkip
  let failure: unknown = null
  // 48 kHz → 16 kHz: average each run of three samples, all channels mixed down
  let carry = 0
  let carried = 0
  const decoder = new w.AudioDecoder({
    output: (d) => {
      const n = d.numberOfFrames
      const chans = d.numberOfChannels
      const planes: Float32Array[] = []
      for (let c = 0; c < chans; c++) {
        const plane = new Float32Array(n)
        d.copyTo(plane, { planeIndex: c, format: 'f32-planar' })
        planes.push(plane)
      }
      d.close()
      for (let i = 0; i < n; i++) {
        if (skip > 0) {
          skip--
          continue
        }
        let s = 0
        for (let c = 0; c < chans; c++) s += planes[c][i]
        carry += s / chans
        if (++carried === 3) {
          const x = Math.max(-1, Math.min(1, carry / 3))
          if (written < out.length) out[written++] = x < 0 ? x * 0x8000 : x * 0x7fff
          carry = 0
          carried = 0
        }
      }
    },
    error: (e) => {
      failure = e
    }
  })
  decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: track.channels, description: new Uint8Array(track.head) })
  let ts = 0
  for (let i = 0; i < track.packets.length; i++) {
    const p = track.packets[i]
    decoder.decode(new w.EncodedAudioChunk({ type: 'key', timestamp: ts, data: p }))
    ts += (opusSamples(p) / 48000) * 1e6
    // let the decoder catch up now and then, and report how far along it is
    if (i % 500 === 499) {
      await decoder.flush()
      onProgress?.(i / track.packets.length)
    }
    if (failure) break
  }
  if (!failure) await decoder.flush()
  decoder.close()
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure))
  return wavBlob(out.subarray(0, written), WAV_RATE)
}

interface AudioDataLike {
  numberOfFrames: number
  numberOfChannels: number
  copyTo(dest: Float32Array, opts: { planeIndex: number; format: 'f32-planar' }): void
  close(): void
}

function wavBlob(samples: Int16Array, rate: number): Blob {
  const h = new DataView(new ArrayBuffer(44))
  const text = (at: number, s: string): void => {
    for (let i = 0; i < s.length; i++) h.setUint8(at + i, s.charCodeAt(i))
  }
  text(0, 'RIFF')
  h.setUint32(4, 36 + samples.byteLength, true)
  text(8, 'WAVE')
  text(12, 'fmt ')
  h.setUint32(16, 16, true)
  h.setUint16(20, 1, true) // PCM
  h.setUint16(22, 1, true) // mono
  h.setUint32(24, rate, true)
  h.setUint32(28, rate * 2, true)
  h.setUint16(32, 2, true)
  h.setUint16(34, 16, true)
  text(36, 'data')
  h.setUint32(40, samples.byteLength, true)
  return new Blob([h.buffer, samples.slice().buffer], { type: 'audio/wav' })
}

// ---- choosing ----------------------------------------------------------------------

export type Version = 'original' | 'caf' | 'wav'

/**
 * Ways to play a recording here, best first. Each is made only if the one
 * before it fails to play, so a phone that plays WebM never repackages it.
 */
export function playableVersions(
  blob: Blob,
  ext: string
): { kind: Version; make: (onProgress?: (fraction: number) => void) => Promise<Blob | null> }[] {
  const probe = document.createElement('audio')
  const can = (type: string): boolean => probe.canPlayType(type) !== ''
  if (ext !== '.webm') return [{ kind: 'original', make: async () => blob }]
  let parsed: Promise<OpusTrack | null> | null = null
  const track = (): Promise<OpusTrack | null> => (parsed ??= blob.arrayBuffer().then((buf) => readWebmOpus(new Uint8Array(buf))))
  const out: { kind: Version; make: (onProgress?: (fraction: number) => void) => Promise<Blob | null> }[] = []
  if (can('audio/webm; codecs="opus"')) out.push({ kind: 'original', make: async () => blob })
  if (can('audio/x-caf')) {
    out.push({
      kind: 'caf',
      make: async () => {
        const t = await track()
        return t ? opusToCaf(t) : null
      }
    })
  }
  out.push({
    kind: 'wav',
    make: async (onProgress) => {
      const t = await track()
      return t ? opusToWav(t, onProgress) : null
    }
  })
  return out
}
