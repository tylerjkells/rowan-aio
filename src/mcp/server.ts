/**
 * MeetingScribe MCP server: exposes the local meeting library to MCP clients
 * (Claude Desktop and friends) as read-only tools, so Claude can answer
 * questions about meetings, build reports from them, or push tasks to other
 * connected tools (e.g. ClickUp) — with the data never leaving the machine
 * except in the conversations the user chooses to have.
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
    attendees: m.attendees ?? []
  }
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
      'List meetings in the MeetingScribe library, newest first. Each entry has id, title, date, duration, TL;DR, and attendees.',
    inputSchema: {
      limit: z.number().int().min(1).max(200).optional().describe('Max results (default 25)')
    }
  },
  async ({ limit }) => ({
    content: [
      {
        type: 'text',
        text: JSON.stringify(allMeetings().slice(0, limit ?? 25).map(meetingCard), null, 2)
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
      'Full-text search across meeting titles, summaries, notes, and transcripts. Every word in the query must appear somewhere in a meeting for it to match.',
    inputSchema: {
      query: z.string().describe('Words to search for'),
      limit: z.number().int().min(1).max(50).optional()
    }
  },
  async ({ query, limit }) => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    const hits: Record<string, unknown>[] = []
    for (const m of allMeetings()) {
      const haystack = [
        m.title,
        m.notes ?? '',
        m.summary ? JSON.stringify(m.summary) : '',
        (m.transcript ?? []).map((s) => s.text).join(' ')
      ]
        .join(' ')
        .toLowerCase()
      if (words.every((w) => haystack.includes(w))) hits.push(meetingCard(m))
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

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport())
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
