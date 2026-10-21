import { BrowserWindow } from 'electron'
import { existsSync, rmSync } from 'fs'
import {
  readMeeting,
  writeMeeting,
  wavPath,
  labelSpeakers,
  isCatchingUp,
  collectLiveTranscript,
  hasUserTitle
} from './store'
import { transcribe, meetingPrompt, vocabularyPrompt } from './whisper'
import { summarizeTranscript } from './summarize'
import { activeAiModel } from './ai'
import { getSettings } from './settings'
import { runVoiceEngine, saveVoiceRun, syncVoiceprints, voiceIdActive, type VoiceResult } from './voiceid'
import type { Meeting } from '../shared/types'

function broadcast(meeting: Meeting): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('meeting:updated', meeting)
  }
}

function update(meeting: Meeting, patch: Partial<Meeting>): Meeting {
  const next = { ...meeting, ...patch }
  writeMeeting(next)
  broadcast(next)
  return next
}

const inFlight = new Set<string>()

export const NO_SPEECH =
  'No speech was found in the recording. If people were talking, the microphone may have been muted or the wrong device was selected. Check the Windows sound settings, then try again or re-transcribe from the audio.'

/** Run transcription (and summarization if enabled) for a recorded meeting. */
export async function processMeeting(id: string): Promise<void> {
  if (inFlight.has(id)) return
  inFlight.add(id)
  try {
    let meeting = readMeeting(id)
    if (!meeting) return
    const settings = getSettings()
    // voice recognition needs only the audio, so it starts now and works
    // alongside whatever transcription is left, instead of after it
    const voices = voiceIdActive() && existsSync(wavPath(id)) ? startVoiceRun(wavPath(id)) : null

    if (isCatchingUp(id)) {
      // the recording just stopped and its live transcript is still working
      // through the backlog. Progress re-reads the meeting each time so a
      // rename made meanwhile is not overwritten.
      meeting = update(meeting, { stage: 'transcribing', error: undefined })
      const live = await collectLiveTranscript(id, (percent) => {
        const fresh = readMeeting(id)
        if (fresh) meeting = update(fresh, { stage: 'transcribing', progress: percent })
      })
      meeting = readMeeting(id)
      if (!meeting) return // deleted while it caught up
      if (live) {
        labelSpeakers(id, live)
        meeting = update(meeting, { transcript: live, progress: undefined })
      }
    }

    if (meeting.transcript && meeting.transcript.length > 0) {
      // live transcription already produced the transcript: once the voice
      // engine is done with the recording's audio, the safety wav goes
      meeting = (await finishVoiceRun(id, voices)) ?? meeting
      rmSync(wavPath(id), { force: true })
    }

    if (!meeting.transcript || meeting.transcript.length === 0) {
      const wav = wavPath(id)
      if (!existsSync(wav)) {
        update(meeting, { stage: 'error', error: 'Recording audio for transcription is missing.' })
        return
      }
      meeting = update(meeting, { stage: 'transcribing', progress: 0, error: undefined })
      try {
        const transcript = await transcribe(
          wav,
          settings.whisperModel,
          (percent) => {
            meeting = update(meeting!, { stage: 'transcribing', progress: percent })
          },
          (settings.vocabFromCalendar
            ? meetingPrompt(settings.vocabulary, meeting.attendees, meeting.title)
            : vocabularyPrompt(settings.vocabulary)) || undefined
        )
        if (transcript.length === 0) {
          // keep the wav so "Try again" (or a different model) has something to work with
          update(meeting, { stage: 'error', progress: undefined, error: NO_SPEECH })
          return
        }
        labelSpeakers(id, transcript)
        meeting = update(meeting, { transcript, progress: undefined })
        meeting = (await finishVoiceRun(id, voices)) ?? meeting
        rmSync(wav, { force: true })
      } catch (err) {
        update(meeting, {
          stage: 'error',
          progress: undefined,
          error: err instanceof Error ? err.message : 'Transcription failed'
        })
        return
      }
    }

    if (!settings.autoSummarize || !settings.aiReady) {
      update(meeting, { stage: 'transcript-only', progress: undefined })
      return
    }
    await summarizeMeeting(id)
  } finally {
    inFlight.delete(id)
  }
}

/**
 * A voice engine run under way. Until the meeting is waiting on it (its
 * transcript isn't done yet) its progress is only kept, so it doesn't fight
 * the transcription's for the progress bar.
 */
interface VoiceRun {
  done: Promise<VoiceResult | Error>
  progress: number
  onProgress: ((percent: number) => void) | null
}

function startVoiceRun(wav: string): VoiceRun {
  const run: VoiceRun = { done: Promise.resolve(new Error()), progress: 0, onProgress: null }
  run.done = runVoiceEngine(wav, (percent) => {
    run.progress = percent
    run.onProgress?.(percent)
  }).catch((err) => (err instanceof Error ? err : new Error('Voice recognition failed.')))
  return run
}

/**
 * Wait for a voice run, showing Identifying voices while it finishes, and
 * name the voices the voiceprint library knows. Never fails the meeting: an
 * engine problem is noted on it and the summary goes ahead with the labels
 * it already had. Null when the meeting is gone.
 */
async function finishVoiceRun(id: string, run: VoiceRun | null): Promise<Meeting | null> {
  if (!run) return null
  let meeting = readMeeting(id)
  if (!meeting?.transcript?.length) {
    // still let it finish with the audio before anything removes it
    await run.done
    return meeting
  }
  const before = meeting.stage
  meeting = update(meeting, { stage: 'identifying', progress: run.progress, voiceError: undefined })
  run.onProgress = (percent) => {
    const fresh = readMeeting(id)
    if (fresh) update(fresh, { stage: 'identifying', progress: percent })
  }
  const result = await run.done
  run.onProgress = null
  // re-read: the meeting may have been renamed or edited while the engine ran
  const fresh = readMeeting(id)
  if (!fresh) return null
  try {
    if (result instanceof Error) throw result
    meeting = update(fresh, { ...saveVoiceRun(fresh, result), stage: before, progress: undefined })
    syncVoiceprints(meeting)
  } catch (err) {
    meeting = update(fresh, {
      stage: before,
      progress: undefined,
      voiceError: err instanceof Error ? err.message : 'Voice recognition failed.'
    })
  }
  return meeting
}

/**
 * Run the voice engine on a meeting's audio (one decoded from the saved
 * recording, for an older meeting) and apply what it finds. Returns the
 * updated meeting, or null when the meeting is gone.
 */
export async function runVoiceIdentification(id: string, wav: string): Promise<Meeting | null> {
  const meeting = readMeeting(id)
  if (!meeting?.transcript?.length) return meeting
  return finishVoiceRun(id, startVoiceRun(wav))
}

/**
 * modelOverride: one-off model for this run (the Regenerate menu); default is
 * Settings. extraInstructions: one-off asks for this run only, on top of the
 * standing instructions from Settings.
 */
export async function summarizeMeeting(
  id: string,
  modelOverride?: string,
  extraInstructions?: string
): Promise<void> {
  let meeting = readMeeting(id)
  const transcript = meeting?.transcript
  if (!meeting || !transcript || transcript.length === 0) return
  const settings = getSettings()
  meeting = update(meeting, { stage: 'summarizing', error: undefined })
  try {
    // calendar attendees plus the team directory: the model gets real name
    // spellings to attribute against, attendees first
    const knownNames = [...(meeting.attendees ?? []), ...settings.people]
      .filter((n, i, all) => all.findIndex((x) => x.toLowerCase() === n.toLowerCase()) === i)
      .slice(0, 40)
    const instructions = [settings.summaryInstructions, extraInstructions ?? '']
      .map((t) => t.trim())
      .filter(Boolean)
      .join('\n')
    const summary = await summarizeTranscript(
      transcript,
      modelOverride ?? activeAiModel(),
      knownNames,
      settings.vocabulary,
      meeting.notes,
      meeting.createdAt,
      instructions
    )
    const keepUserTitle = !!meeting.title && hasUserTitle(meeting)
    update(meeting, {
      summary,
      title: keepUserTitle ? meeting.title : summary.title,
      stage: 'ready',
      // a fresh summary carries no hand edits
      summaryEdited: undefined
    })
  } catch (err) {
    update(meeting, {
      stage: 'transcript-only',
      error: err instanceof Error ? err.message : 'Summarization failed'
    })
  }
}
