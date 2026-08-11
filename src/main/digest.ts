import { listMeetings, readMeeting } from './store'
import { actionRollup, identityContext, SELF } from './identity'
import type { ActionRollupItem, WeeklyDigest } from '../shared/types'

// ---------------------------------------------------------------------------
// Weekly digest: a Monday-morning review assembled locally from the library —
// last week's meetings, your open items, what's been open too long, and who
// owes what. No model calls.
// ---------------------------------------------------------------------------

const AGING_DAYS = 14

export function buildDigest(): WeeklyDigest {
  const ctx = identityContext()
  const now = new Date()
  const weekAgo = new Date(now.getTime() - 7 * 86400000)
  const agingCutoff = new Date(now.getTime() - AGING_DAYS * 86400000)

  const lastWeekMeetings: WeeklyDigest['lastWeekMeetings'] = []
  const myOpen: ActionRollupItem[] = []
  const aging: ActionRollupItem[] = []
  const byPerson = new Map<string, { name: string; count: number }>()

  for (const entry of listMeetings()) {
    const m = readMeeting(entry.id)
    if (!m) continue

    const created = new Date(m.createdAt)
    if (created >= weekAgo && created <= now) {
      lastWeekMeetings.push({
        id: m.id,
        title: m.title,
        createdAt: m.createdAt,
        durationMs: m.durationMs
      })
    }

    for (const rollup of actionRollup(m, ctx)) {
      if (rollup.done) continue
      if (rollup.owners.includes(SELF)) myOpen.push(rollup)
      for (const owner of rollup.owners) {
        if (owner === SELF) continue
        const key = owner.toLowerCase()
        const entry = byPerson.get(key) ?? { name: owner, count: 0 }
        entry.count++
        byPerson.set(key, entry)
      }
      if (created < agingCutoff) aging.push(rollup)
    }
  }

  const weekLabel = now.toLocaleDateString(undefined, { month: 'long', day: 'numeric' })

  // most urgent first: dated items ascending, undated after
  const byUrgency = (a: ActionRollupItem, b: ActionRollupItem): number =>
    (a.dueDate ?? '9999') < (b.dueDate ?? '9999') ? -1 : 1
  myOpen.sort(byUrgency)
  aging.sort(byUrgency)

  return {
    weekLabel,
    lastWeekMeetings,
    myOpen,
    aging,
    byPerson: [...byPerson.values()].sort((a, b) => b.count - a.count).slice(0, 8)
  }
}
