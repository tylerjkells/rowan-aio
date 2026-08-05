import { listMeetings, readMeeting } from './store'
import { actionRollup, identityContext } from './identity'
import type { ActionRollupItem, SeriesData } from '../shared/types'

// ---------------------------------------------------------------------------
// Meeting series: meetings sharing a title form a thread. Recordings inherit
// their calendar event's title, so recurring meetings self-assemble; renaming
// a meeting to match is the manual way in. All local, no model calls.
// ---------------------------------------------------------------------------

function norm(title: string): string {
  return title.trim().toLowerCase()
}

/** ids of the other meetings sharing this meeting's title */
export function seriesSiblings(meetingId: string): string[] {
  const target = readMeeting(meetingId)
  if (!target) return []
  const key = norm(target.title)
  return listMeetings()
    .filter((m) => m.id !== meetingId && norm(m.title) === key)
    .map((m) => m.id)
}

/** the full thread for a title: occurrences, decisions by date, open items */
export function seriesData(title: string): SeriesData {
  const ctx = identityContext()
  const key = norm(title)
  const occurrences: SeriesData['occurrences'] = []
  const decisions: SeriesData['decisions'] = []
  const openActions: ActionRollupItem[] = []
  let display = title.trim()

  for (const entry of listMeetings()) {
    if (norm(entry.title) !== key) continue
    const m = readMeeting(entry.id)
    if (!m) continue
    display = m.title
    occurrences.push({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      durationMs: m.durationMs,
      tldr: m.summary?.tldr
    })
    if (m.summary && m.summary.decisions.length > 0) {
      decisions.push({ meetingId: m.id, createdAt: m.createdAt, items: m.summary.decisions })
    }
    for (const rollup of actionRollup(m, ctx)) {
      if (!rollup.done) openActions.push(rollup)
    }
  }

  return { title: display, occurrences, decisions, openActions }
}
