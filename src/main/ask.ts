import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { aiChat } from './ai'
import { listMeetings, readMeeting } from './store'
import { listPeople } from './people'
import { listLinks } from './links'
import { getBrand } from './brand'
import { transcriptToText } from './summarize'
import type { AskSource, LibraryQA, Meeting } from '../shared/types'

// ---------------------------------------------------------------------------
// Library-wide Q&A: answer questions across every meeting in the library.
//
// Two stages keep this cheap. Stage 1 sends only a compact catalog (title,
// date, summary bullets per meeting) and asks the model which meetings'
// transcripts it actually needs. Stage 2 sends those transcripts — capped —
// and produces a grounded answer with citations back to specific meetings.
// A typical question costs a few cents with Haiku even on a large library.
// ---------------------------------------------------------------------------

/** most transcripts the answer stage will read in full */
const MAX_SELECTED = 4
/** per-meeting transcript budget for the answer stage (chars) */
const PER_MEETING_CHARS = 60_000
/** recent exchanges carried into follow-up questions */
const HISTORY_TURNS = 6

function historyPath(): string {
  return join(app.getPath('userData'), 'ask.json')
}

export function readAskHistory(): LibraryQA[] {
  try {
    return JSON.parse(readFileSync(historyPath(), 'utf-8')) as LibraryQA[]
  } catch {
    return []
  }
}

export function clearAskHistory(): void {
  writeFileSync(historyPath(), '[]')
}

const SELECT_SCHEMA = {
  type: 'object',
  properties: {
    meetingIds: {
      type: 'array',
      items: { type: 'string' },
      description:
        'IDs (e.g. "m3") of the meetings whose full transcripts are needed to answer, most relevant first. At most 4. Empty if the catalog alone already answers the question.'
    }
  },
  required: ['meetingIds'],
  additionalProperties: false
} as const

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    answer: {
      type: 'string',
      description:
        'The answer in plain prose. Cite supporting meetings inline with bracketed markers like [1] or [2] that match the ref numbers in sources.'
    },
    sources: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          ref: {
            type: 'number',
            description: 'The marker number used inline in the answer, starting at 1'
          },
          meetingId: {
            type: 'string',
            description: 'The id of the cited meeting, e.g. "m3"'
          },
          quote: {
            anyOf: [{ type: 'string' }, { type: 'null' }],
            description:
              'A short excerpt (roughly 5-20 words) copied verbatim from the cited transcript line that best supports this citation, or null when the citation refers to the meeting as a whole'
          },
          timestampMs: {
            anyOf: [{ type: 'number' }, { type: 'null' }],
            description:
              'The [m:ss] transcript timestamp of that line, converted to milliseconds, or null when the citation is not tied to one moment'
          }
        },
        required: ['ref', 'meetingId', 'quote', 'timestampMs'],
        additionalProperties: false
      },
      description: 'Every meeting cited in the answer. Empty only if nothing was found.'
    }
  },
  required: ['answer', 'sources'],
  additionalProperties: false
} as const

/** meetings that have anything to ask about, newest first */
function loadAskableMeetings(): Meeting[] {
  const meetings: Meeting[] = []
  for (const entry of listMeetings()) {
    const m = readMeeting(entry.id)
    if (!m) continue
    if ((m.transcript?.length ?? 0) > 0 || m.summary) meetings.push(m)
  }
  return meetings
}

/**
 * Compact one-meeting catalog entry. Short aliases (m1, m2, …) stand in for
 * the long meeting ids so the model can reference them reliably and cheaply.
 */
function catalogEntry(alias: string, m: Meeting): string {
  const lines: string[] = [
    `id: ${alias}`,
    `title: ${m.title}`,
    `date: ${m.createdAt.slice(0, 10)}`,
    `duration: ${Math.round(m.durationMs / 60000)} min`
  ]
  const s = m.summary
  if (s) {
    lines.push(`tldr: ${s.tldr}`)
    if (s.decisions.length > 0) lines.push(`decisions: ${s.decisions.join(' | ')}`)
    if (s.actionItems.length > 0) {
      lines.push(
        `action items: ${s.actionItems
          .map((a) => `${a.task}${a.owner ? ` (${a.owner}${a.due ? `, ${a.due}` : ''})` : ''}`)
          .join(' | ')}`
      )
    }
    if (s.openQuestions.length > 0) lines.push(`open questions: ${s.openQuestions.join(' | ')}`)
  } else {
    lines.push('tldr: (no summary yet; transcript only)')
  }
  return lines.join('\n')
}

/** middle-truncate long transcripts so a marathon meeting cannot blow the budget */
function boundedTranscript(m: Meeting): string {
  const text = transcriptToText(m.transcript ?? [], m.speakerNames)
  if (text.length <= PER_MEETING_CHARS) return text
  const half = Math.floor(PER_MEETING_CHARS / 2)
  return `${text.slice(0, half)}\n… [middle of transcript trimmed for length] …\n${text.slice(-half)}`
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Find the transcript segment containing a quoted excerpt and return its
 * start time. Models copy text far more reliably than they convert
 * timestamps, so a located quote beats the model's own timestamp.
 */
function locateQuote(m: Meeting, quote: string): number | null {
  const segs = m.transcript ?? []
  const nq = normalizeForMatch(quote)
  if (nq.length < 8 || segs.length === 0) return null
  // one running haystack so quotes spanning segment boundaries still match
  let haystack = ''
  const starts: number[] = []
  for (const s of segs) {
    starts.push(haystack.length)
    haystack += normalizeForMatch(s.text) + ' '
  }
  for (const probe of [nq, nq.slice(0, 60), nq.slice(-60)]) {
    if (probe.length < 8) continue
    const pos = haystack.indexOf(probe)
    if (pos < 0) continue
    let idx = 0
    for (let i = 0; i < starts.length && starts[i] <= pos; i++) idx = i
    return segs[idx].from
  }
  return null
}

/** align a model-provided time to the start of the segment it falls in */
function snapToSegment(m: Meeting, ms: number): number {
  const segs = m.transcript ?? []
  const hit = segs.find((s) => ms >= s.from && ms < s.to)
  if (hit) return hit.from
  let best = ms
  let bestDist = Infinity
  for (const s of segs) {
    const dist = Math.abs(s.from - ms)
    if (dist < bestDist) {
      bestDist = dist
      best = s.from
    }
  }
  return best
}

function recentHistoryMessages(): { role: 'user' | 'assistant'; content: string }[] {
  return readAskHistory()
    .slice(-HISTORY_TURNS)
    .flatMap((x) => [
      { role: 'user' as const, content: x.q },
      { role: 'assistant' as const, content: x.a }
    ])
}

/**
 * Everything the app knows outside of meetings — the org directory, saved
 * links, brand colors, and the last-refreshed ClickUp task snapshot — as one
 * compact context block. Each source degrades to absent on any failure.
 */
function workspaceContext(): string {
  const parts: string[] = []
  try {
    const people = listPeople()
    if (people.length > 0) {
      const lines = people.map((p) => {
        const d = p.details
        const bits = [
          d?.title,
          d?.department,
          d?.email,
          d?.phone,
          d?.office,
          d?.reportsTo ? `reports to ${d.reportsTo}` : null
        ]
          .filter(Boolean)
          .join(' · ')
        return `${p.name}${bits ? ` — ${bits}` : ''}`
      })
      parts.push(`<directory>\n${lines.join('\n')}\n</directory>`)
    }
  } catch {
    // directory unavailable
  }
  try {
    const links = listLinks()
    if (links.length > 0) {
      const lines = links.map((l) => `${l.name} (${l.category}): ${l.url}${l.note ? ` — ${l.note}` : ''}`)
      parts.push(`<links>\n${lines.join('\n')}\n</links>`)
    }
  } catch {
    // links unavailable
  }
  try {
    const brand = getBrand()
    const lines = brand.palettes.map(
      (p) =>
        `${p.name}: ${p.colors.map((c) => `${c.name}${c.hex ? ` ${c.hex}` : ''}`).join(', ')}`
    )
    parts.push(`<brand_colors>\n${lines.join('\n')}\n</brand_colors>`)
  } catch {
    // brand guide unavailable
  }
  try {
    const activity = JSON.parse(
      readFileSync(join(app.getPath('userData'), 'clickup-activity.json'), 'utf8')
    ) as { snapshot?: Record<string, { name: string; status: string; dueDate: string | null }> }
    const tasks = Object.values(activity.snapshot ?? {})
    if (tasks.length > 0) {
      const lines = tasks.map(
        (t) => `${t.name} — ${t.status}${t.dueDate ? `, due ${t.dueDate}` : ''}`
      )
      parts.push(
        `<clickup_tasks note="the user's open ClickUp tasks as of the last Projects refresh">\n${lines.join('\n')}\n</clickup_tasks>`
      )
    }
  } catch {
    // ClickUp not connected or never refreshed
  }
  return parts.join('\n\n')
}

/** Answer a question across the whole meeting library and workspace, with citations. */
export async function askLibrary(question: string, model: string): Promise<LibraryQA> {
  const meetings = loadAskableMeetings()
  const workspace = workspaceContext()
  if (meetings.length === 0 && !workspace) {
    throw new Error('Nothing to ask about yet. Record a meeting or add workspace data first.')
  }

  const aliases = new Map<string, Meeting>()
  meetings.forEach((m, i) => aliases.set(`m${i + 1}`, m))
  const catalog = [...aliases.entries()].map(([alias, m]) => catalogEntry(alias, m)).join('\n\n')
  const history = recentHistoryMessages()

  // Stage 1: pick which transcripts the answer actually needs. With a handful
  // of meetings the selection round-trip costs more than it saves — send all.
  const withTranscripts = [...aliases.entries()].filter(([, m]) => (m.transcript?.length ?? 0) > 0)
  let selected: [string, Meeting][]
  if (withTranscripts.length <= MAX_SELECTED) {
    selected = withTranscripts
  } else {
    const sel = await aiChat({
      model,
      maxTokens: 1024,
      schema: SELECT_SCHEMA as unknown as Record<string, unknown>,
      schemaName: 'meeting_selection',
      system:
        'You route questions over a personal library of meeting notes. Given the catalog below and a question, ' +
        'pick which meetings\' full transcripts are needed to answer it well. Prefer fewer, more relevant meetings. ' +
        `Catalog entries marked "transcript only" still have transcripts available.\n\n<catalog>\n${catalog}\n</catalog>`,
      messages: [...history, { role: 'user', content: question }]
    })
    if (sel.stop === 'refusal') {
      throw new Error('The request was declined by the model.')
    }
    const ids = sel.text ? (JSON.parse(sel.text) as { meetingIds: string[] }).meetingIds : []
    selected = ids
      .filter((id) => aliases.has(id) && (aliases.get(id)!.transcript?.length ?? 0) > 0)
      .slice(0, MAX_SELECTED)
      .map((id) => [id, aliases.get(id)!])
  }

  // Stage 2: answer from the selected transcripts (plus the catalog, so the
  // model keeps global awareness of meetings it did not open).
  const transcriptBlocks = selected
    .map(
      ([alias, m]) =>
        `<meeting id="${alias}" title="${m.title}" date="${m.createdAt.slice(0, 10)}">\n${boundedTranscript(m)}\n</meeting>`
    )
    .join('\n\n')

  const response = await aiChat({
    model,
    maxTokens: 4096,
    schema: ANSWER_SCHEMA as unknown as Record<string, unknown>,
    schemaName: 'library_answer',
    system:
      'You answer questions across a personal work hub for the person using it: their meeting library plus their workspace data (org directory, saved links, brand colors, open ClickUp tasks). ' +
      'Ground every answer in the material below; when it does not contain the answer, say so plainly instead of guessing. ' +
      'Meeting transcripts are automatic speech recognition output and may contain errors. ' +
      'In transcripts, speaker labels mark audio sources: the first-named label (often "Me") is the person asking you questions now; the other label is everyone else on that call. ' +
      'Answer concisely in plain prose. Cite the meetings that support meeting-based parts of the answer with inline markers like [1], and list each cited meeting in sources with its id. ' +
      'Answers drawn from workspace data (a phone number, a link, a color, a task) need no citations — leave sources empty when nothing came from a meeting. ' +
      'When several meetings touch the topic over time, prefer the most recent position and note how it evolved.\n\n' +
      `<catalog>\n${catalog || '(no meetings yet)'}\n</catalog>` +
      (workspace ? `\n\n${workspace}` : '') +
      (transcriptBlocks ? `\n\nFull transcripts of the most relevant meetings:\n\n${transcriptBlocks}` : ''),
    messages: [...history, { role: 'user', content: question }]
  })

  if (response.stop === 'refusal') {
    throw new Error('The request was declined by the model.')
  }
  if (!response.text) throw new Error('Empty response from the model')
  const parsed = JSON.parse(response.text) as {
    answer: string
    sources: { ref: number; meetingId: string; quote: string | null; timestampMs: number | null }[]
  }

  const sources: AskSource[] = []
  for (const s of parsed.sources) {
    const m = aliases.get(s.meetingId)
    if (!m || sources.some((x) => x.ref === s.ref)) continue
    // prefer the located quote; fall back to the model's own timestamp
    const located = s.quote ? locateQuote(m, s.quote) : null
    const claimed =
      typeof s.timestampMs === 'number' && s.timestampMs >= 0 && s.timestampMs <= m.durationMs
        ? snapToSegment(m, s.timestampMs)
        : null
    sources.push({
      ref: s.ref,
      meetingId: m.id,
      meetingTitle: m.title,
      createdAt: m.createdAt,
      timestampMs: located ?? claimed
    })
  }
  sources.sort((a, b) => a.ref - b.ref)

  const record: LibraryQA = {
    q: question,
    a: parsed.answer,
    sources,
    askedAt: new Date().toISOString()
  }
  writeFileSync(historyPath(), JSON.stringify([...readAskHistory(), record], null, 2))
  return record
}
