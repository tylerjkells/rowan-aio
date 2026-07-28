import { mkdirSync } from 'fs'
import { createHash, randomUUID } from 'crypto'
import { basename, extname } from 'path'
import { meetingDir, writeMeeting } from './store'
import type { Meeting, TranscriptSegment } from '../shared/types'

/** leading [hh:]mm:ss timestamp, with optional brackets/parens */
const TIME_RE = /^\s*[[(]?(\d{1,2}):(\d{2})(?::(\d{2}))?[\])]?\s*[-–—]?\s*/

const WORDS_PER_MS = 150 / 60000 // ~150 spoken words per minute

/**
 * Parse pasted transcript text into segments. Uses the source's own
 * timestamps when at least half the lines carry one; otherwise estimates
 * times from cumulative word count at a normal speaking pace.
 */
export function parseTranscript(text: string): { segments: TranscriptSegment[]; durationMs: number } {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  const raw: { time: number | null; text: string }[] = []
  for (const line of lines) {
    const m = line.match(TIME_RE)
    if (m) {
      const h = m[3] !== undefined ? Number(m[1]) : 0
      const min = m[3] !== undefined ? Number(m[2]) : Number(m[1])
      const sec = Number(m[3] ?? m[2])
      const rest = line.slice(m[0].length).trim()
      if (rest) raw.push({ time: (h * 3600 + min * 60 + sec) * 1000, text: rest })
    } else {
      raw.push({ time: null, text: line })
    }
  }
  if (raw.length === 0) return { segments: [], durationMs: 0 }

  const timestamped = raw.filter((r) => r.time !== null).length
  const useSourceTimes = timestamped >= raw.length / 2

  const segments: TranscriptSegment[] = []
  let cursor = 0
  for (const r of raw) {
    const words = r.text.split(/\s+/).length
    const estMs = Math.max(800, Math.round(words / WORDS_PER_MS))
    const from = useSourceTimes && r.time !== null ? r.time : cursor
    segments.push({ from, to: from + estMs, text: r.text })
    cursor = from + estMs
  }
  // when using source times, close each segment at the next one's start
  if (useSourceTimes) {
    for (let i = 0; i < segments.length - 1; i++) {
      if (segments[i + 1].from > segments[i].from) segments[i].to = segments[i + 1].from
    }
  }
  const durationMs = segments[segments.length - 1].to
  return { segments, durationMs }
}

/**
 * Fingerprint of a transcript's words, so importing the same source twice can
 * be detected regardless of the title or date it was filed under.
 */
export function importKeyFor(text: string): string {
  const normalized = text.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 20000)
  return createHash('sha1').update(normalized).digest('hex')
}

export function createImportedMeeting(
  title: string,
  dateIso: string,
  text: string,
  extras: { attendees?: string[] } = {}
): Meeting {
  const { segments, durationMs } = parseTranscript(text)
  if (segments.length === 0) {
    throw new Error('No usable text found in the pasted transcript.')
  }
  const when = new Date(dateIso)
  const id = `${when.toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
  mkdirSync(meetingDir(id), { recursive: true })
  const meeting: Meeting = {
    id,
    title: title.trim() || `Imported meeting · ${when.toLocaleDateString()}`,
    createdAt: when.toISOString(),
    durationMs,
    mode: 'imported',
    stage: 'recorded',
    hasAudio: false,
    transcript: segments,
    attendees: extras.attendees?.length ? extras.attendees : undefined,
    importKey: importKeyFor(text)
  }
  writeMeeting(meeting)
  return meeting
}

// ---------------------------------------------------------------------------
// Notion pages. "Export → Markdown & CSV" writes one .md per page: an H1
// title, then the page's database properties as `Key: value` lines, then the
// body. Filenames carry the page id as a 32-hex suffix. Everything below is
// best-effort — anything it cannot read is surfaced in the bulk import review
// list for the user to fix rather than guessed at silently.
// ---------------------------------------------------------------------------

export interface ParsedPage {
  title: string
  /** ISO instant; null when neither properties nor the filename said when */
  dateIso: string | null
  dateSource: 'property' | 'filename' | null
  attendees: string[]
  /** the transcript body, markdown stripped */
  body: string
}

/** trailing Notion page id, with the space or dash that precedes it */
const NOTION_ID_RE = /[ \-_][0-9a-f]{32}$/i

/** property keys worth reading a meeting date out of, best first */
const DATE_KEYS = [
  'date',
  'meeting date',
  'when',
  'date and time',
  'start',
  'start time',
  'created',
  'created time',
  'date created',
  'created at'
]

const ATTENDEE_KEYS = ['attendees', 'participants', 'people', 'present', 'with', 'guests']

/**
 * Property keys we recognize. A block of `Key: value` lines under the title is
 * only treated as properties when at least one key is one of these — otherwise
 * a transcript that opens with `David: ...` would lose its first lines.
 */
const KNOWN_KEYS = new Set([
  ...DATE_KEYS,
  ...ATTENDEE_KEYS,
  'owner',
  'organizer',
  'host',
  'tags',
  'tag',
  'status',
  'type',
  'category',
  'project',
  'team',
  'summary',
  'notes',
  'location',
  'duration',
  'last edited time',
  'last edited by',
  'created by'
])

const PROPERTY_RE = /^([^:]{1,40}):\s*(.*)$/

/** standalone structural headings that are not speech */
const STRUCTURAL_LINE_RE = /^(transcript|full transcript|recording|audio|meeting transcript)$/i

export function parseNotionPage(raw: string, filePath: string): ParsedPage {
  const lines = raw.replace(/^﻿/, '').replace(/\r\n/g, '\n').split('\n')
  let i = 0
  const skipBlanks = (): void => {
    while (i < lines.length && lines[i].trim() === '') i++
  }

  skipBlanks()
  let title = ''
  const heading = lines[i]?.match(/^#\s+(.*)$/)
  if (heading) {
    title = heading[1].trim()
    i++
  }

  // candidate property block: consecutive `Key: value` lines up to a blank
  skipBlanks()
  const props = new Map<string, string>()
  let cursor = i
  const block: [string, string][] = []
  while (cursor < lines.length && lines[cursor].trim() !== '') {
    const m = lines[cursor].trim().match(PROPERTY_RE)
    if (!m) break
    block.push([m[1].trim().toLowerCase(), m[2].trim()])
    cursor++
  }
  if (block.length > 0 && block.some(([k]) => KNOWN_KEYS.has(k))) {
    for (const [k, v] of block) props.set(k, v)
    i = cursor
  }

  const fileTitle = basename(filePath, extname(filePath)).replace(NOTION_ID_RE, '').trim()
  if (!title) title = fileTitle

  let dateIso: string | null = null
  let dateSource: ParsedPage['dateSource'] = null
  for (const key of DATE_KEYS) {
    const value = props.get(key)
    if (!value) continue
    const parsed = parseNotionDate(value)
    if (parsed) {
      dateIso = parsed
      dateSource = 'property'
      break
    }
  }
  if (!dateIso) {
    const fromName = dateFromText(`${fileTitle} ${title}`)
    if (fromName) {
      dateIso = fromName
      dateSource = 'filename'
    }
  }

  const attendees: string[] = []
  for (const key of ATTENDEE_KEYS) {
    const value = props.get(key)
    if (!value) continue
    for (const name of value.split(/,|;|\band\b/)) {
      const clean = stripInline(name).trim()
      if (clean && clean.length <= 60 && !attendees.some((a) => a.toLowerCase() === clean.toLowerCase())) {
        attendees.push(clean)
      }
    }
    if (attendees.length) break
  }

  return { title, dateIso, dateSource, attendees: attendees.slice(0, 12), body: cleanBody(lines.slice(i)) }
}

/** markdown decoration inside a line, removed so speaker names come out clean */
function stripInline(text: string): string {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<\/?[a-z][^>]*>/gi, '')
}

function cleanBody(lines: string[]): string {
  const out: string[] = []
  for (const raw of lines) {
    let line = raw.trim()
    if (!line) continue
    if (/^([-*_])\1{2,}$/.test(line)) continue // horizontal rule
    line = line.replace(/^#{1,6}\s+/, '') // headings become plain lines
    line = line.replace(/^>\s?/, '')
    line = line.replace(/^[-*+]\s+/, '')
    line = line.replace(/^\d+[.)]\s+/, '')
    line = line.replace(/^\[[ x]\]\s*/i, '') // Notion to-do checkboxes
    line = stripInline(line).trim()
    if (!line) continue
    if (STRUCTURAL_LINE_RE.test(line)) continue
    out.push(line)
  }
  return out.join('\n')
}

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december'
]

function localMidday(year: number, month: number, day: number): string | null {
  const d = new Date(year, month, day, 12, 0, 0)
  if (Number.isNaN(d.getTime())) return null
  if (d.getFullYear() !== year || d.getMonth() !== month || d.getDate() !== day) return null
  if (year < 2000 || year > new Date().getFullYear() + 1) return null
  return d.toISOString()
}

/** Notion property values: "July 3, 2025 10:02 AM", "2025-07-03", date ranges */
export function parseNotionDate(value: string): string | null {
  const text = value.split('→')[0].split('->')[0].trim()
  if (!text) return null

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return localMidday(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))

  const parsed = new Date(text)
  if (Number.isNaN(parsed.getTime())) return dateFromText(text)
  const year = parsed.getFullYear()
  if (year < 2000 || year > new Date().getFullYear() + 1) return null
  // a bare date parses to local midnight; park it at midday so timezone math
  // downstream can never slide it onto the day before
  if (!/\d{1,2}:\d{2}/.test(text)) {
    return localMidday(year, parsed.getMonth(), parsed.getDate())
  }
  return parsed.toISOString()
}

/** a date embedded in a filename or title, e.g. "2025-07-03 Standup", "Jul 3, 2025" */
export function dateFromText(text: string): string | null {
  const iso = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/)
  if (iso) {
    const hit = localMidday(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]))
    if (hit) return hit
  }

  // scan every "<word> <day>[, <year>]" candidate: the first one is often not
  // the month (e.g. "Sync 3"), so keep looking until a real month name shows up
  for (const named of text.matchAll(
    /\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?(?:\s+(\d{4}))?\b/g
  )) {
    const month = MONTHS.findIndex((m) => m.startsWith(named[1].toLowerCase()))
    if (month < 0) continue
    const year = named[3] ? Number(named[3]) : new Date().getFullYear()
    const hit = localMidday(year, month, Number(named[2]))
    if (hit) return hit
  }

  const us = text.match(/\b(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})\b/)
  if (us) {
    const year = Number(us[3].length === 2 ? `20${us[3]}` : us[3])
    const hit = localMidday(year, Number(us[1]) - 1, Number(us[2]))
    if (hit) return hit
  }

  return null
}
