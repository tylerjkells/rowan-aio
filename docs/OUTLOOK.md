# Outlook / email integration — feasibility

Status: **assessment only, nothing built.** Written to answer "is this real?"
before any code gets written.

## The short version

Technically everything on the wish list is buildable, and most of it is a
small amount of work on top of what the app already does. The whole thing
hinges on one non-technical question:

> **Will IT approve an Entra ID app registration with mail permissions?**

Unlike the calendar, there is no back door. The calendar works because
Outlook lets you publish an iCal feed to a secret URL — a read-only escape
hatch that needs nobody's approval. **Mail has no equivalent.** Every route
to a mailbox goes through an authenticated Microsoft API.

So: ask IT first, build second. Everything below assumes the answer.

## The three routes, honestly

### A. Microsoft Graph + OAuth — the real one

Delegated scopes needed: `Mail.Read` (read), `Mail.ReadWrite` (create
drafts), `Mail.Send` (only if we ever send), `offline_access` (refresh
tokens), `User.Read`.

The catch: `Mail.Read` is **not** in Microsoft's low-impact permission set,
so under the default user-consent policy an ordinary user cannot consent to
it for themselves — a tenant admin has to grant consent. Microsoft has been
tightening this, not loosening it (user consent is now off by default in new
tenants). In a district tenant handling student data, assume this is a
deliberate policy, not an oversight.

If IT says yes, the rest is routine:

- Auth: authorization code + PKCE in a `BrowserWindow`, loopback redirect.
  Public client, no client secret shipped in the app.
- Token storage: refresh token through `safeStorage`, exactly the shape
  `settings.ts` already uses for the ClickUp token and the iCal URL.
- Sync: `GET /me/mailFolders/inbox/messages/delta` gives cheap incremental
  pulls — same "fetch, diff against a local snapshot" pattern the ClickUp
  changelog already uses in `clickup.ts`.
- Drafts: `POST /me/messages/{id}/createReply`, then PATCH the body. The
  draft lands in Outlook; the user sends it from there.

Rough effort: the mail code is a day. The OAuth plumbing and the
token-refresh edge cases are the other two.

### B. Local Outlook COM (Windows only) — works today, has an expiry date

If classic Outlook for Windows is installed, the app can drive
`Outlook.Application` over COM (via a PowerShell bridge) to read the inbox
and create drafts. No app registration, no IT approval, no tokens — it
borrows the session of the Outlook the user is already signed into.

The problem: **new Outlook does not support COM, VBA, or MAPI at all.**
Classic Outlook is supported through 2029 and the classic/new toggle is not
being removed before 2028, but this is a path with a known end date, and it
breaks the day IT flips someone to new Outlook. Reasonable as a stopgap;
bad as the foundation.

### C. IMAP with an app password — dead end

Basic auth for IMAP against Exchange Online is off. IMAP with OAuth needs
the same app registration and the same admin consent as route A, with a
worse API. No shortcut here.

## The privacy question

This is a bigger deal than the calendar was. The guiding constraint in
ROADMAP.md is that transcripts and audio stay local, and only what you
explicitly send leaves the machine. Mail bodies are exactly the kind of
content that constraint exists to protect.

Proposed posture, same as today's:

- Mail is cached locally (encrypted at rest alongside settings).
- Nothing goes to a model on a timer. A thread reaches Claude/OpenAI only
  when the user clicks "draft a reply" or "recap my day" on it.
- Drafts are written back to Outlook as drafts. **The app never sends.**
  Send-from-app is the last thing to build, if ever.

## What's actually worth building

Ranked by value per unit of work, once auth exists:

1. **Inbox on Today** — a triage strip, not a mail client. Unread, flagged,
   and "you asked a question and nobody answered." The app should never try
   to replace Outlook; it should tell you what Outlook is hiding from you.
2. **Draft replies** — the follow-up email drafting on the meeting page
   already does this shape of work. The difference is context: a reply draft
   can be fed the thread *plus* the person's page *plus* the open action
   items that person owns. That's a draft no mail client can write.
3. **Daily recap** — `digest.ts` already assembles a weekly review locally
   from the library, with no model call. Add mail as another input and the
   daily version writes itself: what landed, what needs an answer, what you
   promised in writing today, merged with meeting action items and the
   calendar.
4. **Email ↔ meeting ↔ ClickUp** — the thing nothing else can do, because
   nothing else has all three. "Turn this email into a ClickUp task" is now
   a two-line change (the push dialog was made standalone for the Projects
   page). "This thread belongs to the Tuesday budget series" links mail into
   the meeting history. Person pages gain a mail column next to meetings and
   action items.
5. **Follow-up chasing** — sent mail where you asked something and the
   thread died. Pairs with the aging action items the digest already tracks.
6. **Richer pre-meeting briefs** — the Today brief already pulls decisions
   and open items from past meetings; recent mail with the attendees is the
   obvious missing input.

## Suggested order

- **Phase 0** — ask IT about an app registration with `Mail.Read` +
  `Mail.ReadWrite`. Costs nothing, decides everything.
- **Phase 1** — OAuth + read-only inbox + Today triage.
- **Phase 2** — reply drafts (written to Outlook drafts, never sent).
- **Phase 3** — daily recap, follow-up chasing, cross-links into meetings,
  people, and ClickUp.

If Phase 0 comes back "no", route B (COM against classic Outlook) makes
Phases 1–2 possible on Tyler's machine alone, with the understanding that
it dies when he moves to new Outlook.
