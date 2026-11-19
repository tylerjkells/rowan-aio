// ---------------------------------------------------------------------------
// Action-item state shared by the main process and the renderer. An item is
// "open" when it is not done, not dismissed, and not snoozed into the future.
// Dismissed means it was never really a task (or not yours); done means it was
// and it got done. Keeping them apart keeps the done list honest.
// ---------------------------------------------------------------------------

export interface ActionState {
  /** on your Action items list: only what you added there counts as yours to follow */
  tracked?: boolean
  done?: boolean
  dismissed?: boolean
  /** ISO date; hidden from open lists until this day arrives */
  snoozedUntil?: string | null
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate()
  ).padStart(2, '0')}`
}

export function isSnoozed(item: ActionState, today: string = todayIso()): boolean {
  return !!item.snoozedUntil && item.snoozedUntil > today
}

export function isOpenAction(item: ActionState, today: string = todayIso()): boolean {
  return !item.done && !item.dismissed && !isSnoozed(item, today)
}

/** open and on your list: what Today, the list, reminders and the brief count */
export function isListedAction(item: ActionState, today: string = todayIso()): boolean {
  return !!item.tracked && isOpenAction(item, today)
}

/** how far back the Action items page offers items to add */
export const RECENT_DAYS = 7

/** items from meetings older than this, with no live due date, are stale */
export const STALE_DAYS = 14

/**
 * Stale: old enough that nobody is coming back for it, and nothing due.
 * These fold into the Action items page's Stale section and stay off Today.
 */
export function isStaleAction(
  item: ActionState & { createdAt: string; dueDate?: string },
  today: string = todayIso()
): boolean {
  if (Date.now() - new Date(item.createdAt).getTime() < STALE_DAYS * 86400000) return false
  return !item.dueDate || item.dueDate < today
}
