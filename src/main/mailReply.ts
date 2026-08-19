import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { randomUUID } from 'crypto'
import { aiChat } from './ai'
import { mailOutDir, readMailbox } from './mail'
import { personProfile } from './people'
import { detailsFor, readDirectory } from './directory'
import { getSettings } from './settings'
import type { MailDraftInput, MailDraftResult, MailMessage } from '../shared/types'

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

Rules:
- Write only the reply body. No subject line, no "Here's a draft", no commentary.
- Match the register of the message you are answering. A one-line question gets a one-line answer.
- Never invent facts, dates, numbers, commitments, or attachments. If the right
  answer depends on something you were not told, write the reply around it or
  leave an obvious [bracketed placeholder] for the user to fill.
- You may reference the context you are given about the sender — outstanding
  commitments, past meetings — but only where it genuinely answers the message.
- Plain text. No markdown, no bullet characters unless the reply really is a list.
- Sign off with the user's first name alone, or no sign-off for a short internal reply.`

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

    const text = result.text.trim()
    if (!text) return { ok: false, error: 'The model came back empty. Try again.' }
    return { ok: true, body: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const SUMMARY_SYSTEM = `You summarize a single email for someone deciding what to do about it.

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

    const text = result.text.trim()
    if (!text) return { ok: false, error: 'The model came back empty. Try again.' }
    return { ok: true, body: text }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * File a draft for the outbound flow to turn into a real Outlook draft.
 * Writing the file IS the send — the flow picks it up within a minute.
 */
export function queueMailDraft(input: MailDraftInput): { ok: boolean; error?: string } {
  try {
    const dir = mailOutDir()
    if (!dir) return { ok: false, error: 'No mail folder is set up.' }
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

    const message = readMailbox().find((m) => m.id === input.messageId)
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17)
    const payload = {
      kind: 'reply',
      messageId: input.messageId,
      conversationId: message?.conversationId ?? null,
      to: message?.from ?? '',
      subject: message ? `RE: ${message.subject}` : 'RE:',
      body: input.body,
      queuedAt: new Date().toISOString()
    }
    writeFileSync(join(dir, `${stamp}-${randomUUID()}.json`), JSON.stringify(payload, null, 2))
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
