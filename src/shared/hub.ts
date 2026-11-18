/**
 * The sync hub built into this build: a Supabase project's address and its
 * publishable key. The key is public by design (every row and file in the
 * hub is guarded by row-level security, per signed-in person). Settings →
 * Sync can also point at another hub.
 */
export const BUILT_IN_HUB = {
  url: 'https://qjmrckbavboyenjzlywu.supabase.co',
  key: 'sb_publishable_swI7A0isdRHRwtbNS5PxAA_5jimkQbH'
}

/** where the phone app is published (GitHub Pages, from main; see .github/workflows/phone.yml) */
export const PHONE_APP_URL = 'https://tylerjkells.github.io/rowan-aio/'

/** the shortest password Rowan lets someone choose */
export const MIN_PASSWORD = 8

/** a plausible email address, before asking the hub */
export function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
}

/**
 * The hub turned down a new account: say why in words. `msg` is the hub's own
 * message. An email without an approval is refused by the database (see
 * supabase/migrations/*_approved_signups.sql), which the hub reports as a
 * failure saving the user.
 */
export function signUpProblem(status: number, msg: string, email: string): string {
  if (/database error saving new user|not approved/i.test(msg)) {
    return `${email.trim()} hasn’t been approved for an account yet. Ask the person who runs your Rowan hub to approve it, then try again.`
  }
  if (/already (been )?registered|already exists/i.test(msg)) {
    return 'There’s already an account for that email. Sign in instead.'
  }
  if (/signups? (are )?not allowed|signup.?disabled/i.test(msg)) {
    return 'This hub isn’t taking new accounts. Ask the person who runs it to turn on sign-ups.'
  }
  if (status === 429 || /rate limit|too many/i.test(msg)) return 'Too many tries. Wait a few minutes, then try again.'
  if (/invalid format|validate email|email address .* is invalid/i.test(msg)) return 'That doesn’t look like an email address.'
  return msg
}

/** the account was made, but the hub wants the email confirmed first, which it can't send */
export const CONFIRM_EMAIL_PROBLEM =
  'The hub wants this email confirmed before you can sign in, and it can’t send the confirmation. Ask the person who runs your Rowan hub to turn off “Confirm email” in Supabase, then sign in.'

/** someone approved to create an account (Settings → Sync, for the hub's administrators) */
export interface SignupApproval {
  email: string
  addedAt: string
  /** when they created their account; an approval works once */
  usedAt: string | null
}

/** what to send someone once they're approved */
export function inviteText(email: string): string {
  return [
    `You’re approved for Rowan sync as ${email}.`,
    'On your PC: in Rowan, open Settings → Sync, choose “Create an account”, and pick your own password.',
    `On your iPhone: open ${PHONE_APP_URL} in Safari, tap “Create an account” (or sign in, if you already made it on your PC), then Share → Add to Home Screen.`
  ].join('\n')
}
