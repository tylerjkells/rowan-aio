import { useEffect, useState } from 'react'

/** release notes shown once after an update lands (auto-updates are silent) */
const NOTES: Record<string, string[]> = {
  '0.22.2': [
    'Recordings really do play and skip around now. The 0.22.1 fix loaded a recording into memory so that seeking would be instant, but the app’s own security policy blocked it from doing that, so every meeting quietly fell back to the slow path the fix existed to replace — and that path cannot jump ahead in a long recording at all. It waits for the audio to arrive in order, which on a 55-minute meeting never finishes. Checked end to end this time, against a recording the size of a full hour.'
  ],
  '0.22.1': [
    'Meeting recordings actually play now. Audio that stopped a few seconds in was the app answering the player’s request for the end of the file with the beginning of it, so the player never learned how long the recording was.',
    'Skipping around a recording no longer stalls. The whole file is loaded up front instead of being re-fetched on every jump, so scrubbing lands where you dropped it — and dragging the seek bar now seeks once, when you let go, rather than on every pixel of the drag.'
  ],
  '0.22.0': [
    'Your Outlook inbox now lives in Rowan. Rowan University won’t let any app read mail without an administrator’s approval, so mail arrives a way that needs nobody’s permission: a Power Automate flow you own files each message into OneDrive, and Rowan reads it off your own disk. Settings → Mail has a full setup guide with every expression ready to copy.',
    'Draft a reply to any email with what Rowan knows behind it: who the sender is, what they still owe you, what you owe them, which meetings you shared. That is a draft no mail client can write. Add a steer (“push it to next week”) if you want one. Drafts land in Outlook for you to review, and Rowan never sends mail itself.',
    'Summarize any email in a few lines, for deciding whether it needs you at all.',
    'A morning brief on Today covering yesterday, overnight, and the day ahead. It pulls together your calendar, what arrived in the inbox, your open action items, and anything due in ClickUp, then writes itself once a day after 8am whether or not the app was closed overnight.',
    'Anything the app writes for you now follows house rules: no em dashes, no “delve” or “leverage”, no tidy summarizing sign-off. Drafts should read like you typed them.',
    'Create a ClickUp task straight from the Projects page with the New task button, instead of only from a meeting’s action items. Any email can become a task too.'
  ],
  '0.21.2': [
    'Tasks pushed to ClickUp no longer advertise the app: the description now reads “From meeting: …” with just the plain meeting title, so coworkers see where the task came from without any mention of Rowan AIO.'
  ],
  '0.21.1': [
    'Fixed “Streaming is required for operations that may take longer than 10 minutes” when summarizing with Claude — responses now stream under the hood, so long meetings summarize instead of erroring.',
    'Notifications are withdrawn when the app quits, so a leftover “Meeting started — record it?” toast can no longer open a broken window.'
  ],
  '0.21.0': [
    'Prep notes take attachments: “Attach files…” in the prep dialog adds screenshots (shown as thumbnails wherever the note appears — Today, the calendar tooltip, the Record screen) and any other files as chips that open in their own app.',
    'Silence no longer hallucinates: Whisper’s made-up lines on quiet audio — “Subs by www.zeoranger.co.uk”, “Thanks for watching”, stray “Uh.” — are recognized and dropped from live and final transcripts.'
  ],
  '0.20.1': [
    'Prep notes follow you into the meeting: when you open the Record page during (or just before) a calendar event, that event’s “before the meeting” note is displayed right there — before you hit record and while recording.'
  ],
  '0.20.0': [
    'Plan ahead for meetings: click any upcoming event on the Library calendar (or the “+ Prep” chip on Today’s schedule) to jot “before the meeting” notes — numbers to pull, questions to raise. The note shows under the event on Today with a gold dot on the calendar, stays private to you, and never touches the AI summary.',
    'Keep computer awake (Settings → System): an invisible one-pixel mouse nudge every minute or two stops Windows from locking and Teams from marking you Away. Optionally follow a daily schedule — active hours plus a break — so it switches itself off after work.',
    'Long-meeting summaries breathe again: the output budget grew by half, fixing “ran past the output limit” errors on hour-long recordings.',
    'Summaries with Sonnet or GPT-5.1 now skip the Haiku-era fact-check pass — premium models are accurate on their own, so important-meeting summaries cost roughly half the tokens. Haiku keeps the full double-check.',
    'The SQL query editor is properly resizable: drag its corner to make the window wider or taller, and the SQL box grows with it.'
  ],
  '0.19.3': [
    'Settings → Team directory now folds the roster behind a count — click “47 people” to expand it instead of scrolling a long list.',
    'The app window declares its own icon to Windows, so the taskbar shows the Rowan R even where the shortcut icon cache still remembers the old one.'
  ],
  '0.19.2': [
    'Action-item due chips no longer say the date twice: “August 24 · Aug 24” collapses to just “Aug 24”, while relative phrasings like “before Monday · Sep 9” keep both halves.'
  ],
  '0.19.1': [
    'The meeting header’s info line keeps its shape with a long participant list: items wrap between chips instead of squeezing each one into a two-line smear.'
  ],
  '0.19.0': [
    'Bulk-load your SQL library: Toolbox → SQL → “Upload .sql files” takes any number of .sql or .txt files at once — each becomes a saved query named after its file, and re-uploading a file with the same name updates that query in place.'
  ],
  '0.18.0': [
    'Rowan AIO has a real icon now — Rowan Brown badge, gold R — and it finally shows up in the Windows taskbar instead of the stock Electron logo (the old icon lacked the 256px frame Windows wants).',
    'The window titlebar follows your theme: pick Paper, Notion, or iOS and the frame goes light instead of staying dark.',
    'Set who was in a meeting: click the “with …” chip in a meeting’s header (or “+ participants” when empty) to add people with directory suggestions, remove them, or pull the list straight from the matching Outlook calendar invite. Participants help speaker identification and summaries get names right.',
    'The SQL query editor opens near-full-width with a taller editing area — no more squinting at 60-character lines.'
  ],
  '0.17.0': [
    'Toolbox gains a SQL tab: save the queries you reuse (name, notes, and the SQL itself), expand one to read it, and copy it with a click.',
    'Completing a ClickUp task now asks for a short closing note first — it posts to the task’s thread as a comment, then the task moves to done. “Done without comment” stays available for the rare exception.',
    'Change a task’s status right from Projects: expand a row and pick any status from its list — including Cancelled — not just complete.',
    'Status dots in Projects now say what they mean: the status name sits next to the colored dot.',
    'The calendar shows Monday through Friday only — no more empty weekend columns.'
  ],
  '0.16.1': [
    'Action items can be assigned to several people from the owner picker: type a comma and pick the next name — already-listed people are filtered out, and the result reads “Carol Primas-Young, Andrew Bunoza”.',
    'Person merges can no longer tangle: merging A into B after B had been merged into A used to corrupt the identity map (cards opening under the wrong name); merges now flatten cleanly, and a wrong-direction merge is fixed by simply merging back.',
    'The auto-updater and the About link now point at the renamed rowan-aio repository directly instead of relying on GitHub’s redirect.'
  ],
  '0.16.0': [
    'MeetingScribe is now Rowan AIO — one app for your work at Rowan, with meetings as one module among several. Your library, settings, and updates carry over untouched.',
    'People is a full org directory now: titles, contact info, and reporting lines; an Outlook-style org chart you click through; a one-time CSV import that loads the whole org; renames that keep meeting history; and search.',
    'Projects connects to ClickUp (Settings → ClickUp, personal API token): every open task assigned to you grouped by due date or by project, complete/re-date/comment without leaving the app, a Mine/Everyone view, and an Activity changelog of what changed since you last looked.',
    'Meeting action items gain a “→ ClickUp” button — pick a list and the item becomes a real ClickUp task with assignee and due date mapped, then shows “In ClickUp ↗” so nothing gets pushed twice.',
    'Links: your org link hub, grouped by collapsible category, with pins that also appear on Today — as a compact list or as cards with thumbnails (upload a screenshot, or auto-capture the page).',
    'Brand: the Rowan brand guide built in — every palette with hex, RGB, and Pantone, click-to-copy swatches, and add/edit for colors of your own.',
    'Toolbox: upload the Word-doc guides you work from (every step is click-to-copy, so LOD calcs and formulas lift right out — and guides are editable in place), keep reusable dashboard images that copy straight to the clipboard for Tableau, and store templates you can save fresh copies of anytime.',
    'Ask now answers across everything: meetings, the directory, links, brand colors, and your ClickUp tasks.',
    'Today is the full hub: your schedule with briefs, pinned links, today’s recordings, open action items, and ClickUp tasks due.',
    'Choose your AI service: Claude or ChatGPT, with both keys storable side by side and per-provider model picks (Settings → AI provider).',
    'Two new themes — Notion (flat white, hover-reveal rows) and iOS (grouped cards, pill buttons, green switches) — plus a jump nav on the Settings page.'
  ],
  '0.15.0': [
    'Fix the transcript itself: hover any line to edit it in place, delete it, or delete everything from that line to the end — perfect for cleaning up a recording you forgot to stop. Then hit Regenerate summary and the notes catch up.'
  ],
  '0.14.0': [
    'Pick a model per meeting: summaries default to Claude Haiku (cheap), and the Regenerate button now has a ▾ menu to rerun any single meeting with Sonnet or Opus when the details really matter.',
    'Forgot to end a recording? Long stretches of office noise used to produce garbled repeated text that could break the summary entirely — that text is now cleaned up automatically and summaries have more room to breathe.',
    'Clicking a “Meeting started — record it?” notification now reliably opens the app, even when it had been sitting in the tray for a long time.'
  ],
  '0.13.1': [
    'Shared action items now list everyone who took them on (“Caroline, Andrew, Brian”) in a single row — each person still sees the task under their own name in the Action items view, and nobody gets dropped.'
  ],
  '0.13.0': [
    'See what summaries cost: Settings now shows your Claude usage this month and last, priced from actual token counts and tracked entirely on this machine.',
    'Sturdier fact-checking: the verification pass can no longer shorten a summary or drop a person from the action items — if it tries, the original draft wins.',
    'Honest model guidance: for meetings where the details matter, Claude Sonnet is now the recommended summary model in Settings — Haiku stays the budget pick.'
  ],
  '0.12.2': [
    'Sharper fact-checking for summaries: numbers, dates, thresholds, and who-owns-what are now extracted from the transcript with their exact quotes first, and the summary is corrected against that list — so figures keep their context, partial dates stay as spoken, and tasks stay with the person who took them.'
  ],
  '0.12.1': [
    'Summaries are now fact-checked: after the draft is written, a second pass re-reads it against the transcript and fixes slipped numbers, drifted thresholds, unstated dates, and duplicated action items before you see it. Summaries cost roughly twice as much per meeting (still cents) and take a bit longer.'
  ],
  '0.12.0': [
    'Fix speaker labels in place: after Identify speakers, click any “Speaker 1”-style label (or a wrong guess) in the transcript and pick the right person — every line with that label is reassigned at once.',
    'Summaries now know the meeting date, so deadlines stay in the speakers’ own words (“in three weeks”) instead of being turned into invented calendar dates, and explanations are only reported when someone actually said them.',
    'The meeting page is centered and a bit wider, so large windows show longer lines instead of empty space on the right.'
  ],
  '0.11.1': [
    'Sharper summaries: action items are consolidated and tracker-ready (no more per-person duplicates or “ongoing” due dates), dates and figures stay consistent across sections, numbers keep their filter context, and meeting mechanics like screen-share hiccups are left out.'
  ],
  '0.10.0': [
    'Auto-end: a recording you walked away from stops itself — after a stretch of silence, or once it runs past the end of its calendar event. You get a 30-second warning with a “Keep recording” button, and the timings are in Settings → Auto-end recordings.',
    'Bulk import: Import → Bulk import takes a whole Notion export (.zip or the unzipped folder) or any folder of .md/.txt transcripts. Titles, dates, and attendees come from the page properties, anything already imported is flagged, and summaries run one at a time in the background.'
  ],
  '0.9.0': [
    'Claude app connection: Settings → Claude app links your meeting library to Claude Desktop (read-only, local MCP server). Ask Claude about your meetings, have it build reports from them, or create tasks in connected tools like ClickUp.',
    'Calendar columns stay aligned no matter how long event titles get.'
  ],
  '0.8.0': [
    'Live notes: type during a recording — they sharpen the summary and stay editable on the meeting page.',
    'Full calendar: the Library’s month view now shows your whole schedule (toggle with the Schedule chip).',
    'Always on: closing hides to the tray, launch-at-login optional, and Ctrl+Alt+R opens Record from anywhere.',
    'Backups: back up the library on demand or weekly to a folder — see Settings.',
    'Overdue awareness: dated action items sort by urgency and turn red when overdue.'
  ]
}

export function WhatsNew(): React.JSX.Element {
  const [version, setVersion] = useState<string | null>(null)

  useEffect(() => {
    window.scribe.appVersion().then((v) => {
      const seen = localStorage.getItem('seenVersion')
      if (!seen) {
        // fresh install: nothing to announce
        localStorage.setItem('seenVersion', v)
        return
      }
      if (seen !== v) {
        if (NOTES[v]) setVersion(v)
        else localStorage.setItem('seenVersion', v)
      }
    })
  }, [])

  if (!version) return <></>

  function dismiss(): void {
    localStorage.setItem('seenVersion', version!)
    setVersion(null)
  }

  return (
    <div className="digest-overlay" onClick={dismiss}>
      <div
        className="digest-box whatsnew-box"
        role="dialog"
        aria-modal="true"
        aria-label="What's new"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="digest-head">
          <h2>New in v{version}</h2>
          <button className="btn btn-ghost askw-close" onClick={dismiss} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="digest-body">
          <ul className="digest-list">
            {NOTES[version].map((note, i) => (
              <li key={i}>{note}</li>
            ))}
          </ul>
          <div className="whatsnew-actions">
            <button className="btn btn-primary" onClick={dismiss}>
              Nice
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
