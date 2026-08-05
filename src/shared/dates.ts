// ---------------------------------------------------------------------------
// Due-date parsing: action-item dues are free text from the summarizer
// ("July 21", "next week", "Friday", "EOD"). Parsing the common shapes into
// real dates lets the app sort by urgency and flag overdue items. Anything
// ambiguous returns null and the text stays display-only.
// ---------------------------------------------------------------------------

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
}

const WEEKDAYS: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6
}

function iso(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * Parse free-text due into an ISO date, interpreted relative to when the
 * meeting happened (a "Friday" promised in a meeting means the Friday after
 * that meeting, not after today).
 */
export function parseDueDate(due: string | null, referenceIso: string): string | null {
  if (!due) return null
  const text = due.trim().toLowerCase()
  if (!text) return null
  const ref = new Date(referenceIso)
  const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate())

  if (/^(today|eod|end of day|by eod)$/.test(text)) return iso(refDay)
  if (/^(tomorrow|tmrw)$/.test(text)) return iso(addDays(refDay, 1))
  if (/^(this week|end of week|eow|by end of week)$/.test(text)) {
    return iso(nextWeekday(refDay, 5, true)) // that week's Friday
  }
  if (/^next week$/.test(text)) return iso(addDays(nextWeekday(refDay, 1, false), 4)) // next week's Friday
  if (/^(end of month|eom)$/.test(text)) {
    return iso(new Date(refDay.getFullYear(), refDay.getMonth() + 1, 0))
  }

  // "friday", "next friday", "by friday", "this friday"
  const weekday = text.match(/^(?:by |this )?(next )?(sun|mon|tue|wed|thu|fri|sat)[a-z]*$/)
  if (weekday) {
    let d = nextWeekday(refDay, WEEKDAYS[weekday[2]], false)
    if (weekday[1]) d = addDays(d, 7)
    return iso(d)
  }

  // "july 21", "jul 21st", "by July 21", "July 21-22" (first day), "July 21, 2026"
  const monthDay = text.match(
    /(?:^|by |on )(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*[-–]\s*\d{1,2})?(?:,?\s*(\d{4}))?/
  )
  if (monthDay) {
    const month = MONTHS[monthDay[1]]
    const day = Number(monthDay[2])
    if (day < 1 || day > 31) return null
    const year = monthDay[3] ? Number(monthDay[3]) : yearFor(month, day, refDay)
    const d = new Date(year, month, day)
    return d.getMonth() === month ? iso(d) : null
  }

  // "7/21", "07/21/2026"
  const slash = text.match(/^(?:by )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/)
  if (slash) {
    const month = Number(slash[1]) - 1
    const day = Number(slash[2])
    if (month < 0 || month > 11 || day < 1 || day > 31) return null
    let year = slash[3] ? Number(slash[3]) : yearFor(month, day, refDay)
    if (year < 100) year += 2000
    const d = new Date(year, month, day)
    return d.getMonth() === month ? iso(d) : null
  }

  return null
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days)
}

/** the next occurrence of a weekday at or after the reference */
function nextWeekday(ref: Date, weekday: number, allowToday: boolean): Date {
  let delta = (weekday - ref.getDay() + 7) % 7
  if (delta === 0 && !allowToday) delta = 7
  return addDays(ref, delta)
}

/**
 * Dates without a year mean the next occurrence — but a date shortly before
 * the reference is this year's (recently overdue), not eleven months away.
 */
function yearFor(month: number, day: number, ref: Date): number {
  const candidate = new Date(ref.getFullYear(), month, day)
  const graceMs = 60 * 86400000
  return candidate.getTime() >= ref.getTime() - graceMs
    ? ref.getFullYear()
    : ref.getFullYear() + 1
}
