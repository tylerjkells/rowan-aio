import { useEffect, useState } from 'react'

/** release notes shown once after an update lands (auto-updates are silent) */
const NOTES: Record<string, string[]> = {
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
