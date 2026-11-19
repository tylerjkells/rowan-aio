import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { getEventsBetween, getTodayEvents } from './calendar'
import { readMailbox } from './mail'
import { listMeetings, readMeeting } from './store'
import { actionRollup, identityContext } from './identity'
import { fetchClickupTasks } from './clickup'
import { getSettings } from './settings'
import { aiChat, aiReady } from './ai'
import { stripDashes, VOICE_RULES } from './voice'
import type { ActionRollupItem, BriefSlot, DailyRecap, MailMessage, RecapMail } from '../shared/types'
import { isListedAction } from '../shared/actions'

// ---------------------------------------------------------------------------
// The day's briefs, pulled together from everything Rowan already holds — the
// calendar feed, the mail bridge, open action items from the library, and
// ClickUp. Three a day, timed by the workday set in Settings:
//
//   morning (workday start)  what happened while you were gone, and what the
//                            day asks of you — covers yesterday onward
//   midday  (noon)           what changed since the morning: meetings held,
//                            new asks, what the afternoon holds
//   close   (end - 30 min)   what the day settled, what follows you to
//                            tomorrow, and tomorrow's first meetings
//
// Each brief replaces the previous one on Today; anything still relevant is
// re-said by the newer brief because every brief is assembled from live state
// at generation time.
//
// Assembly is local and free, so it reruns whenever Today loads. The written
// summary costs a model call, so each slot is generated once — the first time
// its start time has passed — and cached to disk per date and slot. A one-shot
// timer would be no use here: it would fire into a closed app, hence the poll.
// ---------------------------------------------------------------------------

function startOfToday(): Date {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

/** "HH:MM" as minutes past midnight; bad input falls back */
function toMinutes(hhmm: string, fallback: number): number {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm ?? '')
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback
}

const MIDDAY_MINUTES = 12 * 60
/** the close brief lands this long before the workday ends */
const CLOSE_LEAD_MINUTES = 30

const SLOT_LABEL: Record<BriefSlot, string> = {
  morning: 'Morning brief',
  midday: 'Midday brief',
  close: 'End of day brief'
}

/**
 * The slot whose window we are in right now, or null before the workday
 * starts. Slots activate in order and the latest active one wins; a workday
 * that ends before noon simply never reaches midday.
 */
export function currentSlot(now: Date = new Date()): BriefSlot | null {
  const s = getSettings()
  const minutes = now.getHours() * 60 + now.getMinutes()
  const start = toMinutes(s.workdayStart, 8 * 60)
  const closeAt = Math.max(start + 1, toMinutes(s.workdayEnd, 16 * 60 + 30) - CLOSE_LEAD_MINUTES)
  if (minutes >= closeAt) return 'close'
  if (minutes >= Math.min(MIDDAY_MINUTES, closeAt) && minutes >= start) return 'midday'
  if (minutes >= start) return 'morning'
  return null
}

/**
 * What each brief looks back over. Morning reaches into yesterday so
 * overnight mail is never missed; the later briefs cover today only — their
 * job is what changed, not a recap of the recap.
 */
function windowStartFor(slot: BriefSlot): Date {
  return slot === 'morning'
    ? new Date(startOfToday().getTime() - 86_400_000)
    : startOfToday()
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

function writeNarrative(key: string, text: string): void {
  // only the last few days are worth keeping
  const all = readNarratives()
  all[key] = text
  const trimmed = Object.fromEntries(
    Object.entries(all)
      .sort((a, b) => b[0].localeCompare(a[0]))
      .slice(0, 14)
  )
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(recapFile(), JSON.stringify(trimmed, null, 2))
}

/**
 * Phrases that mean a person is waiting on you. A question mark alone is not
 * enough: marketing mail and automated alerts are full of rhetorical ones
 * ("Need help getting started?").
 */
const ASKS = [
  /\b(can|could|would) you\b/i,
  /\bare you able\b/i,
  /\bplease (send|review|confirm|approve|advise|sign|complete|fill|provide|share)\b/i,
  /\blet me know\b/i,
  /\byour (thoughts|approval|input|feedback|sign.?off)\b/i,
  /\b(any update|following up|circling back|checking in|gentle reminder)\b/i,
  /\bby (end of day|eod|cob|monday|tuesday|wednesday|thursday|friday|tomorrow|next week)\b/i,
  /\bneed (this|it|your|you to)\b/i,
  /\bwhen (can|will|would) you\b/i,
  /\bwaiting (on|for) (you|your)\b/i
]

/**
 * Does a person appear to be waiting on an answer?
 *
 * The first version of this was "unread, not obviously a robot, and either
 * containing a question mark or addressed to one recipient". The last clause
 * is true of nearly every email ever sent, so the whole thing collapsed into
 * "unread" and the brief reported an inbox of junk as three things that could
 * not wait. Being wrong here is expensive: a flag that fires on everything
 * gets ignored, and then it fires on the one that mattered too.
 */
function wantsReply(m: MailMessage): boolean {
  if (m.isRead || m.automated) return false
  const text = `${m.subject}\n${m.body}`.slice(0, 4000)
  if (ASKS.some((re) => re.test(text))) return true
  // a direct question from a human, not a subject-line teaser
  return /\?/.test(m.body)
}

/** Mail worth surfacing since the slot's window opened. */
function recentMail(slot: BriefSlot): RecapMail[] {
  const from = windowStartFor(slot).getTime()
  return readMailbox()
    .filter((m) => new Date(m.receivedAt).getTime() >= from)
    .map((m) => ({
      id: m.id,
      subject: m.subject,
      from: m.fromName ?? m.from,
      receivedAt: m.receivedAt,
      external: m.external,
      automated: m.automated,
      needsReply: wantsReply(m)
    }))
}

export async function buildDailyRecap(slotOverride?: BriefSlot): Promise<DailyRecap> {
  const ctx = identityContext()
  const now = new Date()
  const slot = slotOverride ?? currentSlot(now) ?? 'morning'

  const myOpen: ActionRollupItem[] = []
  const recentMeetings: DailyRecap['recentMeetings'] = []
  const from = windowStartFor(slot).getTime()
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
    // your Action items list: what you chose to follow, yours or someone else's
    for (const rollup of actionRollup(m, ctx)) {
      if (isListedAction(rollup)) myOpen.push(rollup)
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

  // the close brief looks ahead so tomorrow's first meeting is no surprise
  let tomorrowEvents: DailyRecap['tomorrowEvents'] = []
  if (slot === 'close') {
    try {
      const t0 = new Date(startOfToday().getTime() + 86_400_000)
      const t1 = new Date(t0.getTime() + 86_400_000)
      tomorrowEvents = (await getEventsBetween(t0.toISOString(), t1.toISOString())).map((e) => ({
        title: e.title,
        start: e.start,
        allDay: e.allDay
      }))
    } catch {
      // calendar unreachable: the rest still stands
    }
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
    slot,
    slotLabel: SLOT_LABEL[slot],
    dateLabel: now.toLocaleDateString(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric'
    }),
    events,
    tomorrowEvents,
    mail: recentMail(slot),
    myOpen: myOpen.slice(0, 20),
    clickupDue,
    recentMeetings,
    // pre-slot briefs written under the old date-only key still show
    narrative:
      readNarratives()[`${today}:${slot}`] ??
      (slot === 'morning' ? (readNarratives()[today] ?? null) : null)
  }
}

/**
 * The current slot's brief as Today wants it: assembled fresh, and written up
 * if the slot has started, nothing is cached yet, and there is a model to
 * write it.
 */
export async function todaysBrief(): Promise<DailyRecap> {
  const recap = await buildDailyRecap()
  if (recap.narrative || currentSlot() === null || !aiReady()) return recap
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
  const slot = currentSlot()
  if (writing || slot === null || !aiReady()) return
  const date = new Date().toISOString().slice(0, 10)
  const cached = readNarratives()
  if (cached[`${date}:${slot}`] || (slot === 'morning' && cached[date])) return
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

const SHARED_RULES = `${VOICE_RULES}

Rules:
- Two or three short paragraphs, plain prose. No headings, no bullet lists, no markdown.
- State only what the facts support. Never invent a meeting, a task, a name, or a deadline.
- Do not manufacture urgency. Only say something is pressing when a stated deadline, an overdue
  date, or an explicit request supports it. If the facts do not say something is urgent, it is not.
- Automated notifications are not work. Do not tell them to reply to one, and do not pad the brief
  by narrating them. Mentioning that the inbox was mostly noise is fine; listing the noise is not.
- Write to them directly ("you"), plainly, the way a good chief of staff would. No cheerleading, no filler.
- If there is genuinely little to say, say so in one line rather than padding it.`

const SYSTEMS: Record<BriefSlot, string> = {
  morning: `You write a short morning brief for one person, from structured facts covering
yesterday, overnight, and the day ahead.

${SHARED_RULES}
- Lead with what needs them today: what wants an answer, what is overdue, what is due next,
  what their calendar does to the time available.
- What happened yesterday matters only where it sets up today. Do not recap for its own sake.`,

  midday: `You write a short midday check-in for one person. They already had a morning brief;
your only job is what changed since then and what the afternoon holds.

${SHARED_RULES}
- Lead with anything new that wants them: fresh asks from this morning's meetings, mail that
  arrived wanting an answer, anything due before the day ends.
- Meetings held this morning matter for what they produced — decisions and new action items —
  not as a diary. One clause each.
- Close with the afternoon: what remains on the calendar and where the open time is.
- If the morning changed nothing, one or two lines is the correct length.`,

  close: `You write a short end-of-day brief for one person, wrapping the day so they can leave
it at the desk.

${SHARED_RULES}
- Open with where the day landed: meetings held and what they produced, in a sentence or two.
- Then what follows them: anything still unanswered that someone asked for today, and what is
  overdue or due tomorrow with their name on it. Be specific, not scolding.
- Close with tomorrow's shape — the first meeting and anything early — so nothing surprises them.
- If the day is clean, say so; a short brief after a full day reads as a reward, not a failure.`
}

/** The written summary over an already-assembled brief. One model call. */
export async function narrateRecap(recap: DailyRecap): Promise<{ ok: boolean; text?: string; error?: string }> {
  try {
    const now = new Date()
    const slot = recap.slot ?? 'morning'
    const lines: string[] = [
      slot === 'morning'
        ? `Today is ${recap.dateLabel}. The facts below cover yesterday, overnight, and today ahead.`
        : slot === 'midday'
          ? `It is midday on ${recap.dateLabel}. The facts below cover today so far and the afternoon ahead.`
          : `The workday on ${recap.dateLabel} is ending. The facts below cover today and tomorrow morning.`,
      ''
    ]

    const fmtTime = (iso: string): string =>
      new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

    if (slot === 'midday') {
      const remaining = recap.events.filter((e) => e.allDay || new Date(e.end).getTime() > now.getTime())
      lines.push(remaining.length ? 'Still on the calendar this afternoon:' : 'The calendar is clear for the rest of the day.')
      for (const e of remaining) {
        lines.push(`- ${e.title} (${e.allDay ? 'all day' : fmtTime(e.start)})${e.attendees.length ? ` with ${e.attendees.join(', ')}` : ''}`)
      }
    } else {
      lines.push(recap.events.length ? 'Meetings today:' : 'Meetings today: none.')
      for (const e of recap.events) {
        const when = e.allDay ? 'all day' : fmtTime(e.start)
        lines.push(`- ${e.title} (${when})${e.attendees.length ? ` with ${e.attendees.join(', ')}` : ''}`)
      }
    }

    const needsReply = recap.mail.filter((m) => m.needsReply)
    const automated = recap.mail.filter((m) => m.automated).length
    lines.push(
      '',
      `Mail since yesterday: ${recap.mail.length} in total, of which ${automated} are automated ` +
        `notifications nobody is waiting on. ${needsReply.length} look like someone is waiting ` +
        `for an answer` + (needsReply.length ? ':' : '.')
    )
    for (const m of needsReply.slice(0, 10)) {
      lines.push(`- "${m.subject}" from ${m.from}`)
    }
    if (!needsReply.length && recap.mail.length) {
      lines.push('Nothing in the inbox is waiting on a reply from you.')
    }

    // items born in today's meetings are news to the later briefs; the rest is standing workload
    const todayIso = recap.date
    const newToday = recap.myOpen.filter((i) => i.createdAt.slice(0, 10) === todayIso)
    if (slot !== 'morning' && newToday.length) {
      lines.push('', 'New action items assigned to you in today\'s meetings:')
      for (const i of newToday.slice(0, 10)) {
        lines.push(`- ${i.task}${i.dueDate ? ` (due ${i.dueDate})` : ''} — from "${i.meetingTitle}"`)
      }
    }
    const standing = slot === 'morning' ? recap.myOpen : recap.myOpen.filter((i) => !newToday.includes(i))
    lines.push('', standing.length ? 'Your open action items:' : 'Your open action items: none.')
    for (const i of standing.slice(0, 12)) {
      lines.push(`- ${i.task}${i.dueDate ? ` (due ${i.dueDate})` : ''} — from "${i.meetingTitle}"`)
    }

    if (recap.recentMeetings.length) {
      lines.push('', slot === 'morning' ? 'Meetings recorded since yesterday:' : 'Meetings recorded today, with what they came to:')
      for (const m of recap.recentMeetings) {
        lines.push(`- ${m.title}${m.tldr ? `: ${m.tldr}` : ''}`)
      }
    }

    if (slot === 'close') {
      lines.push('', recap.tomorrowEvents.length ? 'Tomorrow\'s calendar:' : 'Tomorrow\'s calendar: clear.')
      for (const e of recap.tomorrowEvents.slice(0, 8)) {
        lines.push(`- ${e.title} (${e.allDay ? 'all day' : fmtTime(e.start)})`)
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
      system: SYSTEMS[slot],
      messages: [{ role: 'user', content: lines.join('\n') }]
    })
    const text = stripDashes(result.text.trim())
    if (!text) return { ok: false, error: 'The model came back empty.' }
    writeNarrative(`${recap.date}:${slot}`, text)
    return { ok: true, text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
