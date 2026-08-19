# Outlook / email integration — feasibility

Status: **assessment only, nothing built.**

Constraints this is written against: **no IT involvement**, and **new Outlook**
(not classic).

## The short version

It's doable without IT, but not the obvious way. The clean route — an app
registration with `Mail.Read` — almost certainly hits a wall you can't get
past on your own. The route that does work is a **Power Automate flow
bridging Outlook to a OneDrive folder that Rowan reads off local disk.**

Worth ten minutes to confirm the clean route is really shut before
committing to the bridge, because the test is free and the failure message
is unambiguous.

## Route A: Graph + your own app registration — test it, expect no

By default, Entra lets any user register an application in the tenant, so
step one is probably open to you. Registering an app is not the problem.

**Consent is.** `Mail.Read` isn't in Microsoft's low-impact permission set,
so granting it requires either an admin or a tenant that still allows broad
user consent. In July–August 2025 Microsoft flipped every tenant still on
the legacy "users can consent to any app" setting over to the restrictive
recommended policy. Unless someone deliberately re-opened it since, you'll
get "Need admin approval" and there is no way around that from a
non-admin account.

**Test it anyway — 10 minutes, no IT contact:**

1. portal.azure.com → Entra ID → App registrations → New registration.
   Single tenant, redirect URI `http://localhost` (Public client/native).
   *If this screen is greyed out, app registration is disabled and Route A
   is dead here.*
2. API permissions → Microsoft Graph → Delegated → `Mail.Read`,
   `Mail.ReadWrite`, `offline_access`.
3. Build the consent URL for that client ID and open it in a browser signed
   in as yourself.

Three possible outcomes: it consents (great — Route A is open, build the
real thing); "Need admin approval" (Route A is dead); or you never reach
step 1 (also dead). Any of the three answers the question permanently.

There's a known trick of borrowing a first-party Microsoft client ID to
dodge the consent prompt. It violates the terms, it's exactly what tenant
security tooling looks for, and it can get an account flagged. Not building
on that.

## Route B: Power Automate ↔ OneDrive bridge — the one that works

No app registration, no consent prompt, no OAuth code in Rowan at all.
Power Automate's Microsoft 365 Outlook connector runs as *you*, with a
connection you authorize yourself. Files land in OneDrive, the OneDrive
client syncs them to disk, and Rowan reads a local folder — which is a
better fit for a local-first app than a token-refresh loop anyway.

**Inbound (read mail):**

- Trigger: *When a new email arrives (V3)* — webhook-based, near-instant.
- Action: *Create file* in OneDrive at `/Apps/Rowan/in/{messageId}.json`
  with subject, from, to, received time, conversation ID, `webLink`, and
  body.
- Rowan: `fs.watch` on the synced folder. Same shape as the existing
  calendar poll, minus the network.

**Outbound (reply drafts):**

- Rowan writes `/Apps/Rowan/out/{id}.json` with the conversation ID and the
  drafted body.
- Trigger: *When a file is created* (OneDrive) — polling, ~1 min.
- Action: *Draft an email message* (the connector has a real draft action,
  so nothing gets sent), then delete the file.
- The draft appears in Outlook. You review and send it there. Rowan never
  sends mail.

**What can still block this:** a DLP policy on the Outlook or OneDrive
connectors, or Power Automate switched off tenant-wide. You'll find out in
about two minutes at make.powerautomate.com, again without asking anyone.

**Honest tradeoffs:** ~1 min latency on the outbound hop. Mail bodies pass
through Power Automate and sit in your OneDrive — still entirely inside
your own M365 tenant, so no worse than where that mail already lives, but
it is a copy, and flows are visible to an admin who goes looking. This is
sanctioned self-service tooling, not a workaround, but it isn't invisible
either.

## Route C: Outlook web add-in — only for in-context replies

Works on new Outlook, self-installable by you (Settings → Add-ins → Custom
Addins → Add from file; needs the *My Custom Apps* Exchange role, which
users have by default, plus Developer Mode in Trust Center). Load-from-URL
was disabled for security, so it's file-manifest only, and the add-in page
itself has to be hosted over HTTPS — GitHub Pages would do.

It reads the message you're currently looking at via Office.js with no
Graph consent at all, and can call Rowan on `http://localhost` (Chromium
exempts localhost from mixed-content blocking). Good for a "draft a reply
with Rowan's context" button living inside Outlook. Useless for daily
recaps, because it only ever sees the open message — and the old way around
that, EWS, is being blocked starting October 1 2026.

## Definitively dead

- **COM / `Outlook.Application`** — new Outlook has no COM, VBA, or MAPI.
  This was the no-approval-needed answer for classic Outlook only.
- **IMAP with an app password** — basic auth is off; IMAP OAuth needs the
  same consent as Route A.
- **EWS** — blocked from October 1 2026 without a tenant allowlist.
- **Reading a local mail store** — new Outlook keeps no accessible `.ost`.

## Recommendation

1. Run the Route A test. Ten minutes, and it either saves the whole bridge
   or closes the question for good.
2. Assuming it fails, build Route B. Start read-only: one flow, one folder,
   inbox triage on the Today screen. That proves the pipe with almost no
   code in Rowan — a folder watcher and a JSON parse.
3. Add the outbound draft flow once reading feels good.
4. Route C later, only if you want the button inside Outlook rather than
   inside Rowan.

## What's worth building on top

Ranked by value per unit of work, once mail is reachable by any route:

1. **Inbox on Today** — a triage strip, not a mail client. Unread, flagged,
   and "you asked a question and nobody answered." Rowan should tell you
   what Outlook is hiding, not replace it.
2. **Draft replies** — the follow-up email drafting on the meeting page is
   already this shape. The difference is context: a reply draft can be fed
   the thread *plus* the person's page *plus* the open action items that
   person owes you. No mail client can write that draft.
3. **Daily recap** — `digest.ts` already assembles a weekly review locally
   with no model call. Add mail as an input and the daily version writes
   itself: what landed, what needs an answer, what you promised in writing,
   merged with meeting action items and the calendar.
4. **Email ↔ meeting ↔ ClickUp** — the thing nothing else can do, because
   nothing else has all three. "Turn this email into a ClickUp task" is now
   nearly free (the push dialog is standalone as of the Projects page work).
   Threads can join a meeting series; person pages gain a mail column.
5. **Follow-up chasing** — sent mail where you asked something and the
   thread died, alongside the aging action items the digest already tracks.
6. **Richer pre-meeting briefs** — recent mail with the attendees is the
   obvious missing input to the Today brief.

## Privacy posture

Whatever the route, keep the ROADMAP constraint intact: mail is cached
locally, nothing goes to a model on a timer, and a thread reaches
Claude/OpenAI only when you click "draft a reply" or "recap my day" on it.
Drafts are written back as drafts. The app never sends.
