import { getSettings } from './settings'
import { aiChat } from './ai'
import type { Meeting, TranscriptSegment } from '../shared/types'

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

/**
 * Ask the model to attribute speakers, then apply the turn map to the
 * segments. Returns the updated segments (does not persist).
 */
export async function identifySpeakers(meeting: Meeting): Promise<TranscriptSegment[]> {
  const segments = meeting.transcript
  if (!segments || segments.length === 0) {
    throw new Error('This meeting has no transcript yet.')
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
  return updated
}
