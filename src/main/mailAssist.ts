import { app, BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { aiChat, aiReady } from './ai'
import { onMailChanged, readMailbox, readMailTriage } from './mail'
import { readDirectory } from './directory'
import { getMailFolder, getSettings } from './settings'
import { stripDashes, VOICE_RULES } from './voice'
import type {
  MailAssistState,
  MailHandoff,
  MailLevel,
  MailMessage,
  MailSort
} from '../shared/types'

// ---------------------------------------------------------------------------
// Mail assistant. New mail is sorted as it lands: priority, normal or low,
// with a one-line gist of what it wants. When you re-sort something by hand,
// that sticks, and the sender's preference steers later sorting. The handoff
// is the "while you were away" note the Mail tab shows when nothing is open.
//
// Sorting sees the first part of each body only, a few messages per call, so
// it costs cents a day on Haiku. Everything lives in userData/mail-assist.json.
// ---------------------------------------------------------------------------

/** messages per model call */
const BATCH = 8
/** mail older than this is never sorted (first run, or after a long break) */
const WINDOW_DAYS = 3
/** how much of each body the sorter reads */
const BODY_CHARS = 1500
/** sender preferences remembered from your corrections */
const MAX_PREFS = 200
/** the handoff never reaches further back than this */
const HANDOFF_MAX_MS = 3 * 864e5
/** first handoff, before you ever caught up */
const HANDOFF_DEFAULT_MS = 864e5

interface AssistFile {
  sorts: Record<string, MailSort>
  /** sender address -> the level you last gave their mail */
  prefs: Record<string, MailLevel>
  caughtUpAt: string | null
  /** the last handoff lead, reused while the mail it covers is unchanged */
  handoff: { key: string; since: string; lead: string } | null
}

function file(): string {
  return join(app.getPath('userData'), 'mail-assist.json')
}

function load(): AssistFile {
  try {
    const raw = JSON.parse(readFileSync(file(), 'utf8')) as Partial<AssistFile>
    return {
      sorts: raw.sorts && typeof raw.sorts === 'object' ? raw.sorts : {},
      prefs: raw.prefs && typeof raw.prefs === 'object' ? raw.prefs : {},
      caughtUpAt: typeof raw.caughtUpAt === 'string' ? raw.caughtUpAt : null,
      handoff: raw.handoff ?? null
    }
  } catch {
    return { sorts: {}, prefs: {}, caughtUpAt: null, handoff: null }
  }
}

/** Write, dropping sorts for mail that has left the folder. */
function save(data: AssistFile): void {
  const live = new Set(readMailbox().map((m) => m.id))
  for (const id of Object.keys(data.sorts)) if (!live.has(id)) delete data.sorts[id]
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(file(), JSON.stringify(data, null, 2))
}

function enabled(): boolean {
  return getSettings().mailAssistant && aiReady() && !!getMailFolder()
}

let pending = 0
let lastError: string | undefined

export function mailAssistState(): MailAssistState {
  const data = load()
  return {
    enabled: enabled(),
    sorts: data.sorts,
    pending,
    error: lastError,
    caughtUpAt: data.caughtUpAt,
    handoffSince: handoffSince(data.caughtUpAt)
  }
}

function broadcast(): void {
  const state = mailAssistState()
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('mail:assist', state)
}

// ---- sorting ----------------------------------------------------------------

let running = false
let again = false

/** Sort whatever has arrived. Safe to call often; passes never overlap. */
export function kickMailAssist(): void {
  if (running) {
    again = true
    return
  }
  running = true
  sortPending()
    .catch(() => {})
    .finally(() => {
      running = false
      pending = 0
      broadcast()
    })
}

/** start sorting on every folder change, and once now */
export function startMailAssist(): void {
  onMailChanged(kickMailAssist)
  kickMailAssist()
}

async function sortPending(): Promise<void> {
  do {
    again = false
    if (!enabled()) return
    const known = load().sorts
    const handled = readMailTriage().handled
    const cutoff = Date.now() - WINDOW_DAYS * 864e5
    const todo = readMailbox().filter(
      (m) => !known[m.id] && !handled[m.id] && Date.parse(m.receivedAt) >= cutoff
    )
    pending = todo.length
    if (todo.length) broadcast()
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH)
      let results: Map<string, MailSort>
      try {
        results = await sortBatch(batch, load().prefs)
        lastError = undefined
      } catch (err) {
        // no key, offline, rate limited: the next folder change tries again
        lastError = err instanceof Error ? err.message : 'Sorting failed'
        return
      }
      // re-read: you may have re-sorted something while the model worked
      const data = load()
      for (const [id, sort] of results) if (!data.sorts[id]?.mine) data.sorts[id] = sort
      save(data)
      pending = Math.max(0, pending - batch.length)
      broadcast()
    }
  } while (again)
}

const SORT_SCHEMA = {
  type: 'object',
  properties: {
    messages: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          n: { type: 'integer' },
          level: { type: 'string', enum: ['priority', 'normal', 'low'] },
          needs: { type: 'string', enum: ['reply', 'action', 'read', 'none'] },
          gist: { type: 'string' }
        },
        required: ['n', 'level', 'needs', 'gist'],
        additionalProperties: false
      }
    }
  },
  required: ['messages'],
  additionalProperties: false
}

function sortSystem(you: string, prefs: Record<string, MailLevel>): string {
  const byLevel = (level: MailLevel): string[] =>
    Object.entries(prefs)
      .filter(([, l]) => l === level)
      .map(([addr]) => addr)
      .slice(-40)
  const low = byLevel('low')
  const high = byLevel('priority')
  const learned = [
    high.length ? `${you} has marked mail from these senders as priority: ${high.join(', ')}.` : '',
    low.length ? `${you} has marked mail from these senders as low priority: ${low.join(', ')}.` : ''
  ]
    .filter(Boolean)
    .join('\n')

  return `You are ${you}'s executive assistant, sorting their incoming work email so they see what matters first. ${you} works at Rowan University.

For each message decide:
- level:
  "priority" when ${you} personally needs to act or answer soon: a direct question or request to them, a decision or approval, a deadline in the next few days, their leadership, an escalation, an outage, anything time sensitive.
  "low" when nothing is needed from them: newsletters, marketing, automated notifications that need no action, mass announcements, receipts, mail where they are one of many CCs and nothing is asked of them.
  "normal" for everything else.
  When unsure between two levels, pick the less urgent one. Priority should stay rare enough to mean something.
- needs: "reply" if they should answer, "action" if they should do something other than reply, "read" if worth reading but nothing to do, "none" otherwise.
- gist: one plain sentence under 18 words saying what it is and what, if anything, it wants from ${you}, with any deadline. Name the sender only if it matters. No preamble like "This email".
${learned ? `\nWhat ${you} has taught you:\n${learned}\n` : ''}
${VOICE_RULES}

Return one entry per message, using its number as n.`
}

function describe(
  m: MailMessage,
  n: number,
  /** your address and name, lowercased; recipients are stored as either */
  youAs: string[],
  directory: Map<string, string>
): string {
  const who = m.fromName ? `${m.fromName} <${m.from}>` : m.from
  const known = directory.get(m.from.trim().toLowerCase())
  const isYou = (r: string): boolean => youAs.includes(r.trim().toLowerCase())
  const placement = !youAs.length
    ? `To: ${m.to.length} recipient${m.to.length === 1 ? '' : 's'}${m.cc.length ? `, CC: ${m.cc.length}` : ''}`
    : m.to.some(isYou)
      ? `Sent to you${m.to.length > 1 ? ` and ${m.to.length - 1} other${m.to.length === 2 ? '' : 's'}` : ' directly'}${m.cc.length ? `, ${m.cc.length} CC'd` : ''}`
      : m.cc.some(isYou)
        ? `You are CC'd (with ${m.cc.length - 1} others); sent to ${m.to.length}`
        : `You are not on the To or CC line (a list or BCC); ${m.to.length + m.cc.length} recipients`
  const flags = [
    m.automated ? 'sent by a system or no-reply address' : '',
    m.external ? 'from outside Rowan' : '',
    m.importance === 'high' ? 'marked high importance' : '',
    m.hasAttachments ? 'has attachments' : ''
  ].filter(Boolean)
  const body = m.body.replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
  return [
    `Message ${n}`,
    `From: ${who}${known ? ` (${known})` : ''}`,
    placement,
    `Received: ${new Date(m.receivedAt).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`,
    flags.length ? `Notes: ${flags.join('; ')}` : '',
    `Subject: ${m.subject || '(no subject)'}`,
    `Body:\n${body.slice(0, BODY_CHARS)}${body.length > BODY_CHARS ? ' …' : ''}`
  ]
    .filter(Boolean)
    .join('\n')
}

/** directory address -> "Name, Title" so the sorter knows who is who */
function directoryByAddress(): Map<string, string> {
  const map = new Map<string, string>()
  for (const [name, d] of Object.entries(readDirectory())) {
    const addr = d.email?.trim().toLowerCase()
    if (!addr) continue
    map.set(addr, [name, d.title, d.department].filter(Boolean).join(', ') + ', in your directory')
  }
  return map
}

async function sortBatch(
  batch: MailMessage[],
  prefs: Record<string, MailLevel>
): Promise<Map<string, MailSort>> {
  const settings = getSettings()
  const you = settings.yourName.trim() || 'the user'
  const directory = directoryByAddress()
  const yourName = settings.yourName.trim().toLowerCase()
  const yourEmail = yourName
    ? Object.entries(readDirectory())
        .find(([name]) => name.toLowerCase() === yourName)?.[1]
        .email?.trim()
        .toLowerCase()
    : undefined
  const youAs = [yourName, yourEmail].filter((x): x is string => !!x)

  const result = await aiChat({
    maxTokens: 120 * batch.length + 200,
    system: sortSystem(you, prefs),
    messages: [
      {
        role: 'user',
        content: batch.map((m, i) => describe(m, i + 1, youAs, directory)).join('\n\n---\n\n')
      }
    ],
    schema: SORT_SCHEMA,
    schemaName: 'mail_sort'
  })

  const out = new Map<string, MailSort>()
  if (result.stop === 'refusal') {
    // never retry these forever: file them as normal with no gist
    for (const m of batch) out.set(m.id, { level: 'normal', gist: '', needs: 'read' })
    return out
  }
  let parsed: { messages?: { n: number; level: MailLevel; needs: MailSort['needs']; gist: string }[] }
  try {
    parsed = JSON.parse(result.text)
  } catch {
    throw new Error('The sorter returned something unreadable')
  }
  for (const r of parsed.messages ?? []) {
    const m = batch[r.n - 1]
    if (!m || !['priority', 'normal', 'low'].includes(r.level)) continue
    out.set(m.id, {
      level: r.level,
      needs: ['reply', 'action', 'read', 'none'].includes(r.needs) ? r.needs : 'read',
      gist: stripDashes(String(r.gist ?? '')).trim().slice(0, 200)
    })
  }
  return out
}

// ---- your corrections -------------------------------------------------------

/** Re-sort messages by hand. The sender's preference steers future sorting. */
export function setMailLevel(messageIds: string[], level: MailLevel): MailAssistState {
  const data = load()
  const byId = new Map(readMailbox().map((m) => [m.id, m]))
  for (const id of messageIds) {
    const m = byId.get(id)
    if (!m) continue
    const before: MailSort | undefined = data.sorts[id]
    data.sorts[id] = { gist: before?.gist ?? '', needs: before?.needs ?? 'read', level, mine: true }
    const sender = m.from.trim().toLowerCase()
    if (sender) {
      // re-insert so the newest preferences are the ones kept
      delete data.prefs[sender]
      data.prefs[sender] = level
    }
  }
  const senders = Object.keys(data.prefs)
  for (const s of senders.slice(0, Math.max(0, senders.length - MAX_PREFS))) delete data.prefs[s]
  save(data)
  broadcast()
  return mailAssistState()
}

/** You've seen it all: the handoff starts over from now. */
export function markCaughtUp(): MailAssistState {
  const data = load()
  data.caughtUpAt = new Date().toISOString()
  save(data)
  broadcast()
  return mailAssistState()
}

// ---- the handoff ------------------------------------------------------------

function handoffSince(caughtUpAt: string | null): string {
  // the rolling bounds snap to the hour, so the window (and the lead cached
  // for it) holds still between visits instead of moving every millisecond
  const hour = 3_600_000
  const snap = (ms: number): number => Math.floor(ms / hour) * hour
  const floor = snap(Date.now() - HANDOFF_MAX_MS)
  const from = caughtUpAt ? Date.parse(caughtUpAt) : snap(Date.now() - HANDOFF_DEFAULT_MS)
  return new Date(Math.max(floor, from)).toISOString()
}

const LEVEL_ORDER: Record<MailLevel, number> = { priority: 0, normal: 1, low: 2 }

/**
 * The handoff's lead: a few sentences on what came in since you caught up,
 * written from the gists (never the bodies), and kept until that mail changes.
 */
export async function mailHandoff(): Promise<MailHandoff> {
  const data = load()
  const since = handoffSince(data.caughtUpAt)
  if (!enabled()) return { since, lead: '' }
  const handled = readMailTriage().handled
  const items = readMailbox()
    .filter((m) => !handled[m.id] && m.receivedAt > since && data.sorts[m.id])
    .map((m) => ({ m, s: data.sorts[m.id] }))
    .sort((a, b) => LEVEL_ORDER[a.s.level] - LEVEL_ORDER[b.s.level])
  if (items.length === 0) return { since, lead: '' }

  const key = `${since}|${items.map(({ m, s }) => `${m.id}:${s.level}`).sort().join(',')}`
  if (data.handoff?.key === key) return { since, lead: data.handoff.lead }

  const you = getSettings().yourName.trim() || 'the user'
  const lines = items.slice(0, 40).map(
    ({ m, s }) =>
      `[${s.level}${s.needs === 'reply' || s.needs === 'action' ? `, needs ${s.needs}` : ''}] ${m.fromName ?? m.from}: ${s.gist || m.subject}`
  )
  const counts = (['priority', 'normal', 'low'] as const)
    .map((l) => `${items.filter((i) => i.s.level === l).length} ${l}`)
    .join(', ')
  try {
    const result = await aiChat({
      maxTokens: 300,
      system: `You are ${you}'s executive assistant handing over their inbox when they get back to it. Write one to three short sentences, plain and direct, as you would say it across a desk. Lead with what needs them: who wants what, and by when. Then at most one short clause on the rest, if it is worth mentioning. No greeting, no list, no sign-off, and do not repeat the counts back.

${VOICE_RULES}`,
      messages: [
        {
          role: 'user',
          content: `${items.length} new since ${new Date(since).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })} (${counts}):\n${lines.join('\n')}`
        }
      ]
    })
    const lead = result.stop === 'refusal' ? '' : stripDashes(result.text).trim()
    const fresh = load()
    fresh.handoff = { key, since, lead }
    save(fresh)
    return { since, lead }
  } catch (err) {
    return { since, lead: '', error: err instanceof Error ? err.message : 'Could not write the handoff' }
  }
}
