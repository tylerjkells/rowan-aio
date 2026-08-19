import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getTodayEvents } from './calendar'
import { readMailbox } from './mail'
import { listMeetings, readMeeting } from './store'
import { actionRollup, identityContext, SELF } from './identity'
import { fetchClickupTasks } from './clickup'
import { getSettings } from './settings'
import { aiChat, aiReady } from './ai'
import { stripDashes, VOICE_RULES } from './voice'
import type { ActionRollupItem, DailyRecap, RecapMail } from '../shared/types'

// ---------------------------------------------------------------------------
// Morning brief: the day pulled together from everything Rowan already holds —
// the calendar feed, the mail bridge, open action items from the library, and
// ClickUp.
//
// Morning rather than evening, because an end-of-day summary only tells you
// what you already lived through, while a morning one tells you what to do and
// catches whatever landed overnight. The window is therefore yesterday plus
// today so far, not today alone.
//
// Assembly is local and free, so it reruns whenever Today loads. The written
// summary costs a model call, so it is generated once a day — the first time
// the app is opened past BRIEF_HOUR — and cached to disk for that date. A
// timer would be no use here: it would fire into a closed app.
// ---------------------------------------------------------------------------

/** no brief before this hour: at 6am there is nothing to say yet */
const BRIEF_HOUR = 8

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** the brief covers yesterday onward, so overnight mail is never missed */
function windowStart(): Date {
  return new Date(startOfToday().getTime() - 86_400_000)
}

// --- narrative cache: one written brief per date, kept on disk -------------

function recapFile(): string {
  return join(app.getPath('userData'), 'recap.json')
}

function readNarratives(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(recapFile(), 'utf8'))
  } catch {
    return {}
  }
}

function writeNarrative(date: string, text: string): void {
  // only the last few days are worth keeping
  const all = readNarratives()
  all[date] = text
  const trimmed = Object.fromEntries(
    Object.entries(all)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 14)
  )
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(recapFile(), JSON.stringify(trimmed, null, 2))
}

/** senders that never want an answer */
const NO_REPLY = /(^|[.@])(no-?reply|do-?not-?reply|notifications?|alerts?|mailer)([.@]|$)/i

/**
 * Mail worth surfacing since yesterday, with a rough "this one wants an
 * answer" flag. Deliberately crude — unread, from a human, and either asking
 * something or addressed to you alone.
 */
function recentMail(): RecapMail[] {
  const from = windowStart().getTime()
  return readMailbox()
    .filter((m) => new Date(m.receivedAt).getTime() >= from)
    .map((m) => ({
      id: m.id,
      subject: m.subject,
      from: m.fromName ?? m.from,
      receivedAt: m.receivedAt,
      external: m.external,
      needsReply:
        !m.isRead &&
        !NO_REPLY.test(m.from) &&
        (/\?/.test(m.body) || m.to.length <= 1)
    }))
}

export async function buildDailyRecap(): Promise<DailyRecap> {
  const ctx = identityContext()
  const now = new Date()

  const myOpen: ActionRollupItem[] = []
  const recentMeetings: DailyRecap['recentMeetings'] = []
  const from = windowStart().getTime()
  for (const entry of listMeetings()) {
    const m = readMeeting(entry.id)
    if (!m) continue
    if (new Date(m.createdAt).getTime() >= from) {
      recentMeetings.push({
        id: m.id,
        title: m.title,
        createdAt: m.createdAt,
        tldr: m.summary?.tldr ?? null
      })
    }
    for (const rollup of actionRollup(m, ctx)) {
      if (rollup.done) continue
      if (rollup.owners.includes(SELF)) myOpen.push(rollup)
    }
  }
  myOpen.sort((a, b) => (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : 1)

  let events: DailyRecap['events'] = []
  try {
    events = (await getTodayEvents()).map((e) => ({
      title: e.title,
      start: e.start,
      end: e.end,
      allDay: e.allDay,
      attendees: e.attendees
    }))
  } catch {
    // calendar unreachable: the rest of the recap still stands
  }

  const today = now.toISOString().slice(0, 10)
  let clickupDue: DailyRecap['clickupDue'] = []
  if (getSettings().hasClickup) {
    try {
      clickupDue = (await fetchClickupTasks('mine'))
        .filter((t) => t.dueDate && t.dueDate <= today)
        .map((t) => ({ name: t.name, dueDate: t.dueDate!, listName: t.listName, url: t.url }))
    } catch {
      // ClickUp unreachable: same
    }
  }

  return {
    date: today,
    dateLabel: now.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    }),
    events,
    mail: recentMail(),
    myOpen: myOpen.slice(0, 20),
    clickupDue,
    recentMeetings,
    narrative: readNarratives()[today] ?? null
  }
}

/**
 * The brief as Today wants it: assembled fresh, and written up if the day has
 * started, nothing is cached yet, and there is a model to write it.
 */
export async function todaysBrief(): Promise<DailyRecap> {
  const recap = await buildDailyRecap()
  if (recap.narrative || new Date().getHours() < BRIEF_HOUR || !aiReady()) return recap
  if (writing) return recap
  writing = true
  try {
    const result = await narrateRecap(recap)
    if (result.ok && result.text) return { ...recap, narrative: result.text }
  } finally {
    writing = false
  }
  return recap
}

/** guard against two windows racing to generate the same day's brief */
let writing = false

// ---------------------------------------------------------------------------
// Always-open watch: todaysBrief() only runs when Today is opened, which is no
// use to an app that never gets closed — left running overnight it would sit
// on yesterday's brief forever. So poll as well: once the clock passes
// BRIEF_HOUR and the date has no brief yet, write one and tell the windows.
// ---------------------------------------------------------------------------

const CHECK_MS = 10 * 60 * 1000
let timer: NodeJS.Timeout | null = null

async function checkBrief(): Promise<void> {
  if (writing || new Date().getHours() < BRIEF_HOUR || !aiReady()) return
  const date = new Date().toISOString().slice(0, 10)
  if (readNarratives()[date]) return
  writing = true
  try {
    const recap = await buildDailyRecap()
    const result = await narrateRecap(recap)
    if (result.ok) {
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send('recap:updated')
    }
  } catch {
    // a failed brief is not worth surfacing; the next check retries
  } finally {
    writing = false
  }
}

export function startBriefWatch(): void {
  if (timer) clearInterval(timer)
  // an interval also covers waking from sleep, which fires it on the next tick
  timer = setInterval(() => void checkBrief(), CHECK_MS)
  void checkBrief()
}

const SYSTEM = `You write a short morning brief for one person, from structured facts covering
yesterday, overnight, and the day ahead.

${VOICE_RULES}

Rules:
- Two or three short paragraphs, plain prose. No headings, no bullet lists, no markdown.
- Lead with what needs them today: what wants an answer, what is overdue, what is due next,
  what their calendar does to the time available.
- What happened yesterday matters only where it sets up today. Do not recap for its own sake.
- State only what the facts support. Never invent a meeting, a task, a name, or a deadline.
- Write to them directly ("you"), plainly, the way a good chief of staff would. No cheerleading, no filler.
- If it is genuinely a quiet day, say so in one line rather than padding it.`

/** The written summary over an already-assembled brief. One model call. */
export async function narrateRecap(recap: DailyRecap): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const lines: string[] = [
      `Today is ${recap.dateLabel}. The facts below cover yesterday, overnight, and today ahead.`,
      ''
    ]

    lines.push(recap.events.length ? 'Meetings today:' : 'Meetings today: none.')
    for (const e of recap.events) {
      const when = e.allDay
        ? 'all day'
        : new Date(e.start).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
      lines.push(`- ${e.title} (${when})${e.attendees.length ? ` with ${e.attendees.join(', ')}` : ''}`)
    }

    const needsReply = recap.mail.filter((m) => m.needsReply)
    lines.push(
      '',
      `Mail since yesterday: ${recap.mail.length} in, ${needsReply.length} looking like they want a reply.`
    )
    for (const m of needsReply.slice(0, 10)) {
      lines.push(`- "${m.subject}" from ${m.from}`)
    }

    lines.push('', recap.myOpen.length ? 'Your open action items:' : 'Your open action items: none.')
    for (const i of recap.myOpen.slice(0, 12)) {
      lines.push(`- ${i.task}${i.dueDate ? ` (due ${i.dueDate})` : ''} — from "${i.meetingTitle}"`)
    }

    if (recap.recentMeetings.length) {
      lines.push('', 'Meetings recorded since yesterday:')
      for (const m of recap.recentMeetings) {
        lines.push(`- ${m.title}${m.tldr ? `: ${m.tldr}` : ''}`)
      }
    }

    if (recap.clickupDue.length) {
      lines.push('', 'ClickUp tasks due or overdue:')
      for (const t of recap.clickupDue.slice(0, 12)) {
        lines.push(`- ${t.name} (due ${t.dueDate}, ${t.listName})`)
      }
    }

    const result = await aiChat({
      maxTokens: 800,
      system: SYSTEM,
      messages: [{ role: 'user', content: lines.join('\n') }]
    })
    const text = stripDashes(result.text.trim())
    if (!text) return { ok: false, error: 'The model came back empty.' }
    writeNarrative(recap.date, text)
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
