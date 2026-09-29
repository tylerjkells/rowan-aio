import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CLOSED_RE, extractJson, snDate, str, threadHeads } from './tickets'
import type { TeamDesk, TeamSyncResult, TeamTicket } from '../shared/types'

// ---------------------------------------------------------------------------
// Team service report: every incident assigned to the RO Operations group,
// pasted in from ServiceNow's JSONv2 list, in userData/team-tickets.json.
// Each update merges into what's stored, so history builds past the
// 12 months the list link reaches back.
// ---------------------------------------------------------------------------

interface TeamFile {
  tickets: Record<string, TeamTicket>
  syncedAt: string | null
  coverageStart: string | null
}

function file(): string {
  return join(app.getPath('userData'), 'team-tickets.json')
}

let cache: TeamFile | null = null

function load(): TeamFile {
  if (cache) return cache
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8'))
    cache = { tickets: raw.tickets ?? {}, syncedAt: raw.syncedAt ?? null, coverageStart: raw.coverageStart ?? null }
  } catch {
    cache = { tickets: {}, syncedAt: null, coverageStart: null }
  }
  return cache
}

export function readTeamDesk(): TeamDesk {
  const d = load()
  return { tickets: Object.values(d.tickets), syncedAt: d.syncedAt, coverageStart: d.coverageStart }
}

const isOpen = (t: TeamTicket): boolean => !t.gone && t.active && !CLOSED_RE.test(t.state)

const count = (v: unknown): number => {
  const n = Number(str(v).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

/**
 * When the team first answered the requester: the earliest customer-visible
 * comment by someone on the team, leaving out the caller's own and the
 * opening entry ServiceNow writes as the ticket is created. Only the time is
 * kept, never the text.
 */
function firstReply(r: Record<string, unknown>, team: Set<string>): string {
  const caller = str(r.caller_id)
  const opened = Date.parse(snDate(r.opened_at))
  let first = Infinity
  for (const h of threadHeads(str(r.comments_and_work_notes) || str(r.comments))) {
    if (h.kind !== 'comment' || h.who === caller || !team.has(h.who)) continue
    const t = Date.parse(h.at)
    if (!Number.isFinite(t) || (Number.isFinite(opened) && t - opened < 120e3)) continue
    if (t < first) first = t
  }
  return Number.isFinite(first) ? new Date(first).toISOString() : ''
}

function fromRecord(r: Record<string, unknown>, team: Set<string>): TeamTicket {
  const state = str(r.state) || str(r.incident_state)
  const active = str(r.active) === 'true'
  const done = !active || CLOSED_RE.test(state)
  const code = str(r.close_code)
  const t: TeamTicket = {
    number: str(r.number),
    sysId: str(r.sys_id),
    title: str(r.short_description),
    caller: str(r.caller_id),
    assignee: str(r.assigned_to),
    state,
    active,
    openedAt: snDate(r.opened_at),
    closedAt: done ? snDate(r.closed_at) || snDate(r.resolved_at) : '',
    updatedAt: snDate(r.sys_updated_on),
    type: str(r.u_incident_item),
    channel: str(r.contact_type)
  }
  // a paste from a link that leaves these out keeps them unknown, not zero
  if ('resolved_at' in r) {
    t.resolvedAt = done ? snDate(r.resolved_at) : ''
    t.resolvedBy = done ? str(r.resolved_by) : ''
    t.closeCode = done && code !== 'None' ? code : ''
  }
  if ('reopen_count' in r) t.reopens = count(r.reopen_count)
  if ('reassignment_count' in r) t.reassignments = count(r.reassignment_count)
  if ('u_status_inquiries' in r) t.inquiries = count(r.u_status_inquiries)
  if ('comments_and_work_notes' in r || 'comments' in r) t.firstReplyAt = firstReply(r, team)
  return t
}

const same = (a: TeamTicket, b: TeamTicket): boolean => JSON.stringify(a) === JSON.stringify(b)

export function applyTeamPaste(text: string): TeamSyncResult {
  let parsed: unknown
  try {
    parsed = extractJson(text ?? '')
  } catch (err) {
    return { ok: false, error: (err as Error).message }
  }
  const recs = Array.isArray(parsed) ? parsed : (parsed as { records?: unknown })?.records
  if (!Array.isArray(recs)) return { ok: false, error: 'No records found. Use the JSONv2 link.' }
  const records = recs.filter(
    (r): r is Record<string, unknown> => !!r && typeof r === 'object' && !!str(r.number) && !!str(r.opened_at)
  )
  if (records.length && /^[0-9a-f]{32}$/.test(str(records[0].caller_id))) {
    return { ok: false, error: 'Names came through as IDs. The link needs &displayvalue=true.' }
  }

  const d = load()
  // the team is whoever has had tickets assigned or has resolved them, so a
  // colleague copied in on a thread doesn't count as the team replying
  const team = new Set<string>()
  for (const r of records) for (const who of [str(r.assigned_to), str(r.resolved_by)]) if (who) team.add(who)
  for (const t of Object.values(d.tickets)) if (t.assignee) team.add(t.assignee)
  const incoming = records.map((r) => fromRecord(r, team))
  const inSet = new Set(incoming.map((t) => t.number))
  let added = 0
  let changed = 0
  let left = 0
  for (const t of incoming) {
    const old = d.tickets[t.number]
    if (!old) added++
    else if (!same(old, t)) changed++
    d.tickets[t.number] = t
  }
  // a paste with open tickets in it is the whole open queue: anything we still
  // hold as open that isn't in it has been moved out of the group
  if (incoming.some(isOpen)) {
    for (const t of Object.values(d.tickets)) {
      if (isOpen(t) && !inSet.has(t.number)) {
        d.tickets[t.number] = { ...t, gone: true }
        left++
      }
    }
  }

  // the list link reaches back to the start of the month a year ago; history
  // only ever widens, so an older coverage start is kept
  const now = new Date()
  const assumed = new Date(now.getFullYear(), now.getMonth() - 12, 1)
  const earliest = incoming.reduce((a, t) => {
    const o = t.openedAt ? new Date(t.openedAt) : null
    return o && o < a ? o : a
  }, now)
  let coverage = assumed > earliest ? assumed : earliest
  if (d.coverageStart && new Date(d.coverageStart) < coverage) coverage = new Date(d.coverageStart)
  d.coverageStart = coverage.toISOString()
  d.syncedAt = now.toISOString()

  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(d))
  return { ok: true, desk: readTeamDesk(), summary: { count: incoming.length, added, changed, left } }
}
