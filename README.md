# Rowan AIO

The all-in-one work hub: meeting capture and memory, an org directory with an
org chart, a ClickUp companion, an org link hub, the brand guide, and a
toolbox of guides, images, and templates — local-first, private, no
subscription. (Formerly MeetingScribe; the meeting companion below is now one
module of several.)

## The workspace

- **People** — a full org directory: titles, departments, contact info, and
  reporting lines, browsable as an Outlook-style org chart. Load the whole org
  from a CSV export in one import; every person is auto-enriched with their
  meeting history, what they own, and what you owe them.
- **ClickUp** — a ClickUp companion (personal API token, stored encrypted):
  every open task assigned to you grouped by due date or project, search,
  complete / re-date / re-prioritize / reassign / rename / comment in place
  with the task's recent comments shown, a Mine/Everyone scope, quiet
  auto-refresh, and an Activity changelog built by diffing refreshes with an
  unread badge. Any list opens as a list or a status board (Everyone or Just
  me), with subtasks as their own cards or folded inside their parent. Meeting action items and emails push to real ClickUp tasks
  with assignee, due date, and the list's Requestor field mapped.
- **Mail** — an inbox mirror fed by a Power Automate flow into a synced
  OneDrive folder (no mailbox credentials): threads grouped by conversation,
  automated mail and handled mail tucked away behind toggles (mark handled one
  at a time, by selection, or a whole day at once), full-text
  search, AI summaries and drafted replies that land in Outlook Drafts, one
  click to a ClickUp task or a colleague's People page, and a warning when
  the flow goes quiet.
- **Tickets** — your ServiceNow incidents, pasted in from the JSONv2 list
  (copy the page, click Apply from clipboard): triage into Now / Next / Later /
  Waiting, a next step and private notes per ticket, flags for "no reply yet",
  "they replied", "updated" and "quiet 30+ days", the cleaned-up comment
  history, copy-as-link ticket numbers for Outlook/Teams/Webex, and a monthly
  recap of closed tickets ready to paste into email. A Service report view
  covers the whole RO Operations group: opened vs resolved, the open queue
  over time, median time to resolve and to first reply, each team member's
  resolved and open work, how tickets ended, request types, top requesters,
  the open queue by age and status, and the open tickets that need attention,
  for a week, a month, month to date or 12 months, each against the period
  before. Click any bar or name to filter the whole page to it; a full-screen
  Present mode keeps the filters. Nothing is written back to ServiceNow.
- **Action items** — every follow-up from every meeting in one place: dated
  items grouped by when, undated ones grouped by meeting, stale ones folded
  away for a bulk review. Done, dismissed, and snoozed are kept apart; select
  several to act at once; push any item to ClickUp.
- **Links** — the org link hub, grouped by category with pinned favorites that
  also appear on Today; compact list or thumbnail cards (upload a screenshot
  or auto-capture the page).
- **Brand** — the Rowan brand standards built in: every palette with hex, RGB,
  and Pantone, click-to-copy swatches, editable and extendable.
- **Toolbox** — Word-doc guides rendered in-app with click-to-copy steps (and
  in-place editing), reusable dashboard images that copy straight to the
  clipboard for Tableau, and stored templates you can save fresh copies of.
- **Ask everywhere** — the floating assistant answers across meetings, the
  directory, links, brand colors, and your ClickUp tasks.
- **Choose your AI** — Claude or ChatGPT power summaries and Ask; both keys
  storable, per-provider model picks.
- **Six themes** — including Notion and iOS looks that restyle components,
  not just colors.
- **Your tabs** — Settings → Tabs switches any sidebar tab off (Today and
  Settings stay), so tools you haven't set up stay out of the way.

## The meeting companion

- **Record** in-person meetings (your mic) or virtual meetings (your mic **plus** system audio — whatever comes through your speakers/headset from Webex, Teams, Zoom, anything).
- **Transcribe** on your own machine with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). Audio never leaves your PC. $0, forever.
- **Summarize** with the Claude API (pay-per-use — typically 1–5 cents per meeting with Haiku): TL;DR, key points, decisions, action items with owners/due dates, and open questions. Meetings are auto-titled from their content.
- **Claude app connection** — one click in Settings links your library to Claude Desktop through a local, read-only MCP server. Claude can then answer questions about your meetings, build reports and spreadsheets from them, or create tasks in tools you've connected to Claude (like ClickUp).
- **Ask anything** — a floating assistant on every page. On a meeting page it answers from that meeting's transcript; anywhere else it answers across your whole library ("What did we decide about X?", "What has David committed to?") with citations that jump to the exact transcript moment.
- **Action items rollup** — every follow-up across all meetings in one checklist, with done-tracking.
- **People** — a page per colleague: every meeting together, everything they own, and everything you owe them, assembled automatically from owners, attendees, and named speakers.
- **Weekly digest** — a Monday prompt with last week's meetings, your open items, anything languishing 2+ weeks, and who owes what.
- **Meeting series** — recurring meetings self-assemble into threads (recordings inherit their calendar event's title): decisions over time, everything still open across the series, and the full occurrence history.
- **Speakers** — virtual meetings label you vs. the call automatically; an experimental "speaker turns" engine option sharpens the boundaries, and "Identify speakers" attributes lines to named people from context — so in-person meetings get speakers too.
- **Live notes** — type notes while recording (crash-safe, editable afterward); they're folded into the summary as high-signal context.
- **Month calendar** — the Library's calendar view shows your full schedule: scheduled events from the feed alongside recorded meetings.
- **Today view** — the home screen shows today's calendar (connect any Outlook/Google calendar via its secret iCal address, read-only), today's recordings, and your open action items. Recordings started during a calendar event are titled after it, and each event carries a pre-meeting brief — what was decided last time, which follow-ups are still open, and unresolved questions — pulled from the most recent related meeting in your library.
- **Record nudge** — a system notification when a calendared meeting starts and nothing is recording, so you never lose a meeting to a forgotten record button. One click lands you on the Record page.
- **Auto-end** — a recording you walked away from stops itself: after a stretch of silence, or once it runs past the end of its calendar event. Both rules warn for 30 seconds first ("Keep recording" overrules them), a deliberate pause never counts as silence, and you get a notification when one fires. Timings live in Settings.
- **Bulk import** — move a whole archive in at once: hand the app a Notion export (`.zip` or the unzipped folder) or any folder of `.md`/`.txt` transcripts and it reads every page — titles, dates, and attendees come from the page properties. You review the list (anything already imported is flagged), and summaries run one at a time in the background.
- **Follow-up email** — one click drafts a recap right in the app (TL;DR, decisions, action items with owners, open questions); edit it, copy it, paste it into any mail client.
- **Color schemes** — Studio (default), Rowan (brown & gold), Slate (cool blue), and Paper (light), switchable in Settings.
- **Always on** — closes to the tray, optionally launches at login, and Ctrl+Alt+R opens the Record page from anywhere.
- **Backups** — one-click library backup, plus automatic weekly backups to a folder of your choosing (last 8 kept, audio optional).
- **Overdue awareness** — free-text due dates ("Friday", "July 21") are parsed into real dates, so action items sort by urgency and overdue ones show red.
- Pause/resume while recording, search the library (press `/`), copy summaries as Markdown, export full meetings to `.md`.

## Running in development

```powershell
npm install
npm run dev
```

## Building the installer

```powershell
npm run dist
```

Produces a Windows installer and a portable `.exe` under `release/`.

## First run

1. The app downloads its speech engine (whisper.cpp) and a language model (~550 MB total) on first use. One time only.
2. To enable AI summaries, paste a Claude API key in **Settings** (get one at [console.anthropic.com](https://console.anthropic.com)). The key is stored encrypted with Windows DPAPI. Without a key you still get full transcripts.

## Where your data lives

Everything is stored locally under `%APPDATA%\meeting-scribe\` (the folder
keeps the app's original internal name so updates and existing libraries
carry over):

- `meetings\<id>\meeting.json` — metadata, transcript, summary
- `meetings\<id>\audio.webm` — compressed audio for playback
- `engine\` — whisper.cpp binary and models
- `directory.json`, `links.json`, `brand.json`, `link-thumbs\`, `toolbox\`,
  `tickets.json`, `team-tickets.json` — the workspace modules
- `clickup-activity.json` — the local ClickUp changelog snapshot

Delete a meeting in the app (or delete its folder) and it's gone. There is no cloud copy.

## Architecture

| Piece | Tech |
| --- | --- |
| Shell | Electron + electron-vite, React 19, TypeScript |
| Mic capture | `getUserMedia` |
| System audio | Electron display-media handler with `audio: 'loopback'` (WASAPI loopback) |
| Recording | Web Audio graph → webm/opus (playback) + 16 kHz WAV via AudioWorklet (transcription) |
| Transcription | whisper.cpp `whisper-cli.exe`, models from Hugging Face |
| Summaries | `@anthropic-ai/sdk`, structured outputs (JSON schema), default `claude-haiku-4-5` |
