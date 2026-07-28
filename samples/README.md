# Sample transcripts for testing

Six fictional but realistic meetings for exercising the app on a machine with no real
recordings — especially the library-wide **Ask** page, which needs several meetings with
overlapping topics before it gets interesting. There are six so the retrieval stage
(which only kicks in above four transcribed meetings) runs too.

Import each one via **Import a transcript**, pasting the file contents and setting the
title and date:

| File | Title | Date |
| --- | --- | --- |
| `01-enrollment-ops-weekly.txt` | Enrollment Ops weekly | 2026-06-16 |
| `02-enrollment-ops-weekly.txt` | Enrollment Ops weekly | 2026-06-30 |
| `03-david-1on1.txt` | 1:1 with David | 2026-07-01 |
| `04-gradebook-vendor-demo.txt` | GradeSync vendor demo | 2026-07-07 |
| `05-fall-campaign-sync.txt` | Fall campaign sync | 2026-07-08 |
| `06-msda-launch-planning.txt` | MS Data Analytics launch planning | 2026-07-10 |

(Titles will be overwritten by auto-titling if summarization runs — that's fine.)

Faster route: **Import → Bulk import → Choose a folder…** and point it at this `samples`
folder. It picks up all six in one pass. These files carry no date of their own, so every
row comes in flagged "no date found" on today's date — set the dates from the table above
in the review list before importing, otherwise the series and digest views have nothing
interesting to show.

Good questions to test Ask with afterwards:

- *What did we decide about the enrollment dashboard?* — the decision **changes** between
  the two weeklies (Power BI → Tableau), so the answer should reflect the June 30 position
  and ideally note the change, citing both meetings.
- *What has David committed to?* — spread across the weeklies and the 1:1.
- *Are we buying GradeSync?* — decision was deferred pending a pilot; Ask should say it's
  not decided yet.
- *When is the fall campaign launching and what's the budget split?* — single-meeting fact.
- *What's still open for the analytics program launch?*
- *Did we ever talk about parking?* — nothing covers it; Ask should say so instead of
  inventing an answer.
