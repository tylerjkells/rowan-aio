# Rowan on the phone

A web app you add to your iPhone's Home Screen. It opens full screen like any
app, with no App Store and no developer fee. It talks to the same sync hub as
your PCs (see [SYNC.md](SYNC.md)), so it shows the same library and its edits
reach your PCs within a minute.

**Address:** https://tylerjkells.github.io/rowan-aio/

## Installing it

1. On the iPhone, open the address above in **Safari**.
2. Sign in with your sync account (the one in Settings → Sync on your PC).
3. Tap **Share → Add to Home Screen**.

The Home Screen app keeps its own sign-in, separate from Safari, so sign in
again the first time you open it from there.

## What it does

The tab bar holds Today, Meetings, Record and Action items; **More** has the
rest. On a wide screen (an unfolded phone, an iPad, a phone in landscape) a
sidebar lists every section instead, like the desktop, and Meetings, People and
Tickets show the list beside the open item. Sections switched off in the
desktop's Settings → Tabs are hidden here too.

- **Today:** a big Record button, phone recordings waiting on your PC, what's
  due this week (with a count of overdue items that opens Action items), the
  Planner's Now column, recent meetings.
- **Meetings:** search titles, summaries and notes; open one for the summary,
  action items (check them off), notes (edit them; they autosave), discussion
  topics, decisions, open questions and the transcript. Rename it by tapping
  the title. "Play recording" plays the audio when the hub still has it.
- **Action items:** every open one across your meetings, grouped overdue /
  this week / later / no date, with a Mine filter.
- **Planner:** Now / Next / Waiting / Later / Done; add items, tick steps, add
  a progress note, move or finish an item.
- **People:** the team directory; a person's page has Email, Call and Teams
  buttons, who they report to and who reports to them, their open action items
  and the meetings you had together.
- **Tickets:** your ServiceNow incidents by plan (Now / Next / Waiting /
  Later), with the desktop's "They replied", "No reply yet" and "Quiet 30+
  days" flags; set a ticket's plan, next step and notes, read its history, open
  it in ServiceNow.
- **Links** and **Dashboards:** open in Safari, which keeps its own sign-ins.
- **Toolbox:** read guides, view images, copy saved queries, open template files.
- **Brand:** the palettes; tap a color to copy its hex code.
- **Record:** see below.

Mail and ClickUp stay on the PC: mail isn't synced (each PC reads its own
OneDrive copy of the mailbox), and ClickUp needs the token kept on the PC; both
have their own iPhone apps.

It fits the screen it's on: short screens tighten up, a landscape phone drops
the tab labels, and a wide screen (an unfolded phone, an iPad) shows Today in two
columns and the meetings list beside the open meeting. It keeps clear of the
notch, the home bar, and a status column down the side where a phone has one.
It follows the theme you picked on your PC. The last things it loaded stay
on the phone, so it still opens offline (with a note saying so); edits need a
connection.

## Recording

Tap Record, set the phone down with Rowan open, and tap Stop when you're done.
The recording goes to the hub, and **one of your PCs** downloads it,
transcribes it with the same engine as everything else, and writes the
summary; the finished meeting then appears on the phone. Notes typed while
recording go with it.

- **Keep the app open with the screen on.** Rowan keeps the screen from
  sleeping while it records. iOS stops a web app's microphone when the phone
  locks or you switch apps; Rowan keeps everything recorded up to that moment
  and says so.
- **For long meetings or with the phone locked**, record in Voice Memos, then
  tap Share → Save to Files, and in Rowan tap Record → *Choose a recording…*.
  It goes through the same steps.
- Audio is saved on the phone every few seconds while recording, so if iOS
  closes the app, nothing but the last few seconds is lost: the recording
  waits under *Not sent yet*.
- If you're offline when you stop, it waits under *Not sent yet* with a Send
  button.
- The hub takes files up to 50 MB: about 2 hours 20 minutes of phone audio.
- A PC has to be on to transcribe. If none is, the recording waits in the hub
  until one is.

### How a PC picks it up

The phone uploads the audio, then creates the meeting with the stage
`uploaded`. On its next sync pass a PC downloads the audio (whatever the audio
window is set to) and claims the meeting: the claim is an ordinary sync push,
so the hub's revision check lets exactly one PC win. That PC decodes the audio
in its window, the same way "Re-transcribe" does, and runs the normal
pipeline. A PC that claimed a recording and then went quiet for three hours
loses it to another. A recording that can't be decoded is marked "needs
attention" rather than retried forever.

## Hosting and updates

The phone app is a static site built from `mobile/` into `out/mobile` and
published to GitHub Pages by `.github/workflows/phone.yml` on every push to
`main` that touches it. Pushes to `claude/*` branches build it (to catch a
broken build) but don't publish, since there is one live site.

**One-time setup:** repo Settings → Pages → Source: **GitHub Actions**.

A new version reaches phones the next time the app is opened online.

## Working on it

- `npm run mobile:dev` serves it at http://localhost:5180 with live reload. A
  phone on the same network can open it, but iOS only allows the microphone
  on https, so test recording on the published site.
- `npm run mobile:build` builds `out/mobile`.
- The hub address comes from `src/shared/hub.ts`; until it's set there, the
  sign-in screen asks for a hub address and key.
