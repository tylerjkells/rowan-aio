# Master Plan: from MeetingScribe to the AIO Rowan Tool

*Drafted August 2026, from Tyler's braindump + planning session. ROADMAP.md is
chapter one (the meeting companion) and is nearly complete; this document is
chapter two: growing the app into a work "second brain" for everything at Rowan.*

## Vision

One app that handles the whole workday: meeting capture and memory (already
built), a hub for org links and dashboards, a real org directory, project
management wired to ClickUp, branding/dashboard tooling, and one AI assistant
that can answer across all of it.

## Decisions locked in

1. **Evolve this codebase** — MeetingScribe becomes the master app.
   "Meetings" becomes one module among several; nothing that works gets
   rebuilt. Every new module inherits the store patterns, encrypted settings,
   Ask retrieval, MCP server, backups, and the auto-update pipeline for free.
2. **Local-first, single-user** — the privacy story stays intact (usable
   around student data, no backend to run). Sharing is export-based where
   needed.
3. **ClickUp companion, not replacement** — the Project Planner is a UI over
   the ClickUp API. ClickUp remains the team's source of truth; the app
   reads, creates, updates, and automates against it.

## A note on renaming

The braindump title is "AIO Rowan Tool" — the display name, icon, and
branding can change whenever a real name lands. But **keep the internal
identity stable**: `appId`, repo name, and the `%APPDATA%\meeting-scribe`
data folder are what the auto-updater and existing library key off. Rebrand
the surface, not the plumbing. (A data-folder migration is possible later if
it ever matters; it isn't worth the risk now.)

## Phase 0 — The shell (small, do first)

Turn the flat sidebar into a grouped, module-based nav:

- **Today** stays the home screen, and grows into the whole-app dashboard
  over time (open tasks from ClickUp, pinned links, meetings — the "start
  your day here" page).
- **Meetings** group: Library, Actions, Series (existing views, unchanged).
- **People** group: seeded by the existing People module (grows in Phase 2).
- New top-level entries appear as their modules land: **Links**,
  **Projects**, **Toolbox**.

Mechanically this is modest: the `View` union in `App.tsx` grows, the sidebar
gets section headers, and each new module gets its own store file alongside
the meetings store. New stores join the existing backup zip.

## Phase 1 — Quick wins: Link Hub + Brand Guide

Two simple data-plus-UI modules that deliver daily value immediately and
establish the pattern for every module after them.

### Link Hub ("Org Links")

- Categories (Dashboards, Data Centers, …), user-defined and reorderable.
- Each link: name, URL, category, optional note; opens in the default
  browser; copy-link button; search; pinned favorites surfaced on Today.
- Store: `links.json`. Exposed to Ask and the MCP server ("what's the link
  to the enrollment dashboard?").

### Brand Guide ("Rowan color branding")

- Pre-seeded from the Rowan branding doc: named colors with hex + RGB,
  large swatch previews, one-click copy in either format.
- Add, edit, and remove colors; group into palettes (primary, secondary,
  data-viz-safe, …).
- Later growth: fonts, logo usage notes, and asset files (which is where the
  image directory from the Toolbox phase plugs in).
- Store: `brand.json`.

## Phase 2 — Company Directory

Grow the existing People module from "colleagues seen in meetings" into a
real org directory:

- Per-person fields: title, department, email, phone, office, reports-to,
  personal links (their dashboards, calendars), free-form notes.
- Bulk import from CSV (an Outlook/GAL export) on top of the existing
  auto-enrichment from meeting attendees, action-item owners, and named
  speakers — the meeting history *is* the moat here; no other directory
  knows what each person owns and owes.
- Department/team grouping views; Ask coverage ("who runs the data
  centers?", "who do I know in IT?").

## Phase 3 — Project Planner (ClickUp companion)

The biggest single piece. Built on the ClickUp API with the same encrypted
key storage used for the Claude key.

- **Read**: my tasks across the workspace, project/list boards, statuses,
  due dates — surfaced in the app and on Today.
- **Write**: create and update tasks from the app page ("automate ClickUp
  from app page", per the braindump).
- **The bridge**: push meeting action items into real ClickUp tasks with
  owner and due-date mapping — this closes the "Native task push" item that
  ROADMAP.md tabled, and it's the feature that makes the whole app cohere:
  a meeting happens, commitments are captured, and they land in the team's
  actual tracker with one click.
- **Prerequisite**: the workspace-mapping exercise the roadmap flagged —
  which ClickUp spaces/lists map to which kinds of work, and how owners map
  to ClickUp members. Do this deliberately at the start of the phase.
- Later: automation recipes ("when a meeting in series X is summarized,
  draft its action items as tasks for review").

## Phase 4 — Toolbox (dashboard tools)

The most exploratory cluster; each deserves its own short design pass when
its turn comes.

- **Image directory** — a managed folder of approved images/assets with
  previews and one-click copy-to-clipboard for dropping into dashboards and
  docs. Natural companion to the Brand Guide.
- **Tableau templates** — starter workbooks/style templates carrying the
  brand guide's colors; possibly just well-organized files with preview and
  copy-out, possibly generated.
- **Mockup & Guide creator** — import a requirements doc, get a draft
  mockup/spec out (Claude-powered). Biggest unknown; prototype before
  committing to a shape.
- **Research input**: survey other university/internal tools (braindump
  item) before designing this phase.

## Cross-cutting, throughout

- **Ask everywhere** — extend the Ask widget's catalog beyond meetings to
  links, directory entries, brand colors, and ClickUp tasks, so one
  assistant answers across the whole app. Same two-stage retrieval pattern.
- **MCP server** — each module's data gets read tools, so Claude Desktop
  can also work across everything.
- **Today as the hub** — each phase adds its "what matters right now" slice
  to Today: pinned links, due ClickUp tasks, and so on.
- **Backups, What's New, typecheck discipline** — unchanged, new stores
  included.

## Recommended order and why

**Shell → Link Hub + Brand Guide → Directory → Projects → Toolbox.**

The shell is cheap and unblocks everything. The Phase 1 modules are the
fastest path from "meeting app" to "the app I keep open all day," and they
prove the module pattern on low-stakes data. The directory builds directly
on People. Projects goes next-to-last not because it matters least but
because it depends on the ClickUp mapping exercise and deserves the app
already feeling like a hub. The Toolbox is last because it's the least
defined and loses nothing by waiting.

## Open questions (for future sessions)

- The real name (display-level rebrand only — see naming note above).
- Source material for seeding the Brand Guide (the Rowan branding doc) and
  the exact color list.
- The ClickUp workspace map: spaces, lists, members, and which of Tyler's
  workflows should be automated first.
- What "Tableau template" concretely means — files, generation, or both.
- Whether the Meeting Notes experience needs anything new once it's a
  module among peers (probably not — it's the mature one).
