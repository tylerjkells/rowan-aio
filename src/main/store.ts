import { app, BrowserWindow } from 'electron'
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  createWriteStream,
  createReadStream,
  type WriteStream
} from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { LiveTranscriber } from './live'
import { engineStatus, vocabularyPrompt } from './whisper'
import { getSettings } from './settings'
import type {
  EnergySample,
  Meeting,
  MeetingListItem,
  RecordingMode,
  TranscriptSegment
} from '../shared/types'

export function meetingsRoot(): string {
  const dir = join(app.getPath('userData'), 'meetings')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function meetingDir(id: string): string {
  return join(meetingsRoot(), id)
}

function metaPath(id: string): string {
  return join(meetingDir(id), 'meeting.json')
}

export function audioPath(id: string): string {
  return join(meetingDir(id), 'audio.webm')
}

/** playback audio: webm for normal recordings, wav for recovered ones */
export function findAudio(id: string): string | null {
  const webm = join(meetingDir(id), 'audio.webm')
  if (existsSync(webm)) return webm
  const wav = join(meetingDir(id), 'audio.wav')
  if (existsSync(wav)) return wav
  return null
}

export function wavPath(id: string): string {
  return join(meetingDir(id), 'whisper-input.wav')
}

export function energyPath(id: string): string {
  return join(meetingDir(id), 'energy.json')
}

function notesPath(id: string): string {
  return join(meetingDir(id), 'notes.txt')
}

/** stash live-typed notes next to the in-progress recording (crash-safe) */
export function stashNotes(id: string, text: string): void {
  try {
    if (text.trim()) writeFileSync(notesPath(id), text)
    else rmSync(notesPath(id), { force: true })
  } catch {
    // a failed stash only loses the latest keystrokes
  }
}

export function readStashedNotes(id: string): string {
  try {
    return readFileSync(notesPath(id), 'utf-8')
  } catch {
    return ''
  }
}

/** pull stashed notes into the meeting record and clean up the stash file */
function collectNotes(id: string): string | undefined {
  const text = readStashedNotes(id).trim()
  rmSync(notesPath(id), { force: true })
  return text || undefined
}

export function readMeeting(id: string): Meeting | null {
  try {
    return JSON.parse(readFileSync(metaPath(id), 'utf-8')) as Meeting
  } catch {
    return null
  }
}

export function writeMeeting(meeting: Meeting): void {
  mkdirSync(meetingDir(meeting.id), { recursive: true })
  writeFileSync(metaPath(meeting.id), JSON.stringify(meeting, null, 2))
}

export function listMeetings(): MeetingListItem[] {
  const root = meetingsRoot()
  const items: MeetingListItem[] = []
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const m = readMeeting(entry.name)
    if (!m) continue
    items.push({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      durationMs: m.durationMs,
      mode: m.mode,
      stage: m.stage,
      progress: m.progress,
      error: m.error,
      tldr: m.summary?.tldr
    })
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return items
}

/** fingerprints of everything already imported, so a re-import can skip them */
export function existingImportKeys(): Set<string> {
  const keys = new Set<string>()
  for (const entry of readdirSync(meetingsRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const key = readMeeting(entry.name)?.importKey
    if (key) keys.add(key)
  }
  return keys
}

export function deleteMeeting(id: string): void {
  rmSync(meetingDir(id), { recursive: true, force: true })
}

// ---------------------------------------------------------------------------
// Live recording sessions: PCM chunks stream in over IPC and append to a raw
// file; on finish we wrap it in a WAV header for Whisper and store the
// compressed webm alongside for playback.
// ---------------------------------------------------------------------------

interface RecSession {
  id: string
  mode: RecordingMode
  startedAt: string
  pcmStream: WriteStream
  pcmBytes: number
  live: LiveTranscriber | null
}

const sessions = new Map<string, RecSession>()

/** whether any recording session is live (used to suppress record nudges) */
export function hasActiveRecording(): boolean {
  return sessions.size > 0
}

function broadcastLive(id: string, segments: TranscriptSegment[], transcribedMs: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('rec:live', { id, segments, transcribedMs })
  }
}

export function beginRecording(mode: RecordingMode): string {
  const now = new Date()
  const id = `${now.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  mkdirSync(meetingDir(id), { recursive: true })
  const pcmStream = createWriteStream(join(meetingDir(id), 'raw.pcm'))

  // transcribe as we go when the engine is available, so the transcript is
  // essentially ready the moment the recording stops
  const settings = getSettings()
  const engine = engineStatus(settings.whisperModel)
  const live =
    engine.binaryReady && engine.modelReady
      ? new LiveTranscriber(
          meetingDir(id),
          settings.whisperModel,
          (segs, ms) => broadcastLive(id, segs, ms),
          vocabularyPrompt(settings.vocabulary)
        )
      : null

  sessions.set(id, { id, mode, startedAt: now.toISOString(), pcmStream, pcmBytes: 0, live })
  return id
}

export function appendPcm(id: string, chunk: Buffer): void {
  const s = sessions.get(id)
  if (!s) return
  s.pcmStream.write(chunk)
  s.pcmBytes += chunk.length
  s.live?.feed(chunk)
}

const SAMPLE_RATE = 16000

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44)
  h.write('RIFF', 0)
  h.writeUInt32LE(36 + dataBytes, 4)
  h.write('WAVE', 8)
  h.write('fmt ', 12)
  h.writeUInt32LE(16, 16) // PCM chunk size
  h.writeUInt16LE(1, 20) // PCM format
  h.writeUInt16LE(1, 22) // mono
  h.writeUInt32LE(SAMPLE_RATE, 24)
  h.writeUInt32LE(SAMPLE_RATE * 2, 28) // byte rate (16-bit mono)
  h.writeUInt16LE(2, 32) // block align
  h.writeUInt16LE(16, 34) // bits per sample
  h.write('data', 36)
  h.writeUInt32LE(dataBytes, 40)
  return h
}

export async function finishRecording(
  id: string,
  webm: Buffer,
  durationMs: number,
  energy: EnergySample[] | null
): Promise<Meeting> {
  const s = sessions.get(id)
  if (!s) throw new Error(`No active recording session ${id}`)
  sessions.delete(id)

  await new Promise<void>((resolve, reject) =>
    s.pcmStream.end((err: NodeJS.ErrnoException | null | undefined) => (err ? reject(err) : resolve()))
  )

  // raw.pcm -> whisper-input.wav (prepend header, then stream-copy)
  const rawPath = join(meetingDir(id), 'raw.pcm')
  await pcmToWav(rawPath, wavPath(id), s.pcmBytes)
  rmSync(rawPath, { force: true })

  writeFileSync(audioPath(id), webm)
  if (energy && energy.length > 0) {
    writeFileSync(energyPath(id), JSON.stringify(energy))
  }

  // collect the live transcript if it kept up; fall back to whole-file
  // transcription in the pipeline when it did not
  let transcript: TranscriptSegment[] | undefined
  if (s.live) {
    const result = await s.live.finish()
    if (result && result.length > 0) {
      labelSpeakers(id, result)
      transcript = result
      rmSync(wavPath(id), { force: true })
    }
  }

  const when = new Date(s.startedAt)
  const meeting: Meeting = {
    id,
    title: defaultTitle(when, s.mode),
    createdAt: s.startedAt,
    durationMs,
    mode: s.mode,
    stage: 'recorded',
    hasAudio: true,
    transcript,
    notes: collectNotes(id)
  }
  writeMeeting(meeting)
  return meeting
}

async function pcmToWav(rawPath: string, dest: string, bytes: number): Promise<void> {
  const wav = createWriteStream(dest)
  wav.write(wavHeader(bytes))
  await new Promise<void>((resolve, reject) => {
    const rd = createReadStream(rawPath)
    rd.on('error', reject)
    wav.on('error', reject)
    wav.on('finish', resolve)
    rd.pipe(wav)
  })
}

/**
 * Attribute transcript segments to "me" (mic) or "them" (system audio) using
 * the per-source loudness timeline captured while recording. When tinydiarize
 * marked speaker turns, whole turns are labeled from their aggregate energy,
 * which is far more stable than per-segment labeling.
 */
export function labelSpeakers(id: string, segments: TranscriptSegment[]): void {
  const path = energyPath(id)
  if (!existsSync(path)) return
  try {
    const samples = JSON.parse(readFileSync(path, 'utf-8')) as EnergySample[]

    // group segments into speaker turns; without turn markers every segment
    // is its own group, which is the old per-segment behavior
    const groups: TranscriptSegment[][] = []
    let current: TranscriptSegment[] = []
    for (const seg of segments) {
      current.push(seg)
      if (seg.turn) {
        groups.push(current)
        current = []
      }
    }
    if (current.length) groups.push(current)

    for (const group of groups) {
      const from = group[0].from
      const to = group[group.length - 1].to
      let mic = 0
      let sys = 0
      let n = 0
      for (const smp of samples) {
        if (smp.t >= from && smp.t <= to) {
          mic += smp.mic
          sys += smp.sys
          n++
        }
      }
      if (n === 0 || mic + sys < 0.01) continue
      const speaker = mic >= sys ? 'me' : 'them'
      for (const seg of group) seg.speaker = speaker
    }
  } catch {
    // unreadable timeline: ship the transcript unlabeled
  }
  rmSync(path, { force: true })
}

/**
 * Salvage recordings orphaned by a crash or power loss: the raw PCM streams
 * to disk while recording, so a meeting folder with raw.pcm but no
 * meeting.json can still be transcribed.
 */
export async function recoverOrphanedRecordings(): Promise<Meeting[]> {
  const recovered: Meeting[] = []
  for (const entry of readdirSync(meetingsRoot(), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const id = entry.name
    const dir = meetingDir(id)
    const rawPath = join(dir, 'raw.pcm')
    if (existsSync(join(dir, 'meeting.json')) || !existsSync(rawPath)) continue
    if (sessions.has(id)) continue

    const bytes = statSync(rawPath).size
    if (bytes < 32000) {
      // under a second of audio: nothing worth saving
      rmSync(dir, { recursive: true, force: true })
      continue
    }

    // keep the audio playable (wav) and queue it for transcription
    await pcmToWav(rawPath, join(dir, 'audio.wav'), bytes)
    await pcmToWav(rawPath, wavPath(id), bytes)
    rmSync(rawPath, { force: true })

    const createdAt = dateFromId(id) ?? statSync(dir).mtime.toISOString()
    const when = new Date(createdAt)
    const meeting: Meeting = {
      id,
      title: `Recovered recording · ${when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`,
      createdAt,
      durationMs: Math.round((bytes / 32000) * 1000),
      mode: 'in-person',
      stage: 'recorded',
      hasAudio: true,
      notes: collectNotes(id)
    }
    writeMeeting(meeting)
    recovered.push(meeting)
  }
  return recovered
}

function dateFromId(id: string): string | null {
  const m = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/)
  if (!m) return null
  return `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z`
}

export function cancelRecording(id: string): void {
  const s = sessions.get(id)
  if (s) {
    s.live?.abort()
    s.pcmStream.destroy()
    sessions.delete(id)
  }
  rmSync(meetingDir(id), { recursive: true, force: true })
}

function defaultTitle(when: Date, mode: RecordingMode): string {
  const date = when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  const time = when.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return `${mode === 'virtual' ? 'Virtual meeting' : 'Meeting'} · ${date}, ${time}`
}
