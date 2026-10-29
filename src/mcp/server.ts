/**
 * MeetingScribe MCP server: exposes the local meeting library, and the
 * tickets and status update kept beside it, to MCP clients (Claude Desktop
 * and friends) as read-only tools, so Claude can answer questions about
 * them, build reports from them, or push tasks to other connected tools
 * (e.g. ClickUp) — with the data never leaving the machine except in the
 * conversations the user chooses to have.
 *
 * Runs standalone via the MeetingScribe executable in Node mode
 * (ELECTRON_RUN_AS_NODE=1). No Electron APIs here — plain fs against the
 * data folder given in MEETINGSCRIBE_DATA.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { readFileSync, readdirSync, existsSync } from 'fs'
import { join } from 'path'
import type { StatusUpdateData, TeamTicket, Ticket, TicketNote } from '../shared/types'
import { statusUpdateDigest, teamDigest, ticketsDigest } from '../shared/workDigest'

interface Segment {
  from: number
  to: number
  text: string
  speaker?: string
}

interface Meeting {
  id: string
  title: string
  createdAt: string
  durationMs: number
  mode: string
  stage: string
  transcript?: Segment[]
  notes?: string
  attendees?: string[]
  tags?: string[]
  speakerNames?: { me: string; them: string }
  summary?: {
    tldr: string
    decisions: string[]
    actionItems: { task: string; owner: string | null; due: string | null; done?: boolean }[]
    openQuestions: string[]
    topics?: { heading: string; notes: string[] }[]
  }
}

const dataDir = process.env.MEETINGSCRIBE_DATA
if (!dataDir || !existsSync(dataDir)) {
  console.error('MEETINGSCRIBE_DATA is not set or does not exist')
  process.exit(1)
}
const meetingsDir = join(dataDir, 'meetings')
/** the app's link scheme (test and dev builds have their own); older configs lack it */
const urlScheme = process.env.ROWAN_URL_SCHEME || 'rowan-aio'

/** a link that opens the meeting in Rowan AIO, optionally at a moment */
function appUrl(id: string, ms?: number): string {
  const t = ms && ms > 0 ? `?t=${Math.floor(ms / 1000)}` : ''
  return `${urlScheme}://meeting/${encodeURIComponent(id)}${t}`
}

function readMeeting(id: string): Meeting | null {
  try {
    return JSON.parse(readFileSync(join(meetingsDir, id, 'meeting.json'), 'utf-8')) as Meeting
  } catch {
    return null
  }
}

function allMeetings(): Meeting[] {
  if (!existsSync(meetingsDir)) return []
  const out: Meeting[] = []
  for (const entry of readdirSync(meetingsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const m = readMeeting(entry.name)
    if (m) out.push(m)
  }
  out.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  return out
}

function speakerLabel(m: Meeting, speaker?: string): string | null {
  if (!speaker) return null
  if (speaker === 'me') return m.speakerNames?.me ?? 'Me'
  if (speaker === 'them') return m.speakerNames?.them ?? 'Them'
  return speaker
}

function transcriptText(m: Meeting): string {
  return (m.transcript ?? [])
    .map((s) => {
      const total = Math.floor(s.from / 1000)
      const stamp = `[${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}]`
      const label = speakerLabel(m, s.speaker)
      return `${stamp} ${label ? `${label}: ` : ''}${s.text}`
    })
    .join('\n')
}

function meetingCard(m: Meeting): Record<string, unknown> {
  return {
    id: m.id,
    title: m.title,
    date: m.createdAt,
    durationMinutes: Math.round(m.durationMs / 60000),
    mode: m.mode,
    tldr: m.summary?.tldr ?? null,
    attendees: m.attendees ?? [],
    tags: m.tags ?? [],
    app_url: appUrl(m.id)
  }
}

const dateFilters = {
  after: z
    .string()
    .optional()
    .describe('Only meetings on or after this date (YYYY-MM-DD or full ISO timestamp)'),
  before: z
    .string()
    .optional()
    .describe('Only meetings before this date (YYYY-MM-DD or full ISO timestamp)'),
  tag: z.string().optional().describe('Only meetings carrying this tag (case-insensitive)')
}

/** apply the shared after/before/tag filters; an unparseable date is ignored */
function filtered(
  meetings: Meeting[],
  f: { after?: string; before?: string; tag?: string }
): Meeting[] {
  const after = f.after ? Date.parse(f.after) : NaN
  const before = f.before ? Date.parse(f.before) : NaN
  const tag = f.tag?.trim().toLowerCase()
  return meetings.filter((m) => {
    const t = Date.parse(m.createdAt)
    if (!Number.isNaN(after) && t < after) return false
    if (!Number.isNaN(before) && t >= before) return false
    if (tag && !(m.tags ?? []).some((x) => x.toLowerCase() === tag)) return false
    return true
  })
}

function meetingFull(m: Meeting, includeTranscript: boolean): Record<string, unknown> {
  return {
    ...meetingCard(m),
    summary: m.summary ?? null,
    notes: m.notes ?? null,
    transcript: includeTranscript ? transcriptText(m) : '(pass include_transcript: true for the full transcript)'
  }
}

const server = new McpServer({ name: 'meetingscribe', version: '1.0.0' })

server.registerTool(
  'list_meetings',
  {
    description:
      'List meetings in the Rowan AIO library, newest first, optionally within a date range or carrying a tag. Each entry has id, title, date, duration, TL;DR, attendees, tags, and app_url (a link that opens the meeting in Rowan AIO; offer it to the user when pointing at a meeting).',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 25)'),
      ...dateFilters
    }
  },
  async ({ limit, after, before, tag }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          filtered(allMeetings(), { after, before, tag })
            .slice(0, limit ?? 25)
            .map(meetingCard),
          null,
          2
        )
      }
    ]
  })
)

server.registerTool(
  'get_meeting',
  {
    description:
      'Get one meeting in full: summary (TL;DR, decisions, action items, open questions, topics), typed notes, attendees, and optionally the transcript.',
    inputSchema: {
      id: z.string().describe('Meeting id from list_meetings or search_meetings'),
      include_transcript: z.boolean().optional().describe('Include the full transcript text (can be long)')
    }
  },
  async ({ id, include_transcript }) => {
    const m = readMeeting(id)
    if (!m) return { content: [{ type: 'text', text: `No meeting with id ${id}` }], isError: true }
    return {
      content: [{ type: 'text', text: JSON.stringify(meetingFull(m, include_transcript ?? false), null, 2) }]
    }
  }
)

server.registerTool(
  'search_meetings',
  {
    description:
      'Full-text search across meeting titles, tags, summaries, notes, and transcripts, optionally within a date range or tag. Every word in the query must appear somewhere in a meeting for it to match. When the words turn up in the transcript, match_url opens the meeting at that moment in Rowan AIO.',
    inputSchema: {
      query: z.string().describe('Words to search for'),
      limit: z.number().int().min(1).max(50).optional(),
      ...dateFilters
    }
  },
  async ({ query, limit, after, before, tag }) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const hits: Record<string, unknown>[] = []
    for (const m of filtered(allMeetings(), { after, before, tag })) {
      const haystack = [
        m.title,
        (m.tags ?? []).join(' '),
        m.notes ?? '',
        m.summary ? JSON.stringify(m.summary) : '',
        (m.transcript ?? []).map((s) => s.text).join(' ')
      ]
        .join(' ')
        .toLowerCase()
      if (!words.every((w) => haystack.includes(w))) continue
      // the first transcript line naming the first word, as a jump-in point
      const seg = (m.transcript ?? []).find((s) => s.text.toLowerCase().includes(words[0]))
      hits.push({ ...meetingCard(m), ...(seg ? { match_url: appUrl(m.id, seg.from) } : {}) })
      if (hits.length >= (limit ?? 10)) break
    }
    return { content: [{ type: 'text', text: JSON.stringify(hits, null, 2) }] }
  }
)

server.registerTool(
  'list_action_items',
  {
    description:
      'Action items across all meetings, with task, owner, free-text due, done state, and the source meeting. "Me" as owner means the MeetingScribe user.',
    inputSchema: {
      owner: z.string().optional().describe('Filter to one owner name (case-insensitive)'),
      open_only: z.boolean().optional().describe('Only items not yet done (default true)')
    }
  },
  async ({ owner, open_only }) => {
    const items: Record<string, unknown>[] = []
    for (const m of allMeetings()) {
      m.summary?.actionItems.forEach((a, index) => {
        if ((open_only ?? true) && a.done) return
        if (owner && a.owner?.trim().toLowerCase() !== owner.trim().toLowerCase()) return
        items.push({
          task: a.task,
          owner: a.owner,
          due: a.due,
          done: a.done ?? false,
          meetingId: m.id,
          meetingTitle: m.title,
          meetingDate: m.createdAt
        })
      })
    }
    return { content: [{ type: 'text', text: JSON.stringify(items, null, 2) }] }
  }
)

interface PersonEntry {
  name: string
  meetings: number
  openItems: number
  title?: string
  department?: string
  email?: string
  phone?: string
  office?: string
  reportsTo?: string
}

server.registerTool(
  'list_people',
  {
    description:
      'People known to the library (action-item owners, attendees, named speakers, the org directory) with meeting counts, open-item counts, and directory details where known: title, department, email, phone, office, and who they report to.',
    inputSchema: {}
  },
  async () => {
    const byKey = new Map<string, PersonEntry>()
    const add = (name: string): PersonEntry => {
      const key = name.trim().toLowerCase()
      let e = byKey.get(key)
      if (!e) {
        e = { name: name.trim(), meetings: 0, openItems: 0 }
        byKey.set(key, e)
      }
      return e
    }
    for (const m of allMeetings()) {
      const names = new Set<string>()
      for (const a of m.attendees ?? []) names.add(a)
      for (const s of m.transcript ?? []) {
        if (s.speaker && s.speaker !== 'me' && s.speaker !== 'them') names.add(s.speaker)
      }
      for (const item of m.summary?.actionItems ?? []) {
        if (item.owner && !['me', 'them'].includes(item.owner.trim().toLowerCase())) {
          names.add(item.owner)
          if (!item.done) add(item.owner).openItems++
        }
      }
      for (const n of names) add(n).meetings++
    }
    // roster names from settings carry proper display casing
    try {
      const roster: string[] =
        JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf-8')).people ?? []
      for (const n of roster) add(n)
    } catch {
      // no settings.json yet
    }
    // fold in the org directory: everyone in it appears, with their details
    try {
      const directory: Record<string, Record<string, string>> = JSON.parse(
        readFileSync(join(dataDir, 'directory.json'), 'utf-8')
      )
      for (const [key, details] of Object.entries(directory)) {
        const entry = byKey.get(key) ?? add(key)
        Object.assign(entry, details)
      }
    } catch {
      // no directory.json yet
    }
    return {
      content: [{ type: 'text', text: JSON.stringify([...byKey.values()], null, 2) }]
    }
  }
)

server.registerTool(
  'list_links',
  {
    description:
      'The org link hub: saved work links (dashboards, data centers, tools) with name, URL, category, note, and pinned flag.',
    inputSchema: {}
  },
  async () => {
    let links: unknown = []
    try {
      links = JSON.parse(readFileSync(join(dataDir, 'links.json'), 'utf-8'))
    } catch {
      // no links saved yet
    }
    return { content: [{ type: 'text', text: JSON.stringify(links, null, 2) }] }
  }
)

server.registerTool(
  'get_brand_guide',
  {
    description:
      'The Rowan brand guide: color palettes (name, hex, Pantone, CMYK), usage notes, and typography.',
    inputSchema: {}
  },
  async () => {
    let brand: unknown = null
    try {
      brand = JSON.parse(readFileSync(join(dataDir, 'brand.json'), 'utf-8'))
    } catch {
      // brand guide not initialized yet
    }
    return { content: [{ type: 'text', text: JSON.stringify(brand, null, 2) }] }
  }
)

/** one of the app's data files, or null when it hasn't written it yet */
function readData<T>(name: string): T | null {
  try {
    return JSON.parse(readFileSync(join(dataDir!, name), 'utf-8')) as T
  } catch {
    return null
  }
}

const text = (t: string): { content: { type: 'text'; text: string }[] } => ({ content: [{ type: 'text', text: t }] })

server.registerTool(
  'get_my_tickets',
  {
    description:
      "The user's ServiceNow incidents (assigned to them), as of their last Update tickets in Rowan AIO, not live: " +
      'counts by plan and state, every open ticket with its caller, state, the user’s plan (Now/Next/Later/Waiting), ' +
      'next step, notes and reply flags, then recently closed tickets.',
    inputSchema: {}
  },
  async () => {
    const raw = readData<{
      tickets?: Record<string, Ticket>
      notes?: Record<string, TicketNote>
      me?: string | null
      syncedAt?: string | null
    }>('tickets.json')
    const out = raw
      ? ticketsDigest({
          tickets: Object.values(raw.tickets ?? {}),
          notes: raw.notes ?? {},
          me: raw.me ?? null,
          syncedAt: raw.syncedAt ?? null
        })
      : ''
    return text(out || 'No tickets yet: they come in with Update tickets in Rowan AIO’s Tickets tab.')
  }
)

server.registerTool(
  'get_team_tickets',
  {
    description:
      'Every incident assigned to the RO Operations group, as of the last service report update in Rowan AIO, not live: ' +
      'the open queue by person and state, tickets opened and resolved by week and by month with who resolved them and ' +
      'the median days to resolve, the open tickets one by one, and the last 60 days of resolved tickets.',
    inputSchema: {}
  },
  async () => {
    const raw = readData<{ tickets?: Record<string, TeamTicket>; syncedAt?: string | null; coverageStart?: string | null }>(
      'team-tickets.json'
    )
    const out = raw
      ? teamDigest({
          tickets: Object.values(raw.tickets ?? {}),
          syncedAt: raw.syncedAt ?? null,
          coverageStart: raw.coverageStart ?? null
        })
      : ''
    return text(out || 'No team data yet: it comes in with Update on the service report in Rowan AIO’s Tickets tab.')
  }
)

server.registerTool(
  'get_status_update',
  {
    description:
      'The RO Ops monthly status update email being drafted in Rowan AIO: completed work (new dashboards and updates), ' +
      'in-progress items with their status and target, new requests, the spotlight, and which past months are saved.',
    inputSchema: {}
  },
  async () => {
    const raw = readData<Partial<StatusUpdateData>>('status-update.json')
    return text((raw && statusUpdateDigest(raw)) || 'No status update yet.')
  }
)

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
