# Outlook / email integration — feasibility

Status: **assessment only, nothing built.**

Constraints this is written against: **no IT involvement**, and **new Outlook**
(not classic).

## The short version

It's doable without IT, but not the obvious way. The clean route — an app
registration with `Mail.Read` — almost certainly hits a wall you can't get
past on your own. The route that does work is a **Power Automate flow
bridging Outlook to a OneDrive folder that Rowan reads off local disk.**

The clean route was tested on 19 Aug 2026 and came back "Approval
required" — see Route A below. The bridge it is.

## What the iPhone proves (and what it doesn't)

Adding the mailbox to iPhone Mail as a "Microsoft Exchange" account is not
you-with-a-password. iOS Mail connects as an Entra application called
**Apple Internet Accounts** over OAuth, and that app needs *"Access
mailboxes as the signed-in user via Exchange Web Services"* — not a
low-impact permission, so it takes admin consent. Admins grant it
tenant-wide in one click (`aka.ms/ConsentAppleApp`), and districts almost
always do, so staff can get mail on their phones.

That's a grant to one specific app identity. It does not extend to an app
registered here.

It does rule out the worst case, though. If user consent were blocked *and*
nobody had approved Apple's app, the iPhone would have shown "Need admin
approval." It didn't, so the tenant is in one of two states:

- **(a)** an admin consented to Apple's app tenant-wide — says nothing
  about Route A; or
- **(b)** broad user consent is still enabled and the consent screen was
  clicked through personally — in which case **Route A works**.

Tell them apart by whether adding the account showed a permissions screen
that had to be accepted. A list of permissions means (b). Straight from
password + MFA to syncing means (a). Either way the Route A test below is
definitive, and (b) is live enough odds to run that test before building
anything else.

### Being an Exchange client directly is not an option

Four independent blocks:

- EAS is a **licensed protocol**, granted to commercial mail clients.
- Exchange Online has required **EAS 16.1+ since March 1 2026** (fully
  enforced August 4 2026), so a hand-rolled client is refused outright.
- EAS moved to OAuth, so it hits the **same consent wall** anyway.
- It leans on **EWS**, blocked from October 1 2026.

## Route A: Graph + your own app registration — TESTED, BLOCKED

**Result (19 Aug 2026): blocked.** An app registration named `Rowan-AIO`
was created successfully — registration is open to users in this tenant —
but the consent screen came back "Approval required: This app requires your
admin's approval to: Read user mail / Read and write access to user mail /
Maintain access to data you have given it access to / Sign in and read user
profile," with a justification box and a **Request approval** button.

So the tenant is in state (a): an admin consented to Apple's mail app at
some point, and broad user consent is off. Route A cannot be opened from a
non-admin account. Retrying with a narrower scope is pointless — no mail
permission is classified low impact.

The **Request approval** button is the IT route, should that ever become
acceptable. Everything below assumes it doesn't.

The original reasoning, kept because it explains the shape of the wall:

By default, Entra lets any user register an application in the tenant, so
step one is probably open to you. Registering an app is not the problem.

**Consent is.** `Mail.Read` isn't in Microsoft's low-impact permission set,
so granting it requires either an admin or a tenant that still allows broad
user consent. In July–August 2025 Microsoft flipped every tenant still on
the legacy "users can consent to any app" setting over to the restrictive
recommended policy — which is why the base case is "Need admin approval".
The iPhone evidence above is the reason to test rather than assume: if this
tenant is in state (b), consent still works here.

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

1. ~~Run the Route A test.~~ Done — blocked, see above.
2. ~~Confirm Power Automate is reachable.~~ Done — Office 365 Outlook and
   OneDrive for Business connections both create fine, so no DLP policy is
   in the way.
3. ~~Build the read side.~~ Done — `src/main/mail.ts` plus a Mail view.
4. ~~Reply drafting, summaries, morning brief.~~ Done — see below. The
   outbound flow still needs building in Power Automate.
5. Next: capturing Sent Items so "you asked and nobody answered" works, and
   pruning the bridge folder.

## How the read side is wired

- **Flow `Rowan inbox bridge`** — *When a new email arrives (V3)* →
  OneDrive *Create file* at `/Apps/Rowan/in`, name
  `concat(utcNow('yyyyMMddHHmmssfff'), '-', guid(), '.json')`, content
  `string(removeProperty(triggerOutputs()?['body'], 'internetMessageHeaders'))`.
  Serializing the whole trigger body
  means no hand-built JSON to break on a subject containing a quote, and
  Rowan gets every field the connector happens to expose.
- **Settings → Mail** points at the synced folder holding `in`.
  `src/main/mail.ts` reads it, parses defensively (both the flat connector
  shape and the Graph shape), and watches for changes so the view updates
  without polling.
- File names lead with a UTC timestamp, so a reverse name sort is
  newest-first and the parse cache can key off the path — files are written
  once and never edited.
- Only the newest 300 files are parsed per read. Nothing prunes the folder
  yet; that wants doing before it grows into five figures.

### The outbound half

Rowan never sends mail. "Draft a reply" writes a JSON file into the bridge's
`out` folder and stops there; a second flow turns it into a real Outlook
draft, which the user reviews and sends themselves.

The file looks like:

    {
      "kind": "reply",
      "messageId": "...",       // the message being answered
      "conversationId": "...",  // for threading
      "to": "sender@example.com",
      "subject": "RE: ...",
      "body": "...",
      "queuedAt": "2026-08-19T..."
    }

The flow: OneDrive *When a file is created* on `/Apps/Rowan/out` → *Get file
content* → *Parse JSON* → the Outlook connector's draft action → *Delete
file*. Polling makes this the slow direction, about a minute, which is fine
for something a human reviews anyway.

*Get file content* hands back binary rather than JSON, whatever the file
extension, so Parse JSON's Content has to decode it explicitly:

    json(base64ToString(body('Get_file_content')?['$content']))

(Setting *Infer Content Type* to Yes on the OneDrive action does the same
job, if a plain dynamic token is preferred.)

Parse JSON schema:

    {
      "type": "object",
      "properties": {
        "kind": { "type": "string" },
        "messageId": { "type": "string" },
        "conversationId": { "type": ["string", "null"] },
        "to": { "type": "string" },
        "subject": { "type": "string" },
        "body": { "type": "string" },
        "bodyHtml": { "type": "string" },
        "queuedAt": { "type": "string" }
      },
      "required": ["kind", "messageId", "to", "subject", "body"]
    }

Keep `required` minimal. `bodyHtml` was added after the first drafts were
already queued, and listing it as required made Parse JSON reject every
file written by the older build. Any field the bridge gains later has the
same problem, so new fields stay optional and the flow copes with their
absence.

Field mapping into *Draft an email message*: To ← `to`, Subject ←
`subject`, Body ← `coalesce(body('Parse_JSON')?['bodyHtml'], body('Parse_JSON')?['body'])`.

The coalesce is what copes: current drafts carry `bodyHtml`, older ones
fall back to the plain text (losing line breaks, but still drafting).

The connector's body is a rich-text field, so the plain-text `body` would
arrive as one run-on paragraph with every line break lost. Rowan writes
`bodyHtml` alongside it, escaped and with newlines already converted. Doing
that here rather than in the flow keeps the HTML correct when a reply
contains `<`, `>` or `&`, which Logic Apps string functions would mangle.
`body` stays in the file as the plain text of record.

`conversationId` is nullable, which the auto-generated schema will not
guess from a sample: generating from a file that happens to have one
produces `"type": "string"`, and the flow then fails on any draft where it
came back null.

### The signature

Outlook applies a signature when *you* open a compose window. A draft the
flow creates never passes through that code path, so it arrives bare — and
the connector has no signature setting to turn on.

So Rowan carries the signature itself. Settings → Mail has a paste box: copy
the signature out of a new Outlook message and paste it there. The clipboard
carries Outlook's HTML alongside the plain text, so the formatting survives
the trip. `src/shared/signature.ts` strips it back to inline markup —
stylesheets, `mso-` classes, conditional comments, and namespaced Word tags
all go, because none of them mean anything in a mail body. Scripts, event
handlers, and `javascript:` hrefs go for the obvious reason: the same HTML
is put back into the Settings page's DOM.

Images are dropped on purpose. A pasted logo arrives as `cid:image001.png`
or a path into `%TEMP%\msohtmlclip1`, neither of which resolves once the
draft reaches Outlook, so the choice is a broken image icon or no image.

`queueMailDraft()` appends it to both `body` and `bodyHtml`, so the draft
carries a signature whichever field the flow reads. Nothing in the flow
changes.

### Why drafts don't join the thread — and the fix

*Draft an email message* creates a **new** message. Exchange stamps a
conversation onto an item when it is created, so a fresh draft gets its own
`ConversationId` and `ConversationIndex` and never joins the original. The
`RE:` subject makes it *look* like a reply and nothing more; the recipient's
client has no `In-Reply-To` or `References` headers to thread on either, and
the connector gives no way to set them.

Nothing Rowan writes into the file can fix that — the threading is decided
by *which Outlook action creates the draft*, and no action in the Office 365
Outlook connector creates a draft in an existing thread. *Reply to email
(V3)* threads correctly and **sends**, which breaks the one rule this whole
design exists to keep.

The action that does both is Graph's `createReply`, reachable from a flow
through the **HTTP with Microsoft Entra ID** connector. That connector is
standard, not premium, and it runs as you with a connection you authorize
yourself — the same posture as the Outlook connector, and still no app
registration and no admin approval for `Rowan-AIO`. What it *does* need is
consent for Microsoft's own connector app, which this tenant may or may not
have already granted. Ten minutes settles it.

**The test, before rebuilding anything:**

1. make.powerautomate.com → **Create** → **Instant cloud flow** → *Manually
   trigger a flow*.
2. New step → **HTTP with Microsoft Entra ID** → *Invoke an HTTP request*.
3. Create the connection: Base Resource URL and Microsoft Entra ID Resource
   URI both `https://graph.microsoft.com`. Sign in.
   *"Need admin approval" here means this route is closed too, and the
   drafts stay standalone.*
4. Method `GET`, URL:

       https://graph.microsoft.com/v1.0/me/messages?$top=1&$select=subject

   Save and run. A 200 with a subject in it means the route is open.
5. One more check, because the whole rebuild rests on it: open any file in
   the bridge's `in` folder, copy its `id`, and GET

       https://graph.microsoft.com/v1.0/me/messages/{that id}

   The connector's message ids share Graph's id space, so this should also
   come back 200. If it 404s, the flow has to look the message up by
   `internetMessageId` instead and the payload needs that field added.

**The rebuild, once the test passes.** Only the drafts flow changes; the
inbound flow and everything in Rowan stay as they are. Replace *Draft an
email message* with two actions:

- **Invoke an HTTP request** (rename it `Create reply`) — Method `POST`,
  URL an expression:

      concat('https://graph.microsoft.com/v1.0/me/messages/', encodeUriComponent(body('Parse_JSON')?['messageId']), '/createReply')

  No body. This creates a real draft, already in the thread, already
  addressed, with the quoted original underneath.

- **Invoke an HTTP request** (rename it `Fill reply`) — Method `PATCH`,
  URL:

      concat('https://graph.microsoft.com/v1.0/me/messages/', encodeUriComponent(body('Create_reply')?['id']))

  Headers `Content-Type: application/json`, Body:

      {
        "body": {
          "contentType": "HTML",
          "content": "@{concat('<div>', coalesce(body('Parse_JSON')?['bodyHtml'], body('Parse_JSON')?['body']), '</div><br>', body('Create_reply')?['body']?['content'])}"
        }
      }

  Rowan's text goes first, the quoted history Graph generated follows.

*Get file content*, *Parse JSON*, and *Delete file* are untouched. The
payload's `to` and `subject` stop being read — `createReply` sets both from
the original message — but they stay in the file, because a flow that falls
back to *Draft an email message* still needs them.

## House voice

Anything the model writes for Tyler to read or send goes through
`src/main/voice.ts`. The rules are adapted from the humanizer skill he uses
for coursework, keeping what survives the move from an essay to a work
email: the em dash ban, the AI vocabulary list, varied sentence length, no
tidy summarizing closer, no mirrored parallel constructions, no reflexive
lists of three.

Deliberately left behind: "have opinions and react to the material", "let
thoughts trail off", "open with a blunt one-word answer". That advice makes
a discussion post read as human and makes an email to a colleague read as
odd. The goal is sounding like Tyler, not beating a detector.

`stripDashes()` is a backstop rather than the mechanism — the prompt does
the real work, but one slipped em dash undoes the whole effect, so
generated text gets swept afterwards too. It leaves dashes between digits
alone, because "10-15 people" and "pages 4-7" are ranges, not prose.

### Why the brief is a poll, not a timer

The written brief is one model call a day, cached to `recap.json` by date.
Generating it on app open covers the normal case, but the app is meant to be
left running — and an app left open overnight would sit on yesterday's brief
forever. So `startBriefWatch()` also checks every ten minutes and writes the
brief once the clock passes 8am, then tells the windows. Waking from sleep
needs no special handling: the next tick catches it.

Nothing here is shared between people. Each Windows account has its own
userData folder, so two people on one machine get their own brief on their
own first-open, with no coordination and no collision.

### What the connector actually sends

Confirmed against a real message on 19 Aug 2026:

- `from` is a **bare address string** with no display name, and
  `toRecipients` is a **semicolon-delimited string**, not an array. Both
  shapes were already handled defensively; this is what really arrives.
- **There is no `webLink`.** The Mail view builds an OWA deep link from the
  message `id` instead (`?ItemID=…&exvsurl=1&viewmodel=ReadMessageItem`).
- `internetMessageHeaders` is enormous — DKIM signatures and antispam
  blobs made up roughly 90% of the file. The flow drops it with
  `removeProperty`, which takes a message from ~15 KB to ~1 KB.
- Exchange prefixes inbound external mail with `[EXTERNAL]`. That's stripped
  from the displayed subject and kept as an `external` flag, shown as a
  small EXT chip.
- `isHtml`, `body`, `bodyPreview`, `receivedDateTime`, `conversationId`,
  `isRead`, `hasAttachments`, and `importance` all arrive as expected.

Sender display names come from Rowan's own People directory by matching the
address, falling back to the raw `From` header when the flow is still
shipping headers. That means colleagues read as people rather than
mailboxes, and it is the first thread tying mail to the People pages.
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

## Stopgap, independent of all of it

Rowan is Electron, so it could embed Outlook on the web in a tab and show
mail inside the app with no API work at all. That satisfies "see my email
in Rowan" and nothing else — no recaps, no generated replies, since there's
no programmatic access to the messages. Microsoft also blocks sign-in from
some embedded browsers, so it may simply refuse to load. Only worth doing
if seeing mail in-app has value on its own.

## Privacy posture

Whatever the route, keep the ROADMAP constraint intact: mail is cached
locally, nothing goes to a model on a timer, and a thread reaches
Claude/OpenAI only when you click "draft a reply" or "recap my day" on it.
Drafts are written back as drafts. The app never sends.
