# Sync

Sync keeps a person's library the same on every PC they use, through a small
hub (a Supabase project). Every PC still keeps its full library on disk and
works offline exactly as before; sync mirrors it into the hub and folds in
what the person's other devices changed. Each person signs in with their own
account and can only ever see their own data.

## What syncs

| Syncs                                                                 | Stays on each PC                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Meetings: transcript, summary, notes, action items, tags, attendees   | Recordings older than the audio window (default 7 days)            |
| Recordings from the last N days (Settings → Sync), 50 MB per file max | Mail triage and the mail assistant's sorting (each PC reads its own OneDrive copy of the mailbox, which can lag; see below) |
| Planner, Tickets, team report, status update                          | API keys, ClickUp token, calendar URL (encrypted per Windows login) |
| People directory, Links (and thumbnails), Dashboards list, Brand      | Folders, speech model, startup/tray/keep-awake, auto-end, call detection |
| Toolbox: guides, images, templates, queries                           | Voice recognition prints (rebuilt per PC)                          |
| Ask history, prep notes and attachments, daily briefs                 | Usage stats, ClickUp activity feed, caches                         |
| Personal settings: your name, roster, aliases, vocabulary, summary instructions, AI provider and model, theme, tag colors, workday, hidden tabs, report names, mail signature | |

A meeting that is still recording, transcribing, identifying voices or
summarizing on a PC is not synced until it is done.

## How it works

- **One row per document.** Each meeting, each workspace file (planner.json,
  links.json, ...) and the portable settings are rows in `sync_docs`, with a
  revision number. Attachments and recordings are files in the private `sync`
  bucket, stored under a folder named for the person's user id.
- **A pass every minute**, a few seconds after a local change, and when the
  window comes forward: pull rows changed since the last pass, merge them into
  the local files, push what changed here.
- **Merging.** A push names the revision it was made from; the hub refuses it
  if someone else got there first, and the PC pulls, merges and pushes again.
  The merge is three-way against the last version both sides agreed on (kept
  gzipped in `sync/base`): edits to different fields both survive, planner
  items / links / toolbox entries merge item by item, lists of names merge as
  sets, and only the same field changed on both sides is decided, by the newer
  edit. Something edited on one PC and deleted on another is kept.
- **Deletions** reach other PCs, which move the item into `sync-trash` (kept 30
  days) rather than deleting it. If a pass would delete more than 5 items and a
  fifth of the library at once (a missing folder, a botched restore), sync holds
  them and Settings → Sync asks: delete everywhere, or bring them back.
- **Audio** from the last N days is uploaded so other PCs can play it; older
  recordings are removed from the hub (never from a PC). "Delete audio, keep
  notes" removes the recording on every PC. A meeting whose recording is on
  another PC says so where the player would be.

- **Phone recordings** arrive as meetings with the stage `uploaded`. A PC
  downloads their audio whatever the window, claims the meeting (an ordinary
  revision-checked push, so exactly one PC wins), and transcribes it like a
  re-transcribe. The hub keeps the audio until then. See [PHONE.md](PHONE.md).

Code: `src/main/sync/` (`engine.ts` does the work and knows nothing about
Electron; `merge.ts` is the merge; `hub.ts` talks to Supabase; `index.ts` wires
it into the app). Tests: `npm test`. Schema: `supabase/migrations/`.

## Setting up the hub (once)

1. **Create a Supabase project** (e.g. `rowan-aio`, region East US). On the free
   plan an organization can have two active projects.
2. **Create the schema**: run the files in `supabase/migrations/` in order in
   the project's SQL editor (or apply them with the Supabase MCP tools). Each is
   safe to run again.
3. **Sign-ups by approval only**: Authentication → Sign In / Providers → turn
   **on** *Allow new users to sign up* and turn **off** *Confirm email* (the
   built-in email can't reach people outside the Supabase organization). The
   database refuses any new account whose email wasn't approved first, so this
   doesn't open the hub to anyone else. Then Authentication → URL Configuration
   → **Site URL**: the phone app's address (`https://tylerjkells.github.io/rowan-aio/`).
   Any link Supabase emails (a confirmation, if *Confirm email* is ever on)
   lands there and signs the person in, instead of on `localhost:3000`.
4. **Make yourself the administrator**: create your account (see below, but
   for the very first one approve your email in the SQL editor with
   `insert into public.signup_allowlist (email) values ('you@example.com');`),
   then
   `insert into public.hub_admins (user_id) select id from auth.users where email = 'you@example.com';`
5. **Build it in**: Project Settings → API Keys → copy the project URL and the
   publishable key into `src/shared/hub.ts`. The key is public by design; every
   row and file is guarded by row-level security. (Until then, Settings → Sync →
   *Use a different hub…* takes the same two values.)

## Adding a person

People create their own accounts and pick their own passwords, but only with an
email an administrator approved first.

1. In Rowan, Settings → Sync → **Who can join** (shown to the hub's
   administrators): enter their email and **Approve**. Instructions to send them
   are copied to the clipboard (**Copy instructions** copies them again).
2. They open Settings → Sync on their PC, choose **create an account**, and
   enter that email and a password of their own (8+ characters). Or they do the
   same on the phone app's sign-in screen. Either way, the other device then
   just signs in.
3. The list shows when they joined. Each approval works once; **Withdraw**
   takes back one that hasn't been used.

How it's enforced: a trigger on `auth.users` (migration
`20261118190000_approved_signups.sql`) refuses any new account whose email has
no unused approval in `signup_allowlist`, and marks the approval used. It
applies to every way of creating an account, including the dashboard's *Add
user*, so approve an email before using that too. Approvals can only be read
or changed by people in `hub_admins`, which is edited by hand in the SQL editor.
Anyone who knows an approved email could claim it before its owner does, so
send the instructions promptly; the list shows when it was used.

- The first PC they sign in on uploads its library; any other PC that signs in
  to the same account gets all of it (and merges in whatever it already had).
- A PC's library stays linked to the first account that synced it: signing in
  there as someone else is refused.
- For test builds, use a separate account (e.g. `name+test@…`), since a test
  build has its own data folder.

**Changing a password**: Settings → Sync → *Change password…* on a PC, or
More → *Change password* on the phone.

**Forgotten password.** Supabase's built-in email only reaches members of the
Supabase organization, so reset it from the SQL editor:

```sql
update auth.users
set encrypted_password = extensions.crypt('new-password-here', extensions.gen_salt('bf'))
where email = 'person@example.com';
```

**Never delete a user** to "reset" them: their synced data is deleted with
them (the PCs keep their copies, but the hub's is gone).

## Space on the free plan

The free plan has 500 MB of database and 1 GB of file storage, shared by
everyone on the hub. Text is small (a meeting hour is roughly 0.15 MB, stored
compressed); recordings are about 29 MB per hour. With three people recording
about 8 hours a week each, keep the audio window at about a week. Settings →
Sync shows each person's share.

## Known limits

- **Mail triage** (handled, starred, read) and the mail assistant's sorting
  stay per PC. Each PC trims those records against its own OneDrive copy of the
  mailbox, which can lag a few minutes behind another PC's; syncing them as-is
  would let one PC's trimming undo another's marks. Making that safe needs a
  small change to how mail state is trimmed.
- A recording or attachment over 50 MB stays on its PC (Settings → Sync counts
  them).
- Recordings that aged out of the hub are not uploaded again if the window is
  later widened.
