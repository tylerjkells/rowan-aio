import { listMeetings, readMeeting } from './store'
import { getSettings } from './settings'
import { actionRollup, identityContext, resolveOwners, SELF, type IdentityContext } from './identity'
import type {
  Meeting,
  PersonMeetingRef,
  PersonProfile,
  PersonSummary
} from '../shared/types'

// ---------------------------------------------------------------------------
// Person pages: everything the library knows about one colleague, assembled
// from data that already exists — action-item owners, calendar attendees,
// named speakers, and the team directory. Names run through identity
// resolution so "Carol", "Carol Primas-Young", and "Carol (probably)" are one
// person. No model calls.
// ---------------------------------------------------------------------------

/** canonical names of everyone associated with a meeting (excluding the user) */
function meetingPeople(m: Meeting, ctx: IdentityContext): string[] {
  const raw: string[] = []
  for (const a of m.attendees ?? []) raw.push(a)
  if (m.speakerNames?.them) raw.push(m.speakerNames.them)
  for (const item of m.summary?.actionItems ?? []) {
    if (item.owner) raw.push(item.owner)
  }
  const seen = new Set<string>()
  const out: string[] = []
  for (const name of raw.flatMap((n) => resolveOwners(n, ctx))) {
    const key = name.toLowerCase()
    if (name === SELF || seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

export function listPeople(): PersonSummary[] {
  const ctx = identityContext()
  const byKey = new Map<string, PersonSummary>()
  const add = (name: string): PersonSummary => {
    const key = name.toLowerCase()
    let entry = byKey.get(key)
    if (!entry) {
      entry = { name, meetingCount: 0, openItems: 0 }
      byKey.set(key, entry)
    }
    return entry
  }

  // directory members always appear, even before any meetings
  for (const name of getSettings().people) {
    for (const resolved of resolveOwners(name, ctx)) {
      if (resolved !== SELF) add(resolved)
    }
  }

  for (const listItem of listMeetings()) {
    const m = readMeeting(listItem.id)
    if (!m) continue
    for (const name of meetingPeople(m, ctx)) {
      add(name).meetingCount++
    }
    for (const item of actionRollup(m, ctx)) {
      if (item.done) continue
      for (const owner of item.owners) {
        if (owner !== SELF) add(owner).openItems++
      }
    }
  }

  return [...byKey.values()].sort(
    (a, b) => b.openItems - a.openItems || b.meetingCount - a.meetingCount || a.name.localeCompare(b.name)
  )
}

export function personProfile(name: string): PersonProfile | null {
  const ctx = identityContext()
  const canonical = resolveOwners(name, ctx)[0]
  if (!canonical || canonical === SELF) return null
  const key = canonical.toLowerCase()

  const meetings: PersonMeetingRef[] = []
  const items: PersonProfile['items'] = []
  const myCommitments: PersonProfile['myCommitments'] = []

  for (const listItem of listMeetings()) {
    const m = readMeeting(listItem.id)
    if (!m) continue
    const together = meetingPeople(m, ctx).some((p) => p.toLowerCase() === key)
    if (!together) continue

    meetings.push({
      id: m.id,
      title: m.title,
      createdAt: m.createdAt,
      tldr: m.summary?.tldr
    })

    for (const rollup of actionRollup(m, ctx)) {
      if (rollup.owners.some((o) => o.toLowerCase() === key)) items.push(rollup)
      else if (rollup.owners.includes(SELF) && !rollup.done) myCommitments.push(rollup)
    }
  }

  return { name: canonical, meetings, items, myCommitments }
}
