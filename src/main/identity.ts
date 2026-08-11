import { getSettings } from './settings'
import { parseDueDate } from '../shared/dates'
import type { ActionItem, ActionRollupItem, Meeting } from '../shared/types'

// ---------------------------------------------------------------------------
// Person identity resolution. Owner names arrive as free text from the
// summarizer ("Carol", "David and Melissa", "Aliza (or team member assigned)",
// "Me (implied Tyler/implementer)") and the same person shows up under many
// spellings. Everything the app shows — the Action items rollup, the People
// page, per-person filters — resolves raw strings to canonical names here,
// at read time, so historical data cleans up without rewriting any meeting
// files. Canonical names come from the team directory in Settings; "Me" is
// the canonical name for the user.
// ---------------------------------------------------------------------------

/** everything resolution needs, loaded once per request */
export interface IdentityContext {
  /** clean directory entries (compound junk excluded), original spellings */
  directory: string[]
  /** normalized user's own name, '' when unset */
  yourName: string
  /** normalized raw name -> canonical display name (user-made merges) */
  aliases: Record<string, string>
}

export const SELF = 'Me'

function norm(s: string): string {
  return s.trim().toLowerCase()
}

/** strings that look like a person but aren't one */
const NON_NAMES = new Set([
  'me', 'them', 'i', 'myself', 'we', 'us', 'everyone', 'all', 'team', 'anyone',
  'the team', 'tbd', 'tba', 'unassigned', 'n/a', 'none', 'unknown'
])
const SELF_NAMES = new Set(['me', 'i', 'myself'])

/** common short forms, applied only when matching first names against the directory */
const NICKNAMES: Record<string, string[]> = {
  dave: ['david'], davey: ['david'],
  mike: ['michael'], micky: ['michael'],
  bill: ['william'], billy: ['william'], will: ['william'], liam: ['william'],
  bob: ['robert'], rob: ['robert'], bobby: ['robert'], robbie: ['robert'],
  jim: ['james'], jimmy: ['james'], jamie: ['james'],
  steph: ['stephanie', 'stephen'], steve: ['steven', 'stephen'],
  chris: ['christopher', 'christina', 'christine'],
  matt: ['matthew'], tom: ['thomas', 'tomas'], tommy: ['thomas'],
  tony: ['anthony'], drew: ['andrew'], andy: ['andrew'],
  dan: ['daniel'], danny: ['daniel'], nate: ['nathan', 'nathaniel'],
  ben: ['benjamin'], sam: ['samuel', 'samantha'], alex: ['alexander', 'alexandra'],
  nick: ['nicholas'], joe: ['joseph'], joey: ['joseph'],
  kate: ['katherine', 'kathryn'], katie: ['katherine', 'kathryn'], kathy: ['katherine', 'kathryn'],
  liz: ['elizabeth'], beth: ['elizabeth'], jen: ['jennifer'], jenn: ['jennifer'], jenny: ['jennifer'],
  meg: ['megan', 'margaret'], maggie: ['margaret'], peg: ['margaret'],
  pat: ['patrick', 'patricia'], trish: ['patricia'],
  rick: ['richard'], rich: ['richard'], dick: ['richard'],
  ed: ['edward'], eddie: ['edward'], ted: ['theodore', 'edward'],
  greg: ['gregory'], jeff: ['jeffrey'], josh: ['joshua'],
  ken: ['kenneth'], kenny: ['kenneth'], ron: ['ronald'], ronnie: ['ronald'],
  don: ['donald'], donny: ['donald'], tim: ['timothy'], timmy: ['timothy'],
  vicky: ['victoria'], vick: ['victoria'], sue: ['susan'], suzie: ['susan'],
  deb: ['deborah', 'debra'], debbie: ['deborah', 'debra'],
  nat: ['natalie', 'nathan'], mel: ['melissa', 'melanie'], carol: ['caroline', 'carolyn']
}

/** looks like several people or a hedge, not one name */
function isCompound(s: string): boolean {
  return /[()&+/,]|\b(and|or)\b/i.test(s)
}

export function identityContext(): IdentityContext {
  const s = getSettings()
  return {
    directory: s.people.filter((p) => !isCompound(p)),
    yourName: norm(s.yourName),
    aliases: s.personAliases
  }
}

/** drop parenthetical qualifiers: "Aliza (or team member assigned)" -> "Aliza" */
function stripParenthetical(raw: string): string {
  return raw.replace(/\s*\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim()
}

/** split compound owners: "David and Melissa", "Carol or Aliza", "A / B" */
function splitCompound(text: string): string[] {
  return text
    .split(/\s+(?:and|or)\s+|\s*[,&+/]\s*/i)
    .map((p) => p.trim())
    .filter(Boolean)
}

/** directory entries whose first name is one of the given keys */
function byFirstName(keys: string[], directory: string[]): string[] {
  return directory.filter((p) => keys.includes(norm(p).split(/\s+/)[0]))
}

/** resolve one person-ish string to a canonical display name, or null for non-names */
function resolveOne(part: string, ctx: IdentityContext): string | null {
  const key = norm(part)
  if (!key) return null
  if (SELF_NAMES.has(key)) return SELF
  if (NON_NAMES.has(key)) return null

  // user-made merges win over everything
  const alias = ctx.aliases[key]
  if (alias) return norm(alias) === 'me' ? SELF : alias

  // the user's own name (full or first) is Me
  if (ctx.yourName) {
    const yourFirst = ctx.yourName.split(/\s+/)[0]
    if (key === ctx.yourName || key === yourFirst) return SELF
  }

  // exact directory match keeps the directory's spelling
  const exact = ctx.directory.find((p) => norm(p) === key)
  if (exact) return exact

  // "Carol" -> "Carol Primas-Young" when exactly one directory entry fits.
  // An exact first-name match beats nickname expansion ("Carol" must not
  // drift to "Caroline"); ambiguity leaves the name alone.
  if (!part.includes(' ')) {
    const exactFirst = byFirstName([key], ctx.directory)
    if (exactFirst.length === 1) return exactFirst[0]
    if (exactFirst.length === 0) {
      const viaNickname = byFirstName(NICKNAMES[key] ?? [], ctx.directory)
      if (viaNickname.length === 1) return viaNickname[0]
    }
  } else {
    // "Carol Primas" -> "Carol Primas-Young"; "Vijay Kumar" -> "Vijay"
    const starts = ctx.directory.filter(
      (p) => norm(p).startsWith(key) || key.startsWith(norm(p) + ' ')
    )
    if (starts.length === 1) return starts[0]
  }

  // an unknown but plausible name stands on its own
  return part.trim()
}

/**
 * Resolve a raw owner string into canonical people. Compounds credit each
 * person named; pure hedges ("TBD", "the team") resolve to nobody.
 */
export function resolveOwners(raw: string | null | undefined, ctx: IdentityContext): string[] {
  if (!raw?.trim()) return []
  let text = stripParenthetical(raw)
  // "(everything was parenthetical)" — try the inside instead of nothing
  if (!text) text = raw.replace(/[()]/g, ' ').replace(/\s+/g, ' ').trim()
  const out: string[] = []
  const seen = new Set<string>()
  for (const part of splitCompound(text)) {
    const resolved = resolveOne(part, ctx)
    if (!resolved || seen.has(norm(resolved))) continue
    seen.add(norm(resolved))
    out.push(resolved)
  }
  return out
}

/** one meeting's action items as rollup rows, identities resolved */
export function actionRollup(m: Meeting, ctx: IdentityContext): ActionRollupItem[] {
  if (!m.summary) return []
  return m.summary.actionItems.map((a: ActionItem, index: number) => ({
    meetingId: m.id,
    meetingTitle: m.title,
    createdAt: m.createdAt,
    index,
    task: a.task,
    owner: a.owner,
    due: a.due,
    done: a.done ?? false,
    dueDate: a.dueDate ?? parseDueDate(a.due, m.createdAt) ?? undefined,
    dueEdited: !!a.dueDate,
    owners: resolveOwners(a.owner, ctx)
  }))
}
