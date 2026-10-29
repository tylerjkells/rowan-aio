import { app, BrowserWindow } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  writeFileSync,
  type FSWatcher
} from 'fs'
import { open, readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { getMailFolder } from './settings'
import { readDirectory } from './directory'
import type { MailFiledDraft, MailMessage, MailStatus, MailTriage } from '../shared/types'

// ---------------------------------------------------------------------------
// Mail bridge: Rowan never talks to Exchange. A Power Automate flow drops one
// JSON file per message into a OneDrive folder, the OneDrive client syncs it
// to disk, and this module reads that folder. No tokens, no OAuth, no admin
// consent — see docs/OUTLOOK.md for why that is the only route open to us.
//
// The flow writes the connector's whole message object verbatim, so the field
// names are whatever Microsoft happens to use that week. Everything below
// parses defensively and accepts both the flat connector shape ("from" as a
// plain address string) and the Graph shape (from.emailAddress.address).
// ---------------------------------------------------------------------------

/** newest files parsed per read; the folder itself may hold far more */
const MAX_MESSAGES = 300

export function mailInDir(): string | null {
  const root = getMailFolder()
  return root ? join(root, 'in') : null
}

export function mailOutDir(): string | null {
  const root = getMailFolder()
  return root ? join(root, 'out') : null
}

function asText(v: unknown): string {
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return ''
}

/** "Tyler Kells <kellst@rowan.edu>", a bare address, or the Graph object */
function asPerson(v: unknown): { name: string | null; address: string } {
  if (typeof v === 'string') {
    const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/)
    if (m) return { name: m[1].trim() || null, address: m[2].trim() }
    return { name: null, address: v.trim() }
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    // Graph nests it one deeper under emailAddress
    if (o.emailAddress) return asPerson(o.emailAddress)
    const address = asText(o.address ?? o.Address ?? o.email)
    const name = asText(o.name ?? o.Name).trim()
    return { name: name || null, address }
  }
  return { name: null, address: '' }
}

/** recipients arrive as an array, or as one semicolon-delimited string */
function asPeople(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === 'string' ? v.split(';') : []
  return raw
    .map((r) => {
      const p = asPerson(r)
      return p.name ?? p.address
    })
    .map((s) => s.trim())
    .filter(Boolean)
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  '#39': "'"
}

/** good-enough HTML flattening: mail bodies only ever get read, never rendered */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<\/(p|div|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#?\w+);/g, (whole, code: string) => ENTITIES[code.toLowerCase()] ?? whole)
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function looksHtml(s: string): boolean {
  return /<(p|div|br|table|span|a)\b|<\/\w+>/i.test(s)
}

/** address -> directory display name, so colleagues read as people not mailboxes */
let addressBook: { at: number; map: Map<string, string> } | null = null

function nameForAddress(address: string): string | null {
  const key = address.trim().toLowerCase()
  if (!key) return null
  if (!addressBook || Date.now() - addressBook.at > 60_000) {
    const map = new Map<string, string>()
    for (const [name, details] of Object.entries(readDirectory())) {
      const email = details.email?.trim().toLowerCase()
      if (email) map.set(email, name)
    }
    addressBook = { at: Date.now(), map }
  }
  return addressBook.map.get(key) ?? null
}

/**
 * The connector hands us `from` as a bare address, but the raw From header
 * carries the sender's display name — worth reading when the flow is still
 * shipping headers.
 */
function nameFromHeaders(raw: unknown): string | null {
  if (!Array.isArray(raw)) return null
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue
    const entry = h as { name?: unknown; value?: unknown }
    if (String(entry.name).toLowerCase() !== 'from') continue
    return asPerson(asText(entry.value)).name
  }
  return null
}

/**
 * Whether a message came from a machine. Mail standards make this knowable
 * rather than guessable: bulk senders are required to advertise themselves
 * through List-Unsubscribe, Auto-Submitted, and Precedence, so the headers
 * settle it without any judgement about the content.
 *
 * The address check is only a fallback for when headers are unavailable, and
 * it deliberately matches anywhere in the string: the first version anchored
 * "noreply" to a word boundary and sailed straight past
 * PowerAutomateNoReply@microsoft.com.
 */
function isAutomated(rawHeaders: unknown, address: string): boolean {
  if (/no-?reply|do-?not-?reply|mailer-daemon|postmaster|notification/i.test(address)) return true
  if (!Array.isArray(rawHeaders)) return false
  for (const h of rawHeaders) {
    if (!h || typeof h !== 'object') continue
    const entry = h as { name?: unknown; value?: unknown }
    const name = String(entry.name ?? '').toLowerCase()
    const value = String(entry.value ?? '').toLowerCase()
    // a mailing list or bulk sender saying so itself
    if (name === 'list-unsubscribe' || name === 'list-id') return true
    // RFC 3834: anything generated by a program rather than a person
    if (name === 'auto-submitted' && value !== 'no') return true
    if (name === 'precedence' && /bulk|list|junk|auto_reply/.test(value)) return true
    if (name === 'x-auto-response-suppress') return true
  }
  return false
}

/** Exchange stamps inbound external mail; carry it as a flag, not as noise */
const EXTERNAL_TAG = /^\s*\[EXTERNAL\]\s*/i

/**
 * The connector's trigger has no webLink, so build the OWA deep link from the
 * message id instead.
 */
function outlookLink(id: string): string | null {
  if (!id) return null
  return `https://outlook.office.com/owa/?ItemID=${encodeURIComponent(
    id
  )}&exvsurl=1&viewmodel=ReadMessageItem`
}

function parseMessage(raw: unknown, file: string): MailMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>

  const rawBody = asText(o.body ?? o.Body ?? o.bodyHtml)
  const html = o.isHtml === true || looksHtml(rawBody)
  const body = html ? htmlToText(rawBody) : rawBody.trim()
  const preview = asText(o.bodyPreview ?? o.BodyPreview).trim() || body.slice(0, 240)

  const from = asPerson(o.from ?? o.From ?? o.sender)
  const fromName =
    from.name ?? nameForAddress(from.address) ?? nameFromHeaders(o.internetMessageHeaders)

  const rawSubject = asText(o.subject ?? o.Subject).trim()
  const external = EXTERNAL_TAG.test(rawSubject)
  const automated = isAutomated(o.internetMessageHeaders, from.address)
  const received =
    asText(o.receivedDateTime ?? o.ReceivedDateTime ?? o.dateTimeReceived ?? o.receivedTime) ||
    // fall back to the timestamp the flow put at the head of the file name
    ''
  const receivedAt = new Date(received)

  const id = asText(o.id ?? o.Id ?? o.internetMessageId) || file
  return {
    id,
    subject: rawSubject.replace(EXTERNAL_TAG, '') || '(no subject)',
    external,
    automated,
    from: from.address,
    fromName,
    to: asPeople(o.toRecipients ?? o.to ?? o.To),
    cc: asPeople(o.ccRecipients ?? o.cc ?? o.Cc),
    receivedAt: isNaN(receivedAt.getTime())
      ? statSync(file).mtime.toISOString()
      : receivedAt.toISOString(),
    preview,
    body,
    isRead: o.isRead === true,
    hasAttachments: o.hasAttachments === true,
    importance: asText(o.importance ?? o.Importance).toLowerCase() || null,
    conversationId: asText(o.conversationId ?? o.ConversationId) || null,
    webLink: asText(o.webLink ?? o.WebLink) || outlookLink(id),
    file
  }
}

// files are written once and never edited, so a parse is worth keeping
const parsed = new Map<string, MailMessage | null>()

// ---- invitation emails -------------------------------------------------------
// Outlook's published calendar link stopped saying who's invited, but the
// invitation itself arrives as mail and the inbox flow files it like any
// other: the organizer as sender, the invitees on To and Cc.

const DAY_MS = 864e5
/** replies to an invitation go to the organizer, so they say nothing about who's invited */
const INVITE_RESPONSE = /^\s*(accepted|declined|tentative|tentatively accepted|canceled|cancelled|new time proposed)\s*:/i
/** a word that marks a group mailbox rather than a person */
const NOT_A_PERSON =
  /^(rowan|online|operations|portfolio|team|office|room|conference|center|services?|support|group|dept|department|university|staff|all|calendar)$/i
/** what a meeting invitation carries and an ordinary email usually doesn't */
const MEETING_HINT =
  /meetingMessageType|eventMessage|IPM\.Schedule\.Meeting|meetup-join|Join the meeting|Microsoft Teams meeting/i

/** a subject as the calendar shows the meeting's title */
function inviteKey(subject: string): string {
  return subject
    .replace(EXTERNAL_TAG, '')
    .replace(/^\s*updated\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** the flow names each file for the UTC time it saved it: yyyyMMddHHmmssfff */
const stampOf = (ms: number): string => new Date(ms).toISOString().replace(/\D/g, '').slice(0, 17)

const subjects = new Map<string, string>()

/** a file's subject, from the head of the file where the flow writes it; remembered, since files never change */
async function subjectOf(path: string): Promise<string> {
  const known = subjects.get(path)
  if (known !== undefined) return known
  let subject = ''
  try {
    const fh = await open(path, 'r')
    try {
      const { buffer, bytesRead } = await fh.read(Buffer.alloc(8192), 0, 8192, 0)
      const m = buffer
        .subarray(0, bytesRead)
        .toString('utf8')
        .match(/"subject"\s*:\s*("(?:[^"\\]|\\.)*")/i)
      subject = m
        ? (JSON.parse(m[1]) as string)
        : asText((JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>).subject)
    } finally {
      await fh.close()
    }
  } catch {
    // unreadable: counts as no subject
  }
  subjects.set(path, subject)
  return subject
}

/** an address list split on the commas between addresses, not the ones inside "Last, First" */
function addressList(value: string): string[] {
  const out: string[] = []
  let cur = ''
  let quoted = false
  let angle = false
  for (const ch of value) {
    if (ch === '"') quoted = !quoted
    else if (ch === '<') angle = true
    else if (ch === '>') angle = false
    if (ch === ',' && !quoted && !angle) {
      out.push(cur)
      cur = ''
    } else cur += ch
  }
  out.push(cur)
  return out.map((s) => s.trim()).filter(Boolean)
}

/** address -> the display name the From, To and Cc headers give it */
function headerNames(raw: unknown): Map<string, string> {
  const names = new Map<string, string>()
  if (!Array.isArray(raw)) return names
  for (const h of raw) {
    if (!h || typeof h !== 'object') continue
    const entry = h as { name?: unknown; value?: unknown }
    if (!/^(from|to|cc)$/i.test(String(entry.name ?? ''))) continue
    for (const part of addressList(asText(entry.value))) {
      const p = asPerson(part)
      // skip encoded words (=?utf-8?…?=) rather than show them raw
      if (p.name && p.address && !p.name.includes('=?')) names.set(p.address.toLowerCase(), p.name)
    }
  }
  return names
}

/** a display name as a person's: "Burkhardt, Ronald C" -> "Ronald C Burkhardt"; rooms and group mailboxes give null */
function personName(display: string | null | undefined): string | null {
  const n = (display ?? '').trim()
  if (!n || /\b(room|conference)\b/i.test(n)) return null
  if (n.includes(',')) {
    const [last, first] = n.split(',', 2).map((s) => s.trim())
    return first && last ? `${first} ${last}` : null
  }
  const words = n.split(/\s+/)
  return words.length >= 2 && !words.some((w) => NOT_A_PERSON.test(w)) ? n : null
}

/** the organizer and everyone on To and Cc, by the names People knows them by, else as the email shows them */
function inviteesIn(o: Record<string, unknown>): string[] {
  const shown = headerNames(o.internetMessageHeaders ?? o.InternetMessageHeaders)
  const listOf = (v: unknown): unknown[] => (Array.isArray(v) ? v : typeof v === 'string' ? v.split(';') : [])
  const people = [
    o.from ?? o.From ?? o.sender,
    ...listOf(o.toRecipients ?? o.to ?? o.To),
    ...listOf(o.ccRecipients ?? o.cc ?? o.Cc)
  ]
  const out: string[] = []
  for (const r of people) {
    const p = asPerson(r)
    const address = p.address.trim().toLowerCase()
    const name = nameForAddress(address) ?? personName(p.name ?? shown.get(address))
    if (name && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name)
  }
  return out.slice(0, 20)
}

/**
 * Who was invited to the meeting titled `title` at `startIso`, from its
 * invitation email: the newest one in the inbox folder from the year before
 * it. Empty when there's none, or no mail folder.
 */
export async function inviteesFromMail(title: string, startIso: string): Promise<string[]> {
  const dir = mailInDir()
  const want = inviteKey(title)
  const start = Date.parse(startIso)
  if (!dir || !want || !Number.isFinite(start)) return []
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const lo = stampOf(start - 365 * DAY_MS)
  const hi = stampOf(start + 3600e3)
  const files = names
    .filter((n) => n.toLowerCase().endsWith('.json'))
    // files named some other way can't be placed in time, so they're checked too
    .filter((n) => !/^\d{17}/.test(n) || (n.slice(0, 17) >= lo && n.slice(0, 17) <= hi))
    .sort()
    .reverse()
  // an invitation is often made from an email with the same subject, so the
  // one that reads as a meeting wins over the newest
  let newest: Record<string, unknown> | null = null
  let matches = 0
  for (const n of files) {
    const path = join(dir, n)
    const subject = await subjectOf(path)
    if (!subject || INVITE_RESPONSE.test(subject) || inviteKey(subject) !== want) continue
    let text: string
    let o: Record<string, unknown>
    try {
      text = await readFile(path, 'utf8')
      o = JSON.parse(text)
    } catch {
      continue
    }
    if (MEETING_HINT.test(text)) return inviteesIn(o)
    newest ??= o
    if (++matches >= 5) break
  }
  return newest ? inviteesIn(newest) : []
}

/** Everything the flow has dropped, newest first. */
export function readMailbox(): MailMessage[] {
  const dir = mailInDir()
  if (!dir || !existsSync(dir)) return []
  // file names lead with a UTC timestamp, so a reverse name sort is newest-first
  const names = readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.json'))
    .sort()
    .reverse()
    .slice(0, MAX_MESSAGES)

  const out: MailMessage[] = []
  const live = new Set<string>()
  for (const name of names) {
    const file = join(dir, name)
    live.add(file)
    if (!parsed.has(file)) {
      try {
        parsed.set(file, parseMessage(JSON.parse(readFileSync(file, 'utf8')), file))
      } catch {
        // a half-synced or malformed file: skip it, but don't cache the
        // failure — OneDrive may still be writing it
        continue
      }
    }
    const msg = parsed.get(file)
    if (msg) out.push(msg)
  }
  for (const key of parsed.keys()) {
    if (!live.has(key)) parsed.delete(key)
  }

  out.sort((a, b) => b.receivedAt.localeCompare(a.receivedAt))
  return out
}

export function mailStatus(): MailStatus {
  const root = getMailFolder()
  if (!root) return { connected: false, folder: null, count: 0, newestAt: null }
  const dir = mailInDir()!
  if (!existsSync(root)) {
    return {
      connected: false,
      folder: root,
      count: 0,
      newestAt: null,
      error: 'That folder is not on this PC any more. Check OneDrive is syncing it.'
    }
  }
  if (!existsSync(dir)) {
    return {
      connected: false,
      folder: root,
      count: 0,
      newestAt: null,
      error: 'No "in" folder yet — it appears once the Power Automate flow files its first message.'
    }
  }
  const messages = readMailbox()
  return {
    connected: true,
    folder: root,
    count: messages.length,
    newestAt: messages[0]?.receivedAt ?? null
  }
}

// ---------------------------------------------------------------------------
// Triage: the one-way sync means Rowan can't archive or mark mail read in
// Exchange, so it keeps its own "handled" list in userData/mail-triage.json.
// ---------------------------------------------------------------------------

function triageFile(): string {
  return join(app.getPath('userData'), 'mail-triage.json')
}

export function readMailTriage(): MailTriage {
  try {
    const raw = JSON.parse(readFileSync(triageFile(), 'utf8')) as Partial<MailTriage>
    return {
      handled: raw.handled && typeof raw.handled === 'object' ? raw.handled : {},
      starred: raw.starred && typeof raw.starred === 'object' ? raw.starred : {},
      read: raw.read && typeof raw.read === 'object' ? raw.read : {}
    }
  } catch {
    return { handled: {}, starred: {}, read: {} }
  }
}

/** Write the triage file, dropping entries for mail that has left the folder. */
function writeMailTriage(triage: MailTriage, keep: Set<string>): MailTriage {
  const live = new Set(readMailbox().map((m) => m.id))
  for (const id of Object.keys(triage.handled)) {
    if (!live.has(id) && !keep.has(id)) delete triage.handled[id]
  }
  for (const id of Object.keys(triage.starred)) {
    if (!live.has(id) && !keep.has(id)) delete triage.starred[id]
  }
  for (const id of Object.keys(triage.read)) {
    if (!live.has(id) && !keep.has(id)) delete triage.read[id]
  }
  mkdirSync(app.getPath('userData'), { recursive: true })
  writeFileSync(triageFile(), JSON.stringify(triage, null, 2))
  return triage
}

export function setMailHandled(messageIds: string[], handled: boolean): MailTriage {
  const triage = readMailTriage()
  const now = new Date().toISOString()
  const ids = new Set(messageIds)
  for (const id of ids) {
    if (handled) triage.handled[id] = now
    else delete triage.handled[id]
  }
  return writeMailTriage(triage, ids)
}

export function setMailStarred(messageIds: string[], starred: boolean): MailTriage {
  const triage = readMailTriage()
  const now = new Date().toISOString()
  const ids = new Set(messageIds)
  for (const id of ids) {
    if (starred) triage.starred[id] = now
    else delete triage.starred[id]
  }
  return writeMailTriage(triage, ids)
}

/**
 * Drafts Rowan has filed to the outbound folder, newest first. The flow
 * deletes each file once it has made the Outlook draft, so this is "waiting
 * to be picked up" more than a sent folder; it still answers "did that go?"
 */
export function readFiledDrafts(): MailFiledDraft[] {
  const dir = mailOutDir()
  if (!dir || !existsSync(dir)) return []
  const out: MailFiledDraft[] = []
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.json')) continue
    try {
      const o = JSON.parse(readFileSync(join(dir, name), 'utf8')) as Record<string, unknown>
      out.push({
        id: name,
        kind: o.kind === 'reply' ? 'reply' : 'new',
        to: asText(o.to),
        subject: asText(o.subject),
        body: asText(o.body),
        queuedAt: asText(o.queuedAt) || statSync(join(dir, name)).mtime.toISOString()
      })
    } catch {
      // a file the flow is mid-way through deleting
    }
  }
  out.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt))
  return out
}

export function setMailRead(messageIds: string[], read: boolean): MailTriage {
  const triage = readMailTriage()
  const ids = new Set(messageIds)
  for (const id of ids) triage.read[id] = read
  return writeMailTriage(triage, ids)
}

/** Make sure the outbound folder exists, ready for reply drafts. */
export function ensureMailDirs(): void {
  const out = mailOutDir()
  if (out && !existsSync(out)) {
    try {
      mkdirSync(out, { recursive: true })
    } catch {
      // OneDrive may not have created the parent yet; harmless
    }
  }
}

// ---------------------------------------------------------------------------
// Folder watch: OneDrive drops files in whenever it feels like it, so tell the
// renderer rather than making it poll. Sync writes arrive in bursts, hence the
// debounce.
// ---------------------------------------------------------------------------

let watcher: FSWatcher | null = null
let outWatcher: FSWatcher | null = null
let debounce: NodeJS.Timeout | null = null

const changeListeners: (() => void)[] = []

/** run fn whenever the bridge folder changes (the mail assistant sorts new arrivals) */
export function onMailChanged(fn: () => void): void {
  changeListeners.push(fn)
}

function announce(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('mail:changed')
  for (const fn of changeListeners) fn()
}

export function stopMailWatch(): void {
  watcher?.close()
  watcher = null
  outWatcher?.close()
  outWatcher = null
  if (debounce) clearTimeout(debounce)
  debounce = null
}

/** (Re)attach the watcher to the configured folder. Safe to call repeatedly. */
export function startMailWatch(): void {
  stopMailWatch()
  const dir = mailInDir()
  if (!dir || !existsSync(dir)) return
  const ping = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(announce, 800)
  }
  try {
    watcher = watch(dir, ping)
  } catch {
    // an unwatchable path just means the Mail view refreshes on its own
  }
  // the flow deleting a filed draft is worth a refresh of the Drafts folder too
  const out = mailOutDir()
  if (out && existsSync(out)) {
    try {
      outWatcher = watch(out, ping)
    } catch {
      // same as above
    }
  }
}
