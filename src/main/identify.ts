import { getSettings } from './settings'
import { aiChat } from './ai'
import { voiceReport } from './voiceid'
import type { Meeting, TranscriptSegment, VoiceMeta } from '../shared/types'

// ---------------------------------------------------------------------------
// Speaker identification: an opt-in model pass that attributes transcript
// turns to named speakers from conversational context (people address each
// other by name constantly in meetings). Works best when tinydiarize turn
// markers exist, but functions without them. Costs cents with Haiku.
// ---------------------------------------------------------------------------

const IDENTIFY_SCHEMA = {
  type: 'object',
  properties: {
    turns: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          startSegment: {
            type: 'number',
            description: 'Index of the first segment this speaker speaks (0-based)'
          },
          speaker: {
            type: 'string',
            description:
              'The speaker for this run of segments: a real name when determinable ("Priya"), "Me" for the app user when their lines are marked Me, or "Speaker 1"/"Speaker 2" when the name never surfaces'
          }
        },
        required: ['startSegment', 'speaker'],
        additionalProperties: false
      },
      description:
        'Every point where the speaker changes, in ascending startSegment order, starting at segment 0. Each entry applies until the next entry begins.'
    }
  },
  required: ['turns'],
  additionalProperties: false
} as const

/** transcript with segment indices and every hint we have (labels, turn marks) */
function numberedTranscript(segments: TranscriptSegment[], names: { me: string; them: string }): string {
  return segments
    .map((s, i) => {
      const label =
        s.speaker === 'me'
          ? `${names.me}: `
          : s.speaker === 'them'
            ? `${names.them}: `
            : s.speaker
              ? `${s.speaker}: `
              : ''
      return `${i}| ${label}${s.text}${s.turn ? '  «speaker changes after this line»' : ''}`
    })
    .join('\n')
}

const VOICE_SCHEMA = {
  type: 'object',
  properties: {
    voices: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          voice: { type: 'number', description: 'The voice number as labeled in the transcript ("Voice 2" is 2)' },
          name: {
            type: 'string',
            description:
              'Who this voice is: a real name when the evidence supports it, "Me" for the app user, or "Unknown" when the name never surfaces'
          }
        },
        required: ['voice', 'name'],
        additionalProperties: false
      },
      description: 'One entry per voice in the transcript.'
    }
  },
  required: ['voices'],
  additionalProperties: false
} as const

/**
 * Name the voices the voice engine separated. The engine already knows who
 * spoke when, so the model only has to say who each voice is, from what
 * people call each other plus the voiceprint report. Names you set yourself
 * (and your own microphone) are never changed.
 */
async function nameVoices(meeting: Meeting): Promise<Pick<Meeting, 'transcript' | 'voices'>> {
  const segments = meeting.transcript ?? []
  const voices: Record<string, VoiceMeta> = { ...(meeting.voices ?? {}) }
  const settings = getSettings()
  const knownNames = [...new Set([...(meeting.attendees ?? []), ...settings.people])]
  const lines = segments
    .map((s) => {
      const label =
        s.speaker === 'me' && meeting.mode === 'virtual'
          ? 'Me'
          : s.voice !== undefined
            ? `Voice ${s.voice + 1}`
            : 'Unknown voice'
      return `${label}: ${s.text}`
    })
    .join('\n')

  const response = await aiChat({
    maxTokens: 2048,
    schema: VOICE_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'voice_names',
    system:
      'You work out who is who in a meeting transcript produced by automatic speech recognition. A voice engine has already separated the speakers by how they sound, so each line is labeled with the voice that said it; your job is only to name each voice. ' +
      'Use conversational evidence: people address each other by name ("thanks, Priya"), introduce themselves, refer to their own work, and answer questions put to them by name. ' +
      'A voiceprint report says which voices match people heard in earlier meetings. A voice named by the app user, or recognized from their microphone, is certain. A strong voiceprint match is reliable unless the conversation clearly contradicts it. A weak match is only a hint. ' +
      'Lines labeled "Me" are the app user; a voice that is plainly the app user should be named "Me". ' +
      (knownNames.length > 0 ? `Likely participants (use these exact spellings): ${knownNames.join(', ')}. ` : '') +
      'Only give a real name when the evidence supports it; otherwise say "Unknown". Two voices can be the same person when the engine split one speaker in two.',
    messages: [
      {
        role: 'user',
        content: `<voiceprint_report>\n${voiceReport(meeting) || 'No voiceprints on file.'}\n</voiceprint_report>\n\n<transcript>\n${lines}\n</transcript>\n\nName every voice.`
      }
    ]
  })
  if (response.stop === 'refusal') throw new Error('The request was declined by the model.')
  if (!response.text) throw new Error('Empty response from the model')
  const parsed = JSON.parse(response.text) as { voices: { voice: number; name: string }[] }

  for (const { voice, name } of parsed.voices) {
    const key = String(Math.round(voice) - 1)
    const meta = voices[key]
    const clean = name.trim()
    // never overrule you or your microphone; "Unknown" leaves the placeholder
    if (!meta || meta.source === 'you' || meta.source === 'mic') continue
    if (!clean || /^unknown/i.test(clean)) continue
    voices[key] = { ...meta, name: clean.toLowerCase() === 'me' ? 'me' : clean, source: 'ai' }
  }

  const transcript = segments.map((s) => {
    if (s.voice === undefined || (s.speaker === 'me' && meeting.mode === 'virtual')) return { ...s }
    const meta = voices[String(s.voice)]
    return meta ? { ...s, speaker: meta.name } : { ...s }
  })
  return { transcript, voices }
}

/**
 * Ask the model to attribute speakers, then apply the turn map to the
 * segments. Returns the updated segments and voices (does not persist).
 * When the voice engine has run on the meeting, the model only names its
 * voices; otherwise it works out the turns from the text alone.
 */
export async function identifySpeakers(
  meeting: Meeting
): Promise<Pick<Meeting, 'transcript' | 'voices'>> {
  const segments = meeting.transcript
  if (!segments || segments.length === 0) {
    throw new Error('This meeting has no transcript yet.')
  }
  if (meeting.voices && Object.keys(meeting.voices).length > 0 && segments.some((s) => s.voice !== undefined)) {
    return nameVoices(meeting)
  }

  const settings = getSettings()
  const names = {
    me: meeting.speakerNames?.me ?? 'Me',
    them: meeting.speakerNames?.them ?? 'Them'
  }
  const knownNames = [
    ...new Set([...(meeting.attendees ?? []), ...settings.people])
  ]

  const response = await aiChat({
    maxTokens: 8192,
    schema: IDENTIFY_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'speaker_turns',
    system:
      'You attribute speakers in a meeting transcript produced by automatic speech recognition. ' +
      'Work from conversational context: people address each other by name, refer to their own work, answer questions directed at them. ' +
      `Lines already labeled "${names.me}" belong to the app user - output "Me" for those runs. ` +
      'Markers like «speaker changes after this line» come from acoustic turn detection and are strong hints for where one voice stops. ' +
      (knownNames.length > 0
        ? `Likely participants (use these exact spellings): ${knownNames.join(', ')}. `
        : '') +
      'Only use a real name when the context genuinely supports it; otherwise use "Speaker 1", "Speaker 2", numbering consistently for the same voice throughout. ' +
      'Return the complete turn map covering every segment from 0 to the end.',
    messages: [
      {
        role: 'user',
        content: `Attribute the speakers in this transcript (${segments.length} segments):\n\n${numberedTranscript(segments, names)}`
      }
    ]
  })

  if (response.stop === 'refusal') {
    throw new Error('The request was declined by the model.')
  }
  if (!response.text) throw new Error('Empty response from the model')
  const parsed = JSON.parse(response.text) as {
    turns: { startSegment: number; speaker: string }[]
  }

  const turns = parsed.turns
    .filter((t) => Number.isInteger(t.startSegment) && t.startSegment >= 0 && t.speaker.trim())
    .sort((a, b) => a.startSegment - b.startSegment)
  if (turns.length === 0) throw new Error('The model returned no speaker turns.')

  const updated = segments.map((s) => ({ ...s }))
  for (let i = 0; i < turns.length; i++) {
    const from = turns[i].startSegment
    const to = i + 1 < turns.length ? turns[i + 1].startSegment : updated.length
    const raw = turns[i].speaker.trim()
    const speaker = raw.toLowerCase() === 'me' || raw === names.me ? 'me' : raw
    for (let j = from; j < to && j < updated.length; j++) {
      updated[j].speaker = speaker
    }
  }
  return { transcript: updated, voices: meeting.voices }
}
