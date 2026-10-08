import { BrowserWindow } from 'electron'
import { existsSync, rmSync } from 'fs'
import {
  readMeeting,
  writeMeeting,
  wavPath,
  labelSpeakers,
  isCatchingUp,
  collectLiveTranscript
} from './store'
import { transcribe, vocabularyPrompt } from './whisper'
import { summarizeTranscript } from './summarize'
import { activeAiModel } from './ai'
import { getSettings } from './settings'
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
      // live transcription already produced the transcript; drop the safety wav
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
          vocabularyPrompt(settings.vocabulary) || undefined
        )
        if (transcript.length === 0) {
          // keep the wav so "Try again" (or a different model) has something to work with
          update(meeting, { stage: 'error', progress: undefined, error: NO_SPEECH })
          return
        }
        labelSpeakers(id, transcript)
        meeting = update(meeting, { transcript, progress: undefined })
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

/** modelOverride: one-off model for this run (the Regenerate menu); default is Settings */
export async function summarizeMeeting(id: string, modelOverride?: string): Promise<void> {
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
    const summary = await summarizeTranscript(
      transcript,
      modelOverride ?? activeAiModel(),
      knownNames,
      settings.vocabulary,
      meeting.notes,
      meeting.createdAt
    )
    const keepUserTitle =
      meeting.title && !/^(Virtual meeting|Imported meeting|Meeting) · /.test(meeting.title)
    update(meeting, {
      summary,
      title: keepUserTitle ? meeting.title : summary.title,
      stage: 'ready'
    })
  } catch (err) {
    update(meeting, {
      stage: 'transcript-only',
      error: err instanceof Error ? err.message : 'Summarization failed'
    })
  }
}
