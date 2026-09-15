import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { aiChat } from './ai'
import { mailOutDir, readMailbox } from './mail'
import { personProfile } from './people'
import { detailsFor, readDirectory } from './directory'
import { getMailSignature, getSettings } from './settings'
import { stripDashes, VOICE_RULES } from './voice'
import type {
  MailComposeDraftInput,
  MailDraftInput,
  MailDraftResult,
  MailMessage,
  MailNewDraftInput,
  MailRecipients
} from '../shared/types'

// ---------------------------------------------------------------------------
// Reply drafting. Rowan never sends mail: a draft is written to the bridge's
// "out" folder, a Power Automate flow picks it up and creates a real draft in
// Outlook, and the user sends it themselves from there.
//
// The point of drafting here rather than in Outlook is context — the model
// gets the sender's page, what they still owe you, and what you owe them,
// which is the one thing a mail client cannot know.
// ---------------------------------------------------------------------------

/** how much of a long thread the model gets */
const MAX_BODY = 6000

function nameForAddress(address: string): string | null {
  const key = address.trim().toLowerCase()
  if (!key) return null
  for (const [name, details] of Object.entries(readDirectory())) {
    if (details.email?.trim().toLowerCase() === key) return name
  }
  return null
}

/** What Rowan knows about the sender that Outlook doesn't. */
function senderContext(message: MailMessage): string {
  const name = nameForAddress(message.from) ?? message.fromName
  if (!name) return ''
  const profile = personProfile(name)
  if (!profile) return ''

  const lines: string[] = [`What you already know about ${name}:`]
  const details = detailsFor(name)
  if (details?.title || details?.department) {
    lines.push(`- Role: ${[details.title, details.department].filter(Boolean).join(', ')}`)
  }

  const theirOpen = profile.items.filter((i) => !i.done).slice(0, 6)
  if (theirOpen.length) {
    lines.push(`- Open items ${name} owes, from your meetings:`)
    for (const i of theirOpen) {
      lines.push(`  · ${i.task}${i.dueDate ? ` (due ${i.dueDate})` : ''} — from "${i.meetingTitle}"`)
    }
  }

  const mine = profile.myCommitments.filter((i) => !i.done).slice(0, 6)
  if (mine.length) {
    lines.push(`- What you owe ${name}:`)
    for (const i of mine) {
      lines.push(`  · ${i.task}${i.dueDate ? ` (due ${i.dueDate})` : ''} — from "${i.meetingTitle}"`)
    }
  }

  const recent = profile.meetings.slice(0, 3)
  if (recent.length) {
    lines.push(
      `- Recent meetings together: ${recent.map((m) => `"${m.title}"`).join(', ')}`
    )
  }

  // nothing beyond the bare name is worth spending tokens on
  return lines.length > 1 ? lines.join('\n') : ''
}

const SYSTEM = `You draft email replies on behalf of the user, in their voice.

${VOICE_RULES}

Rules:
- Write only the reply body. No subject line, no "Here's a draft", no commentary.
- Match the register of the message you are answering. A one-line question gets a one-line answer.
- Never invent facts, dates, numbers, commitments, or attachments. If the right
  answer depends on something you were not told, write the reply around it or
  leave an obvious [bracketed placeholder] for the user to fill.
- You may reference the context you are given about the sender — outstanding
  commitments, past meetings — but only where it genuinely answers the message.
- Plain text. No markdown, no bullet characters unless the reply really is a list.
- Sign off with the user's first name alone, or no sign-off for a short internal reply.
- Write it the way a busy person actually types a reply, not the way an assistant
  would compose one. No "I hope this email finds you well", no "Please don't
  hesitate to reach out", no "Thank you for your email".`

export async function draftMailReply(
  messageId: string,
  instruction?: string
): Promise<MailDraftResult> {
  try {
    const message = readMailbox().find((m) => m.id === messageId)
    if (!message) return { ok: false, error: 'That message is no longer in the mail folder.' }

    const yourName = getSettings().yourName.trim()
    const context = senderContext(message)
    const body = message.body.slice(0, MAX_BODY)

    const parts = [
      yourName ? `You are writing as ${yourName}.` : '',
      context,
      '',
      'Reply to this message:',
      `From: ${message.fromName ? `${message.fromName} <${message.from}>` : message.from}`,
      `Subject: ${message.subject}`,
      `Received: ${message.receivedAt}`,
      '',
      body,
      '',
      instruction?.trim()
        ? `How the user wants this answered: ${instruction.trim()}`
        : 'Draft a reply that moves this forward.'
    ]

    const result = await aiChat({
      maxTokens: 1200,
      system: SYSTEM,
      messages: [{ role: 'user', content: parts.filter((p) => p !== '').join('\n') }]
    })

    const text = stripDashes(result.text.trim())
    if (!text) return { ok: false, error: 'The model came back empty. Try again.' }
    return { ok: true, body: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const COMPOSE_SYSTEM = `You write emails on behalf of the user, in their voice.

${VOICE_RULES}

Rules:
- Write only the message body. No subject line, no "Here's a draft", no commentary.
- Say what the user asked you to say and nothing more. A short ask is a short email.
- Never invent facts, dates, numbers, commitments, or attachments. Leave an obvious
  [bracketed placeholder] where the user has to fill something in.
- You may use what you are told about the recipient — outstanding commitments,
  past meetings — only where it genuinely belongs in the message.
- Plain text. No markdown, no bullet characters unless the message really is a list.
- Open with the recipient's first name where you know it. Sign off with the user's
  first name alone.
- Write it the way a busy person actually types an email, not the way an assistant
  would compose one. No "I hope this email finds you well", no "Please don't
  hesitate to reach out".`

/** What Rowan knows about each recipient of a fresh message. */
function recipientContext(addresses: string[]): string {
  const blocks: string[] = []
  for (const address of addresses) {
    const name = nameForAddress(address)
    if (!name) continue
    blocks.push(
      senderContext({
        from: address,
        fromName: name
      } as MailMessage)
    )
  }
  return blocks.filter(Boolean).join('\n\n')
}

/** Draft a fresh message from the compose card. */
export async function draftNewMail(input: MailComposeDraftInput): Promise<MailDraftResult> {
  try {
    const instruction = input.instruction.trim()
    if (!instruction) return { ok: false, error: 'Say what the email should say first.' }
    const yourName = getSettings().yourName.trim()
    const to = input.to.map((a) => a.trim()).filter(Boolean)
    const named = to.map((a) => {
      const name = nameForAddress(a)
      return name ? `${name} <${a}>` : a
    })
    const parts = [
      yourName ? `You are writing as ${yourName}.` : '',
      recipientContext(to),
      '',
      named.length ? `To: ${named.join(', ')}` : 'To: (not chosen yet)',
      input.subject.trim() ? `Subject: ${input.subject.trim()}` : '',
      '',
      `What the email should say: ${instruction}`
    ]
    const result = await aiChat({
      maxTokens: 1200,
      system: COMPOSE_SYSTEM,
      messages: [{ role: 'user', content: parts.filter((p) => p !== '').join('\n') }]
    })
    const text = stripDashes(result.text.trim())
    if (!text) return { ok: false, error: 'The model came back empty. Try again.' }
    return { ok: true, body: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const SUMMARY_SYSTEM = `You summarize a single email for someone deciding what to do about it.

${VOICE_RULES}

Rules:
- Three to five lines of plain text, no markdown, no headings.
- First line: what this is actually about, in one sentence.
- Then, only where they exist: what is being asked of the reader, any deadline
  or date, and any decision being requested. Skip what is not there — do not
  write "no deadline mentioned".
- Ignore signatures, disclaimers, quoted history, and unsubscribe boilerplate.
- Never invent anything. If the mail is vague, say that it is vague.
- No preamble. Start with the summary itself.`

/** A short read on one message, for deciding whether it needs you. */
export async function summarizeMailMessage(messageId: string): Promise<MailDraftResult> {
  try {
    const message = readMailbox().find((m) => m.id === messageId)
    if (!message) return { ok: false, error: 'That message is no longer in the mail folder.' }
    if (message.body.trim().length < 40) {
      // nothing to compress: a two-line mail is its own summary
      return { ok: true, body: message.body.trim() || message.preview }
    }

    const result = await aiChat({
      maxTokens: 500,
      system: SUMMARY_SYSTEM,
      messages: [
        {
          role: 'user',
          content: [
            `From: ${message.fromName ? `${message.fromName} <${message.from}>` : message.from}`,
            `Subject: ${message.subject}`,
            `Received: ${message.receivedAt}`,
            '',
            message.body.slice(0, MAX_BODY)
          ].join('\n')
        }
      ]
    })

    const text = stripDashes(result.text.trim())
    if (!text) return { ok: false, error: 'The model came back empty. Try again.' }
    return { ok: true, body: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The connector's "Draft an email message" body is a rich-text field, so a
 * plain-text draft would arrive as one run-on paragraph. Escaping and
 * converting here rather than in the flow keeps the HTML correct even when the
 * reply contains <, > or & — Logic Apps string functions would not.
 */
function toHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r\n|\r|\n/g, '<br>')
}

/** the payload the outbound flow parses; see docs/OUTLOOK.md */
interface OutboundDraft {
  kind: 'reply' | 'new'
  messageId: string
  conversationId: string | null
  to: string
  subject: string
  body: string
}

/**
 * Write one draft file for the outbound flow. Writing the file IS the send —
 * the flow picks it up within a minute.
 */
function writeOutbound(draft: OutboundDraft): { ok: boolean; error?: string } {
  try {
    const dir = mailOutDir()
    if (!dir) return { ok: false, error: 'No mail folder is set up.' }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)

    // Outlook only applies a signature to what you compose yourself, so a
    // draft the flow creates arrives bare. Rowan appends its own copy.
    const signature = getMailSignature()
    const body = signature.text ? `${draft.body}\n\n${signature.text}` : draft.body
    const bodyHtml = signature.html
      ? `${toHtml(draft.body)}<br><br>${signature.html}`
      : toHtml(draft.body)

    const payload = {
      ...draft,
      body,
      /** the same text as HTML, for the connector's rich-text body field */
      bodyHtml,
      queuedAt: new Date().toISOString()
    }
    writeFileSync(join(dir, `${stamp}-${randomUUID()}.json`), JSON.stringify(payload, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** File a reply for the outbound flow to turn into a real Outlook draft. */
export function queueMailDraft(input: MailDraftInput): { ok: boolean; error?: string } {
  const message = readMailbox().find((m) => m.id === input.messageId)
  return writeOutbound({
    kind: 'reply',
    messageId: input.messageId,
    conversationId: message?.conversationId ?? null,
    to: message?.from ?? '',
    subject: message ? `RE: ${message.subject}` : 'RE:',
    body: input.body
  })
}

/**
 * File a fresh message (a meeting follow-up, say). messageId stays present
 * but empty because the flow's Parse JSON step lists it as required.
 * Recipients are joined with semicolons, which Outlook's To field accepts.
 */
export function queueNewMailDraft(input: MailNewDraftInput): { ok: boolean; error?: string } {
  const to = input.to.map((a) => a.trim()).filter(Boolean)
  if (to.length === 0) return { ok: false, error: 'Add at least one recipient.' }
  return writeOutbound({
    kind: 'new',
    messageId: '',
    conversationId: null,
    to: to.join('; '),
    subject: input.subject.trim() || '(no subject)',
    body: input.body
  })
}

/** Look up meeting participants in the directory. Names not on file are reported, not guessed. */
export function recipientsFor(names: string[]): MailRecipients {
  const out: MailRecipients = { matched: [], unmatched: [] }
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name || name.toLowerCase() === 'me') continue
    const email = detailsFor(name)?.email?.trim()
    if (email) {
      if (seen.has(email.toLowerCase())) continue
      seen.add(email.toLowerCase())
      out.matched.push({ name, email })
    } else {
      out.unmatched.push(name)
    }
  }
  return out
}
