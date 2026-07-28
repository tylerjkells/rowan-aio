# Roadmap

The goal: turn MeetingScribe from a meeting recorder into a day-to-day companion — the app
that briefs you before a meeting, remembers what was promised months ago, and chases the
follow-ups. Useful *before* the meeting, *between* meetings, and *across* all of them.

Guiding constraint throughout: **transcripts and audio stay local**. Only what you explicitly
send (a summary, a task, an email draft) ever leaves the machine. That's what makes the app
usable in meetings that touch student data.

## 1. Cross-meeting memory

- [x] **Library-wide Ask** — ask questions across every meeting, answered with citations that
      link back to the source meetings (v0.3.0). Uses two-stage retrieval: a cheap pass over a
      compact catalog picks the relevant meetings, a second pass answers from their transcripts.
- [x] **Person pages** — a People tab with one page per colleague: meetings together, action
      items they own (with done-tracking), and your own open commitments from shared meetings.
      Built from action-item owners, calendar attendees, named speakers, and the team
      directory (v0.7.0).
- [x] **Threads / series** — meetings sharing a title form a series automatically (recordings
      inherit calendar event titles, so recurring meetings self-assemble; rename to join
      manually). A chip on the meeting page opens the series: decisions over time, everything
      still open across the series, and the occurrence timeline (v0.7.0).

## 2. Calendar awareness

- [x] **Calendar connection** (read-only) — any Outlook/Google calendar via its published iCal
      address; the URL is stored encrypted, polled from the main process (v0.4.0).
- [x] **Today view** — the launch screen: today's schedule with live-now marker and join links,
      today's recordings, open action items assigned to Me (v0.4.0).
- [x] **Auto-context on record** — a recording started during a calendar event inherits the
      event's title (v0.4.0). Still to come: attendee names pre-filling speakers.
- [x] **Pre-meeting briefs** — each Today event with a matching past meeting gets an expandable
      "Last met" brief: decisions, still-open action items with owners/dues, and open questions,
      built straight from the stored summary (no model call). The live/next meeting's brief
      auto-expands (v0.5.0). Later: LLM synthesis across multiple past occurrences.
- [x] **Record nudge** — system notification when a meeting with a call link or room starts and
      nothing is recording; clicking it opens the Record page. Toggle in Settings (v0.5.0).
- [x] **Month calendar** — the Library calendar view merges scheduled feed events (dashed,
      quiet) with recorded meetings (solid, clickable); events already recorded that day
      don't double up (v0.8.0).
- [x] **Live notes** — a notes box on the recording screen, stashed to disk as you type
      (crash-safe, survives navigation), attached to the meeting, editable afterward, and fed
      to the summarizer as high-signal context (v0.8.0).

## 3. Action items that leave the app

- [x] **Follow-up email draft** — a "Follow-up email" button on the meeting page opens an
      in-app, editable recap draft (TL;DR, decisions, action items with owners and dues, open
      questions) with copy buttons for subject and body — paste into any mail client (v0.6.0).
- [x] **Claude app connection (MCP server)** — one click in Settings registers a local,
      read-only MCP server with Claude Desktop exposing the library (list/get/search meetings,
      action items, people). Claude then handles the "action" side itself: reports,
      spreadsheets, and task creation in whatever tools the user has connected to Claude —
      including ClickUp (v0.9.0).
- [ ] **Native task push** — send an action item (owner, due date) to ClickUp / Microsoft To Do
      directly from the app, no Claude in the loop. *(Tabled: the team's ClickUp workspace
      needs a deliberate mapping exercise first; the MCP route covers the workflow meanwhile.)*
- [x] **Weekly digest** — a Monday prompt (open or dismiss, once per week) presenting last
      week's meetings, your open items, anything open 2+ weeks, and who owes what; also
      openable any day from the Today page (v0.7.0).

## 4. Capture fidelity

- [x] **Speaker diarization** (two layers, both opt-in, v0.7.0 — *needs on-device testing*):
      a "Small + speaker turns" transcription engine option (whisper.cpp tinydiarize) marks
      speaker-change boundaries, which also makes mic/system labeling turn-accurate; and an
      "Identify speakers" button on the transcript attributes lines to named people from
      conversational context via Claude (uses attendee/directory spellings, feeds discovered
      names back to the directory). True voice-print clustering stays out of scope — it needs
      an ML stack that doesn't bundle sanely into a local app.
- [x] **Vocabulary hints** — a user glossary in Settings (names, acronyms, program names) fed
      to Whisper as a decoding prompt (whole-file and live chunks) and to the summarizer as a
      spelling glossary (v0.7.0).

## 5. Daily-driver hardening

- [x] **Always-on** — close to tray, launch at login (hidden), global Ctrl+Alt+R record
      shortcut; the nudge and calendar stay on duty all day (v0.8.0).
- [x] **Backups** — on-demand zip backup plus weekly automatic backups to a chosen folder,
      pruned to the last 8; audio optional (v0.8.0).
- [x] **Real due dates** — free-text dues parsed into dates; urgency sorting and overdue
      flags across Action items, Today, People, Series, and the digest (v0.8.0).
- [x] **What's new** — a once-per-version card after silent auto-updates (v0.8.0).
- [x] **Auto-end recordings** — a recording stops itself after a stretch of silence, or once
      it runs past the end of the calendar event it started in. Both give a 30-second warning
      with a "Keep recording" button, both are configurable in Settings, and a deliberate
      pause never counts as silence. A recording that ends on its own raises a system
      notification, since the point is that nobody was watching (v0.10.0).
- [x] **Bulk import** — point the app at a Notion export (`.zip` or the unzipped folder), or
      any folder of `.md`/`.txt` transcripts: it reads every page, pulls titles, dates, and
      attendees from the page properties, flags anything already in the library, and imports
      the reviewed list. Summaries then run one meeting at a time in the background (v0.10.0).
- [ ] **Transcript redaction** — remove a sensitive span from the transcript, summary, and
      Ask context permanently.

## 6. Multi-device (future)

- [ ] **Data folder location setting** — point the app at a user-chosen folder so two PCs can
      share one library via Syncthing (peer-to-peer, keeps the privacy story intact) or
      OneDrive. Secrets stay per-machine (DPAPI is machine-bound by design). Avoid running
      both machines simultaneously.
- [ ] **Markdown auto-export** — write each summary to a synced folder of the user's choosing
      as the read-only phone story (OneDrive/Obsidian on mobile). User chooses what syncs;
      transcripts and audio stay home.
- [ ] **Mobile companion app** — someday-maybe; reading and in-person capture only.

## 7. Trust

- [x] **Privacy statement in-app** — a plain-language Privacy section in Settings stating
      exactly what leaves the machine and when (v0.7.0).
