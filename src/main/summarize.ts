import Anthropic from '@anthropic-ai/sdk'
import { getApiKey } from './settings'
import { recordUsage } from './usage'
import type { MeetingSummary, TranscriptSegment } from '../shared/types'

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    title: {
      type: 'string',
      description: 'A short, specific title for this meeting (3-8 words), based on what was actually discussed'
    },
    tldr: {
      type: 'string',
      description: 'A 1-3 sentence plain-language recap of the meeting'
    },
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          heading: {
            type: 'string',
            description: 'Short topic heading (2-5 words), like a meeting-minutes section title'
          },
          notes: {
            type: 'array',
            items: { type: 'string' },
            description: 'Specific, information-dense notes for this topic; each a self-contained sentence'
          }
        },
        required: ['heading', 'notes'],
        additionalProperties: false
      },
      description:
        'The discussion grouped into topical sections in the order they came up. Split by subject matter, not by time. A short single-topic meeting may have just one section. Every note must belong to its section: fold stray details into the topic they relate to instead of collecting leftovers in a vague catch-all section, and drop details too minor to place.'
    },
    decisions: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Decisions that were made. This is the section people cite weeks later, so hold it to the strictest standard: include only what the transcript clearly supports, and state dates and numbers exactly as the speakers did — a summary with a wrong date in its decisions is worse than one with a vague date. Empty if none.'
    },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          task: {
            type: 'string',
            description:
              'The task, phrased as a specific, self-contained piece of work someone could paste into a task tracker and act on (start with a verb; include the concrete detail that makes it actionable)'
          },
          owner: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'Who committed to it: exactly one person\'s plain name. Use "Me" when the person this summary is for (transcript lines labeled Me) committed to it. Never a compound like "X and Y" or "X or Y" — pick the primary owner and mention the others in the task text. Never add qualifiers or parentheticals; if ownership is genuinely unclear, use null.'
          },
          due: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'Concise due date or timeframe, a few words at most (e.g. "July 21st", "next week", "end of Q3"), or null. Only when a real deadline was stated or clearly implied in the meeting — never invent one, and never use filler like "ongoing", "TBD", or "ASAP"; a task with no deadline gets null. Qualifying context belongs in the task text, not here.'
          }
        },
        required: ['task', 'owner', 'due'],
        additionalProperties: false
      },
      description:
        'Concrete follow-ups someone committed to, written as a checklist the reader could paste straight into a task tracker. One item per real task: when several people share the same task, emit it once under the primary owner and name the others in the task text rather than repeating the item per person; when several small fixes are part of one piece of work, fold them into one item. Fewer, sharper items beat an exhaustive list. Empty if none.'
    },
    openQuestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Unresolved questions or topics deferred to later. Empty if none.'
    }
  },
  required: ['title', 'tldr', 'topics', 'decisions', 'actionItems', 'openQuestions'],
  additionalProperties: false
} as const

/**
 * Schema for the fact-extraction pass: every hard fact a summary might cite,
 * each pinned to a verbatim transcript quote. Extraction is a mechanically
 * easier task than summarization, so this list is far more reliable about
 * exact figures than a generated summary is — it then anchors the checking
 * pass.
 */
const FACTS_SCHEMA = {
  type: 'object',
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['figure', 'date', 'threshold', 'assignment'],
            description:
              'figure: a count/amount/percentage. date: a calendar date, deadline, or timeframe. threshold: a cutoff or comparator. assignment: who owns a task or role.'
          },
          claim: {
            type: 'string',
            description:
              'The fact stated precisely, WITH the context that scopes it: for a figure, the filter/view/timeframe it was measured under; for a date, the specific event the speaker attached it to; for an assignment, the exact task or role.'
          },
          quote: {
            type: 'string',
            description: 'Short verbatim transcript excerpt (one sentence or two) this fact comes from'
          }
        },
        required: ['kind', 'claim', 'quote'],
        additionalProperties: false
      },
      description: 'Every hard fact in the transcript, in the order spoken.'
    }
  },
  required: ['facts'],
  additionalProperties: false
} as const

/** 'me'/'them' resolve through the meeting's speaker names; identified speakers are already names */
function speakerLabel(
  speaker: string | undefined,
  names: { me: string; them: string }
): string | null {
  if (!speaker) return null
  if (speaker === 'me') return names.me
  if (speaker === 'them') return names.them
  return speaker
}

export function transcriptToText(
  segments: TranscriptSegment[],
  names: { me: string; them: string } = { me: 'Me', them: 'Them' }
): string {
  return segments
    .map((s) => {
      const totalSec = Math.floor(s.from / 1000)
      const m = Math.floor(totalSec / 60)
      const sec = String(totalSec % 60).padStart(2, '0')
      const label = speakerLabel(s.speaker, names)
      return `[${m}:${sec}] ${label ? `${label}: ` : ''}${s.text}`
    })
    .join('\n')
}

export async function summarizeTranscript(
  segments: TranscriptSegment[],
  model: string,
  attendees?: string[],
  vocabulary?: string,
  userNotes?: string,
  meetingDate?: string
): Promise<MeetingSummary> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Claude API key set. Add one in Settings to enable summaries.')
  }

  const client = new Anthropic({ apiKey })
  const transcript = transcriptToText(segments)
  const attendeeNote =
    attendees && attendees.length > 0
      ? ` These names are known from the calendar invite or the user's team directory and may appear in this meeting: ${attendees.join(', ')}. When attributing action items or decisions to people, prefer these exact spellings over phonetic guesses from the transcript, but only when the transcript plausibly refers to that person.`
      : ''
  const vocabNote = vocabulary?.trim()
    ? ` The user's glossary of domain terms (correct spellings for words speech recognition often mangles): ${vocabulary.trim().slice(0, 600)}. Use these spellings when the transcript clearly means one of them.`
    : ''
  const parsedDate = meetingDate ? new Date(meetingDate) : null
  const dateNote =
    parsedDate && !Number.isNaN(parsedDate.getTime())
      ? ` The meeting took place on ${parsedDate.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}. Use this only to make sense of relative time references — do not repeat it in the summary.`
      : ''

  const draftPromise = client.messages.create({
    model,
    max_tokens: 8192,
    system:
      'You summarize meeting transcripts produced by automatic speech recognition. ' +
      'The transcript comes from automatic speech recognition and may contain errors; infer meaning from context and do not invent facts that are not supported by the transcript. ' +
      'Lines labeled "Me" were spoken by the person you are summarizing for; lines labeled "Them" are the other participants (possibly several people); lines may also carry specific speaker names. Unlabeled lines could be anyone. ' +
      'Write for the meeting participant reviewing this later: concrete, specific, no filler. ' +
      'Group the discussion into topical sections the way good meeting minutes do: when the conversation jumps between subjects, give each subject its own section with a short heading, and put the substance in the notes (numbers, names, formats, reasons), not vague paraphrase. ' +
      'Keep the summary internally consistent: a date, deadline, or figure must read the same in every section that mentions it. If the transcript supports only a rough timeframe ("beginning of September"), use that same rough timeframe everywhere — never sharpen it into a specific date the transcript does not state, and if two spots in the transcript seem to conflict, use the version with stronger support rather than repeating both. ' +
      'Never state a specific calendar date unless a speaker said that date. When the transcript gives a relative timeframe ("in three weeks", "next month"), keep the speakers\' phrasing instead of converting it to a date yourself — ASR mishears dates often enough that a computed date is more likely wrong than helpful. Before finishing, sanity-check the timeline you have written: every deadline must be consistent with the meeting date and with the sequence of events (work that supports a launch cannot be due after the launch); if a date fails that check, fall back to the relative phrasing actually used. ' +
      'Report a cause or explanation for a problem only when a participant actually voiced it in the meeting; never present your own inference as a conclusion the group reached. When describing a reported bug or issue, preserve the specific symptom as described rather than paraphrasing it into a different-sounding problem. ' +
      'When a figure was tied to a particular filter, view, or timeframe (e.g. a count that only holds for one term or one campus), keep that context attached to the number wherever it appears, and never mix figures from different views as if they were the same measurement. Copy thresholds and comparators exactly — "five or more" means at least 5, not more than 5. When the meeting covered two distinct items (two problems, two dependencies, two features), keep them distinct; never fold one into the other because they sound related. ' +
      'A date belongs to the event the speaker attached it to — re-read the surrounding lines before pairing a date with a deadline, and never move a date from one event to another. When a speaker gives a partial date ("the week of the 21st") without naming the month, do not fill the month in yourself — not even from a month mentioned in a neighboring sentence about a different event; keep it as spoken. ' +
      'An open question is one the meeting left unanswered; if the discussion (or another part of your own summary) answers it, it is not open. ' +
      'Leave out meeting mechanics — screen-share hiccups, audio trouble, waiting for people to join — unless someone committed to follow up on them.' +
      attendeeNote +
      vocabNote +
      dateNote,
    output_config: {
      format: {
        type: 'json_schema',
        schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>
      }
    },
    messages: [
      {
        role: 'user',
        content:
          `Summarize this meeting transcript:\n\n${transcript}` +
          (userNotes?.trim()
            ? `\n\n<user_notes>\nThe participant typed these notes during the meeting. Treat them as high-signal: they mark what mattered, correct names and numbers, and may state action items or decisions explicitly. Fold them into the summary where the transcript supports them.\n\n${userNotes.trim().slice(0, 8000)}\n</user_notes>`
            : '')
      }
    ]
  })

  // the fact sheet needs only the transcript, so it extracts while the draft generates
  const [response, factSheet] = await Promise.all([draftPromise, extractFacts(client, model, transcript)])
  recordUsage(model, response.usage)

  if (response.stop_reason === 'refusal') {
    throw new Error('The summary request was declined by the model.')
  }
  const text = response.content.find((b) => b.type === 'text')?.text
  if (!text) throw new Error('Empty response from Claude')
  const draft = JSON.parse(text) as MeetingSummary
  return verifySummary(client, model, transcript, draft, dateNote, factSheet)
}

/**
 * Pull every hard fact out of the transcript with its supporting quote.
 * Runs concurrently with draft generation; returns null on any failure so
 * the checking pass can still run unanchored.
 */
async function extractFacts(
  client: Anthropic,
  model: string,
  transcript: string
): Promise<string | null> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system:
        'You extract hard facts from a meeting transcript produced by automatic speech recognition. ' +
        'List every figure, date/deadline/timeframe, threshold, and task-or-role assignment stated in the transcript — each as a precise claim with the verbatim quote it comes from. ' +
        'Scope matters: a figure carries the filter/view/timeframe it was measured under; a date carries the specific event the speaker tied it to (look at the surrounding lines — a date near a topic is not necessarily about that topic); an assignment carries the exact task. ' +
        'Extract only what is actually said. Do not interpret, reconcile, or summarize.',
      output_config: {
        format: {
          type: 'json_schema',
          schema: FACTS_SCHEMA as unknown as Record<string, unknown>
        }
      },
      messages: [{ role: 'user', content: `Extract the facts from this transcript:\n\n${transcript}` }]
    })
    recordUsage(model, response.usage)
    if (response.stop_reason === 'refusal') return null
    const text = response.content.find((b) => b.type === 'text')?.text
    if (!text) return null
    const parsed = JSON.parse(text) as {
      facts: { kind: string; claim: string; quote: string }[]
    }
    if (!parsed.facts?.length) return null
    return parsed.facts.map((f) => `[${f.kind}] ${f.claim}\n  quote: "${f.quote}"`).join('\n')
  } catch {
    return null
  }
}

/**
 * Second pass: re-read the draft against the transcript and fix only factual
 * slips. A single generation pass reliably garbles a few details on long
 * transcripts (merged figures, drifted thresholds, conflated topics) and each
 * regeneration shuffles which ones — a dedicated checking pass with the
 * transcript in front of it is much better at exactness than generation is.
 * Falls back to the draft on any failure so summaries never break here.
 */
async function verifySummary(
  client: Anthropic,
  model: string,
  transcript: string,
  draft: MeetingSummary,
  dateNote: string,
  factSheet: string | null
): Promise<MeetingSummary> {
  try {
    const response = await client.messages.create({
      model,
      max_tokens: 8192,
      system:
        'You are fact-checking a draft meeting summary against the source transcript. The draft\'s structure, coverage, and wording are already good — reproduce it faithfully and change ONLY what is factually unsupported. ' +
        (factSheet
          ? 'A fact sheet extracted from the transcript is provided: every figure, date, threshold, and assignment, each pinned to a verbatim quote. Check the draft against it claim by claim — a draft claim that contradicts the fact sheet must be corrected to match the fact sheet, and a specific figure or date that appears in neither the fact sheet nor the transcript must be removed or replaced with the speakers\' own phrasing. '
          : '') +
        'Specifically correct: ' +
        '(1) Figures that do not match the transcript: restore the exact number, keep its filter/view/timeframe context attached, and never merge two different figures into one claim. ' +
        '(2) Thresholds and comparators: "five or more" is at least 5, not more than 5. ' +
        '(3) Dates or deadlines: a date belongs to the event the speaker attached it to — never moved to another event, and a partial date ("the week of the 21st") never gets a month filled in from a neighboring sentence about a different event. Replace unsupported dates with the speakers\' own phrasing or drop them, and verify the timeline is coherent (work supporting a launch cannot be due after the launch). ' +
        '(4) Distinct topics merged into one claim (two problems, two dependencies, two features treated as one): split them back apart as the transcript has them. ' +
        '(5) Assignments that contradict the roles the meeting established: a task must sit with the person who actually took it. ' +
        '(6) Internal contradictions between sections: align every mention on the version the transcript supports, and remove an "open question" that the meeting (or the summary itself) answers. ' +
        '(7) Stray artifacts: leftover labels, dangling punctuation, list counts that do not match the list. ' +
        '(8) Action items duplicated per person for the same task: collapse to one item under the primary owner — but never lose a person. Every owner in the draft must still appear in the result, as an item\'s owner or named in a collapsed item\'s task text. ' +
        'Do NOT shorten, condense, or drop anything else: reproduce every section, every note, and every action item at full length — your output must be the complete summary with only the corrections applied. Anything you cannot verify either way, leave exactly as the draft has it.' +
        dateNote,
      output_config: {
        format: {
          type: 'json_schema',
          schema: SUMMARY_SCHEMA as unknown as Record<string, unknown>
        }
      },
      messages: [
        {
          role: 'user',
          content:
            `<transcript>\n${transcript}\n</transcript>\n\n` +
            (factSheet ? `<fact_sheet>\n${factSheet}\n</fact_sheet>\n\n` : '') +
            `<draft_summary>\n${JSON.stringify(draft, null, 2)}\n</draft_summary>\n\nCheck the draft against the fact sheet and transcript, and return the corrected summary.`
        }
      ]
    })
    recordUsage(model, response.usage)
    if (response.stop_reason === 'refusal') return draft
    const text = response.content.find((b) => b.type === 'text')?.text
    if (!text) return draft
    const checked = JSON.parse(text) as MeetingSummary
    // Smaller models sometimes abbreviate when asked to reproduce a document,
    // silently dropping whole sections. A fact-check should barely change the
    // summary's size — if it shrank substantially, trust the draft instead.
    if (JSON.stringify(checked).length < JSON.stringify(draft).length * 0.7) return draft
    return checked
  } catch {
    return draft
  }
}

/** Answer a question about one meeting, grounded in its transcript. */
export async function askAboutMeeting(
  meeting: {
    title: string
    createdAt: string
    transcript?: TranscriptSegment[]
    qa?: { q: string; a: string }[]
    speakerNames?: { me: string; them: string }
  },
  question: string,
  model: string
): Promise<string> {
  const apiKey = getApiKey()
  if (!apiKey) {
    throw new Error('No Claude API key set. Add one in Settings first.')
  }
  if (!meeting.transcript?.length) {
    throw new Error('This meeting has no transcript to ask about yet.')
  }

  const client = new Anthropic({ apiKey })
  const history = (meeting.qa ?? []).flatMap((x) => [
    { role: 'user' as const, content: x.q },
    { role: 'assistant' as const, content: x.a }
  ])

  const response = await client.messages.create({
    model,
    max_tokens: 2048,
    system:
      `You answer questions about one specific meeting for a participant reviewing it later. ` +
      `Meeting: "${meeting.title}" on ${meeting.createdAt.slice(0, 10)}. ` +
      `Ground every answer in the transcript below; if the transcript does not contain the answer, say so plainly instead of guessing. ` +
      `The transcript is automatic speech recognition output and may contain errors. ` +
      `Speaker labels, when present, mark which audio source the line came from: "${meeting.speakerNames?.me ?? 'Me'}" is the person asking you questions now; "${meeting.speakerNames?.them ?? 'Them'}" is everyone else on the call. ` +
      `Answer concisely in plain prose.\n\n<transcript>\n${transcriptToText(meeting.transcript, meeting.speakerNames)}\n</transcript>`,
    messages: [...history, { role: 'user', content: question }]
  })
  recordUsage(model, response.usage)

  if (response.stop_reason === 'refusal') {
    throw new Error('The request was declined by the model.')
  }
  const text = response.content.find((b) => b.type === 'text')?.text
  if (!text) throw new Error('Empty response from Claude')
  return text
}

/** Cheap round-trip to validate a key when the user saves it in Settings. */
export async function testApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = new Anthropic({ apiKey: key.trim() })
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 8,
      messages: [{ role: 'user', content: 'Reply with OK' }]
    })
    recordUsage('claude-haiku-4-5', response.usage)
    return { ok: true }
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      return { ok: false, error: 'That API key was rejected. Double-check it and try again.' }
    }
    if (err instanceof Anthropic.APIError) {
      return { ok: false, error: `API error (${err.status}): ${err.message}` }
    }
    return { ok: false, error: err instanceof Error ? err.message : 'Unknown error' }
  }
}
