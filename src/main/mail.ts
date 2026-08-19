import { BrowserWindow } from 'electron'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher
} from 'fs'
import { join } from 'path'
import { getMailFolder } from './settings'
import { readDirectory } from './directory'
import type { MailMessage, MailStatus } from '../shared/types'

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
let debounce: NodeJS.Timeout | null = null

function announce(): void {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send('mail:changed')
}

export function stopMailWatch(): void {
  watcher?.close()
  watcher = null
  if (debounce) clearTimeout(debounce)
  debounce = null
}

/** (Re)attach the watcher to the configured folder. Safe to call repeatedly. */
export function startMailWatch(): void {
  stopMailWatch()
  const dir = mailInDir()
  if (!dir || !existsSync(dir)) return
  try {
    watcher = watch(dir, () => {
      if (debounce) clearTimeout(debounce)
      debounce = setTimeout(announce, 800)
    })
  } catch {
    // an unwatchable path just means the Mail view refreshes on its own
  }
}
