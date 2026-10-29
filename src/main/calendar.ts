import ical, { type VEvent } from 'node-ical'
import { getCalendarUrl, getSettings } from './settings'
import { inviteesFromMail } from './mail'
import type { CalendarEvent } from '../shared/types'

// ---------------------------------------------------------------------------
// Read-only calendar connection via a published iCal feed URL (Outlook
// "Publish a calendar" / Google "Secret address in iCal format"). The URL is
// a secret and lives encrypted in settings; the feed is fetched from the main
// process and cached briefly. No credentials, no OAuth, nothing written back.
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 10 * 60 * 1000
/** expansion window around today, wide enough for the month calendar */
const WINDOW_BACK_DAYS = 62
const WINDOW_AHEAD_DAYS = 93

let cache: { events: CalendarEvent[]; fetchedAt: number } | null = null

export function clearCalendarCache(): void {
  cache = null
}

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** some fields come through as objects with a val property depending on the feed */
function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && 'val' in v) return String((v as { val: unknown }).val)
  return ''
}

interface IcsPerson {
  params?: { CN?: string }
  val?: string
}

/** attendee + organizer display names; feeds without attendee data yield [] */
function parseAttendees(ev: VEvent): string[] {
  const raw = (ev as unknown as { attendee?: IcsPerson | IcsPerson[]; organizer?: IcsPerson })
  const people = [
    ...(Array.isArray(raw.attendee) ? raw.attendee : raw.attendee ? [raw.attendee] : []),
    ...(raw.organizer ? [raw.organizer] : [])
  ]
  const seen = new Set<string>()
  const names: string[] = []
  for (const p of people) {
    const name =
      p.params?.CN?.trim() ||
      // fall back to the mailbox name of the email address
      (p.val ?? '').replace(/^mailto:/i, '').split('@')[0].trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    names.push(name)
    if (names.length >= 12) break
  }
  return names
}

const JOIN_RE =
  /https?:\/\/[^\s"<>]*(?:zoom\.us|webex\.com|teams\.microsoft\.com|teams\.live\.com|meet\.google\.com|gotomeeting\.com)[^\s"<>]*/i

function findJoinUrl(...fields: string[]): string | null {
  for (const f of fields) {
    const m = f.match(JOIN_RE)
    if (m) return m[0]
  }
  return null
}

/**
 * Drop events the user told the app to ignore (planning blocks, lunch, …).
 * Case-insensitive substring match on the title, applied on every read so a
 * settings change takes effect without waiting out the feed cache. This is
 * the one gate every consumer passes through — Today, the month calendar,
 * event briefs, the daily recap, the record nudge, and recording
 * auto-titling all read the calendar from here.
 */
function withoutIgnored(events: CalendarEvent[]): CalendarEvent[] {
  const ignores = getSettings().calendarIgnores.map((t) => t.toLowerCase())
  if (ignores.length === 0) return events
  return events.filter((e) => {
    const title = e.title.toLowerCase()
    return !ignores.some((t) => title.includes(t))
  })
}

/** Fetch and expand the connected feed for [today, today + WINDOW_DAYS). */
export async function refreshCalendar(force = false): Promise<CalendarEvent[]> {
  const url = getCalendarUrl()
  if (!url) {
    cache = null
    return []
  }
  if (!force && cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return withoutIgnored(cache.events)
  }

  const res = await fetch(url.replace(/^webcal:\/\//i, 'https://'))
  if (!res.ok) {
    throw new Error(`The calendar feed returned ${res.status}. Check the URL in Settings.`)
  }
  const text = await res.text()
  if (!/BEGIN:VCALENDAR/i.test(text)) {
    throw new Error('That URL did not return a calendar. It should be an iCal (.ics) address.')
  }

  const data = ical.sync.parseICS(text)
  const windowStart = new Date(startOfToday().getTime() - WINDOW_BACK_DAYS * 86400000)
  const windowEnd = new Date(startOfToday().getTime() + WINDOW_AHEAD_DAYS * 86400000)
  const events: CalendarEvent[] = []

  for (const key of Object.keys(data)) {
    const ev = data[key] as VEvent
    if (ev.type !== 'VEVENT' || !ev.start) continue
    const durationMs = Math.max(0, (ev.end?.getTime() ?? ev.start.getTime()) - ev.start.getTime())
    const allDay = ev.datetype === 'date'
    const base = {
      title: asText(ev.summary).trim() || '(untitled)',
      allDay,
      location: asText(ev.location).trim() || null,
      joinUrl: findJoinUrl(asText(ev.location), asText(ev.description), asText((ev as unknown as { url?: unknown }).url)),
      attendees: parseAttendees(ev)
    }

    if (ev.rrule) {
      // expand recurrences, honoring cancelled dates and moved instances
      const recurrences = (ev.recurrences ?? {}) as unknown as Record<string, VEvent>
      const exdate = (ev.exdate ?? {}) as unknown as Record<string, Date>
      const dates = ev.rrule.between(new Date(windowStart.getTime() - durationMs), windowEnd, true)
      for (const raw of dates) {
        let date = raw
        // rrule preserves DTSTART's UTC clock time; realign wall-clock across
        // DST boundaries (recipe from the node-ical documentation)
        if (!allDay && date.getTimezoneOffset() !== ev.start.getTimezoneOffset()) {
          date = new Date(
            date.getTime() - (date.getTimezoneOffset() - ev.start.getTimezoneOffset()) * 60000
          )
        }
        const lookup = date.toISOString().substring(0, 10)
        const override = recurrences[lookup]
        if (!override && exdate[lookup]) continue
        const start = override ? override.start : date
        const dur = override
          ? Math.max(0, (override.end?.getTime() ?? start.getTime()) - start.getTime())
          : durationMs
        const end = new Date(start.getTime() + dur)
        if (end < windowStart || start >= windowEnd) continue
        events.push({
          id: `${ev.uid}:${start.toISOString()}`,
          start: start.toISOString(),
          end: end.toISOString(),
          ...base,
          title: override ? asText(override.summary).trim() || base.title : base.title
        })
      }
    } else {
      const end = new Date(ev.start.getTime() + durationMs)
      if (end < windowStart || ev.start >= windowEnd) continue
      events.push({
        id: `${ev.uid}:${ev.start.toISOString()}`,
        start: ev.start.toISOString(),
        end: end.toISOString(),
        ...base
      })
    }
  }

  events.sort((a, b) => a.start.localeCompare(b.start))
  cache = { events, fetchedAt: Date.now() }
  return withoutIgnored(events)
}

/** Events overlapping a range, for the month calendar. */
export async function getEventsBetween(fromIso: string, toIso: string): Promise<CalendarEvent[]> {
  const events = await refreshCalendar()
  const from = new Date(fromIso)
  const to = new Date(toIso)
  return events.filter((e) => new Date(e.end) > from && new Date(e.start) < to)
}

/** Events overlapping today, for the Today view. */
export async function getTodayEvents(): Promise<CalendarEvent[]> {
  const events = await refreshCalendar()
  const dayStart = startOfToday()
  const dayEnd = new Date(dayStart.getTime() + 86400000)
  return events.filter((e) => new Date(e.end) > dayStart && new Date(e.start) < dayEnd)
}

/**
 * The calendar event a recording most plausibly belongs to: a timed event
 * whose window (with a little slack for joining early) contains the
 * recording's start. Used to title recordings after their calendar event.
 */
export async function findLiveEvent(startedAtIso: string): Promise<CalendarEvent | null> {
  if (!getCalendarUrl()) return null
  const startedAt = new Date(startedAtIso).getTime()
  const SLACK_MS = 10 * 60 * 1000
  let best: CalendarEvent | null = null
  for (const e of await refreshCalendar()) {
    if (e.allDay) continue
    const from = new Date(e.start).getTime() - SLACK_MS
    const to = new Date(e.end).getTime()
    if (startedAt < from || startedAt > to) continue
    // prefer the event whose start is closest to the recording's start
    if (
      !best ||
      Math.abs(new Date(e.start).getTime() - startedAt) <
        Math.abs(new Date(best.start).getTime() - startedAt)
    ) {
      best = e
    }
  }
  return best
}

/**
 * Who's invited to an event: the calendar's own list when it has one,
 * otherwise the invitation email's. Outlook's published calendar link
 * stopped carrying invite lists in 2026 (at most the organizer is left), so
 * for most meetings the names come from the email the inbox flow filed.
 */
export async function inviteesOf(
  event: CalendarEvent
): Promise<{ names: string[]; from: 'calendar' | 'email' | null }> {
  if (event.attendees.length > 1) return { names: event.attendees, from: 'calendar' }
  const mailed = await inviteesFromMail(event.title, event.start).catch(() => [])
  const names = [...new Set([...event.attendees, ...mailed])]
  return { names, from: mailed.length > 0 ? 'email' : names.length > 0 ? 'calendar' : null }
}
